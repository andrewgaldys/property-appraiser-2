import { CLASS_BADGE, CLASS_COLORS, CLASS_FALLBACK, CLASS_SHORT, COUNTY_META } from '../config';
import { appendAll, clear, h, icon, type Child } from '../dom';
import { acres, int, money, moneyFull, parcelId, pct, saleDate, sqft, titleCase } from '../format';
import type { Manifest, ParcelRecord, Portfolio, PortfolioItem, TileProps } from '../types';
import type { AerialCard } from './aerial';
import {
  INFO,
  holdInfo,
  isNominal,
  parentSite,
  physicalFacts,
  portfolioMetrics,
  portfolioSummary,
  saleFacts,
  signals,
  unitsApply,
  valueFacts,
  type Fact,
} from './facts';
import { infoTip } from './infotip';

/** Asset-class badge: the class color carries identity, the label repeats it in text. */
const classBadge = (cls: string) =>
  h('span', { class: 'badge class-badge' }, h('i', { style: { background: CLASS_COLORS[cls] ?? CLASS_FALLBACK } }), CLASS_BADGE[cls] ?? cls);

export interface DrawerHandlers {
  onClose(): void;
  onSelectItem(item: PortfolioItem): void;
  onFitPortfolio(items: PortfolioItem[]): void;
  onToggleFocus(): void;
  onExport(): void;
  onCopyLink(): void;
}

const section = (title: string, ...children: Child[]) => h('section', { class: 'dr-sec' }, h('h3', null, title), ...children);

const label = (f: Fact) => h('dt', null, f.k, f.info ? infoTip(f.k.toLowerCase(), f.info) : null);

const factGrid = (facts: Fact[]) =>
  facts.length
    ? h('dl', { class: 'facts' }, facts.map((f) => h('div', { class: 'fact' }, label(f), h('dd', null, f.v, f.sub ? h('small', null, f.sub) : null))))
    : null;

/** Land vs. improvement split: one whole, two parts, 2px surface gap, figures beside. */
function splitBar(r: ParcelRecord): HTMLElement | null {
  const jv = r.just_value ?? 0;
  if (jv <= 0 || r.land_value == null) return null;
  const land = Math.min(r.land_value, jv);
  const impr = Math.max(jv - land, 0);
  const landPct = land / jv;
  return h(
    'div',
    { class: 'split' },
    h(
      'div',
      { class: 'split-bar', role: 'img', 'aria-label': `Land ${pct(landPct)} of value, buildings ${pct(1 - landPct)}` },
      landPct > 0 ? h('span', { class: 'seg-land', style: { flexGrow: String(landPct) } }) : null,
      landPct < 1 ? h('span', { class: 'seg-impr', style: { flexGrow: String(1 - landPct) } }) : null,
    ),
    h(
      'div',
      { class: 'split-legend' },
      h('span', null, h('i', { class: 'sw land' }), 'Land ', h('b', null, pct(landPct)), ` · ${money(land)}`),
      h('span', null, h('i', { class: 'sw impr' }), 'Buildings ', h('b', null, pct(1 - landPct)), ` · ${money(impr)}`),
    ),
  );
}

export class Drawer {
  readonly el: HTMLElement;
  private scroller: HTMLElement;
  private top: HTMLElement;
  private body: HTMLElement;
  private foot: HTMLElement;

  constructor(
    root: HTMLElement,
    private manifest: Manifest,
    private handlers: DrawerHandlers,
    private aerial: AerialCard,
  ) {
    this.el = root;
    this.top = h('div', { class: 'dr-top' });
    this.body = h('div', { class: 'dr-body' });
    // The aerial card sits between the key facts and the detail sections, and is never rebuilt
    // (its map persists across selections).
    this.scroller = h('div', { class: 'dr-scroll' }, this.top, aerial.el, this.body);
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
    clear(this.top);
    clear(this.body);
    this.foot.hidden = true;
    this.top.append(
      h(
        'header',
        { class: 'dr-head' },
        h('div', { class: 'dr-badges' }, hint ? classBadge(hint.cls) : null),
        h('h2', { class: 'dr-addr' }, hint?.addr || 'Loading parcel…'),
        h('div', { class: 'dr-city skeleton' }, ' '),
      ),
      h('div', { class: 'dr-loading' }, h('span', { class: 'spinner' }), 'Loading the tax-roll record'),
    );
    this.open();
  }

