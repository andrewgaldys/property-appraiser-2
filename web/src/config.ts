import type { ExtrudeMode, Filters, ShadeMode } from './types';

export const APP_NAME = 'Property Appraiser 2.0';
export const APP_VERSION = 'V0.1';

export const COUNTY_META: Record<number, { name: string; short: string; badge: string }> = {
  53: { name: 'Martin', short: 'MAR', badge: 'Martin · 53' },
  66: { name: 'St. Lucie', short: 'SLC', badge: 'St. Lucie · 66' },
  60: { name: 'Palm Beach', short: 'PBC', badge: 'Palm Beach · 60' },
};
/** Toggle order requested for the filter bar. */
export const COUNTY_ORDER = [53, 66, 60];

export const CLASS_SHORT: Record<string, string> = {
  MF10: 'MF 10+',
  MF2_9: 'MF 2–9',
  COM: 'Retail / Com',
  IND: 'Industrial',
  VAC_COM: 'Vacant Com',
  SFR: 'Single Family',
  CONDO: 'Condo',
  RES_OTH: 'Other Res',
  VAC_RES: 'Vacant Res',
  AG: 'Agricultural',
  INST: 'Institutional',
  GOV: 'Government',
  OTHER: 'Other',
};

export const CLASS_BADGE: Record<string, string> = {
  MF10: 'Multifamily 10+',
  MF2_9: 'Multifamily 2–9',
  COM: 'Retail / Commercial',
  IND: 'Industrial',
  VAC_COM: 'Vacant Commercial',
  SFR: 'Single Family',
  CONDO: 'Condo / Co-op',
  RES_OTH: 'Other Residential',
  VAC_RES: 'Vacant Residential',
  AG: 'Agricultural',
  INST: 'Institutional',
  GOV: 'Government',
  OTHER: 'Other',
};

/** Min lot size slider stops (acres). */
export const LOT_STEPS_AC = [0, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 40];
/** Max building-to-land value ratio stops; index 0 = no limit. */
export const BTL_STEPS = [Infinity, 5, 3, 2, 1.5, 1, 0.75, 0.5, 0.35, 0.25, 0.1];
export const HOLD_MAX = 40;

export const DEFAULT_FILTERS: Filters = { counties: [], classes: [], minHold: 0, lotStep: 0, btlStep: 0 };

export const EXTRUDE_MODES: { id: ExtrudeMode; label: string; legend: string }[] = [
  { id: 'flat', label: 'Flat 2D', legend: 'Flat' },
  { id: 'value', label: 'Value', legend: 'Just value' },
  { id: 'sqft', label: 'Bldg SF', legend: 'Building sq ft' },
  { id: 'hold', label: 'Hold', legend: 'Hold period' },
];

export const SHADE_MODES: { id: ShadeMode; label: string; legend: string }[] = [
  { id: 'value', label: 'Value', legend: 'Just value' },
  { id: 'sqft', label: 'Bldg SF', legend: 'Building sq ft' },
  { id: 'hold', label: 'Hold', legend: 'Years since last sale' },
  { id: 'ltv', label: 'Land %', legend: 'Land share of value' },
];

/**
 * Single-hue (neutral) sequential ramps, lightness-monotonic, placed at the dataset's
 * 5th/25th/50th/75th/95th percentiles. On the dark surface "more" = lighter.
 * NORMAL leaves headroom below pure white, which is reserved for the selection.
 */
export const RAMP_NORMAL = ['#262626', '#383838', '#4f4f4f', '#6b6b6b', '#8e8e8e'];
/** While a parcel is selected: compress the ramp so the portfolio reads at a glance. */
export const RAMP_SELECTED = ['#222222', '#2f2f2f', '#3d3d3d', '#4e4e4e', '#626262'];
/** Portfolio focus mode: everything outside the portfolio recedes into the ground. */
export const RAMP_FOCUS = ['#171717', '#1b1b1b', '#1f1f1f', '#232323', '#282828'];
/** Low-zoom centroid dots: same ordering, lifted floor so small dots stay visible on the dark basemap. */
export const RAMP_POINTS = ['#4f4f4f', '#6c6c6c', '#8c8c8c', '#b0b0b0', '#d6d6d6'];
export const COLOR_SELECTED = '#ffffff';
export const COLOR_PORTFOLIO = '#e4e4e4';
export const COLOR_HOVER = '#f2f2f2';

/** Extrusion height breakpoints (metres) - piecewise-linear approximation of a log scale. */
export const HEIGHT_STOPS: Record<Exclude<ExtrudeMode, 'flat'>, number[]> = {
  value: [0, 1, 250e3, 4, 1e6, 10, 5e6, 25, 20e6, 55, 60e6, 100, 150e6, 160, 500e6, 260],
  sqft: [0, 1, 2e3, 3, 10e3, 9, 50e3, 28, 150e3, 60, 400e3, 110, 1e6, 190],
  hold: [-1, 1, 0, 2, 5, 12, 10, 25, 20, 52, 30, 80, 45, 120],
};

export const STORAGE_KEY = 'pa2.view.v1';
