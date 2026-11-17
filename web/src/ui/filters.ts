import {
  BTL_STEPS,
  CLASS_COLORS,
  CLASS_FALLBACK,
  CLASS_SHORT,
  COUNTY_META,
  DEFAULT_FILTERS,
  EXTRUDE_MODES,
  HOLD_MAX,
  LOT_STEPS_AC,
  SHADE_MODES,
} from '../config';
import { appendAll, clear, h, icon, type Child } from '../dom';
import { compact, int, money, shortDate } from '../format';
import { MARKET_LABEL, hasListings, listedSet, type ListingsIndex } from '../listings';
import { nominalMax } from '../map/layers';
import { loadUi, saveUi, type Store } from '../state';
import type { AppState, Bbox, Filters, Manifest, MarketFilter, ViewStats } from '../types';
import { INFO, countyCodes, coverageDetail, coverageExample, coverageLine } from './facts';
import { infoTip } from './infotip';

export interface FilterPanelHandlers {
  /** Counties were picked: frame them on the map (an empty list means "all": leave the view alone). */
  onCounties(codes: number[]): void;
  onMarket(bbox: Bbox): void;
  /** Open the Owners table for the current screen. */
  onShowResults(): void;
  /** Open "How it works" (optionally at the data coverage table). */
  onHelp(section?: 'coverage'): void;
}

export type SectionId = 'where' | 'classes' | 'market' | 'screens';
const SECTION_DEFAULTS: Record<SectionId, boolean> = {
  where: true,
  classes: true,
  market: true,
  screens: false,
};
/** Other components mount here: the owner signals (step 3 of Filters) and Top owners (Insights). */
export type SlotId = 'signals' | 'insights';
/** The pop-up panels this component fills (see ui/rail.ts). */
export interface FilterMounts {
  /** Filters: location, asset class, owner signals, more filters, and the way to the owners list. */
  filters: HTMLElement;
  /** Insights: live totals for the map view (Top owners mounts under them). */
  insights: HTMLElement;
  /** Map: what height and color show. */
  map: HTMLElement;
}
const MARKETS_SHOWN = 8;

type SegButton<T> = { value: T; el: HTMLButtonElement };

function segmented<T extends string | number>(
  label: string,
  options: { value: T; label: string; title?: string }[],
  onPick: (v: T) => void,
): { el: HTMLElement; buttons: SegButton<T>[] } {
  const buttons = options.map((o) => ({
    value: o.value,
    el: h('button', { type: 'button', class: 'seg-btn', role: 'radio', title: o.title, onclick: () => onPick(o.value) }, o.label),
  }));
  const el = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label }, buttons.map((b) => b.el));
  el.style.setProperty('--n', String(options.length));
  return { el, buttons };
}

function markSeg<T>(buttons: SegButton<T>[], active: T): void {
  for (const b of buttons) {
    const on = b.value === active;
    b.el.classList.toggle('on', on);
    b.el.setAttribute('aria-checked', String(on));
  }
}

export const lotLabel = (step: number): string => {
  const ac = LOT_STEPS_AC[step] ?? 0;
  return ac === 0 ? 'Any' : `${ac} AC+`;
};
export const btlLabel = (step: number): string => {
  const r = BTL_STEPS[step] ?? Infinity;
  return Number.isFinite(r) ? `≤ ${r.toFixed(2)}×` : 'Any';
};
export const holdLabel = (y: number): string => (y === 0 ? 'Any' : `${y}+ yrs`);
const btlCaption = (step: number): string | null => {
  const r = BTL_STEPS[step] ?? Infinity;
  return Number.isFinite(r) ? `Buildings worth at most ${Math.round(r * 100)}% of the land.` : null;
};

/** Active sliders under "More filters", for the sidebar summary. */
export function activeScreens(f: Filters): number {
  return (f.minHold > 0 ? 1 : 0) + (f.lotStep > 0 ? 1 : 0) + (f.btlStep > 0 ? 1 : 0);
}

