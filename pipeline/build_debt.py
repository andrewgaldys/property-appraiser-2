#!/usr/bin/env python3
"""Debt and liens per parcel, from free public records that state exact terms (nothing estimated).

  Securitized loans (CMBS). Every public commercial mortgage deal reports its loans to the SEC each
  month (Form ABS-EE, Regulation AB Schedule AL): property address, maturity date, rate, balance,
  payment status, special servicing, workout. Each Florida property is placed on a parcel by street
  address (ZIP, then city), and the match is checked against the parcel's year built and floor area.
  Federal liens on owner companies. Florida's Federal Lien Registry (Division of Corporations), matched
  to the owners' state business records by exact legal name, with the address as a further check.

Inputs
  pipeline/raw/sec/                    EDGAR responses, cached by --fetch (needs SEC_USER_AGENT)
  pipeline/raw/sunbiz/flr[fdse]*       Federal Lien Registry files (sftp.floridados.gov, doc > quarterly > flr)
  pipeline/raw/rates/DGS10.csv         10-year Treasury yield (FRED), shown next to loan rates
  pipeline/out/parcels.parquet, web/public/data/index.json, pipeline/out/sunbiz/ (build_entities.py)

    python pipeline/build_debt.py --fetch       # read the latest SEC loan reports, then match and publish
    python pipeline/build_debt.py               # match what is already fetched and downloaded, publish
    python pipeline/build_debt.py --no-publish  # reports only (pipeline/out/debt/)
    python pipeline/build_debt.py --clear       # remove the published debt records

Outputs
  cleaned  pipeline/out/debt/cmbs_fl.json        Florida loans from each deal's latest report
  joined   pipeline/out/debt/loans.csv           each matched loan property -> parcels, with its checks
           pipeline/out/debt/loans_unmatched.csv six-county properties that found no parcel, and why
           pipeline/out/debt/liens.csv           active federal liens matched to parcel owners
           pipeline/out/debt/parcel_debt.json    per parcel: loans and liens (build_signals.py reads it)
  report   pipeline/out/debt/report.json         counts per county, sources and dates
  publish  web/public/data/debt/<shard>.json     per parcel (the parcel panel's Debt section)
           manifest.json "debt"
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import pickle
import re
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from pa2 import __version__  # noqa: E402
from pa2 import cmbs  # noqa: E402
from pa2 import liens as L  # noqa: E402
from pa2 import sunbiz as S  # noqa: E402
from pa2.address import ParcelLookup, match_address, norm_place, parse_address, split_full_address  # noqa: E402
from pa2.config import (  # noqa: E402
    COUNTIES, DEBT_MIN_CONFIDENCE, OUT_DIR, RAW_DIR, ROLL_NAME_CUT, SEC_LOOKBACK_DAYS, SEC_REQUEST_INTERVAL,
    SUNBIZ_MIN_CONFIDENCE, WEB_DATA_DIR,
)
from pa2.entity import mailing_address_norm  # noqa: E402
from pa2.util import clean_str, fnv1a32, zip5  # noqa: E402

WORK = OUT_DIR / "debt"
PARCELS = OUT_DIR / "parcels.parquet"
SEC_CACHE = RAW_DIR / "sec"
CLEANED = WORK / "cmbs_fl.json"
SUNBIZ_RAW = RAW_DIR / "sunbiz"
SUNBIZ_WORK = OUT_DIR / "sunbiz"
RATES = RAW_DIR / "rates"
TODAY = dt.date.today()
FLORIDA = {"FL", "FLORIDA"}
# How bad a loan's payment status is, for picking the worst of several notes on one loan.
SEVERITY = {"0": 0, "A": 1, "B": 2, "4": 3, "1": 4, "2": 5, "3": 6, "5": 7}


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# SEC: each CMBS deal's latest loan report (network, cached)
# ---------------------------------------------------------------------------


def fetch_cmbs(days: int = SEC_LOOKBACK_DAYS) -> dict:
    """Read every CMBS deal's latest ABS-EE asset data from EDGAR and keep its Florida loans."""
    edgar = cmbs.Edgar(SEC_CACHE, SEC_REQUEST_INTERVAL, log)
    end = TODAY
    start = end - dt.timedelta(days=days)
    log(f"SEC loan reports: ABS-EE filings {start} to {end} (cached in {SEC_CACHE})")
    found = cmbs.filings(cmbs.abs_ee_index(edgar, start, end))
    log(f"  {len(found):,} ABS-EE filings in the daily indexes")
    other: set[str] = set()  # filers of another asset class (autos, cards, leases...)
    kept: dict[str, list[set]] = defaultdict(list)
    deals: dict[str, dict] = {}
    records: list[dict] = []
    loans_read = unreadable = 0
    for f in found:
        cik = f["cik"]
        named = cmbs.looks_like_deal(f["company"])
        if cik in other or (named and cik in kept):
            continue  # not CMBS, or an older report of a deal already read
        xmls = cmbs.cmbs_exhibits(edgar, f)
        if xmls is None:
            unreadable += 1
            continue
        if not xmls:
            other.add(cik)
            continue
        loans = [ln for _name, body in xmls for ln in cmbs.parse_ex102(body, f["company"], cik, f["acc"])]
        ids = {(ln.get("assetNumber"), ln.get("originationDate")) for ln in loans}
        if any(p and ids and len(ids & p) >= 0.5 * min(len(ids), len(p)) for p in kept[cik]):
            continue  # a depositor's older report of a deal already read
        kept[cik].append(ids)
        loans_read += len(loans)
        period = max((cmbs.mdy(ln.get("reportingPeriodEndDate")) or "" for ln in loans), default="") or None
        deals[f["acc"]] = {"deal": f["company"], "cik": cik, "filed": f["date"], "period": period,
                           "loans": len(loans), "deal_named": named}
        for ln in loans:
            fl = [p for p in ln.properties if p.get("propertyState").upper() in FLORIDA]
            if fl:
                records.append({"deal": f["company"], "cik": cik, "acc": f["acc"], "filed": f["date"],
                                "deal_named": named, "loan": ln.fields, "props": [p.fields for p in fl],
                                "n_props": len(ln.properties)})
    out = {
        "fetched": TODAY.isoformat(), "window": [start.isoformat(), end.isoformat()], "filings": len(found),
        "deals": len(deals), "loans": loans_read, "unreadable": unreadable, "requests": edgar.fetched,
        "deal_list": deals, "records": records,
    }
    WORK.mkdir(parents=True, exist_ok=True)
    CLEANED.write_text(json.dumps(out, separators=(",", ":")))
    log(f"  {len(deals):,} CMBS deals, {loans_read:,} loans; {len(records):,} with Florida property"
        f" ({edgar.fetched:,} requests, {edgar.bytes / 1e6:,.0f} MB)")
    return out


