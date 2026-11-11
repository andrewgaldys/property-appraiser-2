"""Write the static data bundle consumed by the GitHub Pages frontend.

    <out_dir>/manifest.json
    <out_dir>/parcels.pmtiles      (or parcels.geojson only, when no tiler is available)
    <out_dir>/points.pmtiles
    <out_dir>/parcels/<shard>.json {"fields": [...], "rows": {parcel_id: [...]}}
    <out_dir>/owners/<shard>.json  {"n": {name_key: entry}, "a": {addr_key: entry}}
    <out_dir>/index.json           every parcel in one compact table: search, results tables, CSV export
                                   (loaded on first use)

Shards keep every request small (GitHub Pages / any static host), so the frontend
never downloads more than one shard per click, whatever the dataset size.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import shutil
import statistics
from collections import defaultdict
from pathlib import Path

from . import __version__
from .config import (
    AS_OF_YEAR,
    COUNTIES,
    DETAIL_FIELDS,
    SMALL_PORTFOLIO,
    NOMINAL_VALUE_MAX,
    OUT_DIR,
    OWNER_ITEM_FIELDS,
    POINT_FIELDS,
    POINT_ZOOMS,
    POLYGON_ZOOMS,
    PORTFOLIO_MAX_ITEMS,
    RIM_WIDTH_M,
    RIM_ZOOM,
    TILE_FIELDS,
)
from .dor_codes import ASSET_CLASSES, PRIMARY_CLASSES, describe
from .entity import assign_owner_keys, build_owner_index
from .schema import finalize_record
from .tiler import (
    build_pmtiles_python,
    geojson_geometry,
    python_tiler_available,
    run_tippecanoe,
    tippecanoe_path,
    write_ndjson,
)
from .util import key_shard, pid_shard

_ARTIFACT_FILES = ("manifest.json", "parcels.pmtiles", "points.pmtiles", "parcels.geojson", "search.json", "index.json")
# index.json columns. city / mcity are positions in the "cities" / "mailing_cities" lists.
INDEX_FIELDS = [
    "pid", "co", "cls", "uc", "addr", "city", "zip", "own", "jv", "sf", "lot", "u", "yb", "btl",
    "sp", "sy", "sm", "hold", "hf", "sfrom", "onk", "oak", "ma1", "ma2", "mcity", "mst", "mzip", "lon", "lat",
    "oa", "spf", "et",
]
_ARTIFACT_DIRS = ("parcels", "owners")


def _dump(path: Path, obj) -> int:
    data = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    path.write_text(data, encoding="utf-8")
    return len(data.encode("utf-8"))


def _quantiles(values: list[float], qs=(0.05, 0.25, 0.5, 0.75, 0.95)) -> list[float]:
    vals = sorted(v for v in values if v is not None)
    if len(vals) < 2:
        return [vals[0] if vals else 0.0] * len(qs)
    cuts = statistics.quantiles(vals, n=100, method="inclusive")
    return [round(cuts[int(q * 100) - 1], 4) for q in qs]


_HOUSE_NUMBER = re.compile(r"^(\d+[A-Z]?)\b")


def tile_properties(r: dict) -> dict:
    return {alias: r[field] for field, alias in TILE_FIELDS.items() if r.get(field) is not None}


def point_properties(r: dict) -> dict:
    """Slim centroid attributes + `hn` (house number) for the z15+ map labels."""
    props = {TILE_FIELDS[f]: r[f] for f in POINT_FIELDS if r.get(f) is not None}
    m = _HOUSE_NUMBER.match(r.get("site_address") or "")
    if m:
        props["hn"] = m.group(1)
    return props


def edge_bands(geoms: list, width_m: float) -> list:
    """The band within `width_m` of each polygon's boundary (whole polygon if it is thinner than that).

    Buffered in a local metric frame (equirectangular at the data's mean latitude: under 1% scale
    error across the three counties), then mapped back to degrees.
    """
    import math

    import numpy as np
    import shapely

    if not geoms:
        return []
    lat0 = float(np.mean([g.centroid.y for g in geoms]))
    k = np.array([111_320.0 * math.cos(math.radians(lat0)), 110_574.0])
    metric = shapely.transform(np.asarray(geoms, dtype=object), lambda c: c * k)
    inner = shapely.buffer(metric, -width_m, join_style="mitre", mitre_limit=2.0)
    bands = shapely.transform(shapely.difference(metric, inner), lambda c: c / k)
    out = []
    for b in bands:
        if b is not None and not b.is_empty and not b.is_valid:
            b = shapely.make_valid(b)
            if b.geom_type not in ("Polygon", "MultiPolygon"):
                parts = [p for p in getattr(b, "geoms", []) if p.geom_type in ("Polygon", "MultiPolygon")]
                b = shapely.union_all(parts) if parts else None
        out.append(None if b is None or b.is_empty else b)
    return out


def polygon_features(records: list[dict]) -> list[tuple]:
    """Tile features for the parcel polygons, plus their roof rims (`e: 1`, max-zoom tiles only).

    Rims share the parcel's feature id, so hover / selection feature-state lights both at once.
    """
    feats = [(r["fid"], tile_properties(r), r["geometry"]) for r in records]
    rims = edge_bands([r["geometry"] for r in records], RIM_WIDTH_M)
    return feats + [(r["fid"], {**props, "e": 1}, band, RIM_ZOOM)
                    for r, (_, props, _), band in zip(records, feats, rims) if band is not None]


def parcel_index(records: list[dict], addrs_idx: dict[int, dict]) -> dict:
    """Every parcel as one compact row (INDEX_FIELDS), plus the shared mailing addresses.

    The frontend loads it on first use of search or the results tables: it filters, groups owners,
    sorts and exports CSV client-side, so a screen covers all three counties, not just the map view.
    Cities are stored once and referenced by position; coordinates are rounded to ~1 m.
    Missing values stay null (never 0), so the frontend can tell "not reported" from zero.
    """
    cities = sorted({r["site_city"] for r in records if r["site_city"]})
    city_ix = {c: i for i, c in enumerate(cities)}
    mcities = sorted({r["owner_city"] for r in records if r["owner_city"]})
    mcity_ix = {c: i for i, c in enumerate(mcities)}
    rows = [
        [r["parcel_id"], r["county_code"], r["asset_class"], r["use_code"] or "", r["site_address"] or "",
         city_ix.get(r["site_city"], -1), r["site_zip"] or "", r["owner_name"] or "", r["just_value"],
         r["tot_lvg_area"], r["lnd_sqfoot"], r["residential_units"], r["act_yr_blt"], r["bldg_to_land_ratio"],
         r["last_sale_price"], r["last_sale_year"], r["last_sale_month"], r["hold_period_years"],
         r["hold_floor_years"], r["sales_from"], r["owner_name_key"], r["owner_addr_key"],
         r["owner_addr1"] or "", r["owner_addr2"] or "", mcity_ix.get(r["owner_city"], -1), r["owner_state"] or "",
         r["owner_zip"] or "", round(r["lon"], 5), round(r["lat"], 5),
         r["out_of_area"], r["small_portfolio"], r["estate_trust"]]
        for r in records
    ]
    mailing = [[k, e["label"], e.get("names", 0), 1 if e.get("agent") else 0] for k, e in sorted(addrs_idx.items())]
    return {
        "fields": INDEX_FIELDS,
        "cities": cities,
        "mailing_cities": mcities,
        "rows": rows,
        "mailing": {"fields": ["key", "label", "names", "agent"], "rows": mailing},
    }


_TRUST = re.compile(r"\b(TRUSTS?|TRUSTEES?|TTEES?|TRS?|REVOCABLE|IRREVOCABLE|ESTATE|EST OF|HEIRS)\b")
# Business trusts and companies that only contain the words: REITs, banks, real-estate firms.
_NOT_ESTATE = re.compile(r"\b(REAL ESTATE|REALTY TRUST|INVESTMENT TRUST|REIT|BANK(ING)? (&|AND) TRUST|TRUST BANK|TRUST CO(MPANY)?)\b")
_CORP = re.compile(r"\b(LLC|L L C|INC|CORP|CORPORATION|CO|COMPANY|LP|LLP|LLLP|LTD|PA|PLLC|PARTNERSHIP|ASSOCIATION|ASSN)\b")
_TRUSTEE = re.compile(r"\b(TRUSTEES?|TTEES?)\b")


def estate_trust(name: str | None) -> bool:
    """Owner names that read as a trust or an estate: SMITH JOHN TR, ESTATE OF ..., ACME LAND TRUST.

    Names whose only trust words are a business trust (REALTY TRUST, BANK & TRUST, REAL ESTATE) do not
    count, nor companies (LLC, INC, LP ...) unless a trustee is named. Land trusts are included.
    """
    s = (name or "").upper()
    if not _TRUST.search(s) or not _TRUST.search(_NOT_ESTATE.sub(" ", s)):
        return False
    return not (_CORP.search(s) and not _TRUSTEE.search(s))


def prospect_flags(records: list[dict]) -> dict:
    """Per-parcel flags behind the prospecting presets; returns counts for the log and manifest.

    out_of_area: 2 when the owner's mailing state is not Florida; 1 when it is Florida but outside the
    parcel's county. Mailing ZIPs (else cities) are placed in a county by where this dataset's own
    parcels with that site ZIP (city) are; a Florida ZIP or city with no parcels here is outside all
    three counties. Approximate where a ZIP straddles a county line.
    """
    zips: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    cities: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for r in records:
        if r["site_zip"]:
            zips[r["site_zip"]][r["county_code"]] += 1
        if r["site_city"]:
            cities[r["site_city"].upper()][r["county_code"]] += 1
    zip_county = {z: max(c, key=c.get) for z, c in zips.items()}
    city_county = {k: max(c, key=c.get) for k, c in cities.items()}
    groups: dict[int, list[dict]] = defaultdict(list)
    for r in records:
        if r["owner_name_key"] is not None:
            groups[r["owner_name_key"]].append(r)
    small = {k for k, g in groups.items() if SMALL_PORTFOLIO[0] <= len(g) <= SMALL_PORTFOLIO[1] and len({x["asset_class"] for x in g}) == 1}
    counts = {"out_of_state": 0, "out_of_county": 0, "small_portfolio": 0, "estate_trust": 0}
    for r in records:
        st = r.get("owner_state") or ""
        oa = None
        if st and st != "FL":
            oa = 2
        elif st == "FL":
            mzip, mcity = (r.get("owner_zip") or "")[:5], (r.get("owner_city") or "").upper()
            if mzip or mcity:  # no ZIP and no city: unknown, never "another county"
                home = zip_county.get(mzip) or city_county.get(mcity)
                oa = 1 if home != r["county_code"] else None
        r["out_of_area"] = oa
        r["small_portfolio"] = 1 if r["owner_name_key"] in small else None
        r["estate_trust"] = 1 if estate_trust(r.get("owner_name")) else None
        counts["out_of_state"] += oa == 2
        counts["out_of_county"] += oa == 1
        counts["small_portfolio"] += r["small_portfolio"] is not None
        counts["estate_trust"] += r["estate_trust"] is not None
    return counts


def clean_out_dir(out_dir: Path) -> None:
    """Remove only artifacts this module writes (never the whole directory)."""
    for name in _ARTIFACT_FILES:
        (out_dir / name).unlink(missing_ok=True)
    for name in _ARTIFACT_DIRS:
        if (out_dir / name).is_dir():
            shutil.rmtree(out_dir / name)


def publish(
    records: list[dict],
    out_dir: Path,
    *,
    source_kind: str,
    source_label: str,
    attribution: str,
    tax_roll_year: int | None = None,
    as_of_year: int = AS_OF_YEAR,
    shard_hex: int = 1,
    tiler: str = "auto",
    write_geojson: bool = False,
    work_dir: Path = OUT_DIR,
    log=print,
    nominal_value_max: int = NOMINAL_VALUE_MAX,
    sales_coverage: dict | None = None,
    min_sale_price: int = 100,
) -> dict:
    """records: dicts with the standardized base fields + shapely `geometry` (EPSG:4326).

    sales_coverage: per county code (str) {"from": year records are complete from, "depth": "all" |
    "recent5" | "latest" | "window", "source": text}, shown by the frontend next to hold periods.
    """
    import shapely

    if not records:
        raise ValueError("no parcel records to publish")
    out_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)

    # 1. Derived fields, label points, stable feature ids.
    for r in records:
        finalize_record(r, as_of_year, nominal_value_max)
        g = r["geometry"]
        p = shapely.point_on_surface(g)
        r["lon"], r["lat"] = round(p.x, 6), round(p.y, 6)
        b = g.bounds
        r["bbox"] = [round(b[0], 6), round(b[1], 6), round(b[2], 6), round(b[3], 6)]
    records.sort(key=lambda r: (r["county_code"], r["parcel_id"]))
    for i, r in enumerate(records, start=1):
        r["fid"] = i

    # 2. Owner entity resolution -> integer keys + portfolio index.
    name_groups, addr_groups, addr_meta = assign_owner_keys(records)
    names_idx, addrs_idx = build_owner_index(name_groups, addr_groups, addr_meta, OWNER_ITEM_FIELDS)
    log(f"  owners: {len(names_idx):,} multi-parcel names, {len(addrs_idx):,} shared mailing addresses")
    flags = prospect_flags(records)
    log("  prospecting flags: " + ", ".join(f"{k} {v:,}" for k, v in flags.items()))

    clean_out_dir(out_dir)

    # 3. Parcel detail shards.
    detail: dict[str, dict] = defaultdict(dict)
    for r in records:
        detail[pid_shard(r["parcel_id"], shard_hex)][r["parcel_id"]] = [r.get(f) for f in DETAIL_FIELDS]
    (out_dir / "parcels").mkdir()
    detail_bytes = sum(
        _dump(out_dir / "parcels" / f"{s}.json", {"fields": DETAIL_FIELDS, "rows": rows}) for s, rows in detail.items()
    )

    # 4. Owner portfolio shards.
    owners: dict[str, dict] = defaultdict(lambda: {"n": {}, "a": {}})
    for k, e in names_idx.items():
        owners[key_shard(k, shard_hex)]["n"][str(k)] = e
    for k, e in addrs_idx.items():
        owners[key_shard(k, shard_hex)]["a"][str(k)] = e
    (out_dir / "owners").mkdir()
    owner_bytes = sum(_dump(out_dir / "owners" / f"{s}.json", obj) for s, obj in owners.items())
    log(f"  shards: {len(detail)} parcel ({detail_bytes / 1e6:.1f} MB), {len(owners)} owner ({owner_bytes / 1e6:.1f} MB)")
    index_bytes = _dump(out_dir / "index.json", parcel_index(records, addrs_idx))
    log(f"  index.json: {index_bytes / 1e6:.1f} MB")

    # 5. Vector tiles.
    poly_feats = polygon_features(records)
    point_feats = [(r["fid"], point_properties(r), shapely.Point(r["lon"], r["lat"])) for r in records]
    if tiler == "auto":
        tiler = "tippecanoe" if tippecanoe_path() else ("python" if python_tiler_available() else "none")
    meta = dict(attribution=attribution, description=f"{source_label} - Martin, Palm Beach, St. Lucie parcels")
    if tiler == "tippecanoe":
        for kind, feats, fname, layer, zooms in (
            ("polygon", poly_feats, "parcels", "parcels", POLYGON_ZOOMS),
            ("point", point_feats, "points", "points", POINT_ZOOMS),
        ):
            nd = work_dir / f"{fname}.ndjson"
            write_ndjson(nd, feats)
            log(f"  tippecanoe -> {fname}.pmtiles")
            run_tippecanoe(nd, out_dir / f"{fname}.pmtiles", layer=layer, kind=kind, minzoom=zooms[0],
                           maxzoom=zooms[1], name=f"PA2 {layer}", **meta)
    elif tiler == "python":
        for kind, feats, fname, layer, zooms in (
            ("polygon", poly_feats, "parcels", "parcels", POLYGON_ZOOMS),
            ("point", point_feats, "points", "points", POINT_ZOOMS),
        ):
            res = build_pmtiles_python(feats, out_dir / f"{fname}.pmtiles", layer=layer, kind=kind,
                                       minzoom=zooms[0], maxzoom=zooms[1], name=f"PA2 {layer}", **meta)
            log(f"  python tiler -> {fname}.pmtiles: {res['tiles']} tiles, {res['bytes'] / 1e6:.2f} MB")
    elif tiler == "none":
        write_geojson = True
        log("  no tiler available: frontend will load parcels.geojson directly (fine for small datasets)")
    else:
        raise ValueError(f"unknown tiler {tiler!r}")

    if write_geojson:
        fc = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": r["fid"],
                    "properties": {"fid": r["fid"], **{f: r.get(f) for f in DETAIL_FIELDS if f != "bbox"}},
                    "geometry": geojson_geometry(r["geometry"]),
                }
                for r in records
            ],
        }
        size = _dump(out_dir / "parcels.geojson", fc)
        log(f"  parcels.geojson: {size / 1e6:.2f} MB")

    # 6. Manifest.
    manifest = build_manifest(records, names_idx, addrs_idx, source_kind=source_kind, source_label=source_label,
                              attribution=attribution, tax_roll_year=tax_roll_year, as_of_year=as_of_year,
                              shard_hex=shard_hex, tiler=tiler, nominal_value_max=nominal_value_max,
                              sales_coverage=sales_coverage, min_sale_price=min_sale_price)
    _dump(out_dir / "manifest.json", manifest)
    return manifest


def build_manifest(records, names_idx, addrs_idx, *, source_kind, source_label, attribution, tax_roll_year,
                   as_of_year, shard_hex, tiler, nominal_value_max=NOMINAL_VALUE_MAX, sales_coverage=None,
                   min_sale_price=100) -> dict:
    import shapely

    bounds = [round(v, 5) for v in shapely.total_bounds([r["geometry"] for r in records])]

    counties = []
    for code, c in COUNTIES.items():
        rs = [r for r in records if r["county_code"] == code]
        if not rs:
            continue
        cb = shapely.total_bounds([r["geometry"] for r in rs])
        counties.append({
            "code": code, "name": c.name, "short": c.short, "count": len(rs),
            "jv": sum(r["just_value"] or 0 for r in rs),
            "bbox": [round(v, 5) for v in cb],
        })

    class_counts: dict[str, int] = defaultdict(int)
    for r in records:
        class_counts[r["asset_class"]] += 1
    asset_classes = [
        {"code": code, "label": label, "category": cat, "count": class_counts.get(code, 0),
         "primary": code in PRIMARY_CLASSES}
        for code, (label, cat) in ASSET_CLASSES.items()
        if code in PRIMARY_CLASSES or class_counts.get(code)
    ]

    use_codes = {uc: describe(uc) for uc in sorted({r["use_code"] for r in records if r["use_code"]})}

    cities: dict[tuple[int, str], list[dict]] = defaultdict(list)
    for r in records:
        if r["site_city"]:
            cities[(r["county_code"], r["site_city"].title())].append(r)
    top_cities = sorted(cities.items(), key=lambda kv: -len(kv[1]))[:10]
    city_list = []
    for (code, name), rs in top_cities:
        # 2nd-98th percentile box: one mis-coded parcel must not zoom the "jump to" view out to a county.
        xs = sorted(r["lon"] for r in rs)
        ys = sorted(r["lat"] for r in rs)
        lo, hi = int(len(rs) * 0.02), max(int(len(rs) * 0.98) - 1, 0)
        city_list.append({"name": name, "county": code, "count": len(rs),
                          "bbox": [xs[lo], ys[lo], xs[hi], ys[hi]]})

    # Value ramps and stats skip nominal-value parcels ($100 common areas would anchor the low end).
    valued = [r for r in records if not r.get("nominal_value")]

    def metric(field, rows=records):
        return _quantiles([r.get(field) for r in rows])

    tile_kind = "geojson" if tiler == "none" else "pmtiles"
    return {
        "schema": "pa2.data.v1",
        "pipeline_version": __version__,
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "source": {
            "kind": source_kind,
            "label": source_label,
            "attribution": attribution,
            "tax_roll_year": tax_roll_year,
            "as_of_year": as_of_year,
        },
        "bounds": bounds,
        "counties": counties,
        "cities": city_list,
        "asset_classes": asset_classes,
        "use_codes": use_codes,
        "stats": {
            "parcels": len(records),
            "just_value": sum(r["just_value"] or 0 for r in records),
            "units": sum(r["residential_units"] or 0 for r in records),
            "nominal_parcels": len(records) - len(valued),
            "building_sf": sum(r["tot_lvg_area"] or 0 for r in records),
            "owner_name_groups": len(names_idx),
            "owner_addr_groups": len(addrs_idx),
        },
        "quantiles": {
            "q": [0.05, 0.25, 0.5, 0.75, 0.95],
            "just_value": metric("just_value", valued),
            "tot_lvg_area": metric("tot_lvg_area"),
            "hold_period_years": metric("hold_period_years"),
            "land_to_value_ratio": metric("land_to_value_ratio", valued),
            "lot_acres": metric("lot_acres"),
        },
        "data_quality": {
            "nominal_value_max": nominal_value_max,
            "nominal_parcels": len(records) - len(valued),
            "min_sale_price": min_sale_price,
        },
        "sales_coverage": sales_coverage or {},
        "tiles": {
            "format": tile_kind,
            "polygons": {"url": "parcels.pmtiles" if tile_kind == "pmtiles" else "parcels.geojson",
                         "layer": "parcels", "minzoom": POLYGON_ZOOMS[0], "maxzoom": POLYGON_ZOOMS[1],
                         **({"rim_minzoom": RIM_ZOOM} if tile_kind == "pmtiles" else {})},
            "points": {"url": "points.pmtiles" if tile_kind == "pmtiles" else "parcels.geojson",
                       "layer": "points", "minzoom": POINT_ZOOMS[0], "maxzoom": POINT_ZOOMS[1]},
            "fields": TILE_FIELDS,
        },
        "details": {"url": "parcels/{shard}.json", "shard_hex": shard_hex, "hash": "fnv1a32(parcel_id)"},
        "index": {"url": "index.json", "fields": INDEX_FIELDS},
        "owners": {"url": "owners/{shard}.json", "shard_hex": shard_hex, "hash": "key % 16^shard_hex",
                   "item_fields": OWNER_ITEM_FIELDS, "max_items": PORTFOLIO_MAX_ITEMS,
                   # Mailing-address keys shared by so many owner names they look like a registered
                   # agent or manager: owner rankings group those parcels by owner name instead.
                   "agent_addr_keys": sorted(k for k, e in addrs_idx.items() if e.get("agent"))},
    }