/** A section header's step tag ("01"): the sidebar reads top to bottom as where, what, who. */
export const stepTag = (n: number | null): HTMLElement | null => (n ? h('span', { class: 'sec-step', 'aria-hidden': 'true' }, String(n).padStart(2, '0')) : null);

interface RangeRow {
  input: HTMLInputElement;
  out: HTMLElement;
}

export class FilterPanel {
  private ui = loadUi({ sections: { ...SECTION_DEFAULTS } as Record<SectionId, boolean> });
  private sections = new Map<SectionId, { el: HTMLDetailsElement; sum: HTMLElement }>();
  private slots: Record<SlotId, HTMLElement> = {
    signals: h('div', { class: 'slot' }),
    insights: h('div', { class: 'slot' }),
  };
  private extrudeSeg!: { el: HTMLElement; buttons: SegButton<string>[] };
  private shadeSeg!: { el: HTMLElement; buttons: SegButton<string>[] };
  private countyChips: { code: number; el: HTMLButtonElement }[] = [];
  private allCounties!: HTMLButtonElement;
  private markets!: HTMLElement;
  private marketsKey = '';
  private chips: { code: string; el: HTMLButtonElement }[] = [];
  private allChip!: HTMLButtonElement;
  private ranges!: { hold: RangeRow; lot: RangeRow; btl: RangeRow & { cap: HTMLElement } };
  private nominalToggle!: HTMLInputElement;
  private kpi!: Record<'parcels' | 'jv' | 'units' | 'sf', HTMLElement>;
  private inviewNote!: HTMLElement;
  private resetBtn!: HTMLButtonElement;
  private ctaCount!: HTMLElement;
  private marketSeg!: { el: HTMLElement; buttons: SegButton<MarketFilter>[] };
  private marketCap!: HTMLElement;

  constructor(
    private mounts: FilterMounts,
    private manifest: Manifest,
    private store: Store<AppState>,
    private handlers: FilterPanelHandlers,
  ) {
    this.ui.sections = { ...SECTION_DEFAULTS, ...this.ui.sections };
    this.render();
    this.setListings(null); // hidden until a listing source is connected
    this.sync(store.get());
    store.subscribe((s, prev) => {
      if (s.filters !== prev.filters || s.extrude !== prev.extrude || s.shade !== prev.shade || s.search !== prev.search) this.sync(s);
    });
  }

  /** Where another component mounts. */
  slot(id: SlotId): HTMLElement {
    return this.slots[id];
  }

  private setFilters(patch: Partial<Filters>): void {
    this.store.set({ filters: { ...this.store.get().filters, ...patch } });
  }

  private section(id: SectionId, title: string, step: number | null, ...body: Child[]): HTMLDetailsElement {
    const sum = h('span', { class: 'sec-sum' });
    const el = h(
      'details',
      { class: 'sec', 'data-sec': id },
      h('summary', null, stepTag(step), h('span', { class: 'sec-title' }, title), sum, icon('chevron', 16)),
      h('div', { class: 'sec-body' }, body),
    ) as HTMLDetailsElement;
    el.open = this.ui.sections[id];
    el.addEventListener('toggle', () => {
      this.ui.sections[id] = el.open;
      // Read-modify-write: other panels (Top owners) keep their own open state in the same record.
      const stored = loadUi({ sections: {} as Record<string, boolean> }).sections;
      saveUi({ sections: { ...stored, [id]: el.open } });
    });
    this.sections.set(id, { el, sum });
    return el;
  }

  /** Markets to offer: the picked counties' largest, or with none picked each county's largest first. */
  private marketList(counties: number[]): Manifest['cities'] {
    const all = this.manifest.cities;
    if (counties.length) return all.filter((c) => counties.includes(c.county)).slice(0, MARKETS_SHOWN);
    const order = countyCodes(this.manifest);
    const firsts = order.map((code) => all.find((c) => c.county === code)).filter((c): c is Manifest['cities'][number] => !!c);
    const rest = all.filter((c) => !firsts.includes(c));
    return [...firsts, ...rest]
      .slice(0, MARKETS_SHOWN)
      .sort((a, b) => order.indexOf(a.county) - order.indexOf(b.county) || b.count - a.count);
  }

