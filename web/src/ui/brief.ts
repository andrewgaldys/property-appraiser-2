import { APP_NAME, APP_VERSION, CLASS_BADGE, CLASS_SHORT, COUNTY_META } from '../config';
import { clear, h, icon } from '../dom';
import { acres, int, money, moneyFull, parcelId, pct, saleDate, shortDate, sqft, titleCase } from '../format';
import type { Manifest, ParcelRecord, Portfolio } from '../types';
import {
  holdInfo,
  isNominal,
  physicalFacts,
  portfolioMetrics,
  portfolioSummary,
  present,
  saleFacts,
  signals,
  unitsApply,
  valueFacts,
  type Fact,
} from './facts';

const rows = (facts: Fact[]) =>
  h('table', { class: 'bp-table' }, h('tbody', null, facts.map((f) => h('tr', null, h('th', null, f.k), h('td', null, f.v, f.sub ? h('small', null, ` (${f.sub})`) : null)))));

/** One-page, print-styled property brief (Letter). Print / Save as PDF via the browser. */
export class Brief {
  private root: HTMLElement;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.close();
  };

  constructor() {
    this.root = document.getElementById('brief-root') ?? document.body.appendChild(h('div', { id: 'brief-root' }));
    this.root.hidden = true;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(r: ParcelRecord, portfolio: Portfolio | null, image: string | null, manifest: Manifest, aerial: string | null = null): void {
    clear(this.root);
    const county = COUNTY_META[r.county_code];
    const jv = r.just_value ?? 0;
    const landShare = jv > 0 ? Math.min((r.land_value ?? 0) / jv, 1) : 0;
    const today = shortDate(new Date().toISOString());
    const sample = manifest.source.kind === 'sample';
    const flags = signals(r, manifest);
    const hold = holdInfo(r, manifest);
    const nominal = isNominal(r.just_value, manifest);
    const units = unitsApply(r.asset_class, r.use_code) ? r.residential_units : null;
    const pfItems = portfolio ? portfolio.items.slice(0, 10) : [];

    const printBtn = h('button', { type: 'button', class: 'btn solid', onclick: () => window.print() }, icon('print'), 'Print / Save as PDF');
    const toolbar = h(
      'div',
      { class: 'brief-toolbar' },
      h('span', { class: 'brief-title' }, 'Property brief · print preview'),
      printBtn,
      h('button', { type: 'button', class: 'btn ghost', onclick: () => this.close() }, icon('close'), 'Close'),
    );

    const page = h(
      'article',
      { class: 'brief-page', 'aria-label': `Property brief for ${r.site_address}` },
      h('header', { class: 'bp-band' }, h('span', null, 'Property Brief'), h('span', null, `${APP_NAME} ${APP_VERSION} · ${today}`)),
      h(
        'section',
        { class: 'bp-title' },
        h('div', { class: 'bp-badges' }, h('span', null, county?.badge ?? String(r.county_code)), h('span', null, CLASS_BADGE[r.asset_class] ?? r.asset_class)),
        h('h1', null, r.site_address || 'No site address'),
        h(
          'div',
          { class: 'bp-sub' },
          `${titleCase(r.site_city)}, FL ${r.site_zip} · Parcel ${parcelId(r.parcel_id, r.county_code)} · ${r.use_description}${r.use_code ? ` · DOR ${r.use_code}` : ''}`,
        ),
        r.legal_desc ? h('div', { class: 'bp-legal' }, `Legal: ${r.legal_desc}`) : null,
      ),
      h(
        'section',
        { class: 'bp-hero' },
        h(
          'figure',
          { class: 'bp-map' },
          image ? h('img', { src: image, alt: `3D map view of ${r.site_address}` }) : h('div', { class: 'bp-noimg' }, 'Map snapshot unavailable'),
          h('figcaption', null, '3D view, selected parcel in white. Basemap © OpenFreeMap, OpenMapTiles, OpenStreetMap contributors.'),
        ),
        h(
          'figure',
          { class: 'bp-map' },
          aerial ? h('img', { src: aerial, alt: `Aerial view of ${r.site_address}` }) : h('div', { class: 'bp-noimg' }, 'Aerial unavailable'),
          h('figcaption', null, 'Aerial, parcel boundary in white. Imagery © Esri, Maxar, Earthstar Geographics.'),
        ),
      ),
      h(
        'section',
        { class: 'bp-keys' },
        h(
          'div',
          { class: 'bp-key' },
          h('span', null, 'Assessed market value'),
          h('b', null, nominal ? 'Nominal' : moneyFull(r.just_value)),
          nominal ? h('small', null, `${moneyFull(r.just_value)} on the roll: likely a common-area or sub-parcel`) : null,
        ),
        h('div', { class: 'bp-key' }, h('span', null, 'Land / buildings'), h('b', null, nominal ? '—' : `${pct(landShare)} / ${pct(jv > 0 ? 1 - landShare : 0)}`)),
        h('div', { class: 'bp-key' }, h('span', null, 'Last sale'), h('b', null, moneyFull(r.last_sale_price)), h('small', null, saleDate(r.last_sale_year, r.last_sale_month))),
        h('div', { class: 'bp-key' }, h('span', null, 'Years held'), h('b', null, hold.text), h('small', null, hold.caption)),
      ),
      h(
        'section',
        { class: 'bp-cols' },
        h(
          'div',
          null,
          h('h2', null, 'Value, building & lot'),
          rows(
            present([
              { k: 'Assessed market value', v: moneyFull(r.just_value) },
              { k: 'Land value', v: moneyFull(r.land_value) },
              { k: 'Building value', v: moneyFull(r.building_value) },
              ...valueFacts(r, manifest),
              { k: 'Building', v: sqft(r.tot_lvg_area) },
              { k: 'Lot', v: acres(r.lnd_sqfoot), sub: r.lnd_sqfoot ? `${int(r.lnd_sqfoot)} SF` : undefined },
              ...(units ? [{ k: 'Residential units', v: int(units) }] : []),
              ...physicalFacts(r),
            ]),
          ),
        ),
        h(
          'div',
          null,
          h('h2', null, 'Last sale & hold'),
          rows(
            present([
              { k: 'Last sale price', v: moneyFull(r.last_sale_price) },
              { k: 'Sale date', v: saleDate(r.last_sale_year, r.last_sale_month) },
              { k: 'Years held', v: hold.text },
              ...saleFacts(r, manifest),
            ]),
          ),
          h('h2', null, 'Screening flags'),
          flags.length ? h('ul', { class: 'bp-flags' }, flags.map((f) => h('li', null, f))) : h('p', { class: 'bp-muted' }, 'None'),
        ),
      ),
      h(
        'section',
        { class: 'bp-owner' },
        h('h2', null, 'True owner & portfolio'),
        h('div', { class: 'bp-ownerline' }, h('b', null, r.owner_name || 'Owner not reported'), h('span', null, r.owner_addr)),
        portfolio
          ? h(
              'p',
              { class: 'bp-muted' },
              `${portfolioSummary(portfolio)}${portfolioMetrics(portfolio) ? ` · ${portfolioMetrics(portfolio)}` : ''}. Matched on `,
              [portfolio.byName ? `owner name (${int(portfolio.byName.count)})` : null, portfolio.byAddr ? `normalized mailing address (${int(portfolio.byAddr.count)})` : null]
                .filter(Boolean)
                .join(' and '),
              '.',
            )
          : h('p', { class: 'bp-muted' }, 'No other parcel in the three-county dataset shares this owner name or mailing address.'),
        pfItems.length
          ? h(
              'table',
              { class: 'bp-pf' },
              h('thead', null, h('tr', null, ['County', 'Site address', 'City', 'Class', 'Owner of record', 'Assessed value', 'Match'].map((c) => h('th', null, c)))),
              h(
                'tbody',
                null,
                pfItems.map((it) =>
                  h(
                    'tr',
                    { class: it.parcel_id === r.parcel_id ? 'me' : null },
                    h('td', null, COUNTY_META[it.county_code]?.short ?? it.county_code),
                    h('td', null, it.site_address),
                    h('td', null, titleCase(it.site_city)),
                    h('td', null, CLASS_SHORT[it.asset_class] ?? it.asset_class),
                    h('td', null, it.owner_name),
                    h('td', { class: 'num' }, isNominal(it.just_value, manifest) ? 'Nominal' : money(it.just_value)),
                    h('td', null, it.match === 'both' ? 'Name+Addr' : it.match === 'name' ? 'Name' : 'Addr'),
                  ),
                ),
              ),
            )
          : null,
        portfolio && portfolio.items.length > pfItems.length
          ? h('p', { class: 'bp-muted' }, `+ ${int(portfolio.total - pfItems.length)} more parcels in this portfolio.`)
          : null,
      ),
      h(
        'footer',
        { class: 'bp-foot' },
        `Source: ${manifest.source.label}${manifest.source.tax_roll_year && !manifest.source.label.includes(String(manifest.source.tax_roll_year)) ? ` (${manifest.source.tax_roll_year} roll)` : ''}. `,
        'Assessed market value is the property appraiser’s just value on the FDOR tax roll, not an appraisal. ',
        `Years held = ${manifest.source.as_of_year} − year of the last sale of ${money(manifest.data_quality?.min_sale_price ?? 100)} or more; "N+" marks a minimum where the sale predates the county’s complete records. `,
        'Owner portfolios are resolved by normalized owner name and mailing address and may include unrelated entities that share an agent address. ',
        sample ? 'SAMPLE DATA: all parcels, owners and values are synthetic. ' : '',
      ),
    );

    this.root.append(toolbar, page);
    this.root.hidden = false;
    document.body.classList.add('brief-open');
    document.addEventListener('keydown', this.onKey);
    printBtn.focus();
  }

  close(): void {
    this.root.hidden = true;
    clear(this.root);
    document.body.classList.remove('brief-open');
    document.removeEventListener('keydown', this.onKey);
  }
}
