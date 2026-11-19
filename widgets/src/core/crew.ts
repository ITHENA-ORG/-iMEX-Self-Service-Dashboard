// core/crew.ts — the iMEX crew roster core, TypeScript copy for the Dashboard Builder (D-096; App UI U-218).
//
// Pure functions, no requests. The roster is the SERVER_SCOPE attribute `imexCrew` on the app's "System Configuration"
// asset (Settings › Crew writes it; App UI widgets/_shared/crew.js is the JavaScript core, U-089 / U-095). This file
// ports the READING half of that core: parse (with the version 1 migration), planOf, roleOf, team, people, crewOn,
// coverage, reassign, sameShift, onShift, isManager, abbr and the date helpers. The editing half (assign, setCells,
// paste, repeat, patterns, setTeam, leave, compact) stays in the app: the Builder never writes the roster.
// Contract: widgets/test/crew-vectors.json (byte-identical copy of the App UI's tests/crew-vectors.json; the same
// vectors pin crew.js). Keep this file a line-by-line port of crew.js: same names, same decisions, same answers on bad
// data. The calendar maths comes from core/shiftcal.ts (onShift takes a calendar; the shift meaning takes the chain).
//
// Stored (version 2):
//   { v: 2, rev, at, by,
//     roles:   [{ id, name, need }]                 crew roles in display order
//     team:    [{ site, user, role, left? }]        a site's roster (left 'YYYY-MM-DD': off the roster from that day)
//     entries: [{ site, user, from, to, days?, shifts | cycle, role? }]   later entries win per person and day
//   }
// A site is the asset that directly Contains the machines; people are user ids.

export interface CrewRole {
  id: string;
  name: string;
  need: number;
}
export interface TeamRow {
  site: string;
  user: string;
  role: string;
  left?: string;
}
export type Plan = string[] | null;
export interface CrewEntry {
  site: string;
  user: string;
  from: string;
  to: string;
  days?: number[];
  shifts?: Plan;
  cycle?: { start: string; seq: Plan[] };
  role?: string;
}
export interface CrewDoc {
  v: 2;
  rev: number;
  at: number;
  by: string;
  roles: CrewRole[];
  team: TeamRow[];
  entries: CrewEntry[];
}
export interface PlanOfDay {
  shifts: string[];
  off: boolean;
  role: string | null;
  cycle: boolean;
  anchor: string;
}
export interface OnShiftRow {
  role: string;
  roleName: string;
  userId: string;
  shiftId: string;
  shiftName: string;
  productionDay: string;
  start: number;
  end: number;
}
/** The part of a shiftcal calendar that onShift needs. */
export interface CrewCalendar {
  at(ts: number): { id: string | number | null; name?: string; productionDay: string; start: number; end: number } | null;
}
/** o.chain: the site's imexShifts chain (nearest first); null = do not check the shift meaning; missing = no check. */
export interface MeaningOpts {
  chain?: unknown[] | null;
}

export const KEY = 'imexCrew';
export const V = 2;
export const KEEP_DAYS = 400;
export const MAX_ROLES = 8;
export const MAX_NEED = 20;
export const MAX_CYCLE = 56;
export const REST_H = 8;
const MAX_SPAN = 800;
const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DEFAULT: CrewRole[] = [
  { id: 'op1', name: 'Primary operator', need: 1 },
  { id: 'op2', name: 'Secondary operator', need: 1 },
  { id: 'mgr', name: 'Shift manager', need: 1 },
];
export const DEFAULT_ROLES: CrewRole[] = copy(DEFAULT);

