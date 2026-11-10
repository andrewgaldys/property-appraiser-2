#!/usr/bin/env python3
"""Download every real commercial / multifamily / industrial / institutional parcel in Martin (53),
St. Lucie (66) and Palm Beach (60) from the Florida Statewide Cadastral FeatureServer and publish
them as the web data bundle (replacing the synthetic sample).

Source: Florida Statewide Cadastral (FDOR tax roll joined to county parcel polygons), ArcGIS Online
  https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0

DOR use codes kept by default (DOR_UC):
  003 multifamily 10+, 008 multifamily 2-9,
  010-039 vacant commercial + commercial (stores, office, hotels, mobile home parks = 028, ...),
  040-049 vacant industrial + industrial, 070-079 institutional.
Opt-in: 004 condominium *units* (--include-condo-units) and 002 individual mobile homes
(--include-mobile-homes). Each condo unit is its own parcel, so 004 alone is well over 85k records
in these counties (more than everything else combined), and its densest windows time out.

How it queries: on this statewide table only CO_NO, OBJECTID, PARCEL_ID, OWN_NAME and the shape
are indexed (DOR_UC is not), and each county occupies one contiguous OBJECTID block. So the script
walks each county's block in windows and pages through every window with resultOffset /
resultRecordCount=2000 (the service maximum). Each request stays small; responses are cached under
pipeline/raw/cadastral/ so a re-run only downloads what is missing.

    python pipeline/fetch_real_tricounty_parcels.py                 # fetch (cached) + publish
    python pipeline/fetch_real_tricounty_parcels.py --refresh       # re-download everything
    python pipeline/fetch_real_tricounty_parcels.py --codes 003,008 # a subset of use codes
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import http.client
import json
import random
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pa2.config import AS_OF_YEAR, COUNTIES, COUNTY_CODES, OUT_DIR, RAW_DIR, WEB_DATA_DIR  # noqa: E402
from pa2.dor_codes import ASSET_CLASSES, classify, normalize_use_code  # noqa: E402
from pa2.util import clean_str, norm_parcel_id, to_float, to_int  # noqa: E402

SERVICE = (
    "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/"
    "Florida_Statewide_Cadastral/FeatureServer/0"
)
ATTRIBUTION = "Florida Statewide Cadastral: FDOR tax roll and county property appraisers"
PAGE_SIZE = 2000  # the service's maxRecordCount
WINDOW = 25_000  # OBJECTIDs per window
SQFT_PER_M2 = 10.7639104

DEFAULT_CODES = (
    ["003", "008"]
    + [f"{n:03d}" for n in range(10, 50)]
    + [f"{n:03d}" for n in range(70, 80)]
)
CONDO_UNIT_CODE = "004"
MOBILE_HOME_CODE = "002"
MIN_PAGE_SIZE = 250

OUT_FIELDS = [
    "OBJECTID", "PARCEL_ID", "CO_NO", "DOR_UC", "ASMNT_YR",
    "JV", "AV_NSD", "LND_VAL", "LND_SQFOOT", "TOT_LVG_AR", "NO_RES_UNT", "NO_BULDNG", "ACT_YR_BLT", "EFF_YR_BLT",
    "QUAL_CD1", "SALE_PRC1", "SALE_YR1", "SALE_MO1", "QUAL_CD2", "SALE_PRC2", "SALE_YR2", "SALE_MO2",
    "OWN_NAME", "OWN_ADDR1", "OWN_ADDR2", "OWN_CITY", "OWN_STATE", "OWN_ZIPCD",
    "PHY_ADDR1", "PHY_CITY", "PHY_ZIPCD", "S_LEGAL", "Shape__Area",
]


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:  # system Pythons usually have a CA bundle already
        return ssl.create_default_context()


SSL_CONTEXT = _ssl_context()


class ServiceError(RuntimeError):
    pass


class QueryFailed(RuntimeError):
    """Every retry of one request failed."""


def _describe(exc: BaseException | None) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code} {exc.reason}"
    if isinstance(exc, urllib.error.URLError):
        return f"network error: {exc.reason}"
    return f"{type(exc).__name__}: {exc}"[:200]


def query(params: dict, *, attempts: int = 7, label: str = "") -> dict:
    """POST a query to the FeatureServer; retry transient failures with backoff."""
    body = urllib.parse.urlencode(params).encode()
    last: BaseException | None = None
    for attempt in range(attempts):
        if attempt:
            time.sleep(min(2**attempt, 45) + random.random())
        req = urllib.request.Request(
            f"{SERVICE}/query",
            data=body,
            headers={
                "User-Agent": "pa2-pipeline/0.1",
                "Accept-Encoding": "gzip",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=180, context=SSL_CONTEXT) as resp:
                raw = resp.read()
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            data = json.loads(raw)
            if isinstance(data, dict) and "error" in data:
                raise ServiceError(json.dumps(data["error"])[:300])
            return data
        # OSError covers URLError/HTTPError, timeouts, resets and SSL errors; ValueError covers bad JSON;
        # HTTPException covers truncated bodies (IncompleteRead); EOFError a truncated gzip stream.
        except (OSError, EOFError, ValueError, http.client.HTTPException, ServiceError) as exc:
            last = exc
            if label:
                print(f"    {label}: {_describe(exc)} (attempt {attempt + 1}/{attempts})", file=sys.stderr, flush=True)
    raise QueryFailed(f"FeatureServer query failed after {attempts} attempts: {_describe(last)}")


def code_clause(codes: list[str]) -> str:
    """['002','003','004','008','010',...] -> compact SQL using ranges for consecutive runs."""
    nums = sorted({int(c) for c in codes})
    runs: list[tuple[int, int]] = []
    start = prev = nums[0]
    for n in nums[1:]:
        if n != prev + 1:
            runs.append((start, prev))
            start = n
        prev = n
    runs.append((start, prev))
    singles = [f"'{n:03d}'" for a, b in runs if b - a < 2 for n in range(a, b + 1)]
    parts = [f"(DOR_UC >= '{a:03d}' AND DOR_UC <= '{b:03d}')" for a, b in runs if b - a >= 2]
    if singles:
        parts.insert(0, f"DOR_UC IN ({','.join(singles)})")
    return "(" + " OR ".join(parts) + ")"


def county_extent(co: int) -> tuple[int, int, int]:
    """(parcel count, min OBJECTID, max OBJECTID) using only the indexed CO_NO field."""
    count = int(query({"where": f"CO_NO={co}", "returnCountOnly": "true", "f": "json"})["count"])
    stats = json.dumps([
        {"statisticType": "min", "onStatisticField": "OBJECTID", "outStatisticFieldName": "lo"},
        {"statisticType": "max", "onStatisticField": "OBJECTID", "outStatisticFieldName": "hi"},
    ])
    attrs = query({"where": f"CO_NO={co}", "outStatistics": stats, "f": "json"})["features"][0]["attributes"]
    return count, int(attrs["lo"]), int(attrs["hi"])


def _read_gz(path: Path) -> list[dict]:
    return json.loads(gzip.decompress(path.read_bytes()))


def _write_gz(path: Path, feats: list[dict]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(gzip.compress(json.dumps(feats, separators=(",", ":")).encode(), mtime=0))
    tmp.replace(path)


def reusable_caches(root: Path, own: Path, codes: list[str], simplify: float) -> list[Path]:
    """Earlier download caches made with the same fields and simplification for a superset of `codes`.

    A window found there is filtered locally instead of downloaded again (e.g. after narrowing the code list).
    """
    want = set(codes)
    found = []
    for meta_path in sorted(root.glob("*/meta.json")):
        if meta_path.parent == own:
            continue
        try:
            meta = json.loads(meta_path.read_text())
        except (OSError, ValueError):
            continue
        if meta.get("simplify") == simplify and meta.get("fields") == OUT_FIELDS and want <= set(meta.get("codes") or []):
            found.append(meta_path.parent)
    return found


def fetch_window(co: int, lo: int, hi: int, clause: str, cache: Path, refresh: bool, simplify: float,
                 reuse: list[Path], want: set[str]) -> tuple[list[dict], str]:
    """All matching features with lo <= OBJECTID < hi, paging with resultOffset / resultRecordCount.

    Returns (features, how): how is "cache", "reused" (filtered from a broader earlier download) or "fetched".
    A page that keeps timing out (dense windows, busy server) is retried at the same offset with half the
    page size, down to MIN_PAGE_SIZE.
    """
    name = f"{co}_{lo}_{hi}.geojson.gz"
    path = cache / name
    if not refresh:
        if path.exists():
            return _read_gz(path), "cache"
        for other in reuse:
            if (other / name).exists():
                feats = [f for f in _read_gz(other / name)
                         if normalize_use_code((f.get("properties") or {}).get("DOR_UC")) in want]
                _write_gz(path, feats)
                return feats, "reused"
    label = f"{COUNTIES[co].name} {lo:,}-{hi - 1:,}"
    feats: list[dict] = []
    offset = 0
    size = PAGE_SIZE
    while True:
        params = {
            "where": f"CO_NO={co} AND OBJECTID>={lo} AND OBJECTID<{hi} AND {clause}",
            "outFields": ",".join(OUT_FIELDS),
            "returnGeometry": "true",
            "outSR": "4326",
            "geometryPrecision": "6",
            "orderByFields": "OBJECTID",
            "resultOffset": str(offset),
            "resultRecordCount": str(size),
            "f": "geojson",
        }
        if simplify > 0:
            params["maxAllowableOffset"] = repr(simplify)
        try:
            data = query(params, attempts=3 if size > MIN_PAGE_SIZE else 7, label=label)
        except QueryFailed:
            if size <= MIN_PAGE_SIZE:
                raise
            size = max(MIN_PAGE_SIZE, size // 2)
            print(f"    {label}: retrying offset {offset:,} at {size} records per page", file=sys.stderr, flush=True)
            continue
        page = data.get("features") or []
        feats.extend(page)
        exceeded = bool((data.get("properties") or {}).get("exceededTransferLimit") or data.get("exceededTransferLimit"))
        if not page or (len(page) < size and not exceeded):
            break
        offset += len(page)
    _write_gz(path, feats)
    return feats, "fetched"


def _polygonal(geom):
    import shapely

    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    parts = [g for g in getattr(geom, "geoms", []) if g.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else None


def to_record(feature: dict, min_sale_price: int) -> dict | None:
    """One cadastral GeoJSON feature -> standardized base record for pa2.publish."""
    import shapely
    from shapely.geometry import shape

    p = feature.get("properties") or {}
    g = feature.get("geometry")
    pid = norm_parcel_id(p.get("PARCEL_ID"))
    if not g or not pid:
        return None
    geom = shape(g)
    if geom.is_empty:
        return None
    if not geom.is_valid:
        geom = _polygonal(shapely.make_valid(geom))
        if geom is None or geom.is_empty:
            return None

    sales = []
    for n in ("1", "2"):
        year, price = to_int(p.get(f"SALE_YR{n}")), to_int(p.get(f"SALE_PRC{n}"))
        if year and year >= 1900 and price and price >= min_sale_price:
            sales.append((year, to_int(p.get(f"SALE_MO{n}")) or 0, price, clean_str(p.get(f"QUAL_CD{n}"))))
    last = max(sales) if sales else None

    lot = to_int(p.get("LND_SQFOOT"))
    if not lot:
        area_m2 = to_float(p.get("Shape__Area"))
        lot = int(round(area_m2 * SQFT_PER_M2)) if area_m2 else None
    return {
        "parcel_id": pid,
        "county_code": int(p["CO_NO"]),
        "site_address": p.get("PHY_ADDR1"),
        "site_city": p.get("PHY_CITY"),
        "site_zip": p.get("PHY_ZIPCD"),
        "use_code": p.get("DOR_UC"),
        "just_value": to_int(p.get("JV")),
        "assessed_value": to_int(p.get("AV_NSD")),
        "land_value": to_int(p.get("LND_VAL")),
        "tot_lvg_area": to_int(p.get("TOT_LVG_AR")),
        "lnd_sqfoot": lot,
        "no_res_unts": to_int(p.get("NO_RES_UNT")),
        "no_buldng": to_int(p.get("NO_BULDNG")),
        "act_yr_blt": to_int(p.get("ACT_YR_BLT")),
        "eff_yr_blt": to_int(p.get("EFF_YR_BLT")),
        "owner_name": p.get("OWN_NAME"),
        "owner_addr1": p.get("OWN_ADDR1"),
        "owner_addr2": p.get("OWN_ADDR2"),
        "owner_city": p.get("OWN_CITY"),
        "owner_state": p.get("OWN_STATE"),
        "owner_zip": p.get("OWN_ZIPCD"),
        "last_sale_year": last[0] if last else None,
        "last_sale_month": (last[1] or None) if last else None,
        "last_sale_price": last[2] if last else None,
        "last_sale_qual_cd": (last[3] or None) if last else None,
        "legal_desc": p.get("S_LEGAL"),
        "tax_roll_year": to_int(p.get("ASMNT_YR")),
        "geometry": geom,
    }


def load_sdf_history(patterns: list[str], counties: list[int], min_price: int) -> tuple[dict, int | None]:
    """Latest sale per (county, parcel ID) from FDOR SDF files of earlier rolls, and the year they start.

    The cadastral layer only carries the current roll's sales window, so hold periods need these.
    Each roll's SDF covers roughly the year before it; the start year is the 0.5th percentile of
    sale years, so a few late-recorded older deeds do not overstate the coverage.
    """
    if not patterns:
        return {}, None
    import glob

    import pandas as pd

    from pa2 import fdor

    paths = sorted({Path(p) for pat in patterns for p in (glob.glob(pat) or [pat]) if Path(p).is_file()})
    if not paths:
        raise SystemExit(f"--sdf matched no files: {' '.join(patterns)}")
    sdf = fdor.read_sdf(paths, counties)
    if sdf is None or not len(sdf):
        return {}, None
    sdf["year"] = pd.to_numeric(sdf["SALE_YR"], errors="coerce")
    sdf["month"] = pd.to_numeric(sdf["SALE_MO"], errors="coerce").fillna(0)
    sdf["price"] = pd.to_numeric(sdf["SALE_PRC"].astype(str).str.replace(r"[$,]", "", regex=True), errors="coerce")
    sdf = sdf[(sdf["year"] >= 1900) & (sdf["price"] >= min_price) & (sdf["pid"] != "")]
    if not len(sdf):
        return {}, None
    start = int(sdf["year"].quantile(0.005))
    sdf = sdf.sort_values(["CO_NO", "pid", "year", "month", "price"]).drop_duplicates(["CO_NO", "pid"], keep="last")
    latest = {
        (int(co), pid): (int(y), int(m), int(p), clean_str(q) or None)
        for co, pid, y, m, p, q in sdf[["CO_NO", "pid", "year", "month", "price", "QUAL_CD"]].itertuples(index=False)
    }
    print(f"  SDF history: {len(paths)} file(s), latest sale for {len(latest):,} parcels, coverage from {start}")
    return latest, start


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--counties", default=",".join(map(str, COUNTY_CODES)), help="FDOR county codes (default 53,60,66)")
    ap.add_argument("--codes", default=",".join(DEFAULT_CODES), help="DOR use codes to keep")
    ap.add_argument("--include-condo-units", action="store_true",
                    help=f"also fetch DOR {CONDO_UNIT_CODE} condominium units (one parcel per unit; ~3x the data)")
    ap.add_argument("--include-mobile-homes", action="store_true",
                    help=f"also fetch DOR {MOBILE_HOME_CODE} individual mobile homes (parks are 028, kept by default)")
    ap.add_argument("--refresh", action="store_true", help="ignore the download cache")
    ap.add_argument("--allow-partial", action="store_true",
                    help="publish even if some windows still fail after the retry pass (default: publish nothing)")
    ap.add_argument("--workers", type=int, default=4, help="parallel requests (be polite: <= 6)")
    ap.add_argument("--simplify", type=float, default=0.000005,
                    help="server-side maxAllowableOffset in degrees (default ~0.5 m; 0 = full detail)")
    ap.add_argument("--min-sale-price", type=int, default=100, help="ignore nominal transfers below this")
    ap.add_argument("--sdf", nargs="*", default=[], metavar="PATH",
                    help="FDOR SDF files from earlier rolls (CSV or the portal's zips; globs ok). The cadastral layer "
                         "only has the current roll's sales window, so these extend the history behind hold periods")
    ap.add_argument("--as-of-year", type=int, default=AS_OF_YEAR, help="hold period = this year - last sale year")
    ap.add_argument("--shard-hex", type=int, default=2, help="hex chars per detail/owner shard (2 = 256 files)")
    ap.add_argument("--tiler", choices=["auto", "tippecanoe", "python"], default="auto")
    ap.add_argument("--out", type=Path, default=WEB_DATA_DIR)
    ap.add_argument("--fetch-only", action="store_true", help="download / refresh the cache without publishing")
    args = ap.parse_args()

    counties = [int(c) for c in args.counties.split(",") if c.strip()]
    raw_codes = args.codes.split(",")
    if args.include_condo_units:
        raw_codes.append(CONDO_UNIT_CODE)
    if args.include_mobile_homes:
        raw_codes.append(MOBILE_HOME_CODE)
    codes = sorted({normalize_use_code(c) for c in raw_codes if normalize_use_code(c)})
    clause = code_clause(codes)
    fingerprint = hashlib.sha1(f"{clause}|{args.simplify}|{','.join(OUT_FIELDS)}".encode()).hexdigest()[:10]
    cache = RAW_DIR / "cadastral" / fingerprint
    cache.mkdir(parents=True, exist_ok=True)
    meta_path = cache / "meta.json"
    if not meta_path.exists():
        meta_path.write_text(json.dumps({"codes": codes, "simplify": args.simplify, "fields": OUT_FIELDS}, indent=1))
    reuse = [] if args.refresh else reusable_caches(cache.parent, cache, codes, args.simplify)
    print(f"filter: {clause}")
    print(f"cache:  {cache.relative_to(RAW_DIR.parent)}"
          + (f" (re-using {len(reuse)} broader earlier download(s))" if reuse else ""))

    jobs: list[tuple[int, int, int]] = []
    for co in counties:
        n, lo, hi = county_extent(co)
        windows = [(co, a, min(a + WINDOW, hi + 1)) for a in range(lo, hi + 1, WINDOW)]
        jobs += windows
        print(f"  {co} {COUNTIES[co].name:<11} {n:>8,} parcels in OBJECTID {lo:,}-{hi:,} -> {len(windows)} windows")

    t0 = time.time()
    results: dict[tuple[int, int, int], list[dict]] = {}
    how: Counter[str] = Counter()
    want = set(codes)

    def run(batch: list[tuple[int, int, int]], workers: int) -> list[tuple[int, int, int]]:
        """Fetch a batch of windows; one failing window never stops the others. Returns the failures."""
        failed = []
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(fetch_window, co, a, b, clause, cache, args.refresh, args.simplify, reuse, want): (co, a, b)
                for co, a, b in batch
            }
            for fut in as_completed(futures):
                job = futures[fut]
                try:
                    feats, kind = fut.result()
                except Exception as exc:  # noqa: BLE001 - isolate the window, retried below
                    failed.append(job)
                    print(f"  ! {COUNTIES[job[0]].name} window {job[1]:,}-{job[2] - 1:,} failed: {exc}", flush=True)
                    continue
                results[job] = feats
                how[kind] += 1
                n = len(results)
                if n % 5 == 0 or n == len(jobs):
                    total = sum(map(len, results.values()))
                    print(f"  {n}/{len(jobs)} windows, {total:,} parcels "
                          f"({how['fetched']} downloaded, {how['cache'] + how['reused']} from cache, {time.time() - t0:.0f}s)",
                          flush=True)
        return failed

    failed = run(jobs, max(1, min(args.workers, 8)))
    if failed:
        print(f"retrying {len(failed)} failed window(s) one at a time in 30s ...", flush=True)
        time.sleep(30)
        failed = run(failed, 1)
    if failed:
        print(f"{len(failed)} window(s) still failing: "
              + ", ".join(f"{COUNTIES[co].name} {a:,}-{b - 1:,}" for co, a, b in failed), flush=True)
        if not args.allow_partial:
            print("Nothing was published. Re-run the same command to resume: finished windows are cached.", flush=True)
            return 1
        print("--allow-partial: publishing without them.", flush=True)
    if args.fetch_only:
        return 0
    features = [f for job in jobs if job in results for f in results[job]]

    records: dict[tuple[int, str], dict] = {}
    skipped = merged = 0
    import shapely

    for f in features:
        rec = to_record(f, args.min_sale_price)
        if rec is None:
            skipped += 1
            continue
        key = (rec["county_code"], rec["parcel_id"])
        if key in records:  # multi-part parcel delivered as several features
            records[key]["geometry"] = shapely.union_all([records[key]["geometry"], rec["geometry"]])
            merged += 1
        else:
            records[key] = rec
    recs = list(records.values())
    print(f"{len(recs):,} parcels ({merged} multi-part pieces merged, {skipped} without geometry/ID skipped)")

    history, history_from = load_sdf_history(args.sdf, counties, args.min_sale_price)
    if history:
        newer = 0
        for key, rec in records.items():
            s = history.get(key)
            if s and (rec["last_sale_year"] is None or s[:2] > (rec["last_sale_year"], rec["last_sale_month"] or 0)):
                rec["last_sale_year"], rec["last_sale_month"] = s[0], s[1] or None
                rec["last_sale_price"], rec["last_sale_qual_cd"] = s[2], s[3]
                newer += 1
        print(f"  SDF history supplied the last sale for {newer:,} parcels")

    by_class = Counter(classify(normalize_use_code(r["use_code"])) for r in recs)
    by_county = Counter(r["county_code"] for r in recs)
    print("  by county:", ", ".join(f"{COUNTIES[c].name} {n:,}" for c, n in sorted(by_county.items())))
    print("  by class: ", ", ".join(f"{ASSET_CLASSES[c][0]} {n:,}" for c, n in by_class.most_common()))

    from pa2.io import write_parquet
    from pa2.publish import publish

    roll = Counter(r["tax_roll_year"] for r in recs if r["tax_roll_year"]).most_common(1)
    roll_year = roll[0][0] if roll else None
    # The cadastral layer only carries the roll's two most recent sale slots, which cover the current
    # sales window (2025-26 on the 2026 roll), not a full history: record where that window starts.
    sale_years = [r["last_sale_year"] for r in recs if r["last_sale_year"]]
    sales_from = min(sale_years) if sale_years else None
    if history_from is not None:
        sales_from = min(history_from, sales_from or history_from)
    with_sale = len(sale_years)
    print(f"  sales: {with_sale:,} parcels ({with_sale / len(recs):.0%}) carry a sale; sale data covers {sales_from} on")
    manifest = publish(
        recs,
        args.out,
        source_kind="cadastral",
        source_label=f"Florida Statewide Cadastral, {roll_year} roll" if roll_year else "Florida Statewide Cadastral",
        attribution=ATTRIBUTION,
        tax_roll_year=roll_year,
        as_of_year=args.as_of_year,
        sales_from=sales_from,
        shard_hex=args.shard_hex,
        tiler=args.tiler,
        write_geojson=False,
        work_dir=OUT_DIR,
    )
    write_parquet(recs, OUT_DIR / "parcels.parquet")
    s = manifest["stats"]
    print(f"published {s['parcels']:,} parcels, ${s['just_value'] / 1e9:.1f}B just value -> {args.out} "
          f"({time.time() - t0:.0f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
