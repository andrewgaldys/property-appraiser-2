/**
 * Every parcel in one client-side table (pipeline/pa2/publish.py parcel_index), loaded on first use
 * of search or the results tables. Search, the Owners / Parcels tables, owner profiles and CSV
 * export all read it, so a screen covers all three counties rather than only what the map has
 * loaded. Missing values stay null, never 0.
 */

const ABBR: Record<string, string> = {
  STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', ROAD: 'RD', BOULEVARD: 'BLVD', DRIVE: 'DR', LANE: 'LN', COURT: 'CT',
  PLACE: 'PL', PARKWAY: 'PKWY', HIGHWAY: 'HWY', TERRACE: 'TER', CIRCLE: 'CIR', TRAIL: 'TRL', PLAZA: 'PLZ',
  SQUARE: 'SQ', CAUSEWAY: 'CSWY', CENTER: 'CTR', CENTRE: 'CTR', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW', SAINT: 'ST', SUITE: 'STE',
  INCORPORATED: 'INC', CORPORATION: 'CORP', COMPANY: 'CO', LIMITED: 'LTD', TRUSTEE: 'TR', TRUST: 'TR',
};

export interface Token {
  w: string;
  /** Abbreviated from a whole word ("WEST" -> "W"): must match a whole word, not start one. */
  exact: boolean;
}

/** "651 Hibiscus Street, West Palm" -> 651 HIBISCUS ST(exact) W(exact) PALM. */
export function tokens(s: string): Token[] {
  const out: Token[] = [];
  for (const raw of s.toUpperCase().replace(/&/g, ' AND ').split(/[^A-Z0-9]+/)) {
    if (!raw) continue;
    const ab = ABBR[raw];
    out.push(ab ? { w: ab, exact: true } : { w: raw, exact: false });
  }
  return out;
}

/** Haystack with a leading and trailing space: a word-prefix match is includes(' ' + word). */
export const hay = (s: string): string => ` ${tokens(s).map((t) => t.w).join(' ')} `;

