#!/usr/bin/env python3
"""Generate a realistic SYNTHETIC parcel dataset so the map works before the FDOR download.

~510 commercial, multifamily, industrial and vacant-commercial parcels laid out on
street-like block grids in:

  Martin (53)     Downtown Stuart, Stuart US-1, Port Salerno industrial, Palm City,
                  Jensen Beach, Hobe Sound
  St. Lucie (66)  Port St. Lucie US-1, St. Lucie West, Tradition, Tradition commerce
                  park, Gatlin Blvd, Downtown Fort Pierce, Fort Pierce industrial
  Palm Beach (60) Downtown West Palm Beach, Palm Beach Lakes Blvd, Riviera Beach
                  industrial, Jupiter (Indiantown Rd), Jupiter industrial, Abacoa

Twelve sponsor portfolios span counties and are deliberately messy: different LLC
names behind one mailing address, one entity spelled three ways, "C/O" lines,
"P.O. BOX" vs "PO BOX", so the owner resolver has real work to do. Every owner,
address and parcel ID is fictional.

The records go through exactly the same publish step as the production FDOR build.

    python pipeline/generate_sample_data.py                 # -> web/public/data
    python pipeline/generate_sample_data.py --emit-raw pipeline/raw_sample
        # also writes FDOR-format NAL / SDF CSVs + a parcel GeoJSON so that
        # build_fdor.py can be tested end-to-end without the real download.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pa2.config import AS_OF_YEAR, ATTRIBUTION_SAMPLE, OUT_DIR, WEB_DATA_DIR  # noqa: E402
from pa2.publish import publish  # noqa: E402

SEED = 20261109
TAX_ROLL_YEAR = 2025
M_PER_DEG_LAT = 110_574.0
SQFT_PER_M2 = 10.7639104


# ---------------------------------------------------------------------------
# Clusters
# ---------------------------------------------------------------------------
# Centres were checked against OpenFreeMap z14 water polygons: no parcel has its
# label point, most of its corners, or any corner in a large water body (>20 ha).


@dataclass
class Cluster:
    key: str
    county: int
    city: str
    zips: tuple[str, ...]
    lat: float
    lon: float
    bearing: float  # street grid rotation, degrees counter-clockwise from east
    streets: tuple[str, ...]
    mix: dict[str, float]
    n: int
    setting: str  # urban | suburban | industrial
    land_psf: tuple[float, float]  # land $/sf (just-value basis)
    row_width: float  # m
    block_len: float  # m between cross streets
    road: float  # m right-of-way
    subdivision: str
    pin: tuple[int, ...]
    new_build: bool = False


CLUSTERS: list[Cluster] = [
    # ---- Palm Beach (60) ----
    Cluster("wpb_downtown", 60, "WEST PALM BEACH", ("33401",), 26.7108, -80.0592, 0,
            ("CLEMATIS ST", "DATURA ST", "EVERNIA ST", "FERN ST", "BANYAN BLVD", "LAKEVIEW AVE"),
            {"MF10": .30, "COM": .52, "MF2_9": .06, "VAC_COM": .12}, 42, "urban", (85, 240), 520, 125, 20,
            "TOWN OF WEST PALM BEACH", (74, 43, 43)),
    Cluster("wpb_pbl", 60, "WEST PALM BEACH", ("33409", "33401"), 26.7208, -80.0925, 22,
            ("PALM BEACH LAKES BLVD", "VILLAGE BLVD", "EXECUTIVE CENTER DR", "METROCENTRE BLVD"),
            {"COM": .55, "MF10": .33, "VAC_COM": .12}, 34, "suburban", (28, 68), 820, 320, 30,
            "PALM BEACH LAKES COMMERCE CENTER", (74, 43, 43)),
    Cluster("riviera_ind", 60, "RIVIERA BEACH", ("33404",), 26.7798, -80.0805, 0,
            ("W 13TH ST", "W 15TH ST", "AVENUE E", "PORT CENTER WAY"),
            {"IND": .74, "VAC_COM": .16, "COM": .10}, 26, "industrial", (14, 30), 700, 360, 26,
            "RIVIERA BEACH INDUSTRIAL PARK", (56, 43, 42)),
    Cluster("jupiter_indiantown", 60, "JUPITER", ("33458", "33477"), 26.9338, -80.1060, 0,
            ("W INDIANTOWN RD", "TOWN HALL AVE", "MAPLEWOOD DR", "JUPITER LAKES BLVD"),
            {"COM": .58, "MF10": .25, "MF2_9": .06, "VAC_COM": .11}, 38, "suburban", (34, 82), 860, 300, 30,
            "JUPITER COMMERCE PLAZA", (30, 42, 41)),
    Cluster("jupiter_ind", 60, "JUPITER", ("33458",), 26.9178, -80.1298, 0,
            ("JUPITER PARK DR", "JUPITER PARK LN", "INDUSTRIAL WAY", "COMMERCE LN"),
            {"IND": .80, "VAC_COM": .20}, 26, "industrial", (20, 38), 760, 360, 26,
            "JUPITER PARK OF COMMERCE", (30, 42, 41)),
    Cluster("abacoa", 60, "JUPITER", ("33458",), 26.8912, -80.1128, 0,
            ("MAIN ST", "UNIVERSITY BLVD", "TOWN CENTER DR", "CENTRAL BLVD"),
            {"MF10": .45, "COM": .38, "MF2_9": .17}, 24, "urban", (30, 62), 600, 150, 22,
            "ABACOA TOWN CENTER", (30, 42, 41), True),
    # ---- Martin (53) ----
    Cluster("stuart_downtown", 53, "STUART", ("34994",), 27.1932, -80.2508, 0,
            ("SW OSCEOLA ST", "SE OCEAN BLVD", "SW COLORADO AVE", "SE DIXIE HWY", "SE FLAGLER AVE"),
            {"COM": .55, "MF10": .18, "MF2_9": .17, "VAC_COM": .10}, 30, "urban", (28, 72), 480, 115, 20,
            "TOWN OF STUART", (38, 41)),
    Cluster("stuart_us1", 53, "STUART", ("34997", "34994"), 27.1541, -80.2333, -35,
            ("SE FEDERAL HWY", "SE INDIAN ST", "SE SALERNO RD", "SE WILLOUGHBY BLVD"),
            {"COM": .55, "MF10": .25, "MF2_9": .10, "VAC_COM": .10}, 34, "suburban", (15, 36), 820, 300, 30,
            "STUART COMMERCIAL CENTER", (38, 41)),
    Cluster("port_salerno_ind", 53, "STUART", ("34997",), 27.1362, -80.2155, 0,
            ("SE DIXIE HWY", "SE COMMERCE AVE", "SE INDUSTRIAL WAY", "SE COVE RD"),
            {"IND": .70, "VAC_COM": .15, "COM": .15}, 22, "industrial", (9, 20), 640, 340, 26,
            "SALERNO INDUSTRIAL PARK", (38, 42)),
    Cluster("palm_city", 53, "PALM CITY", ("34990",), 27.1669, -80.3003, 0,
            ("SW MARTIN DOWNS BLVD", "SW MAPP RD", "SW CORNELL AVE", "SW HIGH MEADOW AVE"),
            {"COM": .50, "MF10": .30, "MF2_9": .10, "VAC_COM": .10}, 18, "suburban", (12, 28), 700, 300, 28,
            "MARTIN DOWNS", (38, 40)),
    Cluster("jensen_beach", 53, "JENSEN BEACH", ("34957",), 27.2388, -80.2428, 0,
            ("NW FEDERAL HWY", "NE JENSEN BEACH BLVD", "NW GOLDENROD RD", "NE PINECREST LAKES BLVD"),
            {"COM": .50, "MF10": .30, "MF2_9": .20}, 18, "suburban", (12, 30), 700, 280, 28,
            "JENSEN BEACH PLAZA", (37, 41)),
    Cluster("hobe_sound", 53, "HOBE SOUND", ("33455",), 27.0603, -80.1438, 0,
            ("SE FEDERAL HWY", "SE BRIDGE RD", "SE DIXIE HWY"),
            {"COM": .60, "MF2_9": .20, "VAC_COM": .20}, 12, "suburban", (14, 32), 560, 260, 26,
            "HOBE SOUND", (39, 42)),
    # ---- St. Lucie (66) ----
    Cluster("psl_us1", 66, "PORT ST LUCIE", ("34952",), 27.2862, -80.3096, 110,
            ("SE US HIGHWAY 1", "SE PORT ST LUCIE BLVD", "SE WALTON RD", "SE PRIMA VISTA BLVD"),
            {"COM": .55, "MF10": .25, "MF2_9": .10, "VAC_COM": .10}, 38, "suburban", (8, 21), 860, 300, 30,
            "PORT ST LUCIE SECTION 12", (3420,)),
    Cluster("slw", 66, "PORT ST LUCIE", ("34986",), 27.3048, -80.3991, 0,
            ("SW ST LUCIE WEST BLVD", "NW PEACOCK BLVD", "SW CALIFORNIA BLVD", "NW COURTYARD CIR"),
            {"COM": .45, "MF10": .35, "IND": .10, "VAC_COM": .10}, 30, "suburban", (9, 22), 820, 320, 30,
            "ST LUCIE WEST PLAT NO 101", (3326,)),
    Cluster("tradition", 66, "PORT ST LUCIE", ("34987",), 27.2634, -80.4455, 0,
            ("SW TRADITION PKWY", "SW VILLAGE PKWY", "SW COMMUNITY BLVD", "SW DISCOVERY WAY"),
            {"MF10": .45, "COM": .35, "VAC_COM": .20}, 26, "suburban", (10, 22), 860, 320, 32,
            "TRADITION PLAT NO 6", (4316,), True),
    Cluster("tradition_commerce", 66, "PORT ST LUCIE", ("34987",), 27.2284, -80.4312, 0,
            ("SW INNOVATION WAY", "SW COMMERCE CENTER PKWY", "SW LOGISTICS DR", "SW BECKER RD"),
            {"IND": .75, "VAC_COM": .25}, 26, "industrial", (5, 12), 900, 420, 32,
            "TRADITION COMMERCE PARK", (4324,), True),
    Cluster("gatlin", 66, "PORT ST LUCIE", ("34953",), 27.2512, -80.3722, 0,
            ("SW GATLIN BLVD", "SW ROSSER BLVD", "SW SAVONA BLVD"),
            {"COM": .60, "MF2_9": .20, "VAC_COM": .20}, 16, "suburban", (7, 16), 640, 280, 28,
            "PORT ST LUCIE SECTION 31", (3420,)),
    Cluster("fp_downtown", 66, "FORT PIERCE", ("34950",), 27.4442, -80.3328, 0,
            ("ORANGE AVE", "AVENUE A", "N 2ND ST", "N 7TH ST", "DELAWARE AVE"),
            {"COM": .50, "MF2_9": .30, "MF10": .10, "VAC_COM": .10}, 26, "urban", (10, 34), 480, 115, 20,
            "FORT PIERCE ORIGINAL TOWN", (2410,)),
    Cluster("fp_ind", 66, "FORT PIERCE", ("34947",), 27.4382, -80.3882, 0,
            ("N KINGS HWY", "OKEECHOBEE RD", "BELL AVE", "ENTERPRISE DR"),
            {"IND": .70, "COM": .15, "VAC_COM": .15}, 24, "industrial", (3, 9), 760, 380, 28,
            "FORT PIERCE INDUSTRIAL PARK", (2408,)),
]


# ---------------------------------------------------------------------------
# Asset archetypes
# ---------------------------------------------------------------------------

# use: (urban weight, suburban weight, bldg sf range, FAR range, new $/sf range, depth/frontage)
COM_SPECS: dict[str, tuple] = {
    "011": (0.10, 0.16, (2500, 14000), (0.18, 0.35), (150, 230), (1.0, 1.8)),
    "012": (0.16, 0.03, (6000, 48000), (0.8, 2.6), (190, 300), (1.0, 1.6)),
    "014": (0.00, 0.05, (28000, 62000), (0.18, 0.26), (140, 200), (0.7, 1.1)),
    "016": (0.00, 0.14, (35000, 185000), (0.17, 0.27), (140, 210), (0.6, 1.0)),
    "017": (0.04, 0.10, (4000, 22000), (0.20, 0.35), (160, 240), (1.0, 1.6)),
    "018": (0.24, 0.08, (25000, 260000), (0.9, 4.5), (210, 360), (0.9, 1.4)),
    "019": (0.06, 0.10, (4000, 38000), (0.20, 0.40), (190, 290), (1.0, 1.6)),
    "021": (0.10, 0.08, (3000, 9000), (0.14, 0.24), (240, 420), (1.0, 1.5)),
    "022": (0.02, 0.08, (2200, 4500), (0.07, 0.14), (260, 420), (1.0, 1.4)),
    "023": (0.04, 0.05, (3000, 7000), (0.08, 0.16), (230, 360), (1.0, 1.4)),
    "026": (0.00, 0.05, (2400, 5500), (0.06, 0.12), (220, 380), (1.0, 1.3)),
    "027": (0.00, 0.06, (6000, 42000), (0.08, 0.20), (120, 190), (1.0, 1.8)),
    "033": (0.04, 0.00, (3000, 9000), (0.30, 0.90), (220, 360), (1.2, 2.0)),
    "039": (0.10, 0.02, (45000, 240000), (0.6, 3.0), (230, 380), (0.9, 1.3)),
}
INDUSTRIAL_COM_USES = ("011", "017", "022", "026", "027")

# use: (weight, bldg sf range, FAR range, new $/sf range, depth/frontage)
IND_SPECS: dict[str, tuple] = {
    "041": (0.30, (8000, 90000), (0.25, 0.42), (95, 150), (1.0, 2.0)),
    "048": (0.55, (12000, 360000), (0.28, 0.45), (85, 140), (1.0, 2.2)),
    "049": (0.15, (1200, 8000), (0.02, 0.07), (70, 110), (1.0, 2.0)),
}


def log_uniform(rng: random.Random, lo: float, hi: float) -> float:
    return math.exp(rng.uniform(math.log(lo), math.log(hi)))


def weighted(rng: random.Random, weights: dict[str, float]) -> str:
    keys = [k for k, w in weights.items() if w > 0]
    return rng.choices(keys, weights=[weights[k] for k in keys])[0]


def year_built(rng: random.Random, c: Cluster, lo: int, hi: int) -> int:
    if c.new_build:
        return rng.randint(max(lo, 2012), hi)
    if c.setting == "urban" and rng.random() < 0.45:
        return rng.randint(max(lo, 2004), hi)
    return rng.randint(lo, hi)


def make_asset(rng: random.Random, c: Cluster, cls: str, use_code: str | None = None) -> dict:
    """Physical + valuation attributes for one parcel of asset class `cls`."""
    urban = c.setting == "urban"
    teardown = False
    units = 0
    n_bldg = 1
    if cls == "MF10":
        use_code = "003"
        if urban:
            units = rng.randint(48, 320)
            lot_ac = units / rng.uniform(45, 110)
            new_psf = rng.uniform(205, 285)
            n_bldg = rng.randint(1, 2)
        else:
            units = rng.randint(72, 396)
            lot_ac = units / rng.uniform(12, 24)
            new_psf = rng.uniform(150, 215)
            n_bldg = max(2, units // rng.randint(16, 32))
        sf = units * rng.uniform(880, 1120)
        yb = year_built(rng, c, 1972, 2025)
        aspect = rng.uniform(0.8, 1.5)
        teardown = not c.new_build and rng.random() < (0.16 if urban else 0.08)
    elif cls == "MF2_9":
        use_code = "008"
        units = rng.choice([2, 2, 2, 3, 4, 4, 4, 5, 6, 8, 9])
        lot_ac = rng.uniform(0.13, 0.30) * (1 + units / 8)
        sf = units * rng.uniform(780, 1080)
        yb = rng.randint(1948, 2012) if not c.new_build else rng.randint(2008, 2024)
        new_psf = rng.uniform(140, 200)
        n_bldg = 1 if units <= 4 else rng.randint(1, 3)
        aspect = rng.uniform(1.8, 3.0)
        teardown = not c.new_build and rng.random() < (0.30 if urban else 0.15)
    elif cls == "COM":
        if use_code is None:
            if c.setting == "industrial":
                use_code = rng.choice(INDUSTRIAL_COM_USES)
            else:
                use_code = weighted(rng, {u: s[0 if urban else 1] for u, s in COM_SPECS.items()})
        _, _, sf_rng, far_rng, psf_rng, asp_rng = COM_SPECS[use_code]
        if use_code == "039" and not urban:
            sf_rng, far_rng = (40000, 120000), (0.35, 0.8)
        sf = log_uniform(rng, *sf_rng)
        lot_ac = sf / rng.uniform(*far_rng) / 43560
        yb = year_built(rng, c, 1958, 2024)
        new_psf = rng.uniform(*psf_rng)
        aspect = rng.uniform(*asp_rng)
        n_bldg = 1 if sf < 30000 else rng.randint(1, 4)
        if use_code == "012":
            units = rng.randint(0, 24)
        teardown = use_code not in ("039", "018") and not c.new_build and rng.random() < (0.22 if urban else 0.12)
    elif cls == "IND":
        if use_code is None:
            use_code = weighted(rng, {u: s[0] for u, s in IND_SPECS.items()})
        _, sf_rng, far_rng, psf_rng, asp_rng = IND_SPECS[use_code]
        sf = log_uniform(rng, *sf_rng)
        lot_ac = sf / rng.uniform(*far_rng) / 43560
        yb = year_built(rng, c, 1970, 2025)
        new_psf = rng.uniform(*psf_rng)
        aspect = rng.uniform(*asp_rng)
        n_bldg = 1 if sf < 60000 else rng.randint(1, 3)
        teardown = not c.new_build and rng.random() < 0.08
    elif cls == "VAC_COM":
        use_code = use_code or ("040" if c.setting == "industrial" else "010")
        lot_ac = log_uniform(rng, 0.35, 3.5 if urban else 18)
        sf = 0
        yb = None
        new_psf = 0
        aspect = rng.uniform(0.8, 1.8)
        n_bldg = 0
    else:
        raise ValueError(cls)

    lot_sf = int(lot_ac * 43560)
    lo, hi = c.land_psf
    land_psf = rng.uniform(lo, hi) * min(1.25, max(0.55, (max(lot_ac, 0.25)) ** -0.15))
    if teardown:
        yb = rng.randint(1950, 1979)
        land_psf = rng.uniform((lo + hi) / 2, hi)
    land_value = int(round(lot_sf * land_psf, -2))

    eff = None
    bldg_value = 0
    if sf:
        sf = int(round(sf, -1))
        eff = min(yb + rng.choice([0, 0, 0, 5, 10, 15, 20, 25]), TAX_ROLL_YEAR)
        age = AS_OF_YEAR - eff
        dep = max(0.30, 1 - (0.013 if cls == "IND" else 0.011) * age)
        cond = rng.uniform(0.32, 0.55) if teardown else rng.uniform(0.86, 1.10)
        bldg_value = int(round(sf * new_psf * dep * cond * rng.uniform(1.02, 1.07), -2))
    return {
        "asset_class": cls,
        "use_code": use_code,
        "no_res_unts": units,
        "tot_lvg_area": sf,
        "lnd_sqfoot": lot_sf,
        "act_yr_blt": yb,
        "eff_yr_blt": eff,
        "no_buldng": n_bldg,
        "land_value": land_value,
        "just_value": land_value + bldg_value,
        "_aspect": aspect,
        "_teardown": teardown,
    }


def make_sale(rng: random.Random, p: dict, hold_range: tuple[int, int] | None = None) -> None:
    """Last sale consistent with today's value (plus an optional earlier sale for NAL SALE_*2)."""
    p.update(last_sale_price=None, last_sale_year=None, last_sale_month=None, last_sale_qual_cd=None, _prev_sale=None)
    if hold_range is None:
        if rng.random() < 0.03:
            return  # no sale on record
        lo, hi = rng.choices([(0, 4), (5, 11), (12, 24), (25, 44)], weights=[0.28, 0.30, 0.27, 0.15])[0]
    else:
        lo, hi = hold_range
    hold = rng.randint(lo, hi)
    year = AS_OF_YEAR - hold
    month = rng.randint(1, 10 if year == AS_OF_YEAR else 12)
    growth = rng.uniform(0.038, 0.062)
    built_after_sale = p["act_yr_blt"] is not None and year < p["act_yr_blt"]
    basis = p["land_value"] if built_after_sale or not p["tot_lvg_area"] else p["just_value"]
    price = basis / 0.85 / (1 + growth) ** (hold + (12 - month) / 12) * rng.uniform(0.88, 1.12)
    qual = "01" if rng.random() < 0.84 else rng.choice(["11", "12", "18"])
    if qual != "01":
        price *= rng.uniform(0.35, 0.9)
    p.update(last_sale_price=int(round(price, -3)), last_sale_year=year, last_sale_month=month, last_sale_qual_cd=qual)
    if rng.random() < 0.5 and year > 1982:
        prev_year = rng.randint(max(1975, year - 22), year - 1)
        prev_price = price / (1 + growth) ** (year - prev_year) * rng.uniform(0.85, 1.1)
        p["_prev_sale"] = (int(round(prev_price, -3)), prev_year, rng.randint(1, 12), "01")


