"""GeoParquet persistence of the published parcel table (feeds build_tiles.py and sync_postgis.py)."""

from __future__ import annotations

import json
from pathlib import Path

from .config import DETAIL_FIELDS

PARQUET_COLUMNS = ["fid", *DETAIL_FIELDS]


def write_parquet(records: list[dict], path: Path) -> None:
    import geopandas as gpd

    path.parent.mkdir(parents=True, exist_ok=True)
    data = {c: [r.get(c) for r in records] for c in PARQUET_COLUMNS}
    data["bbox"] = [json.dumps(b) for b in data["bbox"]]  # keep as text; trivially castable to jsonb
    gdf = gpd.GeoDataFrame(data, geometry=[r["geometry"] for r in records], crs=4326)
    gdf.to_parquet(path, index=False)


def read_parquet(path: Path) -> list[dict]:
    import geopandas as gpd
    import pandas as pd

    gdf = gpd.read_parquet(path)
    records = []
    cols = [c for c in gdf.columns if c != "geometry"]
    for row, geom in zip(gdf[cols].itertuples(index=False, name=None), gdf.geometry.values):
        r = {}
        for c, v in zip(cols, row):
            if v is None or (not isinstance(v, (str, list)) and pd.isna(v)):
                r[c] = None
            elif hasattr(v, "item"):
                r[c] = v.item()  # numpy scalar -> python
            else:
                r[c] = v
        r["bbox"] = json.loads(r["bbox"]) if isinstance(r.get("bbox"), str) else r.get("bbox")
        r["geometry"] = geom
        records.append(r)
    return records