export interface IndexRow {
  pid: string;
  co: number;
  cls: string;
  uc: string;
  addr: string;
  city: string;
  zip: string;
  own: string;
  jv: number | null;
  sf: number | null;
  lot: number | null;
  /** Residential units (multifamily and mixed use only). */
  u: number | null;
  yb: number | null;
  btl: number | null;
  /** Last priced sale: price, year, month (0 / null = unknown month). */
  sp: number | null;
  sy: number | null;
  sm: number | null;
  /** Years held (exact) or its minimum, and the year the county's records start. */
  hold: number | null;
  hf: number | null;
  sfrom: number | null;
  onk: number | null;
  oak: number | null;
  ma1: string;
  ma2: string;
  mcity: string;
  mst: string;
  mzip: string;
  lon: number;
  lat: number;
  /** Prospecting flags: out-of-area owner (2 state, 1 county), small portfolio, estate / trust. */
  oa: number | null;
  spf: number | null;
  et: number | null;
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

export interface GroupStats {
  count: number;
  jv: number;
  top: IndexRow;
}

export interface ParcelIndex {
  rows: IndexRow[];
  byPid: Map<string, IndexRow>;
  mailing: MailingGroup[];
  mailingByKey: Map<number, MailingGroup>;
  /** Owner-name groups and shared-mailing-address groups (multi-parcel), dataset-wide. */
  byName: Map<number, GroupStats>;
  byAddr: Map<number, GroupStats>;
  /** Owner names at each shared mailing address, with parcel counts (related entities). */
  namesByAddr: Map<number, Map<string, number>>;
}

export interface RawIndex {
  fields: string[];
  cities: string[];
  mailing_cities?: string[];
  rows: unknown[][];
  mailing: { fields: string[]; rows: unknown[][] };
}

function tally(map: Map<number, GroupStats>, key: number | null, r: IndexRow): void {
  if (key == null) return;
  const g = map.get(key);
  if (!g) map.set(key, { count: 1, jv: r.jv ?? 0, top: r });
  else {
    g.count++;
    g.jv += r.jv ?? 0;
    if ((r.jv ?? 0) > (g.top.jv ?? 0)) g.top = r;
  }
}

export function buildIndex(raw: RawIndex, useCodes: Record<string, string>): ParcelIndex {
  const f = Object.fromEntries(raw.fields.map((k, i) => [k, i])) as Record<string, number>;
  const at = (a: unknown[], k: string): unknown => (f[k] === undefined ? null : a[f[k]!]);
  const num = (a: unknown[], k: string): number | null => {
    const v = at(a, k);
    return typeof v === 'number' ? v : null;
  };
  const str = (a: unknown[], k: string): string => {
    const v = at(a, k);
    return v == null ? '' : String(v);
  };
  const mcities = raw.mailing_cities ?? [];
  const byName = new Map<number, GroupStats>();
  const byAddr = new Map<number, GroupStats>();
  const namesByAddr = new Map<number, Map<string, number>>();
  const byPid = new Map<string, IndexRow>();
  const useHay = new Map<string, string>();

  const rows: IndexRow[] = raw.rows.map((a) => {
    const city = raw.cities[num(a, 'city') ?? -1] ?? '';
    const uc = str(a, 'uc');
    let hUse = useHay.get(uc);
    if (hUse === undefined) {
      hUse = useCodes[uc] ? hay(useCodes[uc]!) : ' ';
      useHay.set(uc, hUse);
    }
    const r: IndexRow = {
      pid: str(a, 'pid'),
      co: num(a, 'co') ?? 0,
      cls: str(a, 'cls'),
      uc,
      addr: str(a, 'addr'),
      city,
      zip: str(a, 'zip'),
      own: str(a, 'own'),
      jv: num(a, 'jv'),
      sf: num(a, 'sf'),
      lot: num(a, 'lot'),
      u: num(a, 'u'),
      yb: num(a, 'yb'),
      btl: num(a, 'btl'),
      sp: num(a, 'sp'),
      sy: num(a, 'sy'),
      sm: num(a, 'sm'),
      hold: num(a, 'hold'),
      hf: num(a, 'hf'),
      sfrom: num(a, 'sfrom'),
      onk: num(a, 'onk'),
      oak: num(a, 'oak'),
      ma1: str(a, 'ma1'),
      ma2: str(a, 'ma2'),
      mcity: mcities[num(a, 'mcity') ?? -1] ?? '',
      mst: str(a, 'mst'),
      mzip: str(a, 'mzip'),
      lon: num(a, 'lon') ?? 0,
      lat: num(a, 'lat') ?? 0,
      oa: num(a, 'oa'),
      spf: num(a, 'spf'),
      et: num(a, 'et'),
      hAddr: hay(`${str(a, 'addr')} ${city}`),
      hOwn: hay(str(a, 'own')),
      hUse,
    };
    byPid.set(r.pid, r);
    tally(byName, r.onk, r);
    tally(byAddr, r.oak, r);
    if (r.oak != null && r.own) {
      let names = namesByAddr.get(r.oak);
      if (!names) namesByAddr.set(r.oak, (names = new Map()));
      names.set(r.own, (names.get(r.own) ?? 0) + 1);
    }
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
  return { rows, byPid, mailing, mailingByKey: new Map(mailing.map((g) => [g.key, g])), byName, byAddr, namesByAddr };
}

/** "4800 N FLAGLER DR STE 1200, WEST PALM BEACH, FL 33407". */
export function mailingLine(r: Pick<IndexRow, 'ma1' | 'ma2' | 'mcity' | 'mst' | 'mzip'>): string {
  const street = [r.ma1, r.ma2].filter(Boolean).join(', ');
  const locality = [r.mcity && (r.mst || r.mzip) ? `${r.mcity},` : r.mcity, r.mst, r.mzip].filter(Boolean).join(' ');
  return [street, locality].filter(Boolean).join(', ');
}
