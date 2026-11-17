"""Florida Division of Corporations ("Sunbiz") bulk data: entities, their filing events, and the
match from tax-roll owners to them.

Source: the Division's free quarterly downloads (January, April, July, October), each holding every
record on file when it was made:
  cordata.zip   corporations, limited liability companies and limited partnerships (10 text files)
  corevent.zip  their filing events: dissolutions, revocations, reinstatements, mergers
Fixed-width text; layouts at https://dos.sunbiz.org/data-definitions/cor.html. The files sit on the
Division's download portal behind a public login printed on
https://dos.fl.gov/sunbiz/other-services/data-downloads/quarterly-data. Download them by hand into
pipeline/raw/sunbiz/: the pipeline never signs in anywhere.

Matching a tax-roll owner to an entity (`match_owners`):
  exact   the names agree once punctuation and designators are normalized ("ACME HOLDINGS L.L.C." and
          "ACME HOLDINGS, LLC");
  prefix  the roll cuts owner names at ROLL_NAME_CUT characters: a cut name matches the entity names
          it begins;
  core    the names agree but for the designator (the roll left "LLC" off, or wrote INC for an LLC).
Each match carries a confidence from 0 to 1: higher when the owner's tax bill goes to the entity's
principal, mailing or officer address, lower when several entities fit the name.

Principals (`group_principals`): the officers, managers and registered agent on file. Owners whose
entities share a principal are linked ("related entities via ..."), except through commercial
registered-agent services, people who are agent for many unrelated owners, and names too common
statewide to tell apart without a shared address.
"""

from __future__ import annotations

import io
import re
import shutil
import subprocess
import zipfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

from .config import ROLL_NAME_CUT, SUNBIZ_COMMON_NAME, SUNBIZ_MIN_CONFIDENCE, SUNBIZ_RA_PERSON_MAX
from .entity import format_mailing_address, mailing_address_norm, owner_name_norm

SOURCE_URL = "https://dos.fl.gov/sunbiz/other-services/data-downloads/quarterly-data"
LAYOUT_URL = "https://dos.sunbiz.org/data-definitions/cor.html"


def _f(start: int, length: int) -> slice:
    """A field by the 1-based start position and length the Division's layouts give."""
    return slice(start - 1, start - 1 + length)


# ---------------------------------------------------------------------------
# Layouts (https://dos.sunbiz.org/data-definitions/cor.html)
# ---------------------------------------------------------------------------

ENTITY_RECORD = 1440
_E = {
    "doc": _f(1, 12), "name": _f(13, 192), "status": _f(205, 1), "type": _f(206, 15),
    "addr1": _f(221, 42), "addr2": _f(263, 42), "city": _f(305, 28), "state": _f(333, 2), "zip": _f(335, 10),
    "mail1": _f(347, 42), "mail2": _f(389, 42), "mcity": _f(431, 28), "mstate": _f(459, 2), "mzip": _f(461, 10),
    "filed": _f(473, 8), "more": _f(495, 1), "last_trx": _f(496, 8),
    "ry1": _f(506, 4), "rd1": _f(511, 8), "ry2": _f(519, 4), "rd2": _f(524, 8), "ry3": _f(532, 4), "rd3": _f(537, 8),
    "ra_name": _f(545, 42), "ra_type": _f(587, 1), "ra_addr": _f(588, 42), "ra_city": _f(630, 28),
    "ra_state": _f(658, 2), "ra_zip": _f(660, 9),
}
# The FEI number (positions 481-494) is never read: nothing here needs it.
_OFFICER_AT, _OFFICER_SIZE, _OFFICERS = 669, 128, 6
_O = {"title": slice(0, 4), "type": slice(4, 5), "name": slice(5, 47), "addr": slice(47, 89),
      "city": slice(89, 117), "state": slice(117, 119), "zip": slice(119, 128)}

EVENT_RECORD = 662
_V = {"doc": _f(1, 12), "seq": _f(13, 5), "code": _f(18, 20), "desc": _f(38, 40),
      "effective": _f(78, 8), "filed": _f(86, 8)}

FILING_TYPES = {
    "DOMP": "Florida profit corporation", "DOMNP": "Florida nonprofit corporation",
    "FORP": "Foreign profit corporation", "FORNP": "Foreign nonprofit corporation",
    "DOMLP": "Florida limited partnership", "FORLP": "Foreign limited partnership",
    "FLAL": "Florida limited liability company", "FORL": "Foreign limited liability company",
    "NPREG": "Nonprofit registration", "TRUST": "Declaration of trust",
}
_FAMILY = {"FLAL": "llc", "FORL": "llc", "DOMP": "corp", "FORP": "corp", "DOMNP": "corp", "FORNP": "corp",
           "NPREG": "corp", "DOMLP": "lp", "FORLP": "lp"}

# Officer titles. Corporate titles combine letters (PSTD = president, secretary, treasurer, director).
_TITLE_LETTERS = {"P": "President", "T": "Treasurer", "C": "Chairman", "V": "Vice president", "S": "Secretary",
                  "D": "Director"}