# ---------------------------------------------------------------------------
# Joined: loan properties -> parcels
# ---------------------------------------------------------------------------

_MULTI = re.compile(r"^(\d+[A-Z]?)\s*(?:,|&|\bAND\b)\s*(\d+[A-Z]?(?:\s*(?:,|&|\bAND\b)\s*\d+[A-Z]?)*)\s+(\D.*)$", re.I)
_SEP = re.compile(r"\s*(?:,|&|\bAND\b)\s*", re.I)
_TRAILING_PLACE = re.compile(r",\s*[^,]*(?:\bFL\b|\bFLORIDA\b|\b\d{5}(?:-\d{4})?)\s*$", re.I)


def street_variants(text: str) -> list[str]:
    """'100 & 200 Main St' -> ['100 Main St', '200 Main St']; 'A; B' -> [A, B]. Ranges stay as they are."""
    text = clean_str(text)
    if _TRAILING_PLACE.search(text):
        text = split_full_address(text)[0]
    out: list[str] = []
    for part in re.split(r"\s*;\s*|\s+/\s+|\s*\n\s*", text):
        part = part.strip()
        if not part:
            continue
        m = _MULTI.match(part)
        if m:
            out += [f"{n} {m.group(3)}" for n in [m.group(1), *_SEP.split(m.group(2))] if n]
        else:
            out.append(part)
    return out


