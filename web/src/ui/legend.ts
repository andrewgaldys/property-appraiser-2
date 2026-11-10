import { CLASS_COLORS, CLASS_FALLBACK, CLASS_SHORT, EXTRUDE_MODES, RAMP_NORMAL, SHADE_MODES } from '../config';
import { appendAll, clear, h } from '../dom';
import { compact, int, money, pct } from '../format';
import { shadeStops, type MetricMode } from '../map/layers';
import type { Store } from '../state';
import type { AppState, Manifest } from '../types';

function tick(mode: MetricMode, v: number): string {
  if (mode === 'value') return money(v);
  if (mode === 'sqft') return `${compact(v)} SF`;
  if (mode === 'hold') return `${Math.max(0, Math.round(v))} yr`;
  return pct(v);
}

/** Compact bottom-left legend: asset-class swatches (or the metric ramp) + what height encodes. */
export class Legend {
  private el: HTMLElement;

  constructor(
    container: HTMLElement,
    private manifest: Manifest,
    store: Store<AppState>,
  ) {
    this.el = h('div', { class: 'legend', role: 'note', 'aria-label': 'Map legend' });
    container.append(this.el);
    this.render(store.get());
    store.subscribe((s, prev) => {
      if (s.shade !== prev.shade || s.extrude !== prev.extrude || s.selection !== prev.selection) this.render(s);
    });
  }

  private classRows(compactRows: boolean): HTMLElement {
    const classes = this.manifest.asset_classes.filter((c) => c.count > 0 || c.primary);
    return h(
      'ul',
      { class: `lg-classes${compactRows ? ' compact' : ''}` },
      classes.map((c) =>
        h(
          'li',
          null,
          h('i', { class: 'lg-sw', style: { background: CLASS_COLORS[c.code] ?? CLASS_FALLBACK } }),
          h('span', { class: 'lg-name' }, c.label),
          compactRows ? null : h('span', { class: 'lg-n' }, int(c.count)),
        ),
      ),
    );
  }

  private render(s: AppState): void {
    clear(this.el);
    const ext = EXTRUDE_MODES.find((x) => x.id === s.extrude)!;
    const height = h(
      'div',
      { class: 'lg-row lg-height' },
      h('span', { class: 'lg-k' }, 'Height'),
      h('span', { class: 'lg-v' }, s.extrude === 'flat' ? 'Flat (2D)' : `${ext.legend}, log-scaled`),
    );
    const keys = s.selection
      ? h(
          'div',
          { class: 'lg-keys' },
          h('span', { class: 'lg-key' }, h('i', { style: { background: '#ffffff' } }), 'Selected'),
          h('span', { class: 'lg-key' }, h('i', { class: 'ring' }), 'Same owner'),
        )
      : null;

    if (s.shade === 'class') {
      appendAll(this.el, h('div', { class: 'lg-title' }, 'Asset class'), this.classRows(false), height, keys);
      return;
    }
    const mode = s.shade as MetricMode;
    const shade = SHADE_MODES.find((x) => x.id === mode)!;
    const stops = shadeStops(this.manifest, mode);
    const grad = `linear-gradient(90deg, ${RAMP_NORMAL.map((c, i) => `${c} ${i * 25}%`).join(', ')})`;
    appendAll(
      this.el,
      h('div', { class: 'lg-row' }, h('span', { class: 'lg-k' }, 'Fill'), h('span', { class: 'lg-v' }, shade.legend)),
      h('div', { class: 'lg-ramp', style: { background: grad } }),
      h(
        'div',
        { class: 'lg-ticks' },
        h('span', null, tick(mode, stops[0]!)),
        h('span', null, tick(mode, stops[2]!)),
        h('span', null, tick(mode, stops[4]!)),
      ),
      h('div', { class: 'lg-ticks lg-q' }, h('span', null, 'p5'), h('span', null, 'median'), h('span', null, 'p95')),
      h('div', { class: 'lg-row' }, h('span', { class: 'lg-k' }, 'Outline'), h('span', { class: 'lg-v' }, 'Asset class')),
      h(
        'div',
        { class: 'lg-outline-keys' },
        this.manifest.asset_classes
          .filter((c) => c.primary)
          .map((c) => h('span', { title: c.label }, h('i', { style: { borderColor: CLASS_COLORS[c.code] ?? CLASS_FALLBACK } }), CLASS_SHORT[c.code] ?? c.code)),
      ),
      height,
      keys,
    );
  }
}