# The title field is free text cut to four characters: "Mana" is a manager, "Pres" a president.
TITLES = {
    "MGR": "Manager", "MANA": "Manager", "MNGR": "Manager", "MANG": "Manager", "MGRS": "Manager",
    "MGRM": "Managing member", "MMBR": "Managing member", "AMBR": "Authorized member", "MBR": "Member",
    "MEMB": "Member", "MEM": "Member", "SOLE": "Sole member", "AP": "Authorized person", "AUTH": "Authorized person",
    "AR": "Authorized representative", "GP": "General partner", "GENE": "General partner", "LP": "Limited partner",
    "LIMI": "Limited partner", "PART": "Partner", "PTNR": "Partner", "PRES": "President", "VP": "Vice president",
    "VICE": "Vice president", "EVP": "Executive vice president", "SVP": "Senior vice president",
    "CEO": "Chief executive", "CFO": "Chief financial officer", "COO": "Chief operating officer", "EXEC": "Executive",
    "DIR": "Director", "DIRE": "Director", "SEC": "Secretary", "SECR": "Secretary", "TREA": "Treasurer",
    "TRES": "Treasurer", "CHAI": "Chairman", "CHMN": "Chairman", "TR": "Trustee", "TTEE": "Trustee", "TRUS": "Trustee",
    "OWNR": "Owner", "OWNE": "Owner", "OWN": "Owner", "RA": "Registered agent",
}


def title_code(raw: str) -> str:
    """The title as filed, cleaned: 'Mana' -> 'MANA', 'VP,' -> 'VP', '' -> '?' (none given)."""
    return re.sub(r"[^A-Z]", "", raw.upper()) or "?"


def title_label(code: str) -> str:
    code = title_code(code)
    if code == "?":
        return "Officer"
    if code in TITLES:
        return TITLES[code]
    if set(code) <= set(_TITLE_LETTERS):
        return ", ".join(dict.fromkeys(_TITLE_LETTERS[c] for c in code))
    return code


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def date8(s: str) -> str | None:
    """'03152019' (MMDDYYYY) or '20190315' -> '2019-03-15'; None when blank or invalid."""
    s = s.strip()
    if len(s) != 8 or not s.isdigit():
        return None
    for y, m, d in ((s[4:], s[:2], s[2:4]), (s[:4], s[4:6], s[6:])):
        try:
            dt = date(int(y), int(m), int(d))
        except ValueError:
            continue
        if 1800 <= dt.year <= 2100:
            return dt.isoformat()
    return None


def _records(stream: io.TextIOBase, size: int) -> Iterator[str]:
    """Fixed-width records, one per line; also copes with records run together without line breaks."""
    carry = ""
    while True:
        line = stream.readline(size * 2)
        if not line:
            break
        if not line.endswith("\n"):
            carry += line
            while len(carry) >= size:
                yield carry[:size]
                carry = carry[size:]
            continue
        text = carry + line.rstrip("\r\n")
        carry = ""
        if len(text) < size * 2:  # one record per line, whatever small drift in its length
            if text.strip():
                yield text
            continue
        while len(text) >= size:
            yield text[:size]
            text = text[size:]
        if text.strip():
            yield text
    if carry.strip():
        yield carry


def _open_texts(path: Path) -> Iterator[tuple[str, io.TextIOBase]]:
    """Every text file in a .zip (nested .zip files too), a folder of .txt files, or one file."""
    if path.is_dir():
        for p in sorted(q for q in path.iterdir() if q.suffix.lower() in (".txt", ".dat") and q.is_file()):
            with p.open(encoding="latin-1", newline="") as fh:
                yield p.name, fh
        return
    if zipfile.is_zipfile(path):
        yield from _zip_texts(zipfile.ZipFile(path), path)
        return
    with path.open(encoding="latin-1", newline="") as fh:
        yield path.name, fh


def _zip_texts(zf: zipfile.ZipFile, path: Path | None = None) -> Iterator[tuple[str, io.TextIOBase]]:
    with zf:
        for info in sorted(zf.infolist(), key=lambda i: i.filename):
            if info.is_dir():
                continue
            if info.filename.lower().endswith(".zip"):
                with zf.open(info) as raw:
                    yield from _zip_texts(zipfile.ZipFile(io.BytesIO(raw.read())))
                continue
            try:
                raw = zf.open(info)
            except NotImplementedError:
                # The Division packs cordata.zip with Deflate64, which Python's zipfile cannot read:
                # stream that member through the system's unzip instead (nothing is written to disk).
                if path is None:
                    raise
                yield from _unzip_member(path, info.filename)
                continue
            with raw:
                yield info.filename, io.TextIOWrapper(raw, encoding="latin-1", newline="")


def _unzip_member(path: Path, member: str) -> Iterator[tuple[str, io.TextIOBase]]:
    exe = shutil.which("unzip")
    if not exe:
        raise RuntimeError(
            f"{path.name} uses a compression Python cannot read and no `unzip` command was found: "
            f"extract it (double-click it in Finder) and pass the folder with --cordata."
        )
    proc = subprocess.Popen([exe, "-p", "-qq", str(path), member], stdout=subprocess.PIPE)
    try:
        yield member, io.TextIOWrapper(proc.stdout, encoding="latin-1", newline="")
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.terminate()
        proc.wait()


