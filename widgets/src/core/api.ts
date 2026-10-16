// core/api.ts — thin browser-side REST client for the ThingsBoard CE API.
//
// Purpose: every ThingsBoard call made by the widgets (builder, renderer, listing, launcher) goes
// through here. There is no backend of our own (DECISIONS D-010): calls run as the LOGGED-IN user
// with the JWT the ThingsBoard UI keeps in `localStorage.jwt_token`. No tenant credentials exist in
// the widgets, so every call is limited to what that user may do in CE (see D-012 for what a
// customer user can and cannot write).
//
// Token refresh: the ThingsBoard UI refreshes its token lazily. `bindWidgetContext(ctx)` (called by
// entries/common.ts for every widget) stores a hook that makes one call through the TB UI's own
// Angular HttpClient (`ctx.http`), which refreshes `jwt_token` as a side effect. `request()` uses it
// once per call on a 401 and then retries with the new token.
//
// Retries: 429 and 5xx are retried up to 3 times with exponential back-off (0.8 s, 1.6 s, 3.2 s).
//
// Main exports:
//   request / get / post          low-level call; JSON in, JSON out; throws ApiError on non-2xx
//   getAttrs / saveAttrs / deleteAttrs   attributes (SERVER_SCOPE by default) of any entity
//   latest / series               device timeseries (latest values, windowed history). Both read the
//                                 WebSocket live cache (core/live.ts, D-021) first and use REST only until
//                                 the subscription is ready or while the socket is down.
//   getCached                     GET with a time-to-live while the socket is live (bar buckets, heatmap, alarms)
//   windowAgg                     MIN/MAX/AVG/SUM of a window; kept current from pushed points while live (D-048)
//   alarms                        alarm list of an entity (/api/v2/alarm); 15 s cache while live
//   childrenOf / parentsOf        relations (default type `Contains`, the hierarchy relation)
//   devicesByIds / assetsByIds    bulk entity lookup (chunks of 100 ids)
//   relationsTree                 every Contains relation below / above an entity in ONE call (D-022)
//   entityData                    names, labels, profiles, SERVER attributes and latest telemetry of many
//                                 entities in ONE call (Entity Data Query, D-022)
//   latestMany                    latest values of many devices: live cache, else one entityData call (D-022)
//   activeAlarmCounts             active alarm count per device in ONE call (Alarm Data Query, D-022)
//   timeseriesKeys                telemetry keys a device has ever reported
//
// ThingsBoard endpoints used:
//   GET  /api/plugins/telemetry/{type}/{id}/values/attributes/{scope}?keys=
//   POST /api/plugins/telemetry/{type}/{id}/attributes/{scope}           (upsert; one call per write)
//   DELETE /api/plugins/telemetry/{type}/{id}/{scope}?keys=
//   GET  /api/plugins/telemetry/DEVICE/{id}/values/timeseries            (latest, or windowed with startTs/endTs)
//   GET  /api/plugins/telemetry/DEVICE/{id}/keys/timeseries
//   GET  /api/v2/alarm/{type}/{id}
//   GET  /api/relations/info/{from|to}/{type}/{id} (TB 4.3+), else /api/relations/info?fromId=|toId= (D-035)
//   GET  /api/devices?deviceIds=, /api/assets?assetIds=
//   POST /api/relations                                                 (EntityRelationsQuery, whole subtree)
//   POST /api/entitiesQuery/find                                        (Entity Data Query)
//   POST /api/alarmsQuery/find                                          (Alarm Data Query)
//   GET  /api/auth/user (refresh hook; also used by core/scope.ts)
//
// ThingsBoard quirks to keep in mind when changing this file (see DECISIONS "ThingsBoard quirks"):
//   - `values/timeseries` returns at most 100 points when `limit` is omitted with agg NONE, so
//     `series()` always passes `limit`.
//   - Name lookups such as /api/tenant/assets?assetName= return 404 (not an empty page) when nothing
//     matches; pass `allow404` to `request()` to get `null` instead of an exception.
//   - Attribute values written as objects come back as JSON strings; `getAttrs()` parses them back.

/** Minimal ThingsBoard entity id: `{ id: uuid, entityType: 'DEVICE' | 'ASSET' | 'USER' | ... }`. */
import { liveHub } from './live';
import { watchAlarmCounts } from './tb-socket';
import type { CountSpec, CountWatch } from './tb-socket';

export interface EntityRef {
  id: string;
  entityType: string;
}

/**
 * Non-2xx response from ThingsBoard (or 401 "Not logged in" when no JWT is present).
 * `status` is the HTTP status, `path` the request path, `body` the raw response text; the message
 * keeps only the first 200 characters of the body.
 */
export class ApiError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`${status} ${path}: ${body.slice(0, 200)}`);
  }
}

type RefreshHook = () => Promise<void>;
let refreshHook: RefreshHook | null = null;

/**
 * Registers the ThingsBoard widget context so a 401 can trigger the TB UI's own token refresh.
 * The hook calls GET /api/auth/user through `ctx.http` (Angular HttpClient with TB's interceptors,
 * which refresh `localStorage.jwt_token`) and resolves whether that call succeeds or not.
 * Module-global: the last bound context wins, which is fine because all widgets on a page share
 * one login. Without a ctx (tests, harness) 401s are thrown straight away.
 * @param ctx ThingsBoard widget `self.ctx`; ignored when it has no `http`.
 */
export function bindWidgetContext(ctx: any) {
  if (!ctx?.http) return;
  refreshHook = () =>
    new Promise<void>((resolve) => {
      try {
        // D-045: quiet (no ThingsBoard toast or loading bar); the 401 refresh still runs in its interceptor
        const opts = ctx.httpUtils?.defaultHttpOptionsFromConfig?.({ ignoreErrors: true, ignoreLoading: true }) ?? {};
        ctx.http.get('/api/auth/user', opts).subscribe({ next: () => resolve(), error: () => resolve() });
      } catch {
        resolve();
      }
    });
}

/** Current JWT of the logged-in user. Throws ApiError(401) when the TB UI holds no token. */
function token(): string {
  const t = localStorage.getItem('jwt_token');
  if (!t) throw new ApiError(401, 'auth', 'Not logged in');
  return t;
}

