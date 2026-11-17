import type { DataStore } from '../data';
import { cap, debtNote, loanTrouble, monthYear, relMonths, type DebtRecord, type LienRecord, type LoanRecord } from '../debt';
import { clear, extLink, h, icon, type Child } from '../dom';
import { money, shortDate } from '../format';
import type { Manifest } from '../types';
import { infoTip } from './infotip';

/** [label, value, sub, value is words (not a figure)] */
type Fact = [Child, Child, Child?, boolean?];

const factGrid = (facts: Fact[]): HTMLElement =>
  h(
    'dl',
    { class: 'facts ent-facts' },
    facts.map(([k, v, sub, words]) =>
      h('div', { class: 'fact' }, h('dt', null, k), h('dd', { class: words ? 'txt' : null }, v, sub ? h('small', null, sub) : null)),
    ),
  );

const GOOD = new Set(['0', 'A']);

/** One securitized loan as its deal last reported it. */
function loanBlock(l: LoanRecord, m: Manifest): HTMLElement {
  const trouble = loanTrouble(l);
  const standing = trouble ?? (l.status ? cap(l.status) : 'Payment status not reported');
  const t10 = m.debt?.sources.treasury;
  const facts: Fact[] = [];
  if (l.mat) facts.push(['Matures', shortDate(l.mat), [relMonths(l.mat), l.mat0 ? `extended from ${shortDate(l.mat0)}` : null].filter(Boolean).join(' · ')]);
  if (l.bal != null) facts.push(['Balance', money(l.bal), l.amt ? `${money(l.amt)} at origination` : null]);
  if (l.rate != null) facts.push(['Rate', `${l.rate.toFixed(2)}%`, [l.rtype, l.io ? 'interest only' : null].filter(Boolean).join(' · ') || null]);
  if (l.ss && trouble !== 'With the special servicer') facts.push(['Special servicer', `Since ${monthYear(l.ss)}`, null, true]);
  if (l.dscr != null) {
    facts.push([
      h('abbr', { title: 'Debt service coverage ratio: the property’s net operating income divided by its loan payments. Under 1.0× it does not cover them.' }, 'DSCR'),
      `${l.dscr.toFixed(2)}×`,
      l.fin ? `${monthYear(l.fin)} financials` : null,
    ]);
  }
  if (l.occ != null) facts.push(['Occupancy', `${Math.round(l.occ * 100)}%`, l.fin ? monthYear(l.fin) : null]);
  if (l.lender) facts.push(['Lender', l.lender, l.orig ? `originated ${monthYear(l.orig)}` : null, true]);
  if (l.workout && !trouble?.startsWith('Workout')) facts.push(['Workout', cap(l.workout), null, true]);
  if (l.modc) facts.push(['Modified', cap(l.modc), l.mod ? shortDate(l.mod) : null, true]);
  if (l.val) facts.push(['Appraised', money(l.val), l.vdate ? monthYear(l.vdate) : null]);
  if (l.ard) facts.push(['Anticipated repayment', shortDate(l.ard), 'the rate steps up after it']);

  const deals = l.deals ?? [l.deal];
  return h(
    'div',
    { class: 'ent debt-item' },
    h(
      'div',
      { class: 'ent-top' },
      h('span', { class: `debt-state${trouble ? ' bad' : GOOD.has(l.sc ?? '') ? '' : ' mid'}` }, trouble ? icon('warn', 13) : null, standing),
      h('span', { class: 'ent-type' }, ['Securitized loan', l.type].filter(Boolean).join(' · ')),
    ),
    l.name ? h('p', { class: 'ent-name' }, l.name) : null,
    factGrid(facts),
    h(
      'p',
      { class: 'cap' },
      deals.length > 1 ? `Split across ${deals.length} deals: ${deals.join(', ')}` : `Held by ${deals[0]}`,
      l.n && l.n > 1 ? `, one of ${l.n} properties securing it` : '',
      l.asof ? `. Loan report of ${shortDate(l.asof)}.` : '.',
      t10?.value != null && t10.date && l.rate != null ? ` The 10-year Treasury yield was ${t10.value.toFixed(2)}% on ${shortDate(t10.date)}.` : '',
    ),
    h(
      'p',
      { class: 'cap ent-match' },
      h('b', null, l.conf >= 0.9 ? 'Matched' : 'Likely match'),
      `: placed by the street address in the loan report${l.check ? `; ${l.check}` : ''}.`,
    ),
    l.url
      ? h(
          'div',
          { class: 'lookups compact' },
          extLink(l.url, { class: 'btn ghost sm ext', title: 'Open the deal’s SEC filing with the loan report (new tab)' }, icon('external', 13), 'SEC filing'),
        )
      : null,
  );
}

