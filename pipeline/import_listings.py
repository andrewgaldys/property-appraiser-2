#!/usr/bin/env python3
"""Publish for-sale and for-lease listings beside the parcel bundle.

    python pipeline/import_listings.py                      every file in pipeline/listings/
    python pipeline/import_listings.py my.csv --source "Acme Realty" --kind own --as-of 2026-11-15
    python pipeline/import_listings.py --clear              back to "no listing source connected"
    python pipeline/import_listings.py --dry-run            match and report, write nothing

Reads CSV or JSON files you have the right to publish (see pipeline/listings/README.md for the
columns), matches every row to a parcel of the published bundle by parcel ID or street address,
and writes web/public/data/listings/. Rows that cannot be matched without guessing are listed in
pipeline/out/listings_report.csv, with the reason, and are not published.

Each file is one source. Name it with --source, or with a file beside it called
<file>.meta.json: {"name": "...", "kind": "own|mls|vendor|other", "as_of": "YYYY-MM-DD",
"note": "...", "disclaimer": "...", "url": "..."}.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from pa2 import listings as L  # noqa: E402

DEFAULT_DIR = HERE / "listings"
DEFAULT_DATA = HERE.parent / "web" / "public" / "data"
REPORT = HERE / "out" / "listings_report.csv"
SKIP = {"TEMPLATE.csv"}


def source_for(path: Path, args: argparse.Namespace) -> L.Source:
    meta: dict = {}
    side = path.with_name(path.name + ".meta.json")
    if not side.is_file():
        side = path.with_suffix(".meta.json")
    if side.is_file():
        meta = json.loads(side.read_text(encoding="utf-8"))
    name = args.source or meta.get("name") or path.stem.replace("_", " ").replace("-", " ").strip().title()
    return L.Source(
        name=name,
        kind=args.kind or meta.get("kind") or "other",
        as_of=args.as_of or meta.get("as_of") or "",
        note=args.note or meta.get("note") or "",
        disclaimer=args.disclaimer or meta.get("disclaimer") or "",
        url=args.url or meta.get("url") or "",
        logo=args.logo or meta.get("logo") or "",
        demo=bool(args.demo or meta.get("demo")),
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*", type=Path, help=f"listing files (default: every .csv / .json in {DEFAULT_DIR.relative_to(HERE.parent)})")
    ap.add_argument("--data", type=Path, default=DEFAULT_DATA, help="the published data bundle (default: web/public/data)")
    ap.add_argument("--source", help="name of the source, as the panel shows it (one file only)")
    ap.add_argument("--kind", choices=L.SOURCE_KINDS, help="own listings, an MLS feed, a licensed vendor, or other")
    ap.add_argument("--as-of", help="date the file was pulled, YYYY-MM-DD (default: the file's own date)")
    ap.add_argument("--note", help="one line about the source, shown in the panel's footnote")
    ap.add_argument("--disclaimer", help="wording the source requires next to its listings")
    ap.add_argument("--url", help="the source's own website")
    ap.add_argument("--logo", help="https address of the source's logo (MLS display rules ask for it beside its listings)")
    ap.add_argument("--operator", default=os.environ.get("LISTINGS_OPERATOR", ""),
                    help="the brokerage the site shows listings under, which MLS rules ask for (default: $LISTINGS_OPERATOR)")
    ap.add_argument("--operator-contact", default=os.environ.get("LISTINGS_OPERATOR_CONTACT", ""),
                    help="its phone or email (default: $LISTINGS_OPERATOR_CONTACT)")
    ap.add_argument("--demo", action="store_true", help="made-up rows for a local preview: every card is stamped as sample data")
    ap.add_argument("--clear", action="store_true", help='remove all listings: the panel says "no listing source connected"')
    ap.add_argument("--dry-run", action="store_true", help="match and report, write nothing")
    args = ap.parse_args()

    if args.clear:
        if args.files:
            ap.error("--clear takes no files")
        if not args.dry_run:
            L.write(args.data, L.empty_index(), {})
        print(f"Listings cleared: {args.data / L.OUT_DIRNAME / 'index.json'} now says no source is connected.")
        return 0

    args.files = [p for p in args.files if not p.name.endswith(".meta.json")]  # sidecars, read with their file
    paths = args.files or sorted(p for p in DEFAULT_DIR.glob("*") if p.suffix.lower() in (".csv", ".json") and p.name not in SKIP and not p.name.endswith(".meta.json"))
    missing = [p for p in paths if not p.is_file()]
    if missing:
        ap.error(f"not found: {', '.join(map(str, missing))}")
    if not paths:
        print(f"No listing files in {DEFAULT_DIR}. Put a CSV there (see {DEFAULT_DIR / 'README.md'}), or run with --clear.")
        return 1
    if len(paths) > 1 and args.source:
        ap.error("--source names one file; give each file a .meta.json when there are several")

    sources = [(p, source_for(p, args)) for p in paths]
    for p, s in sources:
        if s.kind not in L.SOURCE_KINDS:
            ap.error(f"{p.name}: source kind '{s.kind}' is not one of {', '.join(L.SOURCE_KINDS)}")
    print(f"Reading the parcels in {args.data} ...")
    try:
        lookup = L.ParcelLookup.from_bundle(args.data)
        result = L.build(sources, lookup, operator={"name": args.operator.strip(), "contact": args.operator_contact.strip()})
    except (FileNotFoundError, ValueError) as err:
        print(f"Stopped: {err}")
        return 2
    counts = result.index["counts"]
    for line in result.notes:
        print(line)
    print(f"Published: {counts['listings']:,} listings ({counts['sale']:,} for sale, {counts['lease']:,} for lease) on {counts['parcels']:,} parcels.")

    for s in result.index["sources"]:
        if s["kind"] in ("mls", "vendor") and not s.get("disclaimer"):
            print(f"Check: '{s['name']}' is an {s['kind'].upper() if s['kind'] == 'mls' else 'outside'} source with no --disclaimer. "
                  "MLS and vendor licences usually require specific wording and the listing firm's name next to each listing.")
    hosts = {"loopnet.com": "LoopNet", "costar.com": "CoStar"}
    url_at = L.LISTING_FIELDS.index("url")
    linked = {name for shard in result.shards.values() for rows in shard.values() for row in rows
              for host, name in hosts.items() if row[url_at] and host in row[url_at].lower()}
    if linked:
        print(f"Check: some listings link to {' and '.join(sorted(linked))}. Its terms allow links to a listing only from sites that "
              "are not its competitors, and ask that they be removed on request.")

    if result.rejected:
        if not args.dry_run:
            REPORT.parent.mkdir(parents=True, exist_ok=True)
            with REPORT.open("w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["file", "row", "address", "listing id", "not published because", "parcels it could be"])
                for r in result.rejected:
                    w.writerow([r.file, r.row, r.address, r.listing_id, r.reason, r.candidates])
        reasons: dict[str, int] = {}
        for r in result.rejected:
            key = re.sub(r"^\d[\d,]*", "several", r.reason.split(":")[0].split("(")[0].strip())
            reasons[key] = reasons.get(key, 0) + 1
        print(f"Not published: {len(result.rejected):,} rows" + ("" if args.dry_run else f" (listed in {REPORT.relative_to(HERE.parent)})"))
        for reason, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
            print(f"  {n:>6,}  {reason}")
    elif REPORT.is_file() and not args.dry_run:
        REPORT.unlink()

    if args.dry_run:
        print("Dry run: nothing written.")
        return 0
    size = L.write(args.data, result.index, result.shards)
    print(f"Wrote {args.data / L.OUT_DIRNAME} ({len(result.shards)} shard{'s' if len(result.shards) != 1 else ''}, {size / 1024:.0f} KB).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
