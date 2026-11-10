#!/usr/bin/env python3
"""Build the production data bundle from FDOR tax-roll files + parcel polygons.

Inputs (see README "Production data"):
  NAL  Name-Address-Legal CSVs     NAL53*.csv, NAL60*.csv, NAL66*.csv
  SDF  Sales Data File CSVs        SDF53*.csv, ... (optional, improves last-sale accuracy)
  GIS  parcel polygons             shapefile / zipped shapefile / GeoPackage / FileGDB / GeoJSON,
                                   per county or one statewide file (filtered to CO_NO 53/60/66)

    python pipeline/build_fdor.py                                    # auto-discover in pipeline/raw/
    python pipeline/build_fdor.py --raw-dir ~/Downloads/fdor
    python pipeline/build_fdor.py --nal raw/NAL*.csv --sdf raw/SDF*.csv --parcels raw/gis/*.zip
    python pipeline/build_fdor.py --classes MF10,MF2_9,COM,IND,VAC_COM  # investment subset (much smaller)

Outputs web/public/data/{manifest.json, parcels.pmtiles, points.pmtiles, parcels/, owners/}
and pipeline/out/parcels.parquet (joined table for build_tiles.py / sync_postgis.py).
"""

from __future__ import annotations

import argparse
import glob
import logging
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pa2 import fdor  # noqa: E402
from pa2.config import AS_OF_YEAR, ATTRIBUTION_FDOR, COUNTY_CODES, OUT_DIR, RAW_DIR, WEB_DATA_DIR  # noqa: E402
from pa2.dor_codes import ASSET_CLASSES, classify, normalize_use_code  # noqa: E402
from pa2.io import write_parquet  # noqa: E402
from pa2.publish import publish  # noqa: E402

GIS_SUFFIXES = {".shp", ".gpkg", ".geojson", ".fgb", ".zip"}
TABLE_SUFFIXES = {".csv", ".txt", ".zip"}
_ROLL_KIND = re.compile(r"(?:^|[^A-Z])(NAL|SDF|NAP)(?:[^A-Z]|$)")
_COUNTY_CODE = re.compile(r"(?<!\d)(\d{2})(?!\d)")
log = logging.getLogger("pa2")


def roll_kind(name: str) -> str | None:
    """'Martin 53 Final NAL 2026.zip' or 'NAL53F202601.csv' -> 'NAL'; parcel GIS files -> None."""
    m = _ROLL_KIND.search(name.upper())
    return m.group(1) if m else None


def county_codes(name: str) -> set[int]:
    """FDOR county codes (11-77) appearing in a file name, e.g. 'Palm Beach 60 Final SDF 2026.zip' -> {60}."""
    return {int(c) for c in _COUNTY_CODE.findall(name) if 11 <= int(c) <= 77}


def expand(patterns: list[str] | None) -> list[Path]:
    out: list[Path] = []
    for pat in patterns or []:
        hits = glob.glob(str(Path(pat).expanduser()))
        out += [Path(h) for h in sorted(hits)] if hits else [Path(pat).expanduser()]
    return out


