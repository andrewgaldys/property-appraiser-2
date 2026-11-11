import { CLASS_COLORS, CLASS_FALLBACK, CLASS_SHORT, COUNTY_META } from '../config';
import type { DataStore } from '../data';
import { h, icon, toast } from '../dom';
import { acres, int, money, saleDate, titleCase } from '../format';
import { nominalMax } from '../map/layers';
import { mailingLine, type IndexRow, type ParcelIndex } from '../parcelIndex';
import {
  download,
  holdText,
  matcher,
  ownerRefOf,
  ownerResults,
  ownersCsv,
  parcelsCsv,
  refKey,
  relatedEntities,
  signalRank,
  signalText,
  stamp,
  type OwnerResult,
} from '../results';
import { loadUi, saveUi, type Store } from '../state';
import type { AppState, Bbox, Manifest, OwnerRef } from '../types';
import { VirtualTable, type Column } from './table';

export interface ResultsHandlers {
  onOpenOwner(ref: OwnerRef): void;
  onSelectParcel(pid: string): void;
  /** The panel's height over the map changed (the map keeps its framing clear of it). */
  onLayout(px: number): void;
  /** Current map view, for "In map view" results. */
  viewBbox(): Bbox;
  /** Open / tab / scope changed (the page link records them). */
  onStateChange(): void;
}

type Tab = 'owners' | 'parcels';
type Scope = 'all' | 'view';

const cmpNum = (a: number | null | undefined, b: number | null | undefined) => (a ?? -Infinity) - (b ?? -Infinity);
const cmpStr = (a: string, b: string) => a.localeCompare(b);
const BAR = 46;

/**
 * Owners & parcels: the screen's results as tables under the map. They cover every parcel that
 * matches the active filters and search in all three counties (or only the map view), grouped
 * into owners the same way as Top owners. Rows open an owner profile or a parcel; the map's
 * selection highlights the matching row; either table exports to CSV.
 */
export class ResultsPanel {
  readonly el: HTMLElement;
  private open = false;
  private tab: Tab;
  private scope: Scope;
  private ix: ParcelIndex | null = null;
  private loading = false;
  private owners: OwnerResult[] = [];
  private parcels: IndexRow[] = [];
  private ownersTable: VirtualTable<OwnerResult>;
  private parcelsTable: VirtualTable<IndexRow>;
  private tabButtons: Record<Tab, HTMLButtonElement>;
  private scopeButtons: Record<Scope, HTMLButtonElement>;
  private summary: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private exportBtn: HTMLButtonElement;
  private bodyEl: HTMLElement;
  private timer = 0;
  private related = new Map<string, string>();

