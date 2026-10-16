/**
 * core/datefmt.ts — the app's ONE date-time format in the Builder (D-061, audit M2, 16 Oct 2026).
 *
 * The iMEX app writes every date and time as "16 Oct 2026, 4:57 AM" (24-hour clock: "16 Oct 2026, 04:57"), dates in
 * the current year optionally without the year ("16 Oct, 4:57 AM"), never a numeric D/M/Y or M/D/Y date. Its shell
 * offers that as `imxShell.fmt` (App UI widgets/_shared/shell.js, round 3); on app pages the Builder uses it, so both
 * always agree. Without the shell (the harness, an app without the side menu, an older shell) the same output comes
 * from the TypeScript copy below.
 *
 *   dateTime(ts, o)   "16 Oct 2026, 4:57 AM"
 *   date(ts, o)       "16 Oct 2026"
 *   time(ts, o)       "4:57 AM"            (24-hour clock: "04:57")
 *   range(a, b, o)    same day "16 Oct 2026, 4:57 AM – 6:10 PM"; same year "15 Oct, 9:00 PM – 16 Oct 2026, 4:57 AM"
 *   o: { short (no year in the current year), seconds, tz (IANA zone; default the browser's), hour12, now }
 * A bad timestamp gives ''. The 12 / 24-hour clock is the app's (imxShell.hour12(), else the side menu's clock.js
 * __imxClockFns, else the browser's default).
 * D-067 (App UI U-073): the date follows the app's date style (imexAppConfig.formats.date: "16 Oct 2026" by default,
 * "16/10/2026", "16.10.2026", "16-10-2026", "10/16/2026", "2026-10-16" with a space before the time); the shell does
 * it on app pages, the copy below reads the same config (core/regional.ts).
 */
