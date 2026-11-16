/**
 * Who an owner name is, read from the name alone, and where to look the owner up in Florida's
 * state business records (Sunbiz, the Division of Corporations).
 *
 * The app only links to Sunbiz's own search pages: it does not copy or scrape its records. An
 * entity summary (status, registered agent, managers) belongs to the Division's free bulk data
 * files, not to its search site.
 */

export type EntityKind = 'llc' | 'corp' | 'lp' | 'trust' | 'person' | 'gov' | 'org' | 'unknown';

/** Shown as a badge next to the owner. 'unknown' has none: the name does not say. */
export const ENTITY_LABEL: Record<EntityKind, string> = {
  llc: 'LLC',
  corp: 'Corporation',
  lp: 'Partnership',
  trust: 'Trust or estate',
  person: 'Individual',
  gov: 'Government',
  org: 'Organization',
  unknown: '',
};

const SUNBIZ = 'https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults';
/** The tax roll cuts owner names off at about this length, often losing the "LLC" or "INC". */
const ROLL_NAME_MAX = 28;

const LLC = /\b(LLC|L L C|LC|LIMITED LIABILITY)\b/;
const LP = /\b(LP|LLP|LLLP|LTD|PARTNERSHIP|PARTNERS|PTNRS|PTNRSHP|PTNSHP|PRTNRSHP)\b/;
const CORP = /\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|PA|PLLC|PL|BANK|N A)\b/;
const ORG =
  /\b(CHURCH|ASSOCIATION|ASSN|ASSOC|FOUNDATION|MINISTRIES|MINISTRY|TEMPLE|SYNAGOGUE|DIOCESE|ARCHDIOCESE|CONGREGATION|CLUB|LODGE|SOCIETY|UNIVERSITY|COLLEGE|HOSPITAL|HOA|CONDOMINIUM|CONDO|POA|LEGION|MISSION|CHAPEL|BAPTIST|METHODIST|CATHOLIC|LUTHERAN|PRESBYTERIAN|EPISCOPAL|YMCA|UNITED WAY|FARM BUREAU|LOCAL|UNION)\b/;
/** Government bodies only: a county-named nonprofit ("PALM BEACH COUNTY FARM BUREAU") is not one. */
const GOV =
  /^(CITY|TOWN|VILLAGE|COUNTY|STATE) OF\b|\b(CITY|TOWN|VILLAGE) OF$|^([A-Z-]+ ){1,3}COUNTY( LESSOR)?$|\b(UNITED STATES|U S A|STATE OF FLORIDA|SCHOOL BOARD|SCHOOL DISTRICT|BOARD OF COUNTY|TIITF|HOUSING AUTHORITY|WATER MANAGEMENT|DRAINAGE DISTRICT|IMPROVEMENT DISTRICT|FLOOD CONTROL|DEPARTMENT OF|DEPT OF|FDOT|SFWMD)\b/;
