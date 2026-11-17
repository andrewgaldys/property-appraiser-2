#!/usr/bin/env python3
"""Deal signals per parcel: which owners are more likely to sell or refinance, and why.

Inputs (only the parcel table is required; a missing source skips its signals and the report says so):
  pipeline/out/parcels.parquet                     the joined parcel table the last data build wrote
  pipeline/out/sunbiz/parcel_entities.csv          state business records (build_entities.py)
  pipeline/raw/county_sales/                       county transfer histories (the data build's caches)
  pipeline/raw/fema/<fips>/NFHL_<fips>C.zip        FEMA flood zones, one file per county (msc.fema.gov)
  pipeline/raw/coastline/tl_*_us_coastline.zip     the Census coastline
  pipeline/raw/tax/palm_beach/County_Certs_*.xlsx  Palm Beach county-held tax certificates (pbctax.gov)
  pipeline/out/debt/parcel_debt.json               securitized loans and federal liens (build_debt.py)

    python pipeline/build_signals.py                # compute, report, publish into web/public/data
    python pipeline/build_signals.py --no-publish   # compute and report only (pipeline/out/signals/)
    python pipeline/build_signals.py --clear        # remove the published signals

Outputs
  pipeline/out/signals/report.json    parcels per signal and county, sources and dates
  pipeline/out/signals/signals.csv    every flagged parcel with its chips
  web/public/data/signals/flags.json  each flagged parcel's signal mask (lists, filters, exports)
  web/public/data/signals/detail/     each parcel's chips with record date and confidence (panels)
  manifest.json "signals"             definitions, sources with their dates, counts per county
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import pickle
import datetime as dt
import json
import re
import shutil
import sys
import zipfile
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from pa2 import __version__  # noqa: E402
from pa2 import county_sales  # noqa: E402
from pa2 import signals as G  # noqa: E402
from pa2 import sunbiz  # noqa: E402
from pa2.config import (  # noqa: E402
    AS_OF_YEAR, COUNTIES, NOMINAL_VALUE_MAX, OUT_DIR, RAW_DIR, SIGNAL_COAST_MILES, SIGNAL_FLIP_MIN_PRICE,
    SIGNAL_FLIP_MONTHS, SIGNAL_FUND_EXIT_YEARS, SIGNAL_LOAN_MATURITY_MONTHS, SIGNAL_PRE_CODE_YEAR,
    SIGNAL_RECENT_TRANSFER_YEARS, SIGNAL_TAX_GAP_MIN, WEB_DATA_DIR,
)
from pa2.util import fnv1a32, norm_parcel_id  # noqa: E402

WORK = OUT_DIR / "signals"
PARCELS = OUT_DIR / "parcels.parquet"
ENTITIES = OUT_DIR / "sunbiz" / "parcel_entities.csv"
DEBT = OUT_DIR / "debt"
DETAIL_FIELDS = ["code", "chip", "date", "conf", "facts"]
FLORIDA_ALBERS = "EPSG:3086"  # NAD83 / Florida GDL Albers, metres
METRES_PER_MILE = 1609.344
TODAY = dt.date.today().isoformat()


def log(msg: str) -> None:
    print(msg, flush=True)


def _num(v) -> float | None:
    """A number, or None for blanks and NaN."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def _pulled(path: Path) -> str:
    return dt.datetime.fromtimestamp(path.stat().st_mtime).date().isoformat()


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


def load_parcels(path: Path):
    import geopandas as gpd

    cols = ["parcel_id", "county_code", "owner_name", "just_value", "assessed_value", "hold_period_years",
            "last_sale_price", "last_sale_year", "last_sale_month", "last_sale_qual_cd", "act_yr_blt", "eff_yr_blt",
            "tot_lvg_area", "tax_roll_year", "geometry"]
    gdf = gpd.read_parquet(path, columns=cols)
    gdf["parcel_id"] = gdf["parcel_id"].astype(str)
    return gdf


