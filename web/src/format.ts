const DASH = '—';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** $24.9M / $842K / $1.24B */
export function money(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e8) return `$${(v / 1e6).toFixed(0)}M`;
  if (a >= 1e7) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `$${(v / 1e3).toFixed(0)}K`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

export function moneyFull(v: number | null | undefined): string {
  return isNum(v) ? `$${Math.round(v).toLocaleString('en-US')}` : DASH;
}

export function int(v: number | null | undefined): string {
  return isNum(v) ? Math.round(v).toLocaleString('en-US') : DASH;
}

export function compact(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}K`;
  return Math.round(v).toLocaleString('en-US');
}

export function sqft(v: number | null | undefined): string {
  return isNum(v) && v > 0 ? `${int(v)} SF` : DASH;
}

export function acres(sf: number | null | undefined): string {
  if (!isNum(sf) || sf <= 0) return DASH;
  const ac = sf / 43560;
  return `${ac.toFixed(ac >= 10 ? 1 : 2)} AC`;
}

export function pct(r: number | null | undefined, digits = 0): string {
  return isNum(r) ? `${(r * 100).toFixed(digits)}%` : DASH;
}

export function signedPct(r: number | null | undefined): string {
  if (!isNum(r)) return DASH;
  const p = r * 100;
  return `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(0)}%`;
}

export function ratio(r: number | null | undefined): string {
  return isNum(r) ? `${r.toFixed(2)}×` : DASH;
}

export function perUnit(total: number | null | undefined, n: number | null | undefined, kind: 'money' = 'money'): string {
  if (!isNum(total) || !isNum(n) || n <= 0) return DASH;
  return kind === 'money' ? money(total / n) : String(total / n);
}

export function psf(total: number | null | undefined, area: number | null | undefined): string {
  if (!isNum(total) || !isNum(area) || area <= 0) return DASH;
  const v = total / area;
  return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
}

export function saleDate(year: number | null | undefined, month: number | null | undefined): string {
  if (!isNum(year)) return DASH;
  return isNum(month) && month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${year}` : String(year);
}

export function yearBuilt(act: number | null | undefined, eff: number | null | undefined): string {
  if (!isNum(act)) return DASH;
  return isNum(eff) && eff !== act ? `${act} (eff. ${eff})` : String(act);
}

const PID_GROUPS: Record<number, number[]> = {
  60: [2, 2, 2, 2, 2, 3, 4], // Palm Beach PCN
  53: [2, 2, 2, 3, 3, 5, 1], // Martin PCN
  66: [4, 3, 4, 3, 1], // St. Lucie parcel ID
};

/** Display a normalized parcel id in the county's familiar dashed format when lengths match. */
export function parcelId(pid: string, county: number): string {
  const groups = PID_GROUPS[county];
  if (!groups || groups.reduce((a, b) => a + b, 0) !== pid.length) return pid;
  const out: string[] = [];
  let i = 0;
  for (const n of groups) {
    out.push(pid.slice(i, i + n));
    i += n;
  }
  return out.join('-');
}

/** 'PORT ST LUCIE' -> 'Port St Lucie' (cities only; street addresses stay tax-roll uppercase). */
export function titleCase(s: string | null | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
