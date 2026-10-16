/**
 * core/shifts.ts — which shift calendar applies to a machine or a location (D-047).
 *
 * The shifts themselves are configured in the iMEX app (Configuration › Shifts, App UI repo docs/SHIFTS.md):
 * SERVER_SCOPE attributes `imexShifts` (dated versions of shifts, holidays) on the machine, its site and the
 * organisation asset above it, plus `imexTimeZone` on the assets, and a last fallback `imexShifts` on the app's
 * System Configuration asset. The calendar maths is core/shiftcal.ts (the TypeScript copy of the shared core).
 *
 * calendarFor(ctx, id) builds the chain nearest first, exactly like the app's shift directory (shiftdir.js):
 *   the entity itself, its ancestors in the user's scope (ctx.nodes, parent by parent), the ancestors above the scope
 *   root (ctx.assign.aboveRoot), then System Configuration. The zone is the nearest `imexTimeZone` on an ASSET of
 *   that path (a device's own is never read), else UTC.
 * Requests: one Entity Data Query for the assets and one for the device of a chain, plus one lookup of the System
 * Configuration asset per page; results are kept for 5 minutes per entity, and dropped at once when the app's
 * `imexAppConfig.shiftsRev` changes (window.__imexApp.config, else the side menu's 'imx-app-config' cache).
 * A chain where no level has a version gives null: callers then say that no shifts are set and never guess.
 */
import * as api from './api';
import * as scope from './scope';
import type { UserContext } from './scope';
import { calendar, isValidTimeZone, offset } from './shiftcal';
import type { ShiftCalendar } from './shiftcal';
import * as dfmt from './datefmt';

const TTL = 5 * 60e3;

/** imexAppConfig.shiftsRev as this page knows it ('' when not set or unreadable). */
export function shiftsRev(): string {
  try {
    const w: any = typeof window !== 'undefined' ? window : {};
    let c = w.__imexApp?.config;
    if (!c && typeof localStorage !== 'undefined') c = JSON.parse(localStorage.getItem('imx-app-config') || 'null');
    const r = Number(c?.shiftsRev);
    return r > 0 ? String(r) : '';
  } catch {
    return '';
  }
}

/** The chain of one entity: documents nearest first, the zone, and the names of the levels (for labels). */
export interface ShiftChain {
  chain: unknown[];
  tz: string;
  levels: { id: string; name: string; own: boolean }[];
}

interface Entry {
  at: number;
  rev: string;
  p: Promise<ShiftChain>;
}
const chains = new Map<string, Entry>();
let sysP: { at: number; rev: string; p: Promise<{ id: string; name: string; shifts?: unknown } | null> } | null = null;

/** Forgets every cached chain (tests; the app's shift settings changed). */
export function clearShiftCache() {
  chains.clear();
  sysP = null;
}

function systemConfig(rev: string) {
  if (!sysP || sysP.rev !== rev || Date.now() - sysP.at > TTL) {
    const p = api.systemConfigShifts().catch(() => null);
    sysP = { at: Date.now(), rev, p };
    // a failed lookup is asked again next time
    void p.then((v) => {
      if (!v && sysP?.p === p) sysP = null;
    });
  }
  return sysP.p;
}

/** The ids of the path from `id` up: the entity, its in-scope ancestors, then those above the scope root. */
function pathOf(ctx: UserContext, id: string): { id: string; name: string; type: 'ASSET' | 'DEVICE' }[] {
  const self = ctx.nodes.get(id);
  const out: { id: string; name: string; type: 'ASSET' | 'DEVICE' }[] = [{ id, name: self?.label ?? '', type: self?.entityType === 'ASSET' ? 'ASSET' : 'DEVICE' }];
  const inScope = scope.ancestors(ctx, id);
  for (const a of inScope) out.push({ id: a.id, name: a.label, type: 'ASSET' });
  const top = inScope.length ? inScope[inScope.length - 1].id : id;
  for (const a of ctx.assign?.aboveRoot.get(top) ?? []) if (!out.some((x) => x.id === a.id)) out.push({ id: a.id, name: a.label || a.name, type: 'ASSET' });
  return out;
}

