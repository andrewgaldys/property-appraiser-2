"""For-sale and for-lease listings, matched to parcels and published beside the parcel bundle.

Listings are not public records. Nothing here fetches them: this module reads files you have the
right to publish (your own listings, an MLS feed under your membership, a licensed vendor's export),
matches each row to a parcel by parcel ID or street address, and writes `listings/` next to
`manifest.json` for the parcel panel's "Listings" section.

Rules that keep the section honest:
  - a row is published only when it matches a parcel without guessing: several parcels with
    different owners at one address is "ambiguous" and goes to the report instead;
  - closed, expired and withdrawn rows are dropped, never shown as available;
  - a missing price, rent basis or scope stays missing (the panel says so) and is never inferred;
  - every listing keeps its source and the date it was last updated there.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import shutil
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

from .util import clean_str, is_blank, norm_parcel_id, pid_shard, zip5

SCHEMA = "pa2-listings/1"
OUT_DIRNAME = "listings"

# One published listing, as a row in listings/<shard>.json (see web/src/listings.ts).
LISTING_FIELDS = [
    "id", "src", "kind", "sub", "scope", "space", "status", "title", "use",
    "price", "price_max", "basis", "terms", "price_note", "sf", "sf_min", "ac", "units", "cap", "noi",
    "firm", "agent", "phone", "email", "url", "listed", "updated", "note", "match", "group", "also",
]
# When several sources carry the same offering, the card shows the first of these, untouched, and
# names the others beside it ("also": [source, link, updated] each). Data is never mixed across sources.
SOURCE_PRIORITY = {"own": 0, "mls": 1, "vendor": 2, "other": 3}
SOURCE_KINDS = ("own", "mls", "vendor", "other")
# listings/index.json "parcels" values: which kinds of listing a parcel has, and whether every one
# of them is only known to be "at this address" (see match_address, "shared").
FLAG_SALE, FLAG_LEASE, FLAG_SHARED_ONLY = 1, 2, 4
# A listing matched by address that spans more same-owner parcels than this is left to the report.
MAX_GROUP = 25
# Parcels with different owners at one street address (office and warehouse condos): a listing there
# is shown on each of them, marked "at this address", up to this many parcels.
MAX_SHARED = 60
# An address match further than this from the listing's own coordinates is not trusted.
MAX_ADDRESS_DRIFT_M = 1500
# House-number ranges ("5861-5869 NW 19 ST") are indexed number by number up to this span.
MAX_RANGE_SPAN = 400

# ------------------------------------------------------------------------------------------------
# Street addresses
# ------------------------------------------------------------------------------------------------

_DIRS = {
    "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W",
    "NORTHEAST": "NE", "NORTHWEST": "NW", "SOUTHEAST": "SE", "SOUTHWEST": "SW",
}
_DIR_SET = set(_DIRS.values())
_SUFFIX = {
    "STREET": "ST", "AVENUE": "AVE", "AV": "AVE", "BOULEVARD": "BLVD", "BLV": "BLVD", "DRIVE": "DR",
    "ROAD": "RD", "COURT": "CT", "HIGHWAY": "HWY", "HW": "HWY", "TERRACE": "TER", "TERR": "TER",
    "PLACE": "PL", "LANE": "LN", "TRAIL": "TRL", "PARKWAY": "PKWY", "PKY": "PKWY", "CIRCLE": "CIR",
    "WY": "WAY", "SQUARE": "SQ", "PLAZA": "PLZ", "CAUSEWAY": "CSWY", "EXPRESSWAY": "EXPY",
    "POINT": "PT", "POINTE": "PT", "COVE": "CV", "CROSSING": "XING", "ALLEY": "ALY", "TURNPIKE": "TPKE",
}
# Tokens that end a street name: what follows one is a suite or unit, not part of the street.
_TERMINAL = set(_SUFFIX.values()) | {"WAY", "ROW", "WALK", "PATH", "LOOP", "PASS", "RUN"}
_WORDS = {"SAINT": "ST", "FORT": "FT", "MOUNT": "MT", "BEACH": "BCH", "ALTERNATE": "ALT"}
_UNIT_LABEL = {
    "UNIT": "Unit", "#": "Unit", "NO": "Unit", "STE": "Suite", "SUITE": "Suite", "APT": "Apt",
    "APARTMENT": "Apt", "BLDG": "Bldg", "BUILDING": "Bldg", "BAY": "Bay", "SPACE": "Space", "SPC": "Space",
    "RM": "Room", "ROOM": "Room", "FL": "Floor", "FLOOR": "Floor", "OFFICE": "Office", "OFC": "Office",
    "LOT": "Lot",
}
_UNIT_PREFIX = re.compile(r"^(?:(?:UNIT|STE|SUITE|APT|APARTMENT|BLDG|BUILDING|BAY|SPACE|SPC|RM|ROOM|OFFICE|OFC|LOT|NO)\b\.?|#)\s*", re.I)
# ", Suite 200" / ", #4" after a street address (but not ", Bay Harbor Islands" or ", FL 33130").
_UNIT_PART = re.compile(r"^(?:(?:UNIT|STE|SUITE|APT|APARTMENT|BLDG|BUILDING|BAY|SPACE|RM|ROOM|FLOOR|OFFICE)\.?\s+|#\s*)(?=[0-9A-Z-]*\d|[A-Z]{1,2}$)[0-9A-Z-]{1,8}$", re.I)
_ORDINAL = re.compile(r"^(\d+)(ST|ND|RD|TH)$")
_ROUTE_NO = re.compile(r"^\d+[A-Z]?$")
_UNITISH = re.compile(r"^(?:[A-Z]|[A-Z]{0,4}-?\d[0-9A-Z/-]{0,7})$")
_LEAD = re.compile(r"^(\d+)([A-Z])?(?:\s*-\s*(\d+)[A-Z]?)?(?:\s+#\s*([0-9A-Z-]+))?(?:\s+\d+/\d+)?\s+(.+)$")
_HIGHWAYS = (
    (re.compile(r"\bU ?S ?(?:HIGHWAY|HWY|HW|ROUTE|RTE)? ?-? ?(\d+[A-Z]?)\b"), r"US \1"),
    (re.compile(r"\b(?:STATE (?:ROAD|RD|ROUTE|RTE|HIGHWAY|HWY)|S ?R) ?-? ?(\d+[A-Z]?)\b"), r"SR \1"),
    (re.compile(r"\b(?:COUNTY (?:ROAD|RD|HIGHWAY|HWY)|C ?R) ?-? ?(\d+[A-Z]?)\b"), r"CR \1"),
    (re.compile(r"\b(?:(?:STATE (?:ROAD|RD)|S ?R|HIGHWAY|HWY) )?A ?-?1 ?-?A\b"), "A1A"),
)
_NOT_A_PLACE = re.compile(r"\b(COUNTY|UNINCORPORATED)\b")
_STATE_ZIP = re.compile(r"\b(?:FL|FLA|FLORIDA)\b\.?\s*(\d{5})?(?:-\d{4})?\s*$", re.I)


@dataclass(frozen=True)
class Address:
    """A street address split for matching. Empty when there is no house number to match on."""

    street: str = ""
    numbers: tuple[int, ...] = ()
    unit: str = ""
    unit_label: str = ""

    @property
    def ok(self) -> bool:
        return bool(self.street and self.numbers)


def _norm_unit(text: str) -> str:
    """'208-B' -> '208B', '0140' -> '140': how a suite or unit is compared."""
    return re.sub(r"[^0-9A-Z]", "", text.upper()).lstrip("0")


def _unit_label(tokens: list[str]) -> str:
    """['STE', '200'] -> 'Suite 200'; ['4B'] -> 'Unit 4B'."""
    out = [_UNIT_LABEL.get(t, t) for t in tokens]
    if out and out[0] not in set(_UNIT_LABEL.values()):
        out.insert(0, "Unit")
    return " ".join(out)


def parse_address(value: object) -> Address:
    """Normalize a street address so the tax rolls and a listing file can be compared.

    '2608-2610 NE 10th Terrace'     -> street 'NE 10 TER', numbers (2608, 2610)
    '3319 S State Road 7, Unit 103' -> street 'S SR 7', numbers (3319,), unit '103'
    '509 SE RIVERSIDE DR 100'       -> street 'SE RIVERSIDE DR', unit '100' (a bare trailing number)
    '2300 6TH DR SW'                -> street '6 DR SW'
    '100 AVENUE D'                  -> street 'AVE D' (a suffix with no name before it is the name)
    Addresses without a house number ('NE 6 ST', 'TBD') come back empty: they cannot be matched.
    """
    s = clean_str(value).upper()
    if not s:
        return Address()
    s = re.sub(r"[.,'`]", "", s).replace("#", " # ")
    s = re.sub(r"[()]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    m = _LEAD.match(s)
    if not m:
        return Address()
    first, letter, last, hash_unit, rest = m.groups()
    numbers = [int(first)]
    range_unit = ""
    if last:
        if 2 <= len(last) < len(first):  # "5861-69"
            last = first[: len(first) - len(last)] + last
        if int(last) > int(first):
            numbers.append(int(last))
        elif int(last) < int(first):
            range_unit = m.group(3)  # "100-2 MAIN ST": unit 2
    for pat, repl in _HIGHWAYS:
        rest = pat.sub(repl, rest)

    tokens: list[str] = []
    for t in rest.split():
        o = _ORDINAL.match(t)
        if o:
            t = o.group(1)
        tokens.append(_DIRS.get(t) or _SUFFIX.get(t) or _WORDS.get(t) or t)

    # Where the street name ends: the last suffix that has a name before it, or a highway number.
    end = -1
    for i, t in enumerate(tokens):
        named = any(x not in _DIR_SET for x in tokens[:i])
        if t == "A1A" or (t in _TERMINAL and named):
            end = i
        elif t in ("US", "SR", "CR") and i + 1 < len(tokens) and _ROUTE_NO.match(tokens[i + 1]):
            end = max(end, i + 1)
        elif t == "HWY" and not named and i + 1 < len(tokens) and _ROUTE_NO.match(tokens[i + 1]):
            end = max(end, i + 1)  # "N HWY 27", but not "FEDERAL HWY 5" (unit 5)

    street, tail = tokens, []
    if end >= 0:
        stop = end + 1
        if stop < len(tokens) and tokens[stop] in _DIR_SET:  # "6 DR SW"
            stop += 1
        street, tail = tokens[:stop], tokens[stop:]
    else:
        for i in range(len(tokens) - 1, 0, -1):
            if tokens[i] in ("UNIT", "STE", "SUITE", "APT", "#", "BLDG"):
                street, tail = tokens[:i], tokens[i:]
                break

    unit_tokens = [t for t in tail if t not in _UNIT_LABEL]
    explicit = len(unit_tokens) < len(tail)
    if tail and not (unit_tokens and len(unit_tokens) <= 3 and (explicit or all(_UNITISH.match(t) for t in unit_tokens))):
        # The tail does not read as a unit ("100 ST LUCIE"): keep it in the street name.
        street, tail, unit_tokens = tokens, [], []
    unit_raw = " ".join(unit_tokens) or hash_unit or range_unit or letter or ""
    label = _unit_label(tail) if tail else (f"Unit {unit_raw}" if unit_raw else "")
    if not street:
        return Address()
    return Address(" ".join(street), tuple(numbers), _norm_unit(unit_raw), label)


def split_full_address(text: str) -> tuple[str, str, str]:
    """'123 Main St, Suite 200, Miami, FL 33130' -> ('123 Main St Suite 200', 'Miami', '33130').

    A plain street address comes back unchanged with no city or ZIP.
    """
    parts = [p.strip() for p in clean_str(text).split(",") if p.strip()]
    if len(parts) < 2:
        return clean_str(text), "", ""
    street, rest = parts[0], parts[1:]
    while rest and _UNIT_PART.match(rest[0]):
        street += " " + rest.pop(0)
    city = zip_code = ""
    if rest:
        tail = " ".join(rest)
        m = _STATE_ZIP.search(tail)
        if m:
            zip_code = m.group(1) or ""
            tail = tail[: m.start()].strip()
        else:
            z = re.search(r"\b(\d{5})(?:-\d{4})?\s*$", tail)
            if z:
                zip_code, tail = z.group(1), tail[: z.start()].strip()
        city = tail
    return street, city, zip_code


def norm_place(value: object) -> str:
    """City names as compared: 'Port Saint Lucie' = 'PORT ST LUCIE'; 'Unincorporated County' -> ''."""
    s = re.sub(r"[^A-Z0-9 ]", " ", clean_str(value).upper())
    s = re.sub(r"\s+", " ", s).strip()
    if not s or _NOT_A_PLACE.search(s):
        return ""
    return " ".join(_WORDS.get(t, t) for t in s.split())


def _range_numbers(numbers: tuple[int, ...]) -> list[tuple[int, bool]]:
    """(house number, exact?) for one parcel: both ends of a range are exact, the numbers between are not."""
    if len(numbers) < 2:
        return [(n, True) for n in numbers]
    lo, hi = sorted(numbers[:2])
    out = [(lo, True), (hi, True)]
    if hi - lo <= MAX_RANGE_SPAN:
        step = 2 if (hi - lo) % 2 == 0 else 1
        out += [(n, False) for n in range(lo + step, hi, step)]
    return out


# ------------------------------------------------------------------------------------------------
# The parcels a listing can match
# ------------------------------------------------------------------------------------------------


@dataclass
class Parcel:
    pid: str
    county: int
    addr: str
    city: str
    zip: str
    owner_key: int | None
    jv: float | None
    lon: float
    lat: float
    unit: str = ""


class ParcelLookup:
    """Parcels of the published bundle, by parcel ID and by normalized street address."""

    def __init__(self, parcels: list[Parcel], county_names: dict[int, str] | None = None):
        self.by_pid: dict[str, Parcel] = {p.pid: p for p in parcels}
        self.by_addr: dict[tuple[int, str], list[tuple[Parcel, bool]]] = defaultdict(list)
        self.county_names = county_names or {}
        self._pid_lengths = sorted({len(p.pid) for p in parcels})
        for p in parcels:
            a = parse_address(p.addr)
            if not a.ok:
                continue
            p.unit = a.unit
            for number, exact in _range_numbers(a.numbers):
                self.by_addr[(number, a.street)].append((p, exact))

    @classmethod
    def from_bundle(cls, data_dir: Path) -> "ParcelLookup":
        """Read the parcels from the published bundle (index.json + manifest.json)."""
        index_path = data_dir / "index.json"
        if not index_path.is_file():
            raise FileNotFoundError(f"{index_path} not found: build the parcel bundle first (see README)")
        ix = json.loads(index_path.read_text(encoding="utf-8"))
        col = {name: i for i, name in enumerate(ix["fields"])}
        cities = ix.get("cities", [])
        parcels = [
            Parcel(
                pid=r[col["pid"]], county=r[col["co"]], addr=r[col["addr"]] or "",
                city=norm_place(cities[r[col["city"]]]) if r[col["city"]] is not None and r[col["city"]] >= 0 else "",
                zip=(r[col["zip"]] or "")[:5], owner_key=r[col["onk"]], jv=r[col["jv"]],
                lon=r[col["lon"]], lat=r[col["lat"]],
            )
            for r in ix["rows"]
        ]
        names: dict[int, str] = {}
        manifest = data_dir / "manifest.json"
        if manifest.is_file():
            for c in json.loads(manifest.read_text(encoding="utf-8")).get("counties", []):
                names[int(c["code"])] = str(c["name"])
        return cls(parcels, names)

    @staticmethod
    def _county_key(text: str) -> str:
        s = re.sub(r"[^A-Z0-9 ]", " ", text.upper())
        return " ".join(_WORDS.get(t, t) for t in s.split() if t != "COUNTY")

    def county_code(self, value: object) -> int | None:
        """'Broward', 'Broward County', 'St. Lucie', 16 -> the county code; None when blank or not in this bundle."""
        s = self._county_key(clean_str(value))
        if not s:
            return None
        if s.isdigit() and int(s) in self.county_names:
            return int(s)
        for code, name in self.county_names.items():
            if self._county_key(name) == s:
                return code
        return None

    def find_pid(self, raw: str, county: int | None) -> Parcel | None:
        """A parcel by ID as typed: dashes and spaces ignored, zeros lost to a spreadsheet restored."""
        pid = norm_parcel_id(raw)
        if not pid:
            return None
        hit = self.by_pid.get(pid)
        if hit:
            return hit if county is None or hit.county == county else None
        candidates = {pid.zfill(n) for n in self._pid_lengths if n > len(pid)}
        if len(pid) == 21 and pid.endswith("0"):
            candidates.add(pid[:-1])  # Indian River: a ".0" check digit is not kept
        hits = [self.by_pid[c] for c in candidates if c in self.by_pid]
        hits = [h for h in hits if county is None or h.county == county]
        return hits[0] if len(hits) == 1 else None


def _metres(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    rad = math.pi / 180
    a = math.sin((lat2 - lat1) * rad / 2) ** 2 + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin((lon2 - lon1) * rad / 2) ** 2
    return 6_371_000 * 2 * math.asin(math.sqrt(a))


@dataclass
class Match:
    parcels: list[Parcel] = field(default_factory=list)
    how: str = ""  # pid | addr | range | shared (the address, but not which of its parcels)
    reason: str = ""  # why not, when parcels is empty
    candidates: list[str] = field(default_factory=list)


def match_address(lookup: ParcelLookup, addr: Address, *, city: str, zip_code: str, county: int | None,
                  unit: str, lon: float | None, lat: float | None) -> Match:
    """The parcel (or same-owner parcels) at a street address.

    Never a guess between different owners: when several owners' parcels share the address and no
    unit settles it, the match is "shared" (all of them, marked as such) or nothing at all.
    """
    if not addr.ok:
        return Match(reason="no street address with a house number")
    found: list[tuple[Parcel, bool]] = []
    for number in addr.numbers:
        found += lookup.by_addr.get((number, addr.street), [])
    if not found:
        return Match(reason="no parcel has this street address")
    if county is not None:
        found = [f for f in found if f[0].county == county]
        if not found:
            return Match(reason="no parcel has this street address in that county")

    # Where: the ZIP decides, then the city. With neither to go on, the address must be the only one.
    by_zip = [f for f in found if zip_code and f[0].zip == zip_code]
    by_city = [f for f in found if city and f[0].city == city]
    if by_zip:
        pool = by_zip
    elif by_city:
        pool = by_city
    else:
        ids = [f[0].pid for f in found[:8]]
        places = {(f[0].zip, f[0].city, f[0].county) for f in found}
        if (zip_code or city) and any(f[0].zip or f[0].city for f in found):
            where = ", ".join(sorted({f"{f[0].city.title() or '?'} {f[0].zip}".strip() for f in found})[:4])
            return Match(reason=f"this street address is on record only elsewhere ({where})", candidates=ids)
        if len(places) > 1:
            return Match(reason="this street address exists in several places: add a ZIP code, city or parcel ID", candidates=ids)
        pool = found

    exact = [p for p, is_exact in pool if is_exact]
    how = "addr" if exact else "range"
    parcels = list({p.pid: p for p in (exact or [p for p, _ in pool])}.values())

    if unit:
        same_unit = [p for p in parcels if p.unit == unit]
        if same_unit:
            parcels = same_unit
    chosen: list[Parcel] | None = None
    if len(parcels) > 1:
        no_unit = [p for p in parcels if not p.unit]
        if len(no_unit) == 1:
            chosen = no_unit  # the building's own parcel among its unit parcels
    if chosen is None:
        owners = {p.owner_key for p in parcels}
        if len(parcels) == 1 or (len(owners) == 1 and None not in owners and len(parcels) <= MAX_GROUP):
            chosen = parcels
    if chosen is None:
        if len(parcels) > MAX_SHARED:
            return Match(reason=f"{len(parcels)} parcels with different owners share this address: add the parcel ID or the unit",
                         candidates=[p.pid for p in parcels[:8]])
        chosen, how = parcels, "shared"
    if lon is not None and lat is not None:
        drift = min(_metres(lon, lat, p.lon, p.lat) for p in chosen)
        if drift > MAX_ADDRESS_DRIFT_M:
            return Match(reason=f"the address matches a parcel {drift / 1000:.1f} km from the listing's own coordinates",
                         candidates=[p.pid for p in chosen[:8]])
    return Match(parcels=chosen, how=how)


# ------------------------------------------------------------------------------------------------
# Reading listing files
# ------------------------------------------------------------------------------------------------

# Column names a file may use for each field (compared lowercase, letters and digits only). The
# RESO Data Dictionary names an MLS feed returns are among them, so a saved API response reads too.
ALIASES: dict[str, tuple[str, ...]] = {
    "id": ("id", "listingid", "listingkey", "listingnumber", "mlsnumber", "mlsid", "mls"),
    "parcel_id": ("parcelid", "parcelids", "parcelnumber", "parcel", "folio", "folionumber", "pcn", "apn", "taxid", "taxparcelid"),
    "county": ("county", "countyorparish"),
    "address": ("address", "streetaddress", "unparsedaddress", "siteaddress", "propertyaddress", "fulladdress", "location"),
    "city": ("city", "municipality"),
    "zip": ("zip", "zipcode", "postalcode", "zip5"),
    "space": ("space", "spacename", "suite", "unit", "unitnumber", "suitenumber"),
    "type": ("type", "listingtype", "transactiontype", "saleorlease", "kind", "offering", "saletype", "forsaleorlease"),
    "property_type": ("propertytype",),
    "scope": ("scope", "offered", "wholeorpart"),
    "status": ("status", "standardstatus", "mlsstatus", "listingstatus", "availability"),
    "price": ("price", "listprice", "askingprice", "asking", "saleprice", "rent", "askingrent", "rate", "leaserate", "rentalrate"),
    "price_max": ("pricemax", "maxprice", "ratemax", "maxrate", "maxleaserate", "maxrent"),
    "basis": ("basis", "rentbasis", "priceunit", "priceunits", "rateunit", "rentunit", "ratetype", "per", "leaseamountfrequency", "rentfrequency"),
    "terms": ("terms", "leasetype", "leaseterms", "expenses", "servicetype", "netlease"),
    "sf": ("sf", "size", "sizesf", "squarefeet", "sqft", "buildingsf", "buildingareatotal", "availablesf", "spacesf",
           "rentablearea", "leasablearea", "livingarea", "gla", "rsf"),
    "sf_min": ("sfmin", "minsf", "mindivisible", "minimumdivisible", "divisibleto"),
    "ac": ("acres", "ac", "lotsizeacres", "landacres", "lotacres"),
    "lot_sf": ("lotsizesquarefeet", "lotsf", "landsf"),
    "units": ("units", "numberofunits", "numberofunitstotal", "unitcount"),
    "cap": ("caprate", "cap"),
    "noi": ("noi", "netoperatingincome"),
    "use": ("use", "propertysubtype", "subtype", "assettype", "assetclass", "propertyuse", "category"),
    "title": ("title", "headline", "name", "propertyname", "listingtitle"),
    "note": ("note", "notes", "remarks", "publicremarks", "description", "comments", "highlights"),
    "firm": ("firm", "brokerage", "company", "office", "listofficename", "listingoffice", "listingfirm", "brokeragename"),
    "agent": ("agent", "broker", "listingagent", "listagentfullname", "contact", "contactname", "listingbroker"),
    "phone": ("phone", "agentphone", "contactphone", "listagentdirectphone", "listagentpreferredphone", "listofficephone"),
    "email": ("email", "agentemail", "listagentemail", "contactemail"),
    "url": ("url", "link", "listingurl", "weblink", "website", "listinglink"),
    "listed": ("listed", "listdate", "datelisted", "onmarketdate", "listingcontractdate", "dateonmarket"),
    "updated": ("updated", "lastupdated", "modified", "modificationtimestamp", "asof", "lastverified", "dateupdated"),
    "lat": ("lat", "latitude"),
    "lon": ("lon", "lng", "long", "longitude"),
    "source": ("source", "datasource"),
}
# Street address pieces, when a file has no single address column (RESO).
_ADDRESS_PARTS = ("streetnumber", "streetdirprefix", "streetname", "streetsuffix", "streetdirsuffix")
_KEY = re.compile(r"[^a-z0-9]")

INACTIVE = re.compile(r"\b(CLOSED|SOLD|LEASED|RENTED|EXPIRED|WITHDRAWN|CANCELL?ED|OFF[ -]?MARKET|HOLD|DELETED?|INCOMPLETE|TERMINATED|INACTIVE)\b")
PENDING = re.compile(r"\b(PENDING|UNDER CONTRACT|CONTINGENT|IN CONTRACT|LOI|BACKUP)\b")
_MONEY = re.compile(r"\$?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*(K|MM|M|B)?\b", re.I)
_DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d", "%m-%d-%Y", "%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y", "%Y%m%d")
_EMAIL = re.compile(r"^[^@\s<>\"']+@[^@\s<>\"']+\.[A-Za-z]{2,}$")
_LIMITS = {"title": 140, "note": 400, "firm": 90, "agent": 90, "phone": 40, "space": 48, "use": 60, "terms": 48,
           "sub": 40, "price_note": 70, "id": 64}


def read_rows(path: Path) -> list[dict]:
    """Rows of a listing file as dicts. CSV (comma, tab, semicolon or pipe) or JSON: a list of
    objects, or an object holding one under "value" (RESO Web API), "listings", "results" or "data"."""
    if path.suffix.lower() == ".json":
        doc = json.loads(path.read_text(encoding="utf-8-sig"))
        if isinstance(doc, dict):
            doc = next((doc[k] for k in ("value", "listings", "results", "data", "items") if isinstance(doc.get(k), list)), None)
        if not isinstance(doc, list):
            raise ValueError(f"{path.name}: expected a list of listings")
        return [r for r in doc if isinstance(r, dict)]
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    header = text.split("\n", 1)[0]
    delimiter = max(",\t;|", key=header.count)
    return [dict(r) for r in csv.DictReader(io.StringIO(text, newline=""), delimiter=delimiter)]


def _pick(row: dict[str, object], name: str, *, raw: bool = False) -> str:
    """The first non-blank value among a field's column names, whitespace collapsed (kept as typed when `raw`)."""
    for alias in ALIASES[name]:
        v = row.get(alias)
        if not is_blank(v):
            return str(v) if raw else clean_str(v)
    return ""