  constructor(
    private manifest: Manifest,
    private data: DataStore,
    private store: Store<AppState>,
    private handlers: ResultsHandlers,
  ) {
    const ui = loadUi({ resultsTab: 'owners' as Tab, resultsScope: 'all' as Scope });
    this.tab = ui.resultsTab === 'parcels' ? 'parcels' : 'owners';
    this.scope = ui.resultsScope === 'view' ? 'view' : 'all';

    this.ownersTable = new VirtualTable<OwnerResult>({
      label: 'Owners matching the screen',
      rowHeight: 50,
      key: (g) => g.key,
      onRow: (g) => this.handlers.onOpenOwner(g.ref),
      sort: { id: 'jv', dir: -1 },
      empty: 'No owners match the current screen.',
      columns: this.ownerColumns(),
    });
    this.parcelsTable = new VirtualTable<IndexRow>({
      label: 'Parcels matching the screen',
      rowHeight: 46,
      key: (r) => r.pid,
      onRow: (r) => this.handlers.onSelectParcel(r.pid),
      sort: { id: 'jv', dir: -1 },
      empty: 'No parcels match the current screen.',
      columns: this.parcelColumns(),
    });

    const tabBtn = (t: Tab, label: string) =>
      h('button', { type: 'button', class: 'rs-tab', role: 'tab', onclick: () => this.setTab(t, true) }, label, h('span', { class: 'rs-n' }));
    this.tabButtons = { owners: tabBtn('owners', 'Owners'), parcels: tabBtn('parcels', 'Parcels') };
    const scopeBtn = (s: Scope, label: string, title: string) =>
      h('button', { type: 'button', class: 'seg-btn', role: 'radio', title, onclick: () => this.setScope(s) }, label);
    this.scopeButtons = {
      all: scopeBtn('all', 'All matching', 'Every matching parcel in the three counties'),
      view: scopeBtn('view', 'In map view', 'Only matching parcels inside the current map view'),
    };
    this.summary = h('span', { class: 'rs-summary' });
    this.exportBtn = h(
      'button',
      { type: 'button', class: 'btn ghost sm rs-export', 'aria-label': 'Export CSV', onclick: () => this.exportCsv() },
      icon('download', 14),
      h('span', { class: 'rs-btn-label' }, 'Export CSV'),
    );
    this.toggleBtn = h('button', { type: 'button', class: 'icon-btn rs-toggle', onclick: () => this.setOpen(!this.open) }, icon('chevron', 16));
    this.bodyEl = h('div', { class: 'rs-body' }, this.ownersTable.el, this.parcelsTable.el);

    this.el = h(
      'section',
      { id: 'results', class: 'results', 'aria-label': 'Owners and parcels matching the screen' },
      h(
        'header',
        { class: 'rs-bar' },
        h('div', { class: 'rs-tabs', role: 'tablist' }, this.tabButtons.owners, this.tabButtons.parcels),
        this.summary,
        h('div', { class: 'seg seg-sm rs-scope', role: 'radiogroup', 'aria-label': 'Which matching parcels' }, this.scopeButtons.all, this.scopeButtons.view),
        this.exportBtn,
        this.toggleBtn,
      ),
      this.bodyEl,
    );
    this.syncChrome();

    store.subscribe((s, prev) => {
      if (s.filters !== prev.filters || s.search !== prev.search || s.ownerGroup !== prev.ownerGroup) this.schedule();
      if (s.selection !== prev.selection || s.ownerFocus !== prev.ownerFocus || s.ownerGroup !== prev.ownerGroup) this.syncActive(true);
    });
  }

  /** The map moved: "In map view" results follow. */
  mapMoved(): void {
    if (this.scope === 'view') this.schedule();
  }

  get isOpen(): boolean {
    return this.open;
  }

  getState(): { open: boolean; tab: Tab; scope: Scope } {
    return { open: this.open, tab: this.tab, scope: this.scope };
  }

  /** Restore from a link or a saved screen. */
  applyState(st: { open: boolean; tab: Tab; scope: Scope }): void {
    this.scope = st.scope;
    this.tab = st.tab;
    this.syncChrome();
    if (st.open !== this.open) this.setOpen(st.open);
    else this.schedule();
    this.handlers.onStateChange();
  }

  /** Open on a tab (the sidebar's "See matching owners"). */
  show(tab: Tab = 'owners'): void {
    this.setTab(tab, false);
    this.setOpen(true);
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.el.classList.toggle('open', open);
    this.syncChrome();
    if (open) this.ensureIndex();
    this.handlers.onLayout(this.height());
    if (open) this.schedule();
    this.handlers.onStateChange();
  }

  /** The panel's height over the map: mirrors .results / .results.open in app.css. */
  private height(): number {
    if (!this.open) return BAR;
    if (window.matchMedia('(max-width: 720px)').matches) return Math.max(BAR, (this.el.parentElement?.clientHeight ?? window.innerHeight) - 64);
    return Math.min(window.innerHeight * 0.46, 520);
  }

  private setTab(t: Tab, openIt: boolean): void {
    this.tab = t;
    saveUi({ resultsTab: t });
    this.syncChrome();
    if (openIt && !this.open) this.setOpen(true);
    this.syncActive(true);
    this.handlers.onStateChange();
  }

  private setScope(s: Scope): void {
    this.scope = s;
    saveUi({ resultsScope: s });
    this.syncChrome();
    this.schedule();
    this.handlers.onStateChange();
  }

