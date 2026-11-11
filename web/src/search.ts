import { tokens, type IndexRow, type ParcelIndex, type MailingGroup, type Token } from './parcelIndex';
import type { Bbox } from './types';

/**
 * Client-side search over the published search index (pipeline/pa2/publish.py search_index): owner
 * names, site addresses, cities, parcel IDs, property types and shared mailing addresses. Words are
 * normalized the same way on both sides (uppercase, punctuation dropped, street types and
 * directions abbreviated), and every query word must start a word somewhere in what it is matched
 * against, so "651 hibiscus" finds "651 HIBISCUS ST" and "cityplace ret" finds "CITYPLACE RETAIL LLC".
 */

export type SearchRow = IndexRow;
export type SearchIndex = ParcelIndex;

export interface OwnerHit {
  /** The owner-name key, or null for an owner with a single parcel. */
  key: number | null;
  name: string;
  count: number;
  jv: number;
  top: SearchRow;
}

export interface MailingHit {
  group: MailingGroup;
  count: number;
  jv: number;
  top: SearchRow;
}

export interface SearchResults {
  query: string;
  /** Every matching parcel, best first: parcel ID, then address, then owner, then other matches. */
  all: SearchRow[];
  owners: OwnerHit[];
  mailing: MailingHit[];
}

const hasAll = (h: string, q: Token[]): boolean => q.every((t) => h.includes(t.exact ? ` ${t.w} ` : ` ${t.w}`));

export function search(ix: SearchIndex, query: string): SearchResults {
  const q = tokens(query);
  const empty: SearchResults = { query, all: [], owners: [], mailing: [] };
  if (!q.length || (q.length === 1 && q[0]!.w.length < 2)) return empty;
  // Parcel IDs are matched on their alphanumerics, so dashed county formats work too.
  const alnum = query.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pidQuery = alnum.length >= 6 && /\d{4}/.test(alnum) ? alnum : null;

  const tiers: SearchRow[][] = [[], [], [], []];
  const owners = new Map<string, OwnerHit>();
  for (const r of ix.rows) {
    let tier = -1;
    if (pidQuery && (r.pid.startsWith(pidQuery) || (pidQuery.length >= 8 && r.pid.includes(pidQuery)))) tier = 0;
    else if (hasAll(r.hAddr, q)) tier = 1;
    else if (hasAll(r.hOwn, q)) tier = 2;
    else if (hasAll(r.hAddr + r.hOwn + r.hUse, q)) tier = 3;
    if (tier < 0) continue;
    tiers[tier]!.push(r);
    if (tier === 2) {
      const key = r.onk != null ? `n${r.onk}` : `p${r.pid}`;
      if (!owners.has(key)) {
        const g = r.onk != null ? ix.byName.get(r.onk) : undefined;
        owners.set(key, {
          key: r.onk,
          name: (g?.top ?? r).own,
          count: g?.count ?? 1,
          jv: g?.jv ?? r.jv ?? 0,
          top: g?.top ?? r,
        });
      }
    }
  }
  const byValue = (a: SearchRow, b: SearchRow) => (b.jv ?? 0) - (a.jv ?? 0);
  const all = tiers.flatMap((t) => t.sort(byValue));

  const mailing: MailingHit[] = [];
  for (const g of ix.mailing) {
    if (!hasAll(g.h, q)) continue;
    const st = ix.byAddr.get(g.key);
    if (st) mailing.push({ group: g, count: st.count, jv: st.jv, top: st.top });
  }
  return {
    query,
    all,
    owners: [...owners.values()].sort((a, b) => b.jv - a.jv),
    mailing: mailing.sort((a, b) => b.jv - a.jv),
  };
}

/** Box around the rows (with a little room), for fitting the map. */
export function rowsBbox(rows: Pick<SearchRow, 'lon' | 'lat'>[]): Bbox {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rows) {
    x0 = Math.min(x0, r.lon);
    y0 = Math.min(y0, r.lat);
    x1 = Math.max(x1, r.lon);
    y1 = Math.max(y1, r.lat);
  }
  const pad = 0.002;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}
