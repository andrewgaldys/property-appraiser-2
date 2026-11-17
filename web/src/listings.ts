import { int, moneyFull, psf, titleCase } from './format';
import type { MarketFilter, ParcelRecord } from './types';

/**
 * For-sale and for-lease listings matched to parcels (pipeline/pa2/listings.py). They are not public
 * records: the bundle carries them only from sources the site is licensed to show, each with its
 * source and the date it was last updated there. Anything a source did not state stays null.
 */
export type ListingKind = 'sale' | 'lease';
/**
 * How a price is quoted. Sale: null (the whole price), or per SF / per acre. Lease: per SF or per acre
 * by the year or month (or with no period stated), or a flat amount per month or year.
 */
export type ListingBasis = 'sf' | 'sf_yr' | 'sf_mo' | 'ac' | 'ac_yr' | 'ac_mo' | 'mo' | 'yr';
/** pid: parcel ID · addr: street address · range: inside the parcel's address range · shared: the address, which several owners' parcels share. */
export type ListingMatch = 'pid' | 'addr' | 'range' | 'shared';

export interface Listing {
  id: string;
  /** Position in ListingsIndex.sources. */
  src: number;
  kind: ListingKind;
  /** Qualifier as listed: Sublease, Auction, Ground lease, For sale or lease, Business only. */
  sub: string | null;
  /** whole: the entire property · part: a unit, suite or portion · null: the source does not say. */
  scope: 'whole' | 'part' | null;
  space: string | null;
  status: 'active' | 'pending';
  title: string | null;
  /** Property type as listed. */
  use: string | null;
  price: number | null;
  /** Upper end when the source quotes a range ("$28 to $32 / SF"): `price` is then the lower end. */
  price_max: number | null;
  basis: ListingBasis | null;
  /** Lease type (NNN, Modified gross…) or sale terms, as listed. */
  terms: string | null;
  /** The source's own words when it gives no figure: "Call for offers". */
  price_note: string | null;
  sf: number | null;
  /** Smallest divisible area, when the space can be split. */
  sf_min: number | null;
  ac: number | null;
  units: number | null;
  /** Cap rate, percent. */
  cap: number | null;
  noi: number | null;
  firm: string | null;
  agent: string | null;
  phone: string | null;
  email: string | null;
  url: string | null;
  listed: string | null;
  updated: string | null;
  note: string | null;
  match: ListingMatch;
  /** Parcels this listing is shown on, when more than one. */
  group: number | null;
  /** The same offering in other sources: [source index, link, updated]. This card shows its own source's data only. */
  also: [number, string | null, string | null][] | null;
}

export interface ListingSource {
  name: string;
  kind: 'own' | 'mls' | 'vendor' | 'other';
  /** Date the source was last pulled (YYYY-MM-DD). */
  as_of: string;
  listings: number;
  parcels: number;
  note?: string;
  /** Wording the source requires next to its listings. */
  disclaimer?: string;
  url?: string;
  /** The source's logo (an MLS's display rules ask for it beside its listings). */
  logo?: string;
  /** Made-up rows for a local layout preview: never real offerings. */
  demo?: boolean;
}

export interface ListingsIndex {
  schema: string;
  generated_at: string;
  url: string;
  shard_hex: number;
  fields: string[];
  sources: ListingSource[];
  counts: { listings: number; parcels: number; sale: number; lease: number; merged?: number };
  /** Parcel ID -> LISTING_FLAG bits. */
  parcels: Record<string, number>;
  /** The brokerage the site shows listings under (MLS display rules ask for its name). */
  operator?: { name: string; contact?: string };
}

export const LISTING_FLAG = { sale: 1, lease: 2, sharedOnly: 4 } as const;

// ---- Which parcels are listed: one registry for the map, the filters, the tables and the tooltip ----

type MarketKind = Exclude<MarketFilter, ''>;
interface Listed {
  sets: Record<MarketKind, Set<string>>;
  /** Disjoint groups for the map's tags: listed for sale only, for lease only, both. */
  saleOnly: string[];
  leaseOnly: string[];
  both: string[];
  flags: Record<string, number>;
}
let listed: Listed | null = null;

/** Called once the listings index is in (null: no listing source connected). */
export function setListedParcels(ix: ListingsIndex | null): void {
  if (!ix || !ix.sources.length) {
    listed = null;
    return;
  }
  const sets: Listed['sets'] = { any: new Set(), sale: new Set(), lease: new Set() };
  const saleOnly: string[] = [];
  const leaseOnly: string[] = [];
  const both: string[] = [];
  for (const [pid, f] of Object.entries(ix.parcels)) {
    const sale = (f & LISTING_FLAG.sale) !== 0;
    const lease = (f & LISTING_FLAG.lease) !== 0;
    if (!sale && !lease) continue;
    sets.any.add(pid);
    if (sale) sets.sale.add(pid);
    if (lease) sets.lease.add(pid);
    (sale && lease ? both : sale ? saleOnly : leaseOnly).push(pid);
  }
  listed = { sets, saleOnly, leaseOnly, both, flags: ix.parcels };
}

