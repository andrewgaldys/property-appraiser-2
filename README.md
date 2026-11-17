# Property Appraiser 2.0 · V0.1

3D real-estate and parcel intelligence for Florida's Atlantic coast from **Indian River** down to **Miami-Dade**: Indian River (41), St. Lucie (66), Martin (53), Palm Beach (60), Broward (16) and Miami-Dade (23) counties.
It is a static site (GitHub Pages, no server, no API keys) that streams parcel vector tiles from PMTiles files with HTTP Range requests.
A Python pipeline pulls the parcels from the Florida Statewide Cadastral layer (or reads FDOR tax-roll files) and writes that bundle.

- **Real parcels**: every multifamily, commercial, industrial and institutional parcel in the six counties on the 2026 roll (174,215 parcels, $447.6B assessed market value).
- 3D parcel extrusions by **assessed market value**, **building SF** or **years held** (or flat), colored by **asset class** (default), value, SF, years held or land share.
- Every parcel is outlined: class-colored strokes in 2D, and a light **roof rim** on each 3D block. House numbers and building SF label parcels from zoom 15.
- Hover tooltip: assessed market value, site address, property type, owner, county, building SF, units (multifamily and mixed use only) and years held.
- **Satellite**: a spyglass lens around the cursor (zoom 14+, toggle with `S`), a Map / Hybrid / Split basemap switch, and a live aerial of the selected parcel in the drawer.
- **Prospecting screens**: five presets a broker can mix (long-term holders, underbuilt sites, out-of-area owners, small portfolio owners, estate / trust owned) on top of every other filter; named **saved screens**; and a page link that always reopens the exact screen.
- **Owners & parcels tables** (under the map): every parcel matching the screen and search, across all six counties or only the map view, grouped into owners with related entities, parcel counts, value, building SF, asset classes, prospecting signals, longest and average hold, and mailing address. Sortable, linked to the map both ways, and exportable to CSV for a CRM or mail merge.
- **State business records** (Sunbiz): company owners are matched to the Florida Division of Corporations' free quarterly data files. The parcel panel and the owner profile show the entity's status (active, annual report overdue, administratively dissolved, inactive), filing date, last annual report, officers or managers and registered agent, and how sure the match is. The owner profile lists **related entities via** each principal: other owners whose records name the same person or company. Every owner also keeps a link to Sunbiz's own search to verify it.
- **Owner profiles**: everything an owner holds in the six counties, a mini map, an acquisition timeline (last priced sale of each parcel), average hold, asset-class mix, mailing addresses and related entities; CSV export of the holdings.
- **Map first**: the page opens as the map, a search box and a slim rail. Filters, Insights, Saved screens and Map options each open from the rail as one pop-up panel at a time; the Owners list and the guide open from it too. On phones the rail is a bottom bar and panels rise from it.
- **Search** (top-left of the map, or press `/`): owner names, site addresses, cities, parcel IDs (dashed or not), property types and shared mailing addresses. Results come back grouped as owners, mailing addresses and parcels; pick one parcel to fly to it, or show an owner, a mailing address or every match on the map as a removable filter.
- **Top owners in view**: who controls the parcels on screen, after filters, ranked by assessed value, with each owner's share and the top five's combined share (ownership concentration). Group by owner name, or by mailing address to see the sponsor behind single-asset LLCs. Click an owner to open their most valuable parcel and spotlight the portfolio.
- **Panels** (from the rail). *Filters*: a guided flow of *01 Location* (any mix of counties, north to south, and each county's largest markets), *02 Asset class*, *03 Owner signals*, then *More filters* (minimum years held, minimum lot size, maximum building-to-land value, nominal-value parcels), with a **See matching owners** button and the match count pinned at the bottom. *Insights*: live totals for the map view and Top owners. *Saved*: saved screens and four one-click starter screens. *Map*: basemap, satellite lens, what height and color show, and the legend. Explanations sit behind ⓘ buttons, and **Help** (or the ? key) explains the workflow, the map and each county's data coverage.
- **Applied filters** show as removable chips beside the search box ("Showing …"), with *Reset all*, and the Filters button carries their count; when nothing matches, the map says so and offers a reset. A one-line first-visit strip points to the starter lists and the guide.
- **Property drawer**, most decision-relevant first: address, asset class and use, then assessed market value, building SF, lot, residential units, last sale, years held and owner; then the aerial, value and building details, sale and hold, and the **true-owner portfolio** across all six counties (matched on normalized owner name *or* mailing address). Identifiers and legal text fold into *More details*; empty fields are left out.
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
  build_entities.py                Sunbiz quarterly files + the joined roll -> web/public/data/entities (state business records)
  build_signals.py                 deal signals (entity status, holds, values, flood, coast, tax certificates) -> web/public/data/signals
  generate_sample_data.py          synthetic sample -> web/public/data (+ --emit-raw: FDOR-format test files)
  build_tiles.py                   re-tile from pipeline/out/parcels.parquet (e.g. after installing tippecanoe)
  sync_postgis.py                  optional: load the joined table into PostGIS / Supabase
  pa2/                             schema, DOR use codes, owner resolution, Sunbiz reader and matcher, MVT encoder, PMTiles writer, publisher
web/                               Vite + TypeScript + MapLibre GL JS 6 + pmtiles
  public/data/                     manifest.json, parcels.pmtiles, points.pmtiles, parcels/*.json, owners/*.json, index.json,
                                   entities/ (links/, docs/, people/: state business records, when built),
                                   signals/ (flags.json, detail/: deal signals, when built)
.github/workflows/deploy.yml       build web/ and publish to GitHub Pages
```

**Data bundle (about 266 MB for six counties).** Polygon tiles (z12–15, 85 MB) and centroid tiles (z8–12, 36 MB) carry only what the map filters, colors and labels.
The parcel index (`index.json`, 41 MB, about 10 MB gzipped: one row per parcel with what the totals, search, the results tables, owner profiles and CSV export need) is fetched once, shortly after the map appears, with a progress readout in the results bar.
Full parcel records sit in 256 JSON shards keyed by hash(parcel ID) (83 MB), and owner portfolios in shards keyed by owner group (31 MB). A click fetches one shard, whatever the dataset size.
The largest file is the 85 MB polygon archive: under GitHub's 100 MB limit, but see *Bundle size and hosting* before adding more counties or condo units.

## Real parcels: Florida Statewide Cadastral

```bash
pipeline/.venv/bin/python pipeline/fetch_real_tricounty_parcels.py
```

This queries the statewide cadastral FeatureServer (FDOR's tax roll joined to county parcel polygons, published on ArcGIS Online):
`https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0`.
It then publishes `web/public/data/` and `pipeline/out/parcels.parquet`. Counties come from `COUNTIES` in pipeline/pa2/config.py (`--counties 60,16` runs a subset).
A first run downloads for about 15 minutes and queries the county sale tables for a few more; a cached re-run takes about 2 minutes.

**What it keeps (DOR use codes).** 003 multifamily 10+, 008 multifamily 2–9, 010–039 vacant commercial and commercial (stores, centers, offices, hotels, mobile home *parks* = 028, …), 040–049 vacant industrial and industrial, 070–079 institutional.

Two codes are opt-in, because each record is one dwelling rather than an investment property:
- **004 condominium units** (`--include-condo-units`). Every unit is its own parcel: well over 85,000 more records in Martin, St. Lucie and Palm Beach alone (more than everything else there combined), mostly stacked footprints of the same buildings.
- **002 individual mobile homes** (`--include-mobile-homes`, 9,500+ records).

**How it queries.** On this statewide table only `CO_NO`, `OBJECTID`, `PARCEL_ID`, `OWN_NAME` and the shape are indexed. County-wide filters on `DOR_UC` time out. Each county does occupy one contiguous `OBJECTID` block, though.
So the script walks each block in 25,000-ID windows (100 in all), pages through each window with `resultOffset` / `resultRecordCount=2000` (`outSR=4326`), and simplifies server-side by ~0.5 m.
Reliability:
- A page that keeps timing out is retried at the same offset with half the page size, down to 250. The size that worked is remembered per county, and counties over 400,000 parcels (Broward, Miami-Dade, Palm Beach) start at 1,000: their full pages time out.
- A window that still fails does not stop the others; failed windows get a second, sequential pass.
- If anything is still missing, nothing is published and the exit code is 1. Re-running resumes from the cache.

Downloads are cached per window under `pipeline/raw/cadastral/<fingerprint>/`. A narrower code list re-uses a broader earlier download instead of fetching again.

| Option | Use |
|---|---|
| `--include-condo-units` / `--include-mobile-homes` | Add DOR 004 / 002 (see above) |
| `--codes 003,008,…` | Any other code list |
| `--no-county-sales` / `--refresh-sales` | Skip the county sale histories / re-query the county GIS sale tables: Palm Beach, Broward, Miami-Dade, Indian River (see *Sales history* below) |
| `--county-sales-dir DIR` | Where the county sales exports live (default `pipeline/raw/county_sales/`) |
| `--nominal-value-max 1000` | Just values below this are flagged *nominal value* (see *Data quality* below) |
| `--sdf "…/*SDF*.zip"` | FDOR Sales Data Files of earlier rolls, if you have them (the portal only posts the current roll) |
| `--refresh` | Ignore the cache and download everything again |
| `--allow-partial` | Publish even if some windows still fail after the retry pass |
| `--workers 4` / `--simplify 0.000005` | Parallel requests (keep it polite, ≤ 6) / server-side simplification in degrees (0 = full detail) |
| `--shard-hex 2` / `--tiler auto\|tippecanoe\|python` | Shard count (256) / tiler (tippecanoe if installed, else pure Python) |
| `--fetch-only` | Fill the cache without publishing |

Run of 15 Nov 2026 (2026 roll): Miami-Dade 69,638 · Broward 53,258 · Palm Beach 33,851 · St. Lucie 7,861 · Martin 5,021 · Indian River 4,586.
By class: Multifamily 2–9 61,550 · Retail / Commercial 57,674 · Industrial 24,424 · Vacant Commercial / Industrial 16,731 · Institutional 7,386 · Multifamily 10+ 6,450.

### Sales history and hold periods

The cadastral layer carries only the roll's two most recent sale slots (`SALE_YR1/2`): on the 2026 roll, 2025–26 sales (7% of these parcels).
The FDOR Data Portal posts only the current roll, so older SDF files are not available there either.
The counties publish much longer histories for free, and the fetch merges them by default ([pipeline/pa2/county_sales.py](pipeline/pa2/county_sales.py)):

| County | Source | What it has | Records complete from | Matched |
|---|---|---|---|---|
| Palm Beach | Property Appraiser CAMA flat file `CAMA_CSV_CERT2026.zip` ([Data Requests](https://pbcpao.gov/departments/public_services.htm) → Free Download Flat Files → CAMA → CSV Format, ~95 MB; the county file share asks you to accept its access notice first) | Each parcel's five most recent transfers: date, price, instrument, validity code | 1969 | 32,553 of 33,851 |
| Palm Beach | County GIS "Property Information Table" (ArcGIS Online, `PBCGOV_GIS`), queried by parcel number and cached | Each parcel's latest transfer (can be newer than the CAMA cut) | | 32,184 of 33,851 |
| Martin | Property Appraiser CAMA export `real_transfers.zip` ([Data Downloads](https://www.pamartinfl.gov/tools-resources/data-downloads) → Tax Roll / CAMA Database Exports → Real Transfers, ~95 MB) | Every recorded transfer, with FDOR qualification codes | 1977 | 4,821 of 5,021 |
| St. Lucie | Property Appraiser CAMA export `Transactions.zip` ([Data Requests](https://www.paslc.gov/231/Data-Requests) → Data Downloads → Transactions File, ~27 MB; its server only serves browsers, so download it by hand) | Every recorded transfer | 1972 | 7,602 of 7,861 |
| Broward | County GIS layer "PARCEL POLY BCPA TAXROLL" (Broward County on ArcGIS Online: the Property Appraiser's tax roll joined to parcels), queried by folio and cached | Each parcel's five most recent transfers through 2024: date, documentary stamps paid, qualification code | 1960 | 44,086 of 53,258 |
| Miami-Dade | County open data "Property Point View" (`PaGISView`, updated weekly), queried by folio and cached | Each folio's latest transfer: date and price (0 on nominal transfers) | latest transfer only | 66,839 of 69,638 |
| Indian River | County GIS parcel service (`IRCPA/Parcels_MS`), queried by parcel number and cached | Each parcel's latest sale: year, month, price | latest sale only | 3,590 of 4,586 |

Put the exports in `pipeline/raw/county_sales/palm_beach/cama/`, `…/martin/` and `…/stlucie/` (not committed). A county whose export is missing falls back to what remains (Palm Beach: latest transfers only). The three GIS tables need no download: their answers are cached in `…/broward/`, `…/miami_dade/` and `…/indian_river/`.

- **Broward prices come from documentary stamps.** The layer publishes the stamps paid on each deed, not the price. Price = stamps ÷ the statutory rate in force on the deed date (70¢ per $100 since August 1992, 60¢ from June 1991, 55¢ from July 1987, and so on back: `DOC_STAMP_RATES`; the data's own minimum stamps match that schedule year by year). A deed that paid only the minimum is a nominal transfer, not a $100 sale. The layer stops at 2024; 2025–26 sales come from the state roll.
- **Latest-transfer counties (Miami-Dade, Indian River).** A priced latest transfer is the last sale, at any age. A nominal one (a deed into an LLC, say) hides the sale before it, so the hold becomes a minimum counted from that transfer, and a long-time owner can fall out of the *Long-term holders* screen. Indian River's Property Appraiser publishes a full CAMA extract ([Downloads](https://www.ircpa.org/site-links/downloads), browser download only) that could replace its latest-sale table.
"Records complete from" is computed from each export: walking back from today, the first year whose transfer count collapses below a quarter of the five years after it. Dates in the future (typos) and the 1900/1901 placeholders of converted CAMA records are ignored, as are Palm Beach `01-JAN-00`-style dates on pre-2000 deed books.

**Years held** = 2026 − year of the last sale of at least $100 (`--min-sale-price`), from whichever source has the latest one. It is never shown shorter than the records can prove:
- a last priced sale older than the county's complete records (Palm Beach 1968, say) shows as a minimum, "57+ yrs";
- with only nominal transfers since some year (a $10 deed in 2018, and nothing priced after it), the hold shows as "8+ yrs";
- a parcel no source has any transfer for shows "Not on record" and never passes the hold screen.

The drawer explains which case applies and states the county's coverage; the hold screen's ⓘ and *How it works* list every county's. Minimums pass the hold screen when they are long enough, and the years-held color and height modes use them too.

Run of 15 Nov 2026: years held known for **150,376 parcels (86%)**; minimums for 9,941 more (6%); 13,898 not on record (8%). The three northern counties with full exports stay at 94–96% known; Broward, Miami-Dade and Indian River depend on what their GIS tables match.

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
The six-county cadastral bundle (about 266 MB, largest file 85 MB) can still be committed, but each rebuild adds roughly 170 MB to the repository's history, and GitHub rejects files over 100 MB, while Pages sites must stay under 1 GB. The full roll, more counties or condo units go past those limits. Before that, pick one of:

- **GitHub Release asset (works with the included workflow).** Release assets can be up to 2 GB.
  ```bash
  tar -czf pa2-data.tar.gz -C web/public/data .
  ```
  ```bash
  gh release create data-2026F pa2-data.tar.gz --title "FDOR 2026F data bundle" --notes "Indian River to Miami-Dade"
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
- **Legend** (in the Map panel): class swatches with counts in "Asset class" mode; the metric ramp plus "Outline: asset class" in the other color modes.
- **Interface**: black and white. Near-black surfaces in a few steps (map ground `#0b0b0b`, panels `#0d0d0d`), white text and white active states, neutral grays that keep WCAG AA contrast; the asset-class colors are the only hues (plus amber for nominal-value warnings). IBM Plex Sans in sentence case for words, IBM Plex Mono for numbers, IDs and the small uppercase section labels. No text is under 12 px, and secondary text keeps at least 5.7:1 contrast. Nothing sits on the map by default except search, the zoom controls and the map credit. While a screen is filtered and the list is closed, a small pill shows the owner and parcel counts with *View list*; open, the list is a sheet along the bottom whose bar adapts to its own width. The parcel panel leads with the assessed value and puts *Owner profile* and *Look up on Sunbiz* under the owner. A fresh visit centers on the parcels themselves (the markets, weighted by size), not on the bounding box. Breakpoint: below 720 px the rail becomes a bottom bar, panels become sheets, and the parcel panel is a bottom sheet.

## Search

The search box floats at the top-left of the map (`/` focuses it from anywhere). It matches what you type against owner names, site addresses and cities, parcel IDs, property types (the DOR use description: "hotel", "warehouse") and the shared mailing addresses from the owner index.
- **Matching.** Both sides are normalized the same way: uppercase, punctuation dropped, street types and directions abbreviated ("Street" → `ST`, "West" → `W`, "Trust" → `TR`). Every word you type must start a word in the field it matches, so "651 hibiscus" finds 651 HIBISCUS ST and "cityplace ret" finds CITYPLACE RETAIL LLC. Abbreviated words must match whole words ("trust" never matches TRUCKING). Parcel IDs match on their letters and digits, so `74-43-43-21-13-004-0060` works.
- **Results** are grouped: a *Show all N matches on the map* row, then owners (by owner name, with their total parcels and value), mailing addresses (parcels, owner names, agent flag) and parcels (best first: parcel ID, then address, then owner, then other matches; by value within each).
- **Picking** a parcel flies to it and opens the drawer. Picking an owner, a mailing address or *Show all* shows those parcels on the map as a filter and frames them: a chip names the search, the In-view totals and Top owners count only those parcels, and the chip's ×, the box's × or *Reset all* clears it. More than 10,000 matches asks for another word.
- **Keyboard:** ↑/↓ to move, Enter to pick (the first row by default), Esc to close.
- **Index.** Search reads `index.json`, the same parcel table the results use (see below), plus the shared mailing addresses. The map filter uses a `match` expression on parcel IDs, which MapLibre compiles to a lookup table.

## Prospecting screens

Step 3 of the Filters panel, **Owner signals**, holds five preset screens. Turn on any mix: they combine with each other (a parcel must pass all of them) and with every other filter, the search and the map view. Each preset's ⓘ gives its exact rule in plain language, and an active preset shows as a chip over the map like any other filter.

| Preset | A parcel matches when | Based on |
|---|---|---|
| Long-term holders | Its last sale of $100+ is 15 or more years old (2011 or earlier), or no such sale is on record since at least then (a minimum, "N+ yrs") | County sale records, complete from 1969 (Palm Beach), 1972 (St. Lucie) and 1977 (Martin). Parcels with no sale on record are left out: an unknown hold is not a long one. |
| Underbuilt sites | Building value is at most 0.5× the land value, on a lot of 0.5 acre or more. Vacant land counts; nominal-value parcels never do. | Just value and land value on the 2026 roll |
| Out-of-area owners | The owner's mailing address is out of state, or elsewhere in Florida: outside the six counties, or inside them but more than 25 miles from the parcel | The roll's owner mailing address. Its ZIP (else its city, with spellings like "WEST PALM BCH" normalized) is placed at the median point of this dataset's parcels in that ZIP or city, and the distance runs from there to the parcel, so it is approximate. Florida addresses outside the six counties count however close they are (Sebastian's neighbors in Brevard, the Keys). |
| Small portfolio owners | The owner name holds 2 to 10 parcels across the six counties, all in one asset class | Owner-name groups (`owner_name_key`), not mailing addresses |
| Estate / trust owned | The owner name reads as a trust or an estate: TRUST, TRUSTEE, TR, ESTATE OF, HEIRS, REVOCABLE… | The name alone. REITs, banks and trust companies, and real-estate firms are excluded; land trusts are included. |

- Thresholds: `LONG_HOLD_YEARS` and `UNDERBUILT` in web/src/config.ts; `SMALL_PORTFOLIO`, `OUT_OF_AREA_MILES` (or `PA2_OUT_OF_AREA_MILES`) and `MAILING_PLACE_ALIASES` (PO-box towns with no parcels of their own, such as Port Salerno) in pipeline/pa2/config.py. The manifest's `prospecting` block records the pipeline thresholds and flag counts a bundle was built with. The rules run twice, identically: as a MapLibre filter (web/src/map/layers.ts) and over `index.json` for the tables (web/src/results.ts).
- The Owners table's **Signals** column lists the flags found on each owner's matching parcels (out of state or elsewhere in Florida, estate / trust, small portfolio); sorting it puts owners with the most signals first.

**Starter screens.** Four one-click examples (long-time owners of small apartment buildings, out-of-area owners of retail and office, underbuilt sites held 15+ years, estates and trusts that own apartments) sit on the first-visit card and under *Saved screens*. Each keeps the counties already picked, replaces the other filters and opens the owners list (`STARTER_SCREENS` in web/src/config.ts).

**Saved screens.** *Save this screen* names and stores the filters, presets, search, owner grouping, color and height modes, the table (open, tab, scope) and the map view. Clicking a saved screen puts all of that back; × asks before deleting, and saving under an existing name replaces it.
Screens live in this browser's localStorage (`pa2.screens.v1`) for now. `ScreenRepository` in web/src/screens.ts is the only storage seam, so a shared backend can replace `LocalScreenRepository` without touching the interface.

**Shareable links.** The page link always describes the current screen: *Copy link* (or the address bar) shares it, and opening it, or pasting it into an open tab, restores the screen. Keys that hold their default are left out.

| Key | Meaning |
|---|---|
| `map` | `zoom/lat/lng[/bearing/pitch]` (MapLibre's own) |
| `co` | counties: `41` Indian River, `66` St. Lucie, `53` Martin, `60` Palm Beach, `16` Broward, `23` Miami-Dade |
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

The rail's **Owners** button (or *View list* on the pill that appears once a screen is filtered) opens two tables of the current screen's results: every parcel that matches the filters, screens and search, in all six counties (**All matching**) or only inside the current view (**In map view**). The Filters panel's *See matching owners* button opens it too.
The tables run on `index.json` in the browser and use exactly the map's filter rules (`web/src/results.ts` `matcher` mirrors `web/src/map/layers.ts` `filterExpr`), so a screen covers parcels the map has not loaded yet. Only the rows on screen are drawn, so all 46,733 parcels scroll smoothly.

- **Owners**: one row per owner group, with the grouping set by Top owners' *By name / By address* toggle. **By name** groups the normalized owner name. **By address** groups the normalized mailing address, which shows the sponsor behind single-asset LLCs.
  - Registered-agent and manager addresses never form an owner group; their parcels fall back to the owner name. These are the 11 addresses shared by 25 or more owner names, listed as `owners.agent_addr_keys` in the manifest.
  - Columns: owner, related entities, parcels (matching, of the owner's total), assessed value, building SF, asset classes, signals, longest hold, average hold and mailing address. Related entities are other owner names at a shared mailing address, one hop and agent addresses excluded; they are shown for context and never added into the row's totals.
  - **Longest hold** shows minimums as "57+". **Average hold** counts exact holds only and says how many it used, e.g. "10 yrs, 50 of 54".
- **Parcels**: address, class, assessed value (or "Nominal"), building SF, lot, last sale (price and date, or "Not on record"), years held, owner and mailing address.
- **Sorting**: click a column header; click again to reverse.
- **Linked to the map**: clicking an owner row opens the owner profile and spotlights the group's parcels. Clicking a parcel row flies to the parcel and opens it. Selecting a parcel on the map highlights its row in both tables.
- **Export CSV** downloads the open table in its current sort, as UTF-8 with a BOM so Excel opens it correctly. Missing values are left blank, never zero. Text that a spreadsheet would run as a formula is escaped.
  - **Owners columns:** Owner name, Related entities, Matching parcels, Total parcels (all counties), Assessed market value, Building SF, Residential units, Asset classes, Longest hold, Average hold; then Mailing address 1 and 2, city, state and ZIP as separate columns for mail merge; then Other mailing addresses, Out-of-area owner (out of state or elsewhere in Florida), Estate or trust, Small portfolio owner, Largest property, Grouped by, Owner type (read from the name) and a Sunbiz lookup link. With state business records in the bundle, both exports add *Sunbiz entity, Sunbiz document number, Entity type, Entity status, Last annual report, Entity filed, Registered agent, Officers and managers* and *Sunbiz match* (an address group uses its largest property's owner).
  - **Parcels columns:** Parcel ID (county format), County, Site address, City, ZIP, Asset class, Property use, Assessed market value, Nominal-value flag, Building SF, Lot acres and SF, Residential units, Year built, Last sale date and price, Years held, Owner name, the split mailing address plus a one-line version, Out-of-area owner, Estate or trust, Small portfolio owner, Latitude, Longitude, a Link back to the parcel in the app, Owner type (read from the name) and a Sunbiz lookup link.

## Owner profiles

Opening an owner (from a table row, Top owners, a parcel's *Owner profile* button or a link) shows everything the group holds in the six counties, whatever the filters:
- Totals (parcels, assessed market value, building SF, units or lot area) and holds: average of the exact holds (with how many are exact) and the longest hold, as a minimum where it predates the records.
- **Where they own**: a mini map of the parcels, class-colored.
- **Asset class mix**: one bar by assessed value, with parcels, value and share per class.
- **Acquisition timeline**: each parcel's last sale of $100 or more on record, by year and price on a log scale, with a hover readout and a dated list. Parcels whose last priced sale predates the county records, and parcels with no sale on record, are counted in a note instead of plotted. Prices are as recorded: one deed covering several parcels can carry the whole price on each.
- **Entities**: for an address group, the owner names at that address; for a name group, its mailing addresses and the related entities linked through them. Any of these opens its own profile.
- **All parcels**: each opens in the property panel on top of the profile, with *Back to <owner>*.
- The map spotlights the group, and the link (`#…&o=n.<parcel id>`: the owner-name group of that parcel; `a.` for its mailing-address group) reopens the profile. **Export parcels (CSV)** downloads the holdings.

## State business records (Sunbiz)

The Florida Division of Corporations publishes every corporation, LLC and limited partnership on file as free quarterly data files (January, April, July, October). [pipeline/build_entities.py](pipeline/build_entities.py) matches the roll's company owners to them and publishes what it found next to the parcel data.

**Getting the files.** On the Division's [quarterly data page](https://dos.fl.gov/sunbiz/other-services/data-downloads/quarterly-data), choose *Continue to Download Files* and sign in with the public username and password printed on that page, then download `cordata.zip` and `corevent.zip` from *doc → quarterly → cor* into `pipeline/raw/sunbiz/` (kept out of git). The pipeline never signs in anywhere; refresh the files each quarter.

```bash
pipeline/.venv/bin/python pipeline/build_entities.py
```

It reads both files without unzipping them (several GB of fixed-width text, [layout](https://dos.sunbiz.org/data-definitions/cor.html)), keeps only the entities whose names can match an owner, and writes `web/public/data/entities/` plus an `entities` section in the manifest (source, file date, coverage per county). Its report goes to `pipeline/out/sunbiz/`: `report.json` (match rates per county, statuses, event kinds), `matches.csv`, `unmatched.csv` (largest first, to review) and `principals.csv`. `--no-publish` stops before publishing, `--clear` removes the published data. A full data build runs it automatically when the files are present, and drops stale records when they are not.

- **Matching** ([pipeline/pa2/sunbiz.py](pipeline/pa2/sunbiz.py)). Only company-like owner names are tried (LLC, corporation, partnership, organization, or a name cut off by the roll), with the same name normalizer as owner grouping. *Exact*: the names agree once punctuation and designators are normalized. *Prefix*: the roll cuts names at 30 characters (7.6% of parcels), so a cut name matches the entity names it begins. *Core*: the names agree but for LLC/INC and the like. Each match gets a confidence from 0 to 1, raised when the owner's tax bill goes to the entity's principal, mailing or officer address and lowered when several entities fit the name. Below 0.6 (`SUNBIZ_MIN_CONFIDENCE`) it is reported but not published. The app shows *Strong* (0.85+), *Likely* (0.7+) or *Possible* with the reason.
- **Status.** *Active*; *Annual report overdue* (active, but no report for the current year after the May 1 deadline: the Division dissolves such entities in late September); *Administratively dissolved* (or a foreign entity's registration revoked, from the events file); *Inactive* (dissolved by its owners, merged, withdrawn). Also the filing date and age, the last annual report and a reinstatement in the last three years.
- **Principals.** Up to six officers or managers and the registered agent, with their addresses. Owners whose records share a principal are linked: the owner profile lists **Related entities via** that person or company, with each linked owner's parcels and value. Commercial registered-agent services never link owners. Nor does a person listed only as registered agent or authorized person (often an attorney, accountant or filing clerk) on more than `SUNBIZ_RA_PERSON_MAX` (10) matched owners or Florida entities. A name that appears on more than `SUNBIZ_COMMON_NAME` (15) Florida entities links only where it gives the same address, and a link where the address differs is marked *name only*.
- **Limits.** The data file holds six officers per entity (Sunbiz shows the rest). Owners registered only in another state, or under a different name, are not matched. A possible match can be the wrong company with a similar name: every record carries *Verify on Sunbiz*.

### Sunbiz lookups

Opening a parcel shows a **Look up on Sunbiz** button under the owner, and again in the *Owner & contact* section with the mailing address (one click copies it). The owner profile has the same button, and one per entity in its lists. Both CSV exports end with *Owner type (from name)* and *Sunbiz lookup* columns.

- **What the link does.** It opens the Florida Division of Corporations' own search (search.sunbiz.org) in a new tab, with no referrer. For a company or organization it searches the entity name: Sunbiz lists names alphabetically from the term, so a name the tax roll cut off at 30 characters still lands on the entity. For an individual, and for a trustee named in a trust, it searches *officer / registered agent* by the roll's LAST FIRST name, which lists the companies that person manages. Government owners get no link: they are not registered.
- **Owner type** (LLC, Corporation, Partnership, Trust or estate, Individual, Government, Organization) is read from the name alone ([web/src/entity.ts](web/src/entity.ts)) and shown as a badge only when the name says so; a cut-off company name gets no badge.
- **What it is not.** The app never queries or scrapes sunbiz.org: the state records it shows come from the Division's bulk files (above). Without a match, the owner keeps these search buttons.

## Deal signals

[pipeline/build_signals.py](pipeline/build_signals.py) flags the parcels whose owner is more likely to sell or refinance, from public sources only. Each parcel gets a signal mask and, per signal, a short chip ("Held 6 yrs, LLC owner"), the date of the record behind it and a confidence. The source, its date and when it was pulled are kept once per source, in the manifest. It runs after *build_entities.py* (a full data build runs both), takes about five minutes, and writes `web/public/data/signals/` (`flags.json`, the masks for lists, filters and exports; `detail/`, the chips for the panels) and a report in `pipeline/out/signals/`.

| Signal | Rule (thresholds in pipeline/pa2/config.py, `SIGNAL_*`) | Source |
|---|---|---|
| Owner company dissolved / annual report overdue / inactive | The matched Sunbiz record's status | Division of Corporations quarterly file |
| Fund exit window | Exact hold of 5-7 years and a company owner | County sale records |
| Taxes rising | Capped assessed value at least 30% below market (just) value: the 10% non-homestead cap keeps raising the tax base, and a sale resets it | FDOR tax roll |
| Flood zone, coastal V zone | Half the lot or its center in FEMA's 1% annual-chance zone (A or V zones) | FEMA National Flood Hazard Layer, per county |
| Older building in a flood zone | Built before 2002 (the Florida Building Code) and in the flood zone | FEMA + tax roll |
| Near the coast | Within a mile of the Census coastline | Census TIGER/Line coastline |
| Tax certificate | A certificate outstanding on the parcel | County Tax Collector lists (Palm Beach county-held so far) |
| Lender or forced sale; estate, receiver or trustee | Latest transfer in the last 10 years with state sale code 12 or 38; code 19 | Broward and Martin histories, every county's latest sale |
| Quick resale | Two sales of $10,000+ within 36 months, the later one in the last 10 years | Transfer histories (Palm Beach, Martin, St. Lucie, Broward) |

**Getting the files.** FEMA flood maps: `https://msc.fema.gov/portal/downloadProduct?productID=NFHL_<county FIPS>C` into `pipeline/raw/fema/<FIPS>/` (12011 Broward, 12086 Miami-Dade, 12099 Palm Beach, 12085 Martin, 12111 St. Lucie, 12061 Indian River). Coastline: `tl_<year>_us_coastline.zip` from census.gov into `pipeline/raw/coastline/`. Tax certificates: each Tax Collector's list into `pipeline/raw/tax/<county>/` (Palm Beach posts its county-held certificates as an Excel file; the rest come by records request). A missing source skips its signals and the report says so.

**In the app.** The Filters panel's *Owner signals* step adds a *Deal signals* group of presets (owner company dissolved or lapsed, fund exit window, taxes rising, flood zone, recent lender/estate/quick resale, tax certificate), with each one's parcel count; they combine with every other filter. A parcel shows its signal chips under the key facts (hover for source, record date and confidence); the owner profile counts each signal across the owner's parcels; both CSV exports add a *Deal signals* column. Signals are not in the map tiles yet: a signal preset filters the map by parcel ID.

**Not yet.** Year-over-year value jumps need the prior-year rolls (requested from the Department of Revenue); tax delinquency covers only Palm Beach's county-held certificates until the six Tax Collectors' lists arrive.

## Top owners on the map

The Insights panel ranks the owners of the parcels in the map view, after every filter, by assessed market value: each row shows the owner, parcel count, residential units, value and share of the value in view, with a bar scaled to the leader.
The footer gives the top five owners' combined share, a quick read on ownership concentration. Pan, zoom or change a filter and the ranking follows.

- **Totals come from the parcel index**, not from the dots on screen: every parcel inside the map's bounds that passes the screen, exact at any zoom and in step with the table's *In map view*. Until the index has loaded (a few seconds after the map), parcel zooms count the drawn parcels and wider views show "…".

- **By name** groups parcels whose normalized owner names match (`owner_name_key` in the tiles).
- **By address** groups parcels mailed to the same normalized address (`owner_addr_key`), which often reveals the sponsor behind single-asset LLCs: downtown West Palm Beach puts CityPlace's four entities together (17 parcels, $390M). Rows note how many other owner names share the address, and flag addresses shared by 25+ names as a likely registered agent or manager.
- Parcels with no portfolio key are their own row (an owner with one parcel). Nominal-value parcels follow the *Count nominal-value parcels* switch.
- Clicking a row opens that owner's most valuable parcel in view and spotlights the portfolio on the map.

## Satellite imagery

- **Spyglass lens.** Press `S` or use the *Satellite lens* button in the Map panel (hidden on touch screens, which have no hover). From zoom 14, a 120 px-radius circle around the cursor shows imagery with white parcel lines.
  It is a second, non-interactive map, camera-locked to the main one and clipped to the circle, so hover and click still reach the parcels. The tooltip moves out of its way.
- **Basemap switch** (Map panel): **Map** (black and white), **Hybrid** (imagery + white street and place labels + class outlines over translucent fills), **Split** (dark left, imagery right; drag the divider or use the arrow keys).
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
| `out_of_area` | `2` when the owner's mailing state is not FL. `1` when it is FL and the mailing ZIP (else city) has no parcels in this dataset (outside the six counties), or its parcels' median point is more than `OUT_OF_AREA_MILES` (25) from the parcel. Unknown with no ZIP or city. Tiles and index carry it as `oa` (pipeline/pa2/publish.py `prospect_flags`) |
| `small_portfolio` | `1` when the parcel's owner-name group has 2–10 parcels, all in one asset class (`spf`) |
| `estate_trust` | `1` when the owner name reads as a trust or an estate (`estate_trust` in pipeline/pa2/publish.py; `et`) |
| `tot_lvg_area` | `TOT_LVG_AR`; values under 10 SF are treated as not reported. The 2026 roll carries `1` on ~7k improved office, warehouse and retail parcels. |

Other asset classes appear when their codes are fetched: Single Family 001, Condo 004–005, other residential 000, 002, 006–009, and 050–099.

**Owner resolution** (pipeline/pa2/entity.py). Names are uppercased, punctuation is stripped, and entity suffixes are unified (`L.L.C.`/`Limited Liability Company` → `LLC`, `Trustee` → `TR`, …).
Mailing addresses are standardized: `SUITE`/`STE`/`#` → `#`, directionals and street types abbreviated, `P.O. Box` → `PO BOX`, `C/O` lines skipped, ZIP5.
Groups of 2+ parcels get integer keys stored in the tiles, so a click highlights the whole portfolio across all six counties.
An address shared by 25+ distinct owner names is flagged as a likely manager or registered-agent address.
State business records (above) add links through shared officers, managers and registered agents.

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
- Not yet included: comps. Search matches word beginnings, not misspellings.
- Wide views are heavy: at zoom 8 the map draws every parcel as a dot, and the tile that holds Miami and Fort Lauderdale is about 2.4 MB. Thinning the low-zoom tiles (with exact matches drawn from the index) is the next step if coverage grows.
- Saved screens stay in the browser that saved them until a backend replaces `LocalScreenRepository`; share a screen with its link.
- Prospecting flags read names and mailing addresses as the roll publishes them: a trust owned through an LLC is not flagged, and a local owner who mails tax bills to an out-of-state office is.
