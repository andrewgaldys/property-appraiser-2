import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import {
  BTL_STEPS,
  COLOR_HOVER,
  COLOR_PORTFOLIO,
  COLOR_SELECTED,
  HEIGHT_STOPS,
  LOT_STEPS_AC,
  RAMP_FOCUS,
  RAMP_NORMAL,
  RAMP_POINTS,
  RAMP_SELECTED,
} from '../config';
import type { AppState, ExtrudeMode, Filters, Manifest, Selection, ShadeMode } from '../types';

export const SRC_POLY = 'parcels';
export const SRC_PTS = 'parcel-centroids';
export const L_FLAT = 'parcel-flat';
export const L_OUTLINE = 'parcel-outline';
export const L_3D = 'parcel-3d';
export const L_POINTS = 'parcel-points';
export const PARCEL_LAYERS = [L_FLAT, L_OUTLINE, L_3D, L_POINTS];

type Expr = ExpressionSpecification;
const num = (key: string, fallback: number): Expr => ['number', ['get', key], fallback];

const SHADE_FIELD: Record<ShadeMode, { tile: string; fallback: number; quantile: keyof Manifest['quantiles'] }> = {
  value: { tile: 'jv', fallback: 0, quantile: 'just_value' },
  sqft: { tile: 'sf', fallback: 0, quantile: 'tot_lvg_area' },
  hold: { tile: 'hold', fallback: -1, quantile: 'hold_period_years' },
  ltv: { tile: 'ltv', fallback: 0, quantile: 'land_to_value_ratio' },
};

/** Ramp breakpoints = dataset percentiles (p5..p95), forced strictly ascending. */
export function shadeStops(manifest: Manifest, mode: ShadeMode): number[] {
  const q = [...(manifest.quantiles[SHADE_FIELD[mode].quantile] as number[])];
  const eps = mode === 'ltv' ? 0.001 : 1;
  for (let i = 1; i < q.length; i++) if (q[i]! <= q[i - 1]!) q[i] = q[i - 1]! + eps;
  return q;
}

function ramp(manifest: Manifest, mode: ShadeMode, colors: string[]): Expr {
  const f = SHADE_FIELD[mode];
  const stops = shadeStops(manifest, mode);
  const out: unknown[] = ['interpolate', ['linear'], num(f.tile, f.fallback)];
  stops.forEach((s, i) => out.push(s, colors[Math.min(i, colors.length - 1)]));
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

export function colorExpr(manifest: Manifest, s: AppState, variant: 'polygons' | 'points' = 'polygons'): Expr {
  const sel = s.selection;
  const unselected = variant === 'points' ? RAMP_POINTS : RAMP_NORMAL;
  const base = ramp(manifest, s.shade, !sel ? unselected : s.focus ? RAMP_FOCUS : RAMP_SELECTED);
  const cases: unknown[] = ['case'];
  if (sel) cases.push(isSelected(sel), COLOR_SELECTED);
  cases.push(isHovered, COLOR_HOVER);
  const pf = inPortfolio(sel);
  if (pf) cases.push(pf, COLOR_PORTFOLIO);
  cases.push(base);
  return cases as Expr;
}

function byHighlight<T extends number | string>(s: AppState, selected: T, portfolio: T, hover: T, rest: T): Expr {
  const cases: unknown[] = ['case'];
  if (s.selection) cases.push(isSelected(s.selection), selected);
  const pf = inPortfolio(s.selection);
  if (pf) cases.push(pf, portfolio);
  cases.push(isHovered, hover, rest);
  return cases as Expr;
}

export const outlineColor = (s: AppState): Expr =>
  byHighlight(s, '#ffffff', '#cfcfcf', '#bdbdbd', s.focus ? '#1c1c1c' : s.selection ? '#2a2a2a' : '#363636');
export const outlineWidth = (s: AppState): Expr => byHighlight(s, 2.6, 1.6, 1.4, 0.6);

export function pointRadius(s: AppState): Expr {
  const at = (base: number, sel: number, pf: number): Expr | number => {
    const cases: unknown[] = ['case'];
    if (s.selection) cases.push(isSelected(s.selection), sel);
    const p = inPortfolio(s.selection);
    if (p) cases.push(p, pf);
    if (cases.length === 1) return base;
    cases.push(base);
    return cases as Expr;
  };
  return ['interpolate', ['linear'], ['zoom'], 5, at(2.2, 4.5, 3.5), 9, at(3.4, 6.5, 5), 12, at(5, 9, 7)] as Expr;
}

export const pointStrokeWidth = (s: AppState): Expr => byHighlight(s, 2, 1.2, 1, 0);

const HEIGHT_FIELD = { value: ['jv', 0], sqft: ['sf', 0], hold: ['hold', -1] } as const;

export function heightExpr(mode: ExtrudeMode): Expr | number {
  if (mode === 'flat') return 0;
  const [key, fallback] = HEIGHT_FIELD[mode];
  return ['interpolate', ['linear'], num(key, fallback), ...HEIGHT_STOPS[mode]] as Expr;
}

export function filterExpr(f: Filters): FilterSpecification {
  const all: unknown[] = ['all'];
  if (f.counties.length) all.push(['in', ['get', 'co'], ['literal', f.counties]]);
  if (f.classes.length) all.push(['in', ['get', 'cls'], ['literal', f.classes]]);
  if (f.minHold > 0) all.push(['>=', num('hold', -1), f.minHold]);
  const lotAc = LOT_STEPS_AC[f.lotStep] ?? 0;
  if (lotAc > 0) all.push(['>=', num('lot', 0), lotAc * 43560]);
  const btl = BTL_STEPS[f.btlStep] ?? Infinity;
  if (Number.isFinite(btl)) all.push(['<=', num('btl', 1e9), btl]);
  return all as FilterSpecification;
}

const fade = (from: number, to: number, value: number): Expr => ['interpolate', ['linear'], ['zoom'], from, 0, to, value];

export function parcelLayers(manifest: Manifest, s: AppState, vector: boolean): LayerSpecification[] {
  const polyMin = manifest.tiles.polygons.minzoom;
  const poly = vector ? { source: SRC_POLY, 'source-layer': manifest.tiles.polygons.layer } : { source: SRC_POLY };
  const pts = vector ? { source: SRC_PTS, 'source-layer': manifest.tiles.points.layer } : { source: SRC_PTS };
  const filter = filterExpr(s.filters);
  const flat = s.extrude === 'flat';
  const color = colorExpr(manifest, s);
  const layers: Record<string, unknown>[] = [
    {
      id: L_FLAT, type: 'fill', ...poly, minzoom: polyMin, filter,
      layout: { visibility: flat ? 'visible' : 'none' },
      paint: { 'fill-color': color, 'fill-opacity': fade(polyMin, polyMin + 0.6, 0.92) },
    },
    {
      id: L_OUTLINE, type: 'line', ...poly, minzoom: 13, filter,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': outlineColor(s),
        'line-width': outlineWidth(s),
        'line-opacity': fade(13, 13.8, 1),
      },
    },
    {
      id: L_3D, type: 'fill-extrusion', ...poly, minzoom: polyMin, filter,
      layout: { visibility: flat ? 'none' : 'visible' },
      paint: {
        'fill-extrusion-color': color,
        'fill-extrusion-height': heightExpr(s.extrude),
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': fade(polyMin, polyMin + 0.6, 0.9),
        'fill-extrusion-vertical-gradient': true,
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
  ];
  return layers as unknown as LayerSpecification[];
}
