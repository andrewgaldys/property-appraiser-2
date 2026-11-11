import { Map as MapLibreMap, type GeoJSONSource, type LngLatBoundsLike } from 'maplibre-gl';
import { CLASS_BADGE, CLASS_COLORS, CLASS_FALLBACK, CLASS_SHORT, COUNTY_META } from '../config';
import { appendAll, clear, h, icon, toast, type Child } from '../dom';
import { acres, int, money, pct, saleDate, titleCase } from '../format';
import { buildBasemapStyle } from '../map/basemap';
import { nominalMax } from '../map/layers';
import { mailingLine, type IndexRow, type ParcelIndex } from '../parcelIndex';
import { download, groupMembers, holdText, ownerRefOf, parcelsCsv, refKey, relatedEntities, stamp } from '../results';
import { rowsBbox } from '../search';
import type { Manifest, OwnerRef } from '../types';
import { infoTip } from './infotip';

export interface ProfileHandlers {
  onClose(): void;
  onSelectParcel(pid: string): void;
  onOpenOwner(ref: OwnerRef): void;
  onCopyLink(): void;
}

const SVG = 'http://www.w3.org/2000/svg';
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** Non-interactive overview map: the owner's parcels as class-colored dots on the black basemap. */
class MiniMap {
  readonly el: HTMLElement;
  private map: MapLibreMap | null = null;

  constructor() {
    this.el = h('div', { class: 'op-map', role: 'img', 'aria-label': 'Map of the owner’s parcels' });
  }

  private data(rows: IndexRow[]) {
    return {
      type: 'FeatureCollection' as const,
      features: rows.map((r) => ({
        type: 'Feature' as const,
        properties: { cls: r.cls },
        geometry: { type: 'Point' as const, coordinates: [r.lon, r.lat] },
      })),
    };
  }

  show(rows: IndexRow[]): void {
    const b = rowsBbox(rows);
    const bounds: LngLatBoundsLike = [b[0] - 0.003, b[1] - 0.003, b[2] + 0.003, b[3] + 0.003];
    if (!this.map) {
      const style = buildBasemapStyle();
      const color: unknown[] = ['match', ['get', 'cls']];
      for (const [k, v] of Object.entries(CLASS_COLORS)) color.push(k, v);
      color.push(CLASS_FALLBACK);
      style.sources.owner = { type: 'geojson', data: this.data(rows) };
      style.layers.push({
        id: 'owner',
        type: 'circle',
        source: 'owner',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 14, 6],
          'circle-color': color as never,
          'circle-stroke-color': '#000000',
          'circle-stroke-width': 1.5,
        },
      });
      this.map = new MapLibreMap({
        container: this.el,
        style,
        bounds,
        fitBoundsOptions: { padding: 28, maxZoom: 15 },
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
      });
      return;
    }
    const m = this.map;
    m.resize();
    const apply = () => {
      (m.getSource('owner') as GeoJSONSource | undefined)?.setData(this.data(rows));
      m.fitBounds(bounds, { padding: 28, maxZoom: 15, duration: 0 });
    };
    if (m.isStyleLoaded()) apply();
    else m.once('load', apply);
  }
}

/**
 * An owner group's profile: everything it holds in the three counties, a mini map, the asset
 * class mix, an acquisition timeline (last priced sale of each parcel, where on record), average
 * hold and the related entities. Parcels open in the property panel on top of it.
 */
export class OwnerProfile {
  readonly el: HTMLElement;
  private scroller: HTMLElement;
  private body: HTMLElement;
  private mini = new MiniMap();
  private rows: IndexRow[] = [];
  private ref: OwnerRef | null = null;
  private label = '';

  constructor(
    private manifest: Manifest,
    private handlers: ProfileHandlers,
  ) {
    this.body = h('div', { class: 'op-body' });
    this.scroller = h('div', { class: 'dr-scroll' }, this.body);
    const foot = h(
      'footer',
      { class: 'dr-foot' },
      h('button', { type: 'button', class: 'btn solid', onclick: () => this.exportCsv() }, icon('download', 14), 'Export parcels (CSV)'),
      h('button', { type: 'button', class: 'btn ghost', title: 'Copy a link to this owner', onclick: () => this.handlers.onCopyLink() }, icon('link'), 'Copy link'),
    );
    const close = h(
      'button',
      { type: 'button', class: 'icon-btn dr-close', 'aria-label': 'Close owner profile', onclick: () => this.handlers.onClose() },
      icon('close', 16),
    );
    this.el = h('aside', { id: 'profile', class: 'drawer profile', 'aria-label': 'Owner profile', 'aria-hidden': 'true' }, close, this.scroller, foot);
  }

