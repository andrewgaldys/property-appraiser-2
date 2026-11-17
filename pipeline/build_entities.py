#!/usr/bin/env python3
"""Match tax-roll owners to Florida Division of Corporations (Sunbiz) records and publish them.

Inputs
  pipeline/raw/sunbiz/cordata.zip    the Division's quarterly corporate file (or its extracted .txt files)
  pipeline/raw/sunbiz/corevent.zip   its quarterly event file (optional: without it an inactive entity
                                     shows as inactive, without saying why)
  pipeline/out/parcels.parquet       the joined parcel table the last data build wrote

Download both files from the Division's portal by hand (see pa2/sunbiz.py): the pipeline never signs in.

    python pipeline/build_entities.py                 # match, report, publish into web/public/data
    python pipeline/build_entities.py --no-publish    # match and report only (pipeline/out/sunbiz/)
    python pipeline/build_entities.py --clear         # remove the published Sunbiz data

Stages. Each run repeats them all; the slow file scans are cached in pipeline/out/sunbiz/ until the
input files or the roll's owner names change.
  raw      pipeline/raw/sunbiz/*.zip
  cleaned  pipeline/out/sunbiz/scan.pickle     entities whose names can match a roll owner, their events
  joined   pipeline/out/sunbiz/matches.csv     each roll owner -> entity, confidence, method
  report   pipeline/out/sunbiz/report.json     match rates per county, statuses, event kinds seen
           pipeline/out/sunbiz/unmatched.csv   company owners left unmatched, largest first
           pipeline/out/sunbiz/principals.csv  principals linking two or more owners
  publish  web/public/data/entities/           links/ (parcel -> entity), docs/ (entity records),
                                               people/ (principal groups); manifest.json "entities"
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import pickle
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from pa2 import __version__  # noqa: E402
from pa2 import sunbiz as S  # noqa: E402
from pa2.config import (  # noqa: E402
    COUNTIES, OUT_DIR, RAW_DIR, ROLL_NAME_CUT, SUNBIZ_COMMON_NAME, SUNBIZ_MIN_CONFIDENCE, SUNBIZ_RA_PERSON_MAX,
    WEB_DATA_DIR,
)
from pa2.entity import format_mailing_address, mailing_address_norm, owner_name_norm  # noqa: E402
from pa2.util import clean_str, fnv1a32, key_shard  # noqa: E402

SUNBIZ_RAW = RAW_DIR / "sunbiz"
WORK = OUT_DIR / "sunbiz"
PARCELS = OUT_DIR / "parcels.parquet"
SCAN_VERSION = 3  # bump when pa2/sunbiz.py changes what the scans keep

LINK_FIELDS = ["doc", "conf", "how"]
DOC_FIELDS = ["name", "type", "status", "state", "note", "note_date", "filed", "report_year", "report_date",
              "more", "addr", "mail", "principals"]
STATE_LABEL = {"A": "Active", "O": "Annual report overdue", "D": "Administratively dissolved or revoked",
               "I": "Inactive"}


def log(msg: str) -> None:
    print(msg, flush=True)


def find_inputs(folder: Path) -> tuple[Path | None, Path | None]:
    """cordata (zip, folder or text) and corevent in the Sunbiz download folder."""
    if not folder.is_dir():
        return None, None

    def pick(stem: str) -> Path | None:
        for pattern in (f"{stem}.zip", f"{stem}*.zip", f"{stem}*.txt", f"{stem}*"):
            hits = sorted(p for p in folder.glob(pattern) if not p.name.startswith("."))
            if hits:
                # Extracted text parts: read the folder; a zip or one file: read it.
                if len(hits) > 1 and all(p.suffix.lower() == ".txt" for p in hits):
                    return folder
                return hits[0]
        return None

    return pick("cordata"), pick("corevent")


def _stat(p: Path | None) -> list:
    if p is None:
        return []
    files = [p] if p.is_file() else sorted(q for q in p.iterdir() if q.is_file())
    return [[q.name, q.stat().st_size, int(q.stat().st_mtime)] for q in files]


# ---------------------------------------------------------------------------
# Roll owners
# ---------------------------------------------------------------------------


def load_owners(parcels: Path) -> tuple[list[dict], dict[str, dict]]:
    """Distinct roll owners (owner name + mailing address) and every parcel's county and value."""
    import pandas as pd

    cols = ["parcel_id", "county_code", "owner_name", "owner_addr1", "owner_addr2", "owner_city", "owner_state",
            "owner_zip", "just_value"]
    df = pd.read_parquet(parcels, columns=cols)
    owners: dict[tuple[str, str], dict] = {}
    parcels_by_pid: dict[str, dict] = {}
    for r in df.itertuples(index=False):
        pid = str(r.parcel_id)
        co = int(r.county_code)
        jv = float(r.just_value) if r.just_value == r.just_value and r.just_value is not None else 0.0
        parcels_by_pid[pid] = {"county": co, "jv": jv}
        name = clean_str(r.owner_name).upper()
        if not name:
            continue
        mail = mailing_address_norm(r.owner_addr1, r.owner_addr2, r.owner_city, r.owner_state, r.owner_zip)
        o = owners.get((name, mail))
        if o is None:
            o = owners[(name, mail)] = {
                "name": name, "mail_key": mail, "pids": [], "jv": 0.0, "counties": Counter(),
                "mail": format_mailing_address(r.owner_addr1, r.owner_addr2, r.owner_city, r.owner_state, r.owner_zip),
                "company": S.company_like(name),
            }
        o["pids"].append(pid)
        o["jv"] += jv
        o["counties"][co] += 1
        parcels_by_pid[pid]["company"] = o["company"]
    return list(owners.values()), parcels_by_pid


