/**
 * core/regional.ts — the app's regional formats in the Builder (D-067, App UI U-073, spec FORMATS_OEE_SPEC.md A.3 / A.4).
 *
 * The iMEX app stores `imexAppConfig.formats = { locale, date, number, weekStart }` (Configuration › Look & feel ›
 * Regional formats). Its shell offers the formatter as `imxShell.fmt` (App UI widgets/_shared/shell.js); on app pages
 * the Builder uses it, so both always agree. Without the shell (the harness, an older shell) the same output comes
 * from the TypeScript copy below, which runs the shared contract tests/format-vectors.json byte for byte
 * (widgets/test/regional.test.ts).
 *
 *   number(v, o)     "1,234.5" in the app's number style; o { decimals (fixed) | max (default 2) / min, group: false,
 *                    unit, sign: true, empty, formats }; bad input (null, '', NaN, ±Infinity, text) gives '' (or o.empty)
 *   percent(r, o)    "92.5%" for 0.925 (decimals default 1)
 *   weekStart()      0 Sunday | 1 Monday | 6 Saturday (Date.getDay numbering)
 *   appFormats(o?)   the formats in effect (o: a per-call override)
 *
 * Where the formats come from (first that exists): window.__imxFormats (the Configuration page's unsaved preview) →
 * window.__imexApp.config.formats (the side menu's live copy) → localStorage 'imx-app-config'.formats (its cached copy,
 * read at most once a second) → the defaults (dmon, comma-dot, Monday).
 * Rules (as the shell): half away from zero on the decimals shown (1.005 → "1.01"); a value that rounds to zero loses
 * its minus sign; groups from 4 digits on; Indian groups as 12,34,567; space styles use U+202F; minus is ASCII '-'.
 */
export type DateStyle = 'dmon' | 'dmy' | 'dmy.' | 'dmy-' | 'mdy' | 'ymd';
export type NumberStyle = 'comma-dot' | 'dot-comma' | 'space-comma' | 'space-dot' | 'apos-dot' | 'indian';
export type WeekStart = 0 | 1 | 6;
export interface Formats {
  locale: string;
  date: DateStyle;
  number: NumberStyle;
  weekStart: WeekStart;
}

export const DATE_STYLES: readonly DateStyle[] = ['dmon', 'dmy', 'dmy.', 'dmy-', 'mdy', 'ymd'];
export const NUMBER_STYLES: Readonly<Record<NumberStyle, { group: string; decimal: string; indian?: boolean }>> = {
  'comma-dot': { group: ',', decimal: '.' },
  'dot-comma': { group: '.', decimal: ',' },
  'space-comma': { group: ' ', decimal: ',' },
  'space-dot': { group: ' ', decimal: '.' },
  'apos-dot': { group: "'", decimal: '.' },
  indian: { group: ',', decimal: '.', indian: true },
};
const WEEK: readonly number[] = [1, 0, 6];
export const DEFAULT_FORMATS: Readonly<Formats> = { locale: 'standard', date: 'dmon', number: 'comma-dot', weekStart: 1 };

/** A stored / partial formats object made valid: anything missing or unknown is taken from base (the defaults). */
export function normFormats(raw: unknown, base: Formats = DEFAULT_FORMATS): Formats {
  const r: any = raw && typeof raw === 'object' ? raw : {};
  const ws = r.weekStart === '' || r.weekStart === null || r.weekStart === undefined ? NaN : Number(r.weekStart);
  return {
    locale: typeof r.locale === 'string' && r.locale ? r.locale.slice(0, 20) : base.locale,
    date: typeof r.date === 'string' && (DATE_STYLES as string[]).includes(r.date) ? r.date : base.date,
    number: typeof r.number === 'string' && Object.prototype.hasOwnProperty.call(NUMBER_STYLES, r.number) ? r.number : base.number,
    weekStart: WEEK.includes(ws) ? (ws as WeekStart) : base.weekStart,
  };
}

const lsMemo: { at: number; val: unknown } = { at: 0, val: null };
const normMemo: { src: unknown; val: Formats | null } = { src: undefined, val: null };
/** The raw formats object of the page (see the header for the order), or null. */
function source(): unknown {
  const g: any = globalThis as any;
  try {
    if (g.__imxFormats && typeof g.__imxFormats === 'object') return g.__imxFormats;
    const app = g.__imexApp?.config;
    if (app && typeof app === 'object') return app.formats || null;
    const now = Date.now();
    if (now - lsMemo.at > 1000) {
      lsMemo.at = now;
      try {
        const c = typeof localStorage !== 'undefined' ? JSON.parse(localStorage.getItem('imx-app-config') || 'null') : null;
        lsMemo.val = (c && c.formats) || null;
      } catch {
        lsMemo.val = null;
      }
    }
    return lsMemo.val;
  } catch {
    return null;
  }
}

/** The formats in effect: the page's (see the header), with a per-call override on top. */
export function appFormats(override?: unknown): Formats {
  const src = source();
  if (src !== normMemo.src || !normMemo.val) {
    normMemo.src = src;
    normMemo.val = normFormats(src);
  }
  return override && typeof override === 'object' ? normFormats(override, normMemo.val) : normMemo.val;
}