# ---------------------------------------------------------------------------
# Owners
# ---------------------------------------------------------------------------

# Sponsor portfolios: names/addresses are fictional. Variants are intentional.
SPONSORS: list[dict] = [
    dict(key="crr", n=9, classes={"MF10": 1}, counties=(53, 66, 60), hold=(2, 9), name_mode="rotate",
         names=["CRR STUART I LLC", "CRR STUART II LLC", "CRR JENSEN BEACH LLC", "CRR PORT ST LUCIE LLC",
                "CRR TRADITION LLC", "CRR WEST PALM LLC", "CRR JUPITER LLC"],
         addresses=[("4800 N FLAGLER DR STE 1200", "", "WEST PALM BEACH", "FL", "33407"),
                    ("4800 NORTH FLAGLER DRIVE, SUITE 1200", "", "WEST PALM BEACH", "FL", "33407-2841")]),
    dict(key="kestrel", n=11, classes={"IND": 1}, counties=(53, 66, 60), hold=(1, 8), name_mode="random",
         settings=("industrial", "suburban"),
         names=["KESTREL INDUSTRIAL PROPERTIES LP", "KESTREL INDUSTRIAL PROPERTIES, L.P.",
                "Kestrel Industrial Properties Limited Partnership"],
         addresses=[("200 S WACKER DR STE 3100", "", "CHICAGO", "IL", "60606"),
                    ("200 SOUTH WACKER DRIVE", "SUITE 3100", "CHICAGO", "IL", "60606")]),
    dict(key="lox", n=7, classes={"COM": 2, "VAC_COM": 1}, counties=(60, 53, 66), hold=(10, 25), name_mode="random",
         names=["LOXAHATCHEE HOLDINGS LLC"],
         addresses=[("1001 W INDIANTOWN RD STE 202", "", "JUPITER", "FL", "33458")]),
    dict(key="sabal", n=8, classes={"COM": 1}, counties=(60, 53, 66), hold=(6, 18), name_mode="random",
         uses=("016", "014", "011"), settings=("suburban",),
         names=["SABAL PALM RETAIL TRUST"],
         addresses=[("3300 PGA BLVD STE 870", "", "PALM BEACH GARDENS", "FL", "33410")]),
    dict(key="irc", n=10, classes={"MF2_9": 1}, counties=(66, 53), hold=(3, 12), name_mode="rotate",
         names=["IRC RENTALS 1 LLC", "IRC RENTALS 2 LLC", "IRC RENTALS 3 LLC", "INDIAN RIVER CAPITAL GROUP LLC"],
         addresses=[("PO BOX 1847", "", "STUART", "FL", "34995"), ("P.O. BOX 1847", "", "STUART", "FL", "34995")]),
    dict(key="halcyon", n=4, classes={"COM": 1}, counties=(53, 60), hold=(2, 10), name_mode="by_city",
         uses=("039",), names=["HALCYON HOSPITALITY {CITY} LLC"],
         addresses=[("1450 BRICKELL AVE STE 2000", "", "MIAMI", "FL", "33131")]),
    dict(key="osprey", n=6, classes={"COM": 1}, counties=(60, 53), hold=(12, 28), name_mode="random",
         uses=("018", "017", "019"), names=["OSPREY POINT PARTNERS LTD"],
         addresses=[("525 S FLAGLER DR STE 300", "", "WEST PALM BEACH", "FL", "33401")]),
    dict(key="bluewater", n=6, classes={"MF10": 1}, counties=(66, 60), hold=(1, 5), name_mode="rotate",
         names=["BLUEWATER MULTIFAMILY FUND III LP", "BLUEWATER MF PSL OWNER LLC"],
         addresses=[("C/O BLUEWATER ASSET MANAGEMENT", "745 FIFTH AVE FL 22", "NEW YORK", "NY", "10151"),
                    ("745 FIFTH AVENUE", "FLOOR 22", "NEW YORK", "NY", "10151-0022")]),
    dict(key="gulfstream", n=5, classes={"COM": 1}, counties=(53, 66, 60), hold=(15, 35), name_mode="random",
         uses=("027",), settings=("suburban",), names=["GULFSTREAM AUTO REALTY LLC"],
         addresses=[("2600 SE FEDERAL HWY", "", "STUART", "FL", "34994")]),
    dict(key="palmetto", n=8, classes={"VAC_COM": 1}, counties=(66, 53, 60), hold=(4, 20), name_mode="random",
         settings=("suburban", "industrial"),
         names=["PALMETTO LAND VENTURES LLC"],
         addresses=[("3501 PIEDMONT RD NE STE 400", "", "ATLANTA", "GA", "30305")]),
    dict(key="martinez", n=4, classes={"MF2_9": 1}, counties=(53, 66), hold=(25, 42), name_mode="random",
         names=["MARTINEZ FAMILY TRUST", "MARTINEZ ROBERTO & ELENA TR"],
         addresses=[("1420 SW CORNELL AVE", "", "PALM CITY", "FL", "34990")]),
    dict(key="tc_storage", n=5, classes={"IND": 1}, counties=(66, 53), hold=(3, 12), name_mode="random",
         uses=("048",), settings=("industrial", "suburban"), names=["TREASURE COAST STORAGE PARTNERS LLC"],
         addresses=[("8000 S US HIGHWAY 1 STE 302", "", "PORT ST LUCIE", "FL", "34952")]),
]