def _number(text: str) -> float | None:
    """'$4,250,000' -> 4250000 · '4.25M' -> 4250000 · '13,600 SF' -> 13600. None when there is no number."""
    m = _MONEY.search(text.replace("(", " ").replace(")", " "))
    if not m:
        return None
    n = float(m.group(1).replace(",", ""))
    return n * {"K": 1e3, "M": 1e6, "MM": 1e6, "B": 1e9}.get((m.group(2) or "").upper(), 1)


def _basis(text: str) -> str:
    """How a price is quoted: per SF (sf_yr, sf_mo, or sf with no period stated), per acre (ac_yr,
    ac_mo, ac), or a flat amount per month or year (mo, yr). '' when the text does not say."""
    t = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", text).upper().replace("_", " ")  # sfYear, sf_year
    t = re.sub(r"[^A-Z/]", " ", t)
    per_sf = bool(re.search(r"\b(SF|PSF|SQ ?FT|SQUARE F(OO|EE)T|RSF)\b", t))
    per_ac = bool(re.search(r"\b(AC|ACRE|ACRES)\b", t))
    monthly = bool(re.search(r"\b(MO|MONTH|MONTHLY|MTH)\b", t))
    yearly = bool(re.search(r"\b(YR|YEAR|YEARLY|ANNUAL|ANNUALLY|ANNUM)\b", t))
    if per_sf or per_ac:
        unit = "sf" if per_sf else "ac"
        return f"{unit}_mo" if monthly and not yearly else f"{unit}_yr" if yearly else unit
    if monthly:
        return "mo"
    if yearly:
        return "yr"
    return ""