  private renderMarkets(counties: number[]): void {
    const key = counties.join(',');
    if (key === this.marketsKey && this.markets.childElementCount) return;
    this.marketsKey = key;
    clear(this.markets);
    for (const c of this.marketList(counties)) {
      this.markets.append(
        h(
          'button',
          { type: 'button', class: 'market', title: `Fly to ${c.name}`, onclick: () => this.handlers.onMarket(c.bbox) },
          h('span', { class: 'market-name' }, c.name),
          h('span', { class: 'n' }, `${COUNTY_META[c.county]?.short ?? ''} · ${int(c.count)}`),
        ),
      );
    }
  }

  private render(): void {
    const m = this.manifest;
    const sample = m.source.kind === 'sample';
    const nominalCount = m.data_quality?.nominal_parcels ?? m.stats.nominal_parcels ?? 0;

    // ---- 01 Location: counties north to south (any mix), then the largest markets in them -------
    const toggleCounty = (code: number) => {
      const cur = new Set(this.store.get().filters.counties);
      if (cur.has(code)) cur.delete(code);
      else cur.add(code);
      const next = countyCodes(m).filter((c) => cur.has(c));
      // Every county picked is the same as none: keep the state (and the link) simple.
      const counties = next.length === m.counties.length ? [] : next;
      this.setFilters({ counties });
      this.handlers.onCounties(counties);
    };
    this.allCounties = h('button', { type: 'button', class: 'chip chip-all', onclick: () => this.setFilters({ counties: [] }) }, 'All counties');
    this.countyChips = countyCodes(m).map((code) => {
      const c = m.counties.find((x) => x.code === code);
      return {
        code,
        el: h(
          'button',
          { type: 'button', class: 'chip', title: `${COUNTY_META[code]?.badge ?? code}: ${int(c?.count ?? 0)} parcels`, onclick: () => toggleCounty(code) },
          h('span', { class: 'chip-label' }, COUNTY_META[code]?.name ?? String(code)),
          h('span', { class: 'n' }, compact(c?.count ?? 0)),
        ),
      };
    });
    this.markets = h('div', { class: 'markets' });

    // ---- 02 Asset class --------------------------------------------------------------------------
    this.allChip = h('button', { type: 'button', class: 'chip chip-all', onclick: () => this.setFilters({ classes: [] }) }, 'All classes');
    this.chips = m.asset_classes.map((c) => {
      const el = h(
        'button',
        {
          type: 'button',
          class: 'chip',
          title: c.label,
          onclick: () => {
            const cur = new Set(this.store.get().filters.classes);
            if (cur.has(c.code)) cur.delete(c.code);
            else cur.add(c.code);
            this.setFilters({ classes: [...cur] });
          },
        },
        h('i', { class: 'chip-sw' }),
        h('span', { class: 'chip-label' }, CLASS_SHORT[c.code] ?? c.label),
        h('span', { class: 'n' }, compact(c.count)),
      );
      el.style.setProperty('--c', CLASS_COLORS[c.code] ?? CLASS_FALLBACK);
      return { code: c.code, el };
    });

    // ---- More filters ----------------------------------------------------------------------------
    const range = (label: string, min: number, max: number, onInput: (v: number) => void) => {
      const input = h('input', { type: 'range', min, max, step: 1, value: min, 'aria-label': label }) as HTMLInputElement;
      input.addEventListener('input', () => onInput(Number(input.value)));
      return input;
    };
    const hold = { input: range('Minimum years held', 0, HOLD_MAX, (v) => this.setFilters({ minHold: v })), out: h('output', null) };
    const lot = {
      input: range('Minimum lot size', 0, LOT_STEPS_AC.length - 1, (v) => this.setFilters({ lotStep: v })),
      out: h('output', null),
    };
    const btl = {
      input: range('Maximum building-to-land value', 0, BTL_STEPS.length - 1, (v) => this.setFilters({ btlStep: v })),
      out: h('output', null),
      cap: h('p', { class: 'cap' }),
    };
    this.ranges = { hold, lot, btl };

    this.nominalToggle = h('input', {
      type: 'checkbox',
      role: 'switch',
      onchange: () => this.setFilters({ includeNominal: this.nominalToggle.checked }),
    }) as HTMLInputElement;

    this.marketSeg = segmented<MarketFilter>(
      'On the market',
      [
        { value: '', label: 'Any', title: 'Every parcel, listed or not' },
        { value: 'any', label: 'Listed', title: 'Parcels with a listing for sale or for lease' },
        { value: 'sale', label: 'For sale', title: 'Parcels listed for sale' },
        { value: 'lease', label: 'For lease', title: 'Parcels with space listed for lease' },
      ],
      (v) => this.setFilters({ market: v }),
    );
    this.marketCap = h('p', { class: 'cap' });

    this.extrudeSeg = segmented<string>('3D height', EXTRUDE_MODES.map((x) => ({ value: x.id, label: x.label })), (v) =>
      this.store.set({ extrude: v as AppState['extrude'] }),
    );
    this.shadeSeg = segmented<string>('Color by', SHADE_MODES.map((x) => ({ value: x.id, label: x.label })), (v) =>
      this.store.set({ shade: v as AppState['shade'] }),
    );

    // ---- Live totals -----------------------------------------------------------------------------
    const kpi = (label: string, info?: string) => {
      const v = h('div', { class: 'kpi-v' }, '—');
      return {
        tile: h('div', { class: 'kpi' }, h('div', { class: 'kpi-k' }, label, info ? infoTip(label, info) : null), v),
        v,
      };
    };
    const kp = kpi('Parcels');
    const kj = kpi('Assessed value', `Sum of the assessed market value of the parcels in view. ${INFO.marketValue}`);
    const ku = kpi('Residential units', INFO.units);
    const ks = kpi('Building SF');
    this.kpi = { parcels: kp.v, jv: kj.v, units: ku.v, sf: ks.v };
    this.inviewNote = h('p', { class: 'inview-note', hidden: true });

    this.resetBtn = h(
      'button',
      { type: 'button', class: 'btn quiet sm', onclick: () => this.store.set({ filters: { ...DEFAULT_FILTERS }, search: null }) },
      'Reset all filters',
    );
    this.ctaCount = h('p', { class: 'cta-count', hidden: true });

    const rangeRow = (label: string, r: RangeRow, info?: Child, ...extra: Child[]) =>
      h(
        'div',
        { class: 'range' },
        h('div', { class: 'range-head' }, h('span', { class: 'range-label' }, label, info), r.out),
        r.input,
        ...extra,
      );

    const coverage = coverageLine(m);
    const max = nominalMax(m);

    // ---- Filters panel: where, what, who, then the way to the list --------------------------------
    appendAll(
      this.mounts.filters,
      sample ? h('div', { class: 'source-flag' }, h('strong', null, 'Sample data.'), ' Synthetic parcels for demonstration only.') : null,
      this.section(
        'where',
        'Location',
        1,
        h('div', { class: 'chips county-chips', role: 'group', 'aria-label': 'Counties, north to south' }, this.allCounties, this.countyChips.map((c) => c.el)),
        h('div', { class: 'field-label markets-label' }, 'Jump to a market'),
        this.markets,
      ),
      this.section('classes', 'Asset class', 2, h('div', { class: 'chips' }, this.allChip, this.chips.map((c) => c.el))),
      this.slots.signals,
      this.section(
        'market',
        'On the market',
        null,
        this.marketSeg.el,
        this.marketCap,
      ),
      this.section(
        'screens',
        'More filters',
        null,
        rangeRow(
          'Min years held',
          hold,
          infoTip('years held', () => coverageDetail(m)),
          coverage ? h('p', { class: 'cap' }, coverage, ` Older holds show as a minimum, like “${coverageExample(m)}”.`) : null,
        ),
        rangeRow('Min lot size', lot),
        rangeRow('Max building-to-land value', btl, infoTip('building-to-land value', INFO.btl), btl.cap),
        h(
          'div',
          { class: 'toggle-row' },
          h(
            'label',
            { class: 'switch' },
            this.nominalToggle,
            h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
            h('span', { class: 'switch-label' }, 'Count nominal-value parcels'),
          ),
          infoTip(
            'nominal-value parcels',
            `Parcels assessed under ${money(max)} (${int(nominalCount)} in this dataset) are usually common areas, condo-style or sub-parcels whose value sits on a neighboring parcel, like CityPlace’s $100 parcels.\n\nThey stay on the map and keep their badge in the parcel panel, but value filters and the totals leave them out unless this is on.`,
          ),
        ),
      ),
      h(
        'div',
        { class: 'cta' },
        h(
          'button',
          { type: 'button', class: 'btn solid cta-btn', onclick: () => this.handlers.onShowResults() },
          icon('table', 15),
          'See matching owners',
          icon('arrow', 14),
        ),
        this.ctaCount,
        this.resetBtn,
      ),
    );

    // ---- Insights panel: live totals for the map view (Top owners mounts below) -------------------
    appendAll(
      this.mounts.insights,
      h(
        'section',
        { class: 'inview', 'aria-label': 'Totals for the parcels in view' },
        h('div', { class: 'inview-head' }, h('h3', null, h('i', { class: 'live-dot', 'aria-hidden': 'true' }), 'In the map view'), h('span', { class: 'inview-sub' }, 'after filters')),
        h('div', { class: 'kpis' }, kp.tile, kj.tile, ku.tile, ks.tile),
        this.inviewNote,
      ),
      this.slots.insights,
      h(
        'footer',
        { class: 'panel-foot' },
        h(
          'p',
          { class: 'cap' },
          `All data: ${int(m.stats.parcels)} parcels · ${money(m.stats.just_value)} assessed · ${compact(m.stats.owner_addr_groups + m.stats.owner_name_groups)} owner groups`,
        ),
        h(
          'p',
          { class: 'cap' },
          m.source.tax_roll_year ? `${m.source.tax_roll_year} tax roll · ` : '',
          `updated ${shortDate(m.generated_at)} · `,
          h('button', { type: 'button', class: 'linklike', onclick: () => this.handlers.onHelp('coverage') }, 'Data and coverage'),
        ),
      ),
    );

    // ---- Map panel: what the blocks show (the basemap switch and the legend sit around this) ------
    appendAll(
      this.mounts.map,
      h(
        'div',
        { class: 'map-style' },
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Height shows'), this.extrudeSeg.el),
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Color shows'), this.shadeSeg.el),
      ),
    );
  }

