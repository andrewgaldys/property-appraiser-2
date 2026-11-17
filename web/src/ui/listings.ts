import type { DataStore } from '../data';
import { appendAll, clear, extLink, h, icon, type Child } from '../dom';
import { int, shortDate } from '../format';
import {
  LISTING_FLAG,
  SOURCE_KIND_LABEL,
  STALE_DAYS,
  daysSince,
  listingMetrics,
  listingPrice,
  listingScope,
  listingSearchUrl,
  listingSize,
  matchText,
  safeUrl,
  type Listing,
  type ListingSource,
  type ListingsIndex,
} from '../listings';
import type { Manifest, ParcelRecord } from '../types';
import { isNominal } from './facts';
import { infoTip } from './infotip';

/** Cards shown before "Show all": a strip center can have a dozen suites on the market. */
const FIRST = 3;

const ABOUT =
  'For-sale and for-lease listings matched to this parcel by parcel ID or street address. Listings are not public records: they appear here only from sources this site is licensed to show. Each one names its source and the date it was last updated there, so confirm with the listing broker before relying on it.';

const KIND_LABEL = { sale: 'For sale', lease: 'For lease' } as const;

/** What the brief prints: this parcel's listings and where they come from. */
export interface ParcelListings {
  items: Listing[];
  sources: ListingSource[];
}

/**
 * The "Listings" section of the parcel panel: whether the property, or a unit or suite in it, is
 * on the market. It never turns missing data into "no": with no listing source connected it says
 * so, and with one connected it names what it checked. Kept across selections like the aerial card.
 */
export class ListingsCard {
  readonly el: HTMLElement;
  /** "For sale" / "For lease" badges for the panel header (empty until a listing is known). */
  readonly badges: HTMLElement;
  private body: HTMLElement;
  private count: HTMLElement;
  private rec: ParcelRecord | null = null;
  private token = 0;
  private items: Listing[] = [];
  private index: ListingsIndex | null = null;
  private expanded = false;

  constructor(
    private manifest: Manifest,
    private data: DataStore,
  ) {
    this.count = h('span', { class: 'ls-count', hidden: true });
    this.body = h('div', { class: 'ls-body' });
    this.el = h('section', { class: 'dr-sec listings', hidden: true }, h('h3', null, 'Listings', this.count, infoTip('listings', ABOUT)), this.body);
    this.badges = h('span', { class: 'ls-badges' });
  }

  /** The current parcel's listings, for the property brief (null when it has none). */
  current(): ParcelListings | null {
    return this.items.length && this.index ? { items: this.items, sources: this.index.sources } : null;
  }

  hide(): void {
    this.token++;
    this.rec = null;
    this.items = [];
    this.el.hidden = true;
    clear(this.badges);
  }

  /** Show the listings of a parcel. Re-renders of the same parcel (portfolio arriving, focus toggles) change nothing. */
  show(r: ParcelRecord): void {
    this.el.hidden = false;
    if (this.rec?.parcel_id === r.parcel_id) return;
    this.rec = r;
    this.items = [];
    this.expanded = false;
    this.setCount(0);
    clear(this.body);
    void this.load(r);
  }

  private async load(r: ParcelRecord): Promise<void> {
    const my = ++this.token;
    // What the index already says (it loads once, at start): no wait for most parcels.
    const known = this.data.loadedListings;
    this.paintBadges(known?.parcels[r.parcel_id] ?? 0);
    if (known === undefined || known?.parcels[r.parcel_id]) this.paintLoading();
    try {
      const { index, items } = await this.data.parcelListings(r.parcel_id);
      if (my !== this.token) return;
      this.index = index;
      this.items = items;
      this.paintBadges(index?.parcels[r.parcel_id] ?? 0);
      this.paint(r);
    } catch (err) {
      if (my !== this.token) return;
      console.error(err);
      this.paintError(r);
    }
  }

  private setCount(n: number): void {
    this.count.hidden = n === 0;
    this.count.textContent = n ? String(n) : '';
  }

  private paintBadges(flags: number): void {
    clear(this.badges);
    if (!flags) return;
    const jump = () => this.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const badge = (cls: string, text: string) =>
      h('button', { type: 'button', class: `badge ls-badge ${cls}`, title: 'Jump to the listings below', onclick: jump }, text);
    if (flags & LISTING_FLAG.sharedOnly) {
      this.badges.append(badge('lease', 'Listed at this address'));
      return;
    }
    if (flags & LISTING_FLAG.sale) this.badges.append(badge('sale', KIND_LABEL.sale));
    if (flags & LISTING_FLAG.lease) this.badges.append(badge('lease', KIND_LABEL.lease));
  }

  private paintLoading(): void {
    this.setCount(0);
    clear(this.body);
    this.body.append(h('div', { class: 'dr-loading sm' }, h('span', { class: 'spinner' }), 'Checking listings'));
  }

