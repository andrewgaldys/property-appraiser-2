import { CLASS_COLORS, CLASS_FALLBACK, CLASS_SHORT, EXTRUDE_MODES, RAMP_NORMAL, SHADE_MODES } from '../config';
import { appendAll, clear, h } from '../dom';
import { compact, int, money, pct } from '../format';
import { hasListings } from '../listings';
import { shadeStops, type MetricMode } from '../map/layers';
import type { Store } from '../state';
import type { AppState, Manifest } from '../types';

function tick(mode: MetricMode, v: number): string {
  if (mode === 'value') return money(v);
  if (mode === 'sqft') return `${compact(v)} SF`;
  if (mode === 'hold') return `${Math.max(0, Math.round(v))} yrs`;
  return pct(v);
}

/**
 * The legend: asset-class swatches (or the metric ramp) and what height encodes. It lives in the
 * Map panel, so it is only on screen when someone asks for it.
 */
export class Legend {
  readonly el: HTMLElement;
  private body: HTMLElement;

  constructor(
    private manifest: Manifest,
    private store: Store<AppState>,
  ) {
    this.body = h('div', { class: 'lg-body' });
    this.el = h('section', { class: 'legend', 'aria-label': 'Map legend' }, h('h3', { class: 'lg-head' }, 'Legend'), this.body);
    this.render(store.get());
    store.subscribe((s, prev) => {
      if (s.shade !== prev.shade || s.extrude !== prev.extrude || s.selection !== prev.selection) this.render(s);
    });
  }

  /** The listings index is in: add what listed parcels look like (nothing when none is listed). */
  setListings(): void {
    this.render(this.store.get());
  }

  private listed(): HTMLElement | null {
    if (!hasListings()) return null;
    return h(
      'div',
      { class: 'lg-listed' },
      h('span', { class: 'lg-k' }, 'Listed'),
      h('span', { class: 'lg-chip solid' }, 'FOR SALE'),
      h('span', { class: 'lg-chip line' }, 'FOR LEASE'),
      h('span', { class: 'lg-dash', title: 'Dashed outline: a listed parcel' }),
    );
  }

  private classRows(): HTMLElement {
    const classes = this.manifest.asset_classes.filter((c) => c.count > 0 || c.primary);
    return h(
      'ul',
      { class: 'lg-classes' },
      classes.map((c) =>
        h(
          'li',
          null,
          h('i', { class: 'lg-sw', style: { background: CLASS_COLORS[c.code] ?? CLASS_FALLBACK } }),
          h('span', { class: 'lg-name' }, CLASS_SHORT[c.code] ?? c.label),
          h('span', { class: 'lg-n' }, int(c.count)),
        ),
      ),
    );
  }

  private render(s: AppState): void {
    clear(this.body);
    const ext = EXTRUDE_MODES.find((x) => x.id === s.extrude)!;
    const height = h(
      'div',
      { class: 'lg-row lg-height' },
      h('span', { class: 'lg-k' }, 'Height'),
      h('span', { class: 'lg-v' }, s.extrude === 'flat' ? 'Flat' : `${ext.legend} (log scale)`),
    );
    const keys = s.selection
      ? h(
          'div',
          { class: 'lg-keys' },
          h('span', { class: 'lg-key' }, h('i', { class: 'sel' }), 'Selected'),
          h('span', { class: 'lg-key' }, h('i', { class: 'ring' }), 'Same owner'),
        )
      : null;

    if (s.shade === 'class') {
      appendAll(this.body, h('div', { class: 'lg-title' }, 'Asset class'), this.classRows(), height, this.listed(), keys);
      return;
    }
    const mode = s.shade as MetricMode;
    const shade = SHADE_MODES.find((x) => x.id === mode)!;
    const stops = shadeStops(this.manifest, mode);
    const grad = `linear-gradient(90deg, ${RAMP_NORMAL.map((c, i) => `${c} ${i * 25}%`).join(', ')})`;
    appendAll(
      this.body,
      h('div', { class: 'lg-title' }, shade.legend),
      h('div', { class: 'lg-ramp', style: { background: grad } }),
      h(
        'div',
        { class: 'lg-ticks' },
        h('span', null, tick(mode, stops[0]!)),
        h('span', null, tick(mode, stops[2]!)),
        h('span', null, tick(mode, stops[4]!)),
      ),
      h('div', { class: 'lg-ticks lg-q' }, h('span', null, 'Low 5%'), h('span', null, 'Median'), h('span', null, 'Top 5%')),
      mode === 'hold' ? h('p', { class: 'lg-note' }, 'Holds older than the sale records sit at their minimum.') : null,
      h('div', { class: 'lg-row' }, h('span', { class: 'lg-k' }, 'Outline'), h('span', { class: 'lg-v' }, 'Asset class')),
      h(
        'div',
        { class: 'lg-outline-keys' },
        this.manifest.asset_classes
          .filter((c) => c.primary)
          .map((c) =>
            h('span', { title: c.label }, h('i', { style: { borderColor: CLASS_COLORS[c.code] ?? CLASS_FALLBACK } }), CLASS_SHORT[c.code] ?? c.code),
          ),
      ),
      height,
      this.listed(),
      keys,
    );
  }
}