/**
 * Performs one REST call as the logged-in user (`X-Authorization: Bearer <jwt>`).
 * - 401: refreshes the token once through the bound widget ctx, then retries.
 * - 429 / 5xx: retried up to 3 times with back-off 0.8 s, 1.6 s, 3.2 s.
 * - 404 with `allow404`: returns null (TB returns 404 for empty name lookups).
 * @param method HTTP method.
 * @param path   absolute ThingsBoard path, e.g. `/api/auth/user` (same origin as the TB UI).
 * @param body   JSON-serialised when given; sets Content-Type.
 * @returns parsed JSON body, or null for an empty body.
 * @throws ApiError for any other non-2xx status.
 */
export async function request<T = any>(method: string, path: string, body?: unknown, allow404 = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { 'X-Authorization': `Bearer ${token()}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && attempt === 0 && refreshHook) {
      await refreshHook();
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    if (res.status === 404 && allow404) return null as T;
    if (!res.ok) throw new ApiError(res.status, path, text);
    return (text ? JSON.parse(text) : null) as T;
  }
}

/** GET shorthand for `request()`. */
/**
 * GET with in-flight de-duplication (D-028): identical GETs that overlap (two widgets asking for the same
 * series, or a refresh started while the previous one is still waiting on a slow server) share one request.
 */
export const get = <T = any>(p: string): Promise<T> => {
  const cur = inflight.get(p);
  if (cur) return cur as Promise<T>;
  const req = request<T>('GET', p).finally(() => inflight.delete(p));
  inflight.set(p, req);
  return req;
};
const inflight = new Map<string, Promise<unknown>>();
/** POST shorthand for `request()`. */
export const post = <T = any>(p: string, b?: unknown) => request<T>('POST', p, b);

// ---------- attributes ----------

/**
 * Reads attributes of an entity.
 * @param e     entity to read from.
 * @param keys  keys to read; omitted or empty = all keys in the scope.
 * @param scope 'SERVER_SCOPE' (default), 'SHARED_SCOPE' or 'CLIENT_SCOPE'.
 * @returns key -> value; JSON-looking strings are parsed (see `parseMaybeJson`). Missing keys are
 *          simply absent from the result.
 */
export async function getAttrs(e: EntityRef, keys?: string[], scope = 'SERVER_SCOPE'): Promise<Record<string, any>> {
  const q = keys?.length ? `?keys=${encodeURIComponent(keys.join(','))}` : '';
  const rows = await get<{ key: string; value: any }[]>(`/api/plugins/telemetry/${e.entityType}/${e.id}/values/attributes/${scope}${q}`);
  const out: Record<string, any> = {};
  for (const r of rows) out[r.key] = parseMaybeJson(r.value);
  return out;
}

/**
 * Writes (upserts) attributes on an entity; objects are stored as JSON by ThingsBoard.
 * Only the given keys change; others are kept. Customer users may write SERVER/SHARED attributes on
 * any device/asset of their customer and on their own user (D-012), so callers must do their own
 * permission checks (UI-only enforcement).
 */
export function saveAttrs(e: EntityRef, attrs: Record<string, unknown>, scope = 'SERVER_SCOPE') {
  writes++;
  return post(`/api/plugins/telemetry/${e.entityType}/${e.id}/attributes/${scope}`, attrs).finally(() => writes++);
}

/** Deletes attribute keys from an entity in the given scope (default SERVER_SCOPE). */
export function deleteAttrs(e: EntityRef, keys: string[], scope = 'SERVER_SCOPE') {
  writes++;
  return request('DELETE', `/api/plugins/telemetry/${e.entityType}/${e.id}/${scope}?keys=${encodeURIComponent(keys.join(','))}`).finally(() => writes++);
}

// D-046: counts attribute writes (at the start and at the end of each), so a short read cache can tell that
// nothing was written in between (core/store.ts listDashboards).
let writes = 0;
/** Changes whenever an attribute write starts or ends. */
export const writeEpoch = () => writes;

/**
 * Returns `v` parsed as JSON when it is a string that looks like an object or array
 * (starts with `{` or `[`); otherwise, or when parsing fails, returns `v` unchanged.
 */
export function parseMaybeJson(v: any): any {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

// ---------- telemetry ----------

// ---------- data clock (D-033) ----------
// Newest data-point timestamp handed to the widgets (latest values and series), for the machine page's
// "Updated x ago". Reset by the renderer when it loads another dashboard.
let dataTs = 0;
/** Records data-point timestamps (ms); the newest one wins. Future timestamps are capped at now. */
export function noteData(...ts: number[]) {
  const now = Date.now();
  for (const t of ts) if (Number.isFinite(t) && t > dataTs) dataTs = Math.min(t, now);
}
/** Newest data-point timestamp seen since the last reset (0 = none yet). */
export const lastDataTs = () => dataTs;
/** Forgets the data clock (a new dashboard is loading). */
export const resetDataClock = () => (dataTs = 0);
const noteLatestTs = (l: Latest) => {
  for (const v of Object.values(l)) if (v) noteData(v.ts);
  return l;
};

/** Latest value per key; a key is absent/undefined when the device has no (non-empty) value for it. */
export type Latest = Record<string, { ts: number; value: number | string } | undefined>;

/**
 * Latest telemetry values of a device (GET values/timeseries without a time window).
 * Values that look numeric are converted to numbers; null/empty values are dropped.
 * `quiet` = don't move the data clock (header status reads that aren't shown as widget data).
 */
export async function latest(deviceId: string, keys: string[], quiet = false): Promise<Latest> {
  if (!keys.length) return {};
  const noteLatest = quiet ? (l: Latest) => l : noteLatestTs;
  // Live cache first (WebSocket, D-021); REST only until the subscription's first reply or while the socket is down.
  const L = liveHub();
  if (L) {
    L.want(deviceId, keys);
    // cold page: give the socket a moment (it is usually ready in a few hundred ms) instead of a REST call
    const c = L.get(deviceId, keys) ?? ((await L.waitReady(deviceId, keys, LIVE_WAIT_MS)) ? L.get(deviceId, keys) : null);
    if (c) return noteLatest(c as Latest);
  }
  const r = await get<Record<string, { ts: number; value: string }[]>>(
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${encodeURIComponent(keys.join(','))}`,
  );
  const out: Latest = {};
  for (const k of keys) {
    const p = r?.[k]?.[0];
    if (p && p.value !== null && p.value !== undefined && String(p.value) !== '') out[k] = { ts: p.ts, value: toNum(p.value) };
  }
  return noteLatest(out);
}

/**
 * D-061: the last value per key at or before `endTs` (a window that has ended: the values a card shows for it), looking
 * back at most 30 days. REST: GET values/timeseries?agg=NONE&orderBy=DESC&limit=1 over [endTs − 30 d, endTs] (ThingsBoard
 * applies the limit per key). Kept 5 minutes while the WebSocket is live (getCached). Does not move the data clock.
 */
export async function latestAt(deviceId: string, keys: string[], endTs: number): Promise<Latest> {
  if (!keys.length) return {};
  const end = Math.floor(endTs);
  const r = await getCached<Record<string, { ts: number; value: string }[]>>(
    `at|${deviceId}|${keys.join(',')}|${Math.floor(end / 60e3)}`,
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${encodeURIComponent(keys.join(','))}&startTs=${end - 30 * 86400e3}&endTs=${end}&agg=NONE&orderBy=DESC&limit=1`,
    5 * 60e3,
  );
  const out: Latest = {};
  for (const k of keys) {
    const p = r?.[k]?.[0];
    if (p && p.value !== null && p.value !== undefined && String(p.value) !== '') out[k] = { ts: p.ts, value: toNum(p.value) };
  }
  return out;
}

/**
 * How long `latest()` / `latestMany()` wait for a WebSocket subscription that is still being set up before
 * falling back to REST (D-022). Short enough that a slow socket costs little; long enough for the usual case.
 */
export const LIVE_WAIT_MS = 1500;

/** ThingsBoard aggregation function for `series()`. */
export type Agg = 'NONE' | 'AVG' | 'MIN' | 'MAX' | 'SUM';

/**
 * Timeseries of a device between `startTs` and `endTs` (ms), sorted ascending by ts.
 * Picks an aggregation interval (`pickInterval`) so each series has at most about `maxPoints`
 * points, and always passes `limit` (TB returns only 100 points without it).
 * Raw data (`agg` NONE) is switched to AVG when the span is long (more than maxPoints x 10 s),
 * to avoid huge responses.
 * @param opts.fixedStart the window grows from a fixed start to now (the D-047 'shift' range).
 * @returns key -> points; a key with no data maps to an empty array. Non-numeric values are kept as
 *          they come (typed as number for the charts).
 */
export async function series(
  deviceId: string,
  keys: string[],
  startTs: number,
  endTs: number,
  agg: Agg = 'AVG',
  maxPoints = 500,
  opts: { fixedStart?: boolean } = {},
): Promise<Record<string, { ts: number; value: number }[]>> {
  if (!keys.length) return {};
  // Cache + live append (D-021). A window ending "now" with AVG/NONE aggregation is fetched over REST once,
  // then extended with the points pushed over the WebSocket; it is re-fetched every 5 minutes (bucket drift).
  // SUM/MIN/MAX windows and past windows can't be extended point by point: they are re-fetched after 55 s /
  // 5 min. With the socket down the cache is bypassed (REST every call, the pre-D-021 behaviour).
  const L = liveHub();
  const now = Date.now();
  const offsetMin = Math.round((now - endTs) / 60e3);
  const appendable = !!L && (agg === 'AVG' || agg === 'NONE') && offsetMin <= 1;
  // D-047: windows that don't slide with the clock are keyed by where they are, not by their length: a past window
  // (the previous shift) by its start and end, a window growing from a fixed start (the current shift so far) by
  // its start, so it is extended with live points instead of being read again each minute as its length changes.
  const at = (t: number) => Math.floor(t / 60e3);
  const win = offsetMin > 1 ? `${at(startTs)}-${at(endTs)}` : opts.fixedStart ? `@${at(startTs)}` : `${Math.round((endTs - startTs) / 60e3)}|${offsetMin}`;
  const ck = `s|${deviceId}|${keys.join(',')}|${agg}|${maxPoints}|${win}`;
  if (L && appendable) L.want(deviceId, keys);
  if (L?.isLive()) {
    const c = seriesCache.get(ck);
    if (c) {
      const age = now - c.fetchedAt;
      const since = appendable ? L.liveSince(deviceId, keys) : null;
      if (appendable && since != null && since <= c.fetchedAt && age < 5 * 60e3) {
        const out: Record<string, { ts: number; value: number }[]> = {};
        for (const k of keys) {
          const base = c.data[k] ?? [];
          const lastTs = base.length ? base[base.length - 1].ts : c.fetchedAt - 1;
          const extra = (L.since(deviceId, k, lastTs) ?? []).map((p) => ({ ts: p.ts, value: p.value as number }));
          out[k] = base.concat(extra).filter((p) => p.ts >= startTs);
        }
        return noteSeries(out);
      }
      if (!appendable && age < (offsetMin > 1 ? 5 * 60e3 : 55e3)) return noteSeries(c.data);
    }
  }
  const span = Math.max(1, endTs - startTs);
  const interval = pickInterval(span, maxPoints);
  // assumes roughly one sample per 10 s (the simulator rate)
  const useAgg = agg === 'NONE' && span / 10000 > maxPoints ? 'AVG' : agg;
  const q =
    `keys=${encodeURIComponent(keys.join(','))}&startTs=${startTs}&endTs=${endTs}&limit=${maxPoints * 4}` +
    (useAgg === 'NONE' ? '&agg=NONE&orderBy=ASC' : `&agg=${useAgg}&interval=${interval}&orderBy=ASC`);
  const r = await get<Record<string, { ts: number; value: string }[]>>(`/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?${q}`);
  const out: Record<string, { ts: number; value: number }[]> = {};
  for (const k of keys) out[k] = (r?.[k] ?? []).map((p) => ({ ts: p.ts, value: toNum(p.value) as number })).sort((a, b) => a.ts - b.ts);
  if (L) cachePut(seriesCache, ck, { fetchedAt: now, data: out });
  return noteSeries(out);
}

/** Notes the last point of every series on the data clock. Aggregated buckets carry their start time. */
function noteSeries<T extends Record<string, { ts: number }[]>>(d: T): T {
  for (const pts of Object.values(d)) if (pts.length) noteData(pts[pts.length - 1].ts);
  return d;
}

// ---------- caches used while the WebSocket is live (D-021) ----------

const seriesCache = new Map<string, { fetchedAt: number; data: Record<string, { ts: number; value: number }[]> }>();
/** Alarm lists read while the entity's counts are pushed (D-046): kept while the counts (sig) are the same. */
const gatedCache = new Map<string, { fetchedAt: number; sig: string; data: any }>();
const getCache = new Map<string, { fetchedAt: number; data: any }>();

/** Map insert with a 300-entry cap (oldest dropped first). */
function cachePut<V>(m: Map<string, V>, k: string, v: V) {
  m.delete(k);
  m.set(k, v);
  if (m.size > 300) m.delete(m.keys().next().value as string);
}

/**
 * GET with a time-to-live, for window queries the WebSocket can't keep current (bar buckets, heatmap,
 * state timeline, alarms; window aggregates use windowAgg). `key` must identify the query without its exact
 * timestamps.
 * While the socket is down the cache is bypassed, so behaviour is the same as a plain `get`.
 */
export async function getCached<T = any>(key: string, path: string, ttlMs: number): Promise<T> {
  const L = liveHub();
  const hit = getCache.get(key);
  if (L?.isLive() && hit && Date.now() - hit.fetchedAt < ttlMs) return hit.data as T;
  const data = await get<T>(path);
  if (L) cachePut(getCache, key, { fetchedAt: Date.now(), data });
  return data;
}

/**
 * Window aggregates read while the WebSocket is live (D-048): the REST value, the window end it was read for, and for
 * AVG the sample count (null when it was not read), so pushed points can be folded in without another read.
 */
const aggCache = new Map<string, { fetchedAt: number; readEnd: number; value: number | null; count: number | null }>();

/** Reads one aggregate bucket covering the whole window; null when the window has no data. */
async function readAgg(deviceId: string, key: string, startTs: number, endTs: number, agg: string): Promise<number | null> {
  const r = await get<any>(
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${encodeURIComponent(key)}&startTs=${startTs}&endTs=${endTs}&agg=${agg}&interval=${Math.max(1, endTs - startTs)}&limit=10`,
  );
  const v = r?.[key]?.[0]?.value;
  return v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
}

/**
 * One aggregate (MIN / MAX / AVG / SUM) of a key over a whole window (D-048).
 * REST: GET .../values/timeseries with interval = window length, so ThingsBoard returns one bucket.
 *
 * While the WebSocket is live and the key's live history is complete since the read, a window that ends now is read
 * once and then kept current from the pushed points (MIN / MAX / SUM folded in exactly; AVG through the sample count
 * read next to it), so the 60 s safety redraw makes no REST call. It is read again once the window has slid far
 * enough for points to drop out at its start (1/12 of its length, between 1 and 5 minutes); a window growing from a
 * fixed start (the current shift) loses no points and is read again after 5 minutes. A past window (the previous
 * shift) is kept 5 minutes. Before a read it waits up to 1.5 s for the key's subscription to become ready (D-049: the
 * page's first draw), so the first read is already one that is kept current. Without a complete live history for the
 * key (subscription still not ready) it is the old 60 s cache; with the socket down, a plain REST read every time.
 * @param opts.fixedStart the window grows from a fixed start to now (the D-047 'shift' range).
 * @returns The number, or null when there is no data in the window.
 */
export async function windowAgg(
  deviceId: string,
  key: string,
  startTs: number,
  endTs: number,
  agg: 'MIN' | 'MAX' | 'AVG' | 'SUM',
  opts: { fixedStart?: boolean } = {},
): Promise<number | null> {
  const L = liveHub();
  const now = Date.now();
  const offsetMin = Math.round((now - endTs) / 60e3);
  const ending = offsetMin <= 1;
  const at = (t: number) => Math.floor(t / 60e3);
  const win = !ending ? `${at(startTs)}-${at(endTs)}` : opts.fixedStart ? `@${at(startTs)}` : `${Math.round((endTs - startTs) / 60e3)}|${offsetMin}`;
  const ck = `a|${deviceId}|${key}|${agg}|${win}`;
  if (L && ending) L.want(deviceId, [key]);
  let live = !!L?.isLive();
  let since = live && ending ? L!.liveSince(deviceId, [key]) : null;
  const c = live ? aggCache.get(ck) : undefined;
  if (c) {
    const age = now - c.fetchedAt;
    if (!ending) {
      if (age < 5 * 60e3) return c.value;
    } else if (since != null && since <= c.fetchedAt) {
      const slide = opts.fixedStart ? 5 * 60e3 : Math.min(5 * 60e3, Math.max(60e3, (endTs - startTs) / 12));
      if (age < slide && (agg !== 'AVG' || c.count != null)) {
        const pts = (L!.since(deviceId, key, c.readEnd) ?? []).map((p) => Number(p.value)).filter((v) => Number.isFinite(v));
        if (!pts.length) return c.value;
        const sum = pts.reduce((a, b) => a + b, 0);
        if (agg === 'MIN') return Math.min(c.value ?? Infinity, ...pts);
        if (agg === 'MAX') return Math.max(c.value ?? -Infinity, ...pts);
        if (agg === 'SUM') return (c.value ?? 0) + sum;
        const n = c.value == null ? 0 : (c.count as number);
        return ((c.value ?? 0) * n + sum) / (n + pts.length);
      }
    } else if (age < 60e3) return c.value;
  }
  // QA round 2 (D-049): on a page's first draw the key's subscription is usually still being added (or the socket still
  // opening). Wait for its first reply, at most 1.5 s as D-022 does for latest values, so that this read can be kept
  // current. Without the wait the read was not covered, and MIN / AVG / COUNT / MAX were all read again on the first
  // 60 s safety redraw. waitReady resolves at once when the socket is down or the subscription failed.
  if (L && ending && since == null && typeof L.waitReady === 'function' && (await L.waitReady(deviceId, [key], 1500))) {
    live = L.isLive();
    since = live ? L.liveSince(deviceId, [key]) : null;
  }
  // An AVG that is to be kept current needs the window's sample count too: one extra read per refresh instead of an
  // AVG read every minute.
  const withCount = agg === 'AVG' && live && ending && since != null;
  // fetchedAt is taken after the wait, so it is never before the subscription's readyAt (the cover check above).
  const readAt = Date.now();
  const [value, count] = await Promise.all([
    readAgg(deviceId, key, startTs, endTs, agg),
    withCount ? readAgg(deviceId, key, startTs, endTs, 'COUNT') : Promise.resolve(null),
  ]);
  if (L) cachePut(aggCache, ck, { fetchedAt: readAt, readEnd: endTs, value, count: withCount ? (count ?? 0) : null });
  return value;
}

/** Clears the caches (tests). */
export function clearCaches() {
  seriesCache.clear();
  aggCache.clear();
  getCache.clear();
  gatedCache.clear();
  for (const c of countWatches.values()) c.w.stop();
  countWatches.clear();
}

/**
 * Smallest step from a fixed ladder (1 min ... 7 days) that keeps `spanMs / step <= maxPoints`;
 * the largest step (7 days) when none does.
 */
export function pickInterval(spanMs: number, maxPoints: number): number {
  const steps = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 7 * 86400e3];
  for (const s of steps) if (spanMs / s <= maxPoints) return s;
  return steps[steps.length - 1];
}

/** Number when `v` is numeric (and not blank), otherwise `v` unchanged (booleans/text states). */
function toNum(v: any): number | string {
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== '' ? n : v;
}

// ---------- alarms ----------

// ---- pushed alarm counts (D-046, core/tb-socket.ts watchAlarmCounts) ----
/** Machine sets larger than this read their counts over REST (one count datasource per machine otherwise). */
const MAX_COUNT_IDS = 50;
const countWatches = new Map<string, { w: CountWatch; used: number }>();
const one = (entityType: string, id: string) => ({ type: 'singleEntity', singleEntity: { entityType, id } });

/**
 * A page-wide count watch per signature: made on first use through the current ThingsBoard widget, kept while used
 * (dropped after 3 minutes without use, or when its widget went: then made again through the next one).
 * null without a ThingsBoard widget context (tests, the harness, another platform version).
 */
function countWatch(key: string, specs: () => CountSpec[]): CountWatch | null {
  const now = Date.now();
  for (const [k, c] of countWatches)
    if (!c.w.alive() || now - c.used > 3 * 60e3) {
      c.w.stop();
      countWatches.delete(k);
    }
  let c = countWatches.get(key);
  if (!c) {
    const w = watchAlarmCounts(specs());
    if (!w) return null;
    c = { w, used: now };
    countWatches.set(key, c);
  }
  c.used = now;
  return c.w;
}

/**
 * The alarm "signature" of an entity: its pushed counts of active, unacknowledged and all alarms as one string, or
 * null while they are not there (no ThingsBoard context, or not received yet).
 */
function alarmGate(e: EntityRef): string | null {
  const w = countWatch(`ag|${e.entityType}|${e.id}`, () => [
    { name: 'active', filter: one(e.entityType, e.id), status: ['ACTIVE'] },
    { name: 'unack', filter: one(e.entityType, e.id), status: ['UNACK'] },
    { name: 'all', filter: one(e.entityType, e.id), status: [] },
  ]);
  const c = w?.counts();
  return c ? `${c.active}|${c.unack}|${c.all}` : null;
}

/** Flattened alarm as used by the alarm-list widget. */
export interface AlarmRow {
  id: string;
  type: string;
  severity: string;
  status: string;
  startTs: number;
  endTs: number;
  originatorId: string;
  originatorName: string;
  originatorLabel?: string;
  acknowledged: boolean;
  cleared: boolean;
}

/**
 * Alarms of an entity, newest first (GET /api/v2/alarm/{type}/{id}, first page only).
 * For an asset this includes alarms propagated up `Contains` relations (D-003).
 * @param opts.status     ACTIVE / CLEARED filter; ANY or omitted = no filter.
 * @param opts.severities severity filter, e.g. ['CRITICAL', 'MAJOR'].
 * @param opts.limit      page size (default 20).
 * @param opts.startTs    only alarms from this time (ms).
 * @param opts.endTs      only alarms until this time (ms; a past window such as the previous shift, D-047).
 */
export async function alarms(
  e: EntityRef,
  opts: { status?: 'ACTIVE' | 'CLEARED' | 'ANY'; severities?: string[]; limit?: number; startTs?: number; endTs?: number } = {},
): Promise<AlarmRow[]> {
  const status = opts.status && opts.status !== 'ANY' ? `&statusList=${opts.status}` : '';
  const sev = opts.severities?.length ? `&severityList=${opts.severities.join(',')}` : '';
  const start = (opts.startTs ? `&startTime=${opts.startTs}` : '') + (opts.endTs ? `&endTime=${opts.endTs}` : '');
  // Alarms are not pushed over the socket; while it is live they are re-read at most every 15 s per query.
  // D-046: with ThingsBoard's alarm counts for the entity pushed (active, unacknowledged, all), the list is re-read
  // only when one of them changed, or after a minute (the window's start moves on).
  const path = `/api/v2/alarm/${e.entityType}/${e.id}?pageSize=${opts.limit ?? 20}&page=0&sortProperty=createdTime&sortOrder=DESC${status}${sev}`;
  const gate = alarmGate(e);
  const ck = `a|${path}|${opts.startTs ? Math.round((Date.now() - opts.startTs) / 60e3) : ''}|${opts.endTs ? Math.round((Date.now() - opts.endTs) / 60e3) : ''}`;
  let r: any;
  if (gate) {
    const hit = gatedCache.get(ck);
    if (hit && hit.sig === gate && Date.now() - hit.fetchedAt < 60e3) r = hit.data;
    else {
      r = await get<any>(path + start);
      cachePut(gatedCache, ck, { fetchedAt: Date.now(), sig: gate, data: r });
    }
  } else r = await getCached<any>(ck, path + start, 15e3);
  return (r?.data ?? []).map((a: any) => ({
    id: a.id.id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    startTs: a.startTs,
    endTs: a.endTs,
    originatorId: a.originator?.id,
    originatorName: a.originatorName,
    originatorLabel: a.originatorLabel,
    acknowledged: a.acknowledged,
    cleared: a.cleared,
  }));
}

// ---------- entities / relations ----------

/** Relation row from /api/relations/info (includes the entity names). */
export interface RelInfo {
  from: EntityRef;
  to: EntityRef;
  type: string;
  toName?: string;
  fromName?: string;
}

// D-035: ThingsBoard 4.3 serves relation infos only at /api/relations/info/{from|to}/{type}/{id}; 4.2 and older only
// at /api/relations/info?fromId=|toId=. The path form is tried first (an unknown route is a 404, so no retries);
// after one 404 the query form is used for the rest of the page.
let relInfoQueryForm = false;
async function relInfo(dir: 'from' | 'to', e: EntityRef): Promise<RelInfo[]> {
  if (!relInfoQueryForm) {
    try {
      return await get<RelInfo[]>(`/api/relations/info/${dir}/${e.entityType}/${e.id}?relationTypeGroup=COMMON`);
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 404 || err.status === 405))) throw err;
      relInfoQueryForm = true;
    }
  }
  return get<RelInfo[]>(`/api/relations/info?${dir}Id=${e.id}&${dir}Type=${e.entityType}&relationTypeGroup=COMMON`);
}