  showError(message: string): void {
    clear(this.top);
    clear(this.body);
    this.foot.hidden = true;
    this.aerial.hide();
    this.top.append(h('p', { class: 'dr-error' }, message));
    this.open();
  }

  /** portfolio: undefined = still resolving, null = no other parcels. */
  render(r: ParcelRecord, portfolio: Portfolio | null | undefined, focus: boolean): void {
    const m = this.manifest;
    const scrollTop = this.scroller.scrollTop;
    clear(this.top);
    clear(this.body);
    this.foot.hidden = false;
    const county = COUNTY_META[r.county_code];
    const nominal = isNominal(r.just_value, m);
    const hold = holdInfo(r, m);
    const sig = signals(r, m);
    this.aerial.show(r.parcel_id, r.bbox);

    // ---- Header + key facts: the decision-relevant read, top to bottom -----------------------
    const useDesc = r.use_description || CLASS_BADGE[r.asset_class] || r.asset_class;
    const units = unitsApply(r.asset_class, r.use_code) && r.residential_units ? r.residential_units : null;
    const keyFacts: { k: string; v: Child; sub?: Child; info?: string; cls?: string }[] = [
      nominal
        ? { k: 'Assessed market value', v: 'Nominal', sub: `${moneyFull(r.just_value)} on the roll`, info: INFO.marketValue, cls: 'nominal' }
        : { k: 'Assessed market value', v: moneyFull(r.just_value), sub: r.tax_roll_year ? `${r.tax_roll_year} roll` : undefined, info: INFO.marketValue },
      { k: 'Building', v: sqft(r.tot_lvg_area) },
      { k: 'Lot', v: acres(r.lnd_sqfoot), sub: r.lnd_sqfoot ? `${int(r.lnd_sqfoot)} SF` : undefined },
      ...(units ? [{ k: 'Residential units', v: int(units), info: INFO.units }] : []),
      r.last_sale_price != null
        ? { k: 'Last sale', v: moneyFull(r.last_sale_price), sub: saleDate(r.last_sale_year, r.last_sale_month) }
        : { k: 'Last sale', v: 'Not on record', cls: 'muted' },
      { k: 'Years held', v: hold.text, sub: hold.minimum ? 'minimum' : undefined, info: hold.caption, cls: `hold hold-${hold.tier}` },
    ];
    const kf = keyFacts.filter((f) => f.v && f.v !== '—');

    appendAll(
      this.top,
      h(
        'header',
        { class: 'dr-head' },
        h('div', { class: 'dr-badges' }, classBadge(r.asset_class), h('span', { class: 'badge' }, county?.badge ?? String(r.county_code))),
        h('h2', { class: 'dr-addr' }, r.site_address || 'No site address'),
        h('div', { class: 'dr-city' }, [titleCase(r.site_city), r.site_zip ? `FL ${r.site_zip}` : 'FL'].filter(Boolean).join(', ')),
        h(
          'div',
          { class: 'dr-use' },
          h('span', null, useDesc),
          r.use_code ? h('span', { class: 'use-code' }, `Use code ${r.use_code}`) : null,
          r.use_code ? infoTip('use code', INFO.useCode) : null,
        ),
      ),
      nominal ? this.nominalNote(r, portfolio) : null,
      h(
        'dl',
        { class: 'key-facts' },
        kf.map((f) =>
          h(
            'div',
            { class: `kf${f.cls ? ` ${f.cls}` : ''}` },
            h('dt', null, f.k, f.info ? infoTip(f.k.toLowerCase(), f.info) : null),
            h('dd', null, h('span', { class: 'kf-v' }, f.v), f.sub ? h('span', { class: 'kf-sub' }, f.sub) : null),
          ),
        ),
        h(
          'div',
          { class: 'kf kf-owner' },
          h('dt', null, 'Owner'),
          h(
            'dd',
            null,
            h(
              'button',
              {
                type: 'button',
                class: `owner-name${focus ? ' on' : ''}`,
                title: 'Highlight every parcel with this owner name or mailing address',
                'aria-pressed': String(focus),
                onclick: () => this.handlers.onToggleFocus(),
              },
              r.owner_name || 'Owner not reported',
            ),
            portfolio ? h('span', { class: 'kf-sub' }, `Portfolio of ${portfolio.exact ? '' : '≥ '}${int(portfolio.total)} parcels (below)`) : null,
          ),
        ),
      ),
      sig.length ? h('ul', { class: 'signals', 'aria-label': 'Screening flags' }, sig.map((s) => h('li', null, s))) : null,
    );

    // ---- Detail sections ------------------------------------------------------------------------
    const valueSection = nominal ? null : section('Value', splitBar(r), factGrid(valueFacts(r, m)));
    const building = physicalFacts(r);
    const sales = saleFacts(r, m);
    const coverage = m.sales_coverage?.[String(r.county_code)];

    this.body.append(
      ...[
        valueSection,
        building.length ? section('Building & lot', factGrid(building)) : null,
        section(
          'Sale & hold',
          h('p', { class: 'cap hold-cap' }, hold.caption),
          factGrid(sales),
          coverage?.from
            ? h('p', { class: 'cap' }, `${county?.name ?? 'County'} sale records are complete from ${coverage.from}.`)
            : null,
        ),
        this.ownerSection(r, portfolio, focus),
        this.moreDetails(r),
      ].filter((x): x is HTMLElement => !!x),
    );
    this.scroller.scrollTop = scrollTop;
    this.open();
  }

