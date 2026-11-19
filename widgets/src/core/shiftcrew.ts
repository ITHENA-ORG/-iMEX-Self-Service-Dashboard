/**
 * core/shiftcrew.ts — the shift and the crew on shift, worked out in the browser (D-096; App UI U-218).
 *
 * Used by the "Current shift" card (widget type 'shiftinfo') and by the computed properties a value card, a status
 * indicator and a multi-value card can pick: "Current shift" (key `@shift`) and one "On shift: <crew role>" per role of
 * the roster (key `@crew:<roleId>`). Nothing is stored and nothing runs on the server: the shift comes from the shift
 * calendar (core/shifts.ts, cached 5 minutes per entity), the people from the crew roster (`imexCrew` on System
 * Configuration, read at most every 2 minutes per page) and their names from the customer's user list (the app's own
 * way: GET /api/users for a customer user, /api/customer/{id}/users for a tenant administrator; at most every 5
 * minutes per page). A failed read is not cached.
 *
 * Who sees names (Akshay, 19 Nov 2026, "Option 1"): everyone who can open the dashboard. The Crew roster permission
 * controls only the app's Settings › Crew roster page, not these cards. When the user list cannot be read at all, the
 * cards say "Names not available" (a person missing from a list that was read: "Name not available").
 *
 * The site of a machine is the asset that directly Contains it (as the app's crew core and shift directory say); a
 * site's crew uses the site's shift calendar (a machine's own shift override does not change who is on shift there).
 */
import * as api from './api';
import type { UserContext } from './scope';
import * as crew from './crew';
import type { CrewDoc, OnShiftRow } from './crew';
import { calendarFor, chainFor } from './shifts';
import type { ShiftCalendar, ShiftInstance } from './shiftcal';
import type { KeyMeta } from './types';

/** Key of the computed property "Current shift". */
export const SHIFT_KEY = '@shift';
/** Prefix of the computed properties "On shift: <crew role>" (`@crew:<roleId>`). */
export const CREW_PREFIX = '@crew:';
const COMPUTED_RE = /^@(?:shift|crew:[A-Za-z0-9_-]{1,40})$/;
/** True for a computed property key (never a reading of a machine). */
export const isComputed = (key: string | null | undefined): boolean => typeof key === 'string' && COMPUTED_RE.test(key);
/** The widget types that offer the computed properties (they show text). */
export const COMPUTED_TYPES = new Set(['value', 'status', 'multivalue']);

const ROSTER_MS = 2 * 60e3;
const NAMES_MS = 5 * 60e3;
let roster: { at: number; p: Promise<CrewDoc | null> } | null = null;
let names: { at: number; key: string; p: Promise<Map<string, string> | null> } | null = null;

/** Forgets the cached roster and names (tests; after a save elsewhere). */
export function clearCrewCache() {
  roster = null;
  names = null;
}

/** The roster (parsed), null when the user sees no configuration asset or the read failed. */
export function loadRoster(): Promise<CrewDoc | null> {
  if (roster && Date.now() - roster.at < ROSTER_MS) return roster.p;
  const p = api
    .systemConfigCrew()
    .then((r) => (r ? crew.parse(r.raw) : null))
    .catch(() => {
      if (roster?.p === p) roster = null;
      return null;
    });
  roster = { at: Date.now(), p };
  return p;
}

/** The roster's roles as soon as it is known (synchronous; [] before the first load or without a roster). */
let rolesNow: { id: string; name: string }[] = [];
export function knownRoles(): { id: string; name: string }[] {
  return rolesNow;
}
/** Loads the roster and remembers its roles for the property pickers. */
export async function loadRoles(): Promise<{ id: string; name: string }[]> {
  const d = await loadRoster();
  rolesNow = d ? d.roles.map((r) => ({ id: r.id, name: r.name })) : [];
  return rolesNow;
}