  get isOpen(): boolean {
    return this.el.classList.contains('open');
  }

  get current(): { ref: OwnerRef; label: string; rows: IndexRow[] } | null {
    return this.ref ? { ref: this.ref, label: this.label, rows: this.rows } : null;
  }

  close(): void {
    this.el.classList.remove('open');
    this.el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('profile-open');
    this.ref = null;
  }

  show(ix: ParcelIndex, ref: OwnerRef): IndexRow[] {
    const rows = groupMembers(ix, ref).sort((a, b) => (b.jv ?? 0) - (a.jv ?? 0));
    this.rows = rows;
    this.ref = ref;
    const top = rows[0];
    this.label =
      ref.kind === 'a'
        ? [...(ix.namesByAddr.get(Number(ref.id)) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? top?.own ?? ''
        : top?.own ?? '';
    clear(this.body);
    if (!top) {
      this.body.append(h('p', { class: 'dr-error' }, 'This owner is not in the current data.'));
    } else {
      this.render(ix, ref, rows);
    }
    this.el.classList.add('open');
    this.el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('profile-open');
    this.scroller.scrollTop = 0;
    return rows;
  }

  private render(ix: ParcelIndex, ref: OwnerRef, rows: IndexRow[]): void {
    const m = this.manifest;
    const nominal = nominalMax(m);
    const jv = rows.reduce((a, r) => a + (r.jv ?? 0), 0);
    const sf = rows.reduce((a, r) => a + (r.sf ?? 0), 0);
    const units = rows.reduce((a, r) => a + (r.u ?? 0), 0);
    const exact = rows.filter((r) => r.hold != null);
    const avg = exact.length ? exact.reduce((a, r) => a + r.hold!, 0) / exact.length : null;
    let longest: { y: number; min: boolean } | null = null;
    for (const r of rows) {
      const y = r.hold ?? r.hf;
      if (y != null && (!longest || y > longest.y)) longest = { y, min: r.hold == null };
    }
    const counties = [...new Set(rows.map((r) => r.co))].map((c) => COUNTY_META[c]?.name ?? c).join(', ');
    const names = new Set(rows.map((r) => r.own));
    const kind = ref.kind === 'a' ? 'Owners at one mailing address' : ref.kind === 'n' ? 'Owner name' : 'Single-parcel owner';

    // ---- Header + key facts ---------------------------------------------------------------------
    this.body.append(
      h(
        'header',
        { class: 'dr-head' },
        h(
          'div',
          { class: 'dr-badges' },
          h('span', { class: 'badge' }, kind),
          ref.kind !== 'p'
            ? infoTip(
                'owner grouping',
                ref.kind === 'a'
                  ? 'Every parcel whose tax bill goes to this normalized mailing address, whatever the owner name. It often reveals the sponsor behind single-asset LLCs; a manager’s or agent’s office can also collect unrelated owners.'
                  : 'Every parcel with this normalized owner name (spelling variants like "L.L.C." and "LLC" match).',
              )
            : null,
        ),
        h('h2', { class: 'dr-addr' }, this.label || 'Owner not reported'),
        h('div', { class: 'dr-city' }, [counties, ref.kind === 'a' && names.size > 1 ? `${int(names.size)} owner names` : null].filter(Boolean).join(' · ')),
      ),
      h(
        'dl',
        { class: 'key-facts' },
        this.kf('Parcels', int(rows.length)),
        this.kf('Assessed market value', money(jv), undefined, 'Sum of the just (market) values on the tax roll. Not an appraisal.'),
        this.kf('Building SF', sf ? int(sf) : '—'),
        units ? this.kf('Residential units', int(units)) : this.kf('Lot area', acres(rows.reduce((a, r) => a + (r.lot ?? 0), 0))),
        this.kf(
          'Average hold',
          avg != null ? `${Math.round(avg)} yrs` : 'Not on record',
          avg != null && exact.length < rows.length ? `${exact.length} of ${rows.length} parcels with an exact hold` : undefined,
          'Average years since the last priced sale, over the parcels where it is known exactly. Holds that reach back past the county sale records (shown as minimums) and parcels with no sale on record are left out.',
        ),
        this.kf('Longest hold', longest ? `${longest.y}${longest.min ? '+' : ''} yrs` : 'Not on record', longest?.min ? 'minimum: older than the sale records' : undefined),
      ),
    );

    // ---- Map, class mix, timeline ----------------------------------------------------------------
    const mapSec = h('section', { class: 'dr-sec op-sec' }, h('h3', null, 'Where they own'), this.mini.el);
    this.body.append(mapSec);
    requestAnimationFrame(() => this.mini.show(rows));

    this.body.append(this.classMix(rows, jv));
    this.body.append(this.timeline(rows));

    // ---- Entities --------------------------------------------------------------------------------
    this.body.append(this.entities(ix, ref, rows));

    // ---- Holdings --------------------------------------------------------------------------------
    this.body.append(
      h(
        'section',
        { class: 'dr-sec' },
        h('h3', null, `All parcels (${int(rows.length)})`),
        h(
          'ol',
          { class: 'pf-list' },
          rows.map((r) =>
            h(
              'li',
              null,
              h(
                'button',
                { type: 'button', class: 'pf-item', title: 'Open this parcel', onclick: () => this.handlers.onSelectParcel(r.pid) },
                h('i', { class: 'pf-sw', style: { background: CLASS_COLORS[r.cls] ?? CLASS_FALLBACK } }),
                h(
                  'span',
                  { class: 'pf-main' },
                  h('span', { class: 'pf-addr' }, r.addr || 'No site address'),
                  h(
                    'span',
                    { class: 'pf-sub' },
                    [titleCase(r.city), CLASS_SHORT[r.cls] ?? r.cls, holdText(r) ? `held ${holdText(r)}` : null, names.size > 1 ? r.own : null]
                      .filter(Boolean)
                      .join(' · '),
                  ),
                ),
                r.jv != null && r.jv < nominal ? h('span', { class: 'pf-val nominal' }, 'Nominal') : h('span', { class: 'pf-val' }, money(r.jv)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  private kf(k: string, v: string, sub?: string, info?: string): HTMLElement {
    return h(
      'div',
      { class: 'kf' },
      h('dt', null, k, info ? infoTip(k.toLowerCase(), info) : null),
      h('dd', null, h('span', { class: 'kf-v' }, v), sub ? h('span', { class: 'kf-sub' }, sub) : null),
    );
  }

  /** Part-to-whole by assessed value: one bar, 2px gaps, legend rows with counts and shares. */
  private classMix(rows: IndexRow[], total: number): HTMLElement {
    const by = new Map<string, { n: number; jv: number }>();
    for (const r of rows) {
      const g = by.get(r.cls) ?? { n: 0, jv: 0 };
      g.n++;
      g.jv += r.jv ?? 0;
      by.set(r.cls, g);
    }
    const list = [...by.entries()].sort((a, b) => b[1].jv - a[1].jv);
    return h(
      'section',
      { class: 'dr-sec op-sec' },
      h('h3', null, 'Asset class mix'),
      h(
        'div',
        { class: 'op-bar', role: 'img', 'aria-label': list.map(([c, g]) => `${CLASS_BADGE[c] ?? c} ${pct(total ? g.jv / total : 0)}`).join(', ') },
        list.map(([c, g]) => h('span', { style: { flexGrow: String(Math.max(g.jv, 1)), background: CLASS_COLORS[c] ?? CLASS_FALLBACK } })),
      ),
      h(
        'ul',
        { class: 'op-mix' },
        list.map(([c, g]) =>
          h(
            'li',
            null,
            h('i', { style: { background: CLASS_COLORS[c] ?? CLASS_FALLBACK } }),
            h('span', { class: 'op-mix-name' }, CLASS_BADGE[c] ?? c),
            h('span', { class: 'op-mix-n' }, `${int(g.n)} ${g.n === 1 ? 'parcel' : 'parcels'}`),
            h('span', { class: 'op-mix-v' }, money(g.jv)),
            h('span', { class: 'op-mix-p' }, pct(total ? g.jv / total : 0)),
          ),
        ),
      ),
    );
  }

  /**
   * When each parcel was bought (its last priced sale, where on record) and for how much: year
   * across, price on a log scale up, class-colored dots with a hover readout; then the list.
   */
  private timeline(rows: IndexRow[]): HTMLElement {
    const asOf = this.manifest.source.as_of_year;
    const sold = rows.filter((r) => r.sy && r.sp).sort((a, b) => b.sy! * 100 + (b.sm ?? 0) - (a.sy! * 100 + (a.sm ?? 0)));
    const before = rows.filter((r) => !r.sy && r.hf != null);
    const none = rows.filter((r) => !r.sy && r.hf == null);
    const sec = h('section', { class: 'dr-sec op-sec' }, h('h3', null, 'Acquisition timeline', infoTip('acquisition timeline', 'Each parcel’s last sale of $100 or more on record: roughly when and for how much the current owner bought it. A later transfer between related entities for under $100 does not count as a sale. Prices are as recorded: one deed covering several parcels can carry the whole price on each.')));
    if (!sold.length) {
      sec.append(h('p', { class: 'cap' }, 'No priced sale of these parcels is on record.'));
    } else {
      sec.append(this.chart(sold, asOf));
      const items: Child[] = sold.slice(0, 40).map((r) =>
        h(
          'li',
          null,
          h('span', { class: 'op-t-date' }, saleDate(r.sy, r.sm)),
          h('button', { type: 'button', class: 'op-t-addr', onclick: () => this.handlers.onSelectParcel(r.pid) }, r.addr || 'No site address'),
          h('span', { class: 'op-t-price' }, money(r.sp)),
        ),
      );
      sec.append(h('ul', { class: 'op-tlist' }, items));
      if (sold.length > 40) sec.append(h('p', { class: 'cap' }, `+ ${int(sold.length - 40)} earlier purchases.`));
    }
    const notes: string[] = [];
    if (before.length) notes.push(`${int(before.length)} with no priced sale inside the county records (held at least ${Math.min(...before.map((r) => r.hf!))} years)`);
    if (none.length) notes.push(`${int(none.length)} with no sale on record`);
    if (notes.length) sec.append(h('p', { class: 'cap' }, `Not shown: ${notes.join('; ')}.`));
    return sec;
  }

  private chart(sold: IndexRow[], asOf: number): HTMLElement {
    const W = 392;
    const H = 150;
    const L = 46;
    const R = 10;
    const T = 10;
    const B = 22;
    const years = sold.map((r) => r.sy! + ((r.sm || 6) - 1) / 12);
    let x0 = Math.floor(Math.min(...years)) - 1;
    const x1 = asOf + 0.5;
    if (x1 - x0 < 6) x0 = x1 - 6;
    const logs = sold.map((r) => Math.log10(Math.max(r.sp!, 1)));
    let y0 = Math.floor(Math.min(...logs));
    let y1 = Math.ceil(Math.max(...logs));
    if (y1 === y0) {
      y0 -= 1;
      y1 += 1;
    }
    const x = (v: number) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
    const y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'op-chart', role: 'img', 'aria-label': `Purchases from ${Math.floor(Math.min(...years))} to ${Math.floor(Math.max(...years))}` });
    for (let p = y0; p <= y1; p++) {
      root.append(svg('line', { x1: L, x2: W - R, y1: y(p), y2: y(p), class: 'op-grid' }));
      const t = svg('text', { x: L - 6, y: y(p) + 3.5, class: 'op-tick', 'text-anchor': 'end' });
      t.textContent = money(10 ** p).replace('.0', '');
      root.append(t);
    }
    const span = x1 - x0;
    const step = span > 40 ? 10 : span > 16 ? 5 : 2;
    for (let yr = Math.ceil(x0 / step) * step; yr <= x1; yr += step) {
      const t = svg('text', { x: x(yr), y: H - 6, class: 'op-tick', 'text-anchor': 'middle' });
      t.textContent = String(yr);
      root.append(t);
    }
    root.append(svg('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, class: 'op-axis' }));
    const tip = h('div', { class: 'op-tip', hidden: true });
    const wrap = h('div', { class: 'op-chart-wrap' }, tip);
    wrap.prepend(root);
    sold.forEach((r, i) => {
      const cx = x(years[i]!);
      const cy = y(logs[i]!);
      const hit = svg('circle', { cx, cy, r: 9, class: 'op-hit' });
      const dot = svg('circle', { cx, cy, r: 4.5, class: 'op-dot', fill: CLASS_COLORS[r.cls] ?? CLASS_FALLBACK });
      const show = () => {
        tip.textContent = `${r.addr || 'No site address'} · ${saleDate(r.sy, r.sm)} · ${money(r.sp)}`;
        tip.hidden = false;
        tip.style.left = `${(cx / W) * 100}%`;
        tip.style.top = `${(cy / H) * 100}%`;
        dot.classList.add('on');
      };
      const hide = () => {
        tip.hidden = true;
        dot.classList.remove('on');
      };
      for (const el of [hit, dot]) {
        el.addEventListener('pointerenter', show);
        el.addEventListener('pointerleave', hide);
        el.addEventListener('click', () => this.handlers.onSelectParcel(r.pid));
      }
      root.append(dot, hit);
    });
    return wrap;
  }

  /** Who is in the group, and who is linked to it by a shared mailing address. */
  private entities(ix: ParcelIndex, ref: OwnerRef, rows: IndexRow[]): HTMLElement {
    const sec = h('section', { class: 'dr-sec op-sec' });
    const openName = (name: string, oak: number | null) => {
      const row = ix.rows.find((r) => r.own === name && (oak == null || r.oak === oak)) ?? ix.rows.find((r) => r.own === name);
      if (row) this.handlers.onOpenOwner(ownerRefOf(row, 'name'));
    };
    const entityList = (items: { name: string; parcels: number; oak: number | null }[]) =>
      h(
        'ul',
        { class: 'op-ent' },
        items.slice(0, 30).map((e) =>
          h(
            'li',
            null,
            h('button', { type: 'button', class: 'op-ent-name', title: 'Open this owner', onclick: () => openName(e.name, e.oak) }, e.name),
            h('span', { class: 'op-ent-n' }, `${int(e.parcels)} ${e.parcels === 1 ? 'parcel' : 'parcels'}`),
          ),
        ),
      );
    if (ref.kind === 'a') {
      const g = ix.mailingByKey.get(Number(ref.id));
      const names = [...(ix.namesByAddr.get(Number(ref.id)) ?? new Map<string, number>()).entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, parcels]) => ({ name, parcels, oak: Number(ref.id) }));
      appendAll(
        sec,
        h('h3', null, 'Owner names at this address'),
        h('p', { class: 'op-mail' }, g?.label ?? mailingLine(rows[0]!)),
        g?.agent ? h('p', { class: 'warn' }, 'Many unrelated-looking owners share this address. It may be a registered agent or manager rather than one owner.') : null,
        entityList(names),
      );
      return sec;
    }
    // Owner name (or one parcel): the mailing addresses it uses, then names linked through them.
    const mails = new Map<string, { n: number; row: IndexRow }>();
    for (const r of rows) {
      const k = mailingLine(r);
      const m = mails.get(k);
      if (m) m.n++;
      else mails.set(k, { n: 1, row: r });
    }
    sec.append(
      h('h3', null, mails.size > 1 ? `Mailing addresses (${mails.size})` : 'Mailing address'),
      h(
        'ul',
        { class: 'op-ent' },
        [...mails.entries()]
          .sort((a, b) => b[1].n - a[1].n)
          .slice(0, 8)
          .map(([line, m]) =>
            h(
              'li',
              null,
              m.row.oak != null
                ? h('button', { type: 'button', class: 'op-ent-name', title: 'Everything mailed to this address', onclick: () => this.handlers.onOpenOwner({ kind: 'a', id: m.row.oak! }) }, line || '—')
                : h('span', { class: 'op-ent-text' }, line || '—'),
              h('span', { class: 'op-ent-n' }, `${int(m.n)} ${m.n === 1 ? 'parcel' : 'parcels'}`),
            ),
          ),
      ),
    );
    const related = relatedEntities(ix, { ref, label: this.label }, rows);
    if (related.length) {
      sec.append(
        h('h3', { class: 'op-sub' }, 'Related entities', infoTip('related entities', 'Other owner names that share a mailing address with this owner (registered-agent addresses left out). Often affiliates of the same sponsor; their parcels are not included above. Open one to see its holdings.')),
        entityList(related.map((e) => ({ ...e, oak: null }))),
      );
    }
    return sec;
  }

  private exportCsv(): void {
    if (!this.rows.length) return;
    const base = `${window.location.origin}${window.location.pathname}`;
    const slug = (this.label || 'owner').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    download(`pa2-${slug}-${stamp()}.csv`, parcelsCsv(this.rows, this.manifest.use_codes ?? {}, nominalMax(this.manifest), (pid) => `${base}#p=${pid}`));
    toast(`Exported ${int(this.rows.length)} parcels`);
  }

  /** Key for comparing with the map's owner spotlight. */
  get key(): string | null {
    return this.ref ? refKey(this.ref) : null;
  }
}