FIRST = ["JAMES", "MARIA", "ROBERT", "LINDA", "MICHAEL", "PATRICIA", "DAVID", "BARBARA", "RICHARD", "SUSAN",
         "JOSEPH", "KAREN", "THOMAS", "NANCY", "CARLOS", "ANA", "WILLIAM", "DEBORAH", "DANIEL", "SANDRA",
         "PAUL", "DONNA", "MARK", "CAROL", "STEVEN", "SHARON", "KEVIN", "LAURA", "BRIAN", "HELEN", "RAJ",
         "PRIYA", "WEI", "MEI", "AHMED", "FATIMA", "IVAN", "GRACE", "LUIS", "ELENA"]
LAST = ["SMITH", "JOHNSON", "WILLIAMS", "BROWN", "JONES", "GARCIA", "MILLER", "DAVIS", "RODRIGUEZ", "WILSON",
        "ANDERSON", "THOMAS", "TAYLOR", "MOORE", "JACKSON", "LEE", "PEREZ", "THOMPSON", "WHITE", "HARRIS",
        "SANCHEZ", "CLARK", "RAMIREZ", "LEWIS", "ROBINSON", "WALKER", "YOUNG", "ALLEN", "KING", "WRIGHT",
        "SCOTT", "TORRES", "NGUYEN", "HILL", "FLORES", "GREEN", "ADAMS", "NELSON", "BAKER", "HALL", "RIVERA",
        "CAMPBELL", "MITCHELL", "CARTER", "ROBERTS", "PATEL", "KOWALSKI", "OKAFOR", "SCHNEIDER", "ROSSI",
        "COHEN", "MURPHY", "SULLIVAN", "DESAI", "FERREIRA", "LINDQVIST"]