/** The catalogue entries of the computed properties (roles: the roster's, in order). */
export function computedMetas(roles: { id: string; name: string }[] = rolesNow): KeyMeta[] {
  const m = (key: string, displayName: string): KeyMeta => ({ key, displayName, unit: '', decimals: 0, min: 0, max: 0, type: 'string' });
  return [m(SHIFT_KEY, 'Current shift'), ...roles.map((r) => m(CREW_PREFIX + r.id, `On shift: ${r.name}`))];
}
/** The catalogue entry of one computed key (a role no longer in the roster keeps a plain name). */
export function computedMeta(key: string): KeyMeta {
  const hit = computedMetas().find((m) => m.key === key);
  if (hit) return hit;
  return { key, displayName: key === SHIFT_KEY ? 'Current shift' : 'On shift', unit: '', decimals: 0, min: 0, max: 0, type: 'string' };
}

/** user id -> display name of the app customer's people; null when the list could not be read. */
export function loadNames(ctx: Pick<UserContext, 'customerId' | 'perms'>): Promise<Map<string, string> | null> {
  const tenant = !!ctx.perms?.unrestricted;
  const key = `${tenant ? 't' : 'c'}:${ctx.customerId || ''}`;
  if (names && names.key === key && Date.now() - names.at < NAMES_MS) return names.p;
  const p = (async () => {
    let cid: string | null = null;
    if (tenant) {
      cid = ctx.customerId || '';
      if (!cid) {
        const sc = await api.systemConfigCrew().catch(() => null);
        cid = sc ? await api.assetCustomer(sc.id).catch(() => '') : '';
      }
      if (!cid) throw new Error('no customer');
    }
    const list = await api.customerPeople(cid);
    return new Map(list.map((u) => [u.id, u.name]));
  })().catch((): Map<string, string> | null => {
    if (names?.p === p) names = null;
    return null;
  });
  names = { at: Date.now(), key, p };
  return p;
}

/** The site of a machine: the asset that directly Contains it (in scope, else the first one above the scope root). */
export function siteOf(ctx: Pick<UserContext, 'nodes' | 'assign'>, id: string): { id: string; name: string } | null {
  const n = ctx.nodes.get(id);
  if (n && n.entityType === 'ASSET') return { id: n.id, name: n.label };
  const parent = n?.parentId ? ctx.nodes.get(n.parentId) : undefined;
  if (parent && parent.entityType === 'ASSET') return { id: parent.id, name: parent.label };
  const above = ctx.assign?.aboveRoot.get(id)?.[0];
  return above ? { id: above.id, name: above.label || above.name } : null;
}

/** The shift picture of a machine or a site at ts. cal null: no shifts are set up there. */
export interface ShiftNow {
  cal: ShiftCalendar | null;
  tz: string;
  cur: ShiftInstance | null;
  prev: ShiftInstance | null;
  next: ShiftInstance | null;
}
export async function shiftNow(ctx: UserContext, id: string, ts = Date.now()): Promise<ShiftNow> {
  const cal = await calendarFor(ctx, id);
  if (!cal) return { cal: null, tz: 'UTC', cur: null, prev: null, next: null };
  const safe = <T>(f: () => T): T | null => {
    try {
      return f();
    } catch {
      return null;
    }
  };
  return { cal, tz: cal.tz, cur: safe(() => cal.at(ts)), prev: safe(() => cal.previous(ts)), next: safe(() => cal.next(ts)) };
}

/** Who is on shift at a site: rows with names, or why there are none. */
export interface CrewNow {
  /** 'noSite': the machine is not at a site; 'noRoster': nobody on the site's
   * roster and nothing planned there (or no roster at all);
   * 'noShifts': no shifts are set up for the site; 'noShift': no shift runs now; 'ok': rows (possibly empty: nobody
   * planned). */
  state: 'noSite' | 'noRoster' | 'noShifts' | 'noShift' | 'ok';
  roles: { id: string; name: string }[];
  rows: (OnShiftRow & { name: string })[];
  /** false: the user list could not be read (every name is NO_NAMES) */
  named?: boolean;
}
/** Name shown for a person the user list does not have (a removed user). */
export const NO_NAME = 'Name not available';
/** Shown instead of names when the user list could not be read at all. */
export const NO_NAMES = 'Names not available';