const TRUST = /\b(TRUST|TRUSTS|TRUS|TRUSTEE|TRUSTEES|TTEE|TTEES|TR|TRS|ESTATE|EST OF|EST|HEIRS|REVOCABLE|IRREVOCABLE)\b/;
const NOT_TRUST = /\b(REAL ESTATE|REALTY TRUST|INVESTMENT TRUST|REIT|TRUST BANK|TRUST CO|TRUST COMPANY)\b/;
/** Words a person's name does not contain: a name with one is a business, whatever its ending. */
const BUSINESS =
  /\b(SERVICES?|CONSTRUCTION|MATERIALS|HEALTHCARE|HEALTH|MEDICAL|DENTAL|CENTER|CENTRE|PLAZA|APARTMENTS?|APTS|STORAGE|EQUITIES|EQUITY|LANDLORD|OWNER|OWNERS|PROPERTY|PROPERTIES|PROP|PROPS|RENTALS?|HOMES?|HOUSING|BUILDERS?|CONTRACTORS?|RESTAURANTS?|MOTEL|HOTEL|INN|MARINA|FARMS?|NURSERY|AUTO|MOTORS?|SUPPLY|SALES|INDUSTRIES|INDUSTRIAL|INTERNATIONAL|AMERICA|AMERICAN|FLORIDA|USA|SHOPPES?|MALL|HOLDINGS?|HOLDING|INVESTMENTS?|INVESTORS?|INVSTMNT|REALTY|ENTERPRISES?|GROUP|VENTURES?|DEVELOPMENT|DEVELOPERS?|MANAGEMENT|MGMT|CAPITAL|FUND|ASSOCIATES|ACADEMY|SCHOOL|ACQUISITIONS?|ASSETS?|PORTFOLIO|PARTNERS|OFFICE|RETAIL|COMMERCIAL|RESIDENTIAL|TOWERS?|VILLAS?|ESTATES|GARDENS|LLLP|TRAIL|STREET|AVENUE|AVE|BLVD|ROAD|HWY|HIGHWAY|NORTH|SOUTH|EAST|WEST|NO|NUMBER|LAND|FAMILY|CHARITABLE|MARITAL|AGREEMENT|DATED|DTD|THE|OF|GLOBAL|LEARNING|CHILD|CHILDREN|CARE|CLINIC|LAW|TRADING|SYSTEMS|SOLUTIONS|TECHNOLOGIES|DESIGN|STUDIO|MARKET|FOODS?|CAFE|BAR|GRILL|PIZZA|PETROLEUM|OIL|GAS|ENERGY|ELECTRIC|PLUMBING|ROOFING|PAVING|TRUCKING|TOWING|LOGISTICS|WAREHOUSE|DISTRIBUTORS?|IMPORTS?|EXPORTS?)\b/;
/** Words the tax roll adds to a person's name that are not part of it. */
const NOISE =
  /\b(ET AL|ETAL|ET UX|ETUX|ET VIR|JTRS|JT TEN|TEN COM|LIFE ESTATE|AS TRUSTEES?|TRUSTEES?|TTEES?|TRS?|TRUS|REV|REVOCABLE|IRREV|IRREVOCABLE|LIVING|LIV|TRUSTS?|ESTATE OF|ESTATE|EST OF|EST|HEIRS OF|HEIRS)\b/g;

