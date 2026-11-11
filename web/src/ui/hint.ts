import { h, icon } from '../dom';
import { loadUi, saveUi } from '../state';

export interface HintActions {
  onPickMarket(): void;
  onRunScreen(): void;
}

/**
 * First-visit card: what the tool does in one sentence and where to start. Dismissed for good
 * by its close button or either action (remembered per browser); it also steps aside once a
 * parcel is opened.
 */
export class FirstVisitHint {
  private el: HTMLElement | null = null;

  constructor(container: HTMLElement, actions: HintActions) {
    if (loadUi({ hintDismissed: false }).hintDismissed) return;
    const act = (fn: () => void) => () => {
      this.dismiss();
      fn();
    };
    this.el = h(
      'section',
      { class: 'hint', role: 'note', 'aria-label': 'Getting started' },
      h(
        'div',
        { class: 'hint-text' },
        h(
          'p',
          { class: 'hint-lead' },
          'Every commercial and multifamily parcel in Martin, St. Lucie and Palm Beach counties, in 3D: what it’s worth, when it last sold and who owns it.',
        ),
        h('p', { class: 'hint-cta' }, 'Pick a market or run a screen to start. Click any parcel for its details.'),
      ),
      h(
        'div',
        { class: 'hint-actions' },
        h('button', { type: 'button', class: 'btn solid sm', onclick: act(actions.onPickMarket) }, icon('pin', 14), 'Pick a market'),
        h('button', { type: 'button', class: 'btn ghost sm', onclick: act(actions.onRunScreen) }, icon('filters', 14), 'Run a screen'),
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
