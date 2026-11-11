import { clear, h, icon } from '../dom';
import type { DataStore } from '../data';
import { int, money, pct } from '../format';
import { loadUi, saveUi, type Store } from '../state';
import type { AppState, Manifest, OwnerGrouping, OwnerRow, ViewStats } from '../types';
import { infoTip } from './infotip';

export interface OwnersHandlers {
  /** Open the owner's most valuable parcel in view and spotlight its portfolio. */
  onPick(row: OwnerRow): void;
}

interface Label {
  name: string;
  /** e.g. "+3 other owner names at this address". */
  sub?: string;
  /** The mailing address looks like a registered agent's or manager's. */
  agent?: boolean;
}

const SHOWN = 8;

const INFO =
  'Who owns the parcels in view, after filters, ranked by assessed market value. Pan, zoom or filter and the ranking follows.\n\n' +
  '"By name" groups parcels with the same normalized owner name. "By address" groups parcels mailed to the same address, which often reveals the sponsor behind single-asset LLCs (and sometimes a registered agent or manager instead).\n\n' +
  'Click an owner to open their most valuable parcel here and highlight their portfolio on the map.';

/**
 * Top owners in view: an ownership-concentration readout built from the same rendered parcels as the
 * In-view totals. Owner names come from the tiles at parcel zooms; further out they are looked up
 * (owner index for portfolios, the parcel record for single-parcel owners) and cached.
 */
export class OwnersPanel {
  readonly el: HTMLDetailsElement;
  private list: HTMLOListElement;
  private foot: HTMLElement;
  private sum: HTMLElement;
  private groupButtons: { id: OwnerGrouping; el: HTMLButtonElement }[];
  private labels = new Map<string, Label>();
  private pending = new Set<string>();
  private stats: ViewStats | null = null;
  private ownerIdx: number;

  constructor(
    manifest: Manifest,
    private data: DataStore,
    private store: Store<AppState>,
    private handlers: OwnersHandlers,
  ) {
    this.ownerIdx = manifest.owners.item_fields.indexOf('owner_name');
    this.sum = h('span', { class: 'sec-sum' });
    this.list = h('ol', { class: 'ow-list' });
    this.foot = h('p', { class: 'ow-foot' });
    this.groupButtons = (
      [
        { id: 'name', label: 'By name' },
        { id: 'addr', label: 'By address' },
      ] as const
    ).map((g) => ({
      id: g.id,
      el: h('button', { type: 'button', class: 'seg-btn', role: 'radio', onclick: () => store.set({ ownerGroup: g.id }) }, g.label),
    }));
    const seg = h('div', { class: 'seg seg-sm', role: 'radiogroup', 'aria-label': 'Group owners by' }, this.groupButtons.map((b) => b.el));

    const open = loadUi({ sections: { owners: true } as Record<string, boolean> }).sections.owners !== false;
    this.el = h(
      'details',
      { class: 'sec owners', 'data-sec': 'owners' },
      h('summary', null, h('span', { class: 'sec-title' }, 'Top owners'), this.sum, icon('chevron', 16)),
      h('div', { class: 'sec-body' }, h('div', { class: 'ow-head' }, seg, infoTip('top owners', INFO)), this.list, this.foot),
    ) as HTMLDetailsElement;
    this.el.open = open;
    this.el.addEventListener('toggle', () => {
      const cur = loadUi({ sections: {} as Record<string, boolean> }).sections;
      saveUi({ sections: { ...cur, owners: this.el.open } });
    });

    this.syncGrouping(store.get().ownerGroup);
    store.subscribe((s, prev) => {
      if (s.ownerGroup !== prev.ownerGroup) this.syncGrouping(s.ownerGroup);
      if (s.selection !== prev.selection && this.stats) this.render(this.stats);
    });
  }

  private syncGrouping(g: OwnerGrouping): void {
    for (const b of this.groupButtons) {
      const on = b.id === g;
      b.el.classList.toggle('on', on);
      b.el.setAttribute('aria-checked', String(on));
    }
  }

  setStats(s: ViewStats): void {
    this.stats = s;
    this.render(s);
  }