// ---------------------------------------------------------------------------------------------- small helpers
function isArray(a: unknown): a is any[] {
  return Array.isArray(a);
}
function isObj(o: unknown): o is Record<string, any> {
  return o !== null && typeof o === 'object' && !Array.isArray(o);
}
function copy<T>(o: T): T {
  return o == null ? o : JSON.parse(JSON.stringify(o));
}
function pad(n: number) {
  return (n < 10 ? '0' : '') + n;
}
export function dayNum(s: unknown): number | null {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null;
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const c = new Date(t);
  if (c.getUTCFullYear() !== +m[1] || c.getUTCMonth() !== +m[2] - 1 || c.getUTCDate() !== +m[3]) return null;
  return Math.round(t / DAY_MS);
}
export function dayStr(n: number): string {
  const c = new Date(n * DAY_MS);
  return c.getUTCFullYear() + '-' + pad(c.getUTCMonth() + 1) + '-' + pad(c.getUTCDate());
}
function isoWeekday(n: number) {
  return (((n % 7) + 7 + 3) % 7) + 1; // 1970-01-01 was a Thursday
}
function mod(a: number, b: number) {
  return ((a % b) + b) % b;
}
function maskOf(days: unknown): number {
  if (!isArray(days)) return 254;
  let m = 0;
  for (const d of days) if (typeof d === 'number' && d >= 1 && d <= 7 && d % 1 === 0) m |= 1 << d;
  return m;
}
function daysOf(mask: number): number[] {
  const out: number[] = [];
  for (let d = 1; d <= 7; d++) if (mask & (1 << d)) out.push(d);
  return out;
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function str(x: unknown): string | null {
  return typeof x === 'string' && x ? x : null;
}
function has(o: object, k: string) {
  return Object.prototype.hasOwnProperty.call(o, k);
}
/** ISO weekday (1 = Monday) of a 'YYYY-MM-DD' day, or null. */
export function weekday(day: string): number | null {
  const n = dayNum(day);
  return n === null ? null : isoWeekday(n);
}

// ---------------------------------------------------------------------------------------------- the document
function cleanRoles(list: unknown): CrewRole[] {
  const out: CrewRole[] = [];
  const seen: Record<string, boolean> = {};
  if (isArray(list)) {
    for (let i = 0; i < list.length && out.length < MAX_ROLES; i++) {
      const r = list[i];
      if (!isObj(r) || typeof r.id !== 'string' || !ID_RE.test(r.id) || seen[r.id]) continue;
      const name = typeof r.name === 'string' ? r.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      if (!name) continue;
      const need = typeof r.need === 'number' && isFinite(r.need) ? Math.max(0, Math.min(MAX_NEED, Math.round(r.need))) : 1;
      seen[r.id] = true;
      out.push({ id: r.id, name, need });
    }
  }
  return out.length ? out : copy(DEFAULT);
}
// a plan element: ['id', ...] (works), [] (Off), null (nothing); undefined when it is not one
function cleanPlan(p: unknown): Plan | undefined {
  if (p === null) return null;
  if (typeof p === 'string') return p ? [p] : undefined;
  if (!isArray(p)) return undefined;
  const out: string[] = [];
  const seen: Record<string, boolean> = {};
  for (let i = 0; i < p.length && out.length < 4; i++)
    if (typeof p[i] === 'string' && p[i] && !seen[p[i]]) {
      seen[p[i]] = true;
      out.push(p[i]);
    }
  return out;
}
function cleanEntry(e: unknown): CrewEntry | null {
  if (!isObj(e) || !str(e.site) || !str(e.user)) return null;
  const a = dayNum(e.from);
  const b = dayNum(e.to);
  if (a === null || b === null || b < a) return null;
  const out: CrewEntry = { site: e.site, user: e.user, from: e.from, to: e.to };
  if (isArray(e.days)) {
    const m = maskOf(e.days);
    if (!m) return null; // no day at all: says nothing
    if (m !== 254) out.days = daysOf(m);
  }
  if (isObj(e.cycle)) {
    if (dayNum(e.cycle.start) === null || !isArray(e.cycle.seq) || !e.cycle.seq.length || e.cycle.seq.length > MAX_CYCLE) return null;
    const seq: Plan[] = [];
    for (let i = 0; i < e.cycle.seq.length; i++) {
      const p = cleanPlan(e.cycle.seq[i]);
      if (p === undefined) return null;
      seq.push(p);
    }
    out.cycle = { start: e.cycle.start, seq };
  } else {
    const s = cleanPlan(e.shifts === undefined ? null : e.shifts);
    if (s === undefined) return null;
    out.shifts = s;
  }
  if (typeof e.role === 'string' && ID_RE.test(e.role)) out.role = e.role;
  return out;
}
function cleanTeam(list: unknown): TeamRow[] {
  const out: TeamRow[] = [];
  const seen: Record<string, boolean> = {};
  if (!isArray(list)) return out;
  for (const t of list) {
    if (!isObj(t) || !str(t.site) || !str(t.user) || typeof t.role !== 'string' || !ID_RE.test(t.role)) continue;
    const k = t.site + '|' + t.user;
    if (seen[k]) continue;
    seen[k] = true;
    const r: TeamRow = { site: t.site, user: t.user, role: t.role };
    if (dayNum(t.left) !== null) r.left = t.left;
    out.push(r);
  }
  return out;
}
/** A clean version 2 document (never null; a version 1 document is migrated; bad entries are skipped). */
export function parse(raw: unknown): CrewDoc {
  let d: any = raw;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      d = null;
    }
  }
  if (!isObj(d)) d = {};
  if (d.v !== V && isArray(d.entries) && d.entries.length && !isArray(d.team)) return migrateV1(d);
  const entries: CrewEntry[] = [];
  if (isArray(d.entries))
    for (const x of d.entries) {
      const e = cleanEntry(x);
      if (e) entries.push(e);
    }
  return {
    v: V,
    rev: typeof d.rev === 'number' && d.rev > 0 ? d.rev : 0,
    at: typeof d.at === 'number' && d.at > 0 ? d.at : 0,
    by: typeof d.by === 'string' ? d.by : '',
    roles: cleanRoles(d.roles),
    team: cleanTeam(d.team),
    entries,
  };
}

