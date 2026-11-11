import { CLASS_COLORS, CLASS_FALLBACK } from '../config';
import type { DataStore } from '../data';
import { clear, h, icon, type Child } from '../dom';
import { int, money, titleCase } from '../format';
import { rowsBbox, search, type SearchIndex, type SearchResults, type SearchRow } from '../search';
import type { Store } from '../state';
import type { AppState, Manifest, SearchSet } from '../types';
import { isNominal } from './facts';

export interface SearchHandlers {
  /** Show these parcels on the map (a filter) and frame them. */
  onShowSet(set: SearchSet): void;
  /** Fly to one parcel and open it. */
  onSelectParcel(pid: string): void;
}

/** Larger sets would make the map filter heavy; the menu asks for another word instead. */
const MAX_SET = 10_000;
const SHOW = { owners: 5, mailing: 3, parcels: 8 };

interface Option {
  el: HTMLElement;
  act: () => void;
}

/**
 * The search box over the map: owner names, site addresses, cities, parcel IDs, property types and
 * shared mailing addresses. Results come back grouped (owners, mailing addresses, parcels) under a
 * "Show all matching parcels" row. Picking a group or "Show all" shows those parcels on the map as a
 * filter (a chip, In-view totals and Top owners follow); picking a parcel flies to it. The index
 * loads on first hover or focus. Press "/" to search from anywhere.
 */
export class SearchBox {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private clearBtn: HTMLButtonElement;
  private menu: HTMLElement;
  private index: SearchIndex | null = null;
  private loading = false;
  private failed = false;
  private options: Option[] = [];
  private active = -1;
  private timer = 0;

