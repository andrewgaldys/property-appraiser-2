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
- **Sunbiz lookups**: every owner in the parcel panel, the owner profile and the CSV exports carries a link to Florida's state business records (the entity itself, or for a person the companies that list them), plus an owner-type badge read from the name.
- **Listings**: every parcel on the market, from every licensed feed connected at once (MLS feeds over the RESO Web API, Resimplifi's API, your own files). The map tags listed parcels FOR SALE / FOR LEASE with a dashed outline, *On the market* in Filters shows only them, and the parcel panel lists each offering with its asking price or rent, who to call, its source and date. The same listing from several sources shows once. With no source connected nothing changes and the panel says so rather than "none" (see *Listings*).
- **Owner profiles**: everything an owner holds in the six counties, a mini map, an acquisition timeline (last priced sale of each parcel), average hold, asset-class mix, mailing addresses and related entities; CSV export of the holdings.
- **Map first**: the page opens as the map, a search box and a slim rail. Filters, Insights, Saved screens and Map options each open from the rail as one pop-up panel at a time; the Owners list and the guide open from it too. On phones the rail is a bottom bar and panels rise from it.
- **Search** (top-left of the map, or press `/`): owner names, site addresses, cities, parcel IDs (dashed or not), property types and shared mailing addresses. Results come back grouped as owners, mailing addresses and parcels; pick one parcel to fly to it, or show an owner, a mailing address or every match on the map as a removable filter.
- **Top owners in view**: who controls the parcels on screen, after filters, ranked by assessed value, with each owner's share and the top five's combined share (ownership concentration). Group by owner name, or by mailing address to see the sponsor behind single-asset LLCs. Click an owner to open their most valuable parcel and spotlight the portfolio.
- **Panels** (from the rail). *Filters*: a guided flow of *01 Location* (any mix of counties, north to south, and each county's largest markets), *02 Asset class*, *03 Owner signals*, then *More filters* (minimum years held, minimum lot size, maximum building-to-land value, nominal-value parcels), with a **See matching owners** button and the match count pinned at the bottom. *Insights*: live totals for the map view and Top owners. *Saved*: saved screens and four one-click starter screens. *Map*: basemap, satellite lens, what height and color show, and the legend. Explanations sit behind ⓘ buttons, and **Help** (or the ? key) explains the workflow, the map and each county's data coverage.
- **Applied filters** show as removable chips beside the search box ("Showing …"), with *Reset all*, and the Filters button carries their count; when nothing matches, the map says so and offers a reset. A one-line first-visit strip points to the starter lists and the guide.
- **Property drawer**, most decision-relevant first: address, asset class and use (with *For sale* / *For lease* badges when it is listed), then assessed market value, building SF, lot, residential units, last sale, years held and owner; then the aerial, **listings**, value and building details, sale and hold, and the **true-owner portfolio** across all six counties (matched on normalized owner name *or* mailing address). Identifiers and legal text fold into *More details*; empty fields are left out.
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
  import_listings.py               for-sale / for-lease listing files -> web/public/data/listings (see Listings)
  fetch_listings.py                licensed market feeds (Resimplifi API, an MLS's RESO Web API) -> pipeline/listings, then import
  listings/                        where those files go (git-ignored), with a column guide and a template
  pa2/                             schema, DOR use codes, owner resolution, listings matcher, MVT encoder, PMTiles writer, publisher
web/                               Vite + TypeScript + MapLibre GL JS 6 + pmtiles
  public/data/                     manifest.json, parcels.pmtiles, points.pmtiles, parcels/*.json, owners/*.json, index.json, listings/
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
  - **Owners columns:** Owner name, Related entities, Matching parcels, Total parcels (all counties), Assessed market value, Building SF, Residential units, Asset classes, Longest hold, Average hold; then Mailing address 1 and 2, city, state and ZIP as separate columns for mail merge; then Other mailing addresses, Out-of-area owner (out of state or elsewhere in Florida), Estate or trust, Small portfolio owner, Largest property, Grouped by, Owner type (read from the name) and a Sunbiz lookup link.
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

## Sunbiz lookups

Opening a parcel shows a **Look up on Sunbiz** button under the owner, and again in the *Owner & contact* section with the mailing address (one click copies it). The owner profile has the same button, and one per entity in its lists. Both CSV exports end with *Owner type (from name)* and *Sunbiz lookup* columns.

- **What the link does.** It opens the Florida Division of Corporations' own search (search.sunbiz.org) in a new tab, with no referrer. For a company or organization it searches the entity name: Sunbiz lists names alphabetically from the term, so a name the tax roll cut off at 30 characters still lands on the entity. For an individual, and for a trustee named in a trust, it searches *officer / registered agent* by the roll's LAST FIRST name, which lists the companies that person manages. Government owners get no link: they are not registered.
- **Owner type** (LLC, Corporation, Partnership, Trust or estate, Individual, Government, Organization) is read from the name alone ([web/src/entity.ts](web/src/entity.ts)) and shown as a badge only when the name says so; a cut-off company name gets no badge.
- **What it is not.** Nothing is copied or scraped from Sunbiz, so the app shows no status, registered agent or officers of its own. The sanctioned source for that is the Division's free bulk data (*Data Downloads → Quarterly Data → Corporate Data*, `cordata.zip`, fixed-width records with status, addresses, registered agent and officers), downloaded from its data portal with the public login the Division posts. Matching those records to owner names is the next step toward contact information.

## Listings

Opening a parcel shows a **Listings** section under the aerial: is the whole property for sale, is a suite or unit in it for lease, at what asking price or rent, and who to call. A listed parcel also carries a *For sale* or *For lease* badge at the top of the panel, and the print brief gets an *On the market* table.

**Listings are not public records.** Tax rolls and deeds are published by the counties; listings belong to the brokers and the sites that carry them. So the site shows a listing only when it comes from a source it is licensed to use, and it never fetches one itself:

| Source | Can it be used? |
|---|---|
| Your own brokerage's listings | Yes. They are yours. |
| An MLS feed (MIAMI REALTORS + BeachesMLS) | Yes, as a member, with your broker's approval and under the MLS's display rules (IDX). The two have merged and offer their subscribers one combined feed; MIAMI REALTORS delivers its feed over a RESO Web API (Bridge for agents, Trestle for brokers). |
| A licensed data vendor's API (Resimplifi, for one) | Yes, within its licence. Resimplifi's public terms allow no public display without its written permission, so the licence has to say so. |
| LoopNet / CoStar, Crexi and other listing sites | No. Their terms bar copying listings into another product, by script or by hand, and using their data in a competing one (LoopNet Terms of Use, revised May 7, 2025; Crexi Customer Terms of Service, October 28, 2024). |

Each card states what the source states and nothing more:

- **For sale / For lease**, with *Sublease*, *Auction*, *For sale or lease* or *Under contract* when the source says so, and **Entire property** or the suite, unit or bay on offer. A lease with no suite named does not claim to be the whole property.
- **Asking price or rent** as listed (`$38.00 / SF / yr`, `$28.00–$34.50 / SF / yr`, `$9,800 / mo`, `$24,000 / AC / yr`, or the source's own words: "Call for offers"). A rent with no basis reads "basis not stated"; a missing price reads "Price not stated". Neither is ever filled in.
- **Worked-out figures**, each with its formula on hover: price per SF (on the listing's area, else "on tax-roll area"), price per unit, asking price as a multiple of the assessed market value, monthly rent from a per-SF rate and the reverse.
- **Who lists it**, a link to the listing, and in small print the source, the date it was last updated there and how it was matched to the parcel.

The section has three honest states: listings; *No listing on file for this parcel*, naming the sources it checked and their dates; and *No listing source connected*, which is what the site shows until a source is imported. In every state a **Search the web for this address** button opens a web search for the address with "for sale" and "for lease" in a new tab; nothing is copied back.

### Importing listings

Put listing files in `pipeline/listings/` (CSV or JSON; [column guide](pipeline/listings/README.md), [template](pipeline/listings/TEMPLATE.csv)) and run:

```bash
pipeline/.venv/bin/python pipeline/import_listings.py
```

That writes `web/public/data/listings/` (`index.json`: the sources and which parcels are listed; small shards with the listings themselves), separate from the parcel bundle so listings can be refreshed in seconds without a rebuild. `--dry-run` reports without writing, and `--clear` goes back to "No listing source connected". Files in `pipeline/listings/` are git-ignored; what is published is the matched output.

### Market-wide feeds

To show what is on the market across the whole map, not one firm's listings, connect a feed and let it refresh itself:

```bash
pipeline/.venv/bin/python pipeline/fetch_listings.py --check
```

```bash
pipeline/.venv/bin/python pipeline/fetch_listings.py
```

The first says which feeds are set up; the second pulls each one into `pipeline/listings/feed_<name>.json` and runs the import. Credentials come from the environment, never from a file in the repo ([pipeline/pa2/feeds.py](pipeline/pa2/feeds.py)):

| Feed | What it covers | Needs |
|---|---|---|
| `resimplifi` | Resimplifi's commercial listing API: sale and lease, with a row per available suite, queried one county box at a time | `RESIMPLIFI_API_KEY`, and a licence that allows display on this site |
| `trestle` | Your MLS's listings over the RESO Web API on Trestle (brokers at MIAMI REALTORS) | `TRESTLE_CLIENT_ID`, `TRESTLE_CLIENT_SECRET` |
| `bridge` | The same on Bridge (agents at MIAMI REALTORS) | `BRIDGE_SERVER_TOKEN`, `BRIDGE_DATASET` |
| `spark` | An MLS on Flexmls, through FBS's Spark API (BeachesMLS uses Flexmls). 25 records a request, or 1,000 with a replication key (`SPARK_REPLICATION=on`) | `SPARK_ACCESS_TOKEN` |
| `reso-<key>` | Any other MLS's RESO Web API, such as the Indian River County MLS: its Property address and a token (or OAuth client credentials), one JSON object per MLS | `RESO_FEEDS` |

**All of them at once.** Every feed that is set up is pulled on each run. The six counties need three MLS sources to be covered: MIAMI REALTORS and BeachesMLS (merged, with one combined subscriber feed) for Miami-Dade, Broward, Palm Beach, Martin and St. Lucie, and the Indian River County MLS (run by the Realtors Association of Indian River County, which charges for its feed) for Indian River. Resimplifi adds commercial listings that sit only on brokerage websites.

From an MLS feed the pull is active and active-under-contract listings of the property types this map's parcels can carry, minus anything the seller withheld from internet display. Every MLS names its types its own way ("CommercialSale", "Commercial/Industrial", "Income", "Vacant Land"), so the connector reads them from the MLS's own metadata, or its Lookup list, and keeps those whose words say commercial, industrial, income, land, business, office, retail or multifamily (never homes, rentals or condo units). When an MLS lists neither, every active listing is fetched and sorted locally: slower, but no type is missed. A type naming lease or rental is a lease; any other is for sale. `MLS_PROPERTY_TYPES` and `MLS_STATUSES` (or `SPARK_…`) set exact values instead. `MLS_SOURCE_NAME`, `MLS_DISCLAIMER`, `MLS_SOURCE_URL` and `MLS_LOGO_URL` (or `SPARK_…`) set how the panel names the MLS, the notice it requires and its logo; `LISTINGS_OPERATOR` and `LISTINGS_OPERATOR_CONTACT` name the brokerage the site shows listings under.

**The same listing in several sources** shows once. When two sources carry the same offering on a parcel (the whole property for sale or for lease, or the same suite), the card shows the more authoritative source's data unchanged (your own listings, then an MLS, then a vendor, then the most recently updated) and names the others beneath it, each with its own link and date. Data is never mixed across sources, which MLS rules require. A lease that names no suite is never merged, since it cannot be told apart from another space in the building.

**Refreshing on its own.** Put the same names in the repository's Actions *secrets* and the deploy workflow pulls the feeds on every build; set the repository *variable* `LISTINGS_REFRESH` to `on` and it also rebuilds every six hours. With no secrets the step does nothing and the committed listings ship as they are. A feed that fails, comes back empty, or returns under half of its last pull stops the run before anything is published, so an outage never wipes listings off the map (the site keeps its last good deployment).

**On the map.** Listed parcels carry a FOR SALE (solid) or FOR LEASE (outlined) tag from zoom 13, a dashed outline on the ground, and a ring on their dot when zoomed out. The Map panel's legend explains them, a parcel's hover card says "For sale", and *On the market* in Filters (Any · Listed · For sale · For lease) narrows the map, the totals, the owners list and the CSV to listed parcels; links and saved screens keep it (`mk=`). None of this appears until a source is connected.

**What "the whole market" means.** No feed has every listing. An MLS feed has what its members entered (the commercial MLS claimed about 5,000 properties at its 2019 launch); Resimplifi says it syncs with brokerages and puts its coverage at up to 70 to 80% of a market for its fullest product. Listings that exist only on LoopNet or Crexi cannot be brought in. The panel names the sources it checked for that reason, and keeps the web search button.

**Before an MLS feed goes live** the site has to meet the MLS's IDX rules. From BeachesMLS's (version 10-19-23): refresh at least every 12 hours (§20.2.5); the listing firm and its phone or email on every listing (§20.3.3); the MLS's logo and its notice (§20.3.6, §20.3.7); the name of the brokerage that runs the site, readily visible (§20.2.7); no seller or occupant names (§20.3.10); nothing but display, on a site under the member's control, with an activity log the MLS can ask for (§20.2.2, §20.6). The cards already carry the listing firm, contact, source and notice text. Still to add for an MLS source: the MLS logo, the operating brokerage's name on the site, and an activity log, which a static site does not have. One question to put to the MLS before applying: this panel shows the owner of record from the tax roll next to a listing, and §20.3.10 bars displaying the seller's name.

The connectors were written from each provider's published API description and tested against local stand-ins for those APIs (paging, retry on rate limits, token exchange, property-type naming, the safety stops). They have not yet run against the live services: the first real pull needs a look.

How a row finds its parcel ([pipeline/pa2/listings.py](pipeline/pa2/listings.py)):

1. **Parcel ID** (folio / PCN), dashes, spaces and lost leading zeros forgiven.
2. **Street address**, normalized the way the six tax rolls write theirs (`Avenue` / `AVE`, `14th` / `14`, `State Road 7` / `SR 7`, `US Highway 1` / `US 1`), with the ZIP or city agreeing. A number inside a parcel's range (`5865` for `5861-5869 NW 19 ST`) counts, and a suite picks the unit parcel where the roll has one.
3. Several parcels of **one owner** at the address: one offering, shown on each.
4. Parcels of **different owners** at the address (office and warehouse condos; about 9% of parcels, mostly in Broward and Palm Beach): shown on each as *Listed at this address*, with a note that it may be for another one, unless a parcel ID or unit settles it.
5. Everything else, and every closed, expired or withdrawn row, is **left out** and written to `pipeline/out/listings_report.csv` with the reason.

Checked against the roll itself, on 30,000 sampled parcels with their addresses respelled the way listings spell them: 2,111 have no house number on the roll and cannot be matched by address at all (use the parcel ID). Of the other 27,889, 94.3% matched back to the right parcel or its same-owner group, 3.7% came back as *Listed at this address* (rule 4, the right parcel among them), 2.1% were left out (nearly all at addresses that more than 60 parcels share), and none matched a wrong parcel. Parcel IDs typed with dashes, spaces or lost leading zeros matched 8,000 of 8,000.

Limits: listings are only as current as the last import (each source's date is shown, with a warning past 30 days). A lease rate under $100 marked per month or per year shows with its basis not stated: MLS feeds often put a per-SF rate there, and the panel does not assume it. An MLS or vendor source usually requires its own notice and the listing firm's name beside each listing (`disclaimer` in the source's `.meta.json`), and MLS display rules typically also set how often the data must be refreshed and ask for safeguards against bulk copying, which a static site may not meet as it stands: read your MLS's rules, and get your broker's approval, before publishing a feed. The RESO field names are mapped but have been tried only on made-up rows, not yet on a live feed. The site links to LoopNet nowhere: its terms allow links to a listing only from sites that are not its competitors.

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
- Not yet included: comps, and entity details from Sunbiz's bulk data (the app links to Sunbiz instead; see *Sunbiz lookups*). Search matches word beginnings, not misspellings.
- Listings: the section, the importer, the matcher and the feed connectors are in place, but no listing source is connected yet (each needs a licence and credentials), so the live site says "No listing source connected" on every parcel. Listed parcels are not yet a filter or a map layer.
- Wide views are heavy: at zoom 8 the map draws every parcel as a dot, and the tile that holds Miami and Fort Lauderdale is about 2.4 MB. Thinning the low-zoom tiles (with exact matches drawn from the index) is the next step if coverage grows.
- Saved screens stay in the browser that saved them until a backend replaces `LocalScreenRepository`; share a screen with its link.
- Prospecting flags read names and mailing addresses as the roll publishes them: a trust owned through an LLC is not flagged, and a local owner who mails tax bills to an out-of-state office is.