// ---------------------------------------------------------------------------------------------- version 1
// v1: { roles: [{ id, name }], entries: [{ site, from, to, days?, shift ('*' = every), role ('*' = every), user|null }] },
// later entries win per (site, day, shift, role); written as person-centred runs (crew.js migrateV1).
export function migrateV1(d: any): CrewDoc {
  const roles = cleanRoles(d.roles);
  const list: { site: string; a: number; b: number; m: number; shift: string; role: string; user: string | null }[] = [];
  for (const e of d.entries || []) {
    if (!isObj(e) || !str(e.site)) continue;
    const a = dayNum(e.from);
    const b = dayNum(e.to);
    if (a === null || b === null || b < a) continue;
    const shift = e.shift === '*' ? '*' : str(e.shift);
    const role = e.role === '*' ? '*' : str(e.role);
    if (!shift || !role) continue;
    list.push({ site: e.site, a, b, m: maskOf(e.days), shift, role, user: str(e.user) });
  }
  const oldest = dayNum(todayStr())! - KEEP_DAYS;
  const sites: Record<string, { ids: Record<string, boolean>; lo: number; hi: number; star: boolean }> = {};
  const plans: Record<string, Record<string, Record<number, { shifts: string[]; role: string; ri: number }>>> = {};
  const counts: Record<string, Record<string, number>> = {};
  for (const x of list) {
    const s = (sites[x.site] = sites[x.site] || { ids: {}, lo: Infinity, hi: -Infinity, star: false });
    if (x.shift !== '*') s.ids[x.shift] = true;
    else if (x.user) s.star = true;
    if (x.user) {
      s.lo = Math.min(s.lo, x.a);
      s.hi = Math.max(s.hi, x.b);
    }
  }
  for (const site of Object.keys(sites)) {
    const s = sites[site];
    let ids = Object.keys(s.ids);
    if (!ids.length && s.star) ids = ['*'];
    const lo = Math.max(s.lo, oldest);
    const hi = Math.min(s.hi, lo + MAX_SPAN);
    plans[site] = {};
    for (let n = lo; n <= hi; n++) {
      const bit = 1 << isoWeekday(n);
      for (let k = 0; k < ids.length; k++) {
        const open: Record<string, boolean> = {};
        let left = 0;
        for (const r of roles) {
          open[r.id] = true;
          left++;
        }
        for (let j = list.length - 1; j >= 0 && left > 0; j--) {
          const x = list[j];
          if (x.site !== site || n < x.a || n > x.b || !(x.m & bit) || !(x.shift === '*' || x.shift === ids[k])) continue;
          for (let r = 0; r < roles.length; r++) {
            const rid = roles[r].id;
            if (!open[rid] || !(x.role === '*' || x.role === rid)) continue;
            open[rid] = false;
            left--;
            if (!x.user) continue;
            const pu = (plans[site][x.user] = plans[site][x.user] || {});
            const day = (pu[n] = pu[n] || { shifts: [], role: rid, ri: r });
            if (day.shifts.indexOf(ids[k]) < 0) day.shifts.push(ids[k]);
            if (r < day.ri) {
              day.role = rid;
              day.ri = r;
            }
            const ck = site + '|' + x.user;
            counts[ck] = counts[ck] || {};
            counts[ck][rid] = (counts[ck][rid] || 0) + 1;
          }
        }
      }
    }
  }
  const team: TeamRow[] = [];
  const entries: CrewEntry[] = [];
  for (const site of Object.keys(plans)) {
    for (const user of Object.keys(plans[site])) {
      const c = counts[site + '|' + user] || {};
      let best: string | null = null;
      for (const r of roles) if (c[r.id] && (best === null || c[r.id] > c[best])) best = r.id;
      if (!best) continue;
      team.push({ site, user, role: best });
      const groups: Record<string, { shifts: string[]; role: string | null; days: number[] }> = {};
      for (const k of Object.keys(plans[site][user])) {
        const p = plans[site][user][+k];
        const sh = p.shifts.slice().sort();
        const key = JSON.stringify(sh) + '|' + (p.role === best ? '' : p.role);
        (groups[key] = groups[key] || { shifts: sh, role: p.role === best ? null : p.role, days: [] }).days.push(+k);
      }
      for (const key of Object.keys(groups)) {
        const g = groups[key];
        for (const rn of runs(g.days)) {
          const en: CrewEntry = { site, user, from: dayStr(rn.a), to: dayStr(rn.b), shifts: g.shifts };
          if (rn.m !== 254) en.days = daysOf(rn.m);
          if (g.role) en.role = g.role;
          entries.push(en);
        }
      }
    }
  }
  const out: CrewDoc = {
    v: V,
    rev: typeof d.rev === 'number' && d.rev > 0 ? d.rev : 0,
    at: typeof d.at === 'number' && d.at > 0 ? d.at : 0,
    by: typeof d.by === 'string' ? d.by : '',
    roles,
    team,
    entries,
  };
  try {
    Object.defineProperty(out, 'migrated', { value: true, enumerable: false, configurable: true, writable: true });
  } catch {
    /* no flag */
  }
  return out;
}
// day numbers -> [{ a, b, m }]: runs that repeat one weekday mask week after week
function runs(days: number[]): { a: number; b: number; m: number }[] {
  const s = days.slice().sort((x, y) => x - y);
  const hasDay: Record<number, boolean> = {};
  const done: Record<number, boolean> = {};
  const out: { a: number; b: number; m: number }[] = [];
  for (const n of s) hasDay[n] = true;
  const free = (n: number) => hasDay[n] && !done[n];
  for (let i = 0; i < s.length; i++) {
    const a = s[i];
    if (done[a]) continue;
    let m = 0;
    let k: number;
    for (k = 0; k < 7; k++) if (free(a + k)) m |= 1 << isoWeekday(a + k);
    let b = a + 6;
    for (;;) {
      let same = true;
      for (k = 1; k <= 7 && same; k++) {
        const n = b + k;
        if (!!free(n) !== !!(m & (1 << isoWeekday(n)))) same = false;
      }
      if (!same) break;
      b += 7;
    }
    while (b > a && !(free(b) && m & (1 << isoWeekday(b)))) b--;
    for (k = b + 1; k < b + 7; k++) {
      const on = !!(m & (1 << isoWeekday(k)));
      if (on && free(k)) continue;
      if (on || free(k)) break;
    }
    for (let e = k - 1; e > b; e--)
      if (free(e) && m & (1 << isoWeekday(e))) {
        b = e;
        break;
      }
    for (k = a; k <= b; k++) if (m & (1 << isoWeekday(k))) done[k] = true;
    out.push({ a, b, m: m === 254 ? 254 : fullMask(a, b, m) });
  }
  return out;
}
function fullMask(a: number, b: number, m: number) {
  for (let n = a; n <= b; n++) if (!(m & (1 << isoWeekday(n)))) return m;
  return 254;
}