def iter_records(path: Path, size: int) -> Iterator[str]:
    for _name, stream in _open_texts(path):
        yield from _records(stream, size)


def file_date(path: Path) -> str:
    """When the Division made the file: the newest member date inside a .zip, else its modified time."""
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            stamps = [datetime(*i.date_time) for i in zf.infolist() if not i.is_dir()]
        if stamps:
            return max(stamps).date().isoformat()
    target = path if path.is_file() else max(path.iterdir(), key=lambda p: p.stat().st_mtime)
    return datetime.fromtimestamp(target.stat().st_mtime).date().isoformat()


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Principal:
    role: str  # officer title code, or "RA" for the registered agent
    kind: str  # "P" person, "C" company
    name: str
    addr: str  # one display line
    addr_key: str  # normalized address ('' when unusable)
    key: str = ""  # person / company key, see person_key
    group: int = 0  # principal group linking this entity to other owners' (0: none)


@dataclass(slots=True)
class Event:
    seq: int
    code: str
    desc: str
    effective: str | None
    filed: str | None

    @property
    def when(self) -> str:
        return self.effective or self.filed or ""


@dataclass(slots=True)
class Entity:
    doc: str
    name: str
    status: str  # "A" active, "I" inactive, as filed
    ftype: str
    addr: str
    addr_key: str
    mail: str
    mail_key: str
    filed: str | None
    last_trx: str | None
    reports: list[tuple[int, str | None]]
    more_officers: bool
    principals: list[Principal]
    events: list[Event] = field(default_factory=list)
    # Set by classify(): A active | O active, annual report overdue | D administratively dissolved or
    # revoked | I inactive for another reason (voluntary dissolution, merger, withdrawal...).
    state: str = ""
    note: str | None = None
    note_date: str | None = None

    @property
    def family(self) -> str | None:
        return _FAMILY.get(self.ftype)

    @property
    def report_year(self) -> int | None:
        return max((y for y, _ in self.reports), default=None)

    @property
    def report_date(self) -> str | None:
        return max(((y, d) for y, d in self.reports), default=(0, None))[1]


_PERSON_PUNCT = str.maketrans({c: " " for c in ".,'\"`()/;:#*"})


def person_key(name: str, kind: str) -> str:
    """Match key for a principal: companies by their normalized name, people by their name as filed."""
    if kind == "C":
        k = owner_name_norm(name)
        return f"C:{k}" if k else ""
    k = " ".join(name.upper().translate(_PERSON_PUNCT).split())
    return f"P:{k}" if k else ""


def parse_entity(rec: str) -> Entity:
    rec = rec.ljust(ENTITY_RECORD)

    def g(k: str) -> str:
        return " ".join(rec[_E[k]].split())

    principals: list[Principal] = []
    ra = g("ra_name")
    if ra:
        kind = g("ra_type") or "P"
        parts = (g("ra_addr"), "", g("ra_city"), g("ra_state"), g("ra_zip"))
        principals.append(Principal("RA", kind, ra, format_mailing_address(*parts), mailing_address_norm(*parts),
                                    person_key(ra, kind)))
    for i in range(_OFFICERS):
        at = _OFFICER_AT - 1 + i * _OFFICER_SIZE
        blk = rec[at:at + _OFFICER_SIZE]
        name = " ".join(blk[_O["name"]].split())
        if not name:
            continue
        kind = blk[_O["type"]].strip() or "P"
        parts = (" ".join(blk[_O["addr"]].split()), "", " ".join(blk[_O["city"]].split()),
                 blk[_O["state"]].strip(), blk[_O["zip"]].strip())
        principals.append(Principal(title_code(blk[_O["title"]]), kind, name, format_mailing_address(*parts),
                                    mailing_address_norm(*parts), person_key(name, kind)))
    reports: list[tuple[int, str | None]] = []
    for yk, dk in (("ry1", "rd1"), ("ry2", "rd2"), ("ry3", "rd3")):
        y = g(yk)
        if y.isdigit() and 1900 <= int(y) <= 2100:
            reports.append((int(y), date8(g(dk))))
    principal = (g("addr1"), g("addr2"), g("city"), g("state"), g("zip"))
    mailing = (g("mail1"), g("mail2"), g("mcity"), g("mstate"), g("mzip"))
    return Entity(
        doc=g("doc"), name=g("name"), status=g("status").upper(), ftype=g("type").upper(),
        addr=format_mailing_address(*principal), addr_key=mailing_address_norm(*principal),
        mail=format_mailing_address(*mailing), mail_key=mailing_address_norm(*mailing),
        filed=date8(g("filed")), last_trx=date8(g("last_trx")), reports=reports,
        more_officers=g("more").upper() == "Y", principals=principals,
    )


