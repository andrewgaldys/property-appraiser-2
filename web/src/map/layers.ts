import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import {
  BTL_STEPS,
  CLASS_COLORS,
  CLASS_FALLBACK,
  COLOR_HOVER,
  COLOR_PORTFOLIO,
  COLOR_SELECTED,
  HEIGHT_STOPS,
  LOT_STEPS_AC,
  MAP_GROUND,
  NOMINAL_VALUE_MAX,
  RAMP_FOCUS,
  RAMP_NORMAL,
  RAMP_POINTS,
  RAMP_SELECTED,
} from '../config';
import type { AppState, ExtrudeMode, Filters, Manifest, OwnerRef, SearchSet, Selection, ShadeMode } from '../types';

export const SRC_POLY = 'parcels';
export const SRC_PTS = 'parcel-centroids';
export const L_FLAT = 'parcel-flat';
export const L_OUTLINE = 'parcel-outline';
export const L_3D = 'parcel-3d';
export const L_RIM = 'parcel-rim';
export const L_POINTS = 'parcel-points';
export const L_LABELS = 'parcel-labels';
export const PARCEL_LAYERS = [L_FLAT, L_OUTLINE, L_3D, L_RIM, L_POINTS, L_LABELS];
/**
 * Rim features (`e: 1`, max-zoom polygon tiles only) are a narrow band inside each parcel
 * boundary, extruded a hair above the 3D block so roofs get an outline. Every other polygon
 * consumer must skip them.
 */
export const NOT_RIM: FilterSpecification = ['!', ['has', 'e']];
const IS_RIM: Expr = ['has', 'e'];
/** Labels appear from this zoom. */
export const LABEL_MIN_ZOOM = 15;

type Expr = ExpressionSpecification;
export type MetricMode = Exclude<ShadeMode, 'class'>;
const num = (key: string, fallback: number): Expr => ['number', ['get', key], fallback];

/**
 * Years held: the known hold, else the parcel's minimum `hf` (its last priced sale predates the
 * county's complete records, or only nominal transfers follow it), else -1 (not on record).
 * A minimum is a better stand-in than "unknown" for color, height and the hold screen alike:
 * a long-held parcel must never look short-held because its sale is older than the records.
 */
const HOLD_OR_FLOOR: Expr = ['number', ['coalesce', ['get', 'hold'], ['get', 'hf']], -1];

const SHADE_FIELD: Record<MetricMode, { value: Expr; quantile: keyof Manifest['quantiles'] }> = {
  value: { value: num('jv', 0), quantile: 'just_value' },
  sqft: { value: num('sf', 0), quantile: 'tot_lvg_area' },
  hold: { value: HOLD_OR_FLOOR, quantile: 'hold_period_years' },
  ltv: { value: num('ltv', 0), quantile: 'land_to_value_ratio' },
};

/** Just values below this are nominal (common areas, sub-parcels): from the bundle, else the default. */
export const nominalMax = (m: Manifest): number => m.data_quality?.nominal_value_max ?? NOMINAL_VALUE_MAX;

/** Ramp breakpoints = dataset percentiles (p5..p95), forced strictly ascending. */
export function shadeStops(manifest: Manifest, mode: MetricMode): number[] {
  const q = [...(manifest.quantiles[SHADE_FIELD[mode].quantile] as number[])];
  const eps = mode === 'ltv' ? 0.001 : 1;
  for (let i = 1; i < q.length; i++) if (q[i]! <= q[i - 1]!) q[i] = q[i - 1]! + eps;
  return q;
}

function ramp(manifest: Manifest, mode: MetricMode, colors: string[]): Expr {
  const stops = shadeStops(manifest, mode);
  const out: unknown[] = ['interpolate', ['linear'], SHADE_FIELD[mode].value];
  stops.forEach((s, i) => out.push(s, colors[Math.min(i, colors.length - 1)]));
  return out as Expr;
}

