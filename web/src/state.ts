import { DEFAULT_FILTERS, PRESET_IDS, STORAGE_KEY, UI_KEY } from './config';
import type { AppState } from './types';

type Listener<T> = (state: T, prev: T) => void;

/** Minimal observable store: one state object, shallow merges, synchronous listeners. */
export class Store<T extends object> {
  private state: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  set(patch: Partial<T>): void {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    for (const l of this.listeners) l(this.state, prev);
  }

  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Per-viewer convenience only: restore the last filters / view modes when available. */
export function loadSavedView(): Partial<AppState> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Partial<AppState>;
    const out: Partial<AppState> = {};
    if (v.filters && typeof v.filters === 'object') {
      const f = { ...DEFAULT_FILTERS, ...v.filters };
      f.includeNominal = f.includeNominal === true;
      f.presets = Array.isArray(f.presets) ? f.presets.filter((p) => PRESET_IDS.includes(p)) : [];
      out.filters = f;
    }
    if (v.extrude && ['flat', 'value', 'sqft', 'hold'].includes(v.extrude)) out.extrude = v.extrude;
    if (v.shade && ['class', 'value', 'sqft', 'hold', 'ltv'].includes(v.shade)) out.shade = v.shade;
    if (v.basemap && ['dark', 'hybrid', 'split'].includes(v.basemap)) out.basemap = v.basemap;
    if (typeof v.lens === 'boolean') out.lens = v.lens;
    if (v.ownerGroup === 'name' || v.ownerGroup === 'addr') out.ownerGroup = v.ownerGroup;
    return out;
  } catch {
    return {};
  }
}

/** Per-viewer UI conveniences (open sections, collapsed legend, dismissed hint); never required. */
export function loadUi<T extends object>(fallback: T): T {
  try {
    const raw = window.localStorage.getItem(UI_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveUi(patch: Record<string, unknown>): void {
  try {
    const raw = window.localStorage.getItem(UI_KEY);
    const cur = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    window.localStorage.setItem(UI_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch {
    /* storage unavailable: the UI just forgets */
  }
}

export function saveView(s: AppState): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ filters: s.filters, extrude: s.extrude, shade: s.shade, basemap: s.basemap, lens: s.lens, ownerGroup: s.ownerGroup }),
    );
  } catch {
    /* storage unavailable (private mode, blocked): ignore */
  }
}