def _years(v) -> int | None:
    try:
        y = int(float(v))
    except (TypeError, ValueError):
        return None
    return y if 1800 < y <= TODAY.year + 1 else None


def _pct(v: float | None, whole: float) -> float | None:
    """Occupancy or DSCR as filed: some trusts send 0.95 / 1.45, others 95 / 145."""
    if v is None:
        return None
    return round(v / 100 if v > whole else v, 4)


def cross_check(prop: cmbs.Property, pids: list[str], attrs: dict[str, tuple]) -> tuple[float, list[str]]:
    """Adjust a street-address match by what the loan report and the tax roll say about the building."""
    delta, notes = 0.0, []
    yb = _years(prop.get("yearBuiltNumber"))
    years = [y for pid in pids for y in attrs.get(pid, (None, None, None))[:2] if y]
    if yb and years:
        if any(abs(yb - y) <= 2 for y in years):
            delta += 0.05
            notes.append("year built agrees")
        elif all(abs(yb - y) > 15 for y in years):
            delta -= 0.25
            notes.append(f"year built differs ({yb} vs {min(years)})")
    nra = cmbs.num(prop.get("netRentableSquareFeetNumber"))
    area = sum(attrs.get(pid, (None, None, 0))[2] or 0 for pid in pids)
    if nra and nra > 0 and area > 0:
        ratio = nra / area
        if 0.67 <= ratio <= 1.5:
            delta += 0.05
            notes.append("size agrees")
        elif ratio < 0.33:
            delta -= 0.25
            notes.append(f"size differs ({nra:,.0f} vs {area:,.0f} sq ft)")
        elif ratio > 3:
            delta -= 0.1
            notes.append(f"loan property larger ({nra:,.0f} vs {area:,.0f} sq ft)")
    return delta, notes


def load_attrs(path: Path) -> dict[str, tuple]:
    """(year built, effective year built, floor area) per parcel."""
    import pandas as pd

    df = pd.read_parquet(path, columns=["parcel_id", "act_yr_blt", "eff_yr_blt", "tot_lvg_area"])
    out = {}
    for r in df.itertuples(index=False):
        area = r.tot_lvg_area if r.tot_lvg_area == r.tot_lvg_area else None
        out[str(r.parcel_id)] = (_years(r.act_yr_blt), _years(r.eff_yr_blt), float(area) if area else None)
    return out


def _note(rec: dict, prop: cmbs.Property, conf: float, how: str, checks: list[str]) -> dict:
    """One trust's note on a loan, as shown in the parcel panel."""
    ln = cmbs.Loan(rec["deal"], rec["cik"], rec["acc"], rec["loan"])
    g = ln.get
    status = g("paymentStatusLoanCode")
    workout = g("workoutStrategyCode")
    pstat = prop.get("propertyStatusCode")
    mat0 = cmbs.mdy(g("maturityDate"))
    note = {
        "deal": rec["deal"], "url": cmbs.folder_url({"cik": rec["cik"], "acc": rec["acc"]}) + "/",
        "asof": cmbs.mdy(g("reportingPeriodEndDate")), "asset": g("assetNumber"),
        "name": prop.get("propertyName").title() if prop.get("propertyName").isupper() else prop.get("propertyName"),
        "type": cmbs.PROPERTY_TYPE.get(prop.get("propertyTypeCode"), ""),
        "addr": prop.get("propertyAddress"),
        "orig": cmbs.mdy(g("originationDate")), "lender": g("originatorName"),
        "mat": ln.maturity, "mat0": mat0 if ln.maturity != mat0 else None,
        "ard": cmbs.mdy(g("hyperAmortizingDate")),
        "rate": round(ln.rate, 4) if ln.rate else None,
        "rtype": cmbs.RATE_TYPE.get(g("originalInterestRateTypeCode")),
        "io": g("interestOnlyIndicator").lower() == "true" or None,
        "bal": ln.balance, "amt": cmbs.num(g("originalLoanAmount")),
        "status": cmbs.PAYMENT_STATUS.get(status), "sc": status or None,
        "ss": cmbs.mdy(g("mostRecentSpecialServicerTransferDate")) if ln.with_special_servicer else None,
        "workout": cmbs.WORKOUT.get(workout), "wc": workout or None,
        "mod": cmbs.mdy(g("lastModificationDate")), "modc": cmbs.MODIFICATION.get(g("modificationCode")),
        "pstat": cmbs.PROPERTY_STATUS.get(pstat) or None, "pc": pstat or None,
        "dscr": _pct(cmbs.num(prop.get("mostRecentDebtServiceCoverageNetOperatingIncomePercentage")), 20),
        "occ": _pct(cmbs.num(prop.get("mostRecentPhysicalOccupancyPercentage")), 1.5),
        "fin": cmbs.mdy(prop.get("mostRecentFinancialsEndDate")),
        "val": cmbs.num(prop.get("mostRecentValuationAmount")), "vdate": cmbs.mdy(prop.get("mostRecentValuationDate")),
        "servicer": g("primaryServicerName"), "n": rec.get("n_props") or None,
        "how": how, "conf": round(conf, 2), "check": "; ".join(checks) or None,
    }
    return {k: v for k, v in note.items() if v not in (None, "", [])}


