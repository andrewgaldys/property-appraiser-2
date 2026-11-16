import { STARTER_SCREENS } from '../config';
import { h, icon } from '../dom';
import { loadUi, saveUi } from '../state';
import type { Manifest } from '../types';
import { area } from './facts';

export interface HintActions {
  /** Run a starter screen (config STARTER_SCREENS). */
  onStarter(id: string): void;
  onHelp(): void;
}

/**
 * First-visit card: what the tool is for in one sentence, and three example lists that each show
 * the whole workflow in one click. Dismissed for good by its close button or any action
 * (remembered per browser); it also steps aside once someone filters or opens a parcel.
 */
export class FirstVisitHint {
  private el: HTMLElement | null = null;

  /** `show: false` skips the card for this visit only (someone arrived on a link to a screen, parcel or owner). */
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
      h('p', { class: 'eyebrow' }, 'Start here'),
      h('h2', { class: 'hint-lead' }, 'Find the owners worth calling.'),
      h(
        'p',
        { class: 'hint-text' },
        `Every commercial and multifamily parcel ${where.n > 1 ? `from ${where.span}` : `in ${where.names}`}: what it is worth, when it last sold, and who owns it.`,
      ),
      h('p', { class: 'hint-cta' }, 'Try a list:'),
      h(
        'div',
        { class: 'hint-actions' },
        STARTER_SCREENS.slice(0, 3).map((sc) =>
          h('button', { type: 'button', class: 'hint-starter', onclick: act(() => actions.onStarter(sc.id)) }, h('span', null, sc.label), icon('arrow', 14)),
        ),
      ),
      h(
        'p',
        { class: 'hint-foot' },
        'Or build your own in the sidebar. ',
        h('button', { type: 'button', class: 'linklike', onclick: () => actions.onHelp() }, 'How it works'),
      ),
      h('button', { type: 'button', class: 'icon-btn hint-close', 'aria-label': 'Dismiss', onclick: () => this.dismiss() }, icon('close', 14)),
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
