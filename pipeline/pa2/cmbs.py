"""Securitized commercial mortgages (CMBS) from SEC EDGAR: every public deal files its loans each month
(Form ABS-EE, Exhibit 102, Regulation AB Schedule AL): property address, origination and maturity date,
balance, rate, payment status, special servicing and workout. Exact, as the trust reports them.

EDGAR asks automated clients to name a contact in the User-Agent header and to stay under 10 requests
a second (https://www.sec.gov/os/accessing-edgar-data). The contact comes from the SEC_USER_AGENT
environment variable, which the person running the pipeline sets themselves ("Name name@example.com");
it is never written to a file here. Requests are spaced to about four a second, and every response
is cached under pipeline/raw/sec/, so a rerun only fetches what is new.
"""

from __future__ import annotations

import gzip
import io
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from xml.etree import ElementTree

UA_ENV = "SEC_USER_AGENT"
NS = "http://www.sec.gov/edgar/document/absee/cmbs/assetdata"
ARCHIVES = "https://www.sec.gov/Archives/edgar"

# Schedule AL code lists (EDGAR ABS XML schema, eis_ABS_CMBSAssetData.xsd).
PAYMENT_STATUS = {
    "0": "current", "1": "30-59 days late", "2": "60-89 days late", "3": "90+ days late",
    "4": "matured, still paying", "5": "matured, not repaid", "A": "in grace period", "B": "late, under 30 days",
}
LATE_STATUSES = {"1", "2", "3", "5"}
WORKOUT = {
    "1": "modification", "2": "foreclosure", "3": "bankruptcy", "4": "extension", "5": "note sale",
    "6": "discounted payoff", "7": "REO (lender-owned)", "8": "resolved", "9": "returning to master servicer",
    "10": "deed in lieu of foreclosure", "11": "full payoff", "12": "reps and warranties", "13": "to be decided",
    "98": "other",
}
DISTRESS_WORKOUTS = {"2", "3", "5", "6", "7", "10"}
# liquidationPrepaymentCode values that end a loan (1, 10 and 11 are partial paydowns).
LIQUIDATED = {"2", "3", "4", "5", "6", "7", "8", "9"}
# propertyStatusCode: 1 in foreclosure, 2 REO; 3 defeased, 4 partially released, 5 substituted (the
# property no longer secures the loan); 6 same as at securitization.
PROPERTY_STATUS = {"1": "in foreclosure", "2": "REO (lender-owned)", "3": "defeased", "4": "released",
                   "5": "substituted", "6": ""}
RELEASED_STATUSES = {"3", "4", "5"}
RATE_TYPE = {"1": "fixed", "2": "adjustable", "3": "step", "4": "other"}
MODIFICATION = {"1": "maturity extended", "2": "amortization changed", "3": "principal written off",
                "5": "rate cut temporarily", "6": "interest capitalized", "7": "taxes capitalized",
                "8": "combination", "98": "other"}
PROPERTY_TYPE = {
    "CH": "Co-op housing", "HC": "Healthcare", "IN": "Industrial", "LO": "Lodging", "MF": "Multifamily",
    "MH": "Mobile home park", "MU": "Mixed use", "OF": "Office", "RT": "Retail", "SE": "Securities",
    "SS": "Self storage", "WH": "Warehouse", "ZZ": "", "98": "Other",
}

LOAN_FIELDS = (
    "assetNumber", "reportingPeriodEndDate", "originatorName", "originationDate", "originalLoanAmount",
    "maturityDate", "originalInterestRatePercentage", "interestRateSecuritizationPercentage",
    "originalInterestRateTypeCode", "interestOnlyIndicator", "balloonIndicator", "modifiedIndicator",
    "reportPeriodInterestRatePercentage", "reportPeriodEndActualBalanceAmount", "paidThroughDate",
    "paymentStatusLoanCode", "primaryServicerName", "mostRecentSpecialServicerTransferDate",
    "mostRecentMasterServicerReturnDate", "workoutStrategyCode", "lastModificationDate", "modificationCode",
    "postModificationMaturityDate", "liquidationPrepaymentCode", "liquidationPrepaymentDate", "NumberProperties",
)
PROPERTY_FIELDS = (
    "propertyName", "propertyAddress", "propertyCity", "propertyState", "propertyZip", "propertyCounty",
    "propertyTypeCode", "netRentableSquareFeetNumber", "unitsBedsRoomsNumber", "yearBuiltNumber",
    "valuationSecuritizationAmount", "valuationSecuritizationDate", "mostRecentValuationAmount",
    "mostRecentValuationDate", "mostRecentPhysicalOccupancyPercentage", "mostRecentNetOperatingIncomeAmount",
    "mostRecentDebtServiceCoverageNetOperatingIncomePercentage", "mostRecentFinancialsEndDate", "largestTenant",
    "leaseExpirationLargestTenantDate", "propertyStatusCode", "DefeasedStatusCode",
)