def _merge(loans: list[dict], note: dict) -> None:
    """Add a trust's note to the parcel's loans: notes of one loan held by several deals (pari passu)
    share origination, maturity and property, and are shown as one loan with their balances added."""
    key = (note.get("orig"), note.get("mat0") or note.get("mat"), (note.get("addr") or "").upper())
    for ln in loans:
        if ln["_key"] == key:
            if note["deal"] in ln["deals"]:
                return
            ln["deals"].append(note["deal"])
            for k in ("bal", "amt"):
                if note.get(k) is not None:
                    ln[k] = (ln.get(k) or 0) + note[k]
            if SEVERITY.get(note.get("sc", ""), 0) > SEVERITY.get(ln.get("sc", ""), 0):
                for k in ("status", "sc"):
                    ln[k] = note.get(k)
            for k in ("ss", "workout", "wc", "pstat", "pc"):
                if note.get(k) and not ln.get(k):
                    ln[k] = note[k]
            ln["conf"] = max(ln["conf"], note["conf"])
            return
    loans.append({**note, "deals": [note["deal"]], "_key": key})


def match_cmbs(cleaned: dict, lookup: ParcelLookup, attrs: dict[str, tuple]):
    """Florida loan properties -> parcels. Returns (loans per parcel, joined rows, unmatched rows, counts)."""
    zip_votes: dict[str, Counter] = defaultdict(Counter)
    for p in lookup.by_pid.values():
        if p.zip:
            zip_votes[p.zip][p.county] += 1
    zip_county = {z: c.most_common(1)[0][0] for z, c in zip_votes.items()}

    records = cleaned.get("records", [])

    def ident(rec: dict, prop: dict) -> tuple:
        g = rec["loan"].get
        return (g("originationDate"), g("maturityDate"), g("originalLoanAmount"), (prop.get("propertyAddress") or "").upper())

    # A depositor's report at a deal's launch repeats what the deal itself reports later: keep the deal's.
    by_deal = {ident(r, p) for r in records if r["deal_named"] for p in r["props"]}

    loans_by_pid: dict[str, list[dict]] = defaultdict(list)
    joined: list[dict] = []
    unmatched: list[dict] = []
    counts: dict[str, Counter] = defaultdict(Counter)
    cache: dict[tuple, tuple] = {}
    for rec in records:
        ln = cmbs.Loan(rec["deal"], rec["cik"], rec["acc"], rec["loan"])
        if not ln.outstanding:
            continue
        for pf in rec["props"]:
            if not rec["deal_named"] and ident(rec, pf) in by_deal:
                continue
            prop = cmbs.Property(pf)
            z = zip5(prop.get("propertyZip"))
            co = lookup.county_code(prop.get("propertyCounty")) or zip_county.get(z)
            if co is None:
                counts["elsewhere"]["properties"] += 1
                continue
            c = counts[str(co)]
            c["properties"] += 1
            row = {"deal": rec["deal"], "asset": ln.get("assetNumber"), "property": prop.get("propertyName"),
                   "address": prop.get("propertyAddress"), "city": prop.get("propertyCity"), "zip": z,
                   "county": COUNTIES[co].name if co in COUNTIES else co}
            if prop.get("propertyStatusCode") in cmbs.RELEASED_STATUSES or prop.get("DefeasedStatusCode") == "F":
                c["released"] += 1
                unmatched.append({**row, "reason": "defeased or released: the property no longer secures the loan"})
                continue
            key = (prop.get("propertyAddress").upper(), norm_place(prop.get("propertyCity")), z, co)
            if key not in cache:
                pids: dict[str, None] = {}
                hows, reasons, cands = [], [], []
                for street in street_variants(prop.get("propertyAddress")):
                    addr = parse_address(street)
                    m = match_address(lookup, addr, city=norm_place(prop.get("propertyCity")), zip_code=z, county=co,
                                      unit=addr.unit, lon=None, lat=None)
                    if m.parcels and m.how != "shared":
                        pids.update({p.pid: None for p in m.parcels})
                        hows.append(m.how)
                    elif m.how == "shared":
                        reasons.append("several owners' parcels share this address")
                        cands += [p.pid for p in m.parcels[:8]]
                    else:
                        reasons.append(m.reason)
                        cands += m.candidates
                cache[key] = (list(pids), "range" if "range" in hows else ("addr" if hows else ""), reasons, cands)
            pids, how, reasons, cands = cache[key]
            if not pids:
                c["unmatched"] += 1
                unmatched.append({**row, "reason": "; ".join(dict.fromkeys(reasons)) or "no street address",
                                  "candidates": " ".join(cands[:8])})
                continue
            delta, checks = cross_check(prop, pids, attrs)
            conf = min(0.99, (0.9 if how == "addr" else 0.8) + delta)
            joined.append({**row, "parcels": " ".join(pids), "how": how, "confidence": round(conf, 2),
                           "checks": "; ".join(checks), "maturity": ln.maturity,
                           "status": cmbs.PAYMENT_STATUS.get(ln.get("paymentStatusLoanCode"), ""), "balance": ln.balance})
            if conf < DEBT_MIN_CONFIDENCE:
                c["low_confidence"] += 1
                unmatched.append({**row, "reason": f"address matches, but {'; '.join(checks)}", "candidates": " ".join(pids[:8])})
                continue
            c["matched"] += 1
            note = _note(rec, prop, conf, how, checks)
            for pid in pids:
                _merge(loans_by_pid[pid], note)
    for loans in loans_by_pid.values():
        for ln in loans:
            ln.pop("_key", None)
            if len(ln["deals"]) == 1:
                ln.pop("deals")
        loans.sort(key=lambda x: x.get("mat") or "9999")
    return dict(loans_by_pid), joined, unmatched, counts