def parse_event(rec: str) -> tuple[str, Event]:
    rec = rec.ljust(EVENT_RECORD)

    def g(k: str) -> str:
        return " ".join(rec[_V[k]].split())

    seq = g("seq")
    return g("doc"), Event(int(seq) if seq.isdigit() else 0, g("code").upper(), g("desc").upper(),
                           date8(g("effective")), date8(g("filed")))


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

# Event descriptions as the Division writes them (corevent.zip): "ADMIN DISSOLUTION FOR ANNUAL REPORT",
# "INVOL DISSOLUTION FOR ANNUAL REPORT", "INVOLUNTARILY DISSOLVED", "DISSOLVED BY PROCLAMATION" (the older
# wording), "CANCEL FOR NON-PAYMENT", "REVOKED FOR ANNUAL REPORT" are the state's doing; "VOLUNTARY
# DISSOLUTION", "MERGER", "CONVERSION", "WITHDRAWAL", "DISSOLVED BY COURT ORDER" are not.
_ADMIN = re.compile(r"ADMIN|INVOL|PROCLAMATION|NON-?PAYMENT|REVOK|REVOC(?!ATION OF DISSOL)")
_ENDS = re.compile(r"DISSOL|REVOK|REVOC|WITHDR|MERGE|CONVERSION|CANCEL|EXPIR|TERMINAT|INACTIV|ABANDON")
# "CANCEL ADM DISS/REV" undoes an administrative dissolution or revocation, like a reinstatement.
_REVIVES = re.compile(r"REINST|REVOCATION OF DISSOL|REVIV|CANCEL ADM")


_KEEP_UPPER = {"LLC", "LP", "INC", "PA", "FL", "RA"}
REINSTATED_YEARS = 3  # an active entity notes a reinstatement this recent


def _title(s: str) -> str:
    """'ADMIN DISSOLUTION FOR ANNUAL REPORT' -> 'Admin Dissolution For Annual Report' (for display)."""
    return " ".join(w if w in _KEEP_UPPER else w.capitalize() for w in s.split())


def classify(ent: Entity, as_of: date) -> None:
    """Set ent.state / note / note_date from the status as filed, the annual reports and the events."""
    events = sorted(ent.events, key=lambda e: (e.when, e.seq))
    if ent.status == "A":
        filed_year = int(ent.filed[:4]) if ent.filed else None
        due_passed = (as_of.month, as_of.day) > (5, 1)
        if due_passed and filed_year and filed_year < as_of.year and (ent.report_year or 0) < as_of.year:
            ent.state, ent.note = "O", f"No {as_of.year} annual report on file (due May 1)"
            return
        ent.state = "A"
        # A recent reinstatement says the entity lapsed lately; one from decades ago says nothing.
        recent = f"{as_of.year - REINSTATED_YEARS}{as_of.isoformat()[4:]}"
        revived = [e for e in events if _REVIVES.search(f"{e.code} {e.desc}") and e.when >= recent]
        if revived:
            ent.note, ent.note_date = "Reinstated", revived[-1].when or None
        return
    ending = [e for e in events if _ENDS.search(f"{e.code} {e.desc}") and not _REVIVES.search(f"{e.code} {e.desc}")]
    last = ending[-1] if ending else None
    if last and _ADMIN.search(f"{last.code} {last.desc}"):
        ent.state = "D"
    else:
        ent.state = "I"
    if last:
        ent.note, ent.note_date = _title(last.desc or last.code), last.when or None


# ---------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------

_LIGHT_DROP = re.compile(r"[.,'\"`]")
_LIGHT_OTHER = re.compile(r"[^A-Z0-9& ]+")
_WS = re.compile(r"\s+")
_AND = re.compile(r"\bAND\b")
_DESIGNATORS = {"LLC", "LC", "INC", "CORP", "CO", "LP", "LLP", "LLLP", "LTD", "PA", "PLLC", "PL", "PC"}
_DESIGNATOR_FAMILY = {"LLC": "llc", "LC": "llc", "INC": "corp", "CORP": "corp", "CO": "corp", "PA": "corp",
                      "PC": "corp", "PLLC": "llc", "PL": "llc", "LP": "lp", "LLP": "lp", "LLLP": "lp", "LTD": "lp"}
PREFIX_HEAD = 16


def light_key(name: str) -> str:
    """Punctuation, '&'/'AND' and a leading 'THE' evened out, nothing else: safe on names cut mid-word."""
    s = _LIGHT_DROP.sub("", name.upper())
    s = _LIGHT_OTHER.sub(" ", s)
    s = _AND.sub("&", s).replace("&", " & ")
    s = _WS.sub(" ", s).strip()
    return s[4:] if s.startswith("THE ") else s


def core_key(exact: str) -> str:
    """The normalized name without its trailing designators: 'ACME HOLDINGS LLC' -> 'ACME HOLDINGS'."""
    toks = exact.split()
    while toks and toks[-1] in _DESIGNATORS:
        toks.pop()
    return " ".join(toks)


def name_family(exact: str) -> str | None:
    toks = exact.split()
    return _DESIGNATOR_FAMILY.get(toks[-1]) if toks else None


