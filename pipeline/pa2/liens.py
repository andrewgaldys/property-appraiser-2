"""Florida's Federal Lien Registry: federal liens (IRS tax liens, mostly) filed against corporations and
partnerships whose principal office is in Florida (Uniform Federal Lien Registration Act, s. 713.901,
F.S.; liens against individuals go to the county clerks instead).

The Division of Corporations publishes the registry with its quarterly data (sftp.floridados.gov,
doc > quarterly > flr): four fixed-width files, one each for filings, debtors, secured parties and
events. Layouts: https://dos.sunbiz.org/data-definitions/lien.html
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .sunbiz import _f, date8, iter_records

LAYOUT_URL = "https://dos.sunbiz.org/data-definitions/lien.html"
FILING_RECORD = 82
PARTY_RECORD = 206
EVENT_RECORD = 135

_FILING = {"doc": _f(1, 12), "filed": _f(13, 8), "status": _f(31, 1), "type": _f(32, 1), "assessed": _f(33, 8),
           "cancelled": _f(41, 8), "expires": _f(49, 8)}
_PARTY = {"type": _f(1, 1), "doc": _f(2, 12), "name": _f(14, 55), "format": _f(69, 1), "addr1": _f(70, 44),
          "addr2": _f(114, 44), "city": _f(158, 28), "state": _f(186, 2), "zip": _f(188, 9), "rel": _f(204, 1),
          "status": _f(206, 1)}
_EVENT = {"doc": _f(14, 12), "filed": _f(29, 8), "code": _f(60, 3), "desc": _f(63, 70)}

STATUS = {"A": "active", "L": "lapsed", "T": "terminated"}
KIND = {"F": "federal lien", "U": "lien"}
_TAX = re.compile(r"INTERNAL REVENUE|\bIRS\b|TREASURY")
# Events that end a lien even while the filing still reads "A" (seen in the Oct 2026 file), and the one
# that undoes a release. A certificate of discharge frees one property, not the lien.
_RELEASED = re.compile(r"CERTIFICATE OF RELEASE|WITHDRAW|TERMINAT")
_UNRELEASED = re.compile(r"REVOCATION|REVOKE|REINSTAT")
# A federal tax lien's notice runs 10 years and 30 days from assessment and can be refiled once in the
# year before; an expiry further out than this from the filing date is a typing error in the registry.
MAX_EXPIRY_YEARS = 21
LIFE_YEARS = 10


@dataclass
class Party:
    name: str
    person: bool
    addr1: str
    addr2: str
    city: str
    state: str
    zip: str
    current: bool


@dataclass
class Lien:
    doc: str
    filed: str | None
    status: str  # A active, L lapsed, T terminated
    kind: str  # F federal lien registration, U lien
    assessed: str | None
    cancelled: str | None
    expires: str | None
    debtors: list[Party] = field(default_factory=list)
    secured: list[Party] = field(default_factory=list)
    events: list[tuple[str | None, str]] = field(default_factory=list)

    @property
    def released(self) -> bool:
        """A certificate of release or a withdrawal is on file (and was not revoked after it)."""
        state = False
        for _when, desc in sorted(self.events, key=lambda e: e[0] or ""):
            if _RELEASED.search(desc):
                state = True
            elif state and _UNRELEASED.search(desc):
                state = False
        return state

    @property
    def ends(self) -> str | None:
        """When the notice stops being effective: the registry's expiry date when it is a plausible one,
        else 10 years from assessment (or, without one, from filing)."""
        if self.expires and self.filed and int(self.expires[:4]) - int(self.filed[:4]) <= MAX_EXPIRY_YEARS:
            return self.expires
        if self.expires and not self.filed:
            return self.expires
        start = self.assessed if self.assessed and (not self.filed or self.assessed <= self.filed) else self.filed
        return f"{int(start[:4]) + LIFE_YEARS}{start[4:]}" if start else None

    def active(self, today: str) -> bool:
        """Still in force: marked active, not cancelled, released or withdrawn, and not past its end."""
        if self.status != "A" or self.cancelled or self.released:
            return False
        end = self.ends
        return bool(end) and end >= today

    @property
    def tax(self) -> bool | None:
        """Filed by the IRS (a federal tax lien) rather than another federal agency; None when the
        secured-party file was not loaded."""
        if not self.secured:
            return None
        return any(_TAX.search(p.name) for p in self.secured)

    @property
    def holder(self) -> str:
        names = [p.name for p in self.secured if p.current] or [p.name for p in self.secured]
        return names[0] if names else ""


def find_files(folder: Path) -> dict[str, Path]:
    """The registry's four files in a folder, by kind: f filings, d debtors, s secured parties, e events
    (named flrf, flrd, flrs, flre: .zip, .txt or an extracted folder)."""
    out: dict[str, Path] = {}
    if not folder.is_dir():
        return out
    for p in sorted(folder.iterdir()):
        m = re.match(r"^flr([fdse])", p.name.lower())
        if m and (p.is_dir() or p.suffix.lower() in (".zip", ".txt", ".dat")):
            out.setdefault(m.group(1), p)
    return out


def _party(rec: str) -> tuple[str, str, Party]:
    g = lambda k: rec[_PARTY[k]].strip()  # noqa: E731
    return g("doc"), g("type"), Party(
        name=" ".join(g("name").upper().split()), person=g("format") == "P", addr1=g("addr1"), addr2=g("addr2"),
        city=g("city"), state=g("state"), zip=g("zip")[:5], current=g("rel") in ("C", ""),
    )


def read(files: dict[str, Path], log=print) -> dict[str, Lien]:
    """Every filing with its parties and events."""
    liens: dict[str, Lien] = {}
    if "f" not in files:
        return liens
    for rec in iter_records(files["f"], FILING_RECORD):
        rec = rec.ljust(FILING_RECORD)
        g = lambda k: rec[_FILING[k]].strip()  # noqa: E731
        doc = g("doc")
        if doc:
            liens[doc] = Lien(doc, date8(g("filed")), g("status"), g("type"), date8(g("assessed")),
                              date8(g("cancelled")), date8(g("expires")))
    log(f"  {len(liens):,} lien filings in {files['f'].name}")
    for kind, attr in (("d", "debtors"), ("s", "secured")):
        if kind not in files:
            continue
        n = 0
        for rec in iter_records(files[kind], PARTY_RECORD):
            doc, _type, party = _party(rec.ljust(PARTY_RECORD))
            lien = liens.get(doc)
            if lien and party.name:
                getattr(lien, attr).append(party)
                n += 1
        log(f"  {n:,} {attr} in {files[kind].name}")
    if "e" in files:
        n = 0
        for rec in iter_records(files["e"], EVENT_RECORD):
            rec = rec.ljust(EVENT_RECORD)
            lien = liens.get(rec[_EVENT["doc"]].strip())
            if lien:
                lien.events.append((date8(rec[_EVENT["filed"]]), " ".join(rec[_EVENT["desc"]].split())))
                n += 1
        log(f"  {n:,} events in {files['e'].name}")
    return liens
