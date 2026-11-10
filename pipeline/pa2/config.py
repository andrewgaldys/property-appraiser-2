"""Shared configuration: counties, paths, field aliases and tiling parameters."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = PIPELINE_DIR.parent
WEB_DATA_DIR = REPO_DIR / "web" / "public" / "data"
RAW_DIR = PIPELINE_DIR / "raw"
OUT_DIR = PIPELINE_DIR / "out"

# hold_period_years = AS_OF_YEAR - last_sale_year. Override with PA2_AS_OF_YEAR or --as-of-year.
AS_OF_YEAR = int(os.environ.get("PA2_AS_OF_YEAR", "2026"))


@dataclass(frozen=True)
class County:
    code: int  # FDOR CO_NO
    name: str
    short: str
    fips: str
    bbox: tuple[float, float, float, float]  # approx. lon/lat extent (sanity checks only)


COUNTIES: dict[int, County] = {
    53: County(53, "Martin", "MAR", "12085", (-80.69, 26.95, -80.08, 27.27)),
    60: County(60, "Palm Beach", "PBC", "12099", (-80.89, 26.31, -80.03, 26.98)),
    66: County(66, "St. Lucie", "SLC", "12111", (-80.68, 27.20, -80.16, 27.56)),
}
COUNTY_CODES: tuple[int, ...] = tuple(sorted(COUNTIES))

# Standardized field name -> short vector-tile attribute. Tiles only carry what the
# map needs to filter, extrude, shade, highlight and show a hover tooltip; everything
# else is fetched from the sharded detail records when a parcel is clicked.
TILE_FIELDS: dict[str, str] = {
    "parcel_id": "pid",
    "county_code": "co",
    "asset_class": "cls",
    "use_code": "uc",
    "site_address": "addr",
    "owner_name": "own",
    "just_value": "jv",
    "assessed_value": "av",
    "land_value": "lv",
    "building_value": "bv",
    "land_to_value_ratio": "ltv",
    "bldg_to_land_ratio": "btl",
    "tot_lvg_area": "sf",
    "lnd_sqfoot": "lot",
    "no_res_unts": "u",
    "act_yr_blt": "yb",
    "last_sale_price": "sp",
    "last_sale_year": "sy",
    "hold_period_years": "hold",
    "hold_floor_years": "hf",
    "owner_name_key": "onk",
    "owner_addr_key": "oak",
}

# The centroid-dot layer covers whole counties per tile at low zoom, so it carries only what the
# map needs to filter, color, highlight and label; the tooltip fetches the rest on demand.
POINT_FIELDS: list[str] = [
    "parcel_id", "county_code", "asset_class", "use_code", "just_value", "tot_lvg_area", "lnd_sqfoot",
    "no_res_unts", "hold_period_years", "hold_floor_years", "land_to_value_ratio", "bldg_to_land_ratio",
    "owner_name_key", "owner_addr_key",
]

# Columns stored per parcel in parcels/<shard>.json (row arrays, in this order).
DETAIL_FIELDS: list[str] = [
    "parcel_id",
    "county_code",
    "site_address",
    "site_city",
    "site_zip",
    "use_code",
    "use_description",
    "use_category",
    "asset_class",
    "just_value",
    "assessed_value",
    "land_value",
    "building_value",
    "land_to_value_ratio",
    "bldg_to_land_ratio",
    "tot_lvg_area",
    "lnd_sqfoot",
    "lot_acres",
    "no_res_unts",
    "no_buldng",
    "act_yr_blt",
    "eff_yr_blt",
    "owner_name",
    "owner_addr1",
    "owner_addr2",
    "owner_city",
    "owner_state",
    "owner_zip",
    "owner_addr",
    "last_sale_price",
    "last_sale_year",
    "last_sale_month",
    "last_sale_qual_cd",
    "last_sale_qualified",
    "hold_period_years",
    "no_sale_since",
    "hold_floor_years",
    "owner_name_key",
    "owner_addr_key",
    "legal_desc",
    "tax_roll_year",
    "lon",
    "lat",
    "bbox",
]

# Compact per-parcel "card" embedded in owners/<shard>.json portfolio entries.
OWNER_ITEM_FIELDS: list[str] = [
    "parcel_id",
    "county_code",
    "asset_class",
    "site_address",
    "site_city",
    "just_value",
    "tot_lvg_area",
    "no_res_unts",
    "owner_name",
    "owner_name_key",
    "owner_addr_key",
    "lon",
    "lat",
]

# A portfolio list stores at most this many cards; the total count is always exact.
PORTFOLIO_MAX_ITEMS = 500
# A mailing address shared by this many distinct owner names is flagged as a likely
# agent / manager / registered-agent address rather than one beneficial owner.
AGENT_ADDRESS_NAME_THRESHOLD = 25

# Zoom ranges. Polygons start at z12; below that the map draws the centroid layer.
POLYGON_ZOOMS = (12, 15)
POINT_ZOOMS = (8, 12)
# Parcel "rims": a narrow band just inside each boundary, shipped only in the max-zoom polygon tiles
# (flagged `e: 1`). The frontend extrudes it a hair above the 3D block so every roof gets an
# outline: MapLibre cannot raise line layers to roof height. ~1.9 px at z16.
RIM_WIDTH_M = 2.0
RIM_ZOOM = POLYGON_ZOOMS[1]

ATTRIBUTION_FDOR = "Florida Department of Revenue, Property Tax Oversight (NAL/SDF)"
ATTRIBUTION_SAMPLE = "Synthetic sample data (not real parcels)"