// ---------------------------------------------------------------------------------------------- resolving
interface Cached {
  a: number;
  b: number;
  m: number;
  s: number;
}
interface Index {
  n: number;
  list: CrewEntry[];
  by: Record<string, CrewEntry[]>;
  sites: Record<string, Record<string, boolean>>;
}
function cOf(e: CrewEntry): Cached {
  const x = e as any;
  if (x.__c) return x.__c;
  const c: Cached = { a: dayNum(e.from)!, b: dayNum(e.to)!, m: maskOf(e.days), s: e.cycle ? dayNum(e.cycle.start)! : 0 };
  try {
    Object.defineProperty(e, '__c', { value: c, enumerable: false, configurable: true, writable: true });
  } catch {
    /* frozen */
  }
  return c;
}
function index(doc: CrewDoc): Index {
  const x = doc as any;
  if (x.__ix && x.__ix.n === doc.entries.length && x.__ix.list === doc.entries) return x.__ix;
  const ix: Index = { n: doc.entries.length, list: doc.entries, by: {}, sites: {} };
  for (const e of doc.entries) {
    const k = e.site + '|' + e.user;
    (ix.by[k] = ix.by[k] || []).push(e);
    (ix.sites[e.site] = ix.sites[e.site] || {})[e.user] = true;
  }
  try {
    Object.defineProperty(doc, '__ix', { value: ix, enumerable: false, configurable: true, writable: true });
  } catch {
    /* frozen: no cache */
  }
  return ix;
}
function elemOf(e: CrewEntry, n: number): Plan | undefined {
  if (!e.cycle) return e.shifts;
  return e.cycle.seq[mod(n - cOf(e).s, e.cycle.seq.length)];
}
function teamRow(doc: CrewDoc, site: string, user: string): TeamRow | null {
  for (const t of doc.team || []) if (t.site === site && t.user === user) return t;
  return null;
}
/** The person's usual role id at the site (or null). */
export function roleOf(doc: CrewDoc, site: string, user: string): string | null {
  const t = teamRow(doc, site, user);
  return t ? t.role : null;
}
function planAt(doc: CrewDoc, site: string, user: string, n: number): PlanOfDay | null {
  const list = index(doc).by[site + '|' + user];
  if (!list) return null;
  const bit = 1 << isoWeekday(n);
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    const c = cOf(e);
    if (n < c.a || n > c.b || !(c.m & bit)) continue;
    const p = elemOf(e, n);
    if (p === null || p === undefined) return null;
    return { shifts: p.slice(), off: !p.length, role: e.role || roleOf(doc, site, user) || (doc.roles[0] && doc.roles[0].id), cycle: !!e.cycle, anchor: e.from };
  }
  return null;
}
/** What one person works at a site on a day: null (nothing planned) or { shifts, off, role, cycle, anchor }. */
export function planOf(doc: CrewDoc, site: string, user: string, day: string): PlanOfDay | null {
  const n = dayNum(day);
  return n === null ? null : planAt(doc, site, user, n);
}
function roleOrder(doc: CrewDoc): Record<string, number> {
  const o: Record<string, number> = {};
  doc.roles.forEach((r, i) => (o[r.id] = i));
  return o;
}
function byRole(o: Record<string, number>) {
  return (a: { role: string | null; i: number }, b: { role: string | null; i: number }) =>
    ((a.role !== null && a.role in o ? o[a.role] : 99) - (b.role !== null && b.role in o ? o[b.role] : 99)) || a.i - b.i;
}
/** A site's roster in role order (day: only the people still on it that day). */
export function team(doc: CrewDoc, site: string, day?: string | null): { user: string; role: string; left: string | null }[] {
  const n = day ? dayNum(day) : null;
  const out: { user: string; role: string; left: string | null; i: number }[] = [];
  (doc.team || []).forEach((t, i) => {
    if (t.site !== site) return;
    if (n !== null && t.left && dayNum(t.left)! <= n) return;
    out.push({ user: t.user, role: t.role, left: t.left || null, i });
  });
  out.sort(byRole(roleOrder(doc)));
  return out.map((x) => ({ user: x.user, role: x.role, left: x.left }));
}
/** User ids with a roster row or an entry at the site. */
export function people(doc: CrewDoc, site: string): string[] {
  const out: string[] = [];
  const seen: Record<string, boolean> = {};
  for (const t of doc.team || [])
    if (t.site === site && !seen[t.user]) {
      seen[t.user] = true;
      out.push(t.user);
    }
  const s = index(doc).sites[site] || {};
  for (const u of Object.keys(s))
    if (!seen[u]) {
      seen[u] = true;
      out.push(u);
    }
  return out;
}
/** Everyone planned on that shift of that production day, in role order. */
export function crewOn(doc: CrewDoc, site: string, day: string, shiftId: string | number, o?: MeaningOpts): { user: string; role: string }[] {
  const n = dayNum(day);
  const out: { user: string; role: string | null; i: number }[] = [];
  const sid = String(shiftId);
  const defs = defsFor(o);
  if (n === null) return [];
  people(doc, site).forEach((u, i) => {
    const p = planAt(doc, site, u, n);
    if (p && ((p.shifts.indexOf(sid) >= 0 && meaning(defs, p.anchor, day, sid) === 'same') || p.shifts.indexOf('*') >= 0)) out.push({ user: u, role: p.role, i });
  });
  out.sort(byRole(roleOrder(doc)));
  return out.map((x) => ({ user: x.user, role: x.role as string }));
}
/** Per role: who is planned on the shift against the number the role needs. */
export function coverage(doc: CrewDoc, site: string, day: string, shiftId: string | number, o?: MeaningOpts): { role: string; name: string; need: number; have: string[] }[] {
  const on = crewOn(doc, site, day, shiftId, o);
  return doc.roles.map((r) => ({ role: r.id, name: r.name, need: r.need, have: on.filter((x) => x.role === r.id).map((x) => x.user) }));
}