  /** The nominal-value callout, with the valued parcel it most likely belongs to. */
  private nominalNote(r: ParcelRecord, portfolio: Portfolio | null | undefined): HTMLElement {
    const parent = parentSite(r, portfolio, this.manifest);
    return h(
      'div',
      { class: 'notice', role: 'note' },
      icon('warn', 16),
      h(
        'div',
        null,
        h('p', { class: 'notice-title' }, 'Nominal assessed value'),
        h(
          'p',
          null,
          `Assessed at ${moneyFull(r.just_value)}: likely a common-area, condo-style or sub-parcel whose value sits on another parcel. Value figures are hidden, and screens and totals leave it out by default.`,
        ),
        portfolio === undefined
          ? h('p', { class: 'notice-sub' }, 'Looking for its main site…')
          : parent
            ? h(
                'button',
                { type: 'button', class: 'parent-link', onclick: () => this.handlers.onSelectItem(parent.item) },
                h('span', null, 'Likely part of ', h('b', null, parent.item.site_address || 'a parcel'), ` · ${money(parent.item.just_value)}`),
                h('span', { class: 'notice-sub' }, `Same owner, ${Math.round(parent.metres)} m away`),
                icon('arrow', 14),
              )
            : null,
      ),
    );
  }

  private ownerSection(r: ParcelRecord, portfolio: Portfolio | null | undefined, focus: boolean): HTMLElement {
    const block: Child[] = [
      h('div', { class: 'owner-line' }, h('span', { class: 'owner-name-static' }, r.owner_name || 'Owner not reported')),
      h('div', { class: 'owner-addr' }, r.owner_addr || 'No mailing address on record'),
    ];
    if (portfolio === undefined) {
      block.push(h('div', { class: 'dr-loading sm' }, h('span', { class: 'spinner' }), 'Finding other parcels with this owner'));
    } else if (portfolio === null) {
      block.push(h('p', { class: 'cap' }, 'No other parcel in the three counties shares this owner name or mailing address.'));
    } else {
      block.push(this.portfolioBlock(r, portfolio, focus));
    }
    const title = h(
      'h3',
      null,
      'Owner & portfolio',
      infoTip(
        'owner and portfolio',
        'Other parcels in Martin, St. Lucie and Palm Beach with the same owner name or the same normalized mailing address. Shared addresses can belong to a manager or registered agent rather than one owner.',
      ),
    );
    return h('section', { class: 'dr-sec' }, title, ...block);
  }

