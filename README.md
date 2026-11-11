# Property Appraiser 2.0 · V0.1

3D real-estate and parcel intelligence for **Martin (53)**, **St. Lucie (66)** and **Palm Beach (60)** counties, Florida.
It is a static site (GitHub Pages, no server, no API keys) that streams parcel vector tiles from PMTiles files with HTTP Range requests.
A Python pipeline pulls the parcels from the Florida Statewide Cadastral layer (or reads FDOR tax-roll files) and writes that bundle.

- **Real parcels**: every multifamily, commercial, industrial and institutional parcel in the three counties on the 2026 roll (46,733 parcels, $109.2B assessed market value).
- 3D parcel extrusions by **assessed market value**, **building SF** or **years held** (or flat), colored by **asset class** (default), value, SF, years held or land share.
- Every parcel is outlined: class-colored strokes in 2D, and a light **roof rim** on each 3D block. House numbers and building SF label parcels from zoom 15.
- Hover tooltip: assessed market value, site address, property type, owner, county, building SF, units (multifamily and mixed use only) and years held.
- **Satellite**: a spyglass lens around the cursor (zoom 14+, toggle with `S`), a Map / Hybrid / Split basemap switch, and a live aerial of the selected parcel in the drawer.
- **Prospecting screens**: five presets a broker can mix (long-term holders, underbuilt sites, out-of-area owners, small portfolio owners, estate / trust owned) on top of every other filter; named **saved screens**; and a page link that always reopens the exact screen.
- **Owners & parcels tables** (under the map): every parcel matching the screen and search, across all three counties or only the map view, grouped into owners with related entities, parcel counts, value, building SF, asset classes, prospecting signals, longest and average hold, and mailing address. Sortable, linked to the map both ways, and exportable to CSV for a CRM or mail merge.
- **Owner profiles**: everything an owner holds in the three counties, a mini map, an acquisition timeline (last priced sale of each parcel), average hold, asset-class mix, mailing addresses and related entities; CSV export of the holdings.
- **Search** (top-left of the map, or press `/`): owner names, site addresses, cities, parcel IDs (dashed or not), property types and shared mailing addresses. Results come back grouped as owners, mailing addresses and parcels; pick one parcel to fly to it, or show an owner, a mailing address or every match on the map as a removable filter.
- **Top owners in view**: who controls the parcels on screen, after filters, ranked by assessed value, with each owner's share and the top five's combined share (ownership concentration). Group by owner name, or by mailing address to see the sponsor behind single-asset LLCs. Click an owner to open their most valuable parcel and spotlight the portfolio.
- **Sidebar** in collapsible sections (Top owners, Prospecting, County, Markets, Asset class, Screens, Display) under the live **In view** totals. Screens: minimum years held, minimum lot size, maximum building-to-land value, and whether nominal-value parcels count. Explanations sit behind ⓘ buttons.
- **Applied filters** show as removable chips over the map, with *Reset all*. The legend collapses to a button (and steps aside on its own while the drawer needs the room). A one-time hint suggests where to start.
- **Property drawer**, most decision-relevant first: address, asset class and use, then assessed market value, building SF, lot, residential units, last sale, years held and owner; then the aerial, value and building details, sale and hold, and the **true-owner portfolio** across all three counties (matched on normalized owner name *or* mailing address). Identifiers and legal text fold into *More details*; empty fields are left out.
- One-click, print-styled **Property Brief** (Letter, Save as PDF) with a 3D view and an aerial, plus shareable parcel links (`#…&p=<parcel id>`).

> `web/public/data/` holds real public tax-roll records, including owner names and owner mailing addresses as the county property appraisers publish them.
> For offline development, `pipeline/generate_sample_data.py` still writes a fully synthetic 510-parcel bundle in its place.

## Quick start

```bash
cd web
```

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173.

Pipeline setup (Python 3.10+):

```bash
python3 -m venv pipeline/.venv && pipeline/.venv/bin/pip install -r pipeline/requirements.txt
```

## Layout

```
pipeline/
  fetch_real_tricounty_parcels.py  Florida Statewide Cadastral -> web/public/data (what the site ships)
  build_fdor.py                    alternative: FDOR NAL + SDF + parcel polygon files -> web/public/data
  generate_sample_data.py          synthetic sample -> web/public/data (+ --emit-raw: FDOR-format test files)
  build_tiles.py                   re-tile from pipeline/out/parcels.parquet (e.g. after installing tippecanoe)
  sync_postgis.py                  optional: load the joined table into PostGIS / Supabase
  pa2/                             schema, DOR use codes, owner resolution, MVT encoder, PMTiles writer, publisher
web/                               Vite + TypeScript + MapLibre GL JS 6 + pmtiles
  public/data/                     manifest.json, parcels.pmtiles, points.pmtiles, parcels/*.json, owners/*.json, index.json
.github/workflows/deploy.yml       build web/ and publish to GitHub Pages
```