ENTITY_A = ["ATLANTIC", "HARBOR", "CYPRESS", "MANGROVE", "PELICAN", "SEAGRAPE", "CORAL", "TARPON", "SNOOK",
            "HERON", "EGRET", "SANDPIPER", "KINGFISHER", "ANCHOR", "TIDEWATER", "BRIGHTWATER", "SUNRISE",
            "LIGHTHOUSE", "INLET", "LAGOON", "BANYAN", "POINCIANA", "ROYAL POINCIANA", "SEA OATS", "DRIFTWOOD",
            "SAILFISH", "MARLIN", "GUMBO LIMBO", "SEABREEZE", "WATERSIDE", "PORTSIDE", "BAYFRONT", "SOUTHPORT",
            "NORTHPOINT", "EASTGATE", "WESTWIND", "PINEAPPLE", "CITRUS", "OCEANSIDE", "RIVERWALK", "COQUINA",
            "SAWGRASS", "KEYSTONE", "CORNERSTONE", "GRANITE", "SUMMIT", "MERIDIAN", "OLD DIXIE", "SEMINOLE",
            "CALOOSA", "TEQUESTA", "HUTCHINSON", "SEWALLS POINT", "ST LUCIE INLET", "INDIANTOWN"]
ENTITY_B = ["PROPERTIES", "HOLDINGS", "INVESTMENTS", "VENTURES", "PARTNERS", "REALTY", "GROUP", "CAPITAL",
            "DEVELOPMENT", "ASSOCIATES", "ENTERPRISES", "EQUITIES", "LAND CO", "PLAZA"]
