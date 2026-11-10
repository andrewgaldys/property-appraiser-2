import { COLOR_PORTFOLIO, COLOR_SELECTED, EXTRUDE_MODES, RAMP_NORMAL, SHADE_MODES } from '../config';
import { appendAll, clear, h } from '../dom';
import { compact, money, pct } from '../format';
import { shadeStops } from '../map/layers';
import type { Store } from '../state';
import type { AppState, Manifest, ShadeMode } from '../types';

function tick(mode: ShadeMode, v: number): string {
  if (mode === 'value') return money(v);
  if (mode === 'sqft') return `${compact(v)} SF`;
  if (mode === 'hold') return `${Math.max(0, Math.round(v))} yr`;
  return pct(v);
}

/** Scale legend for the single-hue ramp + what height encodes. */
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

  private render(s: AppState): void {
    clear(this.el);
    const shade = SHADE_MODES.find((x) => x.id === s.shade)!;
    const ext = EXTRUDE_MODES.find((x) => x.id === s.extrude)!;
    const stops = shadeStops(this.manifest, s.shade);
    const grad = `linear-gradient(90deg, ${RAMP_NORMAL.map((c, i) => `${c} ${i * 25}%`).join(', ')})`;
    const swatch = (color: string, label: string) =>
      h('span', { class: 'lg-key' }, h('i', { style: { background: color } }), label);
    appendAll(
      this.el,
      h('div', { class: 'lg-row' }, h('span', { class: 'lg-k' }, 'Shade'), h('span', { class: 'lg-v' }, shade.legend)),
      h('div', { class: 'lg-ramp', style: { background: grad } }),
      h(
        'div',
        { class: 'lg-ticks' },
        h('span', null, tick(s.shade, stops[0]!)),
        h('span', null, tick(s.shade, stops[2]!)),
        h('span', null, tick(s.shade, stops[4]!)),
      ),
      h('div', { class: 'lg-ticks lg-q' }, h('span', null, 'p5'), h('span', null, 'median'), h('span', null, 'p95')),
      h(
        'div',
        { class: 'lg-row' },
        h('span', { class: 'lg-k' }, 'Height'),
        h('span', { class: 'lg-v' }, s.extrude === 'flat' ? 'Flat (2D)' : `${ext.legend}, log-scaled`),
      ),
      s.selection
        ? h('div', { class: 'lg-keys' }, swatch(COLOR_SELECTED, 'Selected'), swatch(COLOR_PORTFOLIO, 'Same owner'))
        : null,
    );
  }
}
