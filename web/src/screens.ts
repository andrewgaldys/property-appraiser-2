import { BTL_STEPS, CLASS_SHORT, COUNTY_META, DEFAULT_FILTERS, LOT_STEPS_AC, PRESETS, PRESET_IDS } from './config';
import type { ExtrudeMode, Filters, OwnerGrouping, PresetId, SearchSpec, ShadeMode } from './types';

/**
 * A "screen": everything that decides which parcels and owners a broker is looking at. The same
 * object is saved (named screens), written into the page link (so a link reopens the screen) and,
 * later, could be stored by a backend: ScreenRepository is the only storage seam.
 */
export interface ScreenState {
  filters: Filters;
  search: SearchSpec | null;
  ownerGroup: OwnerGrouping;
  extrude?: ExtrudeMode;
  shade?: ShadeMode;
  results?: { open: boolean; tab: 'owners' | 'parcels'; scope: 'all' | 'view' };
  /** Map camera when saved (links carry MapLibre's own `map=` instead). */
  view?: { center: [number, number]; zoom: number; bearing: number; pitch: number };
}

export interface SavedScreen {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  state: ScreenState;
}

/** Storage for named screens. Swap LocalScreenRepository for an HTTP-backed one to share them across devices. */
export interface ScreenRepository {
  list(): Promise<SavedScreen[]>;
  save(name: string, state: ScreenState): Promise<SavedScreen>;
  remove(id: string): Promise<void>;
}

/** This browser only (localStorage). Failures (private mode, quota) surface as rejected promises. */
export class LocalScreenRepository implements ScreenRepository {
  constructor(private key = 'pa2.screens.v1') {}

  private read(): SavedScreen[] {
    const raw = window.localStorage.getItem(this.key);
    const data = raw ? (JSON.parse(raw) as { v: number; screens: SavedScreen[] }) : null;
    return data?.v === 1 && Array.isArray(data.screens) ? data.screens : [];
  }

  private write(screens: SavedScreen[]): void {
    window.localStorage.setItem(this.key, JSON.stringify({ v: 1, screens }));
  }

