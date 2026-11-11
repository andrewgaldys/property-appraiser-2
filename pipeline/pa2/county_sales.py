"""Sale history from the county property appraisers, so hold periods reach back decades.

FDOR's statewide data (the cadastral layer, NAL / SDF) only carries the current roll's sales window
(2025-26 on the 2026 roll), and the FDOR portal keeps no older rolls. The three property appraisers
publish much longer histories for free:

* Palm Beach (60): the Property Appraiser's free CAMA flat file ``CAMA_CSV_CERT<year>.zip`` (each parcel's
  five most recent transfers), plus the county GIS "Property Information Table" (PBCGOV_GIS on ArcGIS
  Online), which holds each parcel's *latest transfer* and can be newer than the CAMA cut.
* Martin (53): the Property Appraiser's CAMA export ``real_transfers.zip`` (every recorded transfer,
  with FDOR qualification codes). https://www.pamartinfl.gov/tools-resources/data-downloads
* St. Lucie (66): the Property Appraiser's CAMA export ``Transactions.zip`` (every recorded transfer).
  https://www.paslc.gov/231/Data-Requests (its download server only answers browsers: download by hand)

For every parcel each source yields `SaleFacts`: the latest sale of at least `min_price`, or, when
none is on record, the year from which it can vouch that no such sale happened. A nominal transfer
($0 / $10 deeds between related parties) after the last priced sale proves exactly that much.
"""

from __future__ import annotations

import datetime as dt
import gzip
import json
import logging
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from . import arcgis
from .util import clean_str, norm_parcel_id

log = logging.getLogger(__name__)

PBC_TABLE = (
    "https://services1.arcgis.com/ZWOoUZbtaYePLlPw/arcgis/rest/services/"
    "Property_Information_Table/FeatureServer/0/query"
)
PBC_BATCH = 1000  # parcel numbers per IN (...) query; PARCEL_NUMBER is indexed
# Converted CAMA records use 1900-01-01 / 1901-01-01 for unknown dates (Martin: 82 parcels, St. Lucie: 7).
MIN_VALID_YEAR = 1902

SOURCES = {
    60: "Palm Beach County Property Appraiser CAMA file (five most recent transfers) and county GIS latest transfer",
    53: "Martin County Property Appraiser transfers export",
    66: "St. Lucie County Property Appraiser transactions export",
}


@dataclass(frozen=True)
class Sale:
    year: int
    month: int  # 0 = unknown
    price: int
    qual: str | None = None

    @property
    def key(self) -> tuple[int, int]:
        return (self.year, self.month)


@dataclass(frozen=True)
class SaleFacts:
    last: Sale | None  # latest sale of at least min_price on record
    none_since: int | None = None  # when `last` is None: no such sale from this year on


def coverage_start(years: Iterable[int]) -> int | None:
    """First year from which a county's transfer records are complete.

    CAMA exports reach back a century, but early years hold only scattered records. Walking back
    from the latest year, records are taken as complete while each year has at least a quarter of
    the average of the five years after it; the first collapse below that marks the start
    (Martin: 1977, St. Lucie: 1972).
    """
    from collections import Counter

    this_year = dt.date.today().year
    counts = Counter(int(y) for y in years if y and MIN_VALID_YEAR <= y <= this_year)  # 2055 = a typo
    if not counts:
        return None
    last = max(counts)
    start = last
    for y in range(last - 1, min(counts) - 1, -1):
        after = [counts.get(y + k, 0) for k in range(1, 6) if y + k <= last]
        if counts.get(y, 0) < 0.25 * (sum(after) / len(after)):
            break
        start = y
    return start


def _latest(sales: Iterable[Sale]) -> Sale | None:
    return max(sales, key=lambda s: (s.key, s.price), default=None)


def _facts(rows: list[tuple[int, int, int, str | None]], min_price: int) -> SaleFacts:
    """rows: (year, month, price, qual) of every recorded transfer of one parcel."""
    priced = [Sale(y, m, p, q) for y, m, p, q in rows if p >= min_price]
    if priced:
        return SaleFacts(_latest(priced))
    years = [y for y, _, _, _ in rows]
    return SaleFacts(None, min(years) if years else None)


# --- Palm Beach: latest transfer from the county GIS table ------------------------------------------