/** Outgoing relations of `e` of the given type (default `Contains`, the hierarchy relation). */
export const childrenOf = (e: EntityRef, type = 'Contains') => relInfo('from', e).then((rs) => (rs ?? []).filter((r) => r.type === type));

/** Incoming relations of `e` of the given type (default `Contains`), i.e. its parents. */
export const parentsOf = (e: EntityRef, type = 'Contains') => relInfo('to', e).then((rs) => (rs ?? []).filter((r) => r.type === type));

/** Devices by id (raw TB Device objects), fetched in chunks of 100 ids. Unknown/unreadable ids are omitted by TB. */
export async function devicesByIds(ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await get<any[]>(`/api/devices?deviceIds=${ids.slice(i, i + 100).join(',')}`)));
  return out;
}

/** Assets by id (raw TB Asset objects), fetched in chunks of 100 ids. Unknown/unreadable ids are omitted by TB. */
export async function assetsByIds(ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await get<any[]>(`/api/assets?assetIds=${ids.slice(i, i + 100).join(',')}`)));
  return out;
}

/** Every telemetry key the device has stored (used to warn about missing properties before an apply). */
export async function timeseriesKeys(deviceId: string): Promise<string[]> {
  return (await get<string[]>(`/api/plugins/telemetry/DEVICE/${deviceId}/keys/timeseries`)) ?? [];
}

