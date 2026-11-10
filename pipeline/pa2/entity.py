"""Owner entity resolution: normalize OWN_NAME / owner mailing address into match keys.

Two parcels belong to the same "portfolio" when they share either
  * the same normalized owner name   (owner_name_key), or
  * the same normalized mailing address (owner_addr_key).

Keys are small integers assigned only to groups with 2+ parcels (singletons have no
portfolio), so they are compact in vector tiles and collision-free. They are rebuilt
on every pipeline run, together with the tiles and the owner index that use them.

This module is the schema hook for smarter resolution later (Sunbiz registered
agents / officers, fuzzy matching): anything that returns stable string keys per
record can replace `owner_name_norm` / `mailing_address_norm`.
"""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable

from .config import AGENT_ADDRESS_NAME_THRESHOLD, PORTFOLIO_MAX_ITEMS
from .util import clean_str, zip5

# ---------------------------------------------------------------------------
# Owner names
# ---------------------------------------------------------------------------

_NAME_PHRASES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(p), r)
    for p, r in [
        (r"\bLIMITED LIABILITY (COMPANY|CO)\b", "LLC"),
        (r"\bLTD LIABILITY (COMPANY|CO)\b", "LLC"),
        (r"\bL L L P\b", "LLLP"),
        (r"\bL L C\b", "LLC"),
        (r"\bL L P\b", "LLP"),
        (r"\bP L L C\b", "PLLC"),
        (r"\bLIMITED PARTNERSHIP\b", "LP"),
        (r"\bLTD PARTNERSHIP\b", "LP"),
        (r"\bL P\b", "LP"),
        (r"\bINCORPORATED\b", "INC"),
        (r"\bCORPORATION\b", "CORP"),
        (r"\bCOMPANY\b", "CO"),
        (r"\bLIMITED\b", "LTD"),
        (r"\bTRUSTEES?\b|\bTTEES?\b|\bTRS\b|\bTRSTE\b", "TR"),
        (r"\bAND\b", "&"),
    ]
]
_NAME_TRAILING_NOISE = re.compile(
    r"(\s+(ET\s?AL|ET\s?UX|ET\s?VIR|H/W|H&W|JTWROS|JT\s?TEN|TEN\s?COM|TIC|LE|REM))+$"
)
_LEADING_THE = re.compile(r"^THE\s+")
_NAME_DROP = re.compile(r"[.,'\"`]")
_NAME_OTHER = re.compile(r"[^A-Z0-9&/ ]+")
_WS = re.compile(r"\s+")


def owner_name_norm(name: object) -> str:
    """'Kestrel Industrial Properties, L.P.' -> 'KESTREL INDUSTRIAL PROPERTIES LP'."""
    s = clean_str(name).upper()
    if not s:
        return ""
    s = _NAME_DROP.sub("", s)
    s = _NAME_OTHER.sub(" ", s)
    s = _WS.sub(" ", s).strip()
    for pat, rep in _NAME_PHRASES:
        s = pat.sub(rep, s)
    s = _LEADING_THE.sub("", s)
    s = _NAME_TRAILING_NOISE.sub("", s)
    s = s.replace(" & ", "&").replace("&", " & ")
    return _WS.sub(" ", s).strip()


# ---------------------------------------------------------------------------
# Mailing addresses
# ---------------------------------------------------------------------------

_ADDR_TOKENS = {
    "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W",
    "NORTHEAST": "NE", "NORTHWEST": "NW", "SOUTHEAST": "SE", "SOUTHWEST": "SW",
    "STREET": "ST", "STR": "ST", "AVENUE": "AVE", "AV": "AVE", "AVN": "AVE",
    "BOULEVARD": "BLVD", "BLV": "BLVD", "DRIVE": "DR", "DRV": "DR", "ROAD": "RD",
    "LANE": "LN", "COURT": "CT", "PLACE": "PL", "PARKWAY": "PKWY", "PKY": "PKWY",
    "HIGHWAY": "HWY", "HIWAY": "HWY", "TERRACE": "TER", "TERR": "TER",
    "CIRCLE": "CIR", "TRAIL": "TRL", "SQUARE": "SQ", "PLAZA": "PLZ",
    "CENTER": "CTR", "CENTRE": "CTR", "EXPRESSWAY": "EXPY", "CAUSEWAY": "CSWY",
    "FLOOR": "FL", "FLR": "FL", "BUILDING": "BLDG", "BLD": "BLDG",
}
_UNIT = re.compile(r"\b(SUITE|STE|UNIT|APT|APARTMENT|RM|ROOM)\b\s*#?\s*")
_PO_BOX = re.compile(r"\b(P\s?O\s?BOX|POST\s+OFFICE\s+BOX|P\s?O\s?B|POB)\b")
_CARE_OF = re.compile(r"^(C/O|C O|ATTN|ATTENTION)\b|^%")
_ADDR_DROP = re.compile(r"[.,'\"`]")
_ADDR_OTHER = re.compile(r"[^A-Z0-9#/ -]+")
_HASH_SPACE = re.compile(r"#\s+")
_UNIT_ONLY = re.compile(r"^(#|FL |BLDG )\s*\S+$")


def _addr_line_norm(line: str) -> str:
    s = clean_str(line).upper()
    if not s:
        return ""
    s = _ADDR_DROP.sub("", s)
    s = _ADDR_OTHER.sub(" ", s)
    s = _PO_BOX.sub("PO BOX", s)
    s = _UNIT.sub("#", s)
    s = " ".join(_ADDR_TOKENS.get(t, t) for t in _WS.split(s.strip()))
    s = _HASH_SPACE.sub("#", s)
    return _WS.sub(" ", s).strip()


