# Property Appraiser 2.0 · V0.1

3D real-estate and parcel intelligence for **Martin (53)**, **St. Lucie (66)** and **Palm Beach (60)** counties, Florida.
It is a static site (GitHub Pages, no server, no API keys) that streams parcel vector tiles from one PMTiles file with HTTP Range requests.
A Python pipeline turns Florida Department of Revenue (FDOR) tax-roll files into that bundle.

- 3D parcel extrusions by **just value**, **building SF** or **hold period** (or flat 2D), shaded by value, SF, hold or land share.
- Filters: county, asset class, minimum hold period, minimum lot size, maximum building-to-land value ratio. The "In view" totals respect them.
- Property drawer: valuation and land/improvement split, physicals, last sale and hold signal, and a **true-owner portfolio** across all three counties, matched on normalized owner name *or* mailing address.
- One-click, print-styled **Property Brief** (Letter, Save as PDF), with shareable parcel links (`#…&p=<parcel id>`).

> The repo ships with **synthetic sample data** (510 parcels, 12 cross-county LLC portfolios). Every owner, address and value in it is fictional.

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

Open http://localhost:5173. The sample bundle in `web/public/data/` is committed, so nothing else is needed.

To regenerate the sample (Python 3.10+):

```bash
python3 -m venv pipeline/.venv && pipeline/.venv/bin/pip install -r pipeline/requirements.txt
```

```bash
pipeline/.venv/bin/python pipeline/generate_sample_data.py
```

## Layout

```
pipeline/
  generate_sample_data.py   synthetic sample -> web/public/data (+ --emit-raw: FDOR-format test files)
  build_fdor.py             NAL + SDF + parcel polygons -> web/public/data (production)
  build_tiles.py            re-tile from pipeline/out/parcels.parquet (e.g. after installing tippecanoe)
  sync_postgis.py           optional: load the joined table into PostGIS / Supabase
  pa2/                      schema, DOR use codes, owner resolution, MVT encoder, PMTiles writer, publisher
web/                        Vite + TypeScript + MapLibre GL JS 6 + pmtiles
  public/data/              manifest.json, parcels.pmtiles, points.pmtiles, parcels/*.json, owners/*.json
.github/workflows/deploy.yml  build web/ and publish to GitHub Pages
```

**Data bundle.** The polygon tiles (z12–15) and centroid tiles (z5–12) carry only what the map filters and draws.
Full parcel records sit in small JSON shards keyed by hash(parcel ID), and owner portfolios in shards keyed by owner group.
A click fetches one shard, whatever the dataset size.

## Production data (FDOR)

### 1 · Download

Everything comes from the FDOR Property Tax Oversight **Data Portal**: https://floridarevenue.com/property/dataportal/Pages/default.aspx
Folder names follow the roll year (`2026F` = final 2026 roll, `2026P` = preliminary); use the newest.

| Data | Portal path | Files for counties 53 / 60 / 66 |
|---|---|---|
| **NAL**: Name-Address-Legal (values, owner, use code, physicals, recent sales) | Tax Roll Data Files → NAL → `2026F` | `Martin 53 Final NAL 2026.zip`, `Palm Beach 60 Final NAL 2026.zip`, `Saint Lucie 66 Final NAL 2026.zip` |
| **SDF**: Sales Data File | Tax Roll Data Files → SDF → `2026F` | `Martin 53 Final SDF 2026.zip`, `Palm Beach 60 Final SDF 2026.zip`, `Saint Lucie 66 Final SDF 2026.zip` |
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
2. takes each parcel's most recent sale of at least $100 across NAL `SALE_*1/2` and the SDF,
3. reads, repairs and reprojects the polygons and dissolves multi-part parcels,
4. joins on the normalized parcel ID (dashes and spaces removed),
5. resolves owner portfolios and writes `web/public/data/` plus `pipeline/out/parcels.parquet`.

It logs the polygon match rate per county. Condo units usually have no individual polygon, so they drop out of the map.

