import { shortDate } from './format';
import type { Manifest } from './types';

/**
 * Debt and liens per parcel (pipeline/build_debt.py), from public records that state exact terms:
 * securitized loans from the monthly loan reports CMBS deals file with the SEC, and federal liens
 * from Florida's Federal Lien Registry. Nothing here is estimated.
 */

/** One loan on the property, as its deal (or deals, for a loan split across several) last reported it. */
export interface LoanRecord {
  /** The deal that holds the loan (the first, when several hold pieces of it). */
  deal: string;
  /** Every deal holding a piece of the loan, when more than one. */
  deals?: string[];
  /** The deal's SEC filing folder. */
  url?: string;
  /** Reporting period end of the loan report. */
  asof?: string;
  asset?: string;
  name?: string;
  type?: string;
  addr?: string;
  orig?: string;
  lender?: string;
  /** Maturity date (after any modification). */
  mat?: string;
  /** The original maturity date, when a modification moved it. */
  mat0?: string;
  /** Anticipated repayment date (hyper-amortizing loans). */
  ard?: string;
  /** Interest rate, percent. */
  rate?: number;
  rtype?: string;
  io?: boolean;
  /** Balance at the end of the reporting period (all reported pieces together). */
  bal?: number;
  /** Original amount (all reported pieces together). */
  amt?: number;
  status?: string;
  /** Payment status code: 0 current, A grace, B under 30 days, 1/2/3 30/60/90+ days late, 4 matured and paying, 5 matured and not. */
  sc?: string;
  /** With the special servicer since this date. */
  ss?: string;
  workout?: string;
  wc?: string;
  mod?: string;
  modc?: string;
  pstat?: string;
  /** Property status code: 1 in foreclosure, 2 lender-owned. */
  pc?: string;
  dscr?: number;
  /** Occupancy, 0-1. */
  occ?: number;
  /** End date of the financials the DSCR and occupancy come from. */
  fin?: string;
  val?: number;
  vdate?: string;
  servicer?: string;
  /** Properties securing the loan. */
  n?: number;
  how: string;
  conf: number;
  check?: string;
}

export interface LienRecord {
  doc: string;
  filed?: string;
  /** Filed by the IRS: a federal tax lien. */
  tax?: boolean;
  kind?: string;
  holder?: string;
  debtor?: string;
  expires?: string;
  assessed?: string;
  last?: string;
  how: string;
  conf: number;
}

export interface DebtRecord {
  loans?: LoanRecord[];
  liens?: LienRecord[];
}

/** Where the bundle's debt records come from, in a sentence (Help, the panel's info tip). */
export function debtNote(m: Manifest): string {
  const s = m.debt?.sources ?? {};
  const parts: string[] = [];
  if (s.sec) {
    parts.push(
      `securitized loans from the monthly loan reports that public commercial mortgage deals (CMBS) file with the SEC${
        s.sec.as_of ? ` (reports through ${shortDate(s.sec.as_of)})` : ''
      }, placed on parcels by street address and checked against year built and floor area: maturity, rate, balance and payment status exactly as reported, never estimated. Most commercial loans sit with banks and insurers and are never reported publicly, so a parcel with no loan here may still be mortgaged`,
    );
  }
  if (s.flr) {
    parts.push(
      `federal liens (IRS tax liens, mostly) against owner companies, from Florida’s Federal Lien Registry${
        s.flr.as_of ? ` (as of ${shortDate(s.flr.as_of)})` : ''
      }, matched by the company’s exact legal name and shown only while in force (not released, withdrawn or expired)`,
    );
  }
  const text = parts.join('; and ');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}.` : '';
}

const LATE = new Set(['1', '2', '3', '5']);

/** The worst thing a loan's report says, in a few words; null when it is in good standing. */
export function loanTrouble(l: LoanRecord): string | null {
  if (l.pc === '1') return 'Property in foreclosure';
  if (l.pc === '2') return 'Lender-owned (REO)';
  if (l.wc && ['2', '3', '5', '6', '7', '10'].includes(l.wc) && l.workout) return `Workout: ${l.workout}`;
  if (l.sc && LATE.has(l.sc) && l.status) return cap(l.status);
  if (l.ss) return 'With the special servicer';
  return null;
}

export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Whole months from today to an ISO date (negative once it has passed). */
export function monthsFromNow(iso: string, today = new Date()): number {
  return (Number(iso.slice(0, 4)) - today.getFullYear()) * 12 + Number(iso.slice(5, 7)) - 1 - today.getMonth();
}

/** 'in 4 months' / 'in 2 years' / '3 months ago' / 'this month'. */
export function relMonths(iso: string, today = new Date()): string {
  const m = monthsFromNow(iso, today);
  if (m === 0) return 'this month';
  const n = Math.abs(m);
  const span = n >= 24 ? `${Math.floor(n / 12)} years` : `${n} ${n === 1 ? 'month' : 'months'}`;
  return m > 0 ? `in ${span}` : `${span} ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-06-15' -> 'Jun 2026'. */
export const monthYear = (iso: string): string => `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''} ${iso.slice(0, 4)}`.trim();

/** The loan that matures first (exports, chips). */
export function firstLoan(d: DebtRecord | undefined): LoanRecord | undefined {
  return [...(d?.loans ?? [])].sort((a, b) => (a.mat ?? '9999').localeCompare(b.mat ?? '9999'))[0];
}

/** Export columns, added when the bundle has debt records. */
export const DEBT_COLUMNS = [
  'Loan matures', 'Loan balance', 'Loan rate (%)', 'Loan status', 'Loan deal', 'Loan report date', 'Federal lien filed', 'Federal lien holder',
];

export function debtColumns(d: DebtRecord | undefined): (string | number | null)[] {
  const l = firstLoan(d);
  const lien = d?.liens?.[0];
  return [
    l?.mat ?? null,
    l?.bal != null ? Math.round(l.bal) : null,
    l?.rate ?? null,
    l ? [loanTrouble(l) ?? (l.status ? cap(l.status) : null), l.ss ? `special servicer since ${l.ss}` : null].filter(Boolean).join('; ') || null : null,
    l ? (l.deals ?? [l.deal]).join('; ') : null,
    l?.asof ?? null,
    lien?.filed ?? null,
    lien?.holder ?? null,
  ];
}