  private syncChrome(): void {
    for (const t of ['owners', 'parcels'] as Tab[]) {
      this.tabButtons[t].classList.toggle('on', this.tab === t);
      this.tabButtons[t].setAttribute('aria-selected', String(this.tab === t));
    }
    for (const s of ['all', 'view'] as Scope[]) {
      this.scopeButtons[s].classList.toggle('on', this.scope === s);
      this.scopeButtons[s].setAttribute('aria-checked', String(this.scope === s));
    }
    this.ownersTable.el.hidden = this.tab !== 'owners';
    this.parcelsTable.el.hidden = this.tab !== 'parcels';
    this.toggleBtn.setAttribute('aria-label', this.open ? 'Collapse the results table' : 'Open the results table');
    this.toggleBtn.setAttribute('aria-expanded', String(this.open));
    this.exportBtn.disabled = !this.ix;
    this.exportBtn.title = this.tab === 'owners' ? 'Download the owners table as CSV (current sort)' : 'Download the parcels table as CSV (current sort)';
  }

  private ensureIndex(): void {
    if (this.ix || this.loading) return;
    this.loading = true;
    this.summary.textContent = 'Loading every parcel…';
    this.data
      .parcelIndex()
      .then((ix) => {
        this.ix = ix;
        this.syncChrome();
        this.compute();
      })
      .catch((err: unknown) => {
        console.error(err);
        this.summary.textContent = 'Could not load the parcel table. Try reloading.';
      })
      .finally(() => {
        this.loading = false;
      });
  }

