import { LONG_HOLD_YEARS, PRESETS, UNDERBUILT } from '../config';
import { clear, h, icon, toast } from '../dom';
import { describeScreen, type SavedScreen, type ScreenRepository, type ScreenState } from '../screens';
import { loadUi, saveUi, type Store } from '../state';
import type { AppState, Manifest, PresetId } from '../types';
import { coverageLine, prospectingRules } from './facts';
import { infoTip } from './infotip';

export interface ProspectingHandlers {
  /** The current screen, including the map view. */
  capture(): ScreenState;
  apply(state: ScreenState): void;
  copyLink(): void;
}

/** What each preset does, in plain language (the exact rules: map/layers.ts filterExpr). */
function presetInfo(id: PresetId, m: Manifest): string {
  const year = m.source.as_of_year - LONG_HOLD_YEARS;
  switch (id) {
    case 'long':
      return `Last sale of $100 or more ${LONG_HOLD_YEARS} or more years ago (${year} or earlier), or no priced sale on record since at least then. ${coverageLine(m) ?? ''}\n\nParcels with no sale on record are left out: their hold is unknown, not long.`;
    case 'underbuilt':
      return `Buildings worth at most ${Math.round(UNDERBUILT.maxBtl * 100)}% of the land (building-to-land value ${UNDERBUILT.maxBtl}× or less) on a lot of ${UNDERBUILT.minLotAc} acre or more. Vacant land counts; nominal-value parcels don't. Add an asset class to narrow it.`;
    case 'outside':
      return `The tax bill goes out of state, or elsewhere in Florida: outside Martin, St. Lucie and Palm Beach, or inside them but more than ${prospectingRules(m).miles} miles from the parcel.\n\nThe distance runs from the middle of the owner’s mailing ZIP code (placed using this dataset’s own parcels) to the parcel, so it is approximate. Owners just past the outer county lines (Deerfield Beach, Vero Beach, Okeechobee) count however close they are.`;
    case 'small':
      return `The owner name holds ${prospectingRules(m).small[0]} to ${prospectingRules(m).small[1]} parcels across the three counties, all in one asset class (grouped by owner name, not mailing address).`;
    case 'trust':
      return 'The owner name reads as a trust or an estate: TRUST, TRUSTEE, TR, ESTATE OF and the like. Land trusts count; REITs, banks and real-estate companies do not.';
  }
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Prospecting: preset screens a broker would actually run (combinable with each other and every
 * other filter) and named saved screens. Saved screens live in this browser for now; the
 * repository interface is where a shared backend would plug in.
 */
export class ProspectingPanel {
  readonly el: HTMLDetailsElement;
  private sum: HTMLElement;
  private toggles = new Map<PresetId, HTMLInputElement>();
  private list: HTMLElement;
  private form: HTMLElement;
  private nameInput: HTMLInputElement;
  private screens: SavedScreen[] = [];
  private confirming: string | null = null;

  constructor(
    manifest: Manifest,
    private store: Store<AppState>,
    private repo: ScreenRepository,
    private handlers: ProspectingHandlers,
  ) {
    this.sum = h('span', { class: 'sec-sum' });
    const presets = h(
      'ul',
      { class: 'presets' },
      PRESETS.map((p) => {
        const input = h('input', { type: 'checkbox', role: 'switch', onchange: () => this.toggle(p.id, input.checked) }) as HTMLInputElement;
        this.toggles.set(p.id, input);
        return h(
          'li',
          null,
          h('label', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', { class: 'switch-label' }, p.label)),
          infoTip(p.label.toLowerCase(), () => presetInfo(p.id, manifest)),
        );
      }),
    );
    this.list = h('ul', { class: 'saved' });
    this.nameInput = h('input', {
      type: 'text',
      class: 'saved-input',
      maxlength: '80',
      'aria-label': 'Name for this screen',
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') void this.save();
        if (e.key === 'Escape') this.showForm(false);
      },
    }) as HTMLInputElement;
    this.form = h(
      'div',
      { class: 'saved-form', hidden: true },
      this.nameInput,
      h('div', { class: 'saved-form-actions' },
        h('button', { type: 'button', class: 'btn solid sm', onclick: () => void this.save() }, 'Save'),
        h('button', { type: 'button', class: 'btn ghost sm', onclick: () => this.showForm(false) }, 'Cancel'),
      ),
    );
    const open = loadUi({ sections: { prospecting: true } as Record<string, boolean> }).sections.prospecting !== false;
    this.el = h(
      'details',
      { class: 'sec prospecting', 'data-sec': 'prospecting' },
      h('summary', null, h('span', { class: 'sec-title' }, 'Prospecting'), this.sum, icon('chevron', 16)),
      h(
        'div',
        { class: 'sec-body' },
        h('p', { class: 'cap pre-cap' }, 'Turn on any mix; they combine with every other filter.'),
        presets,
        h('div', { class: 'saved-head' }, h('h4', null, 'Saved screens'), infoTip('saved screens', 'A saved screen keeps the filters, prospecting presets, search, owner grouping, table and map view. Saved in this browser only for now; use Copy link to share a screen with someone else.')),
        this.list,
        this.form,
        h(
          'div',
          { class: 'saved-actions' },
          h('button', { type: 'button', class: 'btn ghost sm', onclick: () => this.showForm(true) }, icon('save', 14), 'Save this screen'),
          h('button', { type: 'button', class: 'btn ghost sm', onclick: () => this.handlers.copyLink() }, icon('link', 14), 'Copy link'),
        ),
      ),
    ) as HTMLDetailsElement;
    this.el.open = open;
    this.el.addEventListener('toggle', () => {
      const cur = loadUi({ sections: {} as Record<string, boolean> }).sections;
      saveUi({ sections: { ...cur, prospecting: this.el.open } });
    });
    this.sync(store.get());
    store.subscribe((s, prev) => {
      if (s.filters !== prev.filters) this.sync(s);
    });
    void this.refresh();
  }

  private toggle(id: PresetId, on: boolean): void {
    const f = this.store.get().filters;
    const presets = on ? [...new Set([...f.presets, id])] : f.presets.filter((p) => p !== id);
    this.store.set({ filters: { ...f, presets } });
  }

  private sync(s: AppState): void {
    for (const [id, input] of this.toggles) input.checked = s.filters.presets.includes(id);
    const n = s.filters.presets.length;
    this.sum.textContent = n ? `${n} on` : this.screens.length ? `${this.screens.length} saved` : '';
    this.sum.classList.toggle('on', n > 0);
  }

  private async refresh(): Promise<void> {
    try {
      this.screens = await this.repo.list();
    } catch {
      this.screens = [];
    }
    this.renderList();
    this.sync(this.store.get());
  }

  private renderList(): void {
    clear(this.list);
    if (!this.screens.length) {
      this.list.append(h('li', { class: 'saved-empty' }, 'None yet. Set up a screen, then save it here.'));
      return;
    }
    for (const sc of this.screens) {
      if (this.confirming === sc.id) {
        this.list.append(
          h(
            'li',
            { class: 'saved-item confirm' },
            h('span', { class: 'saved-q' }, `Delete “${sc.name}”?`),
            h('button', { type: 'button', class: 'btn ghost sm', onclick: () => void this.remove(sc) }, 'Delete'),
            h('button', { type: 'button', class: 'btn ghost sm', onclick: () => this.confirm(null) }, 'Keep'),
          ),
        );
        continue;
      }
      this.list.append(
        h(
          'li',
          { class: 'saved-item' },
          h(
            'button',
            { type: 'button', class: 'saved-open', title: 'Apply this screen', onclick: () => this.handlers.apply(sc.state) },
            h('span', { class: 'saved-name' }, sc.name),
            h('span', { class: 'saved-sub' }, `${describeScreen(sc.state)} · ${fmtDate(sc.updatedAt)}`),
          ),
          h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Delete ${sc.name}`, title: 'Delete', onclick: () => this.confirm(sc.id) }, icon('close', 13)),
        ),
      );
    }
  }

  private confirm(id: string | null): void {
    this.confirming = id;
    this.renderList();
  }

  private showForm(on: boolean): void {
    this.form.hidden = !on;
    if (on) {
      this.nameInput.value = describeScreen(this.handlers.capture()).slice(0, 80);
      this.nameInput.focus();
      this.nameInput.select();
    }
  }

  private async save(): Promise<void> {
    const name = this.nameInput.value.trim();
    if (!name) {
      this.nameInput.focus();
      return;
    }
    try {
      await this.repo.save(name, this.handlers.capture());
      this.showForm(false);
      toast(`Saved “${name}”`);
      await this.refresh();
    } catch (err) {
      console.error(err);
      toast('Could not save in this browser (storage is unavailable).');
    }
  }

  private async remove(sc: SavedScreen): Promise<void> {
    try {
      await this.repo.remove(sc.id);
    } catch (err) {
      console.error(err);
    }
    this.confirming = null;
    await this.refresh();
  }
}