ENTITY_SUFFIX = ["LLC"] * 7 + ["INC", "LTD", "LP", "CORP"]

LOCAL_STREETS = {
    53: ["SE ST LUCIE BLVD", "SW SUNSET TRL", "SE OSPREY ST", "NW RIVER SHORES DR", "SE HARBOR POINT DR",
         "SW PALM CITY RD", "SE GREEN ACRES CIR", "SE SEWALLS POINT RD"],
    66: ["SW CALIFORNIA BLVD", "SE MORNINGSIDE BLVD", "NW SELVITZ RD", "SW ABINGDON AVE", "SE THORNHILL DR",
         "NW BAYSHORE BLVD", "S OCEAN DR", "SE SUNRISE BLVD"],
    60: ["N OLIVE AVE", "S FLAGLER DR", "PARKSIDE DR", "BIRD BAY DR", "LOXAHATCHEE DR", "MILITARY TRL",
         "N OCEAN BLVD", "SEMINOLE AVE", "LIGHTHOUSE DR"],
}
LOCAL_CITIES = {
    53: [("STUART", "34996"), ("STUART", "34994"), ("PALM CITY", "34990"), ("JENSEN BEACH", "34957"),
         ("HOBE SOUND", "33455")],
    66: [("PORT ST LUCIE", "34952"), ("PORT ST LUCIE", "34953"), ("PORT ST LUCIE", "34983"),
         ("PORT ST LUCIE", "34986"), ("FORT PIERCE", "34949"), ("FORT PIERCE", "34950")],
    60: [("WEST PALM BEACH", "33401"), ("WEST PALM BEACH", "33405"), ("JUPITER", "33458"), ("JUPITER", "33477"),
         ("PALM BEACH GARDENS", "33410"), ("NORTH PALM BEACH", "33408"), ("PALM BEACH", "33480"),
         ("TEQUESTA", "33469")],
}
OUT_OF_STATE = [
    ("NEW YORK", "NY", "10022", ["MADISON AVE", "PARK AVE", "LEXINGTON AVE", "W 57TH ST"]),
    ("GREENWICH", "CT", "06830", ["GREENWICH AVE", "STEAMBOAT RD"]),
    ("CHICAGO", "IL", "60611", ["N MICHIGAN AVE", "E OHIO ST"]),
    ("COLUMBUS", "OH", "43215", ["E BROAD ST", "N HIGH ST"]),
    ("ATLANTA", "GA", "30326", ["PEACHTREE RD NE", "LENOX RD NE"]),
    ("BOSTON", "MA", "02116", ["BOYLSTON ST", "NEWBURY ST"]),
    ("PRINCETON", "NJ", "08540", ["NASSAU ST", "WITHERSPOON ST"]),
    ("DALLAS", "TX", "75201", ["ROSS AVE", "MCKINNEY AVE"]),
    ("CHARLOTTE", "NC", "28202", ["S TRYON ST", "N COLLEGE ST"]),
]