  constructor(
    private manifest: Manifest,
    private data: DataStore,
    private store: Store<AppState>,
    private handlers: SearchHandlers,
  ) {
    this.input = h('input', {
      type: 'text',
      placeholder: 'Search owners, addresses, parcel IDs',
      'aria-label': 'Search owners, addresses, parcel IDs and property types',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': 'search-menu',
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
    }) as HTMLInputElement;
    this.clearBtn = h(
      'button',
      { type: 'button', class: 'search-clear', 'aria-label': 'Clear search', hidden: true, onclick: () => this.reset() },
      icon('close', 14),
    ) as HTMLButtonElement;
    this.menu = h('div', { id: 'search-menu', class: 'search-menu', role: 'listbox', 'aria-label': 'Search results', hidden: true });
    this.el = h(
      'div',
      { class: 'search', role: 'search' },
      h(
        'div',
        { class: 'search-field' },
        icon('search', 15),
        this.input,
        this.clearBtn,
        h('kbd', { class: 'search-kbd', title: 'Press / to search' }, '/'),
      ),
      this.menu,
    );

    this.input.addEventListener('input', () => {
      this.syncClear();
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.run(), 90);
    });
    this.input.addEventListener('focus', () => {
      this.warm();
      if (this.input.value.trim()) this.run();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('pointerenter', () => this.warm(), { once: true });
    document.addEventListener('pointerdown', (e) => {
      if (!this.el.contains(e.target as Node)) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      e.preventDefault();
      this.input.focus();
      this.input.select();
    });
    // The chip or "Reset all" cleared the search: clear the box too.
    store.subscribe((s, prev) => {
      if (!s.search && prev.search && document.activeElement !== this.input) {
        this.input.value = '';
        this.syncClear();
      }
    });
  }

  /** Start loading the index (hover / focus), so results are ready by the first keystroke. */
  private warm(): void {
    if (this.index || this.loading || this.failed) return;
    this.loading = true;
    this.data
      .parcelIndex()
      .then((ix) => {
        this.index = ix;
      })
      .catch((err: unknown) => {
        console.error('Search index failed to load', err);
        this.failed = true;
      })
      .finally(() => {
        this.loading = false;
        if (document.activeElement === this.input && this.input.value.trim()) this.run();
      });
  }

  private syncClear(): void {
    this.clearBtn.hidden = !this.input.value && !this.store.get().search;
  }

  private reset(): void {
    this.input.value = '';
    this.close();
    if (this.store.get().search) this.store.set({ search: null });
    this.syncClear();
    this.input.focus();
  }

  private open(): void {
    this.menu.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
  }

  private close(): void {
    this.menu.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.active = -1;
  }

  private message(text: string): void {
    clear(this.menu);
    this.options = [];
    this.active = -1;
    this.menu.append(h('div', { class: 'sm-empty' }, text));
    this.open();
  }

  private run(): void {
    const q = this.input.value.trim();
    if (!q) {
      this.close();
      return;
    }
    if (!this.index) {
      this.warm();
      this.message(this.failed ? 'Search is unavailable right now. Try reloading the page.' : 'Loading the search index…');
      return;
    }
    this.render(search(this.index, q));
  }

  private option(cls: string, act: () => void, ...children: Child[]): void {
    const i = this.options.length;
    const el = h(
      'div',
      {
        id: `sm-opt-${i}`,
        role: 'option',
        class: `sm-item ${cls}`,
        'aria-selected': 'false',
        onmousedown: (e: MouseEvent) => e.preventDefault(), // keep focus in the box
        onclick: act,
        onmousemove: () => this.setActive(i, false),
      },
      ...children,
    );
    this.options.push({ el, act });
    this.menu.append(el);
  }

  private group(title: string, count?: number): void {
    this.menu.append(
      h('div', { class: 'sm-group', role: 'presentation' }, h('span', null, title), count != null ? h('span', null, int(count)) : null),
    );
  }

  private render(res: SearchResults): void {
    clear(this.menu);
    this.options = [];
    this.active = -1;
    const total = res.all.length;
    if (!total) {
      this.message(`No parcels match “${res.query}”.`);
      return;
    }

    if (total > 1) {
      if (total <= MAX_SET)
        this.option(
          'sm-all',
          () => this.showSet(res.all, `“${res.query}”`),
          h('span', { class: 'sm-main' }, h('span', { class: 'sm-title' }, `Show all ${int(total)} matches on the map`)),
          h('kbd', { class: 'sm-enter', 'aria-hidden': 'true' }, '↵'),
        );
      else this.menu.append(h('div', { class: 'sm-note' }, `${int(total)} matches: add a word to narrow them down.`));
    }

    if (res.owners.length) {
      this.group('Owners', res.owners.length);
      for (const o of res.owners.slice(0, SHOW.owners)) {
        this.option(
          'sm-owner',
          () =>
            o.key != null && o.count > 1
              ? this.showSet(this.index!.rows.filter((r) => r.onk === o.key), `Owner: ${o.name}`)
              : this.pick(o.top.pid),
          h(
            'span',
            { class: 'sm-main' },
            h('span', { class: 'sm-title' }, o.name),
            h('span', { class: 'sm-sub' }, `${int(o.count)} ${o.count === 1 ? 'parcel' : 'parcels'} · ${titleCase(o.top.city) || 'Florida'}`),
          ),
          h('span', { class: 'sm-val' }, money(o.jv)),
        );
      }
    }

    if (res.mailing.length) {
      this.group('Mailing addresses', res.mailing.length);
      for (const m of res.mailing.slice(0, SHOW.mailing)) {
        const sub = [
          `${int(m.count)} parcels`,
          m.group.names > 1 ? `${int(m.group.names)} owner names` : null,
          m.group.agent ? 'likely an agent or manager address' : null,
        ]
          .filter(Boolean)
          .join(' · ');
        this.option(
          'sm-mail',
          () => this.showSet(this.index!.rows.filter((r) => r.oak === m.group.key), `Mailing address: ${m.group.label}`),
          h('span', { class: 'sm-main' }, h('span', { class: 'sm-title' }, m.group.label), h('span', { class: 'sm-sub' }, sub)),
          h('span', { class: 'sm-val' }, money(m.jv)),
        );
      }
    }

    this.group('Parcels', total);
    for (const r of res.all.slice(0, SHOW.parcels)) this.parcelOption(r);
    if (total > SHOW.parcels) this.menu.append(h('div', { class: 'sm-note' }, `+ ${int(total - SHOW.parcels)} more: show all to see them on the map.`));
    this.open();
  }

  private parcelOption(r: SearchRow): void {
    const nominal = isNominal(r.jv, this.manifest);
    this.option(
      'sm-parcel',
      () => this.pick(r.pid),
      h('i', { class: 'sm-sw', style: { background: CLASS_COLORS[r.cls] ?? CLASS_FALLBACK } }),
      h(
        'span',
        { class: 'sm-main' },
        h('span', { class: 'sm-title' }, r.addr || 'No site address'),
        h('span', { class: 'sm-sub' }, [titleCase(r.city), r.own].filter(Boolean).join(' · ')),
      ),
      h('span', { class: `sm-val${nominal ? ' nominal' : ''}` }, nominal ? 'Nominal' : money(r.jv)),
    );
  }

  private setActive(i: number, scroll = true): void {
    if (!this.options.length) return;
    this.options[this.active]?.el.setAttribute('aria-selected', 'false');
    this.active = Math.max(0, Math.min(i, this.options.length - 1));
    const opt = this.options[this.active]!;
    opt.el.setAttribute('aria-selected', 'true');
    this.input.setAttribute('aria-activedescendant', opt.el.id);
    if (scroll) opt.el.scrollIntoView({ block: 'nearest' });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.menu.hidden) this.run();
      else this.setActive(this.active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.setActive(this.active - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.menu.hidden) this.run();
      else (this.options[this.active] ?? this.options[0])?.act();
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // the menu, not the property panel
      if (!this.menu.hidden) this.close();
      else this.input.blur();
    }
  }

  private pick(pid: string): void {
    this.close();
    this.input.blur();
    this.handlers.onSelectParcel(pid);
  }

  private showSet(rows: SearchRow[], label: string): void {
    const pids = [...new Set(rows.map((r) => r.pid))];
    if (pids.length === 1) {
      this.pick(pids[0]!);
      return;
    }
    this.close();
    this.input.blur();
    this.handlers.onShowSet({ label, pids, bbox: rowsBbox(rows) });
    this.syncClear();
  }
}
