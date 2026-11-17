"""Street addresses: parse them, and find the parcel at one.

Used to place records that carry a street address rather than a parcel ID (securitized loans' property
addresses, for one) on the parcel map. Recovered from the listings matcher (git 5a5bb65), which was
tested on six counties' addresses.

Rules that keep a match honest:
  - the ZIP decides where, then the city; with neither, the address must exist in one place only;
  - never a guess between different owners: several owners' parcels at one address are "shared"
    (all of them, marked as such) or no match at all;
  - a match far from the record's own coordinates, when it has any, is refused.
"""

from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .util import clean_str, norm_parcel_id

# A record matched by address that spans more same-owner parcels than this is left to the report.
MAX_GROUP = 25
# Parcels with different owners at one street address (office and warehouse condos): a record there
# a record there applies to each of them, marked "at this address", up to this many parcels.
MAX_SHARED = 60
# An address match further than this from the record's own coordinates is not trusted.
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
    """Normalize a street address so the tax rolls and another source can be compared.

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
# The parcels a record can match
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
            return Match(reason=f"the address matches a parcel {drift / 1000:.1f} km from the record's own coordinates",
                         candidates=[p.pid for p in chosen[:8]])
    return Match(parcels=chosen, how=how)