def palm_beach(pids: list[str], cache: Path, min_price: int, refresh: bool = False) -> dict[str, SaleFacts]:
    """Latest transfer per Palm Beach parcel number, cached in `cache` (gzip JSON) between runs."""
    known: dict[str, list] = {}
    if cache.exists() and not refresh:
        known = json.loads(gzip.decompress(cache.read_bytes()))
    todo = sorted(set(pids) - set(known))
    for i in range(0, len(todo), PBC_BATCH):
        batch = todo[i : i + PBC_BATCH]
        where = "PARCEL_NUMBER IN (" + ",".join(f"'{p}'" for p in batch) + ")"
        data = arcgis.query(PBC_TABLE, {
            "where": where,
            "outFields": "PARCEL_NUMBER,SALE_DATE,PRICE,INSTRUMENT",
            "returnGeometry": "false",
            "resultRecordCount": str(PBC_BATCH * 2),
            "f": "json",
        }, label=f"Palm Beach sales {i:,}")
        for p in batch:
            known.setdefault(p, [None, None, None])
        for f in data.get("features") or []:
            a = f["attributes"]
            pid = norm_parcel_id(a.get("PARCEL_NUMBER"))
            row = [a.get("SALE_DATE"), a.get("PRICE"), clean_str(a.get("INSTRUMENT")) or None]
            prev = known.get(pid)
            if pid and (prev is None or prev[0] is None or (row[0] or 0) > prev[0]):
                known[pid] = row
        if (i // PBC_BATCH) % 10 == 9:
            log.info("Palm Beach sales: %s / %s parcels", f"{i + len(batch):,}", f"{len(todo):,}")
    if todo:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(gzip.compress(json.dumps(known, separators=(",", ":")).encode(), mtime=0))

    out: dict[str, SaleFacts] = {}
    for pid in pids:
        ms, price, _instrument = known.get(pid) or (None, None, None)
        if not ms:
            continue
        d = dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).date()
        if d.year < MIN_VALID_YEAR:
            continue
        # Only the latest transfer is published: a priced one is the last sale; a nominal one proves
        # that no priced sale happened after it (the one before it is not on record here).
        if (price or 0) >= min_price:
            out[pid] = SaleFacts(Sale(d.year, d.month, int(price)))
        else:
            out[pid] = SaleFacts(None, d.year)
    return out


# --- Martin and St. Lucie: full transfer exports --------------------------------------------------

def _read_zip_csv(path: Path, member_hint: str, sep: str, usecols: list[str]):
    import pandas as pd

    with zipfile.ZipFile(path) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith((".csv", ".txt"))]
        name = next((n for n in names if member_hint.lower() in n.lower()), names[0] if names else None)
        if name is None:
            raise ValueError(f"{path.name}: no CSV inside")
        with zf.open(name) as fh:
            return pd.read_csv(fh, sep=sep, dtype=str, usecols=usecols, keep_default_na=False,
                               encoding="latin-1", low_memory=False)


def _history(df, pid_col: str, date_col: str, price_col: str, qual_col: str | None, date_fmt: str,
             pids: set[str], min_price: int) -> tuple[dict[str, SaleFacts], int | None]:
    """(facts per parcel, year from which the export's records are complete)."""
    import pandas as pd

    all_years = pd.to_datetime(df[date_col].str.slice(0, 10), format=date_fmt, errors="coerce").dt.year
    start = coverage_start(all_years.dropna().astype(int))
    df = df.assign(pid=df[pid_col].map(norm_parcel_id))
    df = df[df["pid"].isin(pids)]
    when = pd.to_datetime(df[date_col].str.slice(0, 10), format=date_fmt, errors="coerce")
    price = pd.to_numeric(df[price_col].str.replace(r"[$,]", "", regex=True), errors="coerce").fillna(0)
    qual = df[qual_col].str.strip().str.slice(0, 2) if qual_col else None
    rows: dict[str, list] = {}
    this_year = dt.date.today().year
    for i, (pid, w, p) in enumerate(zip(df["pid"], when, price)):
        if pd.isna(w) or not MIN_VALID_YEAR <= w.year <= this_year:  # future dates are typos
            continue
        q = qual.iat[i] if qual is not None else None
        rows.setdefault(pid, []).append((int(w.year), int(w.month), int(p), q if q and q.isdigit() else None))
    return {pid: _facts(r, min_price) for pid, r in rows.items()}, start


