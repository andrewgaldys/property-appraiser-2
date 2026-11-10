#!/usr/bin/env python3
"""Optional: load the joined parcel table into PostGIS / Supabase.

The static site does not need a database. This is the hook for server-side
queries later (search, comps, bulk exports, an API):

    pip install -r pipeline/requirements-postgis.txt
    export PA2_DATABASE_URL='postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres'
    python pipeline/sync_postgis.py                 # replaces table pa2_parcels

Creates pa2_parcels (+ indexes), view pa2_owner_portfolios and function
pa2_portfolio(parcel_id) from sql/postgis_post_load.sql.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pa2.config import OUT_DIR, PIPELINE_DIR  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--parquet", type=Path, default=OUT_DIR / "parcels.parquet")
    ap.add_argument("--dsn", default=os.environ.get("PA2_DATABASE_URL"), help="Postgres URL (or PA2_DATABASE_URL)")
    ap.add_argument("--table", default="pa2_parcels")
    args = ap.parse_args()
    if not args.dsn:
        ap.error("set PA2_DATABASE_URL or pass --dsn")

    import geopandas as gpd
    from sqlalchemy import create_engine, text

    gdf = gpd.read_parquet(args.parquet)
    engine = create_engine(args.dsn)
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
    gdf.to_postgis(args.table, engine, if_exists="replace", index=False, chunksize=20_000)
    sql = (PIPELINE_DIR / "sql" / "postgis_post_load.sql").read_text().replace("pa2_parcels", args.table)
    with engine.begin() as conn:
        conn.exec_driver_sql(sql)
    print(f"loaded {len(gdf):,} parcels into {args.table}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