  private schedule(): void {
    if (!this.ix) {
      if (this.open) this.ensureIndex();
      return;
    }
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.compute(), 120);
  }

  private compute(): void {
    const ix = this.ix;
    if (!ix) return;
    const s = this.store.get();
    const match = matcher(s.filters, s.search, nominalMax(this.manifest), this.scope === 'view' ? this.handlers.viewBbox() : null);
    this.parcels = ix.rows.filter(match);
    this.owners = ownerResults(ix, this.parcels, s.ownerGroup);
    this.related.clear();
    this.ownersTable.setRows(this.owners);
    this.parcelsTable.setRows(this.parcels);
    this.tabButtons.owners.querySelector('.rs-n')!.textContent = int(this.owners.length);
    this.tabButtons.parcels.querySelector('.rs-n')!.textContent = int(this.parcels.length);
    const jv = this.parcels.reduce((a, r) => a + (r.jv ?? 0), 0);
    this.summary.textContent = `${money(jv)} assessed · ${this.scope === 'view' ? 'in map view' : 'all three counties'}${s.ownerGroup === 'addr' ? ' · owners by mailing address' : ''}`;
    this.syncActive(false);
  }

  private syncActive(scroll: boolean): void {
    if (!this.ix) return;
    const s = this.store.get();
    const sel = s.selection ? this.ix.byPid.get(s.selection.pid) : undefined;
    const ownerKey = s.ownerFocus ? refKey(s.ownerFocus) : sel ? refKey(ownerRefOf(sel, s.ownerGroup, this.ix)) : null;
    this.ownersTable.setActive(ownerKey, scroll && this.open && this.tab === 'owners');
    this.parcelsTable.setActive(sel?.pid ?? null, scroll && this.open && this.tab === 'parcels');
  }

  private relatedText(g: OwnerResult): string {
    let t = this.related.get(g.key);
    if (t === undefined) {
      const rel = this.ix ? relatedEntities(this.ix, g) : [];
      t = rel.length ? `${rel.slice(0, 3).map((e) => e.name).join(', ')}${rel.length > 3 ? ` +${rel.length - 3}` : ''}` : '';
      this.related.set(g.key, t);
    }
    return t;
  }

  private exportCsv(): void {
    const ix = this.ix;
    if (!ix) return;
    const s = this.store.get();
    if (this.tab === 'owners') {
      const rows = this.ownersTable.sorted();
      download(`pa2-owners-${stamp()}.csv`, ownersCsv(ix, rows, s.ownerGroup));
      toast(`Exported ${int(rows.length)} ${rows.length === 1 ? 'owner' : 'owners'}`);
    } else {
      const rows = this.parcelsTable.sorted();
      const base = `${window.location.origin}${window.location.pathname}`;
      download(
        `pa2-parcels-${stamp()}.csv`,
        parcelsCsv(rows, this.manifest.use_codes ?? {}, nominalMax(this.manifest), (pid) => `${base}#p=${pid}`),
      );
      toast(`Exported ${int(rows.length)} ${rows.length === 1 ? 'parcel' : 'parcels'}`);
    }
  }

  private ownerColumns(): Column<OwnerResult>[] {
    const sw = (cls: string) => h('i', { class: 'rs-sw', style: { background: CLASS_COLORS[cls] ?? CLASS_FALLBACK } });
    return [
      {
        id: 'owner', label: 'Owner', width: 230, sort: (a, b) => cmpStr(a.label, b.label),
        cell: (g) =>
          h(
            'span',
            { class: 'rs-two' },
            h('span', { class: 'rs-main' }, g.label || 'Owner not reported'),
            h('span', { class: 'rs-sub' }, g.ref.kind === 'a' ? 'Shared mailing address' : g.ref.kind === 'n' ? 'Owner name' : 'One parcel'),
          ),
        title: (g) => g.label,
      },
      {
        id: 'related', label: 'Related entities', width: 200,
        info: 'Other owner names that share a mailing address with this owner (registered-agent addresses left out). Listed for context; their parcels are not counted in this row.',
        cell: (g) => h('span', { class: 'rs-clip' }, this.relatedText(g) || '—'),
        title: (g) => this.relatedText(g) || undefined,
      },
      {
        id: 'parcels', label: 'Parcels', width: 92, align: 'right', sort: (a, b) => a.rows.length - b.rows.length || a.total - b.total,
        info: 'Parcels matching the screen, of all the parcels this owner group holds in the three counties.',
        cell: (g) => h('span', { class: 'rs-two r' }, h('span', { class: 'rs-num' }, int(g.rows.length)), g.total > g.rows.length ? h('span', { class: 'rs-sub' }, `of ${int(g.total)}`) : null),
      },
      { id: 'jv', label: 'Assessed value', width: 122, align: 'right', sort: (a, b) => a.jv - b.jv, cell: (g) => h('span', { class: 'rs-num' }, money(g.jv)) },
      { id: 'sf', label: 'Building SF', width: 110, align: 'right', sort: (a, b) => a.sf - b.sf, cell: (g) => h('span', { class: 'rs-num' }, g.sf ? int(g.sf) : '—') },
      {
        id: 'classes', label: 'Asset classes', width: 170, sort: (a, b) => a.classes.size - b.classes.size,
        cell: (g) => {
          const list = [...g.classes.entries()].sort((a, b) => b[1] - a[1]);
          return h('span', { class: 'rs-classes' }, list.slice(0, 4).map(([c]) => sw(c)), h('span', { class: 'rs-clip' }, list.map(([c, n]) => `${CLASS_SHORT[c] ?? c}${list.length > 1 ? ` ${n}` : ''}`).join(' · ')));
        },
        title: (g) => [...g.classes.entries()].map(([c, n]) => `${CLASS_SHORT[c] ?? c}: ${n}`).join(', '),
      },
      {
        id: 'signals', label: 'Signals', width: 170,
        sort: (a, b) => signalRank(a) - signalRank(b),
        desc: true,
        info: 'Prospecting signals on the matching parcels: owner mails from out of state or another Florida county, owner name reads as a trust or estate, small portfolio owner (2–10 parcels in one class).',
        cell: (g) => h('span', { class: 'rs-clip rs-signals' }, signalText(g) || '—'),
        title: (g) => signalText(g) || undefined,
      },
      {
        id: 'longest', label: 'Longest hold', width: 104, align: 'right',
        sort: (a, b) => cmpNum(a.longest?.years, b.longest?.years),
        info: 'Longest-held matching parcel. "57+" means the last priced sale is older than the county sale records, so the hold is at least that long.',
        cell: (g) => h('span', { class: 'rs-num' }, g.longest ? `${g.longest.years}${g.longest.minimum ? '+' : ''} yrs` : '—'),
      },
      {
        id: 'avg', label: 'Avg hold', width: 96, align: 'right', sort: (a, b) => cmpNum(a.avgHold, b.avgHold),
        info: 'Average of the matching parcels with an exact hold. Minimums ("57+") and parcels with no sale on record are left out.',
        cell: (g) =>
          h(
            'span',
            { class: 'rs-two r' },
            h('span', { class: 'rs-num' }, g.avgHold != null ? `${Math.round(g.avgHold)} yrs` : '—'),
            g.avgHold != null && g.knownHolds < g.rows.length ? h('span', { class: 'rs-sub' }, `${g.knownHolds} of ${g.rows.length}`) : null,
          ),
      },
      {
        id: 'mail', label: 'Mailing address', width: 270, sort: (a, b) => cmpStr(mailingLine(a.mail), mailingLine(b.mail)),
        cell: (g) =>
          h('span', { class: 'rs-two' }, h('span', { class: 'rs-clip' }, mailingLine(g.mail) || '—'), g.mailCount > 1 ? h('span', { class: 'rs-sub' }, `+${g.mailCount - 1} more`) : null),
        title: (g) => mailingLine(g.mail),
      },
    ];
  }

  private parcelColumns(): Column<IndexRow>[] {
    const nominal = nominalMax(this.manifest);
    return [
      {
        id: 'addr', label: 'Address', width: 220, sort: (a, b) => cmpStr(a.addr, b.addr),
        cell: (r) =>
          h(
            'span',
            { class: 'rs-two' },
            h('span', { class: 'rs-main' }, r.addr || 'No site address'),
            h('span', { class: 'rs-sub' }, [titleCase(r.city), COUNTY_META[r.co]?.short].filter(Boolean).join(' · ')),
          ),
        title: (r) => r.addr,
      },
      {
        id: 'cls', label: 'Class', width: 150, sort: (a, b) => cmpStr(CLASS_SHORT[a.cls] ?? a.cls, CLASS_SHORT[b.cls] ?? b.cls),
        cell: (r) => h('span', { class: 'rs-classes' }, h('i', { class: 'rs-sw', style: { background: CLASS_COLORS[r.cls] ?? CLASS_FALLBACK } }), h('span', { class: 'rs-clip' }, CLASS_SHORT[r.cls] ?? r.cls)),
        title: (r) => this.manifest.use_codes?.[r.uc] ?? undefined,
      },
      {
        id: 'jv', label: 'Assessed value', width: 122, align: 'right', sort: (a, b) => cmpNum(a.jv, b.jv),
        cell: (r) => (r.jv != null && r.jv < nominal ? h('span', { class: 'rs-nominal' }, 'Nominal') : h('span', { class: 'rs-num' }, money(r.jv))),
      },
      { id: 'sf', label: 'Building SF', width: 104, align: 'right', sort: (a, b) => cmpNum(a.sf, b.sf), cell: (r) => h('span', { class: 'rs-num' }, r.sf ? int(r.sf) : '—') },
      { id: 'lot', label: 'Lot', width: 90, align: 'right', sort: (a, b) => cmpNum(a.lot, b.lot), cell: (r) => h('span', { class: 'rs-num' }, acres(r.lot)) },
      {
        id: 'sale', label: 'Last sale', width: 150, align: 'right', sort: (a, b) => cmpNum(a.sy ? a.sy * 100 + (a.sm ?? 0) : null, b.sy ? b.sy * 100 + (b.sm ?? 0) : null),
        cell: (r) =>
          r.sy
            ? h('span', { class: 'rs-two r' }, h('span', { class: 'rs-num' }, money(r.sp)), h('span', { class: 'rs-sub' }, saleDate(r.sy, r.sm)))
            : h('span', { class: 'rs-sub' }, 'Not on record'),
      },
      {
        id: 'hold', label: 'Years held', width: 96, align: 'right', sort: (a, b) => cmpNum(a.hold ?? a.hf, b.hold ?? b.hf),
        info: '"57+" means the last priced sale is older than the county sale records, so the hold is at least that long.',
        cell: (r) => h('span', { class: 'rs-num' }, holdText(r) ?? '—'),
      },
      {
        id: 'own', label: 'Owner', width: 230, sort: (a, b) => cmpStr(a.own, b.own),
        cell: (r) => h('span', { class: 'rs-two' }, h('span', { class: 'rs-clip' }, r.own || 'Not reported'), h('span', { class: 'rs-sub rs-clip' }, mailingLine(r))),
        title: (r) => `${r.own}\n${mailingLine(r)}`,
      },
    ];
  }

  /** Window resized: keep the map's framing clear of the panel. */
  relayout(): void {
    this.handlers.onLayout(this.height());
  }

}