  private portfolioBlock(r: ParcelRecord, p: Portfolio, focus: boolean): HTMLElement {
    const m = this.manifest;
    const chips: Child[] = [];
    if (p.byName) chips.push(h('span', { class: 'rchip' }, 'Same name ', h('b', null, int(p.byName.count))));
    if (p.byAddr) chips.push(h('span', { class: 'rchip' }, 'Same mailing address ', h('b', null, int(p.byAddr.count))));
    if (p.byAddr && (p.byAddr.names ?? 0) > 1) chips.push(h('span', { class: 'rchip' }, h('b', null, int(p.byAddr.names ?? 0)), ' owner names at this address'));
    const agent = p.byAddr?.agent
      ? h('p', { class: 'warn' }, 'Many unrelated-looking owners share this mailing address. It may be a manager or registered agent rather than one beneficial owner.')
      : null;
    const counties = Object.entries(p.counties)
      .sort((a, b) => b[1] - a[1])
      .map(([co, n]) => `${COUNTY_META[Number(co)]?.name ?? co} ${n}`)
      .join(' · ');
    const metrics = portfolioMetrics(p);
    const list = h(
      'ol',
      { class: 'pf-list' },
      p.items.map((it) => {
        const current = it.parcel_id === r.parcel_id;
        const otherName = it.owner_name && it.owner_name !== r.owner_name;
        const nominal = isNominal(it.just_value, m);
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
            h('i', { class: 'pf-sw', style: { background: CLASS_COLORS[it.asset_class] ?? CLASS_FALLBACK } }),
            h(
              'span',
              { class: 'pf-main' },
              h('span', { class: 'pf-addr' }, it.site_address || 'No site address'),
              h(
                'span',
                { class: 'pf-sub' },
                [titleCase(it.site_city), CLASS_SHORT[it.asset_class] ?? it.asset_class, otherName ? it.owner_name : null].filter(Boolean).join(' · '),
              ),
            ),
            nominal ? h('span', { class: 'pf-val nominal' }, 'Nominal') : h('span', { class: 'pf-val' }, money(it.just_value)),
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
        h('div', { class: 'pf-sum-main' }, portfolioSummary(p)),
        h('div', { class: 'pf-sum-sub' }, [counties, metrics].filter(Boolean).join(' · ')),
        (p.byName?.nominal ?? 0) + (p.byAddr?.nominal ?? 0) > 0
          ? h('div', { class: 'pf-sum-sub' }, 'Includes nominal-value parcels (shown as “Nominal”).')
          : null,
      ),
      h(
        'div',
        { class: 'pf-actions' },
        h('button', { type: 'button', class: 'btn ghost sm', onclick: () => this.handlers.onFitPortfolio(p.items) }, icon('fit', 14), 'Fit all on map'),
        h(
          'button',
          { type: 'button', class: `btn ghost sm${focus ? ' on' : ''}`, 'aria-pressed': String(focus), onclick: () => this.handlers.onToggleFocus() },
          icon('focus', 14),
          focus ? 'Highlighted on map' : 'Highlight on map',
        ),
      ),
      list,
      p.exact ? null : h('p', { class: 'cap' }, `Showing the ${int(p.items.length)} highest-value parcels.`),
    );
  }

  /** Secondary fields, folded away: identifiers, legal text, sources. Empty ones are left out. */
  private moreDetails(r: ParcelRecord): HTMLElement {
    const rows: [string, Child][] = [
      [
        'Parcel ID',
        h(
          'span',
          { class: 'pid' },
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
      ],
      ['Land use', r.use_code ? `${r.use_description} (DOR ${r.use_code})` : r.use_description],
      ['Land value', r.land_value != null ? moneyFull(r.land_value) : ''],
      ['Building value', r.building_value != null ? moneyFull(r.building_value) : ''],
      ['Owner mailing address', r.owner_addr],
      ['Legal description', r.legal_desc],
      ['Tax roll', r.tax_roll_year ? `${r.tax_roll_year} · ${this.manifest.source.label}` : this.manifest.source.label],
    ];
    return h(
      'details',
      { class: 'dr-sec more' },
      h('summary', null, h('span', null, 'More details'), icon('chevron', 16)),
      h(
        'dl',
        { class: 'more-list' },
        rows.filter(([, v]) => v !== '' && v != null).map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v))),
      ),
    );
  }
}