  private paintError(r: ParcelRecord): void {
    this.setCount(0);
    clear(this.body);
    this.body.append(
      h('p', { class: 'ls-empty-t' }, 'Could not check listings'),
      h('p', { class: 'cap' }, 'The listing data did not load, so this panel cannot say whether the property is on the market.'),
      h(
        'div',
        { class: 'lookups' },
        h('button', { type: 'button', class: 'btn ghost sm', onclick: () => void this.load(r) }, 'Try again'),
        this.searchLink(r),
      ),
    );
  }

  private searchLink(r: ParcelRecord, quiet = false): HTMLElement | null {
    const url = listingSearchUrl(r);
    return url
      ? extLink(
          url,
          {
            class: `btn ${quiet ? 'quiet' : 'ghost'} sm ext`,
            title: 'Opens a web search for this address with “for sale” and “for lease” in a new tab. Nothing is copied into this site.',
          },
          icon('external', 13),
          'Search the web for this address',
        )
      : null;
  }

  private paint(r: ParcelRecord): void {
    const ix = this.index;
    clear(this.body);
    this.setCount(this.items.length);

    if (!ix) {
      this.body.append(
        h('p', { class: 'ls-empty-t' }, 'No listing source connected'),
        h(
          'p',
          { class: 'cap' },
          'This panel cannot yet say whether the property is on the market. Listings are not public records: they show here once a licensed source is connected.',
        ),
        h('div', { class: 'lookups' }, this.searchLink(r)),
      );
      return;
    }

    if (!this.items.length) {
      appendAll(
        this.body,
        h('p', { class: 'ls-empty-t' }, 'No listing on file for this parcel'),
        h('p', { class: 'cap' }, `Checked against ${this.sourcesText(ix.sources)}. A property can still be on the market elsewhere.`),
        this.staleNote(ix.sources),
        h('div', { class: 'lookups' }, this.searchLink(r)),
      );
      return;
    }

    const used = [...new Set(this.items.map((l) => l.src))].map((i) => ix.sources[i]).filter((s): s is ListingSource => !!s);
    const nominal = isNominal(r.just_value, this.manifest);
    const shown = this.expanded ? this.items : this.items.slice(0, FIRST);
    const sale = this.items.filter((l) => l.kind === 'sale').length;
    const lease = this.items.length - sale;
    const summary = [sale ? `${sale} for sale` : null, lease ? `${lease} for lease` : null].filter(Boolean).join(' · ');

    this.body.append(
      ...[
        used.some((s) => s.demo)
          ? h('p', { class: 'ls-demo', role: 'note' }, icon('warn', 14), 'Sample data for a layout preview. These are not real listings.')
          : null,
        this.items.length > 1 ? h('p', { class: 'ls-summary' }, summary) : null,
        h('div', { class: 'ls-cards' }, shown.map((l) => this.card(l, r, ix.sources[l.src], nominal))),
        this.items.length > shown.length
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn ghost sm ls-more',
                onclick: () => {
                  this.expanded = true;
                  this.paint(r);
                },
              },
              `Show all ${this.items.length} listings`,
            )
          : null,
        this.staleNote(used),
        ix.operator?.name
          ? h('p', { class: 'ls-operator' }, 'Listings shown by ', h('b', null, ix.operator.name), ix.operator.contact ? ` · ${ix.operator.contact}` : '')
          : null,
        ...used.filter((s) => s.disclaimer).map((s) => h('p', { class: 'cap ls-disclaimer' }, s.disclaimer)),
        h('div', { class: 'lookups' }, this.searchLink(r, true)),
      ].filter((x): x is HTMLElement => !!x),
    );
  }

  /** "Acme Realty listings (42 listings, updated Nov 12, 2026)". */
  private sourcesText(sources: ListingSource[]): string {
    return sources.map((s) => `${s.name} (${int(s.listings)} ${s.listings === 1 ? 'listing' : 'listings'}, updated ${shortDate(s.as_of)})`).join(' and ');
  }

  private staleNote(sources: ListingSource[]): HTMLElement | null {
    const old = sources.map((s) => ({ s, days: daysSince(s.as_of) })).filter((x) => x.days != null && x.days > STALE_DAYS);
    if (!old.length) return null;
    return h(
      'p',
      { class: 'warn ls-stale', role: 'note' },
      old.map((x) => `${x.s.name} was last updated ${x.days} days ago.`).join(' '),
      ' Listings change quickly: these may no longer be current.',
    );
  }

  private card(l: Listing, r: ParcelRecord, source: ListingSource | undefined, nominal: boolean): HTMLElement {
    const price = listingPrice(l);
    const scope = listingScope(l);
    const metrics = listingMetrics(l, r, nominal);
    const facts = [...listingSize(l), l.use].filter(Boolean) as string[];
    const url = safeUrl(l.url);
    const who = [l.agent, l.firm].filter(Boolean).join(' · ');
    const phoneHref = l.phone ? `tel:${l.phone.replace(/[^0-9+]/g, '')}` : null;
    const fine: Child[] = [
      source ? `${source.name}${SOURCE_KIND_LABEL[source.kind] ? ` (${SOURCE_KIND_LABEL[source.kind]})` : ''}` : 'Source not named',
      l.updated ? `updated ${shortDate(l.updated)}` : null,
      l.listed ? `on the market since ${shortDate(l.listed)}` : null,
      matchText(l),
    ].filter(Boolean);

    return h(
      'article',
      { class: `ls-card ${l.kind}${l.status === 'pending' ? ' pending' : ''}`, 'aria-label': `${KIND_LABEL[l.kind]}${scope ? `: ${scope}` : ''}` },
      h(
        'div',
        { class: 'ls-top' },
        h('span', { class: `ls-tag ${l.kind}` }, KIND_LABEL[l.kind]),
        scope ? h('span', { class: 'ls-scope' }, scope) : null,
        l.sub && l.sub !== scope ? h('span', { class: 'ls-chip' }, l.sub) : null,
        l.status === 'pending' ? h('span', { class: 'ls-chip pending' }, 'Under contract') : null,
        source?.demo ? h('span', { class: 'ls-chip demo' }, 'Sample') : null,
      ),
      h(
        'div',
        { class: `ls-price${price.stated ? '' : ' unstated'}` },
        h('span', { class: 'ls-amount' }, price.amount),
        price.unit ? h('span', { class: 'ls-unit' }, price.unit) : null,
        l.kind === 'lease' && l.price != null && !l.basis
          ? h('span', { class: 'ls-unit', title: 'The source gives a rent figure without saying whether it is per square foot, per month or per year.' }, 'basis not stated')
          : null,
        l.terms ? h('span', { class: 'ls-terms' }, l.terms) : null,
      ),
      metrics.length ? h('ul', { class: 'ls-metrics' }, metrics.map((m) => h('li', { title: m.how }, m.text))) : null,
      facts.length ? h('p', { class: 'ls-facts' }, facts.join(' · ')) : null,
      l.title ? h('p', { class: 'ls-title' }, l.title) : null,
      l.note ? h('p', { class: 'ls-note' }, l.note) : null,
      l.match === 'shared'
        ? h(
            'p',
            { class: 'ls-caveat', role: 'note' },
            `Listed at this street address. ${l.group ? `${int(l.group)} parcels` : 'Several parcels'} with different owners share it, so the listing may be for another one.`,
          )
        : l.group && l.group > 1
          ? h('p', { class: 'ls-caveat', role: 'note' }, `One offering across ${int(l.group)} parcels, this one included.`)
          : null,
      who || l.phone || l.email || url
        ? h(
            'div',
            { class: 'ls-contact' },
            who ? h('span', { class: 'ls-who' }, h('span', { class: 'ls-who-k' }, 'Listed by'), who) : null,
            h(
              'div',
              { class: 'ls-actions' },
              url ? extLink(url, { class: 'btn solid sm ext', title: 'Opens the listing in a new tab' }, icon('external', 13), 'View listing') : null,
              l.phone && phoneHref ? h('a', { class: 'btn ghost sm', href: phoneHref }, l.phone) : null,
              l.email ? h('a', { class: 'btn ghost sm', href: `mailto:${l.email}` }, 'Email') : null,
            ),
          )
        : null,
      h(
        'p',
        { class: 'ls-fine' },
        source?.logo && safeUrl(source.logo)
          ? h('img', {
              class: 'ls-logo', src: safeUrl(source.logo), alt: source.name, referrerpolicy: 'no-referrer', loading: 'lazy',
              onerror: (e: Event) => (e.target as HTMLElement).remove(), // a logo that does not load leaves no broken image
            })
          : null,
        fine.map((x, i) => (i ? [' · ', x] : x)),
      ),
      this.alsoLine(l),
    );
  }

  /** "Also listed on Acme MLS (updated Nov 12) · Resimplifi ↗": the same offering in other sources, each with its own link. */
  private alsoLine(l: Listing): HTMLElement | null {
    const ix = this.index;
    if (!ix || !l.also?.length) return null;
    const parts = l.also.map(([src, link, updated]) => {
      const s = ix.sources[src];
      const label = `${s?.name ?? 'another source'}${updated ? ` (updated ${shortDate(updated)})` : ''}`;
      const href = safeUrl(link);
      return href ? extLink(href, { title: `Open this listing on ${s?.name ?? 'the other source'}` }, label, icon('external', 11)) : label;
    });
    return h('p', { class: 'ls-also' }, 'Also listed on ', parts.map((x, i) => (i ? [' · ', x] : x)));
  }
}