def _lease_terms(text: str) -> str:
    t = text.upper()
    for pat, label in (
        (r"\b(NNN|TRIPLE[ -]NET)\b", "NNN"), (r"\b(MG|MODIFIED GROSS)\b", "Modified gross"),
        (r"\b(IG|INDUSTRIAL GROSS)\b", "Industrial gross"), (r"\b(FS|FSG|FULL[ -]SERVICE)\b", "Full service"),
        (r"\bABSOLUTE NET\b", "Absolute net"), (r"\bGROSS\b", "Gross"), (r"\bNET\b", "Net"),
    ):
        if re.search(pat, t):
            return label
    return ""


def parse_date(text: str) -> str:
    """Any common date or timestamp -> 'YYYY-MM-DD' ('' when it cannot be read)."""
    s = clean_str(text)
    if not s:
        return ""
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        pass
    for candidate in (s, s.split("T")[0], s.split(" ")[0]):
        for fmt in _DATE_FORMATS:
            try:
                return datetime.strptime(candidate, fmt).date().isoformat()
            except ValueError:
                continue
    return ""


def _words(text: str) -> str:
    """RESO enumerations run words together ("CommercialSale", "ActiveUnderContract"): split them."""
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", text)


def _kind(text: str) -> tuple[str, str, bool]:
    """'For lease', 'CommercialSale', 'Sublease'... -> (sale | lease | '', qualifier, offered both ways)."""
    t = _words(text).upper()
    both = bool(re.search(r"SALE\s*(/|OR|&|AND|\s)\s*LEASE|LEASE\s*(/|OR|&|AND|\s)\s*SALE", t))
    if "SUBLEASE" in t or "SUB-LEASE" in t or "SUBLET" in t:
        return "lease", "Sublease", False
    if both:
        return "sale", "For sale or lease", True
    if "GROUND LEASE" in t:
        return "lease", "Ground lease", False
    if re.search(r"\b(LEASE|RENT|RENTAL)\b", t):
        return "lease", "", False
    if "AUCTION" in t:
        return "sale", "Auction", False
    if "BUSINESS OPPORTUNITY" in t or "BUSINESS ONLY" in t:
        return "sale", "Business only", False
    if re.search(r"\b(SALE|SELL|PURCHASE|INVESTMENT|OWNER[ -]USER|RESIDENTIAL INCOME|LAND|FARM)\b", t):
        return "sale", "", False
    return "", "", False


