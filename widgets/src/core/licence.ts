/**
 * D-059: the instance licence (iMEX Control Centre, DESIGN.md section 10) as the Builder obeys it.
 *
 * The app's side menu verifies the signed licence and offers it on every app page as `window.__imexLicence`:
 *   ready (Promise) · status.mode ('unlicensed' | 'active' | 'grace' | 'expired' | 'suspended' | 'invalid' ...)
 *   · has(featureKey) → boolean · limits → payload.limits or {} (may be absent: then status.payload.limits)
 *   · window event 'imx-licence-changed' after every (re)evaluation.
 * Read defensively: no `__imexLicence` (a page without the side menu), no `has`, or a `has` that throws = everything
 * allowed (the side menu's own route guard and the services stay the gate there). Before the licence is evaluated the
 * side menu answers has() = true (mode 'unlicensed', reason 'pending'), and fires the event once it knows.
 *
 * Features used here:
 *   builder     the Build / Edit actions (renderer bar menu + published edit actions, launcher pencil menu, Dashboards
 *               page buttons and Edit, openBuilder). Viewing dashboards is core and never licence-gated.
 *   builder.ai  the Builder's Chat tab and its "Describe it in chat" tiles (the side menu's has() also needs the parent).
 *
 * LLM metering (DESIGN 10.4): every LLM provider call is one telemetry point `llm_<source>` = 1 on the asset
 * "System Configuration"; usage = COUNT of the five keys since the start of the calendar month (UTC), compared with
 * limits.llmCallsPerMonth: >= 80 % warn, >= 100 % refuse with "Monthly AI limit reached (N of M) — contact your
 * administrator". The thresholds and texts mirror llm_verdict of the shared Python module (imex_licence.py).
 * Several calls of one chat turn are posted as several points (ts, ts+1, ...): COUNT counts points, not values.
 */
import * as api from './api';

export const LICENCE_EVENT = 'imx-licence-changed';
/** The five metering keys (DESIGN 10.4), one per source. */
export const LLM_KEYS = ['llm_aiml', 'llm_native', 'llm_reports', 'llm_builder', 'llm_aether'] as const;
export type LlmSource = (typeof LLM_KEYS)[number];

/** What the side menu provides (all optional: feature-detected). */
export interface LicenceApi {
  ready?: Promise<unknown>;
  status?: { mode?: string; payload?: { limits?: Record<string, unknown> } | null } | null;
  has?: (key: string) => boolean;
  limits?: Record<string, unknown> | null;
}

/** `window.__imexLicence`, or null when the page has none. */
export function licenceApi(): LicenceApi | null {
  if (typeof window === 'undefined') return null;
  const L = (window as any).__imexLicence;
  return L && typeof L === 'object' ? (L as LicenceApi) : null;
}

/** The licence switches `key` on (true without a licence API on the page, or when the API fails). */
export function licHas(key: string, L: LicenceApi | null = licenceApi()): boolean {
  if (!L || typeof L.has !== 'function') return true;
  try {
    return !!L.has(key);
  } catch {
    return true;
  }
}

/** Building and editing dashboards is licensed (feature `builder`). */
export const builderLicensed = (L: LicenceApi | null = licenceApi()) => licHas('builder', L);
/** The Builder's chat assistant is licensed (`builder.ai`, a sub-feature of `builder`). */
export const chatLicensed = (L: LicenceApi | null = licenceApi()) => licHas('builder', L) && licHas('builder.ai', L);
/** The role may build (`dashboards.build`) AND the licence includes the Builder. */
export const mayBuild = (ctx: { canBuild: boolean } | null | undefined, L: LicenceApi | null = licenceApi()) => !!ctx?.canBuild && builderLicensed(L);

/**
 * Calls `cb` on 'imx-licence-changed' only when the value of `probe()` changed since the last call (the side menu
 * fires the event on every evaluation, mostly without a change: nothing is redrawn then). Returns the remover.
 */
export function onLicenceChange<T extends string | boolean>(probe: () => T, cb: (now: T) => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => undefined;
  let last = probe();
  const h = () => {
    const now = probe();
    if (now === last) return;
    last = now;
    cb(now);
  };
  window.addEventListener(LICENCE_EVENT, h);
  return () => window.removeEventListener(LICENCE_EVENT, h);
}

// ---------------------------------------------------------------------------------------------- LLM quota

