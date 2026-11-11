import { CLASS_COLORS, CLASS_FALLBACK, CLASS_SHORT, EXTRUDE_MODES, RAMP_NORMAL, SHADE_MODES } from '../config';
import { appendAll, clear, h, icon } from '../dom';
import { compact, int, money, pct } from '../format';
import { shadeStops, type MetricMode } from '../map/layers';
import { loadUi, saveUi, type Store } from '../state';
import type { AppState, Manifest } from '../types';

function tick(mode: MetricMode, v: number): string {
  if (mode === 'value') return money(v);
  if (mode === 'sqft') return `${compact(v)} SF`;
  if (mode === 'hold') return `${Math.max(0, Math.round(v))} yrs`;
  return pct(v);
}

/**
 * Bottom-left legend: asset-class swatches (or the metric ramp) and what height encodes. It
 * collapses to a small "Legend" button so it never sits on parcels; the choice is remembered.
 * Starts collapsed on small screens, and steps aside on its own while the property panel is open
 * on a screen too narrow for both (reopening when the panel closes).
 */
export class Legend {
  private el: HTMLElement;
  private body: HTMLElement;
  private toggle: HTMLButtonElement;
  /** The viewer's choice (remembered). */
  private pref: boolean;
  /** Collapsed for now because a panel needs the room. */
  private auto = false;
  private panelOpen = false;
  private tableOpen = false;

  constructor(
    container: HTMLElement,
    private manifest: Manifest,
    store: Store<AppState>,
  ) {
    const small = window.matchMedia('(max-width: 720px)').matches;
    this.pref = loadUi({ legendCollapsed: small }).legendCollapsed;
    this.body = h('div', { class: 'lg-body', id: 'legend-body' });
    this.toggle = h(
      'button',
      {
        type: 'button',
        class: 'lg-toggle',
        'aria-controls': 'legend-body',
        onclick: () => {
          const next = !this.collapsed;
          this.auto = false;
          this.pref = next;
          saveUi({ legendCollapsed: next });
          this.apply();
        },
      },
      icon('legend', 14),
      h('span', { class: 'lg-toggle-label' }, 'Legend'),
      icon('chevron', 14),
    );
    this.el = h('section', { class: 'legend', 'aria-label': 'Map legend' }, this.toggle, this.body);
    container.append(this.el);
    this.apply();
    this.render(store.get());
    window.addEventListener('resize', () => this.makeRoom(this.panelOpen));
    store.subscribe((s, prev) => {
      if (!!s.selection !== !!prev.selection || !!s.ownerFocus !== !!prev.ownerFocus) this.makeRoom(!!s.selection || !!s.ownerFocus);
      if (s.shade !== prev.shade || s.extrude !== prev.extrude || s.selection !== prev.selection) this.render(s);
    });
  }

  private get collapsed(): boolean {
    return this.auto || this.pref;
  }

  /** The results table is open: the map is short, so the legend steps aside. */
  setTableOpen(open: boolean): void {
    this.tableOpen = open;
    this.makeRoom(this.panelOpen);
  }

  private makeRoom(panelOpen: boolean): void {
    this.panelOpen = panelOpen;
    const cramped = (panelOpen && window.innerWidth < 1280) || this.tableOpen;
    if (cramped && !this.collapsed) {
      this.auto = true;
      this.apply();
    } else if (!cramped && this.auto) {
      this.auto = false;
      this.apply();
    }
  }

  private apply(): void {
    const c = this.collapsed;
    this.el.classList.toggle('collapsed', c);
    this.body.hidden = c;
    this.toggle.setAttribute('aria-expanded', String(!c));
    this.toggle.title = c ? 'Show legend' : 'Hide legend';
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
      appendAll(this.body, h('div', { class: 'lg-title' }, 'Asset class'), this.classRows(), height, keys);
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
      keys,
    );
  }
}