def _head(light: str) -> str:
    return " ".join(light.split(" ", 2)[:2])


# Words the tax roll abbreviates or spells its own way, evened out for the looser "variant" match
# (never for owner grouping, which keeps owner_name_norm).
_PARTNERSHIP = re.compile(r"\b(PRTNRSHP|PTNRSHP|PTNSHP|PRTSHP|PRTNSHP|PARTNRSHP|PARTNERSHP|PTRSHP|PRTNERSHIP|PTNERSHIP)\b")
_ABBREV = {
    "ASSOCIATES": "ASSOC", "ASSOCIATION": "ASSOC", "ASSOCIATE": "ASSOC", "ASSN": "ASSOC", "ASSOCS": "ASSOC",
    "DEVELOPMENT": "DEV", "DEVELOPMENTS": "DEV", "INVESTMENT": "INV", "INVESTMENTS": "INV", "HOSPITAL": "HOSP",
    "MANAGEMENT": "MGMT", "PROPERTIES": "PROP", "PROPERTY": "PROP", "PROPS": "PROP", "APARTMENTS": "APTS",
    "APARTMENT": "APTS", "CENTER": "CTR", "CENTRE": "CTR", "INTERNATIONAL": "INTL", "BROTHERS": "BROS",
    "NATIONAL": "NATL", "LIMITED": "LTD", "CORPORATION": "CORP", "INCORPORATED": "INC", "COMPANY": "CO",
}
# Tags the roll adds after a company name: a trustee, a lessor.
_ROLL_TAGS = {"TR", "TRS", "LESSOR", "LESSEE"}


def mapped_light(light: str, keep_last: bool) -> str:
    """light_key with abbreviations evened out; keep_last leaves the last word alone (a cut-off roll name)."""
    toks = light.split(" ")
    last = toks.pop() if keep_last and toks else None
    s = " ".join([_ABBREV.get(t, t) for t in toks] + ([last] if last is not None else []))
    return _PARTNERSHIP.sub("PARTNERSHIP", s)


def variant_key(exact: str) -> str:
    """The loosest key: the first owner of 'X LLC & Y', the roll's trustee or lessor tag dropped,
    abbreviations and partnership spellings evened out, designators dropped."""
    s = exact
    if " & " in s:
        first = s.split(" & ", 1)[0]
        if name_family(first):  # 'ESPLANADE TIC LLC & ...': two owners, the first a company
            s = first
    s = _PARTNERSHIP.sub("PARTNERSHIP", s.rstrip(" &"))
    s = " ".join(_ABBREV.get(t, t) for t in s.split())
    s = re.sub(r"\bLTD PARTNERSHIP\b", "LP", s)
    toks = s.split()
    while toks and (toks[-1] in _ROLL_TAGS or toks[-1] in _DESIGNATORS):
        toks.pop()
    return " ".join(toks)


# Which tax-roll owner names can be companies (mirrors web/src/entity.ts: LLC, LP, CORP, ORG, GOV, TRUST).
_K_LLC = re.compile(r"\b(LLC|L L C|LC|LIMITED LIABILITY)\b")
_K_LP = re.compile(r"\b(LP|LLP|LLLP|LTD|PARTNERSHIP|PARTNERS|PTNRS|PTNRSHP|PTNSHP|PRTNRSHP)\b")
_K_CORP = re.compile(r"\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|PA|PLLC|PL|BANK|N A)\b")
_K_ORG = re.compile(
    r"\b(CHURCH|ASSOCIATION|ASSN|ASSOC|FOUNDATION|MINISTRIES|MINISTRY|TEMPLE|SYNAGOGUE|DIOCESE|ARCHDIOCESE|"
    r"CONGREGATION|CLUB|LODGE|SOCIETY|UNIVERSITY|COLLEGE|HOSPITAL|HOA|CONDOMINIUM|CONDO|POA|LEGION|MISSION|"
    r"CHAPEL|BAPTIST|METHODIST|CATHOLIC|LUTHERAN|PRESBYTERIAN|EPISCOPAL|YMCA|UNITED WAY|FARM BUREAU|LOCAL|UNION)\b"
)
_K_GOV = re.compile(
    r"^(CITY|TOWN|VILLAGE|COUNTY|STATE) OF\b|\b(CITY|TOWN|VILLAGE) OF$|^([A-Z-]+ ){1,3}COUNTY( LESSOR)?$|"
    r"\b(UNITED STATES|U S A|STATE OF FLORIDA|SCHOOL BOARD|SCHOOL DISTRICT|BOARD OF COUNTY|TIITF|HOUSING AUTHORITY|"
    r"WATER MANAGEMENT|DRAINAGE DISTRICT|IMPROVEMENT DISTRICT|FLOOD CONTROL|DEPARTMENT OF|DEPT OF|FDOT|SFWMD)\b"
)
_K_TRUST = re.compile(r"\b(TRUST|TRUSTS|TRUS|TRUSTEE|TRUSTEES|TTEE|TTEES|TR|TRS|ESTATE|EST OF|EST|HEIRS|REVOCABLE|IRREVOCABLE)\b")
_K_NOT_TRUST = re.compile(r"\b(REAL ESTATE|REALTY TRUST|INVESTMENT TRUST|REIT|TRUST BANK|TRUST CO|TRUST COMPANY)\b")
_K_BUSINESS = re.compile(
    r"\b(HOLDINGS?|INVESTMENTS?|PROPERTIES|PROPERTY|REALTY|ENTERPRISES?|GROUP|VENTURES?|DEVELOPMENT|MANAGEMENT|"
    r"CAPITAL|FUND|ASSOCIATES|PARTNERS|EQUITIES|EQUITY|PLAZA|CENTER|APARTMENTS?|STORAGE|INDUSTRIAL|COMMERCIAL|"
    r"OFFICE|RETAIL|ACQUISITIONS?|ASSETS?|PORTFOLIO|INTERNATIONAL|AMERICA|AMERICAN|FLORIDA|USA)\b"
)


