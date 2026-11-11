import {
  APP_NAME,
  APP_VERSION,
  BTL_STEPS,
  CLASS_COLORS,
  CLASS_FALLBACK,
  CLASS_SHORT,
  COUNTY_META,
  COUNTY_ORDER,
  DEFAULT_FILTERS,
  EXTRUDE_MODES,
  HOLD_MAX,
  LOT_STEPS_AC,
  SHADE_MODES,
} from '../config';
import { appendAll, h, icon, type Child } from '../dom';
import { compact, int, money, shortDate } from '../format';
import { nominalMax } from '../map/layers';
import { loadUi, saveUi, type Store } from '../state';
import type { AppState, Bbox, Filters, Manifest, ViewStats } from '../types';
import { INFO, coverageDetail, coverageExample, coverageLine } from './facts';
import { infoTip } from './infotip';

export interface FilterPanelHandlers {
  onCounty(code: number | null): void;
  onMarket(bbox: Bbox): void;
}

export type SectionId = 'county' | 'markets' | 'classes' | 'screens' | 'display';
const SECTION_DEFAULTS: Record<SectionId, boolean> = {
  county: true,
  markets: true,
  classes: true,
  screens: false,
  display: false,
};

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

/** Active screens, for the sidebar summary. */
export function activeScreens(f: Filters): number {
  return (f.minHold > 0 ? 1 : 0) + (f.lotStep > 0 ? 1 : 0) + (f.btlStep > 0 ? 1 : 0);
}

interface RangeRow {
  input: HTMLInputElement;
  out: HTMLElement;
}

export class FilterPanel {
  private ui = loadUi({ sections: { ...SECTION_DEFAULTS } as Record<SectionId, boolean> });
  private sections = new Map<SectionId, { el: HTMLDetailsElement; sum: HTMLElement }>();
  private countySeg!: { el: HTMLElement; buttons: SegButton<number>[] };
  private extrudeSeg!: { el: HTMLElement; buttons: SegButton<string>[] };
  private shadeSeg!: { el: HTMLElement; buttons: SegButton<string>[] };
  private chips: { code: string; el: HTMLButtonElement }[] = [];
  private allChip!: HTMLButtonElement;
  private ranges!: { hold: RangeRow; lot: RangeRow; btl: RangeRow & { cap: HTMLElement } };
  private nominalToggle!: HTMLInputElement;
  private kpi!: Record<'parcels' | 'jv' | 'units' | 'sf', HTMLElement>;
  private inviewNote!: HTMLElement;
  private resetBtn!: HTMLButtonElement;

  constructor(
    private root: HTMLElement,
    private manifest: Manifest,
    private store: Store<AppState>,
    private handlers: FilterPanelHandlers,
  ) {
    this.ui.sections = { ...SECTION_DEFAULTS, ...this.ui.sections };
    this.render();
    this.sync(store.get());
    store.subscribe((s, prev) => {
      if (s.filters !== prev.filters || s.extrude !== prev.extrude || s.shade !== prev.shade || s.search !== prev.search) this.sync(s);
    });
  }

  private setFilters(patch: Partial<Filters>): void {
    this.store.set({ filters: { ...this.store.get().filters, ...patch } });
  }

  /** Open (and scroll to) a sidebar section: used by the first-visit hint. */
  openSection(id: SectionId): void {
    const s = this.sections.get(id);
    if (!s) return;
    s.el.open = true;
    s.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    s.el.querySelector('summary')?.focus({ preventScroll: true });
  }

  private section(id: SectionId, title: string, ...body: Child[]): HTMLDetailsElement {
    const sum = h('span', { class: 'sec-sum' });
    const el = h(
      'details',
      { class: 'sec', 'data-sec': id },
      h('summary', null, h('span', { class: 'sec-title' }, title), sum, icon('chevron', 16)),
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

  private render(): void {
    const m = this.manifest;
    const sample = m.source.kind === 'sample';
    const nominalCount = m.data_quality?.nominal_parcels ?? m.stats.nominal_parcels ?? 0;

    this.countySeg = segmented<number>(
      'County',
      [{ value: 0, label: 'All' }, ...COUNTY_ORDER.map((c) => ({ value: c, label: COUNTY_META[c]!.name }))],
      (v) => {
        this.setFilters({ counties: v ? [v] : [] });
        this.handlers.onCounty(v || null);
      },
    );

    const markets = h(
      'div',
      { class: 'markets' },
      m.cities.slice(0, 8).map((c) =>
        h(
          'button',
          { type: 'button', class: 'market', title: `Fly to ${c.name}`, onclick: () => this.handlers.onMarket(c.bbox) },
          h('span', { class: 'market-name' }, c.name),
          h('span', { class: 'n' }, `${COUNTY_META[c.county]?.short ?? ''} · ${int(c.count)}`),
        ),
      ),
    );

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
        h('span', { class: 'n' }, int(c.count)),
      );
      el.style.setProperty('--c', CLASS_COLORS[c.code] ?? CLASS_FALLBACK);
      return { code: c.code, el };
    });

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

