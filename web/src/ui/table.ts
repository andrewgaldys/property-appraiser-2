import { clear, h, type Child } from '../dom';
import { infoTip } from './infotip';

export interface Column<T> {
  id: string;
  label: string;
  /** Pixel width (the first column takes any spare room). */
  width: number;
  align?: 'right';
  /** Ascending comparator; columns without one are not sortable. */
  sort?: (a: T, b: T) => number;
  cell: (row: T) => Child;
  /** Hover text for the cell (full value of truncated text). */
  title?: (row: T) => string | undefined;
  info?: string;
}

export interface TableOptions<T> {
  columns: Column<T>[];
  rowHeight: number;
  key: (row: T) => string;
  onRow: (row: T) => void;
  sort: { id: string; dir: 1 | -1 };
  empty: string;
  label: string;
}

/**
 * A sortable table that only renders the rows in view, so tens of thousands of results scroll
 * smoothly. Header cells sort (click again to reverse); rows open on click or Enter.
 */
export class VirtualTable<T> {
  readonly el: HTMLElement;
  private head: HTMLElement;
  private body: HTMLElement;
  private rows: T[] = [];
  private index = new Map<string, number>();
  private active: string | null = null;
  private sortState: { id: string; dir: 1 | -1 };
  private frame = 0;
  private emptyEl: HTMLElement;

  constructor(private o: TableOptions<T>) {
    this.sortState = { ...o.sort };
    const minWidth = o.columns.reduce((a, c) => a + c.width, 0);
    const tracks = o.columns.map((c, i) => (i === 0 ? `minmax(${c.width}px, 1fr)` : `${c.width}px`)).join(' ');
    this.head = h('div', { class: 'vt-head', role: 'row' });
    this.body = h('div', { class: 'vt-body', role: 'rowgroup' });
    this.emptyEl = h('div', { class: 'vt-empty', hidden: true }, o.empty);
    this.el = h('div', { class: 'vt', role: 'table', 'aria-label': o.label }, this.head, this.body, this.emptyEl);
    this.el.style.setProperty('--vt-cols', tracks);
    this.el.style.setProperty('--vt-min', `${minWidth}px`);
    this.el.style.setProperty('--vt-row', `${o.rowHeight}px`);
    this.renderHead();
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.el);
  }

  private renderHead(): void {
    clear(this.head);
    for (const c of this.o.columns) {
      const on = this.sortState.id === c.id;
      const sortLabel = on ? (this.sortState.dir === 1 ? 'ascending' : 'descending') : 'none';
      this.head.append(
        h(
          'div',
          { class: `vt-th${c.align === 'right' ? ' r' : ''}`, role: 'columnheader', 'aria-sort': c.sort ? sortLabel : null },
          c.sort
            ? h(
                'button',
                { type: 'button', class: `vt-sort${on ? ' on' : ''}`, onclick: () => this.toggleSort(c) },
                c.label,
                h('span', { class: 'vt-arrow', 'aria-hidden': 'true' }, on ? (this.sortState.dir === 1 ? '↑' : '↓') : ''),
              )
            : h('span', null, c.label),
          c.info ? infoTip(c.label.toLowerCase(), c.info) : null,
        ),
      );
    }
  }

  private toggleSort(c: Column<T>): void {
    // A new column starts at its most useful end: text A→Z, numbers high→low.
    const numeric = c.align === 'right';
    this.sortState = this.sortState.id === c.id ? { id: c.id, dir: this.sortState.dir === 1 ? -1 : 1 } : { id: c.id, dir: numeric ? -1 : 1 };
    this.renderHead();
    this.apply();
    this.el.scrollTop = 0;
    this.renderRows();
  }

  private apply(): void {
    const col = this.o.columns.find((c) => c.id === this.sortState.id);
    if (col?.sort) {
      const dir = this.sortState.dir;
      const cmp = col.sort;
      this.rows.sort((a, b) => dir * cmp(a, b));
    }
    this.index = new Map(this.rows.map((r, i) => [this.o.key(r), i]));
  }

  setRows(rows: T[]): void {
    this.rows = rows.slice();
    this.apply();
    this.body.style.height = `${this.rows.length * this.o.rowHeight}px`;
    this.emptyEl.hidden = this.rows.length > 0;
    this.el.setAttribute('aria-rowcount', String(this.rows.length + 1));
    this.renderRows();
  }

  /** Rows in the order shown (what an export writes). */
  sorted(): T[] {
    return this.rows;
  }

  setActive(key: string | null, scroll = false): void {
    this.active = key;
    if (scroll && key != null) {
      const i = this.index.get(key);
      if (i != null) {
        const top = i * this.o.rowHeight;
        const view = this.el.clientHeight - this.head.offsetHeight;
        if (top < this.el.scrollTop || top + this.o.rowHeight > this.el.scrollTop + view) this.el.scrollTop = Math.max(0, top - view / 3);
      }
    }
    this.renderRows();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderRows();
    });
  }

  private renderRows(): void {
    const rh = this.o.rowHeight;
    const top = Math.max(0, this.el.scrollTop - this.head.offsetHeight);
    const first = Math.max(0, Math.floor(top / rh) - 6);
    const last = Math.min(this.rows.length, Math.ceil((top + this.el.clientHeight) / rh) + 6);
    clear(this.body);
    for (let i = first; i < last; i++) {
      const row = this.rows[i]!;
      const k = this.o.key(row);
      const on = k === this.active;
      const el = h(
        'div',
        {
          class: `vt-row${on ? ' on' : ''}`,
          role: 'row',
          tabindex: '0',
          'aria-rowindex': String(i + 2),
          'aria-selected': on ? 'true' : 'false',
          onclick: () => this.o.onRow(row),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              this.o.onRow(row);
            }
          },
        },
        this.o.columns.map((c) =>
          h('div', { class: `vt-td${c.align === 'right' ? ' r' : ''}`, role: 'cell', title: c.title?.(row) }, c.cell(row)),
        ),
      );
      el.style.transform = `translateY(${i * rh}px)`;
      this.body.append(el);
    }
  }
}
