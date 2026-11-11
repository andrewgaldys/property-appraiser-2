import type { Bbox } from './types';

/**
 * Client-side search over the published search index (pipeline/pa2/publish.py search_index): owner
 * names, site addresses, cities, parcel IDs, property types and shared mailing addresses. Words are
 * normalized the same way on both sides (uppercase, punctuation dropped, street types and
 * directions abbreviated), and every query word must start a word somewhere in what it is matched
 * against, so "651 hibiscus" finds "651 HIBISCUS ST" and "cityplace ret" finds "CITYPLACE RETAIL LLC".
 */

const ABBR: Record<string, string> = {
  STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', ROAD: 'RD', BOULEVARD: 'BLVD', DRIVE: 'DR', LANE: 'LN', COURT: 'CT',
  PLACE: 'PL', PARKWAY: 'PKWY', HIGHWAY: 'HWY', TERRACE: 'TER', CIRCLE: 'CIR', TRAIL: 'TRL', PLAZA: 'PLZ',
  SQUARE: 'SQ', CAUSEWAY: 'CSWY', CENTER: 'CTR', CENTRE: 'CTR', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW', SAINT: 'ST', SUITE: 'STE',
  INCORPORATED: 'INC', CORPORATION: 'CORP', COMPANY: 'CO', LIMITED: 'LTD', TRUSTEE: 'TR', TRUST: 'TR',
};

interface Token {
  w: string;
  /** Abbreviated from a whole word ("WEST" -> "W"): must match a whole word, not start one. */
  exact: boolean;
}

/** "651 Hibiscus Street, West Palm" -> 651 HIBISCUS ST(exact) W(exact) PALM. */
function tokens(s: string): Token[] {
  const out: Token[] = [];
  for (const raw of s.toUpperCase().replace(/&/g, ' AND ').split(/[^A-Z0-9]+/)) {
    if (!raw) continue;
    const ab = ABBR[raw];
    out.push(ab ? { w: ab, exact: true } : { w: raw, exact: false });
  }
  return out;
}

/** Haystack with a leading and trailing space: a word-prefix match is includes(' ' + word). */
const hay = (s: string): string => ` ${tokens(s).map((t) => t.w).join(' ')} `;

export interface SearchRow {
  pid: string;
  co: number;
  cls: string;
  uc: string;
  addr: string;
  city: string;
  own: string;
  jv: number;
  onk: number | null;
  oak: number | null;
  lon: number;
  lat: number;
  hAddr: string;
  hOwn: string;
  hUse: string;
}

export interface MailingGroup {
  key: number;
  label: string;
  names: number;
  agent: boolean;
  h: string;
}

interface GroupStats {
  count: number;
  jv: number;
  top: SearchRow;
}

export interface SearchIndex {
  rows: SearchRow[];
  mailing: MailingGroup[];
  byName: Map<number, GroupStats>;
  byAddr: Map<number, GroupStats>;
}

export interface RawIndex {
  fields: string[];
  cities: string[];
  rows: unknown[][];
  mailing: { fields: string[]; rows: unknown[][] };
}

function tally(map: Map<number, GroupStats>, key: number | null, r: SearchRow): void {
  if (key == null) return;
  const g = map.get(key);
  if (!g) map.set(key, { count: 1, jv: r.jv, top: r });
  else {
    g.count++;
    g.jv += r.jv;
    if (r.jv > g.top.jv) g.top = r;
  }
}

export function buildIndex(raw: RawIndex, useCodes: Record<string, string>): SearchIndex {
  const f = Object.fromEntries(raw.fields.map((k, i) => [k, i])) as Record<string, number>;
  const byName = new Map<number, GroupStats>();
  const byAddr = new Map<number, GroupStats>();
  const useHay = new Map<string, string>();
  const rows: SearchRow[] = raw.rows.map((a) => {
    const city = raw.cities[a[f.city!] as number] ?? '';
    const uc = String(a[f.uc!] ?? '');
    let hUse = useHay.get(uc);
    if (hUse === undefined) {
      hUse = useCodes[uc] ? hay(useCodes[uc]!) : ' ';
      useHay.set(uc, hUse);
    }
    const r: SearchRow = {
      pid: String(a[f.pid!]),
      co: a[f.co!] as number,
      cls: String(a[f.cls!]),
      uc,
      addr: String(a[f.addr!] ?? ''),
      city,
      own: String(a[f.own!] ?? ''),
      jv: (a[f.jv!] as number) ?? 0,
      onk: (a[f.onk!] as number | null) ?? null,
      oak: (a[f.oak!] as number | null) ?? null,
      lon: a[f.lon!] as number,
      lat: a[f.lat!] as number,
      hAddr: hay(`${a[f.addr!] ?? ''} ${city}`),
      hOwn: hay(String(a[f.own!] ?? '')),
      hUse,
    };
    tally(byName, r.onk, r);
    tally(byAddr, r.oak, r);
    return r;
  });
  const m = raw.mailing;
  const mf = Object.fromEntries(m.fields.map((k, i) => [k, i])) as Record<string, number>;
  const mailing = m.rows.map((a) => ({
    key: a[mf.key!] as number,
    label: String(a[mf.label!]),
    names: (a[mf.names!] as number) ?? 0,
    agent: !!a[mf.agent!],
    h: hay(String(a[mf.label!])),
  }));
  return { rows, mailing, byName, byAddr };
}

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
          jv: g?.jv ?? r.jv,
          top: g?.top ?? r,
        });
      }
    }
  }
  const byValue = (a: SearchRow, b: SearchRow) => b.jv - a.jv;
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
