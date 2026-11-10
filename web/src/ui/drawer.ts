import { CLASS_BADGE, CLASS_COLORS, CLASS_FALLBACK, CLASS_SHORT, COUNTY_META } from '../config';
import { clear, h, icon, type Child } from '../dom';
import { int, money, moneyFull, parcelId, pct, saleDate, titleCase } from '../format';
import type { Manifest, ParcelRecord, Portfolio, PortfolioItem, TileProps } from '../types';
import type { AerialCard } from './aerial';
import { holdCaption, holdTier, physicalFacts, portfolioSummary, saleFacts, signals, type Fact } from './facts';

/** Asset-class badge: the class color carries identity, the label repeats it in text. */
const classBadge = (cls: string) =>
  h(
    'span',
    { class: 'badge class-badge' },
    h('i', { style: { background: CLASS_COLORS[cls] ?? CLASS_FALLBACK } }),
    CLASS_BADGE[cls] ?? cls,
  );

export interface DrawerHandlers {
  onClose(): void;
  onSelectItem(item: PortfolioItem): void;
  onFitPortfolio(items: PortfolioItem[]): void;
  onToggleFocus(): void;
  onExport(): void;
  onCopyLink(): void;
}

const section = (title: string, ...children: Child[]) =>
  h('section', { class: 'dr-sec' }, h('h3', null, title), ...children);

const factGrid = (facts: Fact[]) =>
  h(
    'dl',
    { class: 'facts' },
    facts.map((f) =>
      h('div', { class: 'fact' }, h('dt', null, f.k), h('dd', null, f.v, f.sub ? h('small', null, f.sub) : null)),
    ),
  );

/** Land vs. improvement split: one whole, two parts, 2px surface gap, figures beside. */
function splitBar(r: ParcelRecord): HTMLElement {
  const jv = r.just_value ?? 0;
  const land = Math.min(r.land_value ?? 0, jv);
  const impr = Math.max(jv - land, 0);
  const landPct = jv > 0 ? land / jv : 0;
  return h(
    'div',
    { class: 'split' },
    h(
      'div',
      {
        class: 'split-bar',
        role: 'img',
        'aria-label': `Land ${pct(landPct)} of just value, improvements ${pct(1 - landPct)}`,
      },
      landPct > 0 ? h('span', { class: 'seg-land', style: { flexGrow: String(landPct) } }) : null,
      landPct < 1 ? h('span', { class: 'seg-impr', style: { flexGrow: String(1 - landPct) } }) : null,
    ),
    h(
      'div',
      { class: 'split-legend' },
      h('span', null, h('i', { class: 'sw land' }), 'Land ', h('b', null, pct(landPct)), ` · ${money(land)}`),
      h('span', null, h('i', { class: 'sw impr' }), 'Improvements ', h('b', null, pct(jv > 0 ? 1 - landPct : 0)), ` · ${money(impr)}`),
    ),
  );
}

export class Drawer {
  readonly el: HTMLElement;
  private scroller: HTMLElement;
  private body: HTMLElement;
  private foot: HTMLElement;

  constructor(
    root: HTMLElement,
    private manifest: Manifest,
    private handlers: DrawerHandlers,
    private aerial: AerialCard,
  ) {
    this.el = root;
    this.body = h('div', { class: 'dr-body' });
    // The aerial card sits at the very top and is not rebuilt on each render (its map persists).
    this.scroller = h('div', { class: 'dr-scroll' }, aerial.el, this.body);
    this.foot = h(
      'footer',
      { class: 'dr-foot' },
      h('button', { type: 'button', class: 'btn solid', onclick: () => this.handlers.onExport() }, icon('print'), 'Export property brief'),
      h('button', { type: 'button', class: 'btn ghost', title: 'Copy a link to this parcel', onclick: () => this.handlers.onCopyLink() }, icon('link'), 'Copy link'),
    );
    const close = h(
      'button',
      { type: 'button', class: 'icon-btn dr-close', 'aria-label': 'Close property panel', onclick: () => this.handlers.onClose() },
      icon('close', 16),
    );
    root.append(close, this.scroller, this.foot);
  }

  get isOpen(): boolean {
    return this.el.classList.contains('open');
  }

  open(): void {
    this.el.classList.add('open');
    this.el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
  }

  close(): void {
    this.el.classList.remove('open');
    this.el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
  }

