# Listing files

Put the listing files you have the right to publish in this folder, then run:

```bash
pipeline/.venv/bin/python pipeline/import_listings.py
```

Each `.csv` or `.json` file here is one source. The command matches every row to a parcel and writes
`web/public/data/listings/`, which the parcel panel's **Listings** section reads. Files in this folder
stay on your machine: git ignores everything here except this guide and the template.

**Only use data you may publish.** Your own brokerage's listings, an MLS feed under your membership
(with your broker's approval and the MLS's display rules), or a licensed vendor's export. Listing
sites such as LoopNet and Crexi do not allow their listings to be copied into another product, by
script or by hand. See *Listings* in the main README.

A market-wide feed (your MLS, or a licensed vendor's API) writes its file here by itself:
`pipeline/fetch_listings.py` pulls each feed that is set up into `feed_<name>.json` and then runs the
import. See *Market-wide feeds* in the main README.

## Columns

Start from [TEMPLATE.csv](TEMPLATE.csv). Column names are forgiving (case, spaces and common
synonyms: `Folio`, `List Price`, `Suite`, `Brokerage`…), and a saved MLS Web API response (RESO field
names such as `ListPrice`, `ParcelNumber`, `StandardStatus`) reads as it is.

| Column | What to put |
|---|---|
| **Type** (required) | `For sale`, `For lease`, `Sublease`, `Sale or lease`, `Auction` |
| **Parcel ID** | The county's parcel ID or folio, dashes or not. Best match there is. Several IDs for one offering: separate with `;` |
| **Address**, **City**, **ZIP** | Used when there is no parcel ID. A suite in the address (`100 Main St, Suite 200`) is read as the space |
| **Space** | The suite, unit or bay on offer. Leave blank when the whole property is offered |
| **Status** | Blank or `Active` shows as available; `Pending` / `Under contract` shows as under contract; `Closed`, `Sold`, `Leased`, `Expired`, `Withdrawn` are left out |
| **Price** | Asking price, or asking rent. `$4,250,000`, `4.25M`, `$38/SF/yr`, or words such as `Call for offers` |
| **Basis** | For rent: `$/SF/yr`, `$/SF/mo`, `per month` or `per year`. Never guessed: without it the panel says "basis not stated" |
| **Lease Type** | `NNN`, `Modified gross`, `Full service`… |
| **SF**, **Acres**, **Units** | What is on offer. `1,200 - 5,000` means divisible space |
| **Cap Rate**, **NOI** | As marketed |
| **Use**, **Title**, **Notes** | Property type, headline, and a short description (cut at 400 characters) |
| **Firm**, **Agent**, **Phone**, **Email**, **URL** | Who to call and where the listing lives. Only `http(s)` links are kept |
| **Listed**, **Updated** | Dates. `Updated` defaults to the date the file was pulled |

## Naming the source

The panel names the source of every listing. Give it on the command line for a single file:

```bash
pipeline/.venv/bin/python pipeline/import_listings.py pipeline/listings/ours.csv --source "Acme Realty" --kind own --as-of 2026-11-15
```

or, with several files, put a `<file>.meta.json` beside each one:

```json
{ "name": "Acme Realty", "kind": "own", "as_of": "2026-11-15", "disclaimer": "", "url": "https://example.com" }
```

`kind` is `own`, `mls`, `vendor` or `other`. `disclaimer` is wording the source requires next to its
listings (an MLS's notice, for example): it is printed under them.

## What happens to each row

1. **By parcel ID**, when the row has one (lost leading zeros are restored).
2. **By street address** otherwise: spelling differences are ironed out (`Avenue` / `AVE`, `14th` /
   `14`, `State Road 7` / `SR 7`), the ZIP or city must agree, and a number inside a parcel's range
   (`5865` in `5861-5869 NW 19 ST`) counts.
3. Several parcels of **one owner** at the address: the listing shows on each, as one offering.
4. Several parcels of **different owners** at the address (office and warehouse condos): the listing
   shows on each as "listed at this address", with a note that it may be for another one. Add the
   parcel ID or the unit to pin it down.
5. Anything else is **not published**. `pipeline/out/listings_report.csv` lists each such row with the
   reason and, where it helps, the parcels it could be.

Check before you publish, without writing anything:

```bash
pipeline/.venv/bin/python pipeline/import_listings.py --dry-run
```

Remove every listing (the panel goes back to "No listing source connected"):

```bash
pipeline/.venv/bin/python pipeline/import_listings.py --clear
```

Listings go stale quickly. Re-run the import whenever a source changes: the panel shows each
source's date and warns once it is more than 30 days old.
