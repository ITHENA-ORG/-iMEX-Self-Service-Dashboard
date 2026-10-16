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
 * LLM metering (DESIGN 10.4, since D-066 / CC-013 §12.5): every provider call is metered SERVER-side, by the chat relay
 * rule chain, as one telemetry point `llm_builder` on the tenant-only asset "iMEX Keeper" (customer users can neither
 * read nor delete it); the chain also refuses a turn when the licence lacks builder / builder.ai / genAi or the month's
 * count (COUNT of the five llm_* keys, UTC month) reached limits.llmCallsPerMonth. The browser no longer meters. The
 * thresholds and texts here mirror llm_verdict of the shared Python module (imex_licence.py) for the note shown first.
 */

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
  usage?: { llm?: { total?: number | null } | null } | null;
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

export interface LlmQuota extends LlmVerdict {
  used: number | null;
  limit: number | null;
}

/**
 * D-066 (U-071 / CC-013): the quota NOTE before a chat turn. The count is the server's (the licence keeper counts every
 * provider call on the tenant-only asset "iMEX Keeper" and publishes this month's total as imexAiUsage on the app
 * customer; the side menu's licence core offers it as `usage.llm`). No request from here. The chat relay rule chain
 * checks the licence and the quota itself before every call and meters it: this is only what the user is told first.
 * Without a limit, or without a count yet, ok.
 */
export async function llmCheck(_now = Date.now(), L: LicenceApi | null = licenceApi()): Promise<LlmQuota> {
  const limit = llmLimit(L);
  if (limit == null) return { level: 'ok', message: '', used: null, limit: null };
  const total = Number((L as any)?.usage?.llm?.total);
  if (!Number.isFinite(total) || total < 0) return { level: 'ok', message: '', used: null, limit };
  return { ...llmVerdict(total, limit), used: total, limit };
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
