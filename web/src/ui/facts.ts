import { COUNTY_META, MIXED_USE_CODE, RESIDENTIAL_CLASSES, UNDERBUILT } from '../config';
import { int, money, moneyFull, psf, ratio, saleDate, signedPct, titleCase, yearBuilt } from '../format';
import { nominalMax } from '../map/layers';
import type { Manifest, ParcelRecord, Portfolio, PortfolioItem, TileProps } from '../types';

export interface Fact {
  k: string;
  v: string;
  sub?: string;
  /** Plain-language explanation for an ⓘ next to the label. */
  info?: string;
}

const DASH = '—';
const has = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
/** Facts with nothing to show are left out rather than drawn as a dash. */
export const present = (facts: Fact[]): Fact[] => facts.filter((f) => f.v && f.v !== DASH);

/** Glossary for ⓘ buttons (the technical term lives here, the label stays plain). */
export const INFO = {
  marketValue:
    'The property appraiser’s estimate of market value on the tax roll ("just value", JV in the Florida DOR files). It is not an appraisal or a sale price.',
  cappedValue:
    'Assessed value for non-school taxes (AV_NSD): market value after the annual assessment caps. It is often below market value on parcels held for years.',
  useCode:
    'Florida Department of Revenue land-use code from the tax roll. The description is the plain-language version of the code.',
  btl: 'Improvement value divided by land value. Below 1.0 the land is worth more than the buildings on it: a covered-land, redevelopment or teardown signal. Vacant land always passes.',
  far: 'Floor area ratio: building square feet divided by lot square feet.',
  valueVsSale: 'How today’s assessed market value compares with the last sale price.',
  armsLength:
    'Whether the property appraiser counted the last sale as an arm’s-length market sale (qualified) or excluded it, e.g. between related parties or part of a bulk deal.',
  units: 'Dwelling units from the tax roll. Shown for multifamily and mixed-use parcels only: on hotels, offices and warehouses the same field holds rooms or placeholders.',
};

export const isNominal = (jv: number | null | undefined, m: Manifest): boolean => jv != null && jv < nominalMax(m);

/** Dwelling units only mean something on multifamily and mixed-use parcels. */
export const unitsApply = (cls: string, useCode?: string | null): boolean =>
  RESIDENTIAL_CLASSES.has(cls) || useCode === MIXED_USE_CODE;

export function physicalFacts(r: ParcelRecord): Fact[] {
  const units = unitsApply(r.asset_class, r.use_code) ? r.residential_units : null;
  return present([
    { k: 'Year built', v: yearBuilt(r.act_yr_blt, r.eff_yr_blt) },
    { k: 'Buildings', v: has(r.no_buldng) ? int(r.no_buldng) : DASH },
    { k: 'Floor area ratio', v: has(r.tot_lvg_area) && has(r.lnd_sqfoot) ? (r.tot_lvg_area / r.lnd_sqfoot).toFixed(2) : DASH, info: INFO.far },
    { k: 'Value per unit', v: has(units) && has(r.just_value) ? money(r.just_value / units) : DASH },
  ]);
}

/** Value metrics; a nominal-value parcel has none worth showing. */
export function valueFacts(r: ParcelRecord, m: Manifest): Fact[] {
  if (isNominal(r.just_value, m)) return [];
  return present([
    { k: 'Value per building SF', v: psf(r.just_value, r.tot_lvg_area) },
    { k: 'Land value per SF', v: psf(r.land_value, r.lnd_sqfoot) },
    { k: 'Building-to-land value', v: ratio(r.bldg_to_land_ratio), info: INFO.btl },
    { k: 'Capped assessed value', v: r.assessed_value != null ? moneyFull(r.assessed_value) : DASH, info: INFO.cappedValue },
  ]);
}

export function saleFacts(r: ParcelRecord, m: Manifest): Fact[] {
  const vsSale =
    has(r.last_sale_price) && has(r.just_value) && !isNominal(r.just_value, m) ? r.just_value / r.last_sale_price - 1 : null;
  return present([
    { k: 'Sale price per building SF', v: psf(r.last_sale_price, r.tot_lvg_area) },
    { k: 'Arm’s-length sale', v: qualText(r), info: INFO.armsLength },
    { k: 'Value vs. last sale', v: signedPct(vsSale), info: INFO.valueVsSale },
  ]);
}

