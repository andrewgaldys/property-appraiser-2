import { COUNTY_META } from '../config';
import { debtNote } from '../debt';
import { extLink, h, icon } from '../dom';
import { int, money, shortDate } from '../format';
import type { Manifest, SalesCoverage } from '../types';
import { area, countyCodes } from './facts';

/** One county's sale-record depth in plain words. */
function salesText(k: SalesCoverage | undefined, m: Manifest): string {
  const window = `${m.source.as_of_year - 1}–${String(m.source.as_of_year).slice(2)}`;
  if (!k) return `${window} sales only`;
  const since = k.from ? `, complete from ${k.from}` : '';
  switch (k.depth) {
    case 'all':
      return `Every recorded transfer${since}`;
    case 'recent5':
      return `Each parcel’s five most recent transfers${since}`;
    case 'latest':
      return 'Each parcel’s latest transfer only';
    default:
      return `${window} sales only`;
  }
}

const step = (n: number, title: string, text: string) =>
  h('li', null, h('span', { class: 'help-n', 'aria-hidden': 'true' }, String(n).padStart(2, '0')), h('div', null, h('b', null, title), h('p', null, text)));

/**
 * "How it works": the three-step workflow, how to read the map, and what the data covers county by
 * county (parcels, value, how far back sale records go, and where each comes from).
 */
export class HelpDialog {
  private dlg: HTMLDialogElement;
  private coverage: HTMLElement;

