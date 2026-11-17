/**
 * State business records (Florida Division of Corporations, "Sunbiz") matched to tax-roll owners by
 * the pipeline (pipeline/build_entities.py), from the Division's free quarterly data files. The app
 * reads them from the data bundle; it never queries sunbiz.org itself.
 */

/** A active | O active, annual report overdue | D administratively dissolved or revoked | I inactive. */
export type EntityState = 'A' | 'O' | 'D' | 'I';

export interface EntityLink {
  doc: string;
  /** Match confidence, 0-1. */
  conf: number;
  /** exact | prefix | core, with "+addr" when the owner's mailing address agrees. */
  how: string;
}

export interface Principal {
  /** Officer title code, or RA for the registered agent. */
  role: string;
  kind: 'P' | 'C';
  name: string;
  addr: string;
  /** Principal group linking this entity to other owners' (0: none). */
  group: number;
}

export interface EntityRecord {
  doc: string;
  name: string;
  type: string;
  /** Status as filed: A or I. */
  status: string;
  state: EntityState;
  note: string | null;
  noteDate: string | null;
  filed: string | null;
  reportYear: number | null;
  reportDate: string | null;
  /** More than six officers on file (the data file holds six). */
  more: boolean;
  addr: string;
  mail: string;
  principals: Principal[];
}

export interface GroupMember {
  doc: string;
  name: string;
  roles: string;
  /** The principal gives the same address here as on another member. */
  shared: boolean;
  pids: string[];
}

export interface PrincipalGroup {
  id: number;
  label: string;
  kind: 'P' | 'C';
  /** Florida entities (any status) that list this person; null for companies. */
  statewide: number | null;
  members: GroupMember[];
}

export interface EntityMatch {
  link: EntityLink;
  rec: EntityRecord;
}

export const STATE_LABEL: Record<EntityState, string> = {
  A: 'Active',
  O: 'Annual report overdue',
  D: 'Administratively dissolved',
  I: 'Inactive',
};

export const STATE_TIP: Record<EntityState, string> = {
  A: 'Active on the Division of Corporations’ records, with this year’s annual report filed (or not yet due).',
  O: 'Active, but this year’s annual report is not on file. Reports are due by May 1; an entity that has not filed by late September is administratively dissolved.',
  D: 'Dissolved (or, for an out-of-state company, its Florida registration revoked) by the Division, usually for not filing an annual report. It can be reinstated.',
  I: 'No longer active: dissolved by its owners, merged, converted or withdrawn.',
};

const TYPE_LABEL: Record<string, string> = {
  DOMP: 'Florida corporation',
  DOMNP: 'Florida nonprofit',
  FORP: 'Out-of-state corporation',
  FORNP: 'Out-of-state nonprofit',
  DOMLP: 'Florida limited partnership',
  FORLP: 'Out-of-state limited partnership',
  FLAL: 'Florida LLC',
  FORL: 'Out-of-state LLC',
  NPREG: 'Nonprofit registration',
  TRUST: 'Declaration of trust',
};

export const typeLabel = (code: string): string => TYPE_LABEL[code] ?? code;

const LETTERS: Record<string, string> = { P: 'President', T: 'Treasurer', C: 'Chairman', V: 'Vice president', S: 'Secretary', D: 'Director' };
/** The state's title field is free text cut to four characters ("Mana" is a manager). Mirrors pipeline/pa2/sunbiz.py. */
const TITLES: Record<string, string> = {
  MGR: 'Manager', MANA: 'Manager', MNGR: 'Manager', MANG: 'Manager', MGRS: 'Manager',
  MGRM: 'Managing member', MMBR: 'Managing member', AMBR: 'Authorized member', MBR: 'Member', MEMB: 'Member',
  MEM: 'Member', SOLE: 'Sole member', AP: 'Authorized person', AUTH: 'Authorized person', AR: 'Authorized representative',
  GP: 'General partner', GENE: 'General partner', LP: 'Limited partner', LIMI: 'Limited partner', PART: 'Partner',
  PTNR: 'Partner', PRES: 'President', VP: 'Vice president', VICE: 'Vice president', EVP: 'Executive vice president',
  SVP: 'Senior vice president', CEO: 'Chief executive', CFO: 'Chief financial officer', COO: 'Chief operating officer',
  EXEC: 'Executive', DIR: 'Director', DIRE: 'Director', SEC: 'Secretary', SECR: 'Secretary', TREA: 'Treasurer',
  TRES: 'Treasurer', CHAI: 'Chairman', CHMN: 'Chairman', TR: 'Trustee', TTEE: 'Trustee', TRUS: 'Trustee',
  OWNR: 'Owner', OWNE: 'Owner', OWN: 'Owner', RA: 'Registered agent',
};

