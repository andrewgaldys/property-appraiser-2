import { LONG_HOLD_YEARS, PRESETS, STARTER_SCREENS, UNDERBUILT } from '../config';
import { int } from '../format';
import { hasSignalData, isSignalPreset, presetMask, signalPids } from '../signals';
import { clear, h, icon, toast } from '../dom';
import { describeScreen, type SavedScreen, type ScreenRepository, type ScreenState } from '../screens';
import { loadUi, saveUi, type Store } from '../state';
import type { AppState, Manifest, PresetId } from '../types';
import { area, coverageLine, prospectingRules } from './facts';
import { stepTag } from './filters';
import { infoTip } from './infotip';

export interface ProspectingHandlers {
  /** The current screen, including the map view. */
  capture(): ScreenState;
  apply(state: ScreenState): void;
  copyLink(): void;
  /** Run one of the starter screens (config STARTER_SCREENS). */
  starter(id: string): void;
}

/** What each preset does, in plain language (the exact rules: map/layers.ts filterExpr). */
function presetInfo(id: PresetId, m: Manifest): string {
  const year = m.source.as_of_year - LONG_HOLD_YEARS;
  switch (id) {
    case 'long':
      return `Last sale of $100 or more ${LONG_HOLD_YEARS} or more years ago (${year} or earlier), or no priced sale on record since at least then. ${coverageLine(m) ?? ''}\n\nParcels with no sale on record are left out: their hold is unknown, not long.${
        Object.values(m.sales_coverage ?? {}).some((c) => c.depth === 'latest')
          ? ' Where a county lists only the latest transfer, a recent nominal one (a deed into an LLC, say) hides the earlier sale, so some long-time owners there are missed.'
          : ''
      }`;
    case 'underbuilt':
      return `Buildings worth at most ${Math.round(UNDERBUILT.maxBtl * 100)}% of the land (building-to-land value ${UNDERBUILT.maxBtl}× or less) on a lot of ${UNDERBUILT.minLotAc} acre or more. Vacant land counts; nominal-value parcels don't. Add an asset class to narrow it.`;
    case 'outside':
      return `The tax bill goes out of state, or elsewhere in Florida: outside ${area(m).the} covered here, or inside them but more than ${prospectingRules(m).miles} miles from the parcel.\n\nThe distance runs from the middle of the owner’s mailing ZIP code (placed using this dataset’s own parcels) to the parcel, so it is approximate. Owners just past the outer county lines count however close they are.`;
    case 'small':
      return `The owner name holds ${prospectingRules(m).small[0]} to ${prospectingRules(m).small[1]} parcels across ${area(m).the}, all in one asset class (grouped by owner name, not mailing address).`;
    case 'trust':
      return 'The owner name reads as a trust or an estate: TRUST, TRUSTEE, TR, ESTATE OF and the like. Land trusts count; REITs, banks and real-estate companies do not.';
    default:
      return signalInfo(id, m);
  }
}