def company_like(name: str) -> bool:
    """Whether a roll owner name can be a registered company or organization (not a person, trust or government)."""
    s = " ".join(name.upper().replace(".", " ").replace(",", " ").split())
    if not s or _K_GOV.search(s):
        return False
    if _K_LLC.search(s) or _K_LP.search(s) or _K_ORG.search(s):
        return True
    if _K_TRUST.search(s) and not _K_NOT_TRUST.search(s) and not _K_CORP.search(s):
        return False
    if _K_CORP.search(s):
        return True
    return bool(re.search(r"\d", s) or _K_BUSINESS.search(s) or len(s) >= ROLL_NAME_CUT - 2)


_SERVICE = re.compile(
    r"\b(REGISTERED AGENTS?|CORPORATE (AGENTS?|SERVICES?|CREATIONS)|CORPORATION SERVICE|INCORP SERVICES|"
    r"C ?T CORPORATION|NATIONAL REGISTERED|UNITED STATES CORPORATION AGENTS|LEGALINC|NORTHWEST REGISTERED|"
    r"BUSINESS FILINGS|COGENCY GLOBAL|VCORP|HARBOR COMPLIANCE|ZENBUSINESS|LEGALZOOM|INCFILE|AGENT SERVICES?|"
    r"AGENTS INC|SUNSHINE STATE REGISTERED|FLORIDA REGISTERED AGENT|REGISTERED AGENT SOLUTIONS|A REGISTERED AGENT)\b"
)


def is_service(name: str) -> bool:
    """Commercial registered-agent and filing services: never a principal of the owner."""
    return bool(_SERVICE.search(" ".join(name.upper().translate(_PERSON_PUNCT).split())))


# ---------------------------------------------------------------------------
# Pass 1: entities whose names can match a roll owner
# ---------------------------------------------------------------------------


@dataclass
class OwnerNames:
    """Lookup sets built from the roll's company-like owner names."""

    exact: set[str] = field(default_factory=set)
    core: set[str] = field(default_factory=set)
    variant: set[str] = field(default_factory=set)
    # Cut-off names by their first PREFIX_HEAD characters: as printed, and with abbreviations evened out.
    prefix: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    heads: set[str] = field(default_factory=set)

    @classmethod
    def build(cls, names: Iterable[str]) -> OwnerNames:
        ix = cls()
        for raw in names:
            ex = owner_name_norm(raw)
            if not ex:
                continue
            ix.exact.add(ex)
            co = core_key(ex)
            if co:
                ix.core.add(co)
            va = variant_key(ex)
            if va:
                ix.variant.add(va)
            light = light_key(raw)
            for k in (light, ex, mapped_light(light, keep_last=False)):
                ix.heads.add(_head(k))
            if len(raw.strip()) >= ROLL_NAME_CUT:
                for L in prefix_keys(raw):
                    ix.prefix[L[:PREFIX_HEAD]].add(L)
        return ix


def prefix_keys(raw: str) -> set[str]:
    """A cut-off roll name's prefix keys: as printed, and with its complete words' abbreviations evened out."""
    light = light_key(raw)
    return {k for k in (light, mapped_light(light, keep_last=True)) if len(k) >= PREFIX_HEAD}


@dataclass
class Candidates:
    entities: dict[str, Entity] = field(default_factory=dict)
    by_exact: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    by_core: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    by_variant: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    by_prefix: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    scanned: int = 0