// ---------- bulk queries (D-022) ----------
// One call each instead of one call per entity. They are what keeps the first page load at a fixed number
// of calls however big the customer's hierarchy is.

/** Plain relation row from POST /api/relations (no names). */
export interface Rel {
  from: EntityRef;
  to: EntityRef;
  type: string;
}

/**
 * Every `relationType` relation below (`direction` FROM) or above (TO) `root`, over up to `maxLevel` levels,
 * in ONE call (POST /api/relations, EntityRelationsQuery). For FROM, `entityTypes` filters the child side;
 * for TO, the parent side. ThingsBoard drops relations to entities the user may not read.
 */
export function relationsTree(root: EntityRef, direction: 'FROM' | 'TO', entityTypes: string[], maxLevel = 12, relationType = 'Contains'): Promise<Rel[]> {
  return post<Rel[]>('/api/relations', {
    parameters: { rootId: root.id, rootType: root.entityType, direction, relationTypeGroup: 'COMMON', maxLevel, fetchLastLevelOnly: false },
    filters: [{ relationType, entityTypes }],
  }).then((r) => r ?? []);
}

/**
 * `relationsTree` through POST /api/relations/info: the same relations, with `fromName` / `toName`. D-052: the iMEX
 * app's imxShell.tree asks this way and only reuses a kept tree that has the names, so the tenant admin's shared tree
 * (core/scope.ts tenantTree) is read this way too.
 */