/** The shell's formatter when the page has one (an older shell has no number / weekStart). */
function shellFmt(): any {
  try {
    return (globalThis as any).imxShell?.fmt ?? null;
  } catch {
    return null;
  }
}

export interface NumOpts {
  decimals?: number | null;
  max?: number | null;
  min?: number | null;
  group?: boolean;
  unit?: string;
  sign?: boolean;
  empty?: string | null;
  formats?: Partial<Formats>;
}

const lim = (v: unknown, lo: number, hi: number, def: number): number => {
  const n = v === null || v === undefined || v === '' ? NaN : Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};
/** |a| with d decimals, rounded half away from zero on the digits shown (1.005 → "1.01"). */
function fixed(a: number, d: number): string {
  const s = String(a);
  if (!s.includes('e')) {
    const r = Number(Math.round(Number(s + 'e' + d)) + 'e-' + d);
    if (Number.isFinite(r)) return r.toFixed(d);
  }
  return a.toFixed(d);
}
/** The integer digits with the style's thousands separators (from 4 digits on; Indian 12,34,567). */
function group(ip: string, st: { group: string; indian?: boolean }): string {
  if (ip.length < 4 || !/^\d+$/.test(ip)) return ip;
  let out = '';
  let i = ip.length;
  if (st.indian) {
    out = ip.slice(i - 3);
    i -= 3;
    while (i > 0) {
      out = ip.slice(Math.max(0, i - 2), i) + st.group + out;
      i -= 2;
    }
    return out;
  }
  while (i > 3) {
    out = st.group + ip.slice(i - 3, i) + out;
    i -= 3;
  }
  return ip.slice(0, i) + out;
}

/** The TypeScript copy of imxShell.fmt.number (used without the shell; exported for the contract tests). */
export function formatNumber(v: unknown, o: NumOpts = {}): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return o.empty !== undefined && o.empty !== null ? String(o.empty) : '';
  const st = NUMBER_STYLES[appFormats(o.formats).number];
  const fx = o.decimals !== undefined && o.decimals !== null && (o.decimals as unknown) !== '' ? lim(o.decimals, 0, 10, 0) : null;
  const max = fx !== null ? fx : lim(o.max, 0, 10, 2);
  const min = fx !== null ? fx : Math.min(max, lim(o.min, 0, 10, 0));
  const s = fixed(Math.abs(n), max);
  const dot = s.indexOf('.');
  const ip = dot === -1 ? s : s.slice(0, dot);
  let fp = dot === -1 ? '' : s.slice(dot + 1);
  while (fp.length > min && fp.endsWith('0')) fp = fp.slice(0, -1);
  const nonZero = /[1-9]/.test(ip + fp);
  let out = (n < 0 && nonZero ? '-' : o.sign && n > 0 && nonZero ? '+' : '') + (o.group === false ? ip : group(ip, st)) + (fp ? st.decimal + fp : '');
  if (o.unit) out += o.unit === '%' || o.unit === '°' ? o.unit : ' ' + o.unit;
  return out;
}
/** The TypeScript copy of imxShell.fmt.percent: the ratio × 100 with 1 decimal by default, '%' attached. */
export function formatPercent(ratio: unknown, o: NumOpts = {}): string {
  const r = typeof ratio === 'number' ? ratio : typeof ratio === 'string' && ratio.trim() !== '' ? Number(ratio) : NaN;
  if (!Number.isFinite(r)) return o.empty !== undefined && o.empty !== null ? String(o.empty) : '';
  const p: NumOpts = { ...o, unit: '%' };
  if (p.decimals === undefined && p.max === undefined) p.decimals = 1;
  return formatNumber(r * 100, p);
}

/** A number in the app's number style: imxShell.fmt.number on app pages, else the copy above. */
export function number(v: unknown, o: NumOpts = {}): string {
  const f = shellFmt();
  if (f && typeof f.number === 'function') {
    try {
      return String(f.number(v, o) ?? '');
    } catch {
      /* the copy below */
    }
  }
  return formatNumber(v, o);
}
/** A ratio as a percentage in the app's number style ("92.5%"). */
export function percent(ratio: unknown, o: NumOpts = {}): string {
  const f = shellFmt();
  if (f && typeof f.percent === 'function') {
    try {
      return String(f.percent(ratio, o) ?? '');
    } catch {
      /* the copy below */
    }
  }
  return formatPercent(ratio, o);
}

/** The app's first day of the week: 0 Sunday, 1 Monday (default), 6 Saturday. */
export function weekStart(): WeekStart {
  const f = shellFmt();
  if (f && typeof f.weekStart === 'function') {
    try {
      const w = Number(f.weekStart());
      if (WEEK.includes(w)) return w as WeekStart;
    } catch {
      /* the page's config below */
    }
  }
  return appFormats().weekStart;
}

const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
/** A calendar's weekday headers starting on ws ("Mo".."Su" for Monday). */
export function weekdayHeaders(ws: number): string[] {
  return WD.map((_, i) => WD[(i + ws) % 7]);
}
/** The blank cells before day 1 in a calendar starting on ws, for a month whose day 1 has getDay() = firstDay. */
export function leadDays(firstDay: number, ws: number): number {
  return (((firstDay - ws) % 7) + 7) % 7;
}
