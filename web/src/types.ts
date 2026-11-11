export type Bbox = [number, number, number, number];

export interface TileSet {
  url: string;
  layer: string;
  minzoom: number;
  maxzoom: number;
  /** Polygons only: zoom from which tiles carry roof-rim features (`e: 1`). */
  rim_minzoom?: number;
}

export interface ManifestCounty {
  code: number;
  name: string;
  short: string;
  count: number;
  jv: number;
  bbox: Bbox;
}

export interface SalesCoverage {
  /** Year from which the county's sale records are complete (null: latest transfer only). */
  from: number | null;
  /** all: every recorded transfer · recent5: the five most recent · latest: the latest only · window: the roll's sale window. */
  depth: 'all' | 'recent5' | 'latest' | 'window';
  source: string;
}

export interface ManifestAssetClass {
  code: string;
  label: string;
  category: string;
  count: number;
  primary: boolean;
}

export interface Manifest {
  schema: string;
  pipeline_version: string;
  generated_at: string;
  source: {
    kind: string; // "sample" | "fdor"
    label: string;
    attribution: string;
    tax_roll_year: number | null;
    as_of_year: number;
  };
  bounds: Bbox;
  counties: ManifestCounty[];
  cities: { name: string; county: number; count: number; bbox: Bbox }[];
  asset_classes: ManifestAssetClass[];
  /** DOR use code -> description for codes present in the data (absent in older bundles). */
  use_codes?: Record<string, string>;
  stats: {
    parcels: number;
    just_value: number;
    /** Residential (multifamily + mixed-use) units. */
    units: number;
    building_sf: number;
    owner_name_groups: number;
    owner_addr_groups: number;
    nominal_parcels?: number;
  };
  /** Absent in older bundles. */
  data_quality?: {
    /** Just values below this are "nominal" (common areas, sub-parcels). */
    nominal_value_max: number;
    nominal_parcels: number;
    /** Transfers below this price are not sales (hold periods ignore them). */
    min_sale_price: number;
  };
  /** Per county code: how far back its sale records go (see SalesCoverage). */
  sales_coverage?: Record<string, SalesCoverage>;
  quantiles: Record<'just_value' | 'tot_lvg_area' | 'hold_period_years' | 'land_to_value_ratio' | 'lot_acres', number[]> & {
    q: number[];
  };
  tiles: {
    format: 'pmtiles' | 'geojson';
    polygons: TileSet;
    points: TileSet;
    fields: Record<string, string>;
  };
  details: { url: string; shard_hex: number };
  owners: { url: string; shard_hex: number; item_fields: string[]; max_items: number };
}

/** Attributes carried in the vector tiles (short keys, see pipeline/pa2/config.py TILE_FIELDS). */
export interface TileProps {
  pid: string;
  co: number;
  cls: string;
  uc?: string;
  addr?: string;
  /** Owner name (polygon tiles only; dots fetch it on hover). */
  own?: string;
  /** House number for z15+ labels (dot tiles). */
  hn?: string;
  jv?: number;
  /** Assessed value, non-school (AV_NSD). */
  av?: number;
  lv?: number;
  bv?: number;
  ltv?: number;
  btl?: number;
  sf?: number;
  lot?: number;
  /** Residential units (multifamily and mixed-use parcels only). */
  u?: number;
  yb?: number;
  sp?: number;
  sy?: number;
  hold?: number;
  /** Lower bound on the hold when the last priced sale is not on record (as_of_year - no_sale_since). */
  hf?: number;
  onk?: number;
  oak?: number;
}

export interface ParcelRecord {
  parcel_id: string;
  county_code: number;
  site_address: string;
  site_city: string;
  site_zip: string;
  use_code: string | null;
  use_description: string;
  use_category: string;
  asset_class: string;
  just_value: number | null;
  assessed_value?: number | null;
  land_value: number | null;
  building_value: number | null;
  land_to_value_ratio: number | null;
  bldg_to_land_ratio: number | null;
  tot_lvg_area: number | null;
  lnd_sqfoot: number | null;
  lot_acres: number | null;
  /** Dwelling units: multifamily and mixed-use parcels only (null elsewhere). */
  residential_units: number | null;
  no_buldng: number | null;
  act_yr_blt: number | null;
  eff_yr_blt: number | null;
  owner_name: string;
  owner_addr1: string;
  owner_addr2: string;
  owner_city: string;
  owner_state: string;
  owner_zip: string;
  owner_addr: string;
  last_sale_price: number | null;
  last_sale_year: number | null;
  last_sale_month: number | null;
  last_sale_qual_cd: string | null;
  last_sale_qualified: boolean | null;
  hold_period_years: number | null;
  /** When the hold is not known exactly: the year from which no priced sale is on record. */
  no_sale_since?: number | null;
  hold_floor_years?: number | null;
  /** Year from which the county's sale records are complete (null: latest transfer only). */
  sales_from?: number | null;
  owner_name_key: number | null;
  owner_addr_key: number | null;
  legal_desc: string;
  tax_roll_year: number | null;
  lon: number;
  lat: number;
  bbox: Bbox;
}

export type MatchType = 'name' | 'addr' | 'both';

export interface PortfolioItem {
  parcel_id: string;
  county_code: number;
  asset_class: string;
  site_address: string;
  site_city: string;
  just_value: number | null;
  tot_lvg_area: number | null;
  residential_units: number | null;
  owner_name: string;
  owner_name_key: number | null;
  owner_addr_key: number | null;
  lon: number;
  lat: number;
  match: MatchType;
}

export interface PortfolioGroup {
  label: string;
  count: number;
  jv: number;
  /** Residential units only. */
  units: number;
  /** Parcels that can carry residential units (multifamily, mixed use). */
  res?: number;
  /** Nominal-value parcels in the group. */
  nominal?: number;
  sf: number;
  counties: Record<string, number>;
  items: unknown[][];
  names?: number;
  agent?: boolean;
}

export interface Portfolio {
  byName: PortfolioGroup | null;
  byAddr: PortfolioGroup | null;
  items: PortfolioItem[];
  /** Exact parcel count of the union when both lists are complete, else a lower bound. */
  total: number;
  exact: boolean;
  jv: number;
  /** Residential units only; `allResidential` says whether every parcel can carry them. */
  units: number;
  allResidential: boolean;
  sf: number;
  counties: Record<string, number>;
}

export type ExtrudeMode = 'flat' | 'value' | 'sqft' | 'hold';
/** "Color by": asset class (default) or a metric ramp. */
export type ShadeMode = 'class' | 'value' | 'sqft' | 'hold' | 'ltv';
export type BasemapMode = 'dark' | 'hybrid' | 'split';

export interface Filters {
  counties: number[]; // empty = all
  classes: string[]; // empty = all
  minHold: number; // years, 0 = any
  lotStep: number; // index into LOT_STEPS_AC
  btlStep: number; // index into BTL_STEPS (0 = any)
  /** Count nominal-value parcels in value screens and in-view totals (off by default). */
  includeNominal: boolean;
}

export interface Selection {
  pid: string;
  nameKey: number | null;
  addrKey: number | null;
}

export interface AppState {
  filters: Filters;
  extrude: ExtrudeMode;
  shade: ShadeMode;
  basemap: BasemapMode;
  /** Satellite spyglass lens around the cursor (dark basemap, zoom >= 14). */
  lens: boolean;
  selection: Selection | null;
  focus: boolean;
}

export interface ViewStats {
  parcels: number;
  jv: number;
  units: number;
  sf: number;
  /** Nominal-value parcels in view that the totals leave out. */
  nominal: number;
}