| Option | Use |
|---|---|
| `--classes MF10,MF2_9,COM,IND,VAC_COM` | Investment classes only: a much smaller bundle |
| `--shard-hex 3` (default) | 4,096 detail/owner shards; use `2` for small subsets |
| `--tiler tippecanoe\|python\|none` | Default `auto`. Install tippecanoe for the full roll: `brew install tippecanoe` (or build [felt/tippecanoe](https://github.com/felt/tippecanoe)); the pure-Python tiler is fine for the sample or one county |
| `--geom-id-field PIN` / `--assume-crs EPSG:2236` | Only if auto-detection of the parcel-ID column or the CRS fails |
| `--as-of-year 2026` / `--min-sale-price 100` | Hold-period base year / ignore nominal transfers |

Re-tile without re-reading FDOR files: `pipeline/.venv/bin/python pipeline/build_tiles.py` (`--print-commands` prints the tippecanoe commands).

### 3 · Swap the sample for production

`build_fdor.py` overwrites the sample files in `web/public/data/` (and nothing else there).
Run `npm run build` and the site serves production data.
Check the size with `du -sh web/public/data`. The full roll (~850k parcels) is several hundred MB: too big to commit, since GitHub rejects files over 100 MB and Pages sites must stay under 1 GB. Pick one of:

- **GitHub Release asset (works with the included workflow).** Release assets can be up to 2 GB.
  ```bash
  tar -czf pa2-data.tar.gz -C web/public/data .
  ```
  ```bash
  gh release create data-2026F pa2-data.tar.gz --title "FDOR 2026F data bundle" --notes "Martin, St. Lucie, Palm Beach"
  ```
  Then add the repository variable `DATA_RELEASE_TAG=data-2026F` (Settings → Secrets and variables → Actions → Variables).
  The deploy workflow unpacks it over the sample before building.
- **Object storage (R2 / S3).** Upload `web/public/data/` and set the repository variable `VITE_DATA_URL` to its public URL.
  Allow CORS `GET`/`HEAD` with the `Range` header and expose `ETag` (see the PMTiles cloud-storage docs).

## Deploy to GitHub Pages

1. Push to GitHub, then set **Settings → Pages → Source: GitHub Actions**.
2. Every push to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml): it fetches the release bundle if `DATA_RELEASE_TAG` is set, builds `web/` and publishes `web/dist`.

Asset paths are relative (`base: './'`), so the site works under `/<repo>/` or a custom domain.
For a local check of the production build, use `npm run preview`; Python's `http.server` does not support Range requests, which PMTiles needs.

## Data model

Derived fields (pipeline/pa2/schema.py):

| Field | Definition |
|---|---|
| `building_value` | `JV − LND_VAL` (floored at 0) |
| `land_to_value_ratio` | `LND_VAL / JV` |
| `bldg_to_land_ratio` | `(JV − LND_VAL) / LND_VAL`: the map's "max building / land value" screen |
| `hold_period_years` | `2026 − year of last sale` (`--as-of-year`) |
| `last_sale_qualified` | `true` for qualification code 01, `false` for 11+, otherwise null (raw code kept) |

Asset classes come from the statewide DOR use code (`DOR_UC`):

| Class | DOR codes |
|---|---|
| Multifamily 10+ | 003 |
| Multifamily 2–9 | 008 |
| Retail / Commercial | 011–039 (stores, centers, office, restaurants, hotels, auto…) |
| Industrial | 041–049 |
| Vacant Commercial | 010, 040 |
| Single Family / Condo / other | 001 / 004–005 / 000, 002, 006–009, 050–099 (shown when present) |

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
- Sample parcels sit on simplified street grids. Cluster centres were checked against OpenFreeMap water polygons: no parcel sits in the ocean, the lagoon or a river, though some corners overlap stormwater ponds.
- Last sale and hold come only from the sale fields in NAL/SDF. Parcels without one show "No sale on record" and are excluded by the hold filter.
- Not yet included: address or owner search, comps, and fuzzy/Sunbiz entity matching.