/** True once a listing source is connected and at least one parcel is listed. */
export const hasListings = (): boolean => !!listed && listed.sets.any.size > 0;

/** Parcels the "On the market" filter keeps; null when it filters nothing ('' or no source connected). */
export function listedSet(kind: MarketFilter): Set<string> | null {
  return kind && listed ? listed.sets[kind] : kind ? new Set() : null;
}

/** The same as a list (map filter expressions take arrays). */
export const listedPids = (kind: MarketKind): string[] => (listed ? [...listed.sets[kind]] : []);

/** The map's tag groups (see map/layers.ts listingLayers). */
export const listedGroups = (): { saleOnly: string[]; leaseOnly: string[]; both: string[] } =>
  listed ? { saleOnly: listed.saleOnly, leaseOnly: listed.leaseOnly, both: listed.both } : { saleOnly: [], leaseOnly: [], both: [] };

/** LISTING_FLAG bits of one parcel (0 when unlisted or nothing is connected). */
export const listingFlags = (pid: string): number => listed?.flags[pid] ?? 0;

/** "For sale", "For lease", "For sale · For lease", or null. */
export function listedLabel(pid: string): string | null {
  const f = listingFlags(pid);
  const parts = [f & LISTING_FLAG.sale ? 'For sale' : null, f & LISTING_FLAG.lease ? 'For lease' : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

export const MARKET_LABEL: Record<MarketKind, string> = { any: 'Listed', sale: 'For sale', lease: 'For lease' };

/** Sources older than this get a "may be out of date" warning. */
export const STALE_DAYS = 30;

/** What kind of source a listing comes from, worded to follow its name: "Acme Realty (brokerage listings)". */
export const SOURCE_KIND_LABEL: Record<ListingSource['kind'], string | null> = {
  own: 'brokerage listings',
  mls: 'MLS feed',
  vendor: 'licensed data provider',
  other: null,
};

/** Rows of a listings shard -> objects, by the index's field order. */
export function decodeListings(fields: string[], rows: unknown[][] | undefined): Listing[] {
  return (rows ?? []).map((row) => {
    const o: Record<string, unknown> = {};
    fields.forEach((f, i) => {
      o[f] = row[i] ?? null;
    });
    return o as unknown as Listing;
  });
}

/** Only web links leave the page: anything else in a listing's url field is dropped. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Whole days since an ISO date (null when it cannot be read). */
export function daysSince(iso: string | null | undefined, now = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

const rate = (v: number): string => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const BASIS_UNIT: Record<ListingBasis, string> = {
  sf: '/ SF',
  sf_yr: '/ SF / yr',
  sf_mo: '/ SF / mo',
  ac: '/ AC',
  ac_yr: '/ AC / yr',
  ac_mo: '/ AC / mo',
  mo: '/ mo',
  yr: '/ yr',
};

/** The asking price or rent as listed: { amount: "$38.00", unit: "/ SF / yr" }, or the source's words, or "not stated". */
export function listingPrice(l: Listing): { amount: string; unit: string | null; stated: boolean } {
  if (l.price == null) {
    return { amount: l.price_note || (l.kind === 'sale' ? 'Price not stated' : 'Rent not stated'), unit: null, stated: false };
  }
  // Per-SF figures keep their cents; everything else is whole dollars. A range shows both ends.
  const cents = l.basis ? l.basis.startsWith('sf') : l.kind === 'lease' && l.price < 1000;
  const fmt = cents ? rate : moneyFull;
  const amount = l.price_max != null && l.price_max > l.price ? `${fmt(l.price)}–${fmt(l.price_max)}` : fmt(l.price);
  return { amount, unit: l.basis ? BASIS_UNIT[l.basis] : null, stated: true };
}

/** "2,400 SF", "1,200–5,000 SF", "1.20 AC", "24 units": what is offered, as listed. */
export function listingSize(l: Listing): string[] {
  const out: string[] = [];
  if (l.sf) out.push(l.sf_min ? `${int(l.sf_min)}–${int(l.sf)} SF` : `${int(l.sf)} SF`);
  if (l.ac) out.push(`${l.ac.toFixed(l.ac >= 10 ? 1 : 2)} AC`);
  if (l.units) out.push(`${int(l.units)} ${l.units === 1 ? 'unit' : 'units'}`);
  return out;
}

/** What part of the property the listing covers, in words. Null when the source does not say. */
export function listingScope(l: Listing): string | null {
  if (l.scope === 'whole') return 'Entire property';
  if (l.scope === 'part') return l.space || 'Part of the property';
  return l.space;
}

export interface ListingMetric {
  text: string;
  /** How the figure was worked out (shown as a tooltip). */
  how: string;
}

/**
 * Figures worked out from a listing and the parcel's tax-roll record. Each says what it divides
 * by; none is shown when an input is missing. `nominal`: the parcel's assessed value is a placeholder.
 */
export function listingMetrics(l: Listing, r: ParcelRecord, nominal: boolean): ListingMetric[] {
  const out: ListingMetric[] = [];
  const whole = l.scope === 'whole';
  if (l.cap != null) out.push({ text: `${Number(l.cap.toFixed(2))}% cap rate`, how: 'Cap rate as the listing states it.' });
  if (l.kind === 'sale' && l.price != null && !l.basis && l.price_max == null) {
    const roll = !l.sf && whole && r.tot_lvg_area ? r.tot_lvg_area : null;
    const area = l.sf ?? roll;
    if (area && area > 0) {
      out.push({
        text: `${psf(l.price, area)} / SF${roll ? ' on tax-roll area' : ''}`,
        how: roll ? `Asking price ÷ the ${int(roll)} SF of building on the tax roll.` : `Asking price ÷ the ${int(area)} SF the listing gives.`,
      });
    } else {
      const acres = l.ac ?? (whole ? r.lot_acres : null);
      if (acres && acres > 0) {
        out.push({
          text: `${moneyFull(l.price / acres)} / AC${l.ac ? '' : ' on tax-roll lot'}`,
          how: l.ac ? 'Asking price ÷ the acreage the listing gives.' : 'Asking price ÷ the lot size on the tax roll.',
        });
      }
    }
    const units = l.units ?? (whole ? r.residential_units : null);
    if (units && units > 0) out.push({ text: `${moneyFull(l.price / units)} / unit`, how: `Asking price ÷ ${int(units)} units${l.units ? ' (listing)' : ' (tax roll)'}.` });
    if (whole && !nominal && r.just_value && r.just_value > 0) {
      const x = l.price / r.just_value;
      out.push({
        text: `${x >= 10 ? x.toFixed(0) : x.toFixed(1)}× assessed value`,
        how: `Asking price ÷ the county’s assessed market value (${moneyFull(r.just_value)}${r.tax_roll_year ? `, ${r.tax_roll_year} roll` : ''}). Assessed value is not an appraisal.`,
      });
    }
  }
  if (l.kind === 'sale' && l.price != null && l.price_max == null && (l.basis === 'sf' || l.basis === 'ac')) {
    // A price quoted per SF or per acre (land, mostly): what it comes to over the area the listing gives.
    const area = l.basis === 'ac' ? l.ac : l.ac ? l.ac * 43560 : l.sf;
    if (area && area > 0) {
      const given = l.basis === 'ac' || l.ac ? `${l.ac} acres` : `${int(area)} SF`;
      out.push({ text: `≈ ${moneyFull(l.price * area)} in all`, how: `Price per ${l.basis === 'ac' ? 'acre' : 'SF'} × the ${given} the listing gives.` });
    }
  }
  if (l.kind === 'lease' && l.price != null && l.price_max == null && l.sf && l.sf > 0) {
    if (l.basis === 'mo' || l.basis === 'yr') {
      const annual = l.basis === 'mo' ? l.price * 12 : l.price;
      out.push({ text: `≈ ${rate(annual / l.sf)} / SF / yr`, how: `${l.basis === 'mo' ? 'Monthly rent × 12' : 'Annual rent'} ÷ the ${int(l.sf)} SF listed.` });
    } else if (l.basis === 'sf_yr' || l.basis === 'sf_mo') {
      const monthly = l.basis === 'sf_yr' ? (l.price * l.sf) / 12 : l.price * l.sf;
      out.push({ text: `≈ ${moneyFull(monthly)} / mo`, how: `Rate × the ${int(l.sf)} SF listed${l.basis === 'sf_yr' ? ' ÷ 12' : ''}${l.sf_min ? ' (the full space)' : ''}.` });
    }
  }
  return out;
}

/** How the listing was tied to this parcel, worded to end a line of small print. */
export function matchText(l: Listing): string {
  switch (l.match) {
    case 'pid':
      return 'matched by parcel ID';
    case 'range':
      return 'matched by address, inside this parcel’s number range';
    case 'shared':
      return 'matched to this street address';
    default:
      return 'matched by street address';
  }
}

/** A web search for listings at the parcel's address (nothing is fetched or copied by this site). Null without a site address. */
export function listingSearchUrl(r: ParcelRecord): string | null {
  const addr = (r.site_address || '').trim();
  if (!addr || !/^\d/.test(addr)) return null;
  const city = /COUNTY|UNINCORPORATED/i.test(r.site_city || '') ? '' : titleCase(r.site_city);
  const q = [addr, city, 'FL', r.site_zip, '"for sale" OR "for lease"'].filter(Boolean).join(' ');
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
