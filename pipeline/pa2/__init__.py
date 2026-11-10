"""Property Appraiser 2.0 data pipeline.

Turns Florida Department of Revenue (FDOR) tax-roll files (NAL + SDF) and
parcel polygons for Martin (53), Palm Beach (60) and St. Lucie (66) counties
into a static data bundle the GitHub Pages frontend streams directly:

    web/public/data/
      manifest.json          dataset description read by the frontend
      parcels.pmtiles        polygon vector tiles (layer "parcels")
      points.pmtiles         centroid vector tiles for low zooms (layer "points")
      parcels/<shard>.json   full parcel records, sharded by hash(parcel_id)
      owners/<shard>.json    owner portfolio index (name + mailing-address keys)
"""

__version__ = "0.1.0"