def _cut(text: str, name: str) -> str:
    limit = _LIMITS[name]
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


@dataclass
class Listing:
    """One listing row after cleaning, before it is matched to a parcel."""

    data: dict
    parcel_ids: list[str]
    county: int | None
    address: Address
    address_text: str
    city: str
    zip: str
    unit: str
    lon: float | None
    lat: float | None
    both: bool


def normalize_row(raw: dict, lookup: ParcelLookup) -> tuple[Listing | None, str]:
    """Clean one file row. -> (listing, '') or (None, why it is left out)."""
    row = {_KEY.sub("", str(k).lower()): v for k, v in raw.items() if k is not None}

    status_text = _words(_pick(row, "status")).upper()
    if INACTIVE.search(status_text):
        return None, f"not on the market (status: {status_text.title()})"
    status = "pending" if PENDING.search(status_text) else "active"

    # Sale or lease: the type column, else a RESO property type ("Commercial Lease"), else the status ("For lease").
    type_text, property_type = _pick(row, "type"), _pick(row, "property_type")
    kind, sub, both = "", "", False
    for text in (type_text, property_type, status_text):
        kind, sub, both = _kind(text)
        if kind:
            break
    if not kind:
        return None, "no listing type: say whether it is for sale or for lease"

    address_text = _pick(row, "address") or " ".join(clean_str(row.get(k)) for k in _ADDRESS_PARTS if not is_blank(row.get(k)))
    street_text, city_in, zip_in = split_full_address(address_text)
    address = parse_address(street_text)
    city = norm_place(_pick(row, "city") or city_in)
    zip_code = zip5(_pick(row, "zip") or zip_in)

    space = _pick(row, "space")
    unit = _norm_unit(_UNIT_PREFIX.sub("", space)) if space else address.unit
    if space and re.fullmatch(r"#?\s*[0-9A-Za-z-]{1,8}", space) and not re.fullmatch(r"[A-Za-z]{2,}", space):
        space = f"Unit {space.lstrip('# ')}"  # a bare "200" reads better with a word in front
    if not space:
        space = address.unit_label

    scope_text = _pick(row, "scope").upper()
    if re.search(r"\b(PART|UNIT|SUITE|SPACE|PORTION|PARTIAL|CONDO)\b", scope_text):
        scope = "part"
    elif re.search(r"\b(WHOLE|ENTIRE|ALL|PROPERTY|BUILDING|FULL)\b", scope_text):
        scope = "whole"
    elif space:
        scope = "part"
    else:
        scope = "whole" if kind == "sale" else ""  # a lease with no suite named: the file does not say

    unclear_basis = False
    price_text = _pick(row, "price")
    price = _number(price_text) if price_text else None
    price_note = price_text if price_text and price is None else ""
    if price is not None and not (0 < price < 1e11):
        price = None
    # A range, in its own column or written as "$28 - $32": the lower figure is the price, the upper is kept beside it.
    price_max = _number(_pick(row, "price_max"))
    span = re.match(r"^\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(?:-|–|to)\s*\$?\s*([\d,]+(?:\.\d+)?)(?![\d.]*\s*[KMB]\b)", price_text, re.I)
    if span and price_max is None:
        price, price_max = sorted(float(x.replace(",", "")) for x in span.groups())
    if price is None or price_max is None or not (price < price_max < 1e11):
        price_max = None
    basis = _basis(" ".join(x for x in (_pick(row, "basis"), price_text if re.search(r"[A-Za-z/]", price_text) else "") if x))
    if kind == "sale":
        basis = basis[:2] if basis[:2] in ("sf", "ac") else ""  # a sale is the whole price, or per SF / per acre
    elif basis in ("mo", "yr") and price is not None and price < 100:
        # "$42 a year" for a whole space is not a rent: MLS feeds often put a per-SF rate in the price
        # and call it annual. Per SF is not assumed either: the basis is left unstated.
        basis, unclear_basis = "", True
    terms_text = _pick(row, "terms")
    terms = _lease_terms(terms_text) or (_lease_terms(price_text) if kind == "lease" else "") or terms_text

    def num(name: str, lo: float, hi: float) -> float | None:
        v = _number(_pick(row, name))
        return v if v is not None and lo < v < hi else None

    sf, sf_min = num("sf", 0, 5e7), num("sf_min", 0, 5e7)
    span = re.match(r"^\s*([\d,]+)\s*(?:-|–|to)\s*([\d,]+)", _pick(row, "sf"), re.I)
    if span:  # "1,200 - 5,000 SF": divisible space
        lo, hi = sorted(float(x.replace(",", "")) for x in span.groups())
        sf, sf_min = hi, lo
    if sf_min is not None and (sf is None or sf_min >= sf):
        sf_min = None
    ac, lot_sf = num("ac", 0, 1e5), num("lot_sf", 0, 5e9)
    if ac is None and lot_sf:
        ac = lot_sf / 43560
    cap = num("cap", 0, 100)
    if cap is not None and cap < 1:
        cap *= 100  # 0.061 -> 6.1 %
    if cap is not None and cap > 30:
        cap = None
    units, noi = num("units", 0, 1e5), num("noi", 0, 1e10)

    url = _pick(row, "url")
    if not re.match(r"^https?://[^\s<>\"']{4,500}$", url, re.I):
        url = ""
    email = _pick(row, "email")
    if not _EMAIL.match(email) or len(email) > 120:
        email = ""
    # What it is, as listed: "Commercial Sale" says only "Commercial"; a type column holding "Retail" counts too.
    use = _pick(row, "use")
    for text in (property_type, type_text):
        if not use:
            use = clean_str(re.sub(r"\b(?:FOR|SALE|LEASE|SUBLEASE|RENT|RENTAL|OR|AND)\b|[/&]", " ", _words(text), flags=re.I))

    try:
        lat, lon = float(_pick(row, "lat")), float(_pick(row, "lon"))
    except ValueError:
        lat = lon = None
    if lat is not None and not (24 < lat < 32 and -88 < lon < -79):
        lat = lon = None  # not in Florida: ignore rather than veto a match

    data = {
        "id": _cut(_pick(row, "id"), "id"), "kind": kind, "sub": _cut(sub, "sub"), "scope": scope, "space": _cut(space, "space"),
        "status": status, "title": _cut(_pick(row, "title"), "title"), "use": _cut(use, "use"),
        "price": round(price, 2) if price is not None else None, "price_max": round(price_max, 2) if price_max else None,
        "basis": basis, "terms": _cut(terms, "terms"),
        "price_note": _cut(price_note, "price_note"),
        "sf": round(sf) if sf else None, "sf_min": round(sf_min) if sf_min else None,
        "ac": round(ac, 2) if ac else None, "units": int(units) if units else None,
        "cap": round(cap, 2) if cap else None, "noi": round(noi) if noi else None,
        "firm": _cut(_pick(row, "firm"), "firm"), "agent": _cut(_pick(row, "agent"), "agent"),
        "phone": _cut(_pick(row, "phone"), "phone"), "email": email, "url": url,
        "listed": parse_date(_pick(row, "listed")), "updated": parse_date(_pick(row, "updated")),
        "note": _cut(_pick(row, "note"), "note"),
        "_unclear_basis": unclear_basis,
    }
    # Several IDs for one offering are separated by ; | , or a line break. A space is part of an ID ("4742 36 11 0050").
    parcel_ids = [p.strip() for p in re.split(r"[;|,\n]+", _pick(row, "parcel_id", raw=True)) if norm_parcel_id(p)]
    if not parcel_ids and not address.ok:
        return None, "no parcel ID and no street address with a house number"
    return Listing(
        data=data, parcel_ids=parcel_ids, county=lookup.county_code(_pick(row, "county")), address=address,
        address_text=address_text, city=city, zip=zip_code, unit=unit, lon=lon, lat=lat, both=both,
    ), ""


