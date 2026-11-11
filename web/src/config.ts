import type { BasemapMode, ExtrudeMode, Filters, ShadeMode } from './types';

export const APP_NAME = 'Property Appraiser 2.0';
export const APP_VERSION = 'V0.1';

export const COUNTY_META: Record<number, { name: string; short: string; badge: string }> = {
  53: { name: 'Martin', short: 'MAR', badge: 'Martin County' },
  66: { name: 'St. Lucie', short: 'SLC', badge: 'St. Lucie County' },
  60: { name: 'Palm Beach', short: 'PBC', badge: 'Palm Beach County' },
};
/** Toggle order requested for the filter bar. */
export const COUNTY_ORDER = [53, 66, 60];

export const CLASS_SHORT: Record<string, string> = {
  MF10: 'Multifamily 10+',
  MF2_9: 'Multifamily 2–9',
  COM: 'Retail & commercial',
  IND: 'Industrial',
  VAC_COM: 'Vacant com / ind',
  SFR: 'Single family',
  CONDO: 'Condo',
  RES_OTH: 'Other residential',
  VAC_RES: 'Vacant residential',
  AG: 'Agricultural',
  INST: 'Institutional',
  GOV: 'Government',
  OTHER: 'Other',
};

export const CLASS_BADGE: Record<string, string> = {
  MF10: 'Multifamily 10+ units',
  MF2_9: 'Multifamily 2–9 units',
  COM: 'Retail & commercial',
  IND: 'Industrial',
  VAC_COM: 'Vacant commercial / industrial',
  SFR: 'Single family',
  CONDO: 'Condo / co-op',
  RES_OTH: 'Other residential',
  VAC_RES: 'Vacant residential',
  AG: 'Agricultural',
  INST: 'Institutional',
  GOV: 'Government',
  OTHER: 'Other',
};

/** Classes whose NO_RES_UNTS are dwelling units (plus mixed use, DOR 012): see pipeline/pa2/config.py. */
export const RESIDENTIAL_CLASSES = new Set(['MF10', 'MF2_9']);
export const MIXED_USE_CODE = '012';

/** Min lot size slider stops (acres). */
export const LOT_STEPS_AC = [0, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 40];
/** Max building-to-land value ratio stops; index 0 = no limit. */
export const BTL_STEPS = [Infinity, 5, 3, 2, 1.5, 1, 0.75, 0.5, 0.35, 0.25, 0.1];
export const HOLD_MAX = 40;
/** Fallback when an older data bundle has no data_quality block. */
export const NOMINAL_VALUE_MAX = 1000;

export const DEFAULT_FILTERS: Filters = {
  counties: [],
  classes: [],
  minHold: 0,
  lotStep: 0,
  btlStep: 0,
  includeNominal: false,
};

export const EXTRUDE_MODES: { id: ExtrudeMode; label: string; legend: string }[] = [
  { id: 'flat', label: 'Flat', legend: 'Flat' },
  { id: 'value', label: 'Value', legend: 'Assessed market value' },
  { id: 'sqft', label: 'Building SF', legend: 'Building square feet' },
  { id: 'hold', label: 'Years held', legend: 'Years since last sale' },
];

export const SHADE_MODES: { id: ShadeMode; label: string; legend: string }[] = [
  { id: 'class', label: 'Asset class', legend: 'Asset class' },
  { id: 'value', label: 'Value', legend: 'Assessed market value' },
  { id: 'sqft', label: 'Building SF', legend: 'Building square feet' },
  { id: 'hold', label: 'Years held', legend: 'Years since last sale' },
  { id: 'ltv', label: 'Land share', legend: 'Land share of value' },
];

/**
 * Asset-class colors (fills, extrusions, outlines): muted for the slate map, and validated as a set
 * for a map, where any two classes can touch (dataviz validate_palette.js, dark mode, surface
 * #14181d, all pairs): worst protan/deutan ΔE 8.4, worst normal-vision ΔE 15.8, every color ≥ 3:1.
 * The old Tailwind-500 set put Industrial violet and Multifamily blue at ΔE 0.9 for deuteranopes.
 * Institutional is a light neutral (validated with the five); the opt-in residential classes stay quiet.
 */
export const CLASS_COLORS: Record<string, string> = {
  MF10: '#4e63a9',
  MF2_9: '#4299e5',
  COM: '#b88448',
  IND: '#ab3f6f',
  VAC_COM: '#2aa484',
  INST: '#a9b0ba',
  CONDO: '#c3c9d1',
  RES_OTH: '#7f7a74',
  SFR: '#a39e97',
  VAC_RES: '#5f5b56',
  AG: '#6f8f45',
  GOV: '#6b7380',
  OTHER: '#6b7380',
};
export const CLASS_FALLBACK = '#6b7380';

export const BASEMAP_MODES: { id: BasemapMode; label: string; title: string }[] = [
  { id: 'dark', label: 'Map', title: 'Dark map' },
  { id: 'hybrid', label: 'Hybrid', title: 'Satellite imagery with street labels and parcel outlines' },
  { id: 'split', label: 'Split', title: 'Map on the left, satellite on the right (drag the divider)' },
];

/** Esri World Imagery: keyless raster tiles. Attribution must stay visible. */
export const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const SATELLITE_ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community';
/** The spyglass lens shows from this zoom (imagery is meaningless further out). */
export const LENS_MIN_ZOOM = 14;
export const LENS_RADIUS = 120;

/** The map's ground color: shared by the basemap, fog and the class-color dimming. */
export const MAP_GROUND = '#14181d';

/**
 * Single-hue (slate) sequential ramps, lightness-monotonic, placed at the dataset's
 * 5th/25th/50th/75th/95th percentiles. On the dark surface "more" = lighter.
 * NORMAL leaves headroom below white, which is reserved for the selection.
 */
export const RAMP_NORMAL = ['#2a3039', '#3b434e', '#535d6a', '#717c8a', '#97a2b0'];
/** While a parcel is selected: compress the ramp so the portfolio reads at a glance. */
export const RAMP_SELECTED = ['#232931', '#2d343d', '#38404a', '#454e59', '#56606c'];
/** Portfolio focus mode: everything outside the portfolio recedes into the ground. */
export const RAMP_FOCUS = ['#1a1f25', '#1d2228', '#20262c', '#232930', '#272d34'];
/** Low-zoom centroid dots: same ordering, lifted floor so small dots stay visible on the dark basemap. */
export const RAMP_POINTS = ['#4a5360', '#646e7c', '#838e9c', '#a5afbc', '#cbd2db'];
export const COLOR_SELECTED = '#ffffff';
export const COLOR_PORTFOLIO = '#e3e7ec';
export const COLOR_HOVER = '#eef1f4';

/** Extrusion height breakpoints (metres) - piecewise-linear approximation of a log scale. */
export const HEIGHT_STOPS: Record<Exclude<ExtrudeMode, 'flat'>, number[]> = {
  value: [0, 1, 250e3, 4, 1e6, 10, 5e6, 25, 20e6, 55, 60e6, 100, 150e6, 160, 500e6, 260],
  sqft: [0, 1, 2e3, 3, 10e3, 9, 50e3, 28, 150e3, 60, 400e3, 110, 1e6, 190],
  hold: [-1, 1, 0, 2, 5, 12, 10, 25, 20, 52, 30, 80, 45, 120],
};

export const STORAGE_KEY = 'pa2.view.v3';
/** Per-viewer UI conveniences: open sidebar sections, legend collapsed, first-visit hint dismissed. */
export const UI_KEY = 'pa2.ui.v1';
