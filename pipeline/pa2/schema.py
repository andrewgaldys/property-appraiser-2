"""Standardized parcel schema + derived-field computation.

Every producer (sample generator, FDOR pipeline) emits plain dicts with the BASE
fields below plus a shapely `geometry` (EPSG:4326). `finalize_record` derives the
analytic fields so the math lives in exactly one place.
"""

from __future__ import annotations

from .config import AS_OF_YEAR, COUNTIES, NOMINAL_VALUE_MAX
from .dor_codes import ASSET_CLASSES, classify, describe, normalize_use_code
from .entity import format_mailing_address, residential_use
from .util import clean_str, round_or_none, to_int, us_state_code, zip5

# Placeholder site addresses the property appraisers use for parcels without one.
_NO_ADDRESS = {"UNASSIGNED", "NO SITE ADDRESS", "NONE", "0", "N/A"}
MIN_BUILDING_SQFT = 10  # smaller building areas are roll placeholders, treated as not reported

# (name, SQL type, source / meaning). Used for docs, PostGIS DDL and validation.
FIELDS: list[tuple[str, str, str]] = [
    ("parcel_id", "text", "PARCEL_ID, normalized to uppercase alphanumerics"),
    ("county_code", "smallint", "CO_NO: 53 Martin, 60 Palm Beach, 66 St. Lucie"),
    ("county_name", "text", "County name"),
    ("site_address", "text", "PHY_ADDR1"),
    ("site_city", "text", "PHY_CITY"),
    ("site_zip", "text", "PHY_ZIPCD (5-digit)"),
    ("use_code", "text", "DOR_UC (3-digit DOR land-use code)"),
    ("use_description", "text", "DOR_UC description"),
    ("use_category", "text", "Multifamily | Commercial/Retail | Industrial | Vacant Land | Single Family | ..."),
    ("asset_class", "text", "MF10 | MF2_9 | COM | IND | VAC_COM | SFR | CONDO | ..."),
    ("just_value", "bigint", "JV (just / market value)"),
    ("assessed_value", "bigint", "AV_NSD (assessed value for non-school levies, after caps)"),
    ("land_value", "bigint", "LND_VAL"),
    ("building_value", "bigint", "JV - LND_VAL (floored at 0)"),
    ("land_to_value_ratio", "real", "LND_VAL / JV"),
    ("bldg_to_land_ratio", "real", "(JV - LND_VAL) / LND_VAL"),
    ("tot_lvg_area", "integer", "TOT_LVG_AREA (building sq ft)"),
    ("lnd_sqfoot", "bigint", "LND_SQFOOT (lot sq ft)"),
    ("lot_acres", "real", "LND_SQFOOT / 43,560"),
    ("no_res_unts", "integer", "NO_RES_UNTS (as reported: hotel rooms, pads and placeholders included)"),
    ("residential_units", "integer", "NO_RES_UNTS on multifamily and mixed-use (DOR 012) parcels, else null"),
    ("nominal_value", "boolean", "just_value below NOMINAL_VALUE_MAX: a common-area, condo-style or sub-parcel"),
    ("no_buldng", "integer", "NO_BULDNG"),
    ("act_yr_blt", "smallint", "ACT_YR_BLT"),
    ("eff_yr_blt", "smallint", "EFF_YR_BLT"),
    ("owner_name", "text", "OWN_NAME"),
    ("owner_addr1", "text", "OWN_ADDR1"),
    ("owner_addr2", "text", "OWN_ADDR2"),
    ("owner_city", "text", "OWN_CITY"),
    ("owner_state", "text", "OWN_STATE"),
    ("owner_zip", "text", "OWN_ZIPCD (5-digit)"),
    ("owner_addr", "text", "Formatted owner mailing address"),
    ("last_sale_price", "bigint", "Most recent sale >= min price across NAL SALE_PRC1/2 and SDF"),
    ("last_sale_year", "smallint", "Year of that sale"),
    ("last_sale_month", "smallint", "Month of that sale"),
    ("last_sale_qual_cd", "text", "FDOR sale qualification code of that sale"),
    ("last_sale_qualified", "boolean", "True for code 01, False for codes 11+, else null"),
    ("hold_period_years", "smallint", "AS_OF_YEAR - last_sale_year, when that sale is within complete records"),
    ("no_sale_since", "smallint", "Hold unknown: the year from which no sale >= the minimum price is on record"),
    ("hold_floor_years", "smallint", "AS_OF_YEAR - no_sale_since: a lower bound on the hold period"),
    ("sales_from", "smallint", "Year from which the county's sale records are complete (null: latest transfer only)"),
    ("owner_name_key", "integer", "Portfolio key: normalized owner name (groups of 2+)"),
    ("owner_addr_key", "integer", "Portfolio key: normalized mailing address (groups of 2+)"),
    ("legal_desc", "text", "S_LEGAL"),
    ("tax_roll_year", "smallint", "ASMNT_YR"),
    ("lon", "double precision", "Label point longitude (guaranteed inside the parcel)"),
    ("lat", "double precision", "Label point latitude"),
    ("bbox", "jsonb", "[minLon, minLat, maxLon, maxLat]"),
]
FIELD_NAMES = [f[0] for f in FIELDS]