def match_listing(listing: Listing, lookup: ParcelLookup) -> Match:
    """Parcel ID first (every ID given must resolve), then the street address."""
    by_address = dict(city=listing.city, zip_code=listing.zip, county=listing.county, unit=listing.unit, lon=listing.lon, lat=listing.lat)
    if not listing.parcel_ids:
        return match_address(lookup, listing.address, **by_address)
    hits, missing = [], []
    for raw in listing.parcel_ids:
        p = lookup.find_pid(raw, listing.county)
        if p:
            hits.append(p)
            continue
        # Not one ID: perhaps several typed with spaces between them. All of them must resolve.
        parts = [lookup.find_pid(piece, listing.county) for piece in raw.split()] if " " in raw else []
        if parts and all(parts):
            hits += parts
        else:
            missing.append(raw)
    if hits and not missing:
        return Match(parcels=list({p.pid: p for p in hits}.values()), how="pid")
    gone = f"parcel ID not in this dataset ({', '.join(missing)})"
    if not listing.address.ok:
        return Match(reason=gone)
    m = match_address(lookup, listing.address, **by_address)
    if not m.parcels:
        m.reason = f"{gone}; by address: {m.reason}"
    return m


# ------------------------------------------------------------------------------------------------
# Publishing
# ------------------------------------------------------------------------------------------------


