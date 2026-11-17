"""Deal signals: facts about a parcel or its owner that make a sale or a refinance more likely.

Each signal has a stable bit in the parcel's signal mask (`sg`) and, per parcel, a short chip ("Held 6
yrs, LLC owner"), the date of the record behind it, a confidence from 0 to 1, and a few facts. Where it
comes from and when it was pulled is kept once per source (`Sources`), not per parcel.

Bits are append-only: never renumber a signal, retire it instead (published bundles and saved links
read them by number).

Thresholds live in pa2/config.py (SIGNAL_*), each overridable by an environment variable.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field

from .config import (
    SIGNAL_COAST_MILES, SIGNAL_FLIP_MIN_PRICE, SIGNAL_FLIP_MONTHS, SIGNAL_FUND_EXIT_YEARS, SIGNAL_PRE_CODE_YEAR,
    SIGNAL_RECENT_TRANSFER_YEARS, SIGNAL_TAX_GAP_MIN,
)


@dataclass(frozen=True)
class SignalDef:
    bit: int
    code: str
    label: str  # preset, legend and export name
    group: str  # entity | hold | value | flood | tax | transfer
    source: str  # key into the run's Sources


SIGNALS: list[SignalDef] = [
    SignalDef(0, "dissolved", "Owner company dissolved", "entity", "sunbiz"),
    SignalDef(1, "report_overdue", "Annual report overdue", "entity", "sunbiz"),
    SignalDef(2, "inactive", "Owner company inactive", "entity", "sunbiz"),
    SignalDef(3, "fund_exit", "Fund exit window (held 5-7 yrs, company owner)", "hold", "sales"),
    SignalDef(4, "taxes_rising", "Assessed well below market (taxes rising)", "value", "roll"),
    SignalDef(5, "flood_zone", "In a FEMA flood zone", "flood", "fema"),
    SignalDef(6, "coastal_v", "Coastal high-hazard zone (V)", "flood", "fema"),
    SignalDef(7, "old_in_flood", "Older building in a flood zone", "flood", "fema"),
    SignalDef(8, "near_coast", "Near the coast", "flood", "coastline"),
    SignalDef(9, "tax_certificate", "Tax certificate outstanding", "tax", "tax"),
    SignalDef(10, "lender_sale", "Last transfer: lender, foreclosure or forced sale", "transfer", "sales"),
    SignalDef(11, "estate_sale", "Last transfer: estate, receiver or trustee", "transfer", "sales"),
    SignalDef(12, "flip", "Resold within a few years", "transfer", "sales"),
]
BY_CODE = {s.code: s for s in SIGNALS}

# Florida Department of Revenue sale qualification codes (Real Property Transfer Codes, 2026):
# 12 financial institution or deed in lieu of foreclosure, 38 forced or under duress / to prevent
# foreclosure, 19 to or from bankruptcy trustees, administrators, executors, guardians, personal
# representatives or receivers.
LENDER_CODES = {"12", "38"}
ESTATE_CODES = {"19"}
# FEMA flood zones: the Special Flood Hazard Area (1% annual chance) and its coastal high-hazard part.
SFHA_ZONES = {"A", "AE", "AH", "AO", "AR", "A99", "V", "VE"}
V_ZONES = {"V", "VE"}


@dataclass
class Hit:
    code: str
    chip: str
    date: str | None  # the record behind it (ISO date or year)
    confidence: float
    facts: dict = field(default_factory=dict)

    def row(self) -> list:
        return [self.code, self.chip, self.date, round(self.confidence, 2), self.facts or None]


@dataclass
class Sale:
    year: int
    month: int
    price: int
    qual: str | None
    source: str


def mask(hits: Iterable[Hit]) -> int:
    m = 0
    for h in hits:
        m |= 1 << BY_CODE[h.code].bit
    return m


def ym(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}" if month else f"{year:04d}"


# ---------------------------------------------------------------------------
# Individual signals
# ---------------------------------------------------------------------------

ENTITY_STATE_SIGNAL = {"D": "dissolved", "O": "report_overdue", "I": "inactive"}
FAMILY_LABEL = {"llc": "LLC", "corp": "corporation", "lp": "partnership"}


def entity_signals(ent: dict | None) -> list[Hit]:
    """From the matched Sunbiz record (build_entities.py's parcel_entities.csv row)."""
    if not ent:
        return []
    code = ENTITY_STATE_SIGNAL.get(ent.get("state", ""))
    if not code:
        return []
    note = ent.get("note") or ""
    when = ent.get("note_date") or None
    chip = {
        "dissolved": f"Owner company dissolved{f' ({when[:4]})' if when else ''}",
        "report_overdue": f"Owner's {ent.get('file_date', '')[:4] or 'annual'} annual report overdue",
        "inactive": f"Owner company inactive{f': {note.lower()}' if note else ''}",
    }[code]
    return [Hit(code, chip, when, float(ent.get("confidence") or 0), {"doc": ent.get("doc")})]


def fund_exit(hold: float | None, owner_kind: str | None, last_sale: str | None) -> Hit | None:
    """Held 5-7 years by a company: a typical fund or syndicate exit window."""
    lo, hi = SIGNAL_FUND_EXIT_YEARS
    if hold is None or not (lo <= hold <= hi) or not owner_kind:
        return None
    years = int(round(hold))
    return Hit("fund_exit", f"Held {years} yrs, {owner_kind} owner", last_sale, 0.9, {"years": years})


def taxes_rising(jv: float | None, av: float | None, nominal_max: int, roll_year: int) -> Hit | None:
    """Assessed value well below market value: Florida caps non-homestead increases at 10% a year, so the
    tax base keeps rising toward market value (and a buyer's assessment resets to it)."""
    if not jv or jv < nominal_max or av is None or av <= 0:
        return None
    gap = 1 - av / jv
    if gap < SIGNAL_TAX_GAP_MIN:
        return None
    pct = int(round(gap * 100))
    return Hit("taxes_rising", f"Assessed {pct}% below market value", str(roll_year), 0.95, {"gap": round(gap, 3)})


def transfer_signals(sales: list[Sale], this_year: int) -> list[Hit]:
    """Lender, estate and quick-resale signals from a parcel's transfer history."""
    hits: list[Hit] = []
    if not sales:
        return hits
    ordered = sorted(sales, key=lambda s: (s.year, s.month))
    last = ordered[-1]
    recent = this_year - SIGNAL_RECENT_TRANSFER_YEARS
    if last.qual in LENDER_CODES and last.year >= recent:
        what = "deed in lieu or lender sale" if last.qual == "12" else "forced sale"
        hits.append(Hit("lender_sale", f"Last transfer {ym(last.year, last.month)}: {what}", ym(last.year, last.month), 0.9,
                        {"code": last.qual}))
    if last.qual in ESTATE_CODES and last.year >= recent:
        hits.append(Hit("estate_sale", f"Last transfer {ym(last.year, last.month)}: estate, receiver or trustee",
                        ym(last.year, last.month), 0.9, {"code": last.qual}))
    priced = [s for s in ordered if s.price >= SIGNAL_FLIP_MIN_PRICE]
    for a, b in zip(priced, priced[1:]):
        months = (b.year - a.year) * 12 + ((b.month or 6) - (a.month or 6))
        # Same month, or the same price again: a re-recorded or corrective deed, not a resale.
        if 0 < months <= SIGNAL_FLIP_MONTHS and b.year >= recent and abs(b.price - a.price) > 0.02 * a.price:
            gain = (b.price - a.price) / a.price if a.price else None
            chip = f"Resold within {max(1, math.ceil(months / 12))} yr{'s' if months > 12 else ''} ({a.year} to {b.year})"
            hits.append(Hit("flip", chip, ym(b.year, b.month), 0.85,
                            {"from": a.price, "to": b.price, "months": months, **({"gain": round(gain, 2)} if gain is not None else {})}))
    # Keep only the latest quick resale.
    flips = [h for h in hits if h.code == "flip"]
    if len(flips) > 1:
        hits = [h for h in hits if h.code != "flip"] + [flips[-1]]
    return hits


def flood_signals(zone: str | None, share: float, centroid_zone: str | None, sfha_share: float, v_share: float,
                  year_built: int | None, has_building: bool, fema_date: str | None) -> list[Hit]:
    """FEMA zone signals for one parcel: the zone covering most of it (or its center)."""
    hits: list[Hit] = []
    in_sfha = sfha_share >= 0.5 or (centroid_zone in SFHA_ZONES)
    if in_sfha:
        z = zone if zone in SFHA_ZONES else centroid_zone
        conf = 0.95 if sfha_share >= 0.5 else 0.75
        pct = int(round(sfha_share * 100))
        hits.append(Hit("flood_zone", f"Flood zone {z}" + (f" ({pct}% of lot)" if pct < 95 else ""), fema_date, conf,
                        {"zone": z, "share": round(sfha_share, 2)}))
        if v_share >= 0.25 or centroid_zone in V_ZONES:
            hits.append(Hit("coastal_v", "Coastal high-hazard zone (V)", fema_date, conf, {"share": round(v_share, 2)}))
        if has_building and year_built and year_built < SIGNAL_PRE_CODE_YEAR:
            hits.append(Hit("old_in_flood", f"Pre-{SIGNAL_PRE_CODE_YEAR} building in a flood zone", fema_date, conf, {"year": year_built}))
    return hits


def near_coast(miles: float | None, coast_date: str | None) -> Hit | None:
    if miles is None or miles > SIGNAL_COAST_MILES:
        return None
    text = "On the coast" if miles < 0.05 else f"{miles:.1f} mi from the coast"
    return Hit("near_coast", text, coast_date, 0.9, {"miles": round(miles, 2)})


def summarize(hits_by_pid: dict[str, list[Hit]], county_of: dict[str, int]) -> dict:
    """Parcels per signal, overall and per county."""
    counts: dict[str, int] = defaultdict(int)
    per_county: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for pid, hits in hits_by_pid.items():
        for code in {h.code for h in hits}:
            counts[code] += 1
            per_county[str(county_of.get(pid, ""))][code] += 1
    return {"counts": dict(counts), "per_county": {k: dict(v) for k, v in per_county.items()}}