class OwnerFactory:
    def __init__(self, rng: random.Random, reserved_names: set[str]):
        self.rng = rng
        self.used_names = set(reserved_names)
        self.used_addrs: set[tuple[str, str]] = set()

    def _unique_name(self, make) -> str:
        for _ in range(200):
            name = make()
            if name not in self.used_names:
                self.used_names.add(name)
                return name
        raise RuntimeError("could not generate a unique owner name")

    def entity(self) -> str:
        r = self.rng
        return self._unique_name(lambda: f"{r.choice(ENTITY_A)} {r.choice(ENTITY_B)} {r.choice(ENTITY_SUFFIX)}")

    def person(self) -> str:
        r = self.rng

        def make():
            last, first = r.choice(LAST), r.choice(FIRST)
            mi = r.choice("ABCDEFGHJKLMNPRSTW")
            if r.random() < 0.45:
                return f"{last} {first} {mi} & {r.choice(FIRST)}"
            return f"{last} {first} {mi}"

        return self._unique_name(make)

    def trust(self) -> str:
        r = self.rng

        def make():
            last, first = r.choice(LAST), r.choice(FIRST)
            return f"{last} {first} {r.choice('ABCDEFGHJKLMNPRSTW')} TR" if r.random() < 0.6 else f"{last} FAMILY TRUST"

        return self._unique_name(make)

    def _unique_addr(self, make) -> tuple:
        for _ in range(200):
            a = make()
            k = (a[0], a[4])
            if k not in self.used_addrs:
                self.used_addrs.add(k)
                return a
        raise RuntimeError("could not generate a unique address")

    def local_residential(self, county: int) -> tuple:
        r = self.rng
        city, z = r.choice(LOCAL_CITIES[county])
        return self._unique_addr(lambda: (f"{r.randint(100, 9899)} {r.choice(LOCAL_STREETS[county])}", "", city, "FL", z))

    def local_office(self, county: int) -> tuple:
        r = self.rng
        city, z = r.choice(LOCAL_CITIES[county])
        return self._unique_addr(
            lambda: (f"{r.randint(100, 9899)} {r.choice(LOCAL_STREETS[county])} STE {r.randint(1, 9)}{r.randint(0, 9)}{r.randint(0, 9)}",
                     "", city, "FL", z))

    def out_of_state(self, office: bool) -> tuple:
        r = self.rng
        city, st, z, streets = r.choice(OUT_OF_STATE)
        return self._unique_addr(
            lambda: (f"{r.randint(1, 1999)} {r.choice(streets)}" + (f" STE {r.randint(2, 48)}00" if office else ""),
                     "", city, st, z))

    def mark_used(self, addr: tuple) -> None:
        self.used_addrs.add((addr[0], addr[4]))


def assign_single_owner(rng: random.Random, f: OwnerFactory, p: dict) -> None:
    cls, county = p["asset_class"], p["county_code"]
    roll = rng.random()
    if cls == "MF2_9":
        kind = "person" if roll < 0.55 else ("trust" if roll < 0.68 else "entity")
    elif cls in ("MF10", "IND"):
        kind = "entity" if roll < 0.9 else "trust"
    elif cls == "VAC_COM":
        kind = "entity" if roll < 0.7 else "person"
    else:
        kind = "entity" if roll < 0.7 else ("person" if roll < 0.85 else "trust")
    p["owner_name"] = {"person": f.person, "trust": f.trust, "entity": f.entity}[kind]()

    roll = rng.random()
    site = (p["site_address"], "", p["site_city"], "FL", p["site_zip"])
    if kind == "entity":
        if roll < 0.30 and cls != "VAC_COM":
            addr = site
        elif roll < 0.75:
            addr = f.local_office(county)
        else:
            addr = f.out_of_state(office=True)
    else:
        if roll < 0.20 and cls == "MF2_9":
            addr = site
        elif roll < 0.72:
            addr = f.local_residential(county)
        else:
            addr = f.out_of_state(office=False)
    f.mark_used(addr)
    p["owner_addr1"], p["owner_addr2"], p["owner_city"], p["owner_state"], p["owner_zip"] = addr


# ---------------------------------------------------------------------------
# Parcel IDs, legal descriptions
# ---------------------------------------------------------------------------

PID_GROUPS = {60: (2, 2, 2, 2, 2, 3, 4), 53: (2, 2, 2, 3, 3, 5, 1), 66: (4, 3, 4, 3, 1)}


def make_pid(rng: random.Random, c: Cluster, used: set[str]) -> str:
    while True:
        if c.county == 60:
            muni, rng_, twp = c.pin
            pid = (f"{muni:02d}{rng_:02d}{twp:02d}{rng.randint(1, 36):02d}{rng.randint(0, 99):02d}"
                   f"{rng.randint(0, 120):03d}{rng.randint(1, 400) * 10:04d}")
        elif c.county == 53:
            twp, rng_ = c.pin
            pid = (f"{rng.randint(1, 36):02d}{twp:02d}{rng_:02d}{rng.randint(0, 120):03d}{rng.randint(0, 40):03d}"
                   f"{rng.randint(1, 900) * 10:05d}{rng.randint(0, 9)}")
        else:
            pid = (f"{c.pin[0] + rng.randint(0, 9):04d}{rng.randint(100, 999):03d}{rng.randint(1, 2400):04d}"
                   f"{rng.randint(0, 20):03d}{rng.randint(0, 9)}")
        if pid not in used:
            used.add(pid)
            return pid


def dashed_pid(pid: str, county: int) -> str:
    out, i = [], 0
    for n in PID_GROUPS[county]:
        out.append(pid[i:i + n])
        i += n
    return "-".join(out)


