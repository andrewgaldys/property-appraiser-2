import { CLASS_BADGE, CLASS_COLORS, CLASS_FALLBACK, COUNTY_META } from '../config';
import { clear, h } from '../dom';
import { int, money } from '../format';
import type { Manifest, ParcelRecord, TileProps } from '../types';
import { holdShort, isNominal, unitsApply } from './facts';

type Lookup = (pid: string) => Promise<ParcelRecord | null>;

/**
 * Hover readout: assessed market value first, then site address, property subtype, owner (all via
 * textContent). Low-zoom dots don't carry address/owner, so those are filled in from the detail shard.
 * Nominal-value parcels say so instead of showing "$100" as if it were a price.
 */
export class Tooltip {
  private el: HTMLElement;
  private pid: string | null = null;
  private timer = 0;
  private offset = 14;
  private last = { x: 0, y: 0 };

  constructor(
    private manifest: Manifest,
    private lookup: Lookup,
  ) {
    this.el = document.getElementById('tooltip') ?? document.body.appendChild(h('div', { id: 'tooltip', class: 'tooltip' }));
    this.el.hidden = true;
  }

  /** Distance from the cursor; widened while the satellite lens is showing so the tooltip clears it. */
  setOffset(px: number): void {
    this.offset = px;
    if (!this.el.hidden) this.place();
  }

  show(p: TileProps, clientX: number, clientY: number): void {
    this.last = { x: clientX, y: clientY };
    if (this.pid !== p.pid) {
      this.pid = p.pid;
      window.clearTimeout(this.timer);
      this.render(p, null);
      if (p.addr === undefined || p.own === undefined) {
        const pid = p.pid;
        this.timer = window.setTimeout(() => {
          this.lookup(pid)
            .then((rec) => {
              if (rec && this.pid === pid) {
                this.render(p, rec);
                this.place();
              }
            })
            .catch(() => undefined);
        }, 90);
      }
    }
    this.el.hidden = false;
    this.place();
  }

  private subtype(p: TileProps): string {
    if (p.cls === 'MF10' || p.cls === 'MF2_9') return CLASS_BADGE[p.cls]!;
    return (p.uc && this.manifest.use_codes?.[p.uc]) || CLASS_BADGE[p.cls] || p.cls;
  }

  private render(p: TileProps, rec: ParcelRecord | null): void {
    clear(this.el);
    const pending = !rec && (p.addr === undefined || p.own === undefined);
    const addr = p.addr ?? rec?.site_address;
    const owner = p.own ?? rec?.owner_name;
    const jv = p.jv ?? rec?.just_value ?? null;
    const nominal = isNominal(jv, this.manifest);
    const facts = [
      COUNTY_META[p.co]?.name,
      p.sf ? `${int(p.sf)} SF` : null,
      p.u && unitsApply(p.cls, p.uc) ? `${int(p.u)} units` : null,
      holdShort(p),
    ].filter(Boolean);
    this.el.append(
      nominal
        ? h('div', { class: 'tt-value nominal' }, 'Nominal value', h('span', { class: 'tt-unit' }, `${money(jv)} on the roll`))
        : h('div', { class: 'tt-value' }, money(jv), h('span', { class: 'tt-unit' }, 'assessed market value')),
      h('div', { class: 'tt-addr' }, addr || (pending ? '…' : 'No site address')),
      h(
        'div',
        { class: 'tt-sub' },
        h('i', { class: 'tt-sw', style: { background: CLASS_COLORS[p.cls] ?? CLASS_FALLBACK } }),
        this.subtype(p),
      ),
      h('div', { class: 'tt-owner' }, h('span', { class: 'tt-k' }, 'Owner'), ' ', owner || (pending ? '…' : 'Not reported')),
      h('div', { class: 'tt-meta' }, facts.join(' · ')),
    );
  }

  private place(): void {
    const { x: cx, y: cy } = this.last;
    const pad = this.offset;
    const r = this.el.getBoundingClientRect();
    let x = cx + pad;
    let y = cy + pad;
    if (x + r.width > window.innerWidth - 8) x = cx - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = cy - r.height - pad;
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  hide(): void {
    this.el.hidden = true;
    this.pid = null;
    window.clearTimeout(this.timer);
  }
}
