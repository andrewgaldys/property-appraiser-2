import {
  APP_NAME,
  APP_VERSION,
  BTL_STEPS,
  CLASS_SHORT,
  COUNTY_META,
  COUNTY_ORDER,
  DEFAULT_FILTERS,
  EXTRUDE_MODES,
  HOLD_MAX,
  LOT_STEPS_AC,
  SHADE_MODES,
} from '../config';
import { appendAll, h } from '../dom';
import { compact, int, money, shortDate } from '../format';
import type { Store } from '../state';
import type { AppState, Bbox, Filters, Manifest, ViewStats } from '../types';

export interface FilterPanelHandlers {
  onCounty(code: number | null): void;
  onMarket(bbox: Bbox): void;
}

type SegButton<T> = { value: T; el: HTMLButtonElement };

function segmented<T extends string | number>(
  label: string,
  options: { value: T; label: string }[],
  onPick: (v: T) => void,
): { el: HTMLElement; buttons: SegButton<T>[] } {
  const buttons = options.map((o) => ({
    value: o.value,
    el: h('button', { type: 'button', class: 'seg-btn', role: 'radio', onclick: () => onPick(o.value) }, o.label),
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

const lotLabel = (step: number) => {
  const ac = LOT_STEPS_AC[step] ?? 0;
  return ac === 0 ? 'Any' : `≥ ${ac} AC · ${int(ac * 43560)} SF`;
};
const btlLabel = (step: number) => {
  const r = BTL_STEPS[step] ?? Infinity;
  return Number.isFinite(r) ? `≤ ${r.toFixed(2)}×` : 'Any';
};
const btlCaption = (step: number) => {
  const r = BTL_STEPS[step] ?? Infinity;
  return Number.isFinite(r)
    ? `Improvements worth ≤ ${Math.round(r * 100)}% of land value. Vacant land always passes.`
    : 'Building value ÷ land value. Low ratios flag covered-land and teardown plays.';
};
const holdLabel = (y: number) => (y === 0 ? 'Any' : `≥ ${y} yrs`);

export class FilterPanel {
  private countySeg!: { el: HTMLElement; buttons: SegButton<number>[] };
  private extrudeSeg!: { el: HTMLElement; buttons: SegButton<string>[] };
  private shadeSeg!: { el: HTMLElement; buttons: SegButton<string>[] };
  private chips: { code: string; el: HTMLButtonElement }[] = [];
  private allChip!: HTMLButtonElement;
  private ranges!: {
    hold: { input: HTMLInputElement; out: HTMLElement };
    lot: { input: HTMLInputElement; out: HTMLElement };
    btl: { input: HTMLInputElement; out: HTMLElement; cap: HTMLElement };
  };
  private kpi!: Record<keyof ViewStats, HTMLElement>;
  private resetBtn!: HTMLButtonElement;

  constructor(
    private root: HTMLElement,
    private manifest: Manifest,
    private store: Store<AppState>,
    private handlers: FilterPanelHandlers,
  ) {
    this.render();
    this.sync(store.get());
    store.subscribe((s, prev) => {
      if (s.filters !== prev.filters || s.extrude !== prev.extrude || s.shade !== prev.shade) this.sync(s);
    });
  }

  private setFilters(patch: Partial<Filters>): void {
    this.store.set({ filters: { ...this.store.get().filters, ...patch } });
  }

  private render(): void {
    const m = this.manifest;
    const sample = m.source.kind === 'sample';

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
          h('span', null, c.name),
          h('span', { class: 'n' }, `${COUNTY_META[c.county]?.short ?? ''} ${c.count}`),
        ),
      ),
    );

    this.allChip = h('button', { type: 'button', class: 'chip', onclick: () => this.setFilters({ classes: [] }) }, 'All');
    this.chips = m.asset_classes.map((c) => ({
      code: c.code,
      el: h(
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
        CLASS_SHORT[c.code] ?? c.label,
        h('span', { class: 'n' }, int(c.count)),
      ),
    }));

    const range = (label: string, min: number, max: number, onInput: (v: number) => void) => {
      const input = h('input', { type: 'range', min, max, step: 1, value: min, 'aria-label': label }) as HTMLInputElement;
      input.addEventListener('input', () => onInput(Number(input.value)));
      return input;
    };
    const hold = { input: range('Minimum hold period', 0, HOLD_MAX, (v) => this.setFilters({ minHold: v })), out: h('output', null) };
    const lot = {
      input: range('Minimum lot size', 0, LOT_STEPS_AC.length - 1, (v) => this.setFilters({ lotStep: v })),
      out: h('output', null),
    };
    const btl = {
      input: range('Maximum building to land value ratio', 0, BTL_STEPS.length - 1, (v) => this.setFilters({ btlStep: v })),
      out: h('output', null),
      cap: h('p', { class: 'cap' }),
    };
    this.ranges = { hold, lot, btl };

    this.extrudeSeg = segmented<string>('3D extrusion', EXTRUDE_MODES.map((x) => ({ value: x.id, label: x.label })), (v) =>
      this.store.set({ extrude: v as AppState['extrude'] }),
    );
    this.shadeSeg = segmented<string>('Shade by', SHADE_MODES.map((x) => ({ value: x.id, label: x.label })), (v) =>
      this.store.set({ shade: v as AppState['shade'] }),
    );

    const kpi = (label: string) => {
      const v = h('div', { class: 'kpi-v' }, '—');
      return { tile: h('div', { class: 'kpi' }, h('div', { class: 'kpi-k' }, label), v), v };
    };
    const kp = kpi('Parcels');
    const kj = kpi('Just value');
    const ku = kpi('Units');
    const ks = kpi('Bldg SF');
    this.kpi = { parcels: kp.v, jv: kj.v, units: ku.v, sf: ks.v };

    this.resetBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn ghost',
        onclick: () => {
          this.store.set({ filters: { ...DEFAULT_FILTERS } });
        },
      },
      'Reset filters',
    );

    const rangeRow = (label: string, r: { input: HTMLInputElement; out: HTMLElement }, extra?: HTMLElement) =>
      h('label', { class: 'range' }, h('span', { class: 'range-head' }, h('span', null, label), r.out), r.input, extra);

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
          h('div', { class: 'brand-sub' }, 'Parcel intelligence · Martin · St. Lucie · Palm Beach'),
        ),
        h('span', { class: 'brand-ver' }, APP_VERSION),
      ),
      sample
        ? h(
            'div',
            { class: 'source-flag' },
            h('strong', null, 'Sample data'),
            ' Synthetic parcels for demonstration. Run the FDOR pipeline for the production roll.',
          )
        : null,
      h('section', { class: 'blk' }, h('h3', null, 'County'), this.countySeg.el),
      h('section', { class: 'blk' }, h('h3', null, 'Markets'), markets),
      h(
        'section',
        { class: 'blk' },
        h('h3', null, 'Asset class'),
        h('div', { class: 'chips' }, this.allChip, this.chips.map((c) => c.el)),
      ),
      h(
        'section',
        { class: 'blk' },
        h('h3', null, 'Screens'),
        rangeRow('Min hold period', hold),
        rangeRow('Min lot size', lot),
        rangeRow('Max building / land value', btl, btl.cap),
      ),
      h(
        'section',
        { class: 'blk' },
        h('h3', null, '3D extrusion'),
        this.extrudeSeg.el,
        h('h3', { class: 'sub' }, 'Shade by'),
        this.shadeSeg.el,
      ),
      h(
        'section',
        { class: 'blk' },
        h('h3', null, 'In view', h('span', { class: 'h3-note' }, 'filtered')),
        h('div', { class: 'kpis' }, kp.tile, kj.tile, ku.tile, ks.tile),
        h(
          'p',
          { class: 'cap' },
          `Dataset: ${int(m.stats.parcels)} parcels · ${money(m.stats.just_value)} just value · `,
          `${int(m.stats.owner_addr_groups + m.stats.owner_name_groups)} owner groups resolved`,
        ),
      ),
      h(
        'footer',
        { class: 'panel-foot' },
        this.resetBtn,
        h(
          'p',
          { class: 'cap' },
          `${m.source.label} · built ${shortDate(m.generated_at)}`,
          m.source.tax_roll_year ? ` · roll ${m.source.tax_roll_year}` : '',
          ` · hold = ${m.source.as_of_year} − sale year`,
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
    for (const c of this.chips) c.el.classList.toggle('on', active.has(c.code));

    const setRange = (r: { input: HTMLInputElement; out: HTMLElement }, v: number, text: string) => {
      if (Number(r.input.value) !== v) r.input.value = String(v);
      const max = Number(r.input.max) || 1;
      r.input.style.setProperty('--pct', `${(v / max) * 100}%`);
      r.out.textContent = text;
      r.out.classList.toggle('on', v > 0);
    };
    setRange(this.ranges.hold, f.minHold, holdLabel(f.minHold));
    setRange(this.ranges.lot, f.lotStep, lotLabel(f.lotStep));
    setRange(this.ranges.btl, f.btlStep, btlLabel(f.btlStep));
    this.ranges.btl.cap.textContent = btlCaption(f.btlStep);

    const dirty =
      f.counties.length > 0 || f.classes.length > 0 || f.minHold > 0 || f.lotStep > 0 || f.btlStep > 0;
    this.resetBtn.disabled = !dirty;
  }

  setStats(s: ViewStats): void {
    this.kpi.parcels.textContent = int(s.parcels);
    this.kpi.jv.textContent = money(s.jv);
    this.kpi.units.textContent = s.units ? int(s.units) : '—';
    this.kpi.sf.textContent = s.sf ? compact(s.sf) : '—';
  }
}