const norm = (name: string): string => name.toUpperCase().replace(/[.,'"()]/g, ' ').replace(/\s+/g, ' ').trim();

/** Counties whose roll writes people FIRST [MIDDLE] LAST (Miami-Dade); the others write LAST FIRST [MIDDLE]. */
const FIRST_LAST_COUNTIES = new Set([23]);
const SUFFIX = /^(JR|SR|II|III|IV|LE)$/;

/**
 * "SMITH JOHN A TR & MARY B" -> "SMITH JOHN A": the first person, in LAST FIRST order (what Sunbiz's
 * officer search takes); '' if the name is not a person's. Miami-Dade's "RICHARD K LEE" is turned
 * around to "LEE RICHARD K" (a two-part surname cannot be told apart there, so it keeps its last word).
 */
function firstPerson(name: string, county?: number): string {
  const first = norm(name).split(/\s*&\s*|\s+AND\s+/)[0] ?? '';
  const words = first.replace(NOISE, ' ').split(' ').filter((w) => /^[A-Z]+$/.test(w) && !SUFFIX.test(w));
  if (words.length < 2 || words.length > 4 || BUSINESS.test(words.join(' '))) return '';
  if (county != null && FIRST_LAST_COUNTIES.has(county)) return [words[words.length - 1], ...words.slice(0, -1)].join(' ');
  return words.join(' ');
}

/**
 * The kind of owner a tax-roll name most likely is. A reading of the name, not a state record:
 * 'unknown' whenever the name does not say (a cut-off company name, a bare street address).
 */
export function entityKind(name: string | null | undefined): EntityKind {
  const s = norm(name ?? '');
  if (!s) return 'unknown';
  if (LLC.test(s)) return 'llc';
  if (LP.test(s)) return 'lp';
  if (ORG.test(s)) return 'org';
  if (GOV.test(s)) return 'gov';
  if (TRUST.test(s) && !NOT_TRUST.test(s) && !CORP.test(s)) return 'trust';
  if (CORP.test(s)) return 'corp';
  if (/\d/.test(s) || BUSINESS.test(s) || s.length >= ROLL_NAME_MAX) return 'unknown';
  return firstPerson(s) ? 'person' : 'unknown';
}

/**
 * A person's name the roll's way: two words ("SACCO FRANK"), or more with a middle initial, a
 * second owner ("&") or a suffix. Three plain words ("PARK CREEK PROFESSIONAL") could be either.
 */
function clearlyPerson(name: string): boolean {
  const s = norm(name);
  const words = (s.split(/\s*&\s*|\s+AND\s+/)[0] ?? '').replace(NOISE, ' ').split(' ').filter(Boolean);
  return words.length === 2 || s.includes('&') || words.slice(1).some((w) => w.length === 1 || /^(JR|SR|II|III|IV)$/.test(w));
}

/** The badge next to an owner: the kind when the name says it, '' when it does not. */
export function entityLabel(name: string | null | undefined): string {
  const kind = entityKind(name);
  return kind === 'person' && !clearlyPerson(name ?? '') ? '' : ENTITY_LABEL[kind];
}

export interface Lookup {
  /** Button text. */
  label: string;
  /** What the search shows, for the tooltip. */
  title: string;
  url: string;
}

const sunbiz = (type: 'EntityName' | 'OfficerRegisteredAgentName', term: string): string =>
  `${SUNBIZ}?inquiryType=${type}&searchTerm=${encodeURIComponent(term)}`;

/** Sunbiz lists entity names alphabetically from the term, so a cut-off roll name still lands on it. */
export const sunbizEntityUrl = (name: string): string => sunbiz('EntityName', norm(name).replace(/\s*&\s*$/, ''));

/**
 * State-records lookups that make sense for this owner, most useful first: the entity itself for
 * companies and organizations; for individuals and trustees, the companies that list them as an
 * officer, manager or registered agent. Government owners are not in Sunbiz.
 */
export function ownerLookups(name: string | null | undefined, county?: number): Lookup[] {
  const raw = (name ?? '').trim();
  const kind = entityKind(raw);
  if (!raw || kind === 'gov') return [];
  const entity: Lookup = {
    label: 'Look up on Sunbiz',
    title: 'Florida Division of Corporations records under this name: status, filing date, registered agent, and officers or managers',
    url: sunbizEntityUrl(raw),
  };
  if (kind !== 'person' && kind !== 'trust') return [entity];
  const person = firstPerson(raw, county);
  const officer: Lookup | null = person
    ? {
        label: kind === 'trust' ? 'Find the trustee’s companies' : 'Find their companies',
        title: `Florida companies that list ${person} as an officer, manager or registered agent (Sunbiz)`,
        url: sunbiz('OfficerRegisteredAgentName', person),
      }
    : null;
  // A name that could be a person or a company cut short: the entity search first, the person search second.
  if (kind === 'person' && !clearlyPerson(raw)) return officer ? [entity, { ...officer, label: 'Search as a person' }] : [entity];
  // Individuals are not registered themselves; trusts rarely are, but business and land trusts can be.
  const byName: Lookup = { ...entity, label: kind === 'trust' ? 'Search the trust name' : 'Search as a company name' };
  return officer ? [officer, byName] : [byName];
}

/** One link for exports: the most useful lookup above. Empty for government owners. */
export function sunbizUrl(name: string | null | undefined, county?: number): string {
  return ownerLookups(name, county)[0]?.url ?? '';
}