def scan_entities(path: Path, ix: OwnerNames, log=print) -> Candidates:
    """Stream the corporate file once, keeping the entities whose names can match a roll owner."""
    out = Candidates()
    name_at = _E["name"]
    n = 0
    for n, rec in enumerate(iter_records(path, ENTITY_RECORD), start=1):
        if n % 1_000_000 == 0:
            log(f"    {n:,} entity records read, {len(out.entities):,} kept")
        light = light_key(rec[name_at])
        if not light:
            continue
        mapped = mapped_light(light, keep_last=False)
        cut = {L for k in (light, mapped) for L in ix.prefix.get(k[:PREFIX_HEAD], ()) if k.startswith(L)}
        exact = core = variant = ""
        if _head(light) in ix.heads or _head(mapped) in ix.heads:
            exact = owner_name_norm(rec[name_at])
            core = core_key(exact)
            variant = variant_key(exact)
        hit_exact = exact in ix.exact
        hit_core = core in ix.core
        hit_variant = variant in ix.variant
        if not (cut or hit_exact or hit_core or hit_variant):
            continue
        ent = parse_entity(rec)
        if not ent.doc:
            continue
        out.entities[ent.doc] = ent
        if hit_exact:
            out.by_exact[exact].append(ent.doc)
        if hit_core:
            out.by_core[core].append(ent.doc)
        if hit_variant:
            out.by_variant[variant].append(ent.doc)
        for L in cut:
            out.by_prefix[L].append(ent.doc)
    out.scanned = n
    return out


def scan_events(path: Path, docs: set[str], log=print) -> tuple[dict[str, list[Event]], Counter]:
    """Events for the kept entities, and how often each event description occurs among them."""
    events: dict[str, list[Event]] = defaultdict(list)
    kinds: Counter = Counter()
    doc_at = _V["doc"]
    for n, rec in enumerate(iter_records(path, EVENT_RECORD), start=1):
        if n % 2_000_000 == 0:
            log(f"    {n:,} event records read")
        if rec[doc_at].strip() not in docs:
            continue
        doc, ev = parse_event(rec)
        events[doc].append(ev)
        kinds[f"{ev.code} | {ev.desc}"] += 1
    return events, kinds


def count_names(path: Path, keys: set[str], log=print) -> Counter:
    """How many Florida entities (any status) list each of these people as officer or registered agent."""
    counts: Counter = Counter()
    if not keys:
        return counts
    slots = [_E["ra_name"]] + [
        slice(_OFFICER_AT - 1 + i * _OFFICER_SIZE + _O["name"].start, _OFFICER_AT - 1 + i * _OFFICER_SIZE + _O["name"].stop)
        for i in range(_OFFICERS)
    ]
    for n, rec in enumerate(iter_records(path, ENTITY_RECORD), start=1):
        if n % 2_000_000 == 0:
            log(f"    {n:,} entity records read for principal names")
        seen = set()
        for sl in slots:
            raw = rec[sl]
            if not raw.strip():
                continue
            k = "P:" + " ".join(raw.upper().translate(_PERSON_PUNCT).split())
            if k in keys and k not in seen:
                seen.add(k)
                counts[k] += 1
    return counts


# ---------------------------------------------------------------------------
# Matching roll owners to entities
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Match:
    doc: str
    confidence: float
    how: str  # exact | prefix | core, with "+addr" when the mailing address agrees
    candidates: int


def _addr_parts(key: str) -> tuple[str, str]:
    """('1200', '33401') from '1200 N FLAGLER DR|33401': house number and ZIP (or locality)."""
    line, _, rest = key.partition("|")
    return (line.split(" ", 1)[0] if line[:1].isdigit() else ""), rest


def addr_score(ent: Entity, mail_key: str) -> int:
    """2: the tax bill goes to the entity's principal, mailing or officer address; 1: same street number
    and ZIP (a suite or spelling apart); 0: neither."""
    if not mail_key:
        return 0
    keys = {ent.addr_key, ent.mail_key} | {p.addr_key for p in ent.principals}
    keys.discard("")
    if mail_key in keys:
        return 2
    num, zip_ = _addr_parts(mail_key)
    if num and any(_addr_parts(k) == (num, zip_) for k in keys):
        return 1
    return 0


def _choose(docs: list[str], ents: dict[str, Entity], mail_key: str, family: str | None, how: str) -> Match | None:
    cands = [ents[d] for d in dict.fromkeys(docs) if d in ents]
    if not cands:
        return None

    def rank(e: Entity) -> tuple:
        fam_ok = family is None or e.family is None or e.family == family
        return (addr_score(e, mail_key), e.status == "A", fam_ok, e.filed or "")

    ranked = sorted(cands, key=rank, reverse=True)
    best = ranked[0]
    a = addr_score(best, mail_key)
    unique = len(ranked) == 1
    # Several entities fit the name. The mailing address can single one out; failing that, being the
    # only active one is a weak hint (a dissolved namesake may well be the owner of record).
    by_addr = unique or a > addr_score(ranked[1], mail_key)
    by_status = not by_addr and rank(best)[:2] > rank(ranked[1])[:2]
    fam_conflict = family is not None and best.family is not None and best.family != family
    # An address every candidate shares (sister companies of one sponsor) tells them apart no better
    # than none: in a full tie it earns nothing.
    bonus = {2: 0.08, 1: 0.04, 0: 0.0}[a] if (by_addr or by_status) else 0.0
    if how == "exact":
        base = 0.85 if unique else (0.84 if by_addr else (0.62 if by_status else 0.55))
        conf = base + bonus
    elif how == "prefix":  # a cut name: the address counts double
        base = 0.78 if unique else (0.8 if by_addr else (0.55 if by_status else 0.45))
        conf = base + 2 * bonus
    elif how == "core":  # the designator differs or is missing
        base = 0.68 if unique else (0.72 if by_addr else (0.45 if by_status else 0.4))
        conf = base + 2.5 * bonus - (0.15 if fam_conflict else 0.0)
    else:  # variant: abbreviations, partnership spellings, a trustee or lessor tag apart
        base = 0.64 if unique else (0.7 if by_addr else (0.42 if by_status else 0.38))
        conf = base + 2.5 * bonus - (0.15 if fam_conflict else 0.0)
    conf = round(min(conf, 0.99), 2)
    return Match(best.doc, conf, f"{how}+addr" if a == 2 else how, len(ranked))


