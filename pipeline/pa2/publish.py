"""Write the static data bundle consumed by the GitHub Pages frontend.

    <out_dir>/manifest.json
    <out_dir>/parcels.pmtiles      (or parcels.geojson only, when no tiler is available)
    <out_dir>/points.pmtiles
    <out_dir>/parcels/<shard>.json {"fields": [...], "rows": {parcel_id: [...]}}
    <out_dir>/owners/<shard>.json  {"n": {name_key: entry}, "a": {addr_key: entry}}

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

_ARTIFACT_FILES = ("manifest.json", "parcels.pmtiles", "points.pmtiles", "parcels.geojson")
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
        "owners": {"url": "owners/{shard}.json", "shard_hex": shard_hex, "hash": "key % 16^shard_hex",
                   "item_fields": OWNER_ITEM_FIELDS, "max_items": PORTFOLIO_MAX_ITEMS},
    }
