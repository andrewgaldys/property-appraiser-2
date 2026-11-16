import { APP_NAME } from '../config';
import { appendAll, h, icon } from '../dom';
import { compact, money } from '../format';
import type { Manifest } from '../types';
import { area } from './facts';

export interface TopbarParts {
  /** Opens the sidebar on narrow screens. */
  panelToggle: HTMLElement;
  search: HTMLElement;
  onHelp(): void;
  onCopyLink(): void;
}

/**
 * The app's top bar: brand, search, what the data covers, and the two actions that apply
 * everywhere (how it works, copy a link to this screen). It stays put while the sidebar, the map
 * and the panels change beneath it.
 */
export function buildTopbar(root: HTMLElement, m: Manifest, parts: TopbarParts): void {
  const where = area(m);
  const stat = (value: string, label: string) => h('span', { class: 'top-stat' }, h('b', null, value), ` ${label}`);
  appendAll(
    root,
    parts.panelToggle,
    h(
      'div',
      { class: 'brand' },
      h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('div', { class: 'brand-name' }, APP_NAME),
    ),
    parts.search,
    h(
      'div',
      { class: 'top-stats', 'aria-label': 'What the data covers' },
      h('span', { class: 'top-stat top-area' }, h('i', { class: 'live-dot', 'aria-hidden': 'true' }), where.n > 1 ? where.span : where.names),
      stat(compact(m.stats.parcels), 'parcels'),
      stat(money(m.stats.just_value), 'assessed'),
      m.source.tax_roll_year ? stat(String(m.source.tax_roll_year), 'tax roll') : null,
    ),
    h(
      'div',
      { class: 'top-actions' },
      h(
        'button',
        { type: 'button', class: 'btn ghost sm top-btn', title: 'Copy a link that reopens this exact screen', onclick: () => parts.onCopyLink() },
        icon('link', 14),
        h('span', { class: 'top-btn-label' }, 'Copy link'),
      ),
      h(
        'button',
        { type: 'button', class: 'btn ghost sm top-btn', title: 'How it works (press ?)', onclick: () => parts.onHelp() },
        icon('help', 15),
        h('span', { class: 'top-btn-label' }, 'How it works'),
      ),
    ),
  );
}