  private sync(s: AppState): void {
    const f = s.filters;
    markSeg(this.extrudeSeg.buttons, s.extrude);
    markSeg(this.shadeSeg.buttons, s.shade);

    const counties = new Set(f.counties);
    this.allCounties.classList.toggle('on', counties.size === 0);
    this.allCounties.setAttribute('aria-pressed', String(counties.size === 0));
    for (const c of this.countyChips) {
      c.el.classList.toggle('on', counties.has(c.code));
      c.el.setAttribute('aria-pressed', String(counties.has(c.code)));
    }
    this.renderMarkets(f.counties);

    const active = new Set(f.classes);
    this.allChip.classList.toggle('on', active.size === 0);
    this.allChip.setAttribute('aria-pressed', String(active.size === 0));
    for (const c of this.chips) {
      c.el.classList.toggle('on', active.has(c.code));
      c.el.setAttribute('aria-pressed', String(active.has(c.code)));
    }

    const setRange = (r: RangeRow, v: number, text: string) => {
      if (Number(r.input.value) !== v) r.input.value = String(v);
      const max = Number(r.input.max) || 1;
      r.input.style.setProperty('--pct', `${(v / max) * 100}%`);
      r.out.textContent = text;
      r.out.classList.toggle('on', v > 0);
    };
    setRange(this.ranges.hold, f.minHold, holdLabel(f.minHold));
    setRange(this.ranges.lot, f.lotStep, lotLabel(f.lotStep));
    setRange(this.ranges.btl, f.btlStep, btlLabel(f.btlStep));
    const cap = btlCaption(f.btlStep);
    this.ranges.btl.cap.textContent = cap ?? '';
    this.ranges.btl.cap.hidden = !cap;
    this.nominalToggle.checked = f.includeNominal;

    // Section summaries: what is applied, readable while the section is collapsed.
    const sum = (id: SectionId, text: string, on = false) => {
      const sec = this.sections.get(id)!;
      sec.sum.textContent = text;
      sec.sum.classList.toggle('on', on);
    };
    const names = f.counties.map((c) => COUNTY_META[c]?.name ?? String(c));
    sum('where', names.length === 0 ? 'All counties' : names.length <= 2 ? names.join(', ') : `${names.length} counties`, names.length > 0);
    sum('classes', f.classes.length ? `${f.classes.length} of ${this.chips.length}` : 'All', f.classes.length > 0);
    const n = activeScreens(f) + (f.includeNominal ? 1 : 0);
    sum('screens', n ? `${n} on` : 'None', n > 0);
    markSeg(this.marketSeg.buttons, f.market);
    sum('market', f.market ? MARKET_LABEL[f.market] : 'Any', !!f.market);
    const dirty = f.counties.length > 0 || f.classes.length > 0 || n > 0 || f.presets.length > 0 || !!f.market || !!s.search;
    this.resetBtn.hidden = !dirty;
  }