export function qualText(r: ParcelRecord): string {
  if (!r.last_sale_qual_cd) return DASH;
  if (r.last_sale_qualified === true) return `Yes · code ${r.last_sale_qual_cd}`;
  if (r.last_sale_qualified === false) return `No · code ${r.last_sale_qual_cd}`;
  return `Code ${r.last_sale_qual_cd}`;
}

export type HoldTier = 'long' | 'mid' | 'short' | 'none';
export function holdTier(hold: number | null): HoldTier {
  if (hold == null) return 'none';
  if (hold >= 15) return 'long';
  if (hold >= 7) return 'mid';
  return 'short';
}

export interface HoldInfo {
  /** "12 yrs", "49+ yrs" or "Not on record". */
  text: string;
  years: number | null;
  /** True when `years` is a minimum (the real hold may be longer). */
  minimum: boolean;
  caption: string;
  tier: HoldTier;
}

/**
 * Years held, never shorter than the records can prove. When the last priced sale is older than
 * the county's complete records, or only nominal transfers follow it, the pipeline publishes a
 * minimum (`hold_floor_years`), shown as "N+ yrs".
 */
export function holdInfo(r: ParcelRecord, m: Manifest): HoldInfo {
  const county = COUNTY_META[r.county_code]?.name ?? 'county';
  const minPrice = money(m.data_quality?.min_sale_price ?? 100);
  if (r.hold_period_years != null) {
    return {
      text: `${r.hold_period_years} yrs`,
      years: r.hold_period_years,
      minimum: false,
      caption: `Held since ${saleDate(r.last_sale_year, r.last_sale_month)}.`,
      tier: holdTier(r.hold_period_years),
    };
  }
  const floor = r.hold_floor_years ?? (r.no_sale_since ? m.source.as_of_year - r.no_sale_since : null);
  if (floor != null) {
    const before = r.last_sale_year != null && r.sales_from != null && r.last_sale_year < r.sales_from;
    const caption = before
      ? `Last priced sale on record: ${saleDate(r.last_sale_year, r.last_sale_month)}. ${county} sale records are complete from ${r.sales_from}, so the hold is at least ${floor} years.`
      : `Only nominal transfers (under ${minPrice}) are on record since ${r.no_sale_since}, so the hold is at least ${floor} years.`;
    return { text: `${floor}+ yrs`, years: floor, minimum: true, caption, tier: holdTier(floor) };
  }
  return {
    text: 'Not on record',
    years: null,
    minimum: false,
    caption: `No sale of this parcel is in the ${county} sale records.`,
    tier: 'none',
  };
}

/** Hover readout from tile attributes. */
export function holdShort(p: TileProps): string {
  if (p.hold != null) return `${p.hold} yrs held`;
  if (p.hf != null) return `${p.hf}+ yrs held`;
  return 'sale not on record';
}

const COVERAGE_ORDER = [60, 66, 53];

/** Prospecting thresholds the data was built with (defaults for bundles that predate them). */
export function prospectingRules(m: Manifest): { miles: number; small: [number, number] } {
  return { miles: m.prospecting?.out_of_area_miles ?? 25, small: m.prospecting?.small_portfolio ?? [2, 10] };
}

/** "Sales on record from 1969 (Palm Beach), 1972 (St. Lucie) and 1977 (Martin)." or null without coverage info. */
export function coverageLine(m: Manifest): string | null {
  const cov = m.sales_coverage;
  if (!cov) return null;
  const parts = COVERAGE_ORDER.filter((c) => cov[String(c)]?.from).map(
    (c) => `${cov[String(c)]!.from} (${COUNTY_META[c]?.name ?? c})`,
  );
  if (!parts.length) return null;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `Sales on record from ${list}.`;
}

/** "49+ yrs": the shortest hold that can show as a minimum (the latest county coverage start). */
export function coverageExample(m: Manifest): string {
  const starts = Object.values(m.sales_coverage ?? {}).map((c) => c.from).filter((y): y is number => !!y);
  return starts.length ? `${m.source.as_of_year - Math.max(...starts)}+ yrs` : 'N+ yrs';
}

