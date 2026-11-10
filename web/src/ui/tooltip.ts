import { CLASS_SHORT, COUNTY_META } from '../config';
import { clear, h } from '../dom';
import { int, money } from '../format';
import type { TileProps } from '../types';

/** Hover readout: the value leads, identity follows (all text via textContent). */
export class Tooltip {
  private el: HTMLElement;
  private pid: string | null = null;

  constructor() {
    this.el = document.getElementById('tooltip') ?? document.body.appendChild(h('div', { id: 'tooltip', class: 'tooltip' }));
    this.el.hidden = true;
  }

  show(p: TileProps, clientX: number, clientY: number): void {
    if (this.pid !== p.pid) {
      this.pid = p.pid;
      clear(this.el);
      const facts = [
        CLASS_SHORT[p.cls] ?? p.cls,
        COUNTY_META[p.co]?.short,
        p.sf ? `${int(p.sf)} SF` : null,
        p.u ? `${int(p.u)} units` : null,
        p.hold != null ? `${p.hold} yr hold` : 'no sale on record',
      ].filter(Boolean);
      this.el.append(
        h('div', { class: 'tt-value' }, money(p.jv ?? null), h('span', { class: 'tt-unit' }, 'just value')),
        h('div', { class: 'tt-addr' }, p.addr || 'No site address'),
        h('div', { class: 'tt-meta' }, facts.join(' · ')),
      );
    }
    this.el.hidden = false;
    const pad = 14;
    const r = this.el.getBoundingClientRect();
    let x = clientX + pad;
    let y = clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = clientY - r.height - pad;
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  hide(): void {
    this.el.hidden = true;
    this.pid = null;
  }
}