def mdy(s: str | None) -> str | None:
    """'03-15-2027' (the schema's MM-DD-YYYY) -> '2027-03-15'; ISO dates pass through."""
    s = (s or "").strip()
    m = re.match(r"^(\d{2})-(\d{2})-(\d{4})$", s) or re.match(r"^(\d{2})/(\d{2})/(\d{4})$", s)
    if m:
        return f"{m.group(3)}-{m.group(1)}-{m.group(2)}"
    return s[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", s) else None


def num(s: str | None) -> float | None:
    try:
        v = float((s or "").replace(",", ""))
    except ValueError:
        return None
    return None if v != v or v <= -999999 else v


@dataclass
class Property:
    fields: dict

    def get(self, k: str) -> str:
        return (self.fields.get(k) or "").strip()


@dataclass
class Loan:
    deal: str
    cik: str
    accession: str
    fields: dict
    properties: list[Property] = field(default_factory=list)

    def get(self, k: str) -> str:
        return (self.fields.get(k) or "").strip()

    @property
    def balance(self) -> float | None:
        return num(self.get("reportPeriodEndActualBalanceAmount"))

    @property
    def rate(self) -> float | None:
        r = num(self.get("reportPeriodInterestRatePercentage")) or num(self.get("interestRateSecuritizationPercentage")) \
            or num(self.get("originalInterestRatePercentage"))
        if r is None:
            return None
        return r * 100 if r < 1 else r  # some filers report 0.0425, most 4.25

    @property
    def maturity(self) -> str | None:
        return mdy(self.get("postModificationMaturityDate")) or mdy(self.get("maturityDate"))

    @property
    def outstanding(self) -> bool:
        """Still owed: a balance above zero, or (no balance reported) no payoff or liquidation."""
        b = self.balance
        if b is not None:
            return b > 0
        return self.get("liquidationPrepaymentCode") not in LIQUIDATED

    @property
    def with_special_servicer(self) -> bool:
        to_ss = mdy(self.get("mostRecentSpecialServicerTransferDate"))
        back = mdy(self.get("mostRecentMasterServicerReturnDate"))
        return bool(to_ss and (not back or back < to_ss))


def parse_ex102(data: bytes, deal: str, cik: str, accession: str) -> list[Loan]:
    """Every loan in one CMBS asset data file, with its properties."""
    loans: list[Loan] = []
    tag = lambda e: e.tag.rsplit("}", 1)[-1]  # noqa: E731
    for _event, el in ElementTree.iterparse(io.BytesIO(data), events=("end",)):
        if tag(el) != "assets":
            continue
        loan_fields: dict[str, str] = {}
        props: list[Property] = []
        for child in el:
            t = tag(child)
            if t == "property":
                props.append(Property({tag(c): (c.text or "") for c in child if tag(c) in PROPERTY_FIELDS}))
            elif t in LOAN_FIELDS:
                loan_fields[t] = child.text or ""
        loans.append(Loan(deal, cik, accession, loan_fields, props))
        el.clear()
    return loans


# ---------------------------------------------------------------------------
# EDGAR access
# ---------------------------------------------------------------------------


class Edgar:
    """Rate-limited, cached GETs from www.sec.gov with the person's declared User-Agent."""

    def __init__(self, cache: Path, interval: float = 0.25, log=print):
        ua = os.environ.get(UA_ENV, "").strip()
        if not ua or "@" not in ua:
            raise SystemExit(
                f"Set {UA_ENV} to a contact the SEC can reach, e.g. in Terminal:\n"
                f"  echo 'export {UA_ENV}=\"Your Name you@example.com\"' >> ~/.zshrc\n"
                "then open a new terminal and run this again. EDGAR refuses automated requests without one."
            )
        self.ua = ua
        self.cache = cache
        self.interval = max(0.1, interval)  # never faster than 10 a second
        self.log = log
        self._last = 0.0
        self.fetched = 0
        self.bytes = 0

    def _rel(self, url: str) -> str:
        return url.split("://", 1)[-1].split("/", 1)[-1]

    def _request(self, url: str, headers: dict, limit: int | None = None) -> bytes | None:
        for attempt in range(6):
            wait = self._last + self.interval - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            req = urllib.request.Request(url, headers={"User-Agent": self.ua, **headers})
            try:
                with urllib.request.urlopen(req, timeout=180) as resp:
                    body = resp.read(limit) if limit else resp.read()
                    if resp.headers.get("Content-Encoding") == "gzip" and not limit:
                        body = gzip.decompress(body)
                self.fetched += 1
                self.bytes += len(body)
                if self.fetched % 250 == 0:
                    self.log(f"    {self.fetched:,} requests to sec.gov, {self.bytes / 1e6:,.0f} MB")
                return body
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    return None
                if exc.code == 403:
                    raise SystemExit(f"EDGAR refused {url} (403): check {UA_ENV}, or wait a while and run again.") from exc
                if exc.code in (429, 500, 502, 503, 504) and attempt < 5:
                    time.sleep(min(120, 10 * 2 ** attempt))
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if attempt < 5:
                    time.sleep(min(120, 10 * 2 ** attempt))
                    continue
                raise
        return None

    def get(self, url: str, *, fresh: bool = False) -> bytes | None:
        """The body (cached; None for a 404). fresh=True refetches what may still change (recent daily indexes)."""
        path = self.cache / (self._rel(url) + ".gz")
        if path.exists() and not fresh:
            return gzip.decompress(path.read_bytes())
        body = self._request(url, {"Accept-Encoding": "gzip"})
        if body is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(gzip.compress(body, mtime=0))
        return body

    def head(self, url: str, n: int = 4096) -> bytes | None:
        """The first n bytes of a file (cached), without downloading the rest of it."""
        full = self.cache / (self._rel(url) + ".gz")
        if full.exists():
            return gzip.decompress(full.read_bytes())[:n]
        path = self.cache / (self._rel(url) + ".head")
        if path.exists():
            return path.read_bytes()
        body = self._request(url, {"Range": f"bytes=0-{n - 1}"}, limit=n)
        if body is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        return body


_INDEX_LINE = re.compile(r"^(ABS-EE(?:/A)?)\s+(.+?)\s+(\d{1,10})\s+(\d{8})\s+(edgar/data/\S+)\s*$")
# A filer named like a deal ("BANK 2017-BNK4", "Benchmark 2018-B1 Mortgage Trust") rather than its
# depositor ("Wells Fargo Commercial Mortgage Securities Inc"), which files for many deals.
_DEAL_NAME = re.compile(r"\bTRUST\b|\bCERTIFICATES\b|\b(?:19|20)\d\d-[A-Z0-9]", re.I)


def looks_like_deal(company: str) -> bool:
    return bool(_DEAL_NAME.search(company))


def abs_ee_index(edgar: Edgar, start: date, end: date) -> list[dict]:
    """ABS-EE index lines (one per filer of each filing) from EDGAR's daily form indexes."""
    out: list[dict] = []
    d = start
    today = date.today()
    while d <= end:
        if d.weekday() < 5:
            q = (d.month - 1) // 3 + 1
            url = f"{ARCHIVES}/daily-index/{d.year}/QTR{q}/form.{d:%Y%m%d}.idx"
            body = edgar.get(url, fresh=(today - d).days < 3)
            if body:
                for line in body.decode("latin-1").splitlines():
                    m = _INDEX_LINE.match(line)
                    if m:
                        out.append({"form": m.group(1), "company": m.group(2).strip(), "cik": m.group(3).lstrip("0"),
                                    "date": m.group(4), "file": m.group(5)})
        d += timedelta(days=1)
    return out


def filings(index: list[dict]) -> list[dict]:
    """One row per filing, newest first. A filing listed under several filers (a deal and its depositor)
    belongs to the filer with the fewest filings in the window: the deal."""
    by_acc: dict[str, list[dict]] = {}
    for e in index:
        by_acc.setdefault(Path(e["file"]).stem, []).append(e)
    per_cik: dict[str, int] = {}
    for es in by_acc.values():
        for cik in {e["cik"] for e in es}:
            per_cik[cik] = per_cik.get(cik, 0) + 1
    out = []
    for acc, es in by_acc.items():
        deal = min(es, key=lambda e: (per_cik[e["cik"]], -int(e["cik"])))
        out.append({"acc": acc, "cik": deal["cik"], "company": deal["company"], "date": deal["date"],
                    "form": deal["form"], "ciks": sorted({e["cik"] for e in es})})
    out.sort(key=lambda f: (f["date"], f["acc"]), reverse=True)
    return out


def folder_url(filing: dict) -> str:
    return f"{ARCHIVES}/data/{filing['cik']}/{filing['acc'].replace('-', '')}"


def cmbs_exhibits(edgar: Edgar, filing: dict) -> list[tuple[str, bytes]] | None:
    """(file name, XML) of a filing's CMBS asset data files; [] when it is another asset class (autos,
    cards, leases...), checked from each file's first bytes; None when the filing cannot be read."""
    listing = edgar.get(f"{folder_url(filing)}/index.json")
    if not listing:
        return None
    items = json.loads(listing).get("directory", {}).get("item", [])
    xmls = sorted((i["name"] for i in items if str(i.get("name", "")).lower().endswith(".xml")),
                  key=lambda n: (0 if "102" in n else 1, n))
    out: list[tuple[str, bytes]] = []
    for name in xmls[:6]:
        url = f"{folder_url(filing)}/{name}"
        first = edgar.head(url)
        if not first:
            continue
        if NS.encode() not in first:
            if b"/edgar/document/absee/" in first:
                break  # another asset class's data file: the whole filing is that class
            continue
        body = edgar.get(url)
        if body:
            out.append((name, body))
    return out