export function relationInfosTree(root: EntityRef, direction: 'FROM' | 'TO', entityTypes: string[], maxLevel = 12, relationType = 'Contains'): Promise<RelInfo[]> {
  return post<RelInfo[]>('/api/relations/info', {
    parameters: { rootId: root.id, rootType: root.entityType, direction, relationTypeGroup: 'COMMON', maxLevel, fetchLastLevelOnly: false },
    filters: [{ relationType, entityTypes }],
  }).then((r) => r ?? []);
}

/**
 * D-052: the tops of the location trees the logged-in user can read, the same way as the iMEX app's
 * imxShell.locationTops: assets that Contain machines and lie below no other asset, sorted by id. Entity queries only,
 * no relation requests: the device ids (pages of 1000, at most 20 pages), then for every 1000 of them the last asset up
 * the Contains chain (multi-root relations query, fetchLastLevelOnly). For a tenant admin: every location of the tenant.
 * @throws ApiError when ThingsBoard refuses a query.
 */
export async function locationTops(): Promise<string[]> {
  const devs: string[] = [];
  for (let p = 0; p < 20; p++) {
    const r = await post<any>('/api/entitiesQuery/find', {
      entityFilter: { type: 'entityType', entityType: 'DEVICE' },
      pageLink: { page: p, pageSize: 1000 },
      entityFields: [{ type: 'ENTITY_FIELD', key: 'name' }],
    });
    for (const d of r?.data ?? []) if (d?.entityId?.id) devs.push(d.entityId.id);
    if (!r?.hasNext) break;
  }
  const tops = new Set<string>();
  for (let i = 0; i < devs.length; i += 1000) {
    const r = await post<any>('/api/entitiesQuery/find', {
      entityFilter: { type: 'relationsQuery', multiRoot: true, multiRootEntitiesType: 'DEVICE', multiRootEntityIds: devs.slice(i, i + 1000), direction: 'TO', maxLevel: 12, fetchLastLevelOnly: true, filters: [{ relationType: 'Contains', entityTypes: ['ASSET'] }] },
      pageLink: { page: 0, pageSize: 1000 },
      entityFields: [{ type: 'ENTITY_FIELD', key: 'name' }],
    });
    for (const d of r?.data ?? []) if (d?.entityId?.id) tops.add(d.entityId.id);
  }
  return [...tops].sort();
}