import { appFormats } from './regional';
import type { Formats } from './regional';
export interface FmtOpts {
  short?: boolean;
  seconds?: boolean;
  tz?: string | null;
  hour12?: boolean;
  now?: number;
  /** a per-call override of the app's regional formats (D-067; the shell takes it too) */
  formats?: Partial<Formats>;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The shell's formatter when the page has one with every function this module needs. */
function shell(): { dateTime: Function; date: Function; time: Function; range: Function } | null {
  try {
    const f = (globalThis as any).imxShell?.fmt;
    return f && typeof f.dateTime === 'function' && typeof f.date === 'function' && typeof f.time === 'function' && typeof f.range === 'function' ? f : null;
  } catch {
    return null;
  }
}

/** The app's clock: true for 12 hours (AM / PM). */
export function hour12(): boolean {
  const g: any = globalThis as any;
  try {
    if (typeof g.imxShell?.hour12 === 'function') return !!g.imxShell.hour12();
    if (typeof g.__imxClockFns?.hour12 === 'function') return !!g.__imxClockFns.hour12();
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 !== false;
  } catch {
    return true;
  }
}

const tsOf = (v: unknown): number => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
  const n = v instanceof Date ? v.getTime() : Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const pad = (n: number) => (n < 10 ? '0' : '') + n;

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}
const dtfCache = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock parts of ts in tz (the browser's zone without tz, or when tz is not a zone). */
function parts(ts: number, tz?: string | null): Parts {
  if (tz) {
    try {
      let f = dtfCache.get(tz);
      if (!f) {
        // the original Intl.DateTimeFormat (the app's clock.js wraps it to force its 12 / 24 hours)
        const D: typeof Intl.DateTimeFormat = (globalThis as any).__imxOrigDTF || Intl.DateTimeFormat;
        f = new D('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
        dtfCache.set(tz, f);
      }
      const o: Record<string, string> = {};
      for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
      return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
    } catch {
      /* not a zone: the browser's */
    }
  }
  const d = new Date(ts);
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
}
const h12Of = (o?: FmtOpts) => (o && typeof o.hour12 === 'boolean' ? o.hour12 : hour12());
function timeOf(p: Parts, o?: FmtOpts): string {
  const sec = o?.seconds ? ':' + pad(p.s) : '';
  if (h12Of(o)) return `${p.h % 12 || 12}:${pad(p.mi)}${sec} ${p.h < 12 ? 'AM' : 'PM'}`;
  return `${pad(p.h)}:${pad(p.mi)}${sec}`;
}
function thisYear(o?: FmtOpts): number {
  const now = tsOf(o?.now);
  return parts(Number.isFinite(now) ? now : Date.now(), o?.tz).y;
}
// D-067 (U-073): the date in the app's date style (imexAppConfig.formats.date, core/regional.ts), as the shell writes it
function dateOf(p: Parts, o?: FmtOpts, noYear = false): string {
  const st = appFormats(o?.formats).date;
  const yr = !(noYear || (o?.short && p.y === thisYear(o)));
  const d = pad(p.d);
  const m = pad(p.mo);
  if (st === 'dmy') return d + '/' + m + (yr ? '/' + p.y : '');
  if (st === 'dmy.') return d + '.' + m + '.' + (yr ? p.y : '');
  if (st === 'dmy-') return d + '-' + m + (yr ? '-' + p.y : '');
  if (st === 'mdy') return m + '/' + d + (yr ? '/' + p.y : '');
  if (st === 'ymd') return (yr ? p.y + '-' : '') + m + '-' + d;
  const s = `${p.d} ${MON[p.mo - 1]}`;
  return yr ? `${s} ${p.y}` : s;
}
/** Between the date and the time: ", "; a space for the ISO style ("2026-10-16 16:57"). */
const sepOf = (o?: FmtOpts) => (appFormats(o?.formats).date === 'ymd' ? ' ' : ', ');
/** Options as the shell takes them (no undefined tz). */
const shellOpts = (o?: FmtOpts) => {
  const x: Record<string, unknown> = { ...(o ?? {}) };
  if (!x.tz) delete x.tz;
  return x;
};

/** "16 Oct 2026" ("16 Oct" with short in the current year). */
export function date(ts: unknown, o?: FmtOpts): string {
  const sh = shell();
  if (sh) return String(sh.date(ts, shellOpts(o)) ?? '');
  const t = tsOf(ts);
  return Number.isFinite(t) ? dateOf(parts(t, o?.tz), o) : '';
}
/** "4:57 AM" (24-hour clock: "04:57"). */
export function time(ts: unknown, o?: FmtOpts): string {
  const sh = shell();
  if (sh) return String(sh.time(ts, shellOpts(o)) ?? '');
  const t = tsOf(ts);
  return Number.isFinite(t) ? timeOf(parts(t, o?.tz), o) : '';
}
/** "16 Oct 2026, 4:57 AM" ("16 Oct, 4:57 AM" with short in the current year). */
export function dateTime(ts: unknown, o?: FmtOpts): string {
  const sh = shell();
  if (sh) return String(sh.dateTime(ts, shellOpts(o)) ?? '');
  const t = tsOf(ts);
  if (!Number.isFinite(t)) return '';
  const p = parts(t, o?.tz);
  return dateOf(p, o) + sepOf(o) + timeOf(p, o);
}
/** A period: "16 Oct 2026, 4:57 AM – 6:10 PM" on one day, else both ends with their dates (the year once when shared). */
export function range(from: unknown, to: unknown, o?: FmtOpts): string {
  const sh = shell();
  if (sh) return String(sh.range(from, to, shellOpts(o)) ?? '');
  const a0 = tsOf(from);
  const b0 = tsOf(to);
  if (!Number.isFinite(a0)) return Number.isFinite(b0) ? dateTime(b0, o) : '';
  if (!Number.isFinite(b0)) return dateTime(a0, o);
  const a = parts(a0, o?.tz);
  const b = parts(b0, o?.tz);
  const sep = sepOf(o);
  if (a.y === b.y && a.mo === b.mo && a.d === b.d) return `${dateOf(a, o)}${sep}${timeOf(a, o)} – ${timeOf(b, o)}`;
  const start = a.y === b.y ? dateOf(a, o, true) : dateOf(a, o);
  return `${start}${sep}${timeOf(a, o)} – ${dateOf(b, o)}${sep}${timeOf(b, o)}`;
}

/**
 * Chart axis label for a timestamp in a window of `spanMs`: the time of day up to 36 h ("4:40 AM"), the day and hour up
 * to 8 days ("15 Oct, 6 PM" / "15 Oct, 18:00"), else the day ("15 Oct"; the year only outside the current one).
 */
export function axis(ts: number, spanMs: number): string {
  if (spanMs <= 36 * 3600e3) return time(ts);
  if (spanMs <= 8 * 86400e3) {
    const p = parts(ts);
    const h = h12Of() ? `${p.h % 12 || 12} ${p.h < 12 ? 'AM' : 'PM'}` : `${pad(p.h)}:00`;
    return `${date(ts, { short: true })}, ${h}`;
  }
  return date(ts, { short: true });
}
