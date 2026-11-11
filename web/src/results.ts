import { BTL_STEPS, CLASS_BADGE, COUNTY_META, LOT_STEPS_AC } from './config';
import { parcelId } from './format';
import { mailingLine, type IndexRow, type ParcelIndex } from './parcelIndex';
import type { Bbox, Filters, OwnerGrouping, OwnerRef, SearchSet } from './types';

/**
 * The results tables' logic: which parcels match the active filters (the same rules as the map's
 * filter expression, evaluated on the parcel index so they cover all three counties), how they
 * group into owners, and the CSV a broker takes into a CRM or a mail merge.
 */

export type { OwnerRef };
export const refKey = (r: OwnerRef): string => `${r.kind}${r.id}`;

/**
 * The group a parcel falls in: its shared mailing address (when grouping by address), else its owner
 * name, else the parcel itself. A registered-agent / manager address (25+ owner names) is not an
 * owner, so with the index at hand those parcels fall back to their owner names.
 */
export function ownerRefOf(row: Pick<IndexRow, 'pid' | 'onk' | 'oak'>, grouping: OwnerGrouping, ix?: ParcelIndex | null): OwnerRef {
  if (grouping === 'addr' && row.oak != null && !ix?.mailingByKey.get(row.oak)?.agent) return { kind: 'a', id: row.oak };
  if (row.onk != null) return { kind: 'n', id: row.onk };
  return { kind: 'p', id: row.pid };
}

/** Every parcel of a group, in all three counties. */
export function groupMembers(ix: ParcelIndex, ref: OwnerRef): IndexRow[] {
  if (ref.kind === 'p') {
    const r = ix.byPid.get(String(ref.id));
    return r ? [r] : [];
  }
  const key = Number(ref.id);
  return ix.rows.filter((r) => (ref.kind === 'n' ? r.onk === key : r.oak === key));
}

/** Mirror of map/layers.ts filterExpr: change both together. */
export function matcher(f: Filters, search: SearchSet | null, nominal: number, view: Bbox | null): (r: IndexRow) => boolean {
  const pids = search ? new Set(search.pids) : null;
  const counties = f.counties.length ? new Set(f.counties) : null;
  const classes = f.classes.length ? new Set(f.classes) : null;
  const lot = (LOT_STEPS_AC[f.lotStep] ?? 0) * 43560;
  const btl = BTL_STEPS[f.btlStep] ?? Infinity;
  return (r) => {
    if (pids && !pids.has(r.pid)) return false;
    if (counties && !counties.has(r.co)) return false;
    if (classes && !classes.has(r.cls)) return false;
    if (f.minHold > 0 && (r.hold ?? r.hf ?? -1) < f.minHold) return false;
    if (lot > 0 && (r.lot ?? 0) < lot) return false;
    if (Number.isFinite(btl)) {
      if ((r.btl ?? 1e9) > btl) return false;
      if (!f.includeNominal && (r.jv ?? 0) < nominal) return false;
    }
    if (view && (r.lon < view[0] || r.lon > view[2] || r.lat < view[1] || r.lat > view[3])) return false;
    return true;
  };
}

/** Years held for display: "12 yrs", "57+ yrs", or null when not on record. */
export function holdText(r: Pick<IndexRow, 'hold' | 'hf'>): string | null {
  if (r.hold != null) return `${r.hold} yrs`;
  if (r.hf != null) return `${r.hf}+ yrs`;
  return null;
}

export interface OwnerResult {
  ref: OwnerRef;
  key: string;
  label: string;
  /** Matching parcels (the result) and all parcels of the group. */
  rows: IndexRow[];
  total: number;
  jv: number;
  sf: number;
  units: number;
  classes: Map<string, number>;
  /** Longest hold among the matching parcels; minimum = it reaches back past the sale records. */
  longest: { years: number; minimum: boolean } | null;
  /** Average of the exact holds (minimums and parcels with no sale on record are left out). */
  avgHold: number | null;
  knownHolds: number;
  mail: IndexRow;
  mailCount: number;
  top: IndexRow;
}