/** Longer explanation for the hold screen's ⓘ. */
export function coverageDetail(m: Manifest): string {
  const minPrice = money(m.data_quality?.min_sale_price ?? 100);
  const cov = m.sales_coverage ?? {};
  const lines = COVERAGE_ORDER.filter((c) => cov[String(c)]).map((c) => {
    const k = cov[String(c)]!;
    const name = COUNTY_META[c]?.name ?? String(c);
    const depth =
      k.depth === 'all' ? 'every recorded transfer' : k.depth === 'recent5' ? 'each parcel’s five most recent transfers' : k.depth === 'latest' ? 'each parcel’s latest transfer' : 'the tax roll’s sale window';
    return k.from ? `${name}: ${depth}, complete from ${k.from}.` : `${name}: ${depth}.`;
  });
  return [
    `Years since the last sale of ${minPrice} or more. Smaller transfers (often $10 deeds between related owners) are not sales.`,
    lines.join(' '),
    `A hold that reaches back past a county’s records shows as a minimum, like “${coverageExample(m)}”, and passes this screen when that minimum is long enough. So does a parcel with only nominal transfers since some year. A parcel with no sale on record never passes.`,
  ].join('\n\n');
}

/** Factual screening flags derived from the record (no recommendations). */
export function signals(r: ParcelRecord, m: Manifest): string[] {
  const out: string[] = [];
  const st = (r.owner_state || '').trim().toUpperCase();
  if (r.out_of_area === 2 || (r.out_of_area === undefined && st && st !== 'FL')) out.push(`Out-of-state owner (${st})`);
  else if (r.out_of_area === 1) out.push(`Owner mails from elsewhere in Florida${r.owner_city ? ` (${titleCase(r.owner_city)})` : ''}`);
  if (r.estate_trust) out.push('Estate / trust owned');
  if (r.small_portfolio) out.push('Small portfolio owner');
  if (
    !isNominal(r.just_value, m) && r.bldg_to_land_ratio != null && r.bldg_to_land_ratio <= UNDERBUILT.maxBtl &&
    (r.lnd_sqfoot ?? 0) >= UNDERBUILT.minLotAc * 43560
  )
    out.push('Underbuilt site');
  if (!isNominal(r.just_value, m) && has(r.building_value) && (r.land_to_value_ratio ?? 0) >= 0.6)
    out.push(`Land-heavy: ${Math.round((r.land_to_value_ratio ?? 0) * 100)}% of value in land`);
  const hold = holdInfo(r, m);
  if ((hold.years ?? 0) >= 15) out.push(`Long hold: ${hold.text}`);
  if (has(r.act_yr_blt) && r.act_yr_blt < 1980) out.push(`Built before 1980 (${r.act_yr_blt})`);
  if (r.asset_class.startsWith('VAC')) out.push('Vacant land');
  return out;
}

/** "26 parcels · $160M · 1 county". */
export function portfolioSummary(p: Portfolio): string {
  const counties = Object.keys(p.counties).length;
  return `${p.exact ? '' : '≥ '}${int(p.total)} parcels · ${money(p.jv)} · ${counties} ${counties === 1 ? 'county' : 'counties'}`;
}

/** "1.8M building SF · 10 residential units" (units only from multifamily / mixed-use parcels). */
export function portfolioMetrics(p: Portfolio): string {
  const parts: string[] = [];
  if (p.sf) parts.push(`${int(p.sf)} building SF`);
  if (p.units) parts.push(`${int(p.units)} ${p.allResidential ? 'units' : 'residential units'}`);
  return parts.join(' · ');
}

/** Great-circle distance in metres. */
function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(a));
}

/**
 * For a nominal-value parcel: the valued parcel it most likely belongs to. The most valuable
 * parcel within 500 m with the same owner name; failing that, one that only shares the mailing
 * address (never a registered-agent address).
 */
export function parentSite(r: ParcelRecord, p: Portfolio | null | undefined, m: Manifest): { item: PortfolioItem; metres: number } | null {
  if (!p) return null;
  const pick = (allow: (it: PortfolioItem) => boolean) => {
    let best: { item: PortfolioItem; metres: number } | null = null;
    for (const it of p.items) {
      if (!allow(it) || it.parcel_id === r.parcel_id || it.just_value == null || isNominal(it.just_value, m)) continue;
      const d = metres(r.lon, r.lat, it.lon, it.lat);
      if (d <= 500 && (!best || it.just_value > (best.item.just_value ?? 0))) best = { item: it, metres: d };
    }
    return best;
  };
  return pick((it) => it.match !== 'addr') ?? (p.byAddr?.agent ? null : pick((it) => it.match === 'addr'));
}

