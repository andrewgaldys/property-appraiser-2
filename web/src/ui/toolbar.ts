import { BASEMAP_MODES, LENS_MIN_ZOOM } from '../config';
import { h } from '../dom';
import type { Store } from '../state';
import type { AppState } from '../types';

/** Map top bar: basemap mode (Dark / Hybrid / Split) + the [S] satellite lens toggle. */
export class Toolbar {
  private modeButtons: { id: AppState['basemap']; el: HTMLButtonElement }[];
  private lensBtn: HTMLButtonElement;

  constructor(container: HTMLElement, private store: Store<AppState>) {
    this.modeButtons = BASEMAP_MODES.map((m) => ({
      id: m.id,
      el: h('button', { type: 'button', class: 'tb-btn', role: 'radio', title: m.title, onclick: () => store.set({ basemap: m.id }) }, m.label),
    }));
    this.lensBtn = h('button', { type: 'button', class: 'tb-btn tb-lens', onclick: () => this.toggleLens() });
    container.append(
      h(
        'div',
        { class: 'map-toolbar', role: 'toolbar', 'aria-label': 'Basemap and satellite' },
        h('div', { class: 'tb-seg', role: 'radiogroup', 'aria-label': 'Basemap' }, this.modeButtons.map((b) => b.el)),
        this.lensBtn,
      ),
    );
    this.sync(store.get());
    store.subscribe((s, prev) => {
      if (s.basemap !== prev.basemap || s.lens !== prev.lens) this.sync(s);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 's' && e.key !== 'S') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      this.toggleLens();
    });
  }

  private toggleLens(): void {
    this.store.set({ lens: !this.store.get().lens });
  }

  private sync(s: AppState): void {
    for (const b of this.modeButtons) {
      const on = b.id === s.basemap;
      b.el.classList.toggle('on', on);
      b.el.setAttribute('aria-checked', String(on));
    }
    const usable = s.basemap === 'dark';
    this.lensBtn.textContent = '';
    this.lensBtn.append(h('kbd', null, 'S'), ` Satellite Lens: ${s.lens ? 'ON' : 'OFF'}`);
    this.lensBtn.classList.toggle('on', s.lens && usable);
    this.lensBtn.setAttribute('aria-pressed', String(s.lens));
    this.lensBtn.title = usable
      ? `Imagery inside a lens around the cursor at zoom ${LENS_MIN_ZOOM}+ (press S)`
      : 'The lens works on the Dark basemap; Hybrid and Split already show imagery';
  }
}