const groupLabel = (ix: ParcelIndex, ref: OwnerRef, first: IndexRow): string => {
  if (ref.kind === 'a') {
    const names = ix.namesByAddr.get(Number(ref.id));
    if (names?.size) return [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  }
  if (ref.kind === 'n') return ix.byName.get(Number(ref.id))?.top.own || first.own;
  return first.own;
};

export function ownerResults(ix: ParcelIndex, rows: IndexRow[], grouping: OwnerGrouping): OwnerResult[] {
  const groups = new Map<string, OwnerResult>();
  for (const r of rows) {
    const ref = ownerRefOf(r, grouping, ix);
    const key = refKey(ref);
    let g = groups.get(key);
    if (!g) {
      const total =
        ref.kind === 'n' ? ix.byName.get(Number(ref.id))?.count ?? 1 : ref.kind === 'a' ? ix.byAddr.get(Number(ref.id))?.count ?? 1 : 1;
      g = {
        ref, key, label: groupLabel(ix, ref, r), rows: [], total, jv: 0, sf: 0, units: 0, classes: new Map(),
        longest: null, avgHold: null, knownHolds: 0, mail: r, mailCount: 0, top: r,
      };
      groups.set(key, g);
    }
    g.rows.push(r);
    g.jv += r.jv ?? 0;
    g.sf += r.sf ?? 0;
    g.units += r.u ?? 0;
    g.classes.set(r.cls, (g.classes.get(r.cls) ?? 0) + 1);
    if ((r.jv ?? 0) > (g.top.jv ?? 0)) g.top = r;
  }
  for (const g of groups.values()) {
    let sum = 0;
    const mails = new Map<string, { n: number; row: IndexRow }>();
    for (const r of g.rows) {
      const y = r.hold ?? r.hf;
      if (y != null && (!g.longest || y > g.longest.years || (y === g.longest.years && r.hold == null)))
        g.longest = { years: y, minimum: r.hold == null };
      if (r.hold != null) {
        sum += r.hold;
        g.knownHolds++;
      }
      const mk = `${r.ma1}|${r.ma2}|${r.mzip}`;
      const m = mails.get(mk);
      if (m) m.n++;
      else mails.set(mk, { n: 1, row: r });
    }
    g.avgHold = g.knownHolds ? sum / g.knownHolds : null;
    g.mailCount = mails.size;
    g.mail = [...mails.values()].sort((a, b) => b.n - a.n)[0]!.row;
  }
  return [...groups.values()];
}

/**
 * Other owner names linked by a shared mailing address (one hop; registered-agent addresses left out).
 * For an address group these are the names at that address besides the label.
 */
export function relatedEntities(ix: ParcelIndex, g: Pick<OwnerResult, 'ref' | 'label'>, members?: IndexRow[]): { name: string; parcels: number }[] {
  const out = new Map<string, number>();
  const add = (oak: number | null) => {
    if (oak == null || ix.mailingByKey.get(oak)?.agent) return;
    for (const [name, n] of ix.namesByAddr.get(oak) ?? []) if (name !== g.label) out.set(name, Math.max(out.get(name) ?? 0, n));
  };
  if (g.ref.kind === 'a') add(Number(g.ref.id));
  else for (const oak of new Set((members ?? groupMembers(ix, g.ref)).map((r) => r.oak))) add(oak);
  return [...out.entries()].map(([name, parcels]) => ({ name, parcels })).sort((a, b) => b.parcels - a.parcels || a.name.localeCompare(b.name));
}

export const classSummary = (classes: Map<string, number>): string =>
  [...classes.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${CLASS_BADGE[c] ?? c} (${n})`).join('; ');

// ---- CSV -------------------------------------------------------------------------------------

/** One cell: quoted when needed; text that a spreadsheet would run as a formula is defused. */
function cell(v: unknown): string {
  if (v == null) return '';
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  // BOM so Excel opens UTF-8 correctly; CRLF per RFC 4180.
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const round = (v: number | null | undefined, d = 0): number | null => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const saleDateIso = (r: IndexRow): string | null => (r.sy ? (r.sm ? `${r.sy}-${String(r.sm).padStart(2, '0')}` : String(r.sy)) : null);

export function ownersCsv(ix: ParcelIndex, groups: OwnerResult[], grouping: OwnerGrouping): string {
  const header = [
    'Owner name', 'Related entities', 'Matching parcels', 'Total parcels (all 3 counties)', 'Assessed market value (matching)',
    'Building SF (matching)', 'Residential units (matching)', 'Asset classes', 'Longest hold (years)', 'Average hold (years, known holds)',
    'Mailing address 1', 'Mailing address 2', 'Mailing city', 'Mailing state', 'Mailing ZIP', 'Other mailing addresses',
    'Largest property', 'Largest property city', 'Grouped by',
  ];
  const rows = groups.map((g) => [
    g.label,
    relatedEntities(ix, g).map((e) => e.name).join('; '),
    g.rows.length,
    g.total,
    round(g.jv),
    g.sf ? round(g.sf) : null,
    g.units || null,
    classSummary(g.classes),
    g.longest ? `${g.longest.years}${g.longest.minimum ? '+' : ''}` : null,
    round(g.avgHold, 1),
    g.mail.ma1,
    g.mail.ma2,
    g.mail.mcity,
    g.mail.mst,
    g.mail.mzip,
    g.mailCount > 1 ? g.mailCount - 1 : null,
    g.top.addr,
    g.top.city,
    g.ref.kind === 'a' ? 'Mailing address' : g.ref.kind === 'n' ? 'Owner name' : grouping === 'addr' ? 'Single parcel' : 'Owner name',
  ]);
  return toCsv(header, rows);
}

export function parcelsCsv(rows: IndexRow[], useCodes: Record<string, string>, nominal: number, link: (pid: string) => string): string {
  const header = [
    'Parcel ID', 'County', 'Site address', 'City', 'ZIP', 'Asset class', 'Property use', 'Assessed market value',
    'Nominal value (common area / sub-parcel)', 'Building SF', 'Lot acres', 'Lot SF', 'Residential units', 'Year built',
    'Last sale date', 'Last sale price', 'Years held', 'Owner name', 'Mailing address 1', 'Mailing address 2',
    'Mailing city', 'Mailing state', 'Mailing ZIP', 'Mailing address (one line)', 'Latitude', 'Longitude', 'Link',
  ];
  const out = rows.map((r) => [
    parcelId(r.pid, r.co),
    COUNTY_META[r.co]?.name ?? r.co,
    r.addr,
    r.city,
    r.zip,
    CLASS_BADGE[r.cls] ?? r.cls,
    useCodes[r.uc] ?? r.uc,
    r.jv,
    r.jv != null && r.jv < nominal ? 'Yes' : null,
    r.sf,
    r.lot ? round(r.lot / 43560, 3) : null,
    r.lot,
    r.u,
    r.yb,
    saleDateIso(r),
    r.sp,
    holdText(r)?.replace(' yrs', '') ?? null,
    r.own,
    r.ma1,
    r.ma2,
    r.mcity,
    r.mst,
    r.mzip,
    mailingLine(r),
    r.lat,
    r.lon,
    link(r.pid),
  ]);
  return toCsv(header, out);
}

/** Save text as a file (the viewer's browser download; nothing leaves the page otherwise). */
export function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const stamp = (): string => new Date().toISOString().slice(0, 10);