# ---------------------------------------------------------------------------
# Scans (cached)
# ---------------------------------------------------------------------------


def scan(cordata: Path, corevent: Path | None, owners: list[dict], refresh: bool) -> dict:
    names = sorted({o["name"] for o in owners if o["company"]})
    key = hashlib.sha1(json.dumps([SCAN_VERSION, ROLL_NAME_CUT, _stat(cordata), _stat(corevent), names]).encode()).hexdigest()
    cache = WORK / "scan.pickle"
    if cache.exists() and not refresh:
        with cache.open("rb") as fh:
            data = pickle.load(fh)
        if data.get("key") == key:
            log(f"  using the cached scan ({len(data['cands'].entities):,} candidate entities)")
            return data
    log(f"  scanning {cordata.name} for {len(names):,} company owner names")
    ix = S.OwnerNames.build(names)
    cands = S.scan_entities(cordata, ix, log=log)
    log(f"  {cands.scanned:,} entity records read, {len(cands.entities):,} candidates kept")
    events, kinds = {}, Counter()
    if corevent is not None:
        log(f"  scanning {corevent.name} for their events")
        events, kinds = S.scan_events(corevent, set(cands.entities), log=log)
        for doc, evs in events.items():
            cands.entities[doc].events = evs
        log(f"  {sum(len(v) for v in events.values()):,} events for {len(events):,} entities")
    data = {"key": key, "cands": cands, "kinds": kinds, "has_events": corevent is not None}
    WORK.mkdir(parents=True, exist_ok=True)
    with cache.open("wb") as fh:
        pickle.dump(data, fh, protocol=pickle.HIGHEST_PROTOCOL)
    return data


def statewide_counts(cordata: Path, keys: set[str], refresh: bool) -> Counter:
    key = hashlib.sha1(json.dumps([SCAN_VERSION, _stat(cordata), sorted(keys)]).encode()).hexdigest()
    cache = WORK / "names.pickle"
    if cache.exists() and not refresh:
        with cache.open("rb") as fh:
            data = pickle.load(fh)
        if data.get("key") == key:
            return data["counts"]
    log(f"  counting {len(keys):,} principal names across every Florida entity")
    counts = S.count_names(cordata, keys, log=log)
    with cache.open("wb") as fh:
        pickle.dump({"key": key, "counts": counts}, fh, protocol=pickle.HIGHEST_PROTOCOL)
    return counts


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------