    this.extrudeSeg = segmented<string>('3D height', EXTRUDE_MODES.map((x) => ({ value: x.id, label: x.label })), (v) =>
      this.store.set({ extrude: v as AppState['extrude'] }),
    );
    this.shadeSeg = segmented<string>('Color by', SHADE_MODES.map((x) => ({ value: x.id, label: x.label })), (v) =>
      this.store.set({ shade: v as AppState['shade'] }),
    );

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
      { type: 'button', class: 'btn ghost sm', onclick: () => this.store.set({ filters: { ...DEFAULT_FILTERS }, search: null }) },
      'Reset all filters',
    );

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

    appendAll(
      this.root,
      h(
        'header',
        { class: 'brand' },
        h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h(
          'div',
          { class: 'brand-text' },
          h('div', { class: 'brand-name' }, APP_NAME),
          h('div', { class: 'brand-sub' }, 'Commercial & multifamily parcels'),
        ),
        h('span', { class: 'brand-ver' }, APP_VERSION),
      ),
      sample
        ? h('div', { class: 'source-flag' }, h('strong', null, 'Sample data.'), ' Synthetic parcels for demonstration only.')
        : null,
      h(
        'section',
        { class: 'inview', 'aria-label': 'Totals for the parcels in view' },
        h('div', { class: 'inview-head' }, h('h2', null, 'In view'), h('span', { class: 'inview-sub' }, 'after filters')),
        h('div', { class: 'kpis' }, kp.tile, kj.tile, ku.tile, ks.tile),
        this.inviewNote,
      ),
      this.section('county', 'County', this.countySeg.el),
      this.section('markets', 'Markets', markets),
      this.section('classes', 'Asset class', h('div', { class: 'chips' }, this.allChip, this.chips.map((c) => c.el))),
      this.section(
        'screens',
        'Screens',
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
            `Parcels assessed under ${money(max)} (${int(nominalCount)} in this dataset) are usually common areas, condo-style or sub-parcels whose value sits on a neighboring parcel, like CityPlace’s $100 parcels.\n\nThey stay on the map and keep their badge in the parcel panel, but value screens and the in-view totals leave them out unless this is on.`,
          ),
        ),
      ),
      this.section(
        'display',
        'Display',
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, '3D height'), this.extrudeSeg.el),
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Color by'), this.shadeSeg.el),
      ),
      h(
        'footer',
        { class: 'panel-foot' },
        this.resetBtn,
        h(
          'p',
          { class: 'cap' },
          `${int(m.stats.parcels)} parcels · ${money(m.stats.just_value)} assessed · ${compact(m.stats.owner_addr_groups + m.stats.owner_name_groups)} owner groups`,
        ),
        h(
          'p',
          { class: 'cap' },
          `${m.source.label} · built ${shortDate(m.generated_at)}`,
          m.source.tax_roll_year ? ` · ${m.source.tax_roll_year} roll` : '',
        ),
      ),
    );
  }

  private sync(s: AppState): void {
    const f = s.filters;
    markSeg(this.countySeg.buttons, f.counties.length === 1 ? f.counties[0]! : 0);
    markSeg(this.extrudeSeg.buttons, s.extrude);
    markSeg(this.shadeSeg.buttons, s.shade);
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
      const s = this.sections.get(id)!;
      s.sum.textContent = text;
      s.sum.classList.toggle('on', on);
    };
    sum('county', f.counties.length === 1 ? COUNTY_META[f.counties[0]!]?.name ?? '' : 'All', f.counties.length > 0);
    sum('markets', `${Math.min(this.manifest.cities.length, 8)} cities`);
    sum('classes', f.classes.length ? `${f.classes.length} of ${this.chips.length}` : 'All', f.classes.length > 0);
    const n = activeScreens(f);
    sum('screens', n ? `${n} active` : 'None', n > 0);
    const ext = EXTRUDE_MODES.find((x) => x.id === s.extrude)?.label ?? '';
    const shade = SHADE_MODES.find((x) => x.id === s.shade)?.label ?? '';
    sum('display', `${ext} · ${shade}`);

    const dirty = f.counties.length > 0 || f.classes.length > 0 || n > 0 || f.includeNominal || !!s.search;
    this.resetBtn.disabled = !dirty;
  }

  setStats(s: ViewStats): void {
    this.kpi.parcels.textContent = int(s.parcels);
    this.kpi.jv.textContent = money(s.jv);
    this.kpi.units.textContent = s.units ? int(s.units) : '—';
    this.kpi.sf.textContent = s.sf ? compact(s.sf) : '—';
    this.inviewNote.hidden = !s.nominal;
    this.inviewNote.textContent = s.nominal
      ? `${int(s.nominal)} nominal-value ${s.nominal === 1 ? 'parcel' : 'parcels'} in view not counted`
      : '';
  }
}