# ---------------------------------------------------------------------------
# Joined: federal liens -> owners -> parcels
# ---------------------------------------------------------------------------


def load_owner_links() -> tuple[dict[str, S.Entity], dict[str, list[tuple[str, float]]]]:
    """Sunbiz entities that own parcels (build_entities.py's cache) and their parcels with link confidence."""
    links: dict[str, list[tuple[str, float]]] = defaultdict(list)
    path = SUNBIZ_WORK / "parcel_entities.csv"
    if path.exists():
        with path.open(newline="") as fh:
            for r in csv.DictReader(fh):
                conf = float(r["confidence"] or 0)
                if conf >= SUNBIZ_MIN_CONFIDENCE:
                    links[r["doc"]].append((r["parcel_id"], conf))
    ents: dict[str, S.Entity] = {}
    scan = SUNBIZ_WORK / "scan.pickle"
    if scan.exists() and links:
        with scan.open("rb") as fh:
            data = pickle.load(fh)
        ents = {d: e for d, e in data["cands"].entities.items() if d in links}
    return ents, links


def roll_addresses(path: Path) -> tuple[dict[str, list[str]], dict[str, tuple[str, tuple]]]:
    """Company owner names on the roll (not cut off) -> parcels, and each parcel's tax-bill mailing
    address key and site address (street, house numbers, ZIP)."""
    import pandas as pd

    cols = ["parcel_id", "owner_name", "owner_addr1", "owner_addr2", "owner_city", "owner_state", "owner_zip",
            "site_address", "site_zip"]
    df = pd.read_parquet(path, columns=cols)
    by_name: dict[str, list[str]] = defaultdict(list)
    places: dict[str, tuple[str, tuple]] = {}
    for r in df.itertuples(index=False):
        pid = str(r.parcel_id)
        site = parse_address(r.site_address)
        places[pid] = (mailing_address_norm(r.owner_addr1, r.owner_addr2, r.owner_city, r.owner_state, r.owner_zip),
                       (site.street, set(site.numbers), zip5(r.site_zip)))
        name = clean_str(r.owner_name).upper()
        if name and len(name) < ROLL_NAME_CUT and S.company_like(name):
            by_name[S.light_key(name)].append(pid)
    return by_name, places