export async function crewNow(ctx: UserContext, siteId: string | null, ts = Date.now()): Promise<CrewNow> {
  if (!siteId) return { state: 'noSite', roles: [], rows: [] };
  const doc = await loadRoster();
  if (doc) rolesNow = doc.roles.map((r) => ({ id: r.id, name: r.name }));
  // nobody on the site's roster and nothing planned there: the site has no roster yet
  if (!doc || !crew.people(doc, siteId).length) return { state: 'noRoster', roles: doc ? doc.roles.map((r) => ({ id: r.id, name: r.name })) : [], rows: [] };
  const [cal, chain] = await Promise.all([calendarFor(ctx, siteId), chainFor(ctx, siteId)]);
  const roles = doc.roles.map((r) => ({ id: r.id, name: r.name }));
  if (!cal) return { state: 'noShifts', roles, rows: [] };
  let cur: ShiftInstance | null = null;
  try {
    cur = cal.at(ts);
  } catch {
    cur = null;
  }
  if (!cur) return { state: 'noShift', roles, rows: [] };
  const on = crew.onShift(siteId, ts, { doc, calendar: cal, chain: chain.chain });
  const who = on.length ? await loadNames(ctx) : new Map<string, string>();
  return { state: 'ok', roles, named: !!who, rows: on.map((r) => ({ ...r, name: who ? who.get(r.userId) || NO_NAME : NO_NAMES })) };
}

/** What a computed property shows: a text and an optional line under it, or a sentence instead. */
export type Computed = { text: string; sub?: string; muted?: boolean } | { message: string };

/** Short "2 h 15 min" / "45 min" / "less than a minute". */
export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60e3));
  if (m < 1) return 'less than a minute';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h} h${r ? ` ${r} min` : ''}` : `${r} min`;
}

/**
 * The value of a computed property for a machine at ts. `time(ts, tz)` formats a time in the site's zone (the card
 * passes the app's format).
 */
export async function computedValue(ctx: UserContext, key: string, deviceId: string, ts: number, time: (t: number, tz: string) => string): Promise<Computed> {
  if (key === SHIFT_KEY) {
    const s = await shiftNow(ctx, deviceId, ts);
    if (!s.cal) return { text: 'No shifts set up', muted: true };
    if (!s.cur) return { text: 'Between shifts', sub: s.next ? `Next: ${s.next.name} at ${time(s.next.start, s.tz)}` : undefined, muted: true };
    return { text: s.cur.name, sub: `${time(s.cur.start, s.tz)}–${time(s.cur.end, s.tz)} · ${duration(s.cur.end - ts)} left` };
  }
  const roleId = key.slice(CREW_PREFIX.length);
  const site = siteOf(ctx, deviceId);
  const c = await crewNow(ctx, site?.id ?? null, ts);
  if (c.state === 'noSite') return { text: '—', sub: 'This machine is not at a site', muted: true };
  if (c.state === 'noRoster') return { text: '—', sub: 'No crew roster for this site yet', muted: true };
  if (!c.roles.some((r) => r.id === roleId)) return { text: '—', sub: 'This crew role is no longer in the roster', muted: true };
  if (c.state === 'noShifts') return { text: 'No shifts set up', muted: true };
  if (c.state === 'noShift') return { text: 'Between shifts', muted: true };
  const list = c.rows.filter((r) => r.role === roleId);
  if (!list.length) return { text: 'Nobody planned', sub: c.rows[0]?.shiftName || undefined, muted: true };
  if (c.named === false) return { text: NO_NAMES, sub: list[0].shiftName || undefined, muted: true };
  return { text: list.map((r) => r.name).join(', '), sub: list[0].shiftName || undefined };
}