/** One entity from `entityData()`: entity fields (name, label, type...), SERVER attributes and latest telemetry. */
export interface EntityRow {
  id: string;
  entityType: string;
  fields: Record<string, string>;
  /** SERVER_SCOPE attributes; a key the entity doesn't have is absent. JSON values are parsed. */
  attrs: Record<string, any>;
  /** Latest telemetry; a key without a value is absent (same shape as `latest()`). */
  ts: Latest;
}

/**
 * Entity fields, SERVER attributes and latest telemetry of many entities of one type in ONE call per 500 ids
 * (POST /api/entitiesQuery/find, entityList filter). Unknown or unreadable ids are left out by ThingsBoard.
 * Customer users get only their customer's entities, the same as the single-entity endpoints.
 */
export async function entityData(
  entityType: 'ASSET' | 'DEVICE',
  ids: string[],
  opts: { fields?: string[]; attrs?: string[]; ts?: string[] } = {},
): Promise<EntityRow[]> {
  const out: EntityRow[] = [];
  const fields = opts.fields ?? ['name', 'label', 'type'];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const r = await post<any>('/api/entitiesQuery/find', {
      entityFilter: { type: 'entityList', entityType, entityList: chunk },
      pageLink: { page: 0, pageSize: chunk.length },
      entityFields: fields.map((key) => ({ type: 'ENTITY_FIELD', key })),
      latestValues: [...(opts.attrs ?? []).map((key) => ({ type: 'SERVER_ATTRIBUTE', key })), ...(opts.ts ?? []).map((key) => ({ type: 'TIME_SERIES', key }))],
    });
    for (const d of r?.data ?? []) {
      const l = d.latest ?? {};
      const row: EntityRow = { id: d.entityId.id, entityType: d.entityId.entityType, fields: {}, attrs: {}, ts: {} };
      for (const [k, v] of Object.entries<any>(l.ENTITY_FIELD ?? {})) row.fields[k] = v?.value ?? '';
      // missing values come back as {ts: 0, value: ""}
      for (const [k, v] of Object.entries<any>(l.SERVER_ATTRIBUTE ?? {})) if (v && v.ts > 0) row.attrs[k] = parseMaybeJson(v.value);
      for (const [k, v] of Object.entries<any>(l.TIME_SERIES ?? {}))
        if (v && v.ts > 0 && v.value !== null && v.value !== undefined && String(v.value) !== '') row.ts[k] = { ts: v.ts, value: toNum(v.value) };
      out.push(row);
    }
  }
  return out;
}