  showLoading(hint?: TileProps): void {
    clear(this.body);
    this.foot.hidden = true;
    this.body.append(
      h(
        'header',
        { class: 'dr-head' },
        h(
          'div',
          { class: 'dr-badges' },
          hint ? h('span', { class: 'badge' }, COUNTY_META[hint.co]?.badge ?? String(hint.co)) : null,
          hint ? classBadge(hint.cls) : null,
        ),
        h('h2', { class: 'dr-addr' }, hint?.addr || 'Loading parcel…'),
        h('div', { class: 'dr-city skeleton' }, ' '),
      ),
      h('div', { class: 'dr-loading' }, h('span', { class: 'spinner' }), 'Loading tax-roll record'),
    );
    this.open();
  }

  showError(message: string): void {
    clear(this.body);
    this.foot.hidden = true;
    this.aerial.hide();
    this.body.append(h('p', { class: 'dr-error' }, message));
    this.open();
  }

  /** portfolio: undefined = still resolving, null = no other parcels. */
  render(r: ParcelRecord, portfolio: Portfolio | null | undefined, focus: boolean): void {
    const scrollTop = this.scroller.scrollTop;
    clear(this.body);
    this.foot.hidden = false;
    const county = COUNTY_META[r.county_code];
    const sig = signals(r);
    const tier = holdTier(r.hold_period_years);
    this.aerial.show(r.parcel_id, r.bbox);

    // ---- Header ------------------------------------------------------------
    this.body.append(
      h(
        'header',
        { class: 'dr-head' },
        h(
          'div',
          { class: 'dr-badges' },
          h('span', { class: 'badge' }, county?.badge ?? String(r.county_code)),
          classBadge(r.asset_class),
        ),
        h('h2', { class: 'dr-addr' }, r.site_address || 'No site address'),
        h('div', { class: 'dr-city' }, [titleCase(r.site_city), r.site_zip ? `FL ${r.site_zip}` : 'FL'].filter(Boolean).join(', ')),
        h(
          'div',
          { class: 'dr-pid' },
          h('span', { class: 'k' }, 'Parcel ID'),
          h('span', { class: 'mono' }, parcelId(r.parcel_id, r.county_code)),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn sm',
              title: 'Copy parcel ID',
              'aria-label': 'Copy parcel ID',
              onclick: () => void navigator.clipboard?.writeText(r.parcel_id).catch(() => undefined),
            },
            icon('copy', 13),
          ),
        ),
        h('div', { class: 'dr-use' }, `DOR ${r.use_code ?? '—'} · ${r.use_description}`),
        sig.length ? h('ul', { class: 'signals', 'aria-label': 'Screening flags' }, sig.map((s) => h('li', null, s))) : null,
      ),
    );

    // ---- Valuation & physicals ------------------------------------------------
    this.body.append(
      section(
        'Valuation & physicals',
        h(
          'div',
          { class: 'jv' },
          h('div', { class: 'k' }, 'Just (market) value', r.tax_roll_year ? ` · ${r.tax_roll_year} roll` : ''),
          h('div', { class: 'jv-v mono' }, moneyFull(r.just_value)),
          r.assessed_value != null
            ? h('div', { class: 'av' }, h('span', { class: 'k' }, 'Assessed (non-school)'), h('span', { class: 'mono' }, moneyFull(r.assessed_value)))
            : null,
        ),
        splitBar(r),
        factGrid(physicalFacts(r)),
      ),
    );

    // ---- Last sale & hold ---------------------------------------------------------
    this.body.append(
      section(
        'Last sale & hold signal',
        h(
          'div',
          { class: 'sale' },
          h(
            'div',
            { class: 'sale-main' },
            h('div', { class: 'k' }, 'Last sale price'),
            h('div', { class: 'sale-v mono' }, moneyFull(r.last_sale_price)),
            h('div', { class: 'k sale-date' }, 'Sale date ', h('b', { class: 'mono' }, saleDate(r.last_sale_year, r.last_sale_month))),
          ),
          h(
            'div',
            { class: `hold hold-${tier}`, title: holdCaption(r) },
            h('div', { class: 'hold-n mono' }, r.hold_period_years ?? '—'),
            h('div', { class: 'hold-u' }, 'yr hold'),
          ),
        ),
        h('p', { class: 'cap' }, holdCaption(r), r.hold_period_years != null ? ` · hold = ${this.manifest.source.as_of_year} − ${r.last_sale_year}` : ''),
        factGrid(saleFacts(r)),
      ),
    );

    // ---- True owner & portfolio --------------------------------------------------
    const ownerBlock: Child[] = [
      h(
        'button',
        {
          type: 'button',
          class: `owner-name${focus ? ' on' : ''}`,
          title: 'Highlight every parcel sharing this owner name or mailing address',
          onclick: () => this.handlers.onToggleFocus(),
        },
        r.owner_name || 'Owner not reported',
        icon('focus', 13),
      ),
      h('div', { class: 'owner-addr' }, r.owner_addr || 'No mailing address on record'),
    ];
    if (portfolio === undefined) {
      ownerBlock.push(h('div', { class: 'dr-loading sm' }, h('span', { class: 'spinner' }), 'Resolving portfolio across 3 counties'));
    } else if (portfolio === null) {
      ownerBlock.push(
        h('p', { class: 'cap pf-none' }, 'No other parcel in Martin, St. Lucie or Palm Beach shares this owner name or normalized mailing address.'),
      );
    } else {
      ownerBlock.push(this.portfolioBlock(r, portfolio, focus));
    }
    this.body.append(section('True owner & portfolio resolver', ...ownerBlock));
    this.scroller.scrollTop = scrollTop;
    this.open();
  }

  private portfolioBlock(r: ParcelRecord, p: Portfolio, focus: boolean): HTMLElement {
    const chips: Child[] = [];
    if (p.byName) chips.push(h('span', { class: 'rchip' }, 'Name match ', h('b', null, int(p.byName.count))));
    if (p.byAddr) chips.push(h('span', { class: 'rchip' }, 'Mailing-address match ', h('b', null, int(p.byAddr.count))));
    if (p.byAddr && (p.byAddr.names ?? 0) > 1)
      chips.push(h('span', { class: 'rchip' }, h('b', null, int(p.byAddr.names ?? 0)), ' entity names at this address'));
    const agent = p.byAddr?.agent
      ? h('p', { class: 'warn' }, 'This mailing address is shared by many unrelated-looking owner names. It may belong to a manager or registered agent rather than one beneficial owner.')
      : null;
    const counties = Object.entries(p.counties)
      .sort((a, b) => b[1] - a[1])
      .map(([co, n]) => `${COUNTY_META[Number(co)]?.short ?? co} ${n}`)
      .join(' · ');
    const list = h(
      'ol',
      { class: 'pf-list' },
      p.items.map((it) => {
        const current = it.parcel_id === r.parcel_id;
        const otherName = it.owner_name && it.owner_name !== r.owner_name;
        return h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              class: `pf-item${current ? ' current' : ''}`,
              'aria-current': current ? 'true' : null,
              title: current ? 'Selected parcel' : 'Fly to this parcel',
              onclick: () => this.handlers.onSelectItem(it),
            },
            h(
              'span',
              { class: 'pf-co', style: { borderLeftColor: CLASS_COLORS[it.asset_class] ?? CLASS_FALLBACK } },
              COUNTY_META[it.county_code]?.short ?? it.county_code,
            ),
            h(
              'span',
              { class: 'pf-main' },
              h('span', { class: 'pf-addr' }, it.site_address || 'No site address'),
              h(
                'span',
                { class: 'pf-sub' },
                [titleCase(it.site_city), CLASS_SHORT[it.asset_class] ?? it.asset_class, otherName ? it.owner_name : null]
                  .filter(Boolean)
                  .join(' · '),
              ),
            ),
            h('span', { class: 'pf-val mono' }, money(it.just_value)),
            h('span', { class: `pf-match m-${it.match}` }, it.match === 'both' ? 'Name+Addr' : it.match === 'name' ? 'Name' : 'Addr'),
          ),
        );
      }),
    );
    return h(
      'div',
      { class: 'pf' },
      h('div', { class: 'rchips' }, chips),
      agent,
      h(
        'div',
        { class: 'pf-sum' },
        h('div', { class: 'pf-sum-main mono' }, portfolioSummary(p)),
        h('div', { class: 'pf-sum-sub' }, counties, p.units ? ` · ${int(p.units)} units` : '', p.sf ? ` · ${int(p.sf)} bldg SF` : ''),
      ),
      h(
        'div',
        { class: 'pf-actions' },
        h('button', { type: 'button', class: 'btn ghost sm', onclick: () => this.handlers.onFitPortfolio(p.items) }, icon('fit', 13), 'Fit all on map'),
        h(
          'button',
          { type: 'button', class: `btn ghost sm${focus ? ' on' : ''}`, 'aria-pressed': String(focus), onclick: () => this.handlers.onToggleFocus() },
          icon('focus', 13),
          focus ? 'Spotlight on' : 'Spotlight portfolio',
        ),
      ),
      list,
      p.exact ? null : h('p', { class: 'cap' }, `Showing the ${int(p.items.length)} highest-value parcels.`),
    );
  }
}