def qualified_from_code(code: str | None) -> bool | None:
    """FDOR codes: 01 qualified, 11+ not. Palm Beach CAMA letters: Q* qualified, D* / U* not."""
    if not code:
        return None
    head = code.strip()[:1].upper()
    if head == "Q":
        return True
    if head in ("D", "U"):
        return False
    digits = "".join(ch for ch in code if ch.isdigit())
    if not digits:
        return None
    n = int(digits)
    if n == 1:
        return True
    if n >= 11:
        return False
    return None


def finalize_record(r: dict, as_of_year: int = AS_OF_YEAR, nominal_value_max: int = NOMINAL_VALUE_MAX) -> dict:
    """Derive analytic fields in place (and return r)."""
    r["county_name"] = COUNTIES[r["county_code"]].name if r.get("county_code") in COUNTIES else ""
    uc = normalize_use_code(r.get("use_code"))
    r["use_code"] = uc
    r["asset_class"] = classify(uc)
    r["use_description"] = describe(uc)
    r["use_category"] = ASSET_CLASSES[r["asset_class"]][1]

    for k in ("site_address", "site_city", "owner_name", "owner_addr1", "owner_addr2", "owner_city",
              "legal_desc"):
        r[k] = clean_str(r.get(k))
    if r["site_address"].upper() in _NO_ADDRESS:
        r["site_address"] = ""
    r["owner_state"] = us_state_code(r.get("owner_state"))
    r["site_zip"] = zip5(r.get("site_zip"))
    r["owner_zip"] = zip5(r.get("owner_zip"))
    r["owner_addr"] = format_mailing_address(
        r["owner_addr1"], r["owner_addr2"], r["owner_city"], r["owner_state"], r["owner_zip"]
    )

    jv = r.get("just_value")
    lv = r.get("land_value")
    bv = max(jv - lv, 0) if jv is not None and lv is not None else None
    r["building_value"] = bv
    r["land_to_value_ratio"] = round_or_none(min(lv / jv, 1.0), 4) if jv and lv is not None and jv > 0 else None
    r["bldg_to_land_ratio"] = round_or_none(bv / lv, 3) if bv is not None and lv and lv > 0 else None

    lot = r.get("lnd_sqfoot")
    r["lot_acres"] = round(lot / 43560.0, 3) if lot else None

    # Hold period. `sales_from` = the year the county's sale records become complete (null when the
    # source only has each parcel's latest transfer, which is complete at any age). A last sale older
    # than that, or "no priced sale since" an earlier year, only proves no sale from `sales_from` on:
    # a later sale may be missing from the sparse early records. Such holds become minimums ("49+").
    sy = to_int(r.get("last_sale_year"))
    cov = to_int(r.get("sales_from"))
    nss = to_int(r.get("no_sale_since"))
    if sy and cov and sy < cov:
        sy_in_records = False
        nss = cov
    else:
        sy_in_records = bool(sy)
    if nss and cov and nss < cov:
        nss = cov
    r["sales_from"] = cov
    r["hold_period_years"] = max(as_of_year - sy, 0) if sy_in_records else None
    r["no_sale_since"] = nss if nss and not sy_in_records else None
    r["hold_floor_years"] = max(as_of_year - nss, 0) if r["no_sale_since"] else None
    r["last_sale_qual_cd"] = clean_str(r.get("last_sale_qual_cd")) or None
    r["last_sale_qualified"] = qualified_from_code(r["last_sale_qual_cd"])

    for k in ("just_value", "assessed_value", "land_value", "tot_lvg_area", "lnd_sqfoot", "no_res_unts", "no_buldng",
              "act_yr_blt", "eff_yr_blt", "last_sale_price", "last_sale_year", "last_sale_month", "tax_roll_year"):
        v = r.get(k)
        r[k] = int(v) if v is not None else None
    # Year-built of 0 means "unknown" in NAL.
    for k in ("act_yr_blt", "eff_yr_blt"):
        if r[k] is not None and r[k] < 1800:
            r[k] = None
    # The 2026 roll carries TOT_LVG_AR = 1 on ~7k improved office / warehouse / retail parcels
    # (buildings and year built present): a placeholder for "area not reported", not one square foot.
    if r["tot_lvg_area"] is not None and r["tot_lvg_area"] < MIN_BUILDING_SQFT:
        r["tot_lvg_area"] = None
    r["residential_units"] = r["no_res_unts"] if r["no_res_unts"] and residential_use(r) else None
    r["nominal_value"] = r["just_value"] is not None and r["just_value"] < nominal_value_max
    return r