/**
 * Latest values of many devices (keys per device). Devices already live on the WebSocket are served from the
 * live cache; the rest come from ONE entityData call for the union of their keys. Every device is also
 * subscribed, so later redraws are served live. Errors give empty results for the affected devices.
 */
export async function latestMany(req: { deviceId: string; keys: string[] }[]): Promise<Map<string, Latest>> {
  const out = new Map<string, Latest>();
  const L = liveHub();
  let todo = req.filter((r) => r.keys.length);
  if (L) {
    for (const r of todo) L.want(r.deviceId, r.keys);
    const take = () =>
      (todo = todo.filter((r) => {
        const c = L.get(r.deviceId, r.keys);
        if (c) out.set(r.deviceId, c as Latest);
        return !c;
      }));
    take();
    // a cold page subscribes everything at once; give the socket the same short grace as latest()
    if (todo.length && (await L.waitReady(todo[0].deviceId, todo[0].keys, LIVE_WAIT_MS))) take();
  }
  if (todo.length) {
    const keys = [...new Set(todo.flatMap((r) => r.keys))];
    const rows = await entityData('DEVICE', [...new Set(todo.map((r) => r.deviceId))], { fields: [], ts: keys }).catch(() => [] as EntityRow[]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of todo) {
      const ts = byId.get(r.deviceId)?.ts ?? {};
      out.set(r.deviceId, Object.fromEntries(r.keys.filter((k) => ts[k]).map((k) => [k, ts[k]])));
    }
  }
  for (const r of req) if (!out.has(r.deviceId)) out.set(r.deviceId, {});
  for (const l of out.values()) noteLatestTs(l);
  return out;
}

/**
 * Number of ACTIVE alarms per device (devices without alarms are absent) in ONE call
 * (POST /api/alarmsQuery/find, entityList filter; counts the first 1000 alarms). Re-read at most every 15 s
 * while the socket is live, like `alarms()`.
 */