def load_entities(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    with path.open(newline="") as fh:
        return {r["parcel_id"]: r for r in csv.DictReader(fh)}


def sale_histories(gdf) -> tuple[dict[str, list[G.Sale]], dict[str, str]]:
    """Every transfer on record per parcel: the county histories the data build reads, plus each
    parcel's latest sale. Returns (sales per parcel, history source per county)."""
    root = RAW_DIR / "county_sales"
    by_county: dict[int, set[str]] = defaultdict(set)
    for pid, co in zip(gdf["parcel_id"], gdf["county_code"]):
        by_county[int(co)].add(pid)
    keep: dict[str, list] = {}
    sources: dict[str, str] = {}

    def take(co: int, label: str, fn) -> None:
        part: dict[str, list] = {}
        try:
            fn(part)
        except Exception as exc:  # a missing or changed export: report it, keep going
            log(f"  {COUNTIES[co].name} sale history unavailable: {exc}")
            return
        for pid, sales in part.items():
            keep.setdefault(pid, []).extend(G.Sale(s.year, s.month, s.price, s.qual, label) for s in sales)
        sources[str(co)] = label

    cama = county_sales.find_export(root / "palm_beach" / "cama", ("CAMA_CSV_*.zip", "*CAMA*.zip"))
    if cama:
        take(60, "Palm Beach Property Appraiser CAMA (five latest transfers)",
             lambda k: county_sales.palm_beach_cama(cama, by_county[60], 100, keep=k))
    martin = county_sales.find_export(root / "martin", ("*transfer*.zip", "*transfer*.csv"))
    if martin:
        take(53, "Martin Property Appraiser transfer file (all transfers)",
             lambda k: county_sales.martin(martin, by_county[53], 100, keep=k))
    stl = county_sales.find_export(root / "stlucie", ("Transactions*.zip", "*ransaction*.zip"))
    if stl:
        take(66, "St. Lucie Property Appraiser transactions (all transfers)",
             lambda k: county_sales.st_lucie(stl, by_county[66], 100, keep=k))
    bro = root / "broward" / "transfers.json.gz"
    if bro.exists():
        take(16, "Broward Property Appraiser (five latest transfers)",
             lambda k: county_sales.broward(sorted(by_county[16]), bro, 100, keep=k))
    # Everyone's latest sale (Miami-Dade and Indian River publish only that).
    for r in gdf[["parcel_id", "last_sale_year", "last_sale_month", "last_sale_price", "last_sale_qual_cd"]].itertuples(index=False):
        if _num(r.last_sale_year):
            s = G.Sale(int(_num(r.last_sale_year)), int(_num(r.last_sale_month) or 0), int(_num(r.last_sale_price) or 0),
                       str(r.last_sale_qual_cd) if isinstance(r.last_sale_qual_cd, str) else None, "latest sale")
            have = keep.setdefault(r.parcel_id, [])
            if not any((x.year, x.month, x.price) == (s.year, s.month, s.price) for x in have):
                have.append(s)
    for co in (23, 41):
        sources.setdefault(str(co), "Latest sale only")
    return keep, sources


def _cached(name: str, inputs: list[Path], compute):
    """compute() once per set of input files (names, sizes, dates); reruns read the result back."""
    key = hashlib.sha1(json.dumps([[str(p), p.stat().st_size, int(p.stat().st_mtime)] for p in inputs if p.exists()]).encode()).hexdigest()
    path = WORK / f"{name}.pickle"
    if path.exists():
        with path.open("rb") as fh:
            data = pickle.load(fh)
        if data.get("key") == key:
            log(f"  {name}: using the cached result")
            return data["value"]
    value = compute()
    WORK.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        pickle.dump({"key": key, "value": value}, fh, protocol=pickle.HIGHEST_PROTOCOL)
    return value


def flood_zones(gdf) -> tuple[dict[str, dict], dict[str, dict]]:
    """Per parcel: FEMA zone at its center, its share in the 1% flood zone (SFHA) and in V zones.
    Returns (facts per parcel, source per county)."""
    inputs = [PARCELS, *sorted((RAW_DIR / "fema").glob("*/NFHL_*.zip"))]
    return _cached("flood", inputs, lambda: _flood_zones(gdf))


def _flood_zones(gdf) -> tuple[dict[str, dict], dict[str, dict]]:
    import geopandas as gpd
    import numpy as np
    import pandas as pd
    import shapely

    out: dict[str, dict] = {}
    sources: dict[str, dict] = {}
    root = RAW_DIR / "fema"
    for co, c in COUNTIES.items():
        zips = sorted((root / c.fips).glob("NFHL_*.zip")) if (root / c.fips).exists() else []
        if not zips:
            log(f"  no FEMA flood file for {c.name}")
            continue
        z = zips[-1]
        try:
            with zipfile.ZipFile(z) as zf:
                meta = next((n for n in zf.namelist() if n.endswith("_metadata.xml")), "")
                shp = next((n for n in zf.namelist() if n.upper().endswith("S_FLD_HAZ_AR.SHP")), None)
        except zipfile.BadZipFile:
            log(f"  {z.name} is incomplete or damaged (re-download it): {c.name} flood signals skipped")
            continue
        if not shp:
            log(f"  {z.name}: no flood hazard areas inside")
            continue
        m = re.search(r"_(\d{8})_", meta)
        fema_date = f"{m.group(1)[:4]}-{m.group(1)[4:6]}-{m.group(1)[6:]}" if m else None
        sources[str(co)] = {"file": z.name, "as_of": fema_date, "pulled": _pulled(z)}
        zones = gpd.read_file(f"/vsizip/{z.resolve()}/{shp}", columns=["FLD_ZONE", "ZONE_SUBTY"])
        zones = zones[zones.geometry.notna()].to_crs(FLORIDA_ALBERS)
        zones["geometry"] = shapely.make_valid(zones.geometry.values)
        zones["FLD_ZONE"] = zones["FLD_ZONE"].fillna("").str.strip().str.upper()
        parcels = gdf[gdf["county_code"] == co][["parcel_id", "geometry"]].to_crs(FLORIDA_ALBERS)
        parcels = parcels[parcels.geometry.notna()]
        parcels["geometry"] = shapely.make_valid(parcels.geometry.values)
        area = dict(zip(parcels["parcel_id"], parcels.geometry.area))
        # Zone at the parcel's center (a point inside it).
        pts = gpd.GeoDataFrame(parcels[["parcel_id"]], geometry=parcels.geometry.representative_point(), crs=FLORIDA_ALBERS)
        at = gpd.sjoin(pts, zones[["FLD_ZONE", "geometry"]], predicate="within", how="inner")
        at["sfha"] = at["FLD_ZONE"].isin(G.SFHA_ZONES)
        centre = at.sort_values("sfha", ascending=False).drop_duplicates("parcel_id").set_index("parcel_id")["FLD_ZONE"]
        # Share of each parcel inside the 1% flood zone, and in V zones.
        sfha = zones[zones["FLD_ZONE"].isin(G.SFHA_ZONES)]
        pairs = gpd.sjoin(parcels, sfha[["FLD_ZONE", "geometry"]], predicate="intersects", how="inner")
        shares: dict[str, dict] = defaultdict(lambda: {"sfha": 0.0, "v": 0.0, "zones": defaultdict(float)})
        if len(pairs):
            inter = shapely.intersection(pairs.geometry.values, sfha.geometry.values[pairs["index_right"].map(
                {ix: i for i, ix in enumerate(sfha.index)}).values])
            pairs = pairs.assign(a=shapely.area(inter))
            for pid, zone, a in zip(pairs["parcel_id"], pairs["FLD_ZONE"], pairs["a"]):
                s = shares[pid]
                s["sfha"] += a
                s["zones"][zone] += a
                if zone in G.V_ZONES:
                    s["v"] += a
        n_in = 0
        for pid in parcels["parcel_id"]:
            a = area.get(pid) or 0.0
            s = shares.get(pid)
            sf = min(1.0, s["sfha"] / a) if s and a > 0 else 0.0
            vf = min(1.0, s["v"] / a) if s and a > 0 else 0.0
            top = max(s["zones"].items(), key=lambda kv: kv[1])[0] if s and s["zones"] else None
            cz = centre.get(pid) if pid in centre.index else None
            out[pid] = {"zone": top, "centre": cz, "sfha": sf, "v": vf, "date": fema_date}
            n_in += sf >= 0.5 or (cz in G.SFHA_ZONES)
        log(f"  {c.name}: FEMA zones of {date_or(fema_date)}, {n_in:,} of {len(parcels):,} parcels in the 1% flood zone")
    return out, sources


def date_or(d: str | None) -> str:
    return d or "unknown date"


def coast_distance(gdf) -> tuple[dict[str, float], dict | None]:
    return _cached("coast", [PARCELS, *sorted((RAW_DIR / "coastline").glob("tl_*_us_coastline.zip"))], lambda: _coast_distance(gdf))


def _coast_distance(gdf) -> tuple[dict[str, float], dict | None]:
    import geopandas as gpd
    import shapely

    zips = sorted((RAW_DIR / "coastline").glob("tl_*_us_coastline.zip"))
    if not zips:
        log("  no Census coastline file: near-coast signal skipped")
        return {}, None
    z = zips[-1]
    coast = gpd.read_file(f"/vsizip/{z.resolve()}/{z.stem}.shp")
    b = gdf.total_bounds
    coast = coast.cx[b[0] - 0.5:b[2] + 0.5, b[1] - 0.5:b[3] + 0.5].to_crs(FLORIDA_ALBERS)
    line = shapely.union_all(coast.geometry.values)
    pts = gdf[["parcel_id", "geometry"]].to_crs(FLORIDA_ALBERS)
    pts = pts[pts.geometry.notna()]
    d = shapely.distance(pts.geometry.representative_point().values, line) / METRES_PER_MILE
    year = re.search(r"tl_(\d{4})_", z.name)
    return dict(zip(pts["parcel_id"], d)), {"file": z.name, "as_of": year.group(1) if year else None, "pulled": _pulled(z)}


def xlsx_rows(path: Path) -> list[list[str]]:
    """First worksheet of an .xlsx as rows of text (standard library only)."""
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(path) as zf:
        strings: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ElementTree.fromstring(zf.read("xl/sharedStrings.xml"))
            strings = ["".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")) for si in root.findall("m:si", ns)]
        sheet = sorted(n for n in zf.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))[0]
        root = ElementTree.fromstring(zf.read(sheet))
    rows: list[list[str]] = []
    for r in root.iter(f"{{{ns['m']}}}row"):
        cells: dict[int, str] = {}
        for c in r.findall("m:c", ns):
            ref = c.get("r", "")
            col = 0
            for ch in re.match(r"[A-Z]+", ref).group(0) if ref else "A":
                col = col * 26 + (ord(ch) - 64)
            v = c.find("m:v", ns)
            text = ""
            if c.get("t") == "s" and v is not None:
                text = strings[int(v.text)]
            elif c.get("t") == "inlineStr":
                text = "".join(t.text or "" for t in c.iter(f"{{{ns['m']}}}t"))
            elif v is not None:
                text = v.text or ""
            cells[col] = text.strip()
        if cells:
            rows.append([cells.get(i, "") for i in range(1, max(cells) + 1)])
    return rows


def tax_certificates(pids: set[str]) -> tuple[dict[str, dict], dict[str, dict]]:
    """Outstanding tax certificates per parcel, from the county lists in pipeline/raw/tax/."""
    out: dict[str, dict] = {}
    sources: dict[str, dict] = {}
    pbc = sorted((RAW_DIR / "tax" / "palm_beach").glob("County_Certs*.xlsx"))
    if pbc:
        rows = xlsx_rows(pbc[-1])
        head_i = next((i for i, r in enumerate(rows[:20]) if any(re.search(r"parcel|pcn|property", c, re.I) for c in r)), None)
        if head_i is None:
            log(f"  {pbc[-1].name}: no parcel column found; skipped")
        else:
            head = [c.lower() for c in rows[head_i]]

            def col(*pats: str) -> int | None:
                """The first column matching the first pattern that matches any column (patterns by priority)."""
                for p in pats:
                    hit = next((i for i, c in enumerate(head) if re.search(p, c)), None)
                    if hit is not None:
                        return hit
                return None

            ci_pid = col(r"^(pin|pcn|parcel.*|parcel id|folio)$", r"parcel", r"^pin\b|\bpcn\b")
            ci_year = col(r"^tax ?year$", r"tax ?year")
            ci_cert, ci_amt = col(r"^cert.*(no|num)", r"cert"), col(r"^face", r"face", r"amount|total|due")
            n = 0
            for r in rows[head_i + 1:]:
                if ci_pid is None or ci_pid >= len(r):
                    continue
                pid = norm_parcel_id(r[ci_pid])
                if pid not in pids:
                    continue
                n += 1
                e = out.setdefault(pid, {"count": 0, "years": set(), "amount": 0.0, "certs": []})
                e["count"] += 1
                if ci_year is not None and ci_year < len(r) and r[ci_year][:4].isdigit():
                    e["years"].add(int(r[ci_year][:4]))
                if ci_amt is not None and ci_amt < len(r):
                    try:
                        e["amount"] += float(r[ci_amt].replace(",", "").replace("$", ""))
                    except ValueError:
                        pass
                if ci_cert is not None and ci_cert < len(r) and r[ci_cert]:
                    e["certs"].append(r[ci_cert])
            m = re.search(r"(\d{1,2})\.(\d{1,2})\.(\d{2})", pbc[-1].name)
            as_of = f"20{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else None
            sources["60"] = {"file": pbc[-1].name, "as_of": as_of, "pulled": _pulled(pbc[-1]),
                             "kind": "county-held certificates only"}
            log(f"  Palm Beach county-held certificates: {n:,} on {len([p for p in out if p])} parcels in the dataset")
    return out, sources


def load_debt(pids: set[str]) -> tuple[dict[str, dict], dict[str, dict]]:
    """Securitized loans and federal liens per parcel, and their sources (build_debt.py's last run)."""
    path, rep = DEBT / "parcel_debt.json", DEBT / "report.json"
    if not path.exists():
        log("  no debt records (python pipeline/build_debt.py): loan and lien signals skipped")
        return {}, {}
    debt = {pid: v for pid, v in json.loads(path.read_text()).items() if pid in pids}
    sources = json.loads(rep.read_text()).get("sources", {}) if rep.exists() else {}
    log(f"  debt records for {len(debt):,} parcels")
    return debt, {k: v for k, v in sources.items() if k in ("sec", "flr", "treasury")}


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------


def owner_kind(name: str, ent: dict | None) -> str | None:
    """'LLC' / 'corporation' / 'partnership' / 'company' for company owners, else None."""
    if ent and ent.get("family") in G.FAMILY_LABEL:
        return G.FAMILY_LABEL[ent["family"]]
    s = " ".join(str(name or "").upper().replace(".", " ").replace(",", " ").split())
    if not s or not sunbiz.company_like(s):
        return None
    if sunbiz._K_LLC.search(s):
        return "LLC"
    if sunbiz._K_LP.search(s):
        return "partnership"
    if sunbiz._K_CORP.search(s):
        return "corporation"
    return None


def run(*, parcels: Path = PARCELS, out: Path = WEB_DATA_DIR, publish: bool = True) -> dict:
    import pandas as pd

    WORK.mkdir(parents=True, exist_ok=True)
    log(f"Deal signals: {parcels}")
    gdf = load_parcels(parcels)
    pids = set(gdf["parcel_id"])
    county_of = dict(zip(gdf["parcel_id"], gdf["county_code"].astype(int)))
    roll_year = int(gdf["tax_roll_year"].dropna().max()) if gdf["tax_roll_year"].notna().any() else AS_OF_YEAR
    manifest = json.loads((out / "manifest.json").read_text()) if (out / "manifest.json").exists() else {}
    nominal = int(manifest.get("data_quality", {}).get("nominal_value_max", NOMINAL_VALUE_MAX))

    ents = load_entities(ENTITIES)
    log(f"  state business records: {len(ents):,} parcels" if ents else "  no Sunbiz matches (run build_entities.py): entity signals skipped")
    sales, sale_sources = sale_histories(gdf)
    log(f"  sale histories for {len(sales):,} parcels")
    flood, fema_sources = flood_zones(gdf)
    coast, coast_source = coast_distance(gdf)
    certs, tax_sources = tax_certificates(pids)
    debt, debt_sources = load_debt(pids)

    hits: dict[str, list[G.Hit]] = {}
    this_year = AS_OF_YEAR
    for r in gdf.itertuples(index=False):
        pid = r.parcel_id
        ent = ents.get(pid)
        h: list[G.Hit] = []
        h += G.entity_signals(ent)
        hold = _num(r.hold_period_years)
        sy, sm = _num(r.last_sale_year), _num(r.last_sale_month)
        last = G.ym(int(sy), int(sm or 0)) if sy else None
        fe = G.fund_exit(hold, owner_kind(r.owner_name, ent), last)
        if fe:
            h.append(fe)
        jv, av = _num(r.just_value), _num(r.assessed_value)
        tr = G.taxes_rising(jv, av, nominal, roll_year)
        if tr:
            h.append(tr)
        h += G.transfer_signals(sales.get(pid, []), this_year)
        f = flood.get(pid)
        if f:
            yb = int(_num(r.act_yr_blt)) if _num(r.act_yr_blt) else None
            built = (_num(r.tot_lvg_area) or 0) > 0
            h += G.flood_signals(f["zone"], f["sfha"], f["centre"], f["sfha"], f["v"], yb, built, f["date"])
        if pid in coast:
            nc = G.near_coast(float(coast[pid]), coast_source and coast_source.get("as_of"))
            if nc:
                h.append(nc)
        c = certs.get(pid)
        if c:
            yrs = sorted(c["years"])
            chip = f"County-held tax certificate{'s' if c['count'] > 1 else ''}" + (f" ({', '.join(map(str, yrs))})" if yrs else "")
            src = tax_sources.get(str(county_of[pid]), {})
            h.append(G.Hit("tax_certificate", chip, src.get("as_of"), 0.95,
                           {"count": c["count"], **({"amount": round(c["amount"])} if c["amount"] else {}),
                            **({"certs": c["certs"][:5]} if c["certs"] else {})}))
        d = debt.get(pid)
        if d:
            h += G.loan_signals(d.get("loans", []), TODAY)
            h += G.lien_signals(d.get("liens", []))
        if h:
            hits[pid] = h

    summary = G.summarize(hits, county_of)
    sources = {
        "sunbiz": {"label": "Florida Division of Corporations (Sunbiz) quarterly file",
                   "as_of": next(iter(ents.values()))["file_date"] if ents else None},
        "sales": {"label": "County property appraiser sale records and the FDOR tax roll", "per_county": sale_sources},
        "roll": {"label": f"Florida Department of Revenue {roll_year} tax roll (Statewide Cadastral)", "as_of": str(roll_year)},
        "fema": {"label": "FEMA National Flood Hazard Layer", "per_county": fema_sources},
        "coastline": {"label": "U.S. Census TIGER/Line coastline", **(coast_source or {})},
        "tax": {"label": "County Tax Collector certificate lists", "per_county": tax_sources},
        **debt_sources,
    }
    report = {
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "parcels": len(gdf), "flagged": len(hits), **summary, "sources": sources,
        "thresholds": thresholds(),
    }
    (WORK / "report.json").write_text(json.dumps(report, indent=2, default=list))
    with (WORK / "signals.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["parcel_id", "county", "signals", "chips"])
        for pid, hs in sorted(hits.items()):
            w.writerow([pid, COUNTIES[county_of[pid]].name, " ".join(x.code for x in hs), "; ".join(x.chip for x in hs)])
    log(f"  {len(hits):,} of {len(gdf):,} parcels carry at least one signal")
    for s in G.SIGNALS:
        n = summary["counts"].get(s.code, 0)
        log(f"    {s.code:<16} {n:>7,}  " + "  ".join(
            f"{COUNTIES[int(co)].short} {cnt.get(s.code, 0):,}" for co, cnt in sorted(summary['per_county'].items()) if co))
    if publish:
        write_bundle(out, hits, report)
    return report


def thresholds() -> dict:
    return {
        "fund_exit_years": list(SIGNAL_FUND_EXIT_YEARS), "tax_gap_min": SIGNAL_TAX_GAP_MIN,
        "flip_months": SIGNAL_FLIP_MONTHS, "flip_min_price": SIGNAL_FLIP_MIN_PRICE,
        "recent_transfer_years": SIGNAL_RECENT_TRANSFER_YEARS, "pre_code_year": SIGNAL_PRE_CODE_YEAR,
        "coast_miles": SIGNAL_COAST_MILES, "loan_maturity_months": SIGNAL_LOAN_MATURITY_MONTHS,
    }


def _dump(path: Path, obj) -> int:
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False, default=list)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def clear_bundle(out: Path) -> None:
    shutil.rmtree(out / "signals", ignore_errors=True)
    mf = out / "manifest.json"
    if mf.exists():
        m = json.loads(mf.read_text())
        if m.pop("signals", None) is not None:
            mf.write_text(json.dumps(m, separators=(",", ":")))


def write_bundle(out: Path, hits: dict[str, list[G.Hit]], report: dict) -> None:
    mf = out / "manifest.json"
    manifest = json.loads(mf.read_text())
    shard_hex = int(manifest.get("details", {}).get("shard_hex", 2))
    root = out / "signals"
    shutil.rmtree(root, ignore_errors=True)
    (root / "detail").mkdir(parents=True)
    flags = {pid: G.mask(hs) for pid, hs in hits.items()}
    n_flags = _dump(root / "flags.json", {"fields": ["sg"], "rows": flags})
    shards: dict[str, dict] = defaultdict(dict)
    for pid, hs in hits.items():
        shards[fnv1a32(pid)[:shard_hex]][pid] = [x.row() for x in hs]
    n_detail = sum(_dump(root / "detail" / f"{s}.json", {"fields": DETAIL_FIELDS, "rows": rows}) for s, rows in shards.items())
    manifest["pipeline_version"] = __version__
    manifest["signals"] = {
        "schema": "pa2-signals/1",
        "generated_at": report["generated_at"],
        "defs": [{"bit": s.bit, "code": s.code, "label": s.label, "group": s.group, "source": s.source} for s in G.SIGNALS],
        "sources": report["sources"],
        "flags": {"url": "signals/flags.json", "bytes": n_flags},
        "detail": {"url": "signals/detail/{shard}.json", "shard_hex": shard_hex, "hash": "fnv1a32(parcel_id)",
                   "fields": DETAIL_FIELDS},
        "counts": report["counts"],
        "per_county": report["per_county"],
        "thresholds": report["thresholds"],
    }
    mf.write_text(json.dumps(manifest, separators=(",", ":"), default=list))
    log(f"  published -> {root}: flags {n_flags / 1e6:.1f} MB, detail {n_detail / 1e6:.1f} MB")


def after_build(parcels: Path, out: Path) -> None:
    run(parcels=parcels, out=out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--parcels", type=Path, default=PARCELS)
    ap.add_argument("--out", type=Path, default=WEB_DATA_DIR)
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--clear", action="store_true")
    args = ap.parse_args()
    if args.clear:
        clear_bundle(args.out)
        log(f"Removed the signals from {args.out}.")
        return 0
    if not args.parcels.exists():
        log(f"No joined parcel table at {args.parcels}: run the data build first.")
        return 1
    run(parcels=args.parcels, out=args.out, publish=not args.no_publish)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
