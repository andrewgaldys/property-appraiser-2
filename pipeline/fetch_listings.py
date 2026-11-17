#!/usr/bin/env python3
"""Pull what is on the market from your licensed listing feeds, then publish it to the map.

    python pipeline/fetch_listings.py                 every feed that is set up, then publish
    python pipeline/fetch_listings.py --check         say which feeds are set up; fetch nothing
    python pipeline/fetch_listings.py resimplifi      one feed
    python pipeline/fetch_listings.py --no-publish    fetch only (run import_listings.py yourself)

A feed is "set up" when its credentials are in the environment (never in a file in this repo).
Every feed that is set up is pulled, and the same listing found in several feeds shows once:

    resimplifi   RESIMPLIFI_API_KEY                           Resimplifi Serve API (commercial, sale and lease)
    trestle      TRESTLE_CLIENT_ID, TRESTLE_CLIENT_SECRET     your MLS's feed on Trestle (brokers at MIAMI REALTORS)
    bridge       BRIDGE_SERVER_TOKEN, BRIDGE_DATASET          your MLS's feed on Bridge (agents at MIAMI REALTORS)
    spark        SPARK_ACCESS_TOKEN                           an MLS on Flexmls, through the Spark API (BeachesMLS)
    reso-<key>   RESO_FEEDS                                   any other MLS's RESO Web API (a JSON list; see pa2/feeds.py)

Optional: MLS_SOURCE_NAME, MLS_DISCLAIMER, MLS_SOURCE_URL, MLS_LOGO_URL (how the panel names the MLS on
Trestle or Bridge, the notice its rules require and its logo), the same with SPARK_ for Spark,
MLS_PROPERTY_TYPES / MLS_STATUSES (exact values; by default the MLS's own metadata decides),
SPARK_REPLICATION=on for a Spark key with the replication role, RESIMPLIFI_SOURCE_NAME, RESIMPLIFI_DISCLAIMER.

Each feed lands in pipeline/listings/feed_<name>.json, replacing the last pull, and import_listings.py
then matches every file in that folder to parcels. A feed that fails, comes back empty, or returns
under half of what it did last time stops the run before anything is published, so an outage
never wipes the listings off the map.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from pa2 import feeds as F  # noqa: E402

DEFAULT_DIR = HERE / "listings"
DEFAULT_DATA = HERE.parent / "web" / "public" / "data"


def previous_count(path: Path) -> int:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        return len(doc["value"]) if isinstance(doc, dict) else len(doc)
    except (OSError, ValueError, KeyError, TypeError):
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("feeds", nargs="*", help="feeds to pull: resimplifi, trestle, bridge, spark, reso-<key> (default: every one that is set up)")
    ap.add_argument("--data", type=Path, default=DEFAULT_DATA, help="the published data bundle (default: web/public/data)")
    ap.add_argument("--out", type=Path, default=DEFAULT_DIR, help="where feed files go (default: pipeline/listings)")
    ap.add_argument("--check", action="store_true", help="say which feeds are set up; fetch nothing")
    ap.add_argument("--no-publish", action="store_true", help="fetch only; do not run import_listings.py")
    ap.add_argument("--if-configured", action="store_true", help="exit quietly when no feed is set up (for the deploy workflow)")
    ap.add_argument("--allow-empty", action="store_true", help="accept a feed that returns nothing")
    ap.add_argument("--force", action="store_true", help="accept a feed that returns under half of its last pull")
    args = ap.parse_args()

    env = dict(os.environ)
    ready = F.configured(env)
    if args.check:
        for name, needs in F.REQUIRES.items():
            missing = [k for k in needs if not F.setting(env, k)]
            print(f"{name:<14} {'set up' if not missing else 'not set up: missing ' + ', '.join(missing)}")
        try:
            custom = F.custom_feeds(env)
        except F.FeedError as err:
            print(f"{'RESO_FEEDS':<14} cannot be read: {err}")
            return 3
        for name, item in custom.items():
            print(f"{name:<14} set up ({item.get('name') or 'MLS feed'})")
        if not custom:
            print(f"{'reso-<key>':<14} none (RESO_FEEDS is empty)")
        return 0

    wanted = args.feeds or ready
    not_ready = [n for n in wanted if n not in ready]
    if not_ready:
        needs = [k for n in not_ready for k in F.REQUIRES.get(n, ("RESO_FEEDS",))]
        print(f"Not set up: {', '.join(not_ready)}. Needs {', '.join(dict.fromkeys(needs))} in the environment (--check lists them).")
        return 3
    if not wanted:
        if args.if_configured:
            print("No listing feed is set up: keeping the listings already in the bundle.")
            return 0
        print("No listing feed is set up. Run with --check to see what each feed needs.")
        return 3

    for name in wanted:
        print(f"Fetching {name} ...")
        try:
            feed = F.fetch(name, env, args.data, print)
        except F.FeedError as err:
            print(f"Stopped: {err}. Nothing was published.")
            return 2
        path = args.out / f"feed_{feed.key}.json"
        before = previous_count(path)
        if not feed.rows and not args.allow_empty:
            print(f"Stopped: {name} returned no listings. That is more likely a filter or licence problem than an empty "
                  "market, so nothing was published (--allow-empty to accept it).")
            return 2
        if before >= 50 and len(feed.rows) < before / 2 and not args.force:
            print(f"Stopped: {name} returned {len(feed.rows):,} listings, under half of the {before:,} in the last pull. "
                  "Nothing was published (--force to accept it).")
            return 2
        F.write_feed(feed, args.out)
        print(f"  {name}: {len(feed.rows):,} listings -> {path.relative_to(HERE.parent) if path.is_relative_to(HERE.parent) else path}")

    if args.no_publish:
        return 0
    files = sorted(p for p in args.out.glob("*") if p.suffix.lower() in (".csv", ".json") and p.name != "TEMPLATE.csv" and not p.name.endswith(".meta.json"))
    return subprocess.call([sys.executable, str(HERE / "import_listings.py"), *map(str, files), "--data", str(args.data)])


if __name__ == "__main__":
    raise SystemExit(main())
