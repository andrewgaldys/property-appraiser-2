import { APP_NAME } from '../config';
import { h, icon } from '../dom';

/** The pop-up panels the rail opens. */
export type PanelId = 'filters' | 'insights' | 'saved' | 'map';

const PANELS: { id: PanelId; label: string; title: string; icon: string }[] = [
  { id: 'filters', label: 'Filters', title: 'Filters', icon: 'filters' },
  { id: 'insights', label: 'Insights', title: 'On the map now', icon: 'chart' },
  { id: 'saved', label: 'Saved', title: 'Saved screens', icon: 'save' },
  { id: 'map', label: 'Map', title: 'Map and legend', icon: 'layers' },
];

export interface RailHandlers {
  /** Open or close the owners list. */
  onList(): void;
  onHelp(): void;
  /** A panel opened (its id) or the last one closed (null). */
  onPanel(id: PanelId | null): void;
}

/**
 * The slim rail beside the map and the pop-up panels it opens. By default nothing is open: the
 * page is the map. Filters, insights, saved screens and the map's own options (basemap, colors,
 * legend) each open as one panel over the map's left edge, one at a time; the owners list and
 * the guide open from the rail too.
 */
export class Rail {
  private buttons = new Map<string, HTMLButtonElement>();
  private panels = new Map<PanelId, { el: HTMLElement; body: HTMLElement }>();
  private badge: HTMLElement;
  private currentId: PanelId | null = null;

  constructor(
    rail: HTMLElement,
    /** Panels are laid over this element (the map). */
    host: HTMLElement,
    private handlers: RailHandlers,
  ) {
    const button = (id: string, label: string, iconName: string, onclick: () => void, title = label) => {
      const el = h('button', { type: 'button', class: 'rail-btn', title, onclick }, icon(iconName, 20), h('span', null, label));
      this.buttons.set(id, el);
      return el;
    };
    this.badge = h('i', { class: 'rail-badge', hidden: true });
    const filters = button('filters', 'Filters', 'filters', () => this.toggle('filters'), 'Filters: where, what and who');
    filters.append(this.badge);
    filters.setAttribute('aria-expanded', 'false');
    rail.append(
      h('div', { class: 'rail-brand', title: APP_NAME, role: 'img', 'aria-label': APP_NAME }, h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))),
      filters,
      button('list', 'Owners', 'table', () => this.handlers.onList(), 'Owners and parcels list'),
      ...PANELS.filter((p) => p.id !== 'filters').map((p) => {
        const el = button(p.id, p.label, p.icon, () => this.toggle(p.id), p.title);
        el.setAttribute('aria-expanded', 'false');
        return el;
      }),
      h('span', { class: 'rail-gap' }),
      button('help', 'Help', 'help', () => this.handlers.onHelp(), 'How it works (press ?)'),
    );

    const wrap = h('div', { class: 'rail-panels' });
    for (const p of PANELS) {
      const body = h('div', { class: 'rp-body' });
      const el = h(
        'section',
        { class: 'rail-panel', 'data-panel': p.id, 'aria-label': p.title, hidden: true },
        h(
          'header',
          { class: 'rp-head' },
          h('h2', null, p.title),
          h('button', { type: 'button', class: 'icon-btn rp-close', 'aria-label': `Close ${p.title}`, onclick: () => this.open(null) }, icon('close', 15)),
        ),
        body,
      );
      this.panels.set(p.id, { el, body });
      wrap.append(el);
    }
    host.append(wrap);
  }

  /** Where a panel's content goes. */
  body(id: PanelId): HTMLElement {
    return this.panels.get(id)!.body;
  }

  get current(): PanelId | null {
    return this.currentId;
  }

  open(id: PanelId | null): void {
    if (id === this.currentId) return;
    this.currentId = id;
    for (const [pid, p] of this.panels) {
      const on = pid === id;
      p.el.hidden = !on;
      const btn = this.buttons.get(pid)!;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-expanded', String(on));
    }
    document.body.classList.toggle('rail-open', id != null);
    this.handlers.onPanel(id);
  }

  toggle(id: PanelId): void {
    this.open(this.currentId === id ? null : id);
  }

  /** How many filter groups are applied (shown on the Filters button). */
  setFilterCount(n: number): void {
    this.badge.hidden = n === 0;
    this.badge.textContent = String(n);
  }

  /** The owners list is open: its rail button reads as active. */
  setListOpen(open: boolean): void {
    this.buttons.get('list')!.classList.toggle('on', open);
  }

  /** Width the open panel takes from the map's left edge, for framing (0 when none is open or on a phone). */
  inset(): number {
    if (!this.currentId || window.matchMedia('(max-width: 720px)').matches) return 0;
    const r = this.panels.get(this.currentId)!.el.getBoundingClientRect();
    return Math.round(r.width + 24);
  }
}