**Data bundle (74 MB).** Polygon tiles (z12–15, 24 MB) and centroid tiles (z8–12, 10 MB) carry only what the map filters, colors and labels.
The parcel index (`index.json`, 10.8 MB, about 2.6 MB gzipped: one row per parcel with what search, the results tables, owner profiles and CSV export need) loads the first time someone uses search or opens the tables.
Full parcel records sit in 256 small JSON shards keyed by hash(parcel ID), and owner portfolios in shards keyed by owner group.
A click fetches one shard, whatever the dataset size. The overview (zoom 8) loads under 2 MB of tiles; every file is under 25 MB.

## Real parcels: Florida Statewide Cadastral

```bash
pipeline/.venv/bin/python pipeline/fetch_real_tricounty_parcels.py
```

This queries the statewide cadastral FeatureServer (FDOR's tax roll joined to county parcel polygons, published on ArcGIS Online):
`https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0`.
It then publishes `web/public/data/` and `pipeline/out/parcels.parquet`. A first run takes a few minutes; a cached re-run takes about 30 seconds.

**What it keeps (DOR use codes).** 003 multifamily 10+, 008 multifamily 2–9, 010–039 vacant commercial and commercial (stores, centers, offices, hotels, mobile home *parks* = 028, …), 040–049 vacant industrial and industrial, 070–079 institutional.

Two codes are opt-in, because each record is one dwelling rather than an investment property:
- **004 condominium units** (`--include-condo-units`). Every unit is its own parcel: well over 85,000 more records in these counties (more than everything else combined), mostly stacked footprints of the same buildings.
- **002 individual mobile homes** (`--include-mobile-homes`, 9,500+ records).

**How it queries.** On this statewide table only `CO_NO`, `OBJECTID`, `PARCEL_ID`, `OWN_NAME` and the shape are indexed. County-wide filters on `DOR_UC` time out. Each county does occupy one contiguous `OBJECTID` block, though.
So the script walks each block in 25,000-ID windows (40 in all), pages through each window with `resultOffset` / `resultRecordCount=2000` (`outSR=4326`), and simplifies server-side by ~0.5 m.
Reliability:
- A page that keeps timing out is retried at the same offset with half the page size, down to 250.
- A window that still fails does not stop the others; failed windows get a second, sequential pass.
- If anything is still missing, nothing is published and the exit code is 1. Re-running resumes from the cache.

Downloads are cached per window under `pipeline/raw/cadastral/<fingerprint>/`. A narrower code list re-uses a broader earlier download instead of fetching again.

| Option | Use |
|---|---|
| `--include-condo-units` / `--include-mobile-homes` | Add DOR 004 / 002 (see above) |
| `--codes 003,008,…` | Any other code list |
| `--no-county-sales` / `--refresh-sales` | Skip the county sale histories / re-query Palm Beach's latest transfers (see *Sales history* below) |
| `--county-sales-dir DIR` | Where the county sales exports live (default `pipeline/raw/county_sales/`) |
| `--nominal-value-max 1000` | Just values below this are flagged *nominal value* (see *Data quality* below) |
| `--sdf "…/*SDF*.zip"` | FDOR Sales Data Files of earlier rolls, if you have them (the portal only posts the current roll) |
| `--refresh` | Ignore the cache and download everything again |
| `--allow-partial` | Publish even if some windows still fail after the retry pass |
| `--workers 4` / `--simplify 0.000005` | Parallel requests (keep it polite, ≤ 6) / server-side simplification in degrees (0 = full detail) |
| `--shard-hex 2` / `--tiler auto\|tippecanoe\|python` | Shard count (256) / tiler (tippecanoe if installed, else pure Python) |
| `--fetch-only` | Fill the cache without publishing |

Run of 10 Nov 2026 (2026 roll): Palm Beach 33,851 · St. Lucie 7,861 · Martin 5,021.
By class: Retail / Commercial 17,970 · Multifamily 2–9 12,793 · Industrial 7,908 · Vacant Commercial / Industrial 4,530 · Institutional 2,513 · Multifamily 10+ 1,019.

### Sales history and hold periods

The cadastral layer carries only the roll's two most recent sale slots (`SALE_YR1/2`): on the 2026 roll, 2025–26 sales (7% of these parcels).
The FDOR Data Portal posts only the current roll, so older SDF files are not available there either.
The three property appraisers publish much longer histories for free, and the fetch merges them by default ([pipeline/pa2/county_sales.py](pipeline/pa2/county_sales.py)):

| County | Source | What it has | Records complete from | Matched |
|---|---|---|---|---|
| Palm Beach | Property Appraiser CAMA flat file `CAMA_CSV_CERT2026.zip` ([Data Requests](https://pbcpao.gov/departments/public_services.htm) → Free Download Flat Files → CAMA → CSV Format, ~95 MB; the county file share asks you to accept its access notice first) | Each parcel's five most recent transfers: date, price, instrument, validity code | 1969 | 32,553 of 33,851 |
| Palm Beach | County GIS "Property Information Table" (ArcGIS Online, `PBCGOV_GIS`), queried by parcel number and cached | Each parcel's latest transfer (can be newer than the CAMA cut) | | 32,184 of 33,851 |
| Martin | Property Appraiser CAMA export `real_transfers.zip` ([Data Downloads](https://www.pamartinfl.gov/tools-resources/data-downloads) → Tax Roll / CAMA Database Exports → Real Transfers, ~95 MB) | Every recorded transfer, with FDOR qualification codes | 1977 | 4,821 of 5,021 |
| St. Lucie | Property Appraiser CAMA export `Transactions.zip` ([Data Requests](https://www.paslc.gov/231/Data-Requests) → Data Downloads → Transactions File, ~27 MB; its server only serves browsers, so download it by hand) | Every recorded transfer | 1972 | 7,602 of 7,861 |

Put the exports in `pipeline/raw/county_sales/palm_beach/cama/`, `…/martin/` and `…/stlucie/` (not committed). A county whose export is missing falls back to what remains (Palm Beach: latest transfers only).
"Records complete from" is computed from each export: walking back from today, the first year whose transfer count collapses below a quarter of the five years after it. Dates in the future (typos) and the 1900/1901 placeholders of converted CAMA records are ignored, as are Palm Beach `01-JAN-00`-style dates on pre-2000 deed books.

**Years held** = 2026 − year of the last sale of at least $100 (`--min-sale-price`), from whichever source has the latest one. It is never shown shorter than the records can prove:
- a last priced sale older than the county's complete records (Palm Beach 1968, say) shows as a minimum, "57+ yrs";
- with only nominal transfers since some year (a $10 deed in 2018, and nothing priced after it), the hold shows as "8+ yrs";
- a parcel no source has any transfer for shows "Not on record" and never passes the hold screen.

The drawer explains which case applies and states the county's coverage; the hold screen's ⓘ lists all three. Minimums pass the hold screen when they are long enough, and the years-held color and height modes use them too.

Run of 10 Nov 2026: years held known for **44,138 parcels (94%)**: Martin 95%, Palm Beach 94% (71% with latest transfers only), St. Lucie 96%. Minimums for 850 more; 1,745 not on record. Median hold: 11 years in Palm Beach, 8 in Martin and St. Lucie.

### Data quality

- **Nominal-value parcels.** 181 parcels carry a just value under $1,000 (`--nominal-value-max`), such as CityPlace's $100 parcels on Hibiscus Street: common areas, condo-style or sub-parcels whose value sits on a neighboring parcel. They stay on the map, but the drawer and tooltip label them "Nominal" instead of showing $100 as a price, value figures are hidden, the building-to-land screen and the In-view totals leave them out (the sidebar switch *Count nominal-value parcels* brings them back), and the value color ramp ignores them. The drawer links to the most valuable parcel within 500 m with the same owner name (or, failing that, the same non-agent mailing address) as the likely main site.
- **Units.** `NO_RES_UNTS` only counts dwelling units on multifamily (DOR 003, 008) and mixed-use (DOR 012) parcels; elsewhere it holds hotel rooms, mobile-home pads or placeholder 1s on offices and warehouses. Only those parcels show units (`residential_units`: 133,019 of the roll's 185,313), and a portfolio that mixes classes reports "residential units".

## Alternative: FDOR tax-roll files

### 1 · Download

Everything comes from the FDOR Property Tax Oversight **Data Portal**: https://floridarevenue.com/property/dataportal/Pages/default.aspx
Folder names follow the roll year (`2026F` = final 2026 roll, `2026P` = preliminary); use the newest.

| Data | Portal path | Files for counties 53 / 60 / 66 |
|---|---|---|
| **NAL**: Name-Address-Legal (values, owner, use code, physicals, recent sales) | Tax Roll Data Files → NAL → `2026F` | `Martin 53 Final NAL 2026.zip`, `Palm Beach 60 Final NAL 2026.zip`, `Saint Lucie 66 Final NAL 2026.zip` |
| **SDF**: Sales Data File | Tax Roll Data Files → SDF → `2026F` (only the current roll is posted) | `Martin 53 Final SDF 2026.zip`, `Palm Beach 60 Final SDF 2026.zip`, `Saint Lucie 66 Final SDF 2026.zip` |
| **Parcel polygons** (shapefiles) | Map Data → `2026F` → `2026F PAR` | `martin_2026Ppar.zip`, `palmbeach_2026Ppar.zip`, `stlucie_2026Ppar.zip` |
| Field definitions | User Guides → `2026 Users guide and quick reference` | NAL/SDF layouts and codes |

The Map Data folder also has a `PIN` set and a `parcel shapefiles readme.pdf` describing both. The pipeline needs **polygons**; if it is given a point layer it stops and says so.
A statewide parcel file works too: if it has a `CO_NO` column, only counties 53/60/66 are read.

### 2 · Build

Put the downloads in `pipeline/raw/` as they are. There is no need to unzip them; CSVs and shapefiles are read straight from the zips.

```bash
pipeline/.venv/bin/python pipeline/build_fdor.py
```

The build:
1. reads only the NAL columns it needs (filtered to `CO_NO` 53/60/66),
2. takes each parcel's most recent sale of at least $100 across NAL `SALE_*1/2` and every SDF given (several years work),
3. reads, repairs and reprojects the polygons and dissolves multi-part parcels,
4. joins on the normalized parcel ID (dashes and spaces removed),
5. resolves owner portfolios and writes `web/public/data/` plus `pipeline/out/parcels.parquet`.

It logs the polygon match rate per county. Condo units usually have no individual polygon, so they drop out of the map.

| Option | Use |
|---|---|
| `--classes MF10,MF2_9,COM,IND,VAC_COM` | Investment classes only: a much smaller bundle |
| `--shard-hex 3` (default) | 4,096 detail/owner shards; use `2` for small subsets |
| `--tiler tippecanoe\|python\|none` | Default `auto`. Install tippecanoe for the full roll: `brew install tippecanoe` (or build [felt/tippecanoe](https://github.com/felt/tippecanoe)); the pure-Python tiler is fine up to ~50k parcels |
| `--geom-id-field PIN` / `--assume-crs EPSG:2236` | Only if auto-detection of the parcel-ID column or the CRS fails |
| `--as-of-year 2026` / `--min-sale-price 100` | Hold-period base year / ignore nominal transfers |

Re-tile without re-reading the source: `pipeline/.venv/bin/python pipeline/build_tiles.py` (`--print-commands` prints the tippecanoe commands).

### Bundle size and hosting

Both builders overwrite only their own files in `web/public/data/`. Check the size with `du -sh web/public/data`.
The cadastral bundle (63 MB, largest file 24 MB) can be committed. The full roll (~850k parcels) is several hundred MB, and GitHub rejects files over 100 MB, while Pages sites must stay under 1 GB. For that size, pick one of:

- **GitHub Release asset (works with the included workflow).** Release assets can be up to 2 GB.
  ```bash
  tar -czf pa2-data.tar.gz -C web/public/data .
  ```
  ```bash
  gh release create data-2026F pa2-data.tar.gz --title "FDOR 2026F data bundle" --notes "Martin, St. Lucie, Palm Beach"
  ```
  Then add the repository variable `DATA_RELEASE_TAG=data-2026F` (Settings → Secrets and variables → Actions → Variables).
  The deploy workflow unpacks it over `web/public/data/` before building.
- **Object storage (R2 / S3).** Upload `web/public/data/` and set the repository variable `VITE_DATA_URL` to its public URL.
  Allow CORS `GET`/`HEAD` with the `Range` header and expose `ETag` (see the PMTiles cloud-storage docs).

## Map encoding

| Asset class | Color | DOR codes |
|---|---|---|
| Multifamily 10+ | `#4e63a9` indigo | 003 |
| Multifamily 2–9 | `#4299e5` sky blue | 008 |
| Retail & commercial (incl. office, hotels, mixed use) | `#b88448` amber | 011–039 |
| Industrial | `#ab3f6f` berry | 041–049 |
| Vacant commercial / industrial | `#2aa484` teal | 010, 040 |
| Institutional | `#bdbdbd` light gray | 070–079 |

The palette is muted for the black basemap and validated as a set for a map, where any two classes can touch (dataviz `validate_palette.js`, dark mode, surface `#0b0b0b`, all pairs): worst protanope/deuteranope separation ΔE 8.4, worst normal-vision ΔE 15.8, every color at least 3:1 against the ground. Institutional is a neutral gray, separable from all five. The earlier Tailwind set failed this: Industrial violet and Multifamily blue were nearly identical (ΔE 0.9) for deuteranopes.

- **Outlines.** In 2D every parcel has a class-colored stroke: 1.5 px at zoom 14, 2.5 px at zoom 16, thinner further out. Hover, selection and same-owner portfolio parcels switch to white.
  MapLibre cannot raise a line layer to roof height, so in 3D each parcel gets a **roof rim** instead. The rim is a 2 m band inside the boundary (shipped in the z15 tiles as features flagged `e: 1`), extruded just above the block in a lighter tint of the class color.
- **Labels** (zoom 15+): house number over building SF; where labels collide, higher-value parcels win.
- **Tooltip**: assessed market value ("Nominal value" for nominal parcels), site address, subtype (e.g. "Multifamily 10+ units" or the DOR description, such as "Community Shopping Center"), owner, then county, SF, units and years held.
- **Legend** (bottom-left, collapsible): class swatches with counts in "Asset class" mode; the metric ramp plus "Outline: asset class" in the other color modes.
- **Interface**: black and white. Near-black surfaces in a few steps (map ground `#0b0b0b`, panels `#0d0d0d`), white text and white active states, neutral grays that keep WCAG AA contrast; the asset-class colors are the only hues (plus amber for nominal-value warnings). IBM Plex Sans in sentence case for words, IBM Plex Mono for numbers and IDs. Breakpoints: the sidebar slides in below 900 px, and the drawer becomes a bottom sheet below 720 px.

## Search

The search box sits at the top-left of the map (`/` focuses it from anywhere). It matches what you type against owner names, site addresses and cities, parcel IDs, property types (the DOR use description: "hotel", "warehouse") and the shared mailing addresses from the owner index.
- **Matching.** Both sides are normalized the same way: uppercase, punctuation dropped, street types and directions abbreviated ("Street" → `ST`, "West" → `W`, "Trust" → `TR`). Every word you type must start a word in the field it matches, so "651 hibiscus" finds 651 HIBISCUS ST and "cityplace ret" finds CITYPLACE RETAIL LLC. Abbreviated words must match whole words ("trust" never matches TRUCKING). Parcel IDs match on their letters and digits, so `74-43-43-21-13-004-0060` works.
- **Results** are grouped: a *Show all N matches on the map* row, then owners (by owner name, with their total parcels and value), mailing addresses (parcels, owner names, agent flag) and parcels (best first: parcel ID, then address, then owner, then other matches; by value within each).
- **Picking** a parcel flies to it and opens the drawer. Picking an owner, a mailing address or *Show all* shows those parcels on the map as a filter and frames them: a chip names the search, the In-view totals and Top owners count only those parcels, and the chip's ×, the box's × or *Reset all* clears it. More than 10,000 matches asks for another word.
- **Keyboard:** ↑/↓ to move, Enter to pick (the first row by default), Esc to close.
- **Index.** Search reads `index.json`, the same parcel table the results use (see below), plus the shared mailing addresses. The map filter uses a `match` expression on parcel IDs, which MapLibre compiles to a lookup table.

## Prospecting screens

The sidebar's **Prospecting** section holds five preset screens. Turn on any mix: they combine with each other (a parcel must pass all of them) and with every other filter, the search and the map view. Each preset's ⓘ gives its exact rule in plain language, and an active preset shows as a chip over the map like any other filter.

| Preset | A parcel matches when | Based on |
|---|---|---|
| Long-term holders | Its last sale of $100+ is 15 or more years old (2011 or earlier), or no such sale is on record since at least then (a minimum, "N+ yrs") | County sale records, complete from 1969 (Palm Beach), 1972 (St. Lucie) and 1977 (Martin). Parcels with no sale on record are left out: an unknown hold is not a long one. |
| Underbuilt sites | Building value is at most 0.5× the land value, on a lot of 0.5 acre or more. Vacant land counts; nominal-value parcels never do. | Just value and land value on the 2026 roll |
| Out-of-area owners | The owner's mailing address is out of state, or in another Florida county | The roll's owner mailing address. Florida ZIPs (else cities) are placed in a county by this dataset's own parcels with that site ZIP, so a ZIP that crosses a county line can be misplaced; a Florida ZIP with no parcels here counts as another county. |
| Small portfolio owners | The owner name holds 2 to 10 parcels across the three counties, all in one asset class | Owner-name groups (`owner_name_key`), not mailing addresses |
| Estate / trust owned | The owner name reads as a trust or an estate: TRUST, TRUSTEE, TR, ESTATE OF, HEIRS, REVOCABLE… | The name alone. REITs, banks and trust companies, and real-estate firms are excluded; land trusts are included. |

- Thresholds: `LONG_HOLD_YEARS` and `UNDERBUILT` in web/src/config.ts; `SMALL_PORTFOLIO` in pipeline/pa2/config.py. The rules run twice, identically: as a MapLibre filter (web/src/map/layers.ts) and over `index.json` for the tables (web/src/results.ts).
- The Owners table's **Signals** column lists the flags found on each owner's matching parcels (out of state or other Florida county, estate / trust, small portfolio); sorting it puts owners with the most signals first.

**Saved screens.** *Save this screen* names and stores the filters, presets, search, owner grouping, color and height modes, the table (open, tab, scope) and the map view. Clicking a saved screen puts all of that back; × asks before deleting, and saving under an existing name replaces it.
Screens live in this browser's localStorage (`pa2.screens.v1`) for now. `ScreenRepository` in web/src/screens.ts is the only storage seam, so a shared backend can replace `LocalScreenRepository` without touching the interface.

**Shareable links.** The page link always describes the current screen: *Copy link* (or the address bar) shares it, and opening it, or pasting it into an open tab, restores the screen. Keys that hold their default are left out.

| Key | Meaning |
|---|---|
| `map` | `zoom/lat/lng[/bearing/pitch]` (MapLibre's own) |
| `co` | counties: `53` Martin, `66` St. Lucie, `60` Palm Beach |
| `cl` | asset classes, e.g. `MF10,COM` |
| `hold`, `lot`, `btl` | minimum years held, minimum lot (acres), maximum building / land value |
| `nom` | `1` counts nominal-value parcels |
| `pre` | presets: `long`, `underbuilt`, `outside`, `small`, `trust` |
| `q` | search: `q:<text>`, `owner:<owner name>` or `mail:<mailing address>`, rebuilt from the data on open |
| `g` | `addr` groups owners by mailing address |
| `x`, `c` | height and color modes |
| `t`, `sc` | open table (`owners` or `parcels`) and `view` for the map-view scope |
| `p`, `o` | open parcel; open owner profile |

MapLibre rewrites the hash, decoding it, on every map move, so values keep to characters that survive that: a space is written `+` and other special characters `~XX` ("E&J STORAGE TRUST" is `owner:E~26J+STORAGE+TRUST`).
A linked search that no longer matches anything, or now matches more than 10,000 parcels, opens the screen without it and says so.

## Owners & parcels tables

A bar along the bottom of the map opens two tables of the current screen's results: every parcel that matches the filters, screens and search, in all three counties (**All matching**) or only inside the current view (**In map view**). The sidebar's *See matching owners* button opens it too.
The tables run on `index.json` in the browser and use exactly the map's filter rules (`web/src/results.ts` `matcher` mirrors `web/src/map/layers.ts` `filterExpr`), so a screen covers parcels the map has not loaded yet. Only the rows on screen are drawn, so all 46,733 parcels scroll smoothly.

- **Owners**: one row per owner group, with the grouping set by Top owners' *By name / By address* toggle. **By name** groups the normalized owner name. **By address** groups the normalized mailing address, which shows the sponsor behind single-asset LLCs.
  - Registered-agent and manager addresses never form an owner group; their parcels fall back to the owner name. These are the 11 addresses shared by 25 or more owner names, listed as `owners.agent_addr_keys` in the manifest.
  - Columns: owner, related entities, parcels (matching, of the owner's total), assessed value, building SF, asset classes, signals, longest hold, average hold and mailing address. Related entities are other owner names at a shared mailing address, one hop and agent addresses excluded; they are shown for context and never added into the row's totals.
  - **Longest hold** shows minimums as "57+". **Average hold** counts exact holds only and says how many it used, e.g. "10 yrs, 50 of 54".
- **Parcels**: address, class, assessed value (or "Nominal"), building SF, lot, last sale (price and date, or "Not on record"), years held, owner and mailing address.
- **Sorting**: click a column header; click again to reverse.
- **Linked to the map**: clicking an owner row opens the owner profile and spotlights the group's parcels. Clicking a parcel row flies to the parcel and opens it. Selecting a parcel on the map highlights its row in both tables.
- **Export CSV** downloads the open table in its current sort, as UTF-8 with a BOM so Excel opens it correctly. Missing values are left blank, never zero. Text that a spreadsheet would run as a formula is escaped.
  - **Owners columns:** Owner name, Related entities, Matching parcels, Total parcels (all 3 counties), Assessed market value, Building SF, Residential units, Asset classes, Longest hold, Average hold; then Mailing address 1 and 2, city, state and ZIP as separate columns for mail merge; then Other mailing addresses, Out-of-area owner (out of state or other Florida county), Estate or trust, Small portfolio owner, Largest property and Grouped by.
  - **Parcels columns:** Parcel ID (county format), County, Site address, City, ZIP, Asset class, Property use, Assessed market value, Nominal-value flag, Building SF, Lot acres and SF, Residential units, Year built, Last sale date and price, Years held, Owner name, the split mailing address plus a one-line version, Out-of-area owner, Estate or trust, Small portfolio owner, Latitude, Longitude, and a Link back to the parcel in the app.

## Owner profiles

Opening an owner (from a table row, Top owners, a parcel's *Owner profile* button or a link) shows everything the group holds in the three counties, whatever the filters:
- Totals (parcels, assessed market value, building SF, units or lot area) and holds: average of the exact holds (with how many are exact) and the longest hold, as a minimum where it predates the records.
- **Where they own**: a mini map of the parcels, class-colored.
- **Asset class mix**: one bar by assessed value, with parcels, value and share per class.
- **Acquisition timeline**: each parcel's last sale of $100 or more on record, by year and price on a log scale, with a hover readout and a dated list. Parcels whose last priced sale predates the county records, and parcels with no sale on record, are counted in a note instead of plotted. Prices are as recorded: one deed covering several parcels can carry the whole price on each.
- **Entities**: for an address group, the owner names at that address; for a name group, its mailing addresses and the related entities linked through them. Any of these opens its own profile.
- **All parcels**: each opens in the property panel on top of the profile, with *Back to <owner>*.
- The map spotlights the group, and the link (`#…&o=n.<parcel id>`: the owner-name group of that parcel; `a.` for its mailing-address group) reopens the profile. **Export parcels (CSV)** downloads the holdings.

## Top owners in view

The sidebar ranks the owners of the parcels currently on screen, after every filter, by assessed market value: each row shows the owner, parcel count, residential units, value and share of the value in view, with a bar scaled to the leader.
The footer gives the top five owners' combined share, a quick read on ownership concentration. Pan, zoom or change a filter and the ranking follows (it is computed from the same rendered parcels as the In-view totals).

- **By name** groups parcels whose normalized owner names match (`owner_name_key` in the tiles).
- **By address** groups parcels mailed to the same normalized address (`owner_addr_key`), which often reveals the sponsor behind single-asset LLCs: downtown West Palm Beach puts CityPlace's four entities together (17 parcels, $390M). Rows note how many other owner names share the address, and flag addresses shared by 25+ names as a likely registered agent or manager.
- Parcels with no portfolio key are their own row (an owner with one parcel). Nominal-value parcels follow the *Count nominal-value parcels* switch.
- Owner names come from the parcel tiles at zoom 12+; further out they are looked up in the owner index and parcel records, and cached.
- Clicking a row opens that owner's most valuable parcel in view and spotlights the portfolio on the map.

## Satellite imagery

- **Spyglass lens.** Press `S` or use the top-bar *Satellite lens* button (hidden on touch screens, which have no hover). From zoom 14, a 120 px-radius circle around the cursor shows imagery with white parcel lines.
  It is a second, non-interactive map, camera-locked to the main one and clipped to the circle, so hover and click still reach the parcels. The tooltip moves out of its way.
- **Basemap switch** (top-left): **Map** (black and white), **Hybrid** (imagery + white street and place labels + class outlines over translucent fills), **Split** (dark left, imagery right; drag the divider or use the arrow keys).
- **Drawer aerial**: a live thumbnail fitted to the selected parcel (220 px, below the key facts), boundary in white. The brief prints it next to the 3D view.

Imagery: Esri World Imagery tiles (`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`), keyless, credited on the map as "Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community".
Esri's terms of use apply to this service. Check them before a public or commercial launch; keyed access is available through an ArcGIS Location Platform account if needed.

## Deploy to GitHub Pages

1. Push to GitHub, then set **Settings → Pages → Source: GitHub Actions**.
2. Every push to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml): it fetches the release bundle if `DATA_RELEASE_TAG` is set, builds `web/` and publishes `web/dist`.

Asset paths are relative (`base: './'`), so the site works under `/<repo>/` or a custom domain.
For a local check of the production build, use `npm run preview`; Python's `http.server` does not support Range requests, which PMTiles needs.

Right after a data deploy, a Range request can come back as the whole file (HTTP 200). Chrome does this when it revalidates ranges it cached from the previous file, and so can a CDN edge that hasn't cached the new one yet.
Plain pmtiles would give up and leave the map empty until a reload. [web/src/map/pmtilesSource.ts](web/src/map/pmtilesSource.ts) retries those requests past the browser cache instead.

## Data model

Derived fields (pipeline/pa2/schema.py):

| Field | Definition |
|---|---|
| `assessed_value` | `AV_NSD`, assessed value for non-school levies |
| `building_value` | `JV − LND_VAL` (floored at 0) |
| `land_to_value_ratio` | `LND_VAL / JV` |
| `bldg_to_land_ratio` | `(JV − LND_VAL) / LND_VAL`: the map's "max building / land value" screen |
| `hold_period_years` | `2026 − year of last sale of $100+` (`--as-of-year`, `--min-sale-price`), when that sale falls within the county's complete records |
| `no_sale_since` / `hold_floor_years` | Otherwise: the year from which no such sale is on record, and `2026 −` that year (a minimum, shown as "N+ yrs"; tiles carry it as `hf`) |
| `sales_from` | Year from which the county's sale records are complete (Palm Beach 1969, St. Lucie 1972, Martin 1977) |
| `residential_units` | `NO_RES_UNTS` on multifamily and mixed-use (DOR 012) parcels, else null; tiles carry it as `u` |
| `nominal_value` | `JV` below `--nominal-value-max` (parquet only; the frontend compares `jv` with the manifest's `data_quality.nominal_value_max`) |
| `last_sale_qualified` | `true` for FDOR code 01 or a Palm Beach `Q*` validity code, `false` for 11+ or `D*` / `U*`, otherwise null (raw code kept) |
| `out_of_area` | `2` when the owner's mailing state is not FL; `1` when it is FL and the mailing ZIP (else city) belongs to another county, judged by this dataset's own parcels with that site ZIP (city); unknown with no ZIP or city. Tiles and index carry it as `oa` (pipeline/pa2/publish.py `prospect_flags`) |
| `small_portfolio` | `1` when the parcel's owner-name group has 2–10 parcels, all in one asset class (`spf`) |
| `estate_trust` | `1` when the owner name reads as a trust or an estate (`estate_trust` in pipeline/pa2/publish.py; `et`) |
| `tot_lvg_area` | `TOT_LVG_AR`; values under 10 SF are treated as not reported. The 2026 roll carries `1` on ~7k improved office, warehouse and retail parcels. |

Other asset classes appear when their codes are fetched: Single Family 001, Condo 004–005, other residential 000, 002, 006–009, and 050–099.

**Owner resolution** (pipeline/pa2/entity.py). Names are uppercased, punctuation is stripped, and entity suffixes are unified (`L.L.C.`/`Limited Liability Company` → `LLC`, `Trustee` → `TR`, …).
Mailing addresses are standardized: `SUITE`/`STE`/`#` → `#`, directionals and street types abbreviated, `P.O. Box` → `PO BOX`, `C/O` lines skipped, ZIP5.
Groups of 2+ parcels get integer keys stored in the tiles, so a click highlights the whole portfolio across all three counties.
An address shared by 25+ distinct owner names is flagged as a likely manager or registered-agent address.
Swap in Sunbiz officer/agent matching or fuzzy matching here later.

## Optional: PostGIS / Supabase

```bash
pipeline/.venv/bin/pip install -r pipeline/requirements-postgis.txt
```

```bash
PA2_DATABASE_URL='postgresql://…' pipeline/.venv/bin/python pipeline/sync_postgis.py
```

This creates `pa2_parcels` (indexed), the view `pa2_owner_portfolios` and the function `pa2_portfolio(parcel_id)` (see pipeline/sql/).

## Notes and limits (V0.1)

- Basemap: OpenFreeMap vector tiles (no key), restyled monochrome. Override with `VITE_BASEMAP_STYLE` (any MapLibre style URL).
- Sale history: see *Sales history and hold periods*. Palm Beach's CAMA file keeps five transfers per parcel, so a parcel with five nominal transfers in a row keeps a minimum hold rather than its last priced sale.
- Last-sale prices are as recorded: a deed covering several parcels may carry the whole package's price on each of them.
- Condo units (004) and individual mobile homes (002) are excluded by default; see the opt-in flags.
- Not yet included: comps and fuzzy/Sunbiz entity matching. Search matches word beginnings, not misspellings.
- Saved screens stay in the browser that saved them until a backend replaces `LocalScreenRepository`; share a screen with its link.
- Prospecting flags read names and mailing addresses as the roll publishes them: a trust owned through an LLC is not flagged, and a local owner who mails tax bills to an out-of-state office is.