  /** The label for a row now, or null while it is being looked up (the row re-renders when it lands). */
  private labelFor(row: OwnerRow): Label | null {
    const known = this.labels.get(row.key);
    if (known) return known;
    if (row.kind !== 'a' && row.own) return { name: row.own };
    if (!this.pending.has(row.key)) {
      this.pending.add(row.key);
      void this.lookup(row)
        .then((label) => {
          this.labels.set(row.key, label);
          if (this.stats?.owners.some((r) => r.key === row.key)) this.render(this.stats);
        })
        .catch(() => undefined)
        .finally(() => this.pending.delete(row.key));
    }
    return row.own ? { name: row.own } : null;
  }

  private async lookup(row: OwnerRow): Promise<Label> {
    if (row.kind === 'p') {
      const rec = await this.data.parcel(String(row.id));
      return { name: rec?.owner_name || 'Owner not reported' };
    }
    const g = await this.data.ownerGroup(row.kind, Number(row.id));
    if (!g) return { name: row.own || 'Owner not reported' };
    if (row.kind === 'n') return { name: g.label };
    const first = g.items[0]?.[this.ownerIdx];
    const names = g.names ?? 1;
    return {
      name: row.own || (typeof first === 'string' && first) || g.label,
      sub: names > 1 ? `+${int(names - 1)} other ${names === 2 ? 'name' : 'names'} at this address` : undefined,
      agent: !!g.agent,
    };
  }

  private isSelected(row: OwnerRow): boolean {
    const sel = this.store.get().selection;
    if (!sel) return false;
    if (row.kind === 'n') return sel.nameKey === row.id;
    if (row.kind === 'a') return sel.addrKey === row.id;
    return sel.pid === row.id;
  }

  private render(s: ViewStats): void {
    clear(this.list);
    this.sum.textContent = s.ownerCount ? `${int(s.ownerCount)} ${s.ownerCount === 1 ? 'owner' : 'owners'}` : '';
    if (!s.owners.length) {
      this.list.append(h('li', { class: 'ow-empty' }, 'No parcels in view.'));
      this.foot.textContent = '';
      return;
    }
    const rows = s.owners.slice(0, SHOWN);
    const max = rows[0]!.jv || 1;
    rows.forEach((row, i) => {
      const label = this.labelFor(row);
      const share = s.jv > 0 ? row.jv / s.jv : 0;
      const on = this.isSelected(row);
      const sub = [`${int(row.parcels)} ${row.parcels === 1 ? 'parcel' : 'parcels'}`, row.units ? `${int(row.units)} units` : null]
        .filter(Boolean)
        .join(' · ');
      this.list.append(
        h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              class: `ow-row${on ? ' on' : ''}`,
              'aria-pressed': String(on),
              title: 'Open their most valuable parcel in view and highlight the portfolio',
              onclick: () => this.handlers.onPick(row),
            },
            h('span', { class: 'ow-rank' }, String(i + 1)),
            h(
              'span',
              { class: 'ow-main' },
              h('span', { class: `ow-name${label ? '' : ' loading'}` }, label?.name ?? 'Looking up owner…'),
              h('span', { class: 'ow-sub' }, sub),
              label?.agent
                ? h('span', { class: 'ow-flag' }, 'Shared by many owners: likely an agent or manager address')
                : label?.sub
                  ? h('span', { class: 'ow-flag' }, label.sub)
                  : null,
            ),
            h(
              'span',
              { class: 'ow-val' },
              money(row.jv),
              h('span', { class: 'ow-share', title: 'Share of the assessed value in view' }, pct(share, share < 0.1 ? 1 : 0)),
            ),
            h('span', { class: 'ow-bar', 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.max((row.jv / max) * 100, 1.5)}%` } })),
          ),
        ),
      );
    });
    const top5 = s.owners.slice(0, 5).reduce((a, r) => a + r.jv, 0);
    this.foot.textContent =
      s.ownerCount > 5 && s.jv > 0
        ? `Top 5 owners hold ${pct(top5 / s.jv)} of the assessed value in view.`
        : `${int(s.ownerCount)} ${s.ownerCount === 1 ? 'owner' : 'owners'} in view.`;
  }
}