  async list(): Promise<SavedScreen[]> {
    return this.read().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(name: string, state: ScreenState): Promise<SavedScreen> {
    const now = new Date().toISOString();
    const screens = this.read();
    const existing = screens.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const id = existing?.id ?? (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const screen: SavedScreen = { id, name, createdAt: existing?.createdAt ?? now, updatedAt: now, state };
    this.write([screen, ...screens.filter((s) => s.id !== id)]);
    return screen;
  }

  async remove(id: string): Promise<void> {
    this.write(this.read().filter((s) => s.id !== id));
  }
}

// ---- Links ------------------------------------------------------------------------------------

/** Hash keys a screen writes (MapLibre owns `map=`; the app owns `p=` parcel and `o=` owner). */
export const SCREEN_KEYS = ['co', 'cl', 'hold', 'lot', 'btl', 'nom', 'pre', 'q', 'g', 'x', 'c', 't', 'sc'] as const;

const nearest = (steps: number[], v: number): number => {
  let best = 0;
  steps.forEach((s, i) => {
    if (Math.abs(s - v) < Math.abs((steps[best] ?? Infinity) - v)) best = i;
  });
  return best;
};

/** Screen -> hash params (values unencoded; defaults left out so links stay short). */
export function screenParams(s: ScreenState): Partial<Record<(typeof SCREEN_KEYS)[number], string>> {
  const f = s.filters;
  const out: Partial<Record<(typeof SCREEN_KEYS)[number], string>> = {};
  if (f.counties.length) out.co = f.counties.join(',');
  if (f.classes.length) out.cl = f.classes.join(',');
  if (f.minHold > 0) out.hold = String(f.minHold);
  if (f.lotStep > 0) out.lot = String(LOT_STEPS_AC[f.lotStep]);
  if (f.btlStep > 0) out.btl = String(BTL_STEPS[f.btlStep]);
  if (f.includeNominal) out.nom = '1';
  if (f.presets.length) out.pre = f.presets.join(',');
  if (s.search) out.q = s.search.kind === 'query' ? `q:${s.search.q}` : s.search.kind === 'owner' ? `owner:${s.search.name}` : `mail:${s.search.label}`;
  if (s.ownerGroup === 'addr') out.g = 'addr';
  if (s.extrude && s.extrude !== 'value') out.x = s.extrude;
  if (s.shade && s.shade !== 'class') out.c = s.shade;
  if (s.results?.open) out.t = s.results.tab;
  if (s.results?.scope === 'view') out.sc = 'view';
  return out;
}

/** Hash params -> screen, or null when the link carries no screen at all. Unknown values are dropped. */
export function paramsScreen(get: (k: string) => string | null): ScreenState | null {
  if (!SCREEN_KEYS.some((k) => get(k) != null)) return null;
  const list = (k: string) => (get(k) ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  const num = (k: string) => {
    const v = Number(get(k));
    return Number.isFinite(v) ? v : null;
  };
  const counties = list('co').map(Number).filter((c) => COUNTY_META[c]);
  const classes = list('cl').filter((c) => CLASS_SHORT[c]);
  const lot = num('lot');
  const btl = num('btl');
  const q = get('q');
  let search: SearchSpec | null = null;
  if (q?.startsWith('q:')) search = { kind: 'query', q: q.slice(2) };
  else if (q?.startsWith('owner:')) search = { kind: 'owner', name: q.slice(6) };
  else if (q?.startsWith('mail:')) search = { kind: 'mail', label: q.slice(5) };
  const filters: Filters = {
    ...DEFAULT_FILTERS,
    counties,
    classes,
    minHold: Math.max(0, Math.min(40, Math.round(num('hold') ?? 0))),
    lotStep: lot ? nearest(LOT_STEPS_AC, lot) : 0,
    btlStep: btl ? nearest(BTL_STEPS.map((b) => (Number.isFinite(b) ? b : 1e9)), btl) : 0,
    includeNominal: get('nom') === '1',
    presets: list('pre').filter((p): p is PresetId => PRESET_IDS.includes(p as PresetId)),
  };
  const x = get('x');
  const c = get('c');
  const t = get('t');
  return {
    filters,
    search,
    ownerGroup: get('g') === 'addr' ? 'addr' : 'name',
    extrude: x === 'flat' || x === 'sqft' || x === 'hold' ? x : 'value',
    shade: c === 'value' || c === 'sqft' || c === 'hold' || c === 'ltv' ? c : 'class',
    results: { open: t === 'owners' || t === 'parcels', tab: t === 'parcels' ? 'parcels' : 'owners', scope: get('sc') === 'view' ? 'view' : 'all' },
  };
}

/** "Long-term holders · Multifamily 10+ · Palm Beach · held 10+ yrs". */
export function describeScreen(s: ScreenState): string {
  const f = s.filters;
  const parts: string[] = [];
  for (const p of f.presets) parts.push(PRESETS.find((x) => x.id === p)?.label ?? p);
  for (const c of f.classes) parts.push(CLASS_SHORT[c] ?? c);
  for (const c of f.counties) parts.push(COUNTY_META[c]?.name ?? String(c));
  if (f.minHold > 0) parts.push(`held ${f.minHold}+ yrs`);
  if (f.lotStep > 0) parts.push(`lot ${LOT_STEPS_AC[f.lotStep]}+ AC`);
  if (f.btlStep > 0) parts.push(`bldg / land ≤ ${BTL_STEPS[f.btlStep]}×`);
  if (s.search) parts.push(s.search.kind === 'query' ? `“${s.search.q}”` : s.search.kind === 'owner' ? s.search.name : s.search.label);
  return parts.join(' · ') || 'All parcels';
}