/** 'MGR' -> 'Manager'; corporate letter codes spelled out ('PSD' -> 'President, Secretary, Director'). */
export function roleLabel(code: string): string {
  const c = code.toUpperCase().replace(/[^A-Z]/g, '');
  if (!c) return 'Officer';
  if (TITLES[c]) return TITLES[c];
  if ([...c].every((ch) => LETTERS[ch])) return [...new Set([...c].map((ch) => LETTERS[ch]))].join(', ');
  return c;
}

export function rolesLabel(roles: string): string {
  return [...new Set(roles.split('/').map(roleLabel))].join(', ');
}

/** 'Strong' >= 0.85, 'Likely' >= 0.7, else 'Possible'. */
export function confidenceLabel(conf: number): 'Strong match' | 'Likely match' | 'Possible match' {
  return conf >= 0.85 ? 'Strong match' : conf >= 0.7 ? 'Likely match' : 'Possible match';
}

/** How the owner was matched, in words. */
export function howText(how: string): string {
  const addr = how.endsWith('+addr');
  const base = how.replace('+addr', '');
  const name =
    base === 'exact'
      ? 'same name'
      : base === 'prefix'
        ? 'same name as far as the tax roll prints it (it cuts names at 30 characters)'
        : 'same name apart from LLC, INC or similar';
  return addr ? `${name}, and the tax bill goes to an address on the state record` : name;
}

/** Years since an ISO date, as of another (whole years). */
export function yearsSince(iso: string | null, asOf: string): number | null {
  if (!iso) return null;
  const a = new Date(`${iso}T00:00:00`);
  const b = new Date(`${asOf}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  let y = b.getFullYear() - a.getFullYear();
  if (b.getMonth() < a.getMonth() || (b.getMonth() === a.getMonth() && b.getDate() < a.getDate())) y--;
  return Math.max(0, y);
}

/** Sunbiz's own search, landing on the entity by its full name (the app does not query Sunbiz itself). */
export const sunbizRecordUrl = (name: string): string =>
  `https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults?inquiryType=EntityName&searchTerm=${encodeURIComponent(name.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim())}`;

/** Row arrays from the bundle -> records (fields by name, so a reordered bundle still reads). */
export function toEntity(doc: string, fields: string[], row: unknown[]): EntityRecord {
  const v = (f: string): unknown => row[fields.indexOf(f)];
  const principals = ((v('principals') as unknown[][] | null) ?? []).map((p) => ({
    role: String(p[0] ?? ''),
    kind: (p[1] === 'C' ? 'C' : 'P') as 'P' | 'C',
    name: String(p[2] ?? ''),
    addr: String(p[3] ?? ''),
    group: Number(p[4] ?? 0),
  }));
  const str = (f: string): string | null => (v(f) == null || v(f) === '' ? null : String(v(f)));
  return {
    doc,
    name: String(v('name') ?? ''),
    type: String(v('type') ?? ''),
    status: String(v('status') ?? ''),
    state: (['A', 'O', 'D', 'I'].includes(String(v('state'))) ? String(v('state')) : 'I') as EntityState,
    note: str('note'),
    noteDate: str('note_date'),
    filed: str('filed'),
    reportYear: v('report_year') == null ? null : Number(v('report_year')),
    reportDate: str('report_date'),
    more: v('more') === 1 || v('more') === true,
    addr: String(v('addr') ?? ''),
    mail: String(v('mail') ?? ''),
    principals,
  };
}

/** Principals in display order: officers and managers first, the registered agent last. */
export function officersFirst(ps: Principal[]): Principal[] {
  return [...ps].sort((a, b) => Number(a.role === 'RA') - Number(b.role === 'RA'));
}

/** One line for exports: "Manager: JOHN A SMITH; Registered agent: ACME AGENTS INC". */
export function principalsLine(rec: EntityRecord): string {
  return officersFirst(rec.principals)
    .map((p) => `${roleLabel(p.role)}: ${p.name}`)
    .join('; ');
}
