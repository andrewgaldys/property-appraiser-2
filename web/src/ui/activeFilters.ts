import { CLASS_COLORS, CLASS_FALLBACK, CLASS_SHORT, COUNTY_META, DEFAULT_FILTERS } from '../config';
import { clear, h, icon } from '../dom';
import type { Store } from '../state';
import type { AppState, Filters, SearchSet } from '../types';
import { btlLabel, holdLabel, lotLabel } from './filters';

interface Chip {
  label: string;
  title: string;
  color?: string;
  remove: (f: Filters) => Partial<Filters>;
  /** The search chip clears the search instead of a filter field. */
  search?: boolean;
}

function chipsFor(f: Filters, search: SearchSet | null): Chip[] {
  const out: Chip[] = [];
  if (search)
    out.push({ label: `${search.label} · ${search.pids.length.toLocaleString('en-US')} parcels`, title: 'Search results', remove: () => ({}), search: true });
  for (const c of f.counties)
    out.push({ label: COUNTY_META[c]?.name ?? String(c), title: 'County', remove: (x) => ({ counties: x.counties.filter((v) => v !== c) }) });
  for (const cls of f.classes)
    out.push({
      label: CLASS_SHORT[cls] ?? cls,
      title: 'Asset class',
      color: CLASS_COLORS[cls] ?? CLASS_FALLBACK,
      remove: (x) => ({ classes: x.classes.filter((v) => v !== cls) }),
    });
  if (f.minHold > 0) out.push({ label: `Held ${holdLabel(f.minHold)}`, title: 'Min years held', remove: () => ({ minHold: 0 }) });
  if (f.lotStep > 0) out.push({ label: `Lot ${lotLabel(f.lotStep)}`, title: 'Min lot size', remove: () => ({ lotStep: 0 }) });
  if (f.btlStep > 0)
    out.push({ label: `Bldg / land ${btlLabel(f.btlStep)}`, title: 'Max building-to-land value', remove: () => ({ btlStep: 0 }) });
  if (f.includeNominal)
    out.push({ label: 'Nominal values counted', title: 'Nominal-value parcels', remove: () => ({ includeNominal: false }) });
  return out;
}

/** Removable chips for every applied filter, over the map, plus "Reset all". Hidden when none apply. */
export class ActiveFilters {
  readonly el: HTMLElement;

  constructor(private store: Store<AppState>) {
    this.el = h('div', { class: 'active-filters', role: 'region', 'aria-label': 'Applied filters', hidden: true });
    this.render(store.get());
    store.subscribe((s, prev) => {
      if (s.filters !== prev.filters || s.search !== prev.search) this.render(s);
    });
  }

  private render(s: AppState): void {
    clear(this.el);
    const chips = chipsFor(s.filters, s.search);
    this.el.hidden = chips.length === 0;
    if (!chips.length) return;
    const set = (patch: Partial<Filters>) => this.store.set({ filters: { ...this.store.get().filters, ...patch } });
    this.el.append(
      h('span', { class: 'af-label' }, 'Filters'),
      ...chips.map((c) =>
        h(
          'span',
          { class: `af-chip${c.search ? ' af-search' : ''}`, title: c.title },
          c.color ? h('i', { class: 'af-sw', style: { background: c.color } }) : null,
          h('span', { class: 'af-text' }, c.label),
          h(
            'button',
            {
              type: 'button',
              class: 'af-x',
              'aria-label': `Remove filter: ${c.label}`,
              onclick: () => (c.search ? this.store.set({ search: null }) : set(c.remove(this.store.get().filters))),
            },
            icon('close', 12),
          ),
        ),
      ),
      h('button', { type: 'button', class: 'af-reset', onclick: () => this.store.set({ filters: { ...DEFAULT_FILTERS }, search: null }) }, 'Reset all'),
    );
  }
}