def legal_desc(rng: random.Random, c: Cluster, p: dict) -> str:
    lot, blk = rng.randint(1, 48), rng.randint(1, 60)
    if p["lnd_sqfoot"] > 5 * 43560:
        return f"{c.subdivision} TRACT {rng.choice('ABCDEFGH')} LESS R/W"
    if c.county == 66:
        return f"{c.subdivision} BLK {blk} LOT {lot}"
    return f"{c.subdivision} LT {lot} BLK {blk}"


# ---------------------------------------------------------------------------
# Layout: pack parcels into street-facing rows, rotate, place on the map
# ---------------------------------------------------------------------------


def layout_cluster(rng: random.Random, c: Cluster, parcels: list[dict]) -> None:
    from shapely.geometry import Polygon

    for p in parcels:
        area = p["lnd_sqfoot"] / SQFT_PER_M2
        d = math.sqrt(area * p["_aspect"])
        p["_w"], p["_d"] = area / d, d

    # Rows (one side of a street each), with cross-street gaps every block.
    rows: list[list[dict]] = []
    cur: list[dict] = []
    width = since_cross = 0.0
    for p in parcels:
        gap = 0.0
        if cur and width + p["_w"] > c.row_width:
            rows.append(cur)
            cur, width, since_cross = [], 0.0, 0.0
        elif cur and since_cross + p["_w"] > c.block_len:
            gap, since_cross = c.road, 0.0
        p["_x"] = width + gap
        p["_corner"] = not cur or gap > 0
        width += gap + p["_w"]
        since_cross += p["_w"]
        cur.append(p)
    if cur:
        rows.append(cur)

    # Pair rows across each street: even rows hang below the street, odd rows sit above.
    used_numbers: set[tuple[str, int]] = set()
    street_base: dict[int, int] = {}
    street_y = 0.0
    for i, row in enumerate(rows):
        pair = i // 2
        depth = max(p["_d"] for p in row)
        if i % 2 == 0 and i > 0:
            above = rows[i - 1]
            street_y += c.road + max(q["_d"] for q in above) + depth + rng.uniform(0, 6)
        street = c.streets[pair % len(c.streets)]
        base = street_base.setdefault(pair, 100 + 100 * rng.randint(1, 60))
        upper = i % 2 == 1
        for p in row:
            y0 = street_y + c.road / 2 if upper else street_y - c.road / 2 - p["_d"]
            p["_rect"] = (p["_x"], y0, p["_x"] + p["_w"], y0 + p["_d"])
            p["_front_y"] = y0 if upper else y0 + p["_d"]
            num = base + 2 * int(p["_x"] / 5) + (0 if upper else 1)
            while (street, num) in used_numbers:
                num += 2
            used_numbers.add((street, num))
            p["site_address"] = f"{num} {street}"

    xs = [v for p in parcels for v in (p["_rect"][0], p["_rect"][2])]
    ys = [v for p in parcels for v in (p["_rect"][1], p["_rect"][3])]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    th = math.radians(c.bearing)
    cos_t, sin_t = math.cos(th), math.sin(th)
    m_per_deg_lon = 111_320.0 * math.cos(math.radians(c.lat))

    def to_lonlat(x: float, y: float) -> tuple[float, float]:
        x, y = x - cx, y - cy
        xr, yr = x * cos_t - y * sin_t, x * sin_t + y * cos_t
        return (c.lon + xr / m_per_deg_lon, c.lat + yr / M_PER_DEG_LAT)

    for p in parcels:
        x0, y0, x1, y1 = p["_rect"]
        pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        if p["_corner"] and rng.random() < 0.5:
            cut = min(7.0, 0.18 * p["_w"], 0.18 * p["_d"])
            fy = p["_front_y"]
            # chamfer the street-facing corner on the cross-street side
            if fy == y0:
                pts = [(x0, y0 + cut), (x0 + cut, y0), (x1, y0), (x1, y1), (x0, y1)]
            else:
                pts = [(x0, y0), (x1, y0), (x1, y1), (x0 + cut, y1), (x0, y1 - cut)]
        p["geometry"] = Polygon([to_lonlat(x, y) for x, y in pts])
        p["site_city"] = c.city
        p["site_zip"] = c.zips[0] if len(c.zips) == 1 or rng.random() < 0.7 else rng.choice(c.zips[1:])


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------


def generate(seed: int = SEED) -> list[dict]:
    rng = random.Random(seed)
    used_pids: set[str] = set()
    by_cluster: dict[str, list[dict]] = {c.key: [] for c in CLUSTERS}
    sponsor_names = {n.upper() for sp in SPONSORS for n in sp["names"]}

    # 1) Sponsor parcels, spread across counties and clusters.
    for sp in SPONSORS:
        settings = sp.get("settings", ("urban", "suburban"))
        eligible = [c for c in CLUSTERS if c.county in sp["counties"] and c.setting in settings
                    and any(c.mix.get(k, 0) > 0 for k in sp["classes"])]
        eligible.sort(key=lambda c: (sp["counties"].index(c.county), rng.random()))
        by_county: dict[int, list[Cluster]] = {}
        for c in eligible:
            by_county.setdefault(c.county, []).append(c)
        # Round-robin across counties (then clusters) so every portfolio crosses county lines.
        order: list[Cluster] = []
        rnd = 0
        while len(order) < sp["n"]:
            for cs in by_county.values():
                if len(order) < sp["n"]:
                    order.append(cs[rnd % len(cs)])
            rnd += 1
        for i, c in enumerate(order):
            classes = {k: w for k, w in sp["classes"].items() if c.mix.get(k, 0) > 0}
            cls = weighted(rng, classes)
            use = rng.choice(sp["uses"]) if sp.get("uses") and cls in ("COM", "IND") else None
            p = make_asset(rng, c, cls, use)
            make_sale(rng, p, sp["hold"])
            if sp["name_mode"] == "rotate":
                name = sp["names"][i % len(sp["names"])]
            elif sp["name_mode"] == "by_city":
                name = sp["names"][0].replace("{CITY}", {"WEST PALM BEACH": "WPB"}.get(c.city, c.city))
            else:
                name = rng.choice(sp["names"])
            addr = sp["addresses"][0] if rng.random() < 0.6 else rng.choice(sp["addresses"])
            p["owner_name"] = name
            p["owner_addr1"], p["owner_addr2"], p["owner_city"], p["owner_state"], p["owner_zip"] = addr
            p["_sponsor"] = sp["key"]
            by_cluster[c.key].append(p)

    # 2) Fill each cluster from its asset mix.
    for c in CLUSTERS:
        parcels = by_cluster[c.key]
        while len(parcels) < c.n:
            p = make_asset(rng, c, weighted(rng, c.mix))
            make_sale(rng, p)
            parcels.append(p)
        rng.shuffle(parcels)
        for p in parcels:
            p["_cluster"] = c.key
            p["county_code"] = c.county
            p["parcel_id"] = make_pid(rng, c, used_pids)
            p["legal_desc"] = legal_desc(rng, c, p)
            p["tax_roll_year"] = TAX_ROLL_YEAR
        layout_cluster(rng, c, parcels)

    # 3) Independent owners (need site addresses for owner-occupied mailing addresses).
    factory = OwnerFactory(rng, sponsor_names)
    for sp in SPONSORS:
        for a in sp["addresses"]:
            factory.mark_used(a)
    records = [p for c in CLUSTERS for p in by_cluster[c.key]]
    for p in records:
        if "owner_name" not in p:
            assign_single_owner(rng, factory, p)
    return records