@dataclass
class Source:
    """Where a listing file comes from, as the panel names it."""

    name: str
    kind: str = "other"  # own | mls | vendor | other
    as_of: str = ""  # date the file was pulled; the file's own date when blank
    note: str = ""
    disclaimer: str = ""  # shown under the listings (an MLS's required wording, for example)
    url: str = ""
    logo: str = ""  # an MLS's logo (its display rules ask for it beside its listings); https only
    demo: bool = False  # made-up rows for a local preview: every card is stamped "Sample"


@dataclass
class Rejected:
    file: str
    row: int
    reason: str
    address: str = ""
    listing_id: str = ""
    candidates: str = ""


@dataclass
class ImportResult:
    index: dict
    shards: dict[str, dict[str, list[list]]]
    rejected: list[Rejected]
    notes: list[str]


def _natural(text: str) -> list:
    """'Suite 104' before 'Suite 1100'."""
    return [(0, int(t), "") if t.isdigit() else (1, 0, t) for t in re.findall(r"\d+|\D+", text.upper())]


def _sort_key(d: dict) -> tuple:
    """For sale before for lease, the whole property before its parts; sales by price, spaces by name."""
    sale = d["kind"] == "sale"
    return (0 if sale else 1, 0 if d["scope"] == "whole" else 1, -(d["price"] or 0) if sale else 0, _natural(d["space"] or ""), d["id"])