def match_owner(raw: str, mail_key: str, cands: Candidates) -> Match | None:
    exact = owner_name_norm(raw)
    if not exact:
        return None
    family = name_family(exact)
    found: list[Match] = []
    if exact in cands.by_exact:
        m = _choose(cands.by_exact[exact], cands.entities, mail_key, family, "exact")
        if m:
            found.append(m)
    if len(raw.strip()) >= ROLL_NAME_CUT:
        docs = [d for L in sorted(prefix_keys(raw)) for d in cands.by_prefix.get(L, ())]
        if docs:
            m = _choose(docs, cands.entities, mail_key, None, "prefix")
            if m:
                found.append(m)
    if not found:
        core = core_key(exact)
        if core in cands.by_core:
            m = _choose(cands.by_core[core], cands.entities, mail_key, family, "core")
            if m:
                found.append(m)
    if not found or max(m.confidence for m in found) < SUNBIZ_MIN_CONFIDENCE:
        variant = variant_key(exact)
        if variant in cands.by_variant:
            m = _choose(cands.by_variant[variant], cands.entities, mail_key, family, "variant")
            if m:
                found.append(m)
    return max(found, key=lambda m: m.confidence) if found else None


# ---------------------------------------------------------------------------
# Principals shared across owners
# ---------------------------------------------------------------------------


# Roles that file for an entity rather than run it: the registered agent, an authorized person or representative.
FILER_ROLES = {"RA", "AP", "AR", "AUTH"}


@dataclass
class PrincipalGroup:
    key: str
    label: str
    kind: str  # P person | C company
    statewide: int | None
    members: list[tuple[str, str, bool]]  # (doc, roles, shares an address with another member)


def principal_keys(ents: Iterable[Entity]) -> set[str]:
    return {p.key for e in ents for p in e.principals if p.kind != "C" and p.key and not is_service(p.name)}


def group_principals(ents: dict[str, Entity], owner_of: dict[str, str], statewide: Counter) -> list[PrincipalGroup]:
    """Principals that link two or more matched entities with different owners.

    ents: the matched entities; owner_of: doc -> the roll owner it was matched to (normalized name).
    """
    filer_load: Counter = Counter()
    for e in ents.values():
        for p in e.principals:
            if p.role in FILER_ROLES and p.kind == "P" and p.key:
                filer_load[p.key] += 1
    links: dict[str, dict[str, list[Principal]]] = defaultdict(lambda: defaultdict(list))
    for e in ents.values():
        managers = {p.key for p in e.principals if p.role not in FILER_ROLES}
        for p in e.principals:
            if not p.key or is_service(p.name):
                continue
            if p.role in FILER_ROLES and p.key not in managers:
                # A registered agent or authorized person (often an attorney, accountant or filing
                # clerk) links owners only when it is a person on a handful of entities, here and statewide.
                if p.kind != "P" or filer_load[p.key] > SUNBIZ_RA_PERSON_MAX or statewide.get(p.key, 0) > SUNBIZ_RA_PERSON_MAX:
                    continue
            links[p.key][e.doc].append(p)

    groups: list[PrincipalGroup] = []
    for key, by_doc in links.items():
        if len({owner_of.get(d) for d in by_doc}) < 2:
            continue
        addr_docs: dict[str, set[str]] = defaultdict(set)
        for d, ps in by_doc.items():
            for p in ps:
                if p.addr_key:
                    addr_docs[p.addr_key].add(d)
        shared = {d for ds in addr_docs.values() if len(ds) > 1 for d in ds}
        kind = next(iter(by_doc.values()))[0].kind
        count = statewide.get(key) if kind == "P" else None
        keep = set(by_doc)
        if kind == "P" and (count or 0) > SUNBIZ_COMMON_NAME:
            keep = shared  # a common name: only where it gives the same address
        if len({owner_of.get(d) for d in keep}) < 2:
            continue
        spellings = Counter(p.name for d in keep for p in by_doc[d])
        label = spellings.most_common(1)[0][0]
        members = [
            (d, "/".join(dict.fromkeys(p.role for p in by_doc[d])), d in shared)
            for d in sorted(keep, key=lambda d: ents[d].name)
        ]
        groups.append(PrincipalGroup(key, label, kind, count, members))
    groups.sort(key=lambda g: (g.label, g.key))
    return groups