// ---------------------------------------------------------------------------------------------- shift meaning (M-6)
interface ShiftDefLite {
  name: string;
  start: string;
  end: string;
}
interface VersionLite {
  key: string;
  inherit: boolean;
  map: Record<string, ShiftDefLite>;
  idx: number;
}
interface Defs {
  at(day: string): VersionLite | null;
  changes(a: string, b: string): string[];
  def(day: string, id: string): ShiftDefLite | null;
}
/** Two shift definitions are the same shift: the same name, or the same start and end. */
export function sameShift(x: { name?: unknown; start?: unknown; end?: unknown } | null | undefined, y: { name?: unknown; start?: unknown; end?: unknown } | null | undefined): boolean {
  if (!x || !y) return false;
  const nx = String(x.name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const ny = String(y.name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return (!!nx && nx === ny) || (!!x.start && x.start === y.start && x.end === y.end);
}
function docOfChain(d: any): VersionLite[] | null {
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      d = null;
    }
  }
  if (!isObj(d) || !isArray(d.versions)) return null;
  const vs: VersionLite[] = [];
  for (let i = 0; i < d.versions.length; i++) {
    const v = d.versions[i];
    if (!isObj(v) || (v.from != null && dayNum(v.from) === null)) continue;
    const map: Record<string, ShiftDefLite> = {};
    if (v.inherit !== true && isArray(v.shifts)) {
      for (const s of v.shifts) {
        if (isObj(s) && s.id != null && String(s.id) !== '' && !has(map, 'k' + s.id))
          map['k' + s.id] = { name: typeof s.name === 'string' ? s.name : '', start: typeof s.start === 'string' ? s.start : '', end: typeof s.end === 'string' ? s.end : '' };
      }
    }
    vs.push({ key: v.from == null ? '' : v.from, inherit: v.inherit === true, map, idx: i });
  }
  vs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.idx - y.idx));
  return vs;
}
function makeDefs(chain: unknown[]): Defs {
  const docs: (VersionLite[] | null)[] = [];
  const memo: Record<string, VersionLite | null> = {};
  const keys: string[] = [];
  const seenK: Record<string, boolean> = {};
  for (const c of chain) {
    const vs0 = docOfChain(c);
    docs.push(vs0);
    for (let q = 0; vs0 && q < vs0.length; q++)
      if (vs0[q].key && !seenK[vs0[q].key]) {
        seenK[vs0[q].key] = true;
        keys.push(vs0[q].key);
      }
  }
  keys.sort();
  function at(day: string): VersionLite | null {
    if (has(memo, day)) return memo[day];
    let found: VersionLite | null = null;
    for (let i = 0; i < docs.length && !found; i++) {
      const vs = docs[i];
      if (!vs) continue;
      for (let k = vs.length - 1; k >= 0; k--) {
        if (vs[k].key <= day) {
          if (!vs[k].inherit) found = vs[k];
          break;
        }
      }
    }
    memo[day] = found;
    return found;
  }
  function changes(a: string, b: string) {
    return keys.filter((k) => k > a && k <= b);
  }
  return {
    at,
    changes,
    def(day, id) {
      const v = at(day);
      return v && has(v.map, 'k' + id) ? v.map['k' + id] : null;
    },
  };
}
// the definitions of a site's shifts from o.chain (an array; null or missing = no check)
function defsFor(o?: MeaningOpts): Defs | null {
  const chain = o?.chain;
  if (!isArray(chain)) return null;
  const x = chain as any;
  if (x.__crewDefs) return x.__crewDefs;
  const d = makeDefs(chain);
  try {
    Object.defineProperty(chain, '__crewDefs', { value: d, enumerable: false, configurable: true, writable: true });
  } catch {
    /* frozen */
  }
  return d;
}
// 'same' (or nothing to compare with), 'changed' (the id names another shift that day), 'gone' (that day's version
// has no shift with the id)
function meaning(defs: Defs | null, anchor: string, day: string, id: string): 'same' | 'changed' | 'gone' {
  if (!defs || id === '*' || !anchor || anchor >= day) return 'same';
  let prev = defs.def(anchor, id);
  if (!prev) return 'same';
  const v = defs.at(day);
  if (!v) return 'same';
  if (!has(v.map, 'k' + id)) return 'gone';
  for (const step of defs.changes(anchor, day)) {
    const w = defs.at(step);
    if (!w) continue;
    const cur = has(w.map, 'k' + id) ? w.map['k' + id] : null;
    if (!cur || !sameShift(prev, cur)) return 'changed';
    prev = cur;
  }
  return 'same';
}
/** The shifts a person's plan names that day that no longer mean the shift the plan named ("needs re-assigning"). */
export function reassign(doc: CrewDoc, site: string, user: string, day: string, o?: MeaningOpts): { id: string; was: ShiftDefLite | null; now: ShiftDefLite | null; since: string }[] {
  const p = planOf(doc, site, user, day);
  const defs = defsFor(o);
  const out: { id: string; was: ShiftDefLite | null; now: ShiftDefLite | null; since: string }[] = [];
  if (!p || !defs) return out;
  for (const id of p.shifts) {
    const m = meaning(defs, p.anchor, day, id);
    if (m !== 'same') out.push({ id, was: copy(defs.def(p.anchor, id)), now: m === 'gone' ? null : copy(defs.def(day, id)), since: p.anchor });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- on shift now
/**
 * Everyone on shift at the site at instant ts (all people of each role, in role order); [] when no shift runs then or
 * nothing is known. opts.calendar: the site's calendar (core/shiftcal.ts); opts.chain: its imexShifts chain for the
 * shift meaning (missing = not checked).
 */
export function onShift(siteId: string, ts: number, opts: { doc: unknown; calendar: CrewCalendar | null; chain?: unknown[] | null }): OnShiftRow[] {
  let doc: any = opts.doc;
  if (!doc || !siteId) return [];
  if (!(doc.v === V && isArray(doc.team) && isArray(doc.roles))) doc = parse(doc);
  const cal = opts.calendar;
  if (!cal) return [];
  const mo: MeaningOpts = { chain: opts.chain };
  let x: ReturnType<CrewCalendar['at']> = null;
  try {
    x = cal.at(typeof ts === 'number' ? ts : +ts);
  } catch {
    x = null;
  }
  if (!x || x.id == null) return [];
  const sid = String(x.id);
  const names: Record<string, string> = {};
  for (const r of (doc as CrewDoc).roles) names[r.id] = r.name;
  const shift = x;
  return crewOn(doc, siteId, shift.productionDay, sid, mo).map((c) => ({
    role: c.role,
    roleName: names[c.role] || 'Crew',
    userId: c.user,
    shiftId: sid,
    shiftName: shift.name || '',
    productionDay: shift.productionDay,
    start: shift.start,
    end: shift.end,
  }));
}

const MGR_RE = /manager|supervisor|lead/i;
/** A crew role that leads a shift: its name or id says manager, supervisor or lead (App UI U-135). */
export function isManager(r: { id?: unknown; name?: unknown } | string | null | undefined): boolean {
  if (r === null || r === undefined) return false;
  if (typeof r === 'string') return MGR_RE.test(r);
  return MGR_RE.test(String(r.name || '')) || MGR_RE.test(String(r.id || ''));
}
/** { roleId: 'PO' } short labels (initials, unique). */
export function abbr(roles: { id: string; name?: string }[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const used: Record<string, boolean> = {};
  const list = isArray(roles) ? roles : DEFAULT;
  for (const r of list) {
    const w = String(r.name || '')
      .split(/[\s\-_/]+/)
      .filter(Boolean);
    const s = (w.length > 1 ? w[0].charAt(0) + w[1].charAt(0) : (w[0] || '?').slice(0, 2)).toUpperCase();
    let t = s;
    let k = 2;
    while (used[t]) t = s + k++;
    used[t] = true;
    out[r.id] = t;
  }
  return out;
}