export async function activeAlarmCounts(deviceIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!deviceIds.length) return out;
  const ids = [...new Set(deviceIds)].sort();
  const key = `ac|${ids.join(',')}`;
  // D-046: ThingsBoard pushes the count per machine (one subscription for the set); REST only without it
  const cw = ids.length <= MAX_COUNT_IDS ? countWatch(key, () => ids.map((id) => ({ name: id, filter: one('DEVICE', id), status: ['ACTIVE'] }))) : null;
  if (cw && (cw.counts() || (await cw.waitReady(LIVE_WAIT_MS)))) {
    const c = cw.counts();
    if (c) {
      for (const id of ids) if ((c[id] ?? 0) > 0) out.set(id, c[id]);
      return out;
    }
  }
  const L = liveHub();
  const hit = getCache.get(key);
  let data: any;
  if (L?.isLive() && hit && Date.now() - hit.fetchedAt < 15e3) data = hit.data;
  else {
    data = await post<any>('/api/alarmsQuery/find', {
      entityFilter: { type: 'entityList', entityType: 'DEVICE', entityList: ids },
      pageLink: { page: 0, pageSize: 1000, statusList: ['ACTIVE'], sortOrder: { key: { type: 'ALARM_FIELD', key: 'createdTime' }, direction: 'DESC' } },
      alarmFields: [{ type: 'ALARM_FIELD', key: 'type' }],
      entityFields: [],
      latestValues: [],
    });
    if (L) cachePut(getCache, key, { fetchedAt: Date.now(), data });
  }
  for (const a of data?.data ?? []) {
    const id = a.originator?.id ?? a.entityId?.id;
    if (id) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

// ---------- shift settings (D-047) ----------

/** The shift settings of one entity: its own `imexShifts` document and `imexTimeZone` (SERVER_SCOPE), when set. */
export interface ShiftAttrs {
  name: string;
  shifts?: unknown;
  tz?: string;
}

/**
 * `imexShifts` (and for assets `imexTimeZone`) of the given assets and devices: one Entity Data Query per entity
 * type (entityList filter). The iMEX App UI's Configuration › Shifts writes them (docs/SHIFTS.md in that repo).
 * The developers' `shift` attribute is never read. Ids the user can't read are left out.
 */
export async function shiftAttrs(assetIds: string[], deviceIds: string[]): Promise<Map<string, ShiftAttrs>> {
  const [assets, devices] = await Promise.all([
    assetIds.length ? entityData('ASSET', assetIds, { fields: ['name', 'label'], attrs: ['imexShifts', 'imexTimeZone'] }) : Promise.resolve([] as EntityRow[]),
    deviceIds.length ? entityData('DEVICE', deviceIds, { fields: ['name', 'label'], attrs: ['imexShifts'] }) : Promise.resolve([] as EntityRow[]),
  ]);
  const out = new Map<string, ShiftAttrs>();
  for (const r of [...assets, ...devices]) {
    const a: ShiftAttrs = { name: r.fields.label || r.fields.name || '' };
    if (r.attrs.imexShifts != null && r.attrs.imexShifts !== '') a.shifts = r.attrs.imexShifts;
    if (r.entityType === 'ASSET' && typeof r.attrs.imexTimeZone === 'string' && r.attrs.imexTimeZone) a.tz = r.attrs.imexTimeZone;
    out.set(r.id, a);
  }
  return out;
}

/**
 * The app's configuration asset (System Configuration) with its `imexShifts`, the last level of every shift chain:
 * the iMEX side menu's asset when it is on the page (`window.__imexApp.asset`), else the asset named
 * "System Configuration" (one Entity Data Query). null when the user can't see one.
 */
export async function systemConfigShifts(): Promise<{ id: string; name: string; shifts?: unknown } | null> {
  const app = typeof window !== 'undefined' ? (window as any).__imexApp?.asset : null;
  if (app?.id) {
    const id = typeof app.id === 'string' ? app.id : app.id.id;
    const m = await shiftAttrs([id], []);
    const a = m.get(id);
    return a ? { id, name: a.name || app.name || 'System Configuration', shifts: a.shifts } : null;
  }
  const r = await post<any>('/api/entitiesQuery/find', {
    entityFilter: { type: 'entityName', entityType: 'ASSET', entityNameFilter: 'System Configuration' },
    pageLink: { page: 0, pageSize: 10 },
    entityFields: [{ type: 'ENTITY_FIELD', key: 'name' }],
    latestValues: [{ type: 'SERVER_ATTRIBUTE', key: 'imexShifts' }],
  });
  const hit = (r?.data ?? []).find((d: any) => d?.latest?.ENTITY_FIELD?.name?.value === 'System Configuration');
  if (!hit) return null;
  const v = hit.latest?.SERVER_ATTRIBUTE?.imexShifts;
  return { id: hit.entityId.id, name: 'System Configuration', shifts: v && v.ts > 0 && v.value !== '' ? parseMaybeJson(v.value) : undefined };
}

/**
 * D-064: the machine model (`imexMachineModel` of the configuration asset, written by the app's Settings > Sites &
 * machines): the side menu's asset when it is on the page (one attribute read), else the asset named "System
 * Configuration" with the attribute in ONE Entity Data Query. Resolves to the stored value (object or JSON text) or
 * null; rejects when the request fails (core/machine.ts load() keeps its copy then).
 */
export async function systemConfigMachineModel(): Promise<unknown> {
  const app = typeof window !== 'undefined' ? (window as any).__imexApp?.asset : null;
  if (app?.id) {
    const id = typeof app.id === 'string' ? app.id : app.id.id;
    const a = await getAttrs({ id, entityType: 'ASSET' }, ['imexMachineModel']);
    return a.imexMachineModel ?? null;
  }
  const r = await post<any>('/api/entitiesQuery/find', {
    entityFilter: { type: 'entityName', entityType: 'ASSET', entityNameFilter: 'System Configuration' },
    pageLink: { page: 0, pageSize: 10 },
    entityFields: [{ type: 'ENTITY_FIELD', key: 'name' }],
    latestValues: [{ type: 'SERVER_ATTRIBUTE', key: 'imexMachineModel' }],
  });
  const hit = (r?.data ?? []).find((d: any) => d?.latest?.ENTITY_FIELD?.name?.value === 'System Configuration');
  const v = hit?.latest?.SERVER_ATTRIBUTE?.imexMachineModel;
  return v && v.ts > 0 && v.value !== '' ? v.value : null;
}

/**
 * D-050: the customer's role store, the `imexRoles` attribute of the configuration asset (System Configuration): the
 * iMEX side menu's asset when it is on the page (`window.__imexApp.asset`, one attribute read), else the asset named
 * "System Configuration" with the attribute in ONE Entity Data Query. `raw` is the value as stored (object or JSON
 * text; core/perm.ts parseStore reads both), null when the asset has none. Resolves to null when the user can see no
 * configuration asset (POC customers: the built-in roles); rejects when the request fails.
 */
export async function systemConfigRoles(): Promise<{ id: string; raw: unknown } | null> {
  const app = typeof window !== 'undefined' ? (window as any).__imexApp?.asset : null;
  if (app?.id) {
    const id = typeof app.id === 'string' ? app.id : app.id.id;
    const a = await getAttrs({ id, entityType: 'ASSET' }, ['imexRoles']);
    return { id, raw: a.imexRoles ?? null };
  }
  const r = await post<any>('/api/entitiesQuery/find', {
    entityFilter: { type: 'entityName', entityType: 'ASSET', entityNameFilter: 'System Configuration' },
    pageLink: { page: 0, pageSize: 10 },
    entityFields: [{ type: 'ENTITY_FIELD', key: 'name' }],
    latestValues: [{ type: 'SERVER_ATTRIBUTE', key: 'imexRoles' }],
  });
  const hit = (r?.data ?? []).find((d: any) => d?.latest?.ENTITY_FIELD?.name?.value === 'System Configuration');
  if (!hit) return null;
  const v = hit.latest?.SERVER_ATTRIBUTE?.imexRoles;
  return { id: hit.entityId.id, raw: v && v.ts > 0 && v.value !== '' ? v.value : null };
}