def discover(raw_dir: Path, counties: list[int]) -> tuple[list[Path], list[Path], list[Path]]:
    """Find NAL / SDF tables (CSV, or the zips FDOR ships) and parcel polygon files under raw_dir."""
    wanted = set(counties)
    files = sorted(
        p for p in raw_dir.rglob("*")
        if p.is_file() and not any(part.lower().endswith(".gdb") for part in p.parts)
    )

    def tables(kind: str) -> list[Path]:
        found = [
            p for p in files
            if p.suffix.lower() in TABLE_SUFFIXES and roll_kind(p.name) == kind
            and (not county_codes(p.name) or county_codes(p.name) & wanted)
        ]
        # A zip is skipped when its CSV was already extracted for the same county.
        extracted = set().union(*(county_codes(p.name) for p in found if p.suffix.lower() != ".zip")) if found else set()
        return [p for p in found if p.suffix.lower() != ".zip" or not (county_codes(p.name) & extracted)]

    gis = [p for p in files if p.suffix.lower() in GIS_SUFFIXES and roll_kind(p.name) is None]
    gis += sorted(d for d in raw_dir.rglob("*.gdb") if d.is_dir())
    # If anything was unzipped, use the unzipped copies only (avoids reading parcels twice).
    unzipped = [p for p in gis if p.suffix.lower() != ".zip"]
    return tables("NAL"), tables("SDF"), (unzipped or gis)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw-dir", type=Path, default=RAW_DIR, help="where NAL/SDF/GIS files live (default pipeline/raw)")
    ap.add_argument("--nal", nargs="*", help="NAL CSV paths/globs (overrides discovery)")
    ap.add_argument("--sdf", nargs="*", help="SDF CSV paths/globs (overrides discovery)")
    ap.add_argument("--parcels", nargs="*", help="parcel polygon files/globs (overrides discovery)")
    ap.add_argument("--counties", default=",".join(map(str, COUNTY_CODES)), help="FDOR county codes (default 53,60,66)")
    ap.add_argument("--classes", default="", help="keep only these asset classes, e.g. MF10,MF2_9,COM,IND,VAC_COM")
    ap.add_argument("--out", type=Path, default=WEB_DATA_DIR, help="web data directory (default web/public/data)")
    ap.add_argument("--work-dir", type=Path, default=OUT_DIR, help="intermediate files (default pipeline/out)")
    ap.add_argument("--as-of-year", type=int, default=AS_OF_YEAR, help="hold period = this year - last sale year")
    ap.add_argument("--min-sale-price", type=int, default=100, help="ignore nominal transfers below this price")
    ap.add_argument("--shard-hex", type=int, default=3, help="hex chars per shard: 3 -> 4,096 shard files")
    ap.add_argument("--tiler", choices=["auto", "tippecanoe", "python", "none"], default="auto")
    ap.add_argument("--geojson", action="store_true", help="also write parcels.geojson (large!)")
    ap.add_argument("--geom-id-field", default=None, help="parcel id column in the GIS file (auto-detected)")
    ap.add_argument("--geom-layer", default=None, help="layer name for GeoPackage / FileGDB inputs")
    ap.add_argument("--assume-crs", default=None, help="CRS for GIS files without one, e.g. EPSG:2236")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")

    counties = [int(c) for c in args.counties.split(",") if c.strip()]
    nal_p, sdf_p, gis_p = discover(args.raw_dir, counties) if args.raw_dir.exists() else ([], [], [])
    nal_p = expand(args.nal) or nal_p
    sdf_p = expand(args.sdf) or sdf_p
    gis_p = expand(args.parcels) or gis_p
    if not nal_p or not gis_p:
        ap.error(f"need NAL CSVs and parcel polygons (found {len(nal_p)} NAL, {len(gis_p)} GIS in {args.raw_dir}); "
                 "see README 'Production data'")
    log.info("NAL: %s", ", ".join(p.name for p in nal_p))
    log.info("SDF: %s", ", ".join(p.name for p in sdf_p) or "(none)")
    log.info("GIS: %s", ", ".join(p.name for p in gis_p))

    t0 = time.time()
    nal = fdor.read_nal(nal_p, counties)
    if args.classes:
        keep = {c.strip().upper() for c in args.classes.split(",") if c.strip()}
        unknown = keep - set(ASSET_CLASSES)
        if unknown:
            ap.error(f"unknown classes {sorted(unknown)}; choose from {list(ASSET_CLASSES)}")
        nal = nal[nal["DOR_UC"].map(lambda u: classify(normalize_use_code(u)) in keep)]
        log.info("class filter %s: %s NAL rows remain", sorted(keep), f"{len(nal):,}")
    sdf = fdor.read_sdf(sdf_p, counties)
    sales = fdor.latest_sales(nal, sdf, args.min_sale_price)
    geoms = fdor.read_parcel_polygons(gis_p, counties, id_field=args.geom_id_field, layer=args.geom_layer,
                                      assume_crs=args.assume_crs)
    merged = fdor.join(nal, geoms, sales)
    if merged.empty:
        log.error("no NAL rows matched a polygon: check --geom-id-field (parcel ids must match after "
                  "removing dashes/spaces)")
        return 1
    records = fdor.to_records(merged)
    log.info("joined %s parcels in %.0fs", f"{len(records):,}", time.time() - t0)

    roll_years = sorted({r["tax_roll_year"] for r in records if r.get("tax_roll_year")})
    roll = roll_years[-1] if roll_years else None
    manifest = publish(
        records,
        args.out,
        source_kind="fdor",
        source_label=f"FDOR {roll or ''} tax roll (NAL/SDF)".replace("  ", " "),
        attribution=ATTRIBUTION_FDOR,
        tax_roll_year=roll,
        as_of_year=args.as_of_year,
        shard_hex=args.shard_hex,
        tiler=args.tiler,
        write_geojson=args.geojson,
        work_dir=args.work_dir,
        log=log.info,
    )
    write_parquet(records, args.work_dir / "parcels.parquet")
    s = manifest["stats"]
    log.info("published %s parcels / $%.2fB just value -> %s (%s tiles) in %.0fs",
             f"{s['parcels']:,}", s["just_value"] / 1e9, args.out, manifest["tiles"]["format"], time.time() - t0)
    log.info("joined table -> %s", args.work_dir / "parcels.parquet")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