def run(cordata: Path, corevent: Path | None, *, parcels: Path = PARCELS, out: Path = WEB_DATA_DIR,
        as_of: dt.date | None = None, publish: bool = True, refresh: bool = False, demo: bool = False) -> dict:
    WORK.mkdir(parents=True, exist_ok=True)
    file_day = dt.date.fromisoformat(S.file_date(cordata))
    as_of = as_of or file_day
    log(f"Sunbiz entities: {cordata} (file of {file_day.isoformat()}), roll {parcels}")
    owners, by_pid = load_owners(parcels)
    company = [o for o in owners if o["company"]]
    log(f"  {len(owners):,} distinct owners, {len(company):,} company-like ({sum(len(o['pids']) for o in company):,} parcels)")

    data = scan(cordata, corevent, owners, refresh)
    cands: S.Candidates = data["cands"]
    for e in cands.entities.values():
        S.classify(e, as_of)

    # Joined: each company owner -> its entity.
    matched: dict[str, S.Match] = {}  # pid -> match
    rows = []
    for o in company:
        m = S.match_owner(o["name"], o["mail_key"], cands)
        o["match"] = m
        if m and m.confidence >= SUNBIZ_MIN_CONFIDENCE:
            for pid in o["pids"]:
                matched[pid] = m
        rows.append(o)
    docs = {m.doc for m in matched.values()}
    ents = {d: cands.entities[d] for d in docs}
    owner_of: dict[str, str] = {}
    for o in company:
        m = o["match"]
        if m and m.doc in ents:
            owner_of.setdefault(m.doc, owner_name_norm(o["name"]))
    log(f"  matched {len(matched):,} parcels to {len(docs):,} entities (confidence >= {SUNBIZ_MIN_CONFIDENCE})")

    # Principals shared by two or more owners.
    keys = S.principal_keys(ents.values())
    counts = statewide_counts(cordata, keys, refresh)
    groups = S.group_principals(ents, owner_of, counts)
    gid_of = {g.key: i for i, g in enumerate(groups, start=1)}
    in_group = {(gid_of[g.key], d) for g in groups for d, _, _ in g.members}
    for e in ents.values():
        for p in e.principals:
            gid = gid_of.get(p.key, 0)
            if gid and (gid, e.doc) in in_group:
                p.group = gid
    log(f"  {len(groups):,} principals link two or more owners")

    # For later stages (deal signals): each matched parcel's entity, its status and type.
    with (WORK / "parcel_entities.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["parcel_id", "doc", "confidence", "how", "state", "note", "note_date", "type", "family",
                    "filed", "report_year", "file_date"])
        for pid, m in sorted(matched.items()):
            e = ents[m.doc]
            w.writerow([pid, m.doc, m.confidence, m.how, e.state, e.note or "", e.note_date or "", e.ftype,
                        e.family or "", e.filed or "", e.report_year or "", file_day.isoformat()])

    report = write_reports(rows, matched, ents, groups, by_pid, data, file_day, as_of)
    if publish:
        write_bundle(out, matched, ents, groups, report, file_day, as_of, demo)
    return report


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


def _band(conf: float) -> str:
    return "strong" if conf >= 0.85 else "likely" if conf >= 0.7 else "possible"


def write_reports(rows, matched, ents, groups, by_pid, data, file_day, as_of) -> dict:
    cands: S.Candidates = data["cands"]
    coverage: dict[str, dict] = {}
    for co in sorted(COUNTIES):
        pids = [p for p, v in by_pid.items() if v["county"] == co]
        comp = [p for p in pids if by_pid[p].get("company")]
        got = [p for p in comp if p in matched]
        bands = Counter(_band(matched[p].confidence) for p in got)
        states = Counter(ents[matched[p].doc].state for p in got)
        coverage[str(co)] = {
            "name": COUNTIES[co].name, "parcels": len(pids), "company": len(comp), "matched": len(got),
            "rate": round(len(got) / len(comp), 3) if comp else None,
            "strong": bands["strong"], "likely": bands["likely"], "possible": bands["possible"],
            "states": dict(sorted(states.items())),
        }
    how = Counter(m.how for m in matched.values())
    titles = Counter(p.role for e in ents.values() for p in e.principals)
    comma_names = sum(1 for e in ents.values() for p in e.principals if p.kind == "P" and "," in p.name)
    person_names = sum(1 for e in ents.values() for p in e.principals if p.kind == "P")
    report = {
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "file_date": file_day.isoformat(), "as_of": as_of.isoformat(),
        "entity_records_read": cands.scanned, "candidates": len(cands.entities), "events": data["has_events"],
        "entities_matched": len(ents), "parcels_matched": len(matched), "principal_groups": len(groups),
        "methods": dict(how.most_common()), "coverage": coverage,
        "states": dict(Counter(e.state for e in ents.values())),
        "event_kinds": dict(data["kinds"].most_common(40)),
        "officer_titles": dict(titles.most_common(40)),
        "person_names_with_comma": f"{comma_names:,} of {person_names:,}",
        "thresholds": {"min_confidence": SUNBIZ_MIN_CONFIDENCE, "ra_person_max": SUNBIZ_RA_PERSON_MAX,
                       "common_name": SUNBIZ_COMMON_NAME, "roll_name_cut": ROLL_NAME_CUT},
    }
    (WORK / "report.json").write_text(json.dumps(report, indent=2))

    with (WORK / "matches.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Roll owner", "Mailing address", "Parcels", "Just value", "Counties", "Document number",
                    "Sunbiz name", "Status", "Confidence", "Method", "Candidates"])
        for o in sorted(rows, key=lambda o: -o["jv"]):
            m = o["match"]
            if not m:
                continue
            e = data["cands"].entities[m.doc]
            w.writerow([o["name"], o["mail"], len(o["pids"]), round(o["jv"]), _counties(o), m.doc, e.name,
                        STATE_LABEL.get(e.state, e.state), m.confidence, m.how, m.candidates])
    with (WORK / "unmatched.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Roll owner", "Mailing address", "Parcels", "Just value", "Counties", "Best guess", "Confidence"])
        for o in sorted(rows, key=lambda o: -o["jv"]):
            m = o["match"]
            if m and m.confidence >= SUNBIZ_MIN_CONFIDENCE:
                continue
            guess = data["cands"].entities[m.doc].name if m else ""
            w.writerow([o["name"], o["mail"], len(o["pids"]), round(o["jv"]), _counties(o), guess,
                        m.confidence if m else ""])
    with (WORK / "principals.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Principal", "Kind", "Florida entities listing the name", "Linked entities", "Entities"])
        for g in sorted(groups, key=lambda g: -len(g.members)):
            w.writerow([g.label, "Person" if g.kind == "P" else "Company", g.statewide or "", len(g.members),
                        "; ".join(ents[d].name for d, _, _ in g.members[:12])])
    log(f"  report -> {WORK / 'report.json'}")
    for co, c in coverage.items():
        rate = f"{c['rate']:.0%}" if c["rate"] is not None else "n/a"
        log(f"    {c['name']:<13} {c['matched']:>7,} of {c['company']:>7,} company-owned parcels matched ({rate}); "
            f"strong {c['strong']:,}, likely {c['likely']:,}, possible {c['possible']:,}")
    return report