/** The federal liens in force against one owner company (several filings show as one entry). */
function lienBlock(group: LienRecord[], m: Manifest): HTMLElement {
  const src = m.debt?.sources.flr;
  const byDate = [...group].sort((a, b) => (b.filed ?? '').localeCompare(a.filed ?? ''));
  const latest = byDate[0];
  const first = byDate[byDate.length - 1];
  const n = group.length;
  const byAddress = group.some((l) => l.how.includes('address'));
  const tax = group.every((l) => l.tax === true);
  const holders = [...new Set(group.map((l) => l.holder).filter(Boolean))];
  const ends = group.map((l) => l.expires).filter((d): d is string => !!d).sort();
  const docs = byDate.map((l) => l.doc);
  const facts: Fact[] = [];
  if (latest.filed) facts.push([n > 1 ? 'Latest filed' : 'Filed', shortDate(latest.filed), relMonths(latest.filed)]);
  if (n > 1 && first.filed) facts.push(['First filed', shortDate(first.filed), relMonths(first.filed)]);
  if (holders.length === 1) facts.push(['Lien holder', holders[0]!, null, true]);
  if (ends.length) facts.push([n > 1 ? 'Last one expires' : 'Expires', shortDate(ends[ends.length - 1]), 'unless refiled']);
  facts.push([n > 1 ? 'Document numbers' : 'Document number', docs.slice(0, 3).join(', ') + (n > 3 ? ` +${n - 3} more` : '')]);
  return h(
    'div',
    { class: 'ent debt-item' },
    h(
      'div',
      { class: 'ent-top' },
      h('span', { class: 'debt-state bad' }, icon('warn', 13), `${n > 1 ? `${n} ` : ''}Federal ${tax ? 'tax ' : ''}lien${n > 1 ? 's' : ''}`),
      h('span', { class: 'ent-type' }, 'In force against the owner company'),
    ),
    latest.debtor ? h('p', { class: 'ent-name' }, latest.debtor) : null,
    factGrid(facts),
    h(
      'p',
      { class: 'cap ent-match' },
      h('b', null, byAddress ? 'Matched' : 'Likely match'),
      `: ${lienHowText(group.find((l) => l.how.includes('address'))?.how ?? latest.how)}. ${src?.label ?? 'Florida Federal Lien Registry'}${
        src?.as_of ? ` data as of ${shortDate(src.as_of)}` : ''
      }.`,
    ),
  );
}

/** How a lien was tied to this parcel's owner, in words. */
function lienHowText(how: string): string {
  const name = how.includes('(tax roll)') ? 'the owner’s exact name on the tax roll' : 'the company’s exact legal name';
  if (how.includes('state record address')) return `${name}, and the lien gives its address on the state record`;
  if (how.includes('tax-bill address')) return `${name}, and the lien gives the tax bill’s mailing address`;
  if (how.includes('property address')) return `${name}, and the lien gives this property’s address`;
  return `${name} (the lien gives another address)`;
}

/** Liens grouped by the company they were filed against. */
function lienGroups(liens: LienRecord[]): LienRecord[][] {
  const by = new Map<string, LienRecord[]>();
  for (const l of liens) {
    const k = l.debtor ?? l.doc;
    by.set(k, [...(by.get(k) ?? []), l]);
  }
  return [...by.values()];
}

/**
 * The parcel panel's "Debt & liens" section, loaded once per parcel (re-renders of the same parcel
 * keep it). Hidden when the parcel has neither.
 */
export class DebtCard {
  readonly el: HTMLElement;
  private body = h('div', { class: 'debt' });
  private pid: string | null = null;
  private token = 0;

  constructor(
    private data: DataStore,
    private manifest: Manifest,
  ) {
    this.el = h(
      'section',
      { class: 'dr-sec', hidden: true },
      h('h3', null, manifest.debt?.sources.sec ? 'Debt & liens' : 'Liens', infoTip('debt and liens', debtNote(manifest))),
      this.body,
    );
  }

  get enabled(): boolean {
    return !!this.manifest.debt;
  }

  show(pid: string): HTMLElement {
    if (pid === this.pid) return this.el;
    this.pid = pid;
    const t = ++this.token;
    clear(this.body);
    this.el.hidden = true;
    const done = (d: DebtRecord | null) => {
      if (t !== this.token) return;
      clear(this.body);
      const items = [...(d?.loans ?? []).map((l) => loanBlock(l, this.manifest)), ...lienGroups(d?.liens ?? []).map((g) => lienBlock(g, this.manifest))];
      this.body.append(...items);
      this.el.hidden = !items.length;
    };
    this.data.debt(pid).then(done, () => done(null));
    return this.el;
  }
}