# ---------------------------------------------------------------------------
# Optional: FDOR-format raw files (for testing build_fdor.py end-to-end)
# ---------------------------------------------------------------------------

NAL_COLUMNS = [
    "CO_NO", "PARCEL_ID", "FILE_T", "ASMNT_YR", "DOR_UC", "PA_UC", "JV", "LND_VAL", "LND_SQFOOT", "TOT_LVG_AREA",
    "NO_BULDNG", "NO_RES_UNTS", "ACT_YR_BLT", "EFF_YR_BLT",
    "QUAL_CD1", "SALE_PRC1", "SALE_YR1", "SALE_MO1", "QUAL_CD2", "SALE_PRC2", "SALE_YR2", "SALE_MO2",
    "OWN_NAME", "OWN_ADDR1", "OWN_ADDR2", "OWN_CITY", "OWN_STATE", "OWN_ZIPCD", "S_LEGAL",
    "PHY_ADDR1", "PHY_ADDR2", "PHY_CITY", "PHY_ZIPCD",
]
SDF_COLUMNS = ["CO_NO", "PARCEL_ID", "ASMNT_YR", "DOR_UC", "QUAL_CD", "SALE_YR", "SALE_MO", "SALE_PRC", "OR_BOOK", "OR_PAGE"]


def emit_raw(records: list[dict], raw_dir: Path, rng: random.Random) -> None:
    """Write NAL/SDF CSVs per county + one statewide-style parcel GeoJSON (dashed IDs)."""
    from pa2.tiler import geojson_geometry

    raw_dir.mkdir(parents=True, exist_ok=True)
    blank = lambda v: "" if v is None else v  # noqa: E731
    for co in (53, 60, 66):
        rs = [r for r in records if r["county_code"] == co]
        with (raw_dir / f"NAL{co}F{TAX_ROLL_YEAR}01.csv").open("w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(NAL_COLUMNS)
            with (raw_dir / f"SDF{co}F{TAX_ROLL_YEAR}01.csv").open("w", newline="") as sfh:
                sw = csv.writer(sfh)
                sw.writerow(SDF_COLUMNS)
                for r in rs:
                    s1 = (r["last_sale_qual_cd"], r["last_sale_price"], r["last_sale_year"], r["last_sale_month"])
                    s2 = (None, None, None, None)
                    if r["_prev_sale"]:
                        pp, py, pm, pq = r["_prev_sale"]
                        s2 = (pq, pp, py, pm)
                    recent = r["last_sale_year"] is not None and r["last_sale_year"] >= 2024
                    if recent:
                        sw.writerow([co, r["parcel_id"], TAX_ROLL_YEAR, r["use_code"], r["last_sale_qual_cd"],
                                     r["last_sale_year"], r["last_sale_month"], r["last_sale_price"],
                                     rng.randint(3000, 4200), rng.randint(1, 2900)])
                        if rng.random() < 0.5:
                            # NAL not yet updated with the newest sale: pipeline must take it from SDF.
                            s1, s2 = s2, (None, None, None, None)
                    uc = r["use_code"]
                    w.writerow([
                        co, r["parcel_id"], "R", TAX_ROLL_YEAR, uc, f"{uc}00", r["just_value"], r["land_value"],
                        r["lnd_sqfoot"], r["tot_lvg_area"], r["no_buldng"], r["no_res_unts"],
                        blank(r["act_yr_blt"]) or 0, blank(r["eff_yr_blt"]) or 0,
                        *(blank(v) for v in s1), *(blank(v) for v in s2),
                        r["owner_name"], r["owner_addr1"], r["owner_addr2"], r["owner_city"], r["owner_state"],
                        r["owner_zip"], r["legal_desc"], r["site_address"], "", r["site_city"], r["site_zip"],
                    ])
    fc = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature",
             "properties": {"CO_NO": r["county_code"], "PARCEL_ID": dashed_pid(r["parcel_id"], r["county_code"])},
             "geometry": geojson_geometry(r["geometry"], 7)}
            for r in records
        ],
    }
    (raw_dir / "parcels_statewide_sample.geojson").write_text(json.dumps(fc), encoding="utf-8")
    print(f"raw FDOR-format files -> {raw_dir}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=WEB_DATA_DIR, help="output directory (default: web/public/data)")
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--tiler", choices=["auto", "tippecanoe", "python", "none"], default="auto")
    ap.add_argument("--emit-raw", type=Path, default=None, help="also write FDOR-format NAL/SDF/GIS test inputs here")
    args = ap.parse_args()

    records = generate(args.seed)
    n_sponsor = sum(1 for r in records if r.get("_sponsor"))
    print(f"generated {len(records)} synthetic parcels ({n_sponsor} in {len(SPONSORS)} sponsor portfolios)")
    if args.emit_raw:
        emit_raw(records, args.emit_raw, random.Random(args.seed + 1))

    manifest = publish(
        records,
        args.out,
        source_kind="sample",
        source_label="Synthetic sample data",
        attribution=ATTRIBUTION_SAMPLE,
        tax_roll_year=TAX_ROLL_YEAR,
        as_of_year=AS_OF_YEAR,
        shard_hex=1,
        tiler=args.tiler,
        write_geojson=True,
        work_dir=OUT_DIR / "sample",
    )
    s = manifest["stats"]
    print(f"published {s['parcels']} parcels, ${s['just_value'] / 1e9:.2f}B just value -> {args.out}")
    for c in manifest["counties"]:
        print(f"  {c['code']} {c['name']:<11} {c['count']:>4} parcels  ${c['jv'] / 1e9:.2f}B")
    print(f"  tiles: {manifest['tiles']['format']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