def mailing_address_norm(addr1: object, addr2: object, city: object, state: object, zipcode: object) -> str:
    """Normalized mailing address used as the address match key ('' when unusable)."""
    raw1 = clean_str(addr1).upper()
    a1 = _addr_line_norm(raw1)
    a2 = _addr_line_norm(clean_str(addr2))
    if raw1 and _CARE_OF.match(raw1):
        line = a2  # "C/O ACME MGMT" + street on line 2 -> match on the street line
    elif a1 and a2 and _UNIT_ONLY.match(a2):
        line = f"{a1} {a2}"  # suite on its own line
    else:
        line = a1 or a2
    if not line:
        return ""
    z = zip5(zipcode)
    if z and z != "00000":
        return f"{line}|{z}"
    c = _WS.sub(" ", clean_str(city).upper())
    st = clean_str(state).upper()
    if not c and not st:
        return ""
    return f"{line}|{c}|{st}"


def format_mailing_address(addr1: object, addr2: object, city: object, state: object, zipcode: object) -> str:
    """Display form: '4800 N FLAGLER DR STE 1200, WEST PALM BEACH, FL 33407'."""
    street = ", ".join(p for p in (clean_str(addr1), clean_str(addr2)) if p)
    c, st, z = clean_str(city), clean_str(state), zip5(zipcode)
    locality = " ".join(p for p in ((f"{c}," if c and (st or z) else c), st, z) if p)
    return ", ".join(p for p in (street, locality) if p)


# ---------------------------------------------------------------------------
# Portfolio grouping
# ---------------------------------------------------------------------------


def assign_owner_keys(records: list[dict]) -> tuple[dict[int, list[dict]], dict[int, list[dict]], dict[int, dict]]:
    """Set record['owner_name_key'] / ['owner_addr_key'] (int or None) in place.

    Returns (name_groups, addr_groups, addr_meta) keyed by the integer keys.
    """
    by_name: dict[str, list[dict]] = defaultdict(list)
    by_addr: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        nn = owner_name_norm(r.get("owner_name"))
        na = mailing_address_norm(
            r.get("owner_addr1"), r.get("owner_addr2"), r.get("owner_city"), r.get("owner_state"), r.get("owner_zip")
        )
        r["owner_name_key"] = None
        r["owner_addr_key"] = None
        if nn:
            by_name[nn].append(r)
        if na:
            by_addr[na].append(r)

    name_groups: dict[int, list[dict]] = {}
    for i, norm in enumerate(sorted(k for k, v in by_name.items() if len(v) >= 2), start=1):
        name_groups[i] = by_name[norm]
        for r in by_name[norm]:
            r["owner_name_key"] = i

    addr_groups: dict[int, list[dict]] = {}
    addr_meta: dict[int, dict] = {}
    for i, norm in enumerate(sorted(k for k, v in by_addr.items() if len(v) >= 2), start=1):
        members = by_addr[norm]
        addr_groups[i] = members
        distinct_names = {owner_name_norm(r.get("owner_name")) for r in members} - {""}
        addr_meta[i] = {
            "norm": norm,
            "names": len(distinct_names),
            "agent": len(distinct_names) >= AGENT_ADDRESS_NAME_THRESHOLD,
        }
        for r in members:
            r["owner_addr_key"] = i
    return name_groups, addr_groups, addr_meta


def _portfolio_entry(members: Iterable[dict], label: str, item_fields: list[str]) -> dict:
    members = sorted(members, key=lambda r: (-(r.get("just_value") or 0), r["parcel_id"]))
    counties: dict[str, int] = defaultdict(int)
    for r in members:
        counties[str(r["county_code"])] += 1
    return {
        "label": label,
        "count": len(members),
        "jv": sum(r.get("just_value") or 0 for r in members),
        "units": sum(r.get("no_res_unts") or 0 for r in members),
        "sf": sum(r.get("tot_lvg_area") or 0 for r in members),
        "counties": dict(sorted(counties.items())),
        "items": [[r.get(f) for f in item_fields] for r in members[:PORTFOLIO_MAX_ITEMS]],
    }


def build_owner_index(
    name_groups: dict[int, list[dict]],
    addr_groups: dict[int, list[dict]],
    addr_meta: dict[int, dict],
    item_fields: list[str],
) -> tuple[dict[int, dict], dict[int, dict]]:
    """Portfolio entries keyed by owner_name_key / owner_addr_key."""
    names: dict[int, dict] = {}
    for key, members in name_groups.items():
        # Most common raw spelling is the display label.
        spellings: dict[str, int] = defaultdict(int)
        for r in members:
            spellings[clean_str(r.get("owner_name"))] += 1
        label = max(spellings.items(), key=lambda kv: (kv[1], kv[0]))[0]
        names[key] = _portfolio_entry(members, label, item_fields)

    addrs: dict[int, dict] = {}
    for key, members in addr_groups.items():
        spellings = defaultdict(int)
        for r in members:
            spellings[r.get("owner_addr") or ""] += 1
        label = max(spellings.items(), key=lambda kv: (kv[1], kv[0]))[0]
        entry = _portfolio_entry(members, label, item_fields)
        entry["names"] = addr_meta[key]["names"]
        entry["agent"] = addr_meta[key]["agent"]
        addrs[key] = entry
    return names, addrs