def offering_key(d: dict) -> tuple[str, str] | None:
    """What makes two sources' listings the same offering on one parcel: the property for sale (or
    for lease) as a whole, or the same suite or unit. A lease that names no space is never merged."""
    space = _norm_unit(_UNIT_PREFIX.sub("", d["space"] or "")) if d["space"] else ""
    if space:
        return (d["kind"], space)
    if d["scope"] == "whole" or (d["kind"] == "sale" and not d["scope"]):
        return (d["kind"], "whole")
    return None


def merge_sources(items: list[dict], sources: list[dict]) -> list[dict]:
    """One parcel's listings with each offering once. Within a group of the same offering from
    different sources, the most authoritative source (own, MLS, vendor, other; then the most
    recently updated) keeps its card as it is, and the others are named in its "also" list."""
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    out: list[dict] = []
    for d in items:
        key = offering_key(d)
        if key is None:
            out.append(d)
        else:
            groups[key].append(d)
    for group in groups.values():
        if len({d["src"] for d in group}) < 2:
            out += group  # one source: its listings stay as they are, even two for the same space
            continue
        rank = lambda d: (SOURCE_PRIORITY.get(sources[d["src"]]["kind"], 9), "".join(chr(0x10FFFF - ord(c)) for c in d["updated"] or ""))
        group.sort(key=rank)
        primary = group[0]
        also: dict[int, dict] = {}
        for d in group[1:]:
            if d["src"] == primary["src"]:
                out.append(d)  # the primary source's own second listing for this space
            elif d["src"] not in also:
                also[d["src"]] = d
        out.append({**primary, "also": [[d["src"], d["url"] or None, d["updated"] or None] for d in also.values()]})
    return out