def _same_place(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a == b:
        return True
    na, za = S._addr_parts(a)
    return bool(na) and (na, za) == S._addr_parts(b)


def _at_site(party: L.Party, site: tuple) -> bool:
    """The lien gives the parcel's own street address (a business at its own building)."""
    street, numbers, zip_ = site
    a = parse_address(party.addr1)
    return bool(a.ok and street and a.street == street and numbers & set(a.numbers) and (not zip_ or not party.zip or party.zip == zip_))


def match_liens(liens: dict[str, L.Lien], parcels: Path) -> tuple[dict[str, list[dict]], list[dict], dict]:
    """Active federal liens against companies -> the parcels those companies own."""
    today = TODAY.isoformat()
    ents, links = load_owner_links()
    by_name: dict[str, list[str]] = defaultdict(list)
    for doc, e in ents.items():
        by_name[S.light_key(e.name)].append(doc)
    owners, places = roll_addresses(parcels)
    out: dict[str, list[dict]] = defaultdict(list)
    rows: list[dict] = []
    stats = Counter()
    for lien in liens.values():
        if not lien.active(today):
            continue
        stats["active"] += 1
        stats["active_" + lien.kind] += 1
        for debtor in lien.debtors:
            if debtor.person or not debtor.current:
                continue
            key = S.light_key(debtor.name)
            where = mailing_address_norm(debtor.addr1, debtor.addr2, debtor.city, debtor.state, debtor.zip)

            def agrees(pid: str) -> str | None:
                """Where the lien's address agrees with this owner: its state record, tax bill or parcel."""
                mail, site = places.get(pid, ("", ("", set(), "")))
                if _same_place(mail, where):
                    return "tax-bill address"
                if _at_site(debtor, site):
                    return "property address"
                return None

            hits: list[tuple[str, float, str]] = []
            for doc in by_name.get(key, []):
                e = ents[doc]
                if e.filed and lien.filed and lien.filed < e.filed:
                    continue  # filed before this company existed: an earlier company of the same name
                on_record = S.addr_score(e, where) > 0
                for pid, link in links[doc]:
                    why = "state record address" if on_record else agrees(pid)
                    hits.append((pid, min(0.95 if why else 0.85, link), f"name and {why}" if why else "name"))
            if not hits:
                hits = [(pid, 0.9, f"name and {why} (tax roll)") for pid in owners.get(key, []) if (why := agrees(pid))]
            for pid, conf, how in hits:
                if conf < DEBT_MIN_CONFIDENCE:
                    continue
                if any(x["doc"] == lien.doc for x in out[pid]):
                    continue
                item = {"doc": lien.doc, "filed": lien.filed, "tax": lien.tax, "kind": L.KIND.get(lien.kind, "lien"),
                        "holder": lien.holder.title(), "debtor": debtor.name, "expires": lien.expires,
                        "assessed": lien.assessed, "last": lien.events[-1][1] if lien.events else None,
                        "how": how, "conf": round(conf, 2)}
                out[pid].append({k: v for k, v in item.items() if v not in (None, "")})
                rows.append({"parcel_id": pid, **item})
    for v in out.values():
        v.sort(key=lambda x: x.get("filed") or "", reverse=True)
    stats["parcels"] = len(out)
    return dict(out), rows, dict(stats)


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------


def treasury() -> dict | None:
    """The latest 10-year Treasury yield in pipeline/raw/rates/DGS10.csv (FRED)."""
    path = RATES / "DGS10.csv"
    if not path.exists():
        return None
    last = None
    with path.open(newline="") as fh:
        for row in csv.reader(fh):
            if len(row) == 2 and re.match(r"^\d{4}-\d{2}-\d{2}$", row[0]) and re.match(r"^-?\d+(\.\d+)?$", row[1]):
                last = row
    if not last:
        return None
    return {"label": "10-year Treasury yield (Federal Reserve H.15, via FRED DGS10)", "date": last[0], "value": float(last[1])}


def _write_csv(path: Path, rows: list[dict]) -> None:
    keys: list[str] = []
    for r in rows:
        keys += [k for k in r if k not in keys]
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=keys or ["none"])
        w.writeheader()
        w.writerows(rows)