  /** The listings index is in: offer "On the market" when something is listed (hidden otherwise). */
  setListings(ix: ListingsIndex | null): void {
    const sec = this.sections.get('market')!.el;
    sec.hidden = !hasListings();
    if (!ix || sec.hidden) return;
    const n = (k: 'any' | 'sale' | 'lease') => listedSet(k)?.size ?? 0;
    for (const b of this.marketSeg.buttons) {
      if (b.value) b.el.title = `${int(n(b.value))} ${n(b.value) === 1 ? 'parcel' : 'parcels'} ${MARKET_LABEL[b.value].toLowerCase()}`;
    }
    const names = [...new Set(ix.sources.map((s) => s.name))];
    this.marketCap.textContent = `${int(n('any'))} listed parcels: ${int(n('sale'))} for sale, ${int(n('lease'))} with space for lease. From ${names.join(', ')}.`;
  }

  /** Totals for the view; null while they are still being loaded. */
  setStats(s: ViewStats | null): void {
    for (const el of Object.values(this.kpi)) el.classList.toggle('pending', !s);
    if (!s) {
      for (const el of Object.values(this.kpi)) el.textContent = '…';
      this.inviewNote.hidden = true;
      return;
    }
    this.kpi.parcels.textContent = int(s.parcels);
    this.kpi.jv.textContent = money(s.jv);
    this.kpi.units.textContent = s.units ? int(s.units) : '—';
    this.kpi.sf.textContent = s.sf ? compact(s.sf) : '—';
    this.inviewNote.hidden = !s.nominal;
    this.inviewNote.textContent = s.nominal
      ? `${int(s.nominal)} nominal-value ${s.nominal === 1 ? 'parcel' : 'parcels'} in view not counted`
      : '';
  }

  /** Matches for the whole screen (every county), once the parcel table is loaded; null hides the line. */
  setMatches(n: { owners: number; parcels: number } | null): void {
    this.ctaCount.hidden = !n;
    if (n) this.ctaCount.textContent = `${int(n.owners)} ${n.owners === 1 ? 'owner' : 'owners'} · ${int(n.parcels)} ${n.parcels === 1 ? 'parcel' : 'parcels'} match`;
  }
}
