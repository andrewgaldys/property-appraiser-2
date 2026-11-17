import type { DataStore } from '../data';
import { clear, h } from '../dom';
import { shortDate } from '../format';
import { defOf, type SignalHit } from '../signals';
import type { Manifest } from '../types';

/** "FEMA National Flood Hazard Layer, as of May 13, 2026 · confidence 95%": what a chip rests on. */
export function signalTip(x: SignalHit, m: Manifest): string {
  const def = defOf(x.code);
  const src = def ? m.signals?.sources[def.source] : undefined;
  const when = x.date ? (/^\d{4}-\d{2}-\d{2}$/.test(x.date) ? shortDate(x.date) : x.date) : null;
  return [def?.label, src?.label, when ? `record of ${when}` : null, `confidence ${Math.round(x.conf * 100)}%`].filter(Boolean).join(' · ');
}

/**
 * The parcel panel's deal-signal chips, loaded once per parcel (re-renders of the same parcel keep
 * them). Hidden when the parcel has none.
 */
export class SignalChips {
  readonly el = h('ul', { class: 'signals deal', 'aria-label': 'Deal signals', hidden: true });
  private pid: string | null = null;
  private token = 0;

  constructor(
    private data: DataStore,
    private manifest: Manifest,
  ) {}

  get enabled(): boolean {
    return !!this.manifest.signals;
  }

  show(pid: string): HTMLElement {
    if (pid === this.pid) return this.el;
    this.pid = pid;
    const t = ++this.token;
    clear(this.el);
    this.el.hidden = true;
    this.data.signalDetail(pid).then(
      (hits) => {
        if (t !== this.token) return;
        clear(this.el);
        for (const x of hits) {
          const group = defOf(x.code)?.group ?? 'other';
          this.el.append(h('li', { class: `sg sg-${group}`, title: signalTip(x, this.manifest) }, x.chip));
        }
        this.el.hidden = !hits.length;
      },
      () => {
        if (t === this.token) this.el.hidden = true;
      },
    );
    return this.el;
  }
}
