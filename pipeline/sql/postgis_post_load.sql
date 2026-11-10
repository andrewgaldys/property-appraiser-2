-- Run by sync_postgis.py right after each (table-replacing) load of pa2_parcels.
-- Works on any PostGIS 3.x database, including Supabase.

ALTER TABLE pa2_parcels ADD PRIMARY KEY (county_code, parcel_id);
CREATE INDEX IF NOT EXISTS pa2_parcels_geom_gix   ON pa2_parcels USING gist (geometry);
CREATE INDEX IF NOT EXISTS pa2_parcels_name_key   ON pa2_parcels (owner_name_key) WHERE owner_name_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS pa2_parcels_addr_key   ON pa2_parcels (owner_addr_key) WHERE owner_addr_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS pa2_parcels_class      ON pa2_parcels (asset_class, county_code);
CREATE INDEX IF NOT EXISTS pa2_parcels_owner_name ON pa2_parcels (upper(owner_name));

-- One row per resolved owner group (by normalized name or by mailing address).
CREATE OR REPLACE VIEW pa2_owner_portfolios AS
SELECT 'name'::text AS match_type, owner_name_key AS key, min(owner_name) AS label,
       count(*) AS parcels, sum(just_value) AS just_value, sum(no_res_unts) AS units,
       sum(tot_lvg_area) AS building_sf, array_agg(DISTINCT county_code) AS counties
FROM pa2_parcels WHERE owner_name_key IS NOT NULL GROUP BY owner_name_key
UNION ALL
SELECT 'address', owner_addr_key, min(owner_addr), count(*), sum(just_value), sum(no_res_unts),
       sum(tot_lvg_area), array_agg(DISTINCT county_code)
FROM pa2_parcels WHERE owner_addr_key IS NOT NULL GROUP BY owner_addr_key;

-- Every parcel sharing the owner name OR mailing address of a given parcel.
CREATE OR REPLACE FUNCTION pa2_portfolio(p_parcel_id text)
RETURNS SETOF pa2_parcels LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT owner_name_key, owner_addr_key FROM pa2_parcels WHERE parcel_id = p_parcel_id LIMIT 1)
  SELECT p.* FROM pa2_parcels p, me
  WHERE (me.owner_name_key IS NOT NULL AND p.owner_name_key = me.owner_name_key)
     OR (me.owner_addr_key IS NOT NULL AND p.owner_addr_key = me.owner_addr_key)
  ORDER BY p.just_value DESC NULLS LAST;
$$;