def build(files: list[tuple[Path, Source]], lookup: ParcelLookup, *, shard_hex: int | None = None, today: date | None = None,
          operator: dict | None = None) -> ImportResult:
    """Read, clean, match and lay out every listing file for publishing. `operator`: the brokerage
    the site's listings are shown under ({"name": ..., "contact": ...}), which MLS rules ask for."""
    today = today or date.today()
    sources: list[dict] = []
    rejected: list[Rejected] = []
    notes: list[str] = []
    kept: list[tuple[dict, list[Parcel]]] = []

    for path, meta in files:
        if meta.kind not in SOURCE_KINDS:
            raise ValueError(f"{path.name}: source kind must be one of {', '.join(SOURCE_KINDS)}")
        rows = read_rows(path)
        src = len(sources)
        if meta.as_of and not parse_date(meta.as_of):
            raise ValueError(f"{path.name}: as-of date '{meta.as_of}' is not a date (use YYYY-MM-DD)")
        as_of = parse_date(meta.as_of) or datetime.fromtimestamp(path.stat().st_mtime).date().isoformat()
        entry: dict = {"name": meta.name, "kind": meta.kind, "as_of": as_of, "listings": 0, "parcels": 0}
        for key in ("note", "disclaimer", "url"):
            if getattr(meta, key):
                entry[key] = getattr(meta, key)
        if re.match(r"^https://[^\s\"'<>]{4,500}$", meta.logo or ""):
            entry["logo"] = meta.logo
        if meta.demo:
            entry["demo"] = True
        sources.append(entry)

        latest: dict[str, tuple[dict, list[Parcel]]] = {}
        for n, raw in enumerate(rows, start=2):  # row 1 is the header in a spreadsheet
            if all(is_blank(v) for v in raw.values()):
                continue
            listing, why = normalize_row(raw, lookup)
            if listing is None:
                keyed = {_KEY.sub("", str(k).lower()): v for k, v in raw.items() if k is not None}
                rejected.append(Rejected(path.name, n, why, _pick(keyed, "address"), _pick(keyed, "id")))
                continue
            m = match_listing(listing, lookup)
            d = listing.data
            if not m.parcels:
                rejected.append(Rejected(path.name, n, m.reason, listing.address_text, d["id"], " ".join(m.candidates)))
                continue
            if not d["id"]:
                basis = "|".join(str(x) for x in (meta.name, m.parcels[0].pid, d["kind"], d["space"], d["title"], d["price"], d["sf"]))
                d["id"] = "x" + hashlib.sha1(basis.encode("utf-8")).hexdigest()[:10]
            d["updated"] = d["updated"] or as_of
            d.update(src=src, match=m.how, group=len(m.parcels) if len(m.parcels) > 1 else None, _both=listing.both)
            previous = latest.get(d["id"])
            if previous is None or d["updated"] >= previous[0]["updated"]:
                latest[d["id"]] = (d, m.parcels)  # the same listing twice in a file: the newer copy wins

        how: dict[str, int] = defaultdict(int)
        parcels_here: set[str] = set()
        for d, parcels in latest.values():
            how[d["match"]] += 1
            parcels_here.update(p.pid for p in parcels)
        kept += latest.values()
        entry["listings"], entry["parcels"] = len(latest), len(parcels_here)
        notes.append(
            f"{path.name}: {len(rows):,} rows -> {len(latest):,} listings on {len(parcels_here):,} parcels "
            f"(by parcel ID {how['pid']:,}, by address {how['addr']:,}, inside an address range {how['range']:,}, "
            f"at an address several owners share {how['shared']:,})"
        )
        if how["shared"]:
            notes.append(f"  {how['shared']:,} are at an address that parcels of different owners share: they show on each of those "
                         "parcels as 'at this address'. Add the parcel ID (or the unit) to pin one down.")
        no_price = sum(1 for d, _ in latest.values() if d["price"] is None)
        no_basis = sum(1 for d, _ in latest.values() if d["kind"] == "lease" and d["price"] is not None and not d["basis"])
        unclear = sum(1 for d, _ in latest.values() if d.get("_unclear_basis"))
        if unclear:
            notes.append(f"  {unclear:,} lease rates under $100 came marked per month or per year: shown with the basis not stated "
                         "(they are probably per SF; the panel does not assume it)")
        if no_price:
            notes.append(f"  {no_price:,} without a price: shown as 'Price not stated'")
        if no_basis:
            notes.append(f"  {no_basis:,} lease listings without a rent basis (per SF per year, per month...): add a 'basis' column")
        age = (today - date.fromisoformat(as_of)).days
        if age > 30:
            notes.append(f"  as of {as_of}: {age} days old. The panel warns that these may be out of date.")

    by_parcel: dict[str, list[dict]] = defaultdict(list)
    for d, parcels in kept:
        for p in parcels:
            by_parcel[p.pid].append(d)
    if shard_hex is None:
        shard_hex = 1 if len(kept) < 4000 else 2
    flags: dict[str, int] = {}
    shards: dict[str, dict[str, list[list]]] = defaultdict(dict)
    shown: dict[tuple[int, str], dict] = {}  # each offering once, as shown: (source, id) -> listing
    merged: set[tuple[int, str]] = set()
    for pid, items in sorted(by_parcel.items()):
        items = merge_sources(items, sources)
        items.sort(key=_sort_key)
        flags[pid] = FLAG_SHARED_ONLY if all(d["match"] == "shared" for d in items) else 0
        for d in items:
            flags[pid] |= (FLAG_SALE if d["kind"] == "sale" or d["_both"] else 0) | (FLAG_LEASE if d["kind"] == "lease" or d["_both"] else 0)
            shown[(d["src"], d["id"])] = d
            if d.get("also"):
                merged.add((d["src"], d["id"]))
        shards[pid_shard(pid, shard_hex)][pid] = [[None if d.get(k) in ("", []) else d.get(k) for k in LISTING_FIELDS] for d in items]
    # Offerings as shown: a listing named only in another's "also" list is not counted again.
    distinct = shown
    kinds = {"sale": 0, "lease": 0}
    for d in distinct.values():
        kinds[d["kind"]] += 1
    if merged:
        notes.append(f"{len(merged):,} listings are carried by more than one source: each shows once, with the other sources named on it.")

    index = {**empty_index(), "shard_hex": shard_hex, "sources": sources,
             "counts": {"listings": len(distinct), "parcels": len(flags), **kinds, "merged": len(merged)}, "parcels": flags}
    if operator and operator.get("name"):
        index["operator"] = {k: str(v)[:120] for k, v in operator.items() if k in ("name", "contact") and v}
    return ImportResult(index=index, shards=dict(shards), rejected=rejected, notes=notes)


def empty_index() -> dict:
    """The "no listing source connected" state: the panel says so instead of claiming there are none."""
    return {
        "schema": SCHEMA,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "url": f"{OUT_DIRNAME}/{{shard}}.json",
        "shard_hex": 1,
        "fields": LISTING_FIELDS,
        "sources": [],
        "counts": {"listings": 0, "parcels": 0, "sale": 0, "lease": 0},
        "parcels": {},
    }


def write(data_dir: Path, index: dict, shards: dict[str, dict]) -> int:
    """Replace <data_dir>/listings/ with this index and its shards. -> bytes written."""
    out = data_dir / OUT_DIRNAME
    if out.is_dir():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    size = 0
    for name, obj in [("index", index), *sorted(shards.items())]:
        text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
        (out / f"{name}.json").write_text(text, encoding="utf-8")
        size += len(text.encode("utf-8"))
    return size