def _counties(o: dict) -> str:
    return ", ".join(COUNTIES[c].name for c in sorted(o["counties"]) if c in COUNTIES)


# ---------------------------------------------------------------------------
# Publish
# ---------------------------------------------------------------------------


def _dump(path: Path, obj) -> int:
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def clear_bundle(out: Path) -> None:
    shutil.rmtree(out / "entities", ignore_errors=True)
    mf = out / "manifest.json"
    if mf.exists():
        m = json.loads(mf.read_text())
        if m.pop("entities", None) is not None:
            mf.write_text(json.dumps(m, separators=(",", ":")))


def write_bundle(out: Path, matched, ents, groups, report, file_day, as_of, demo: bool) -> None:
    mf = out / "manifest.json"
    manifest = json.loads(mf.read_text())
    shard_hex = int(manifest.get("details", {}).get("shard_hex", 2))
    root = out / "entities"
    shutil.rmtree(root, ignore_errors=True)
    for sub in ("links", "docs", "people"):
        (root / sub).mkdir(parents=True)

    links: dict[str, dict] = defaultdict(dict)
    pids_of: dict[str, list[str]] = defaultdict(list)
    for pid, m in matched.items():
        links[fnv1a32(pid)[:shard_hex]][pid] = [m.doc, m.confidence, m.how]
        pids_of[m.doc].append(pid)
    n_links = sum(_dump(root / "links" / f"{s}.json", {"fields": LINK_FIELDS, "rows": rows}) for s, rows in links.items())

    docs: dict[str, dict] = defaultdict(dict)
    for d, e in ents.items():
        principals = sorted(e.principals, key=lambda p: p.role != "RA")
        docs[fnv1a32(d)[:shard_hex]][d] = [
            e.name, e.ftype, e.status, e.state, e.note, e.note_date, e.filed, e.report_year, e.report_date,
            1 if e.more_officers else 0, e.addr, e.mail,
            [[p.role, p.kind, p.name, p.addr, p.group] for p in principals],
        ]
    n_docs = sum(_dump(root / "docs" / f"{s}.json", {"fields": DOC_FIELDS, "rows": rows}) for s, rows in docs.items())

    people: dict[str, dict] = defaultdict(dict)
    for gid, g in enumerate(groups, start=1):
        people[key_shard(gid, shard_hex)][str(gid)] = {
            "label": g.label, "kind": g.kind, "statewide": g.statewide,
            "members": [[d, ents[d].name, roles, 1 if shared else 0, sorted(pids_of[d])] for d, roles, shared in g.members],
        }
    n_people = sum(_dump(root / "people" / f"{s}.json", rows) for s, rows in people.items())

    manifest["pipeline_version"] = __version__
    manifest["entities"] = {
        "schema": "pa2-entities/1",
        "label": "Florida Division of Corporations (Sunbiz)",
        "source_url": S.SOURCE_URL,
        "file_date": file_day.isoformat(),
        "as_of": as_of.isoformat(),
        "generated_at": report["generated_at"],
        "links": {"url": "entities/links/{shard}.json", "shard_hex": shard_hex, "hash": "fnv1a32(parcel_id)",
                  "fields": LINK_FIELDS},
        "docs": {"url": "entities/docs/{shard}.json", "shard_hex": shard_hex, "hash": "fnv1a32(doc)", "fields": DOC_FIELDS},
        "people": {"url": "entities/people/{shard}.json", "shard_hex": shard_hex, "hash": "key % 16^shard_hex"},
        "min_confidence": SUNBIZ_MIN_CONFIDENCE,
        "counts": {"entities": len(ents), "parcels": len(matched), "groups": len(groups),
                   "states": dict(Counter(e.state for e in ents.values()))},
        "coverage": {co: {k: c[k] for k in ("parcels", "company", "matched", "rate", "strong", "likely", "possible")}
                     for co, c in report["coverage"].items()},
        **({"demo": True} if demo else {}),
    }
    mf.write_text(json.dumps(manifest, separators=(",", ":")))
    log(f"  published -> {root}: links {n_links / 1e6:.1f} MB, entity records {n_docs / 1e6:.1f} MB, "
        f"principal groups {n_people / 1e6:.1f} MB")