/** Deal-signal presets, in plain language, with the thresholds and sources the bundle used. */
function signalInfo(id: PresetId, m: Manifest): string {
  const sg = m.signals;
  const t = (sg?.thresholds ?? {}) as Record<string, number | number[]>;
  const src = (k: string) => sg?.sources[k];
  const asOf = (k: string) => (src(k)?.as_of ? ` (${src(k)!.as_of})` : '');
  switch (id) {
    case 'entity':
      return `The owner's company is administratively dissolved (usually for a missed annual report), inactive (dissolved, merged or withdrawn), or this year's annual report is overdue, per the Division of Corporations' quarterly file${asOf('sunbiz')}. Only owners matched to a state record with enough confidence count.`;
    case 'fundexit': {
      const [lo, hi] = (t.fund_exit_years as number[]) ?? [5, 7];
      return `Last priced sale ${lo} to ${hi} years ago (an exact hold, not a minimum) and the owner is a company (LLC, corporation or partnership): the years in which many funds and syndicates sell or refinance.`;
    }
    case 'taxgap':
      return `The capped assessed value is at least ${Math.round(Number(t.tax_gap_min ?? 0.3) * 100)}% below the market (just) value on the ${src('roll')?.as_of ?? ''} roll. Florida limits increases on non-homestead property to 10% a year, so taxes keep rising toward market value, and a sale resets the assessment to market for the buyer.`;
    case 'flood':
      return "Half or more of the lot, or its center, lies in FEMA's 1% annual-chance flood zone (A or V zones), per the National Flood Hazard Layer. Rising flood insurance pushes some owners to sell; buildings older than the 2002 building code are flagged on the parcel.";
    case 'transfer':
      return `In the last ${t.recent_transfer_years ?? 10} years the latest transfer was by a lender or in lieu of foreclosure, a forced sale, or by an estate, receiver or trustee (state sale codes 12, 38, 19), or the parcel sold twice within ${t.flip_months ?? 36} months. Sale codes come from Broward's and Martin's histories and every county's latest sale; quick resales need a transfer history, which Miami-Dade and Indian River do not publish.`;
    case 'taxcert':
      return 'A tax certificate is outstanding: the property taxes went unpaid and the county sold (or kept) a lien for them. For now only Palm Beach\'s list of county-held certificates is loaded; the full lists of all six counties have been requested.';
    default:
      return '';
  }
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Owner signals: preset screens a broker would actually run (combinable with each other and every
 * other filter), and, in a section of its own, named saved screens plus the starter screens. Saved
 * screens live in this browser for now; the repository interface is where a shared backend would
 * plug in.
 */
export class ProspectingPanel {
  /** Step 3 of the sidebar's flow: the owner signals. */
  readonly el: HTMLDetailsElement;
  /** Saved and starter screens. */
  readonly savedEl: HTMLDetailsElement;
  private sum: HTMLElement;
  private savedSum: HTMLElement;
  private toggles = new Map<PresetId, HTMLInputElement>();
  private counts = new Map<PresetId, HTMLElement>();
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
    const toggleRow = (p: (typeof PRESETS)[number]) => {
      const input = h('input', { type: 'checkbox', role: 'switch', onchange: () => this.toggle(p.id, input.checked) }) as HTMLInputElement;
      this.toggles.set(p.id, input);
      const count = h('span', { class: 'switch-count' });
      this.counts.set(p.id, count);
      return h(
        'li',
        null,
        h('label', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', { class: 'switch-label' }, p.label, count)),
        infoTip(p.label.toLowerCase(), () => presetInfo(p.id, manifest)),
      );
    };
    const presets = h('ul', { class: 'presets' }, PRESETS.filter((p) => !isSignalPreset(p.id)).map(toggleRow));
    const signals = hasSignalData(manifest)
      ? h(
          'div',
          { class: 'deal-signals' },
          h(
            'div',
            { class: 'field-label' },
            'Deal signals',
            infoTip('deal signals', 'From state business records, the tax roll, county sale records, FEMA flood maps and county tax lists. Each parcel shows its signals with the source and date; Help lists every source.'),
          ),
          h('ul', { class: 'presets' }, PRESETS.filter((p) => isSignalPreset(p.id)).map(toggleRow)),
        )
      : null;
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
    const stored = loadUi({ sections: {} as Record<string, boolean> }).sections;
    const remember = (el: HTMLDetailsElement, id: string) =>
      el.addEventListener('toggle', () => {
        const cur = loadUi({ sections: {} as Record<string, boolean> }).sections;
        saveUi({ sections: { ...cur, [id]: el.open } });
      });
    this.el = h(
      'details',
      { class: 'sec prospecting', 'data-sec': 'prospecting' },
      h('summary', null, stepTag(3), h('span', { class: 'sec-title' }, 'Owner signals'), this.sum, icon('chevron', 16)),
      h(
        'div',
        { class: 'sec-body' },
        h('p', { class: 'cap pre-cap' }, 'Signs an owner may be ready to talk. Turn on any mix: a parcel must match them all.'),
        presets,
        signals,
      ),
    ) as HTMLDetailsElement;
    this.el.open = stored.prospecting !== false;
    remember(this.el, 'prospecting');

    this.savedSum = h('span', { class: 'sec-sum' });
    this.savedEl = h(
      'details',
      { class: 'sec saved-sec', 'data-sec': 'saved' },
      h('summary', null, h('span', { class: 'sec-title' }, 'Saved screens'), this.savedSum, icon('chevron', 16)),
      h(
        'div',
        { class: 'sec-body' },
        h(
          'p',
          { class: 'cap pre-cap' },
          'A screen is everything you have set: filters, signals, search, the list and the map view.',
          infoTip('saved screens', 'Saved in this browser only for now. Use Copy link to send a screen to someone else: the link reopens it exactly.'),
        ),
        this.list,
        this.form,
        h(
          'div',
          { class: 'saved-actions' },
          h('button', { type: 'button', class: 'btn ghost sm', onclick: () => this.showForm(true) }, icon('save', 14), 'Save this screen'),
          h('button', { type: 'button', class: 'btn ghost sm', onclick: () => this.handlers.copyLink() }, icon('link', 14), 'Copy link'),
        ),
        h('div', { class: 'field-label starters-label' }, 'Or start from an example'),
        h(
          'ul',
          { class: 'saved starters' },
          STARTER_SCREENS.map((sc) =>
            h(
              'li',
              { class: 'saved-item' },
              h(
                'button',
                { type: 'button', class: 'saved-open', title: 'Run this example', onclick: () => this.handlers.starter(sc.id) },
                h('span', { class: 'saved-name' }, sc.label),
              ),
              icon('arrow', 13),
            ),
          ),
        ),
      ),
    ) as HTMLDetailsElement;
    this.savedEl.open = stored.saved !== false;
    remember(this.savedEl, 'saved');
    this.sync(store.get());
    store.subscribe((s, prev) => {
      if (s.filters !== prev.filters) this.sync(s);
    });
    void this.refresh();
  }

  /** Once the signal masks have loaded: how many parcels each signal preset holds. */
  signalsLoaded(): void {
    for (const [id, el] of this.counts) if (isSignalPreset(id)) el.textContent = int(signalPids(presetMask(id)).length);
  }

  private toggle(id: PresetId, on: boolean): void {
    const f = this.store.get().filters;
    const presets = on ? [...new Set([...f.presets, id])] : f.presets.filter((p) => p !== id);
    this.store.set({ filters: { ...f, presets } });
  }

  private sync(s: AppState): void {
    for (const [id, input] of this.toggles) input.checked = s.filters.presets.includes(id);
    const n = s.filters.presets.length;
    this.sum.textContent = n ? `${n} on` : 'None';
    this.sum.classList.toggle('on', n > 0);
    this.savedSum.textContent = this.screens.length ? `${this.screens.length} saved` : '';
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
      this.list.append(h('li', { class: 'saved-empty' }, 'Nothing saved yet.'));
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