  constructor(m: Manifest) {
    const where = area(m);
    const cov = m.sales_coverage ?? {};
    const rows = countyCodes(m).map((code) => {
      const c = m.counties.find((x) => x.code === code);
      return h(
        'tr',
        null,
        h('th', { scope: 'row' }, COUNTY_META[code]?.name ?? String(code)),
        h('td', { class: 'num' }, int(c?.count ?? 0)),
        h('td', { class: 'num' }, money(c?.jv ?? 0)),
        h('td', null, salesText(cov[String(code)], m)),
      );
    });
    this.coverage = h(
      'section',
      { class: 'help-sec' },
      h('h3', null, 'Data and coverage'),
      h(
        'div',
        { class: 'help-table' },
        h(
          'table',
          null,
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'County'), h('th', { scope: 'col', class: 'num' }, 'Parcels'), h('th', { scope: 'col', class: 'num' }, 'Assessed value'), h('th', { scope: 'col' }, 'Sale records'))),
          h('tbody', null, rows),
          h(
            'tfoot',
            null,
            h('tr', null, h('th', { scope: 'row' }, 'Total'), h('td', { class: 'num' }, int(m.stats.parcels)), h('td', { class: 'num' }, money(m.stats.just_value)), h('td', null, '')),
          ),
        ),
      ),
      h(
        'ul',
        { class: 'help-notes' },
        h('li', null, h('b', null, 'What is included: '), 'multifamily, commercial, industrial, vacant commercial and institutional parcels. Single-family homes and individual condo units are not.'),
        h('li', null, h('b', null, 'Parcels, owners and values: '), `${m.source.label} (the Florida Department of Revenue tax roll joined to county parcel maps). “Assessed market value” is the county’s just value, not an appraisal or an asking price.`),
        h('li', null, h('b', null, 'Years held: '), 'counted from the last sale of $100 or more in the county’s records. Where a county lists only the latest transfer and that one was nominal, the hold shows as a minimum, like “12+ yrs”. No sale on record shows as “Not on record”, never as zero.'),
        m.entities
          ? h(
              'li',
              null,
              h('b', null, 'State business records: '),
              `status, filings, officers, managers and registered agents come from the Florida Division of Corporations’ free quarterly data files (as of ${shortDate(m.entities.file_date)}), matched to owners by name and, where it agrees, mailing address. ${int(m.entities.counts.parcels)} parcels are matched. Each match says how sure it is: check a possible match on Sunbiz before relying on it. Owners are linked when their records share an officer, manager or registered agent; commercial agent services and people who act as agent for many unrelated owners are left out.`,
            )
          : null,
        m.signals
          ? h(
              'li',
              null,
              h('b', null, 'Deal signals: '),
              'state business records (dissolved or lapsed owner companies), the tax roll (assessed far below market value), county sale records (fund exit window, lender or estate transfers, quick resales), FEMA flood maps (flood and coastal zones, older buildings in them), the Census coastline, and county tax certificate lists. Each chip on a parcel shows its source, the record date and how sure it is. ',
              Object.entries(m.signals.sources)
                .map(([, src]) => `${src.label}${src.as_of ? ` (${src.as_of})` : ''}`)
                .join('; ') + '.',
            )
          : null,
        m.debt ? h('li', null, h('b', null, m.debt.sources.sec ? 'Debt & liens: ' : 'Liens: '), debtNote(m)) : null,
        h('li', null, h('b', null, 'Owner lookups: '), 'the Sunbiz buttons open the Florida Division of Corporations’ own search. The app never queries it.'),
        h('li', null, h('b', null, 'Updated: '), `${shortDate(m.generated_at)}. Public records can lag or contain errors: confirm with the county before you rely on a figure.`),
      ),
    );

    this.dlg = h(
      'dialog',
      { class: 'help', 'aria-labelledby': 'help-title' },
      h(
        'header',
        { class: 'help-head' },
        h('div', null, h('p', { class: 'eyebrow' }, where.n > 1 ? `${where.span} · ${where.n} counties` : where.names), h('h2', { id: 'help-title' }, 'How it works')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => this.dlg.close() }, icon('close', 16)),
      ),
      h(
        'div',
        { class: 'help-body' },
        h(
          'section',
          { class: 'help-sec' },
          h(
            'ol',
            { class: 'help-steps' },
            step(1, 'Pick where and what', 'Open Filters and choose counties and asset classes. The map updates as you go.'),
            step(2, 'Turn on owner signals', 'Long-term holders, out-of-area owners, estates and trusts, small portfolios, underbuilt sites. Mix them: a parcel has to match them all.'),
            step(3, 'Work the owners list', 'Open the Owners list, sort it, open an owner to see everything they hold, look them up on Sunbiz, and export a call or mail list.'),
          ),
        ),
        h(
          'section',
          { class: 'help-sec' },
          h('h3', null, 'Reading the map'),
          h(
            'ul',
            { class: 'help-notes' },
            h('li', null, 'Each block is one parcel. ', h('b', null, 'Height'), ' is its assessed market value and ', h('b', null, 'color'), ' is its asset class. Change either, the basemap, or see the legend under Map.'),
            h('li', null, h('b', null, 'Click a parcel'), ' for its record: value, size, last sale, years held, the owner and everything else they own.'),
            h('li', null, 'Scroll to zoom. Drag with the right mouse button, or with two fingers, to tilt and turn.'),
            h('li', null, 'Shortcuts: ', h('kbd', null, '/'), ' search, ', h('kbd', null, 'S'), ' satellite lens, ', h('kbd', null, '?'), ' this guide, ', h('kbd', null, 'Esc'), ' close a panel.'),
          ),
        ),
        this.coverage,
        h(
          'p',
          { class: 'help-foot' },
          'Sources: ',
          extLink('https://floridarevenue.com/property/Pages/DataPortal.aspx', null, 'Florida Department of Revenue'),
          ', county property appraisers and county GIS, ',
          extLink('https://dos.fl.gov/sunbiz/', null, 'Florida Division of Corporations'),
          '.',
        ),
      ),
    ) as HTMLDialogElement;
    // A click on the backdrop (the dialog element itself, outside its content) closes it.
    this.dlg.addEventListener('click', (e) => {
      if (e.target === this.dlg) this.dlg.close();
    });
    document.body.append(this.dlg);
  }

  get isOpen(): boolean {
    return this.dlg.open;
  }

  open(section?: 'coverage'): void {
    if (!this.dlg.open) this.dlg.showModal();
    const body = this.dlg.querySelector('.help-body');
    if (section === 'coverage') this.coverage.scrollIntoView({ block: 'start' });
    else if (body) body.scrollTop = 0;
  }
}