def martin(path: Path, pids: set[str], min_price: int) -> tuple[dict[str, SaleFacts], int | None]:
    """real_transfers.csv: pipe-delimited, ParcelID like 13-37-41-000-000-00010-7, SaleDate MM/DD/YYYY."""
    df = _read_zip_csv(path, "transfer", "|", ["ParcelID", "SaleDate", "SalePrice", "SalesValidity"])
    return _history(df, "ParcelID", "SaleDate", "SalePrice", "SalesValidity", "%m/%d/%Y", pids, min_price)


def st_lucie(path: Path, pids: set[str], min_price: int) -> tuple[dict[str, SaleFacts], int | None]:
    """Transactions.csv: ParcelID like 1301-607-0049-000-5, SaleDate YYYY-MM-DD hh:mm:ss.

    NALCode is a local disqualification scheme (e.g. 0130 = affiliated parties), not the FDOR
    qualification code, so no qualification is recorded for St. Lucie sales.
    """
    df = _read_zip_csv(path, "transaction", ",", ["ParcelID", "SaleDate", "SalePrice"])
    return _history(df, "ParcelID", "SaleDate", "SalePrice", None, "%Y-%m-%d", pids, min_price)


# --- Palm Beach: CAMA flat file (five most recent transfers per parcel) ------------------------------

# Official Records book numbers passed ~11,900 during 2000: a "20xx" date on a lower book is a
# mis-entered or placeholder date (01-JAN-00 mostly), so that sale is skipped.
PBC_BOOK_2000 = 11_000


def _pbc_cama_date(date: str, book: str) -> tuple[int, int] | None:
    """'17-MAR-23' -> (2023, 3); two-digit years in the future belong to the 1900s. Month 0 = unknown."""
    try:
        t = dt.datetime.strptime(date.strip(), "%d-%b-%y")
    except ValueError:
        return None
    year = t.year - 100 if t.year > dt.date.today().year else t.year
    b = int(book) if book.strip().isdigit() else 0
    if year >= 2000 and 0 < b < PBC_BOOK_2000:
        return None
    month = 0 if (t.day, t.month) == (1, 1) else t.month  # 01-JAN marks an unknown sale date
    return year, month


def palm_beach_cama(path: Path, pids: set[str], min_price: int) -> tuple[dict[str, SaleFacts], int | None]:
    """The Property Appraiser's CAMA CSV (PAS405E): each parcel's SALE record lists its five most recent
    transfers (book, page, date, instrument, validity code, type, price).

    https://pbcpao.gov/departments/public_services.htm -> Free Download Flat Files -> CAMA, CSV format.
    Validity codes: Q* qualified, D* disqualified, U* unqualified (stored as the qualification code).
    """
    import io

    years: list[int] = []
    rows: dict[str, list] = {}
    with zipfile.ZipFile(path) as zf:
        name = next((n for n in zf.namelist() if n.upper().startswith("PAS405") and "_RPT_" not in n.upper()), None)
        if name is None:
            raise ValueError(f"{path.name}: no PAS405 CSV inside")
        with zf.open(name) as fh:
            for line in io.TextIOWrapper(fh, encoding="latin-1"):
                if line[17:23] != ",SALE,":
                    continue
                f = line.rstrip("\r\n").split(",")
                pid = norm_parcel_id(f[0])
                mine = pid in pids
                for k in range(5):
                    book, _page, date, _instrument, validity, _kind, price = (f[2 + 7 * k: 9 + 7 * k] + [""] * 7)[:7]
                    if not date.strip():
                        continue
                    ym = _pbc_cama_date(date, book)
                    if ym is None or ym[0] < MIN_VALID_YEAR:
                        continue
                    years.append(ym[0])
                    if mine:
                        p = int(price) if price.strip().isdigit() else 0
                        rows.setdefault(pid, []).append((ym[0], ym[1], p, validity.strip() or None))
    return {pid: _facts(r, min_price) for pid, r in rows.items()}, coverage_start(years)


def find_export(directory: Path, patterns: tuple[str, ...]) -> Path | None:
    for pat in patterns:
        hits = sorted(directory.glob(pat))
        if hits:
            return hits[-1]
    return None
