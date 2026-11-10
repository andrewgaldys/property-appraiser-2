#!/usr/bin/env python3
"""(Re)build parcels.pmtiles + points.pmtiles from the joined table (pipeline/out/parcels.parquet).

build_fdor.py already does this once; use this script to re-tile with different
settings (e.g. after installing tippecanoe) without re-reading the FDOR files.

    python pipeline/build_tiles.py                     # tippecanoe if installed, else pure Python
    python pipeline/build_tiles.py --tiler tippecanoe
    python pipeline/build_tiles.py --print-commands    # write NDJSON + print the tippecanoe commands only
"""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pa2.config import ATTRIBUTION_FDOR, OUT_DIR, POINT_ZOOMS, POLYGON_ZOOMS, WEB_DATA_DIR  # noqa: E402
from pa2.io import read_parquet  # noqa: E402
from pa2.publish import point_properties, tile_properties  # noqa: E402
from pa2.tiler import (  # noqa: E402
    build_pmtiles_python,
    python_tiler_available,
    run_tippecanoe,
    tippecanoe_path,
    write_ndjson,
)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--parquet", type=Path, default=OUT_DIR / "parcels.parquet")
    ap.add_argument("--out", type=Path, default=WEB_DATA_DIR)
    ap.add_argument("--work-dir", type=Path, default=OUT_DIR)
    ap.add_argument("--tiler", choices=["auto", "tippecanoe", "python"], default="auto")
    ap.add_argument("--print-commands", action="store_true", help="write NDJSON and print tippecanoe commands only")
    args = ap.parse_args()

    import shapely

    records = read_parquet(args.parquet)
    print(f"{len(records):,} parcels from {args.parquet}")
    poly = [(r["fid"], tile_properties(r), r["geometry"]) for r in records]
    pts = [(r["fid"], point_properties(r), shapely.Point(r["lon"], r["lat"])) for r in records]
    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    attribution = manifest.get("source", {}).get("attribution", ATTRIBUTION_FDOR)
    meta = dict(attribution=attribution, description="Martin, Palm Beach, St. Lucie parcels")

    jobs = [("polygon", poly, "parcels", POLYGON_ZOOMS), ("point", pts, "points", POINT_ZOOMS)]
    tiler = args.tiler
    if tiler == "auto":
        tiler = "tippecanoe" if tippecanoe_path() else "python"
    if args.print_commands or tiler == "tippecanoe":
        args.work_dir.mkdir(parents=True, exist_ok=True)
        for kind, feats, name, (zmin, zmax) in jobs:
            nd = args.work_dir / f"{name}.ndjson"
            write_ndjson(nd, feats)
            if args.print_commands:
                extra = ("--detect-shared-borders --simplification=2 --drop-smallest-as-needed "
                         "--no-tiny-polygon-reduction") if kind == "polygon" else "-r1 --drop-densest-as-needed"
                print(f"tippecanoe -o {shlex.quote(str(args.out / f'{name}.pmtiles'))} --force --layer {name} "
                      f"-Z{zmin} -z{zmax} --read-parallel {extra} {shlex.quote(str(nd))}")
            else:
                print(f"tippecanoe -> {name}.pmtiles")
                run_tippecanoe(nd, args.out / f"{name}.pmtiles", layer=name, kind=kind, minzoom=zmin, maxzoom=zmax,
                               name=f"PA2 {name}", **meta)
        if args.print_commands:
            return 0
    else:
        if not python_tiler_available():
            ap.error("pure-Python tiler needs shapely + pmtiles (pip install -r pipeline/requirements.txt)")
        for kind, feats, name, (zmin, zmax) in jobs:
            res = build_pmtiles_python(feats, args.out / f"{name}.pmtiles", layer=name, kind=kind, minzoom=zmin,
                                       maxzoom=zmax, name=f"PA2 {name}", **meta)
            print(f"python tiler -> {name}.pmtiles: {res['tiles']} tiles, {res['bytes'] / 1e6:.1f} MB")

    if manifest:
        manifest["tiles"]["format"] = "pmtiles"
        manifest["tiles"]["polygons"]["url"] = "parcels.pmtiles"
        manifest["tiles"]["points"]["url"] = "points.pmtiles"
        manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
