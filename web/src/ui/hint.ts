import { h, icon } from '../dom';
import { loadUi, saveUi } from '../state';
import type { Manifest } from '../types';
import { area } from './facts';

export interface HintActions {
  /** Show the starter lists (the Saved panel). */
  onStarters(): void;
  onHelp(): void;
}

/**
 * First-visit strip: one line on what the tool is for and two ways in. It is small on purpose:
 * the default page is the map. Dismissed for good by its close button or either action
 * (remembered per browser); it also steps aside once someone filters or opens a parcel.
 */
export class FirstVisitHint {
  private el: HTMLElement | null = null;

  /** `show: false` skips the strip for this visit only (someone arrived on a link to a screen, parcel or owner). */
  constructor(container: HTMLElement, manifest: Manifest, actions: HintActions, show = true) {
    if (!show || loadUi({ hintDismissed: false }).hintDismissed) return;
    const act = (fn: () => void) => () => {
      this.dismiss();
      fn();
    };
    const where = area(manifest);
    this.el = h(
      'section',
      { class: 'hint', role: 'note', 'aria-label': 'Getting started' },
      h(
        'p',
        { class: 'hint-text' },
        h('b', null, 'Find the owners worth calling.'),
        ` Every commercial and multifamily parcel ${where.n > 1 ? `from ${where.span}` : `in ${where.names}`}.`,
      ),
      h(
        'div',
        { class: 'hint-actions' },
        h('button', { type: 'button', class: 'btn solid sm', onclick: act(actions.onStarters) }, 'Try a starter list'),
        h('button', { type: 'button', class: 'btn ghost sm', onclick: act(actions.onHelp) }, 'How it works'),
      ),
      h('button', { type: 'button', class: 'icon-btn sm hint-close', 'aria-label': 'Dismiss', onclick: () => this.dismiss() }, icon('close', 14)),
    );
    container.append(this.el);
  }

  get visible(): boolean {
    return !!this.el;
  }

  dismiss(): void {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    saveUi({ hintDismissed: true });
  }
}
