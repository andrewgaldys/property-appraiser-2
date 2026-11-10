import { acres, int, money, psf, ratio, saleDate, signedPct, sqft, yearBuilt } from '../format';
import type { ParcelRecord, Portfolio } from '../types';

export interface Fact {
  k: string;
  v: string;
  sub?: string;
}

const has = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function physicalFacts(r: ParcelRecord): Fact[] {
  return [
    { k: 'Building SF', v: sqft(r.tot_lvg_area) },
    { k: 'Lot size', v: acres(r.lnd_sqfoot), sub: has(r.lnd_sqfoot) ? `${int(r.lnd_sqfoot)} SF` : undefined },
    { k: 'Units', v: has(r.no_res_unts) ? int(r.no_res_unts) : '—' },
    { k: 'Year built', v: yearBuilt(r.act_yr_blt, r.eff_yr_blt) },
    { k: 'Value / bldg SF', v: psf(r.just_value, r.tot_lvg_area) },
    { k: 'Value / unit', v: has(r.no_res_unts) && has(r.just_value) ? money(r.just_value / r.no_res_unts) : '—' },
    { k: 'Land $ / SF', v: psf(r.land_value, r.lnd_sqfoot) },
    { k: 'FAR', v: has(r.tot_lvg_area) && has(r.lnd_sqfoot) ? (r.tot_lvg_area / r.lnd_sqfoot).toFixed(2) : '—' },
    { k: 'Bldg / land value', v: ratio(r.bldg_to_land_ratio) },
  ];
}

export function saleFacts(r: ParcelRecord): Fact[] {
  const vsSale = has(r.last_sale_price) && has(r.just_value) ? r.just_value / r.last_sale_price - 1 : null;
  return [
    { k: 'Sale $ / bldg SF', v: psf(r.last_sale_price, r.tot_lvg_area) },
    { k: 'Qualification', v: qualText(r) },
    { k: 'Just value vs. sale', v: signedPct(vsSale) },
  ];
}

export function qualText(r: ParcelRecord): string {
  if (!r.last_sale_qual_cd) return '—';
  if (r.last_sale_qualified === true) return `Qualified (${r.last_sale_qual_cd})`;
  if (r.last_sale_qualified === false) return `Unqualified (${r.last_sale_qual_cd})`;
  return `Code ${r.last_sale_qual_cd}`;
}

export type HoldTier = 'long' | 'mid' | 'short' | 'none';
export function holdTier(hold: number | null): HoldTier {
  if (hold == null) return 'none';
  if (hold >= 15) return 'long';
  if (hold >= 7) return 'mid';
  return 'short';
}

/**
 * `salesFrom`: first year of the source's sale window (the statewide cadastral layer only carries
 * the roll's recent sales), so "no sale" there means "none since then", not "never sold".
 */
export function holdCaption(r: ParcelRecord, salesFrom?: number | null): string {
  if (r.hold_period_years == null) return salesFrom ? `No sale since ${salesFrom} (earlier sales not in this source)` : 'No sale on record';
  return `Held since ${saleDate(r.last_sale_year, r.last_sale_month)}`;
}

export const noSaleShort = (salesFrom?: number | null): string => (salesFrom ? `no sale since ${salesFrom}` : 'no sale on record');

/** Factual screening flags derived from the record (no recommendations). */
export function signals(r: ParcelRecord): string[] {
  const out: string[] = [];
  const st = (r.owner_state || '').trim().toUpperCase();
  if (st && st !== 'FL') out.push(`Out-of-state owner (${st})`);
  if (has(r.building_value) && (r.land_to_value_ratio ?? 0) >= 0.6)
    out.push(`Land-heavy: ${Math.round((r.land_to_value_ratio ?? 0) * 100)}% of value in land`);
  if ((r.hold_period_years ?? 0) >= 15) out.push(`Long hold: ${r.hold_period_years} yrs`);
  if (has(r.act_yr_blt) && r.act_yr_blt < 1980) out.push(`Pre-1980 vintage (${r.act_yr_blt})`);
  if (r.asset_class.startsWith('VAC')) out.push('Vacant land');
  return out;
}

export function portfolioSummary(p: Portfolio): string {
  const counties = Object.keys(p.counties).length;
  return `${p.exact ? '' : '≥ '}${int(p.total)} parcels · ${money(p.jv)} · ${counties} ${counties === 1 ? 'county' : 'counties'}`;
}