/** Mix a hex color toward `to` by t (0 = unchanged, 1 = `to`). */
function mix(hex: string, t: number, to: string): string {
  if (!t) return hex;
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = rgb(hex);
  const b = rgb(to);
  return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** Asset-class color for every parcel; dim > 0 pushes toward the dark surface, lift > 0 toward white. */
function classColors(dim = 0, lift = 0): Expr {
  const out: unknown[] = ['match', ['get', 'cls']];
  const tone = (c: string) => (lift ? mix(c, lift, '#ffffff') : mix(c, dim, MAP_GROUND));
  for (const [code, color] of Object.entries(CLASS_COLORS)) out.push(code, tone(color));
  out.push(tone(CLASS_FALLBACK));
  return out as Expr;
}

const isSelected = (sel: Selection): Expr => ['==', ['get', 'pid'], sel.pid];
const isHovered: Expr = ['boolean', ['feature-state', 'hover'], false];

/** Parcels sharing the selected parcel's owner-name key or mailing-address key. */
export function inPortfolio(sel: Selection | null): Expr | null {
  if (!sel) return null;
  const parts: Expr[] = [];
  if (sel.nameKey != null) parts.push(['==', ['get', 'onk'], sel.nameKey]);
  if (sel.addrKey != null) parts.push(['==', ['get', 'oak'], sel.addrKey]);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : (['any', ...parts] as Expr);
}

/** An opened owner profile's parcels: its name key, its mailing-address key, or the one parcel. */
function ownerExpr(r: OwnerRef | null): Expr | null {
  if (!r) return null;
  if (r.kind === 'n') return ['==', ['get', 'onk'], Number(r.id)];
  if (r.kind === 'a') return ['==', ['get', 'oak'], Number(r.id)];
  return ['==', ['get', 'pid'], String(r.id)];
}

/** What the map lights up: an opened owner's parcels, else the selected parcel's portfolio. */
const highlight = (s: AppState): Expr | null => ownerExpr(s.ownerFocus) ?? inPortfolio(s.selection);
/** How far everything else recedes: strongly for a spotlight (owner profile or focus), less for a plain selection. */
const strong = (s: AppState): boolean => !!s.ownerFocus || s.focus;
const dimmed = (s: AppState): boolean => !!s.ownerFocus || !!s.selection;

/**
 * Fill / extrusion / dot color. "Class" mode colors by asset class; metric modes use the
 * neutral ramp. A selection or an open owner profile dims everything else; the portfolio keeps full strength.
 */
export function colorExpr(manifest: Manifest, s: AppState, variant: 'polygons' | 'points' = 'polygons'): Expr {
  const sel = s.selection;
  const byClass = s.shade === 'class';
  const base = byClass
    ? classColors(!dimmed(s) ? 0 : strong(s) ? 0.82 : 0.55)
    : ramp(manifest, s.shade as MetricMode, !dimmed(s) ? (variant === 'points' ? RAMP_POINTS : RAMP_NORMAL) : strong(s) ? RAMP_FOCUS : RAMP_SELECTED);
  const cases: unknown[] = ['case'];
  if (sel) cases.push(isSelected(sel), COLOR_SELECTED);
  cases.push(isHovered, byClass ? classColors(0, 0.45) : COLOR_HOVER);
  const pf = highlight(s);
  if (pf) cases.push(pf, byClass ? classColors() : COLOR_PORTFOLIO);
  cases.push(base);
  return cases as Expr;
}

/** Every parcel gets a crisp stroke in its class color; white marks hover, selection and portfolio. */
export function outlineColor(s: AppState): Expr {
  const sel = s.selection;
  const cases: unknown[] = ['case'];
  if (sel) cases.push(isSelected(sel), '#ffffff');
  const pf = highlight(s);
  if (pf) cases.push(pf, '#ffffff');
  cases.push(isHovered, '#ffffff', classColors(!dimmed(s) ? 0 : strong(s) ? 0.7 : 0.35));
  return cases as Expr;
}

/** 3D roof outline: the class color lifted toward white; white marks hover, selection and portfolio. */
export function rimColor(s: AppState): Expr {
  const sel = s.selection;
  const cases: unknown[] = ['case'];
  if (sel) cases.push(isSelected(sel), '#ffffff');
  const pf = highlight(s);
  if (pf) cases.push(pf, '#ffffff');
  const base = dimmed(s) ? classColors(strong(s) ? 0.8 : 0.45) : classColors(0, s.shade === 'class' ? 0.4 : 0);
  cases.push(isHovered, '#ffffff', base);
  return cases as Expr;
}

/** 1.5 px at z14 -> 2.5 px at z16 (thinner while zoomed out); highlights a step heavier. */
export function outlineWidth(s: AppState): Expr {
  const at = (base: number, pf: number, sel: number, hover: number): unknown => {
    const cases: unknown[] = ['case'];
    if (s.selection) cases.push(isSelected(s.selection), sel);
    const p = highlight(s);
    if (p) cases.push(p, pf);
    cases.push(isHovered, hover, base);
    return cases;
  };
  return ['interpolate', ['linear'], ['zoom'], 12, at(0.6, 1.2, 1.6, 1.2), 14, at(1.5, 2.4, 3, 2.2), 16, at(2.5, 3.2, 4, 3)] as Expr;
}

export function pointRadius(s: AppState): Expr {
  const at = (base: number, sel: number, pf: number): Expr | number => {
    const cases: unknown[] = ['case'];
    if (s.selection) cases.push(isSelected(s.selection), sel);
    const p = highlight(s);
    if (p) cases.push(p, pf);
    if (cases.length === 1) return base;
    cases.push(base);
    return cases as Expr;
  };
  return ['interpolate', ['linear'], ['zoom'], 8, at(1.6, 4.5, 3.5), 10, at(2.6, 6, 4.5), 12, at(4, 8, 6)] as Expr;
}

export const pointStrokeWidth = (s: AppState): Expr => {
  const cases: unknown[] = ['case'];
  if (s.selection) cases.push(isSelected(s.selection), 2);
  const p = highlight(s);
  if (p) cases.push(p, 1.2);
  cases.push(isHovered, 1, 0);
  return cases as Expr;
};

export function heightExpr(mode: ExtrudeMode): Expr | number {
  if (mode === 'flat') return 0;
  const value = mode === 'value' ? num('jv', 0) : mode === 'sqft' ? num('sf', 0) : HOLD_OR_FLOOR;
  return ['interpolate', ['linear'], value, ...HEIGHT_STOPS[mode]] as Expr;
}

/** The rim sits on the roof and rises 0.6 m, or 0.6% of the block height if that is more. */
export function rimHeights(mode: ExtrudeMode): { base: Expr | number; top: Expr | number } {
  const h = heightExpr(mode);
  if (typeof h === 'number') return { base: h, top: h + 0.6 };
  return { base: h, top: ['+', h, ['max', 0.6, ['*', h, 0.006]]] as Expr };
}

/**
 * Screening filters; `rim` selects the roof-rim features instead of the parcels themselves.
 * A parcel passes the hold screen on its known hold or its minimum (see HOLD_OR_FLOOR). Value
 * screens skip nominal-value parcels unless they are included: a $100 common area has no
 * meaningful building-to-land ratio. A search shows only its parcels: `match` on the parcel id
 * compiles to a lookup table, so even thousands of ids stay cheap per feature.
 */
export function filterExpr(
  f: Filters,
  part: 'body' | 'rim' = 'body',
  nominal = NOMINAL_VALUE_MAX,
  search: SearchSet | null = null,
): FilterSpecification {
  const all: unknown[] = ['all', part === 'rim' ? IS_RIM : NOT_RIM];
  if (search?.pids.length) all.push(['match', ['get', 'pid'], search.pids, true, false]);
  if (f.counties.length) all.push(['in', ['get', 'co'], ['literal', f.counties]]);
  if (f.classes.length) all.push(['in', ['get', 'cls'], ['literal', f.classes]]);
  if (f.minHold > 0) all.push(['>=', HOLD_OR_FLOOR, f.minHold]);
  const lotAc = LOT_STEPS_AC[f.lotStep] ?? 0;
  if (lotAc > 0) all.push(['>=', num('lot', 0), lotAc * 43560]);
  const btl = BTL_STEPS[f.btlStep] ?? Infinity;
  if (Number.isFinite(btl)) {
    all.push(['<=', num('btl', 1e9), btl]);
    if (!f.includeNominal) all.push(['>=', num('jv', 0), nominal]);
  }
  return all as FilterSpecification;
}

const fade = (from: number, to: number, value: number): Expr => ['interpolate', ['linear'], ['zoom'], from, 0, to, value];

/** Flat fills stay translucent so outlines and (in hybrid) the imagery read through. */
export function fillOpacity(s: AppState, polyMin: number): Expr {
  const op = s.basemap === 'hybrid' ? (s.shade === 'class' ? 0.24 : 0.5) : s.shade === 'class' ? 0.46 : 0.9;
  return fade(polyMin, polyMin + 0.6, op);
}

export function extrusionOpacity(s: AppState, polyMin: number): Expr {
  return fade(polyMin, polyMin + 0.6, s.basemap === 'hybrid' ? 0.74 : 0.9);
}

export function rimOpacity(s: AppState, rimMin: number): Expr {
  return fade(rimMin, rimMin + 0.4, s.basemap === 'hybrid' ? 0.9 : 0.95);
}

/** Filter for a parcel layer id (the rim layer gets the rim variant). */
export function layerFilter(id: string, f: Filters, nominal = NOMINAL_VALUE_MAX, search: SearchSet | null = null): FilterSpecification {
  return filterExpr(f, id === L_RIM ? 'rim' : 'body', nominal, search);
}

/** "4901" over "151K SF": house number + building size from the centroid layer. */
const SF: Expr = num('sf', 0);
const sfLabel: Expr = [
  'case',
  ['>=', SF, 1e6], ['concat', ['to-string', ['/', ['round', ['/', SF, 1e5]], 10]], 'M SF'],
  ['>=', SF, 1e3], ['concat', ['to-string', ['round', ['/', SF, 1e3]]], 'K SF'],
  ['>', SF, 0], ['concat', ['to-string', SF], ' SF'],
  '',
];

export function parcelLayers(manifest: Manifest, s: AppState, vector: boolean): LayerSpecification[] {
  const polyMin = manifest.tiles.polygons.minzoom;
  const poly = vector ? { source: SRC_POLY, 'source-layer': manifest.tiles.polygons.layer } : { source: SRC_POLY };
  const pts = vector ? { source: SRC_PTS, 'source-layer': manifest.tiles.points.layer } : { source: SRC_PTS };
  const nominal = nominalMax(manifest);
  const filter = layerFilter(L_FLAT, s.filters, nominal, s.search);
  const flat = s.extrude === 'flat';
  const color = colorExpr(manifest, s);
  const rimMin = manifest.tiles.polygons.rim_minzoom;
  const rim = rimHeights(s.extrude);
  const layers: Record<string, unknown>[] = [
    {
      id: L_FLAT, type: 'fill', ...poly, minzoom: polyMin, filter,
      layout: { visibility: flat ? 'visible' : 'none' },
      paint: { 'fill-color': color, 'fill-opacity': fillOpacity(s, polyMin) },
    },
    {
      id: L_OUTLINE, type: 'line', ...poly, minzoom: polyMin, filter,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': outlineColor(s),
        'line-width': outlineWidth(s),
        'line-opacity': fade(polyMin, polyMin + 0.6, 1),
      },
    },
    {
      id: L_3D, type: 'fill-extrusion', ...poly, minzoom: polyMin, filter,
      layout: { visibility: flat ? 'none' : 'visible' },
      paint: {
        'fill-extrusion-color': color,
        'fill-extrusion-height': heightExpr(s.extrude),
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': extrusionOpacity(s, polyMin),
        'fill-extrusion-vertical-gradient': true,
      },
    },
    {
      id: L_RIM, type: 'fill-extrusion', ...poly, minzoom: rimMin ?? 24, filter: layerFilter(L_RIM, s.filters, nominal, s.search),
      layout: { visibility: flat || rimMin == null ? 'none' : 'visible' },
      paint: {
        'fill-extrusion-color': rimColor(s),
        'fill-extrusion-base': rim.base,
        'fill-extrusion-height': rim.top,
        'fill-extrusion-opacity': rimOpacity(s, rimMin ?? 24),
        'fill-extrusion-vertical-gradient': false,
      },
    },
    {
      id: L_POINTS, type: 'circle', ...pts, maxzoom: polyMin + 1, filter,
      paint: {
        'circle-color': colorExpr(manifest, s, 'points') as DataDrivenPropertyValueSpecification<string>,
        'circle-radius': pointRadius(s),
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': pointStrokeWidth(s),
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], polyMin + 0.2, 0.95, polyMin + 1, 0],
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], polyMin + 0.2, 1, polyMin + 1, 0],
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: L_LABELS, type: 'symbol', ...pts, minzoom: LABEL_MIN_ZOOM, filter,
      layout: {
        'text-field': [
          'format',
          ['coalesce', ['get', 'hn'], ''], { 'text-font': ['literal', ['Noto Sans Bold']] },
          ['case', ['all', ['has', 'hn'], ['>', SF, 0]], '\n', ''], {},
          sfLabel, { 'font-scale': 0.82, 'text-font': ['literal', ['Noto Sans Regular']] },
        ],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], LABEL_MIN_ZOOM, 10.5, 18, 13],
        'text-max-width': 8,
        'text-padding': 3,
        'text-letter-spacing': 0.04,
        'symbol-sort-key': ['-', 0, num('jv', 0)],
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': 'rgba(0,0,0,0.88)',
        'text-halo-width': 1.4,
        'text-opacity': fade(LABEL_MIN_ZOOM, LABEL_MIN_ZOOM + 0.4, 1),
      },
    },
  ];
  return layers as unknown as LayerSpecification[];
}
