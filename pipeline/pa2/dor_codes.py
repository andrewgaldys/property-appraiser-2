"""FDOR Department of Revenue land-use codes (DOR_UC) and asset-class mapping.

DOR_UC is the statewide 2-digit use code (stored as 3 characters, e.g. "003")
defined in Rule 12D-8.008, F.A.C. Counties also publish their own PA_UC codes;
the pipeline only relies on DOR_UC so all three counties classify identically.
"""

from __future__ import annotations

import re

DOR_USE_CODES: dict[str, str] = {
    "000": "Vacant Residential",
    "001": "Single Family",
    "002": "Mobile Home",
    "003": "Multifamily (10+ units)",
    "004": "Condominium",
    "005": "Cooperative",
    "006": "Retirement Home (non-exempt)",
    "007": "Misc. Residential (boarding/migrant)",
    "008": "Multifamily (2-9 units)",
    "009": "Residential Common Elements",
    "010": "Vacant Commercial",
    "011": "Stores, One Story",
    "012": "Mixed Use (Store/Office/Residential)",
    "013": "Department Store",
    "014": "Supermarket",
    "015": "Regional Shopping Center",
    "016": "Community Shopping Center",
    "017": "Office, One Story",
    "018": "Office, Multi-Story",
    "019": "Professional / Medical Office",
    "020": "Airport / Marina / Terminal",
    "021": "Restaurant / Cafeteria",
    "022": "Drive-In Restaurant",
    "023": "Financial Institution",
    "024": "Insurance Company Office",
    "025": "Repair Service Shop",
    "026": "Service Station",
    "027": "Auto Sales / Repair / Storage",
    "028": "Parking Lot / Mobile Home Park",
    "029": "Wholesale Outlet / Produce House",
    "030": "Florist / Greenhouse",
    "031": "Drive-In Theater / Open Stadium",
    "032": "Enclosed Theater / Auditorium",
    "033": "Nightclub / Bar",
    "034": "Bowling Alley / Rink / Arena",
    "035": "Tourist Attraction",
    "036": "Camp",
    "037": "Race Track",
    "038": "Golf Course / Driving Range",
    "039": "Hotel / Motel",
    "040": "Vacant Industrial",
    "041": "Light Manufacturing",
    "042": "Heavy Industrial",
    "043": "Lumber Yard / Mill",
    "044": "Packing Plant",
    "045": "Cannery / Bottler / Brewery",
    "046": "Food Processing",
    "047": "Mineral Processing",
    "048": "Warehouse / Distribution",
    "049": "Open Storage",
    "050": "Improved Agricultural",
    "051": "Cropland, Class I",
    "052": "Cropland, Class II",
    "053": "Cropland, Class III",
    "054": "Timberland, Index 90+",
    "055": "Timberland, Index 80-89",
    "056": "Timberland, Index 70-79",
    "057": "Timberland, Index 60-69",
    "058": "Timberland, Index 50-59",
    "059": "Timberland, Unclassified",
    "060": "Grazing Land, Class I",
    "061": "Grazing Land, Class II",
    "062": "Grazing Land, Class III",
    "063": "Grazing Land, Class IV",
    "064": "Grazing Land, Class V",
    "065": "Grazing Land, Class VI",
    "066": "Orchard / Grove",
    "067": "Poultry / Bees / Fish",
    "068": "Dairy / Feed Lot",
    "069": "Ornamentals / Misc. Agricultural",
    "070": "Vacant Institutional",
    "071": "Church",
    "072": "Private School / College",
    "073": "Private Hospital",
    "074": "Home for the Aged",
    "075": "Non-Profit / Charitable Service",
    "076": "Mortuary / Cemetery",
    "077": "Club / Lodge / Union Hall",
    "078": "Sanitarium / Rest Home",
    "079": "Cultural Organization",
    "080": "Vacant Governmental",
    "081": "Military",
    "082": "Forest / Park / Recreation",
    "083": "Public School",
    "084": "College (Public)",
    "085": "Hospital (Public)",
    "086": "County Government",
    "087": "State Government",
    "088": "Federal Government",
    "089": "Municipal Government",
    "090": "Leasehold Interest",
    "091": "Utility",
    "092": "Mining / Petroleum / Gas Land",
    "093": "Subsurface Rights",
    "094": "Right-of-Way",
    "095": "Rivers / Lakes / Submerged Land",
    "096": "Waste Land / Marsh / Swamp",
    "097": "Outdoor Recreational / Parkland",
    "098": "Centrally Assessed",
    "099": "Acreage, Non-Agricultural",
}

# asset_class code -> (label, use_category). Order = order of filter chips in the UI;
# the first five are the investment classes the filter bar always shows.
ASSET_CLASSES: dict[str, tuple[str, str]] = {
    "MF10": ("Multifamily 10+ Units", "Multifamily"),
    "MF2_9": ("Multifamily 2-9 Units", "Multifamily"),
    "COM": ("Retail / Commercial", "Commercial/Retail"),
    "IND": ("Industrial", "Industrial"),
    "VAC_COM": ("Vacant Commercial", "Vacant Land"),
    "SFR": ("Single Family", "Single Family"),
    "CONDO": ("Condo / Co-op", "Residential"),
    "RES_OTH": ("Other Residential", "Residential"),
    "VAC_RES": ("Vacant Residential", "Vacant Land"),
    "AG": ("Agricultural", "Agricultural"),
    "INST": ("Institutional", "Institutional"),
    "GOV": ("Government", "Government"),
    "OTHER": ("Other", "Other"),
}
PRIMARY_CLASSES = ("MF10", "MF2_9", "COM", "IND", "VAC_COM")

_DIGITS = re.compile(r"\D+")


def normalize_use_code(raw: object) -> str | None:
    """'3', '03', '003', 3.0 -> '003'. Returns None for blanks / non-DOR codes."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or s.lower() == "nan":
        return None
    if s.endswith(".0"):
        s = s[:-2]
    digits = _DIGITS.sub("", s)
    if not digits:
        return None
    n = int(digits)
    if n > 99:
        return None
    return f"{n:03d}"


def classify(use_code: str | None) -> str:
    """Map a 3-digit DOR use code to an asset_class code."""
    if use_code is None:
        return "OTHER"
    n = int(use_code)
    if n == 3:
        return "MF10"
    if n == 8:
        return "MF2_9"
    if n in (10, 40):
        return "VAC_COM"
    if 11 <= n <= 39:
        return "COM"
    if 41 <= n <= 49:
        return "IND"
    if n == 0:
        return "VAC_RES"
    if n == 1:
        return "SFR"
    if n in (4, 5):
        return "CONDO"
    if n in (2, 6, 7, 9):
        return "RES_OTH"
    if 50 <= n <= 69:
        return "AG"
    if 70 <= n <= 79:
        return "INST"
    if 80 <= n <= 89:
        return "GOV"
    return "OTHER"


def describe(use_code: str | None) -> str:
    if use_code is None:
        return "Unknown"
    return DOR_USE_CODES.get(use_code, f"DOR {use_code}")