/** limits.llmCallsPerMonth (a positive whole number), or null = no limit (missing, 0, not a number). */
export function llmLimit(L: LicenceApi | null = licenceApi()): number | null {
  if (!L) return null;
  const lim = L.limits && typeof L.limits === 'object' ? L.limits : L.status?.payload?.limits;
  const v = Number((lim as any)?.llmCallsPerMonth);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/** Start of the calendar month (UTC) of `now`, in ms. */
export function monthStartUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export interface LlmVerdict {
  level: 'ok' | 'warn' | 'block';
  message: string;
}
/** Mirror of imex_licence.llm_verdict: block at 100 %, warn from 80 %, ok otherwise or without a limit. */
export function llmVerdict(used: number, limit: number | null): LlmVerdict {
  if (!limit || limit <= 0) return { level: 'ok', message: '' };
  if (used >= limit) return { level: 'block', message: `Monthly AI limit reached (${used} of ${limit}) — contact your administrator` };
  if (used >= 0.8 * limit) return { level: 'warn', message: `${used} of ${limit} AI requests used this month` };
  return { level: 'ok', message: '' };
}

/** The COUNT request of DESIGN 10.4: one bucket from the month start to now, the five keys. */
export function llmCountPath(assetId: string, now: number): string {
  const start = monthStartUtc(now);
  return `/api/plugins/telemetry/ASSET/${assetId}/values/timeseries?keys=${LLM_KEYS.join(',')}&startTs=${start}&endTs=${now}&agg=COUNT&interval=${now - start + 1}&limit=1`;
}

/** Sum of the COUNT buckets of every key (values arrive as numbers or strings; anything else counts 0). */
export function sumCounts(resp: unknown): number {
  let n = 0;
  if (!resp || typeof resp !== 'object') return 0;
  for (const rows of Object.values(resp as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const v = Number((r as any)?.value);
      if (Number.isFinite(v) && v > 0) n += v;
    }
  }
  return Math.round(n);
}

/** The telemetry body for `n` calls of one source: n points of value 1, 1 ms apart (COUNT counts points). */
export function llmPoints(source: LlmSource, n: number, now: number): { ts: number; values: Record<string, number> }[] {
  const out: { ts: number; values: Record<string, number> }[] = [];
  for (let i = 0; i < Math.max(0, Math.floor(n)); i++) out.push({ ts: now + i, values: { [source]: 1 } });
  return out;
}

let cfgP: Promise<string | null> | null = null;
/**
 * Id of the configuration asset ("System Configuration"): the side menu's asset when it is on the page
 * (`window.__imexApp.asset`), else the asset of that name (one Entity Data Query, as api.systemConfigRoles). Cached
 * for the page; a failed lookup is asked again next time.
 */
export function systemConfigId(): Promise<string | null> {
  const app = typeof window !== 'undefined' ? (window as any).__imexApp?.asset : null;
  if (app?.id) return Promise.resolve(typeof app.id === 'string' ? app.id : app.id.id);
  cfgP ??= api
    .post<any>('/api/entitiesQuery/find', {
      entityFilter: { type: 'entityName', entityType: 'ASSET', entityNameFilter: 'System Configuration' },
      pageLink: { page: 0, pageSize: 10 },
      entityFields: [{ type: 'ENTITY_FIELD', key: 'name' }],
    })
    .then((r) => (r?.data ?? []).find((d: any) => d?.latest?.ENTITY_FIELD?.name?.value === 'System Configuration')?.entityId?.id ?? null)
    .catch(() => {
      cfgP = null;
      return null;
    });
  return cfgP;
}

export interface LlmQuota extends LlmVerdict {
  used: number | null;
  limit: number | null;
}

/**
 * The quota check before an LLM call. Without a limit nothing is asked (ok). When the asset or the count can't be
 * read the call is allowed (ok, used null): the licence is a commercial control, a failed read must not stop work.
 */
export async function llmCheck(now = Date.now()): Promise<LlmQuota> {
  const limit = llmLimit();
  if (limit == null) return { level: 'ok', message: '', used: null, limit: null };
  try {
    const id = await systemConfigId();
    if (!id) return { level: 'ok', message: '', used: null, limit };
    const used = sumCounts(await api.get(llmCountPath(id, now)));
    return { ...llmVerdict(used, limit), used, limit };
  } catch {
    return { level: 'ok', message: '', used: null, limit };
  }
}

/** Posts `n` provider calls of `source` (after they succeeded). Resolves false when nothing could be written. */
export async function llmRecord(source: LlmSource, n: number, now = Date.now()): Promise<boolean> {
  if (!(n > 0)) return false;
  try {
    const id = await systemConfigId();
    if (!id) return false;
    await api.post(`/api/plugins/telemetry/ASSET/${id}/timeseries/ANY`, llmPoints(source, n, now));
    return true;
  } catch {
    return false;
  }
}

/** A chat transport that counts the provider calls that answered (the relay's retry included when it succeeded). */
export function countingTransport<T extends { send(body: unknown): Promise<any> }>(inner: T): T & { calls: number } {
  const t = {
    calls: 0,
    async send(body: unknown) {
      const r = await inner.send(body);
      t.calls++;
      return r;
    },
  };
  return t as unknown as T & { calls: number };
}