def run(*, parcels: Path = PARCELS, out: Path = WEB_DATA_DIR, publish: bool = True, fetch: bool = False) -> dict | None:
    WORK.mkdir(parents=True, exist_ok=True)
    if fetch:
        fetch_cmbs()
    lien_files = L.find_files(SUNBIZ_RAW)
    if not CLEANED.exists() and "f" not in lien_files:
        log("Debt records: no SEC loan reports fetched (python pipeline/build_debt.py --fetch) and no Federal Lien "
            f"Registry files in {SUNBIZ_RAW}: skipped.")
        return None
    log(f"Debt records: {parcels}")
    report: dict = {"generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(), "sources": {}}
    loans: dict[str, list[dict]] = {}
    lookup = ParcelLookup.from_bundle(out)
    county_of = {pid: p.county for pid, p in lookup.by_pid.items()}

    if CLEANED.exists():
        cleaned = json.loads(CLEANED.read_text())
        loans, joined, unmatched, counts = match_cmbs(cleaned, lookup, load_attrs(parcels))
        _write_csv(WORK / "loans.csv", joined)
        _write_csv(WORK / "loans_unmatched.csv", unmatched)
        periods = [d.get("period") for d in cleaned.get("deal_list", {}).values() if d.get("period")]
        report["sources"]["sec"] = {
            "label": "SEC EDGAR: CMBS loan reports (Form ABS-EE, Schedule AL)",
            "as_of": max(periods) if periods else None, "pulled": cleaned.get("fetched"), "window": cleaned.get("window"),
            "deals": cleaned.get("deals"), "loans": cleaned.get("loans"), "florida_loans": len(cleaned.get("records", [])),
        }
        report["loans"] = {"per_county": {k: dict(v) for k, v in counts.items()},
                           "parcels": len(loans), "unmatched_reasons": dict(Counter(u["reason"] for u in unmatched).most_common(12))}
        log(f"  SEC: {len(cleaned.get('records', [])):,} Florida loans in {cleaned.get('deals', 0):,} deals "
            f"(reports to {report['sources']['sec']['as_of']}); {len(loans):,} parcels with a securitized loan")
        for co, c in sorted(counts.items()):
            name = COUNTIES[int(co)].name if co.isdigit() and int(co) in COUNTIES else co
            log(f"    {name:<14} properties {c['properties']:>4}  matched {c['matched']:>4}  unmatched {c['unmatched']:>3}"
                f"  low confidence {c['low_confidence']:>3}  released {c['released']:>3}")
    else:
        log("  no SEC loan reports fetched yet (python pipeline/build_debt.py --fetch)")

    liens: dict[str, list[dict]] = {}
    if "f" in lien_files:
        all_liens = L.read(lien_files, log)
        liens, rows, stats = match_liens(all_liens, parcels)
        _write_csv(WORK / "liens.csv", rows)
        report["sources"]["flr"] = {"label": "Florida Federal Lien Registry (Division of Corporations)",
                                    "as_of": S.file_date(lien_files["f"]), "filings": len(all_liens), **stats}
        per = Counter(str(county_of.get(pid, "")) for pid in liens)
        report["liens"] = {"per_county": dict(per), "parcels": len(liens)}
        log(f"  liens: {stats.get('active', 0):,} active of {len(all_liens):,} filings; {len(liens):,} parcels")
    else:
        log(f"  no Federal Lien Registry files in {SUNBIZ_RAW} (flrf, flrd, flrs, flre from the quarterly folder)")
    rate = treasury()
    if rate:
        report["sources"]["treasury"] = rate

    debt: dict[str, dict] = {}
    for pid, v in loans.items():
        debt.setdefault(pid, {})["loans"] = v
    for pid, v in liens.items():
        debt.setdefault(pid, {})["liens"] = v
    per_county = Counter(str(county_of.get(pid, "")) for pid in debt)
    report["parcels"] = len(debt)
    report["per_county"] = dict(per_county)
    (WORK / "parcel_debt.json").write_text(json.dumps(debt, separators=(",", ":")))
    (WORK / "report.json").write_text(json.dumps(report, indent=2))
    log(f"  {len(debt):,} parcels with debt records")
    if publish:
        write_bundle(out, debt, report)
    return report


def _dump(path: Path, obj) -> int:
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def clear_bundle(out: Path) -> None:
    shutil.rmtree(out / "debt", ignore_errors=True)
    mf = out / "manifest.json"
    if mf.exists():
        m = json.loads(mf.read_text())
        if m.pop("debt", None) is not None:
            mf.write_text(json.dumps(m, separators=(",", ":")))


def write_bundle(out: Path, debt: dict[str, dict], report: dict) -> None:
    mf = out / "manifest.json"
    manifest = json.loads(mf.read_text())
    shard_hex = int(manifest.get("details", {}).get("shard_hex", 2))
    root = out / "debt"
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True)
    shards: dict[str, dict] = defaultdict(dict)
    for pid, v in debt.items():
        shards[fnv1a32(pid)[:shard_hex]][pid] = v
    size = sum(_dump(root / f"{s}.json", {"rows": rows}) for s, rows in shards.items())
    manifest["pipeline_version"] = __version__
    manifest["debt"] = {
        "schema": "pa2-debt/1",
        "generated_at": report["generated_at"],
        "url": "debt/{shard}.json", "shard_hex": shard_hex, "hash": "fnv1a32(parcel_id)",
        "sources": report["sources"],
        "parcels": report["parcels"], "per_county": report["per_county"],
    }
    mf.write_text(json.dumps(manifest, separators=(",", ":")))
    log(f"  published -> {root}: {len(shards)} shards, {size / 1e6:.2f} MB")


def after_build(parcels: Path, out: Path) -> None:
    """Run after a data build: match what is already fetched and downloaded (no network)."""
    run(parcels=parcels, out=out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--parcels", type=Path, default=PARCELS)
    ap.add_argument("--out", type=Path, default=WEB_DATA_DIR)
    ap.add_argument("--fetch", action="store_true", help="read the latest SEC loan reports first (needs SEC_USER_AGENT)")
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--clear", action="store_true")
    ap.add_argument("--signals", action="store_true", help="rebuild the deal signals afterwards")
    args = ap.parse_args()
    if args.clear:
        clear_bundle(args.out)
        log(f"Removed the debt records from {args.out}.")
        return 0
    if not args.parcels.exists():
        log(f"No joined parcel table at {args.parcels}: run the data build first.")
        return 1
    run(parcels=args.parcels, out=args.out, publish=not args.no_publish, fetch=args.fetch)
    if args.signals:
        from build_signals import run as build_signals

        build_signals(parcels=args.parcels, out=args.out, publish=not args.no_publish)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