def after_build(parcels: Path, out: Path) -> None:
    """Run after a data build: match the new roll when the Sunbiz files are there, else say how to add them."""
    cordata, corevent = find_inputs(SUNBIZ_RAW)
    if cordata is None:
        log(f"No Sunbiz files in {SUNBIZ_RAW}: the bundle has no state business records "
            "(see pipeline/build_entities.py to add them).")
    else:
        run(cordata, corevent, parcels=parcels, out=out)
    # Debt records (SEC loans already fetched, lien files already downloaded) need the state records'
    # matches; deal signals use both when there are any, and every other source regardless.
    from build_debt import run as build_debt
    from build_signals import run as build_signals

    build_debt(parcels=parcels, out=out)
    build_signals(parcels=parcels, out=out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sunbiz-dir", type=Path, default=SUNBIZ_RAW, help="folder with cordata.zip and corevent.zip")
    ap.add_argument("--cordata", type=Path, help="the corporate file (zip, text file or folder of text files)")
    ap.add_argument("--corevent", type=Path, help="the corporate events file")
    ap.add_argument("--parcels", type=Path, default=PARCELS, help="joined parcel table (default: pipeline/out/parcels.parquet)")
    ap.add_argument("--out", type=Path, default=WEB_DATA_DIR, help="data bundle folder (default: web/public/data)")
    ap.add_argument("--as-of", type=dt.date.fromisoformat, help="date for annual-report status (default: the file's date)")
    ap.add_argument("--no-publish", action="store_true", help="match and write the reports only")
    ap.add_argument("--refresh", action="store_true", help="rescan the files instead of using the cache")
    ap.add_argument("--clear", action="store_true", help="remove the published Sunbiz data from the bundle")
    ap.add_argument("--demo", action="store_true", help="mark the published data as a sample (the app stamps it)")
    args = ap.parse_args()

    if args.clear:
        clear_bundle(args.out)
        log(f"Removed the Sunbiz data from {args.out}.")
        return 0
    cordata, corevent = find_inputs(args.sunbiz_dir)
    cordata = args.cordata or cordata
    corevent = args.corevent or corevent
    if cordata is None:
        log(f"No Sunbiz corporate file in {args.sunbiz_dir}. Download cordata.zip (and corevent.zip) from\n"
            f"  {S.SOURCE_URL}\n  (Continue to Download Files, then doc > quarterly > cor) into that folder.")
        return 1
    if not args.parcels.exists():
        log(f"No joined parcel table at {args.parcels}: run the data build first.")
        return 1
    if corevent is None:
        log("No corevent.zip: inactive entities will show without the reason (dissolved, revoked, merged).")
    run(cordata, corevent, parcels=args.parcels, out=args.out, as_of=args.as_of, publish=not args.no_publish,
        refresh=args.refresh, demo=args.demo)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