/**
 * The shift chain of a machine or a location (see the file header). Never rejects: a failed read gives an empty
 * chain (no shifts), which is not cached.
 */
export function chainFor(ctx: UserContext, id: string): Promise<ShiftChain> {
  const rev = shiftsRev();
  const hit = chains.get(id);
  if (hit && hit.rev === rev && Date.now() - hit.at < TTL) return hit.p;
  const path = pathOf(ctx, id);
  const p = (async (): Promise<ShiftChain> => {
    const [attrs, sc] = await Promise.all([
      api.shiftAttrs(
        path.filter((x) => x.type === 'ASSET').map((x) => x.id),
        path.filter((x) => x.type === 'DEVICE').map((x) => x.id),
      ),
      systemConfig(rev),
    ]);
    const chain: unknown[] = [];
    const levels: ShiftChain['levels'] = [];
    let tz: string | null = null;
    for (const x of path) {
      if (sc && x.id === sc.id) continue;
      const a = attrs.get(x.id);
      chain.push(a?.shifts ?? null);
      levels.push({ id: x.id, name: a?.name || x.name, own: a?.shifts != null });
      if (tz === null && x.type === 'ASSET' && a?.tz) tz = a.tz;
    }
    if (sc) {
      chain.push(sc.shifts ?? null);
      levels.push({ id: sc.id, name: sc.name, own: sc.shifts != null });
    }
    return { chain, tz: tz && isValidTimeZone(tz) ? tz : 'UTC', levels };
  })();
  const entry: Entry = {
    at: Date.now(),
    rev,
    p: p.catch(() => {
      if (chains.get(id) === entry) chains.delete(id);
      return { chain: [], tz: 'UTC', levels: [] };
    }),
  };
  chains.set(id, entry);
  return entry.p;
}

/** True when some level of the chain has at least one version (else there is nothing to compute). */
function hasVersions(chain: unknown[]): boolean {
  return chain.some((d) => {
    const doc = typeof d === 'string' ? api.parseMaybeJson(d) : d;
    return !!doc && typeof doc === 'object' && Array.isArray((doc as any).versions) && (doc as any).versions.length > 0;
  });
}

/**
 * The shift calendar of a machine or a location, or null when no level of its chain has shifts (or the read failed).
 */
export async function calendarFor(ctx: UserContext, id: string | null | undefined): Promise<ShiftCalendar | null> {
  if (!id) return null;
  const c = await chainFor(ctx, id);
  if (!hasVersions(c.chain)) return null;
  try {
    return calendar({ chain: c.chain as any, tz: c.tz });
  } catch {
    return null;
  }
}

/** The shift part of a resolved window (schema.RangeWindow), as rangeWindow gives it. */
interface ShownWindow {
  shift?: { name: string; start: number; end: number };
  between?: boolean;
}

/**
 * Header text for a shift window: "Morning · 6:00 AM–2:00 PM" (the app's clock decides 12 or 24 hours; clock.js
 * patches toLocaleTimeString). Times are wall times in the site's zone `tz`, as the app's Sites and Andon pages show
 * them; when the browser is in another zone at that moment, the zone's city is added ("… (New York time)").
 * "Between shifts · " in front when the current-shift range shows the previous shift; 'No shifts set' without one.
 */
export function shiftWindowText(win: ShownWindow | null | undefined, tz = 'UTC'): string {
  if (!win?.shift) return 'No shifts set';
  const { name, start, end } = win.shift;
  const t = (ts: number) => {
    try {
      return dfmt.time(ts, { tz }); // D-061 (M2): the app's format and clock
    } catch {
      return dfmt.time(ts);
    }
  };
  let where = '';
  try {
    const browser = new Date(start).getTimezoneOffset();
    if (-browser !== offset(start, tz)) where = ` (${tz.split('/').pop()!.replace(/_/g, ' ')} time)`;
  } catch {
    /* no zone note */
  }
  return `${win.between ? 'Between shifts · ' : ''}${name} · ${t(start)}–${t(end)}${where}`;
}
