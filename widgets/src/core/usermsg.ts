// What a user reads when something goes wrong (D-088, Akshay 15 Nov 2026: "the end user need not know this").
//
// One wording table for the Dashboard Builder, the same sentences as the iMEX app (App UI widgets/_shared, the
// userMsg / friendlyError helper), AI Insights (widgets/_shared/aiml.js AIML.userMsg) and Reports (widget/src/usermsg.ts).
// Rules: say what happened in plain words and what to do next; never show internals (platform, store / config names,
// attribute or key names, provider error bodies, HTTP status codes, exception text, JSON, service addresses, ids).
// The technical detail goes to the browser console (console.warn, prefixed "[dbb]") so support can still see it.

import { ApiError } from './api';

/** The sentences, one per case a user can act on. Shared wording: keep in step with the other repos. */
export const MSG = {
  noAccess: 'You do not have access to this. Contact your administrator if you need it.',
  notLicensed: 'This feature is not included in your license.',
  unavailable: 'This is not available right now. Please try again in a few minutes. If it keeps happening, contact your administrator.',
  aiUnavailable: 'AI is not available right now. Contact your ITHENA administrator.',
  aiBusy: 'AI is not available right now. Please try again in a few minutes. If it keeps happening, contact your ITHENA administrator.',
  changed: 'Someone else changed this in the meantime. Reload to see the latest, then try again.',
  noData: 'No data for this period yet.',
  notFound: 'This no longer exists or was removed. Reload the page.',
  offline: 'You appear to be offline. Check your connection and try again.',
  session: 'Your session has ended. Sign in again.',
  reload: 'This page is out of date. Reload the page and try again.',
  generic: 'Something went wrong. Please try again. If it keeps happening, contact your administrator.',
  storeMissing: 'Saving dashboards is not set up for your organisation yet. Contact your ITHENA administrator.',
} as const;

export type MsgKind = keyof typeof MSG;

/** "Could not <action> right now. Please try again in a few minutes. If it keeps happening, contact your administrator." */
export function couldNot(action: string): string {
  return `Could not ${action.replace(/[.\s]+$/, '')} right now. Please try again in a few minutes. If it keeps happening, contact your administrator.`;
}

/** An error whose message was written for the user (shown as it is). */
export class UserError extends Error {
  readonly userFacing = true;
  constructor(message: string, public kind?: MsgKind | string) {
    super(message);
  }
}

/**
 * True when a text carries internals a user must not see: platform or store names, attribute / key names, HTTP codes,
 * exception names, JSON or service addresses. Used as a last guard on texts that come from elsewhere.
 */
export function looksInternal(text: string): boolean {
  const t = String(text ?? '');
  return (
    /thingsboard|dbb-?llm|llm[_ -]?config|dbb_[a-z_]+|\basset\b|\battribute|rule ?chain|\brelay\b|\btenant\b|\bjson\b|\bnull\b|undefined|traceback|exception|stack ?trace|\b[A-Z][a-z]+Error\b|\bHTTP\b|\b(?:status|code)\s*[45]\d\d\b|\b[45]\d\d\s+(?:Bad|Unauthori[sz]ed|Forbidden|Not Found|Internal|Service|Gateway|Too Many|Conflict|Unprocessable)|https?:\/\/|\/api\/|[{}[\]<>]|\b[0-9a-f]{8}-[0-9a-f]{4}-/i.test(t)
  );
}

/** Writes the technical detail to the console for support (never shown on the page). */
export function logDetail(where: string, e: unknown): void {
  try {
    const d = e instanceof ApiError ? `${e.status} ${e.path} ${String(e.body ?? '').slice(0, 300)}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.warn(`[dbb] ${where}:`, d);
  } catch {
    /* console missing */
  }
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * The sentence for an error, for the user.
 * - UserError (and the store's own conflict errors) keep their message (written for users);
 * - a refused platform call: by status (no access, not found, someone else changed it, busy / unreachable);
 * - a network failure: offline or unreachable;
 * - anything else: "Could not <action> right now. ..." (or the generic sentence), the detail in the console.
 * @param e       the error (anything thrown).
 * @param action  what the user tried, e.g. "save the dashboard" (no capital, no full stop).
 */
export function friendlyError(e: unknown, action?: string): string {
  const where = action || 'error';
  if (typeof e === 'string') {
    if (!e.trim() || looksInternal(e)) {
      logDetail(where, e);
      return action ? couldNot(action) : MSG.generic;
    }
    return e;
  }
  const err = e as any;
  if (err && err.userFacing && typeof err.message === 'string' && err.message) return err.message;
  logDetail(where, e);
  if (err instanceof ApiError || (err && typeof err.status === 'number' && 'path' in err)) {
    const s = Number(err.status);
    if (s === 401) return MSG.session;
    if (s === 403) return MSG.noAccess;
    if (s === 404) return MSG.notFound;
    if (s === 409) return MSG.changed;
    if (s === 0 && isOffline()) return MSG.offline;
    return action ? couldNot(action) : MSG.unavailable;
  }
  if (err instanceof TypeError && /fetch|network|load failed/i.test(String(err.message))) return isOffline() ? MSG.offline : action ? couldNot(action) : MSG.unavailable;
  return action ? couldNot(action) : MSG.generic;
}

// ---------- the chat assistant (the AI relay's reply) ----------

/** Codes the relay writes in `dbb_chat_resp.code` (D-088); older relays only wrote an English `error` text. */
export type ChatCode =
  | 'AI_UNAVAILABLE'
  | 'AI_BUSY'
  | 'AI_OFF'
  | 'AI_SW'
  | 'NOT_LICENSED'
  | 'QUOTA'
  | 'RATE'
  | 'ROLE'
  | 'ROLE_ERR'
  | 'TOO_BIG'
  | 'RELOAD'
  | 'NO_OPS';

/** The chat assistant's sentence per relay code. QUOTA takes the used / limit numbers. */
export function chatMessage(code: ChatCode, n?: { used?: string | number; limit?: string | number }): string {
  switch (code) {
    case 'AI_BUSY':
      return MSG.aiBusy;
    case 'AI_OFF':
      return 'The chat assistant is switched off for your organisation. Contact your administrator if you need it.';
    case 'AI_SW':
      return 'The chat assistant is not available right now. Please try again in a few minutes. If it keeps happening, contact your administrator.';
    case 'NOT_LICENSED':
      return MSG.notLicensed;
    case 'QUOTA':
      return n && n.used != null && n.limit != null
        ? `Your organisation has used this month's AI allowance (${n.used} of ${n.limit}). Contact your administrator.`
        : "Your organisation has used this month's AI allowance. Contact your administrator.";
    case 'RATE':
      return 'You have reached the chat limit of 60 requests per hour. Please try again later.';
    case 'ROLE':
      return 'Your role does not include the chat assistant (it needs Build dashboards). Contact your administrator if you need it.';
    case 'ROLE_ERR':
      return 'Your access could not be checked just now, so the chat stays off. Reload the page and try again. If it keeps happening, contact your administrator.';
    case 'TOO_BIG':
      return 'This conversation is too long. Start a new conversation, or ask for fewer changes at once.';
    case 'RELOAD':
      return MSG.reload;
    case 'NO_OPS':
      return 'The assistant did not return an answer. Please try again, or say it in other words.';
    case 'AI_UNAVAILABLE':
    default:
      return MSG.aiUnavailable;
  }
}

/** Old relays (before D-088) wrote only an English `error`: the code it stands for. Unknown = AI_UNAVAILABLE. */
export function chatCodeOf(text: string): ChatCode {
  const t = String(text ?? '');
  if (/^AI_UNAVAILABLE|^AI_BUSY|^AI_OFF|^AI_SW|^NOT_LICENSED|^QUOTA|^RATE|^ROLE_ERR|^ROLE|^TOO_BIG|^RELOAD|^NO_OPS/.test(t)) return t.match(/^[A-Z_]+/)![0] as ChatCode;
  if (/overloaded|rate-limited|Could not reach|temporar/i.test(t)) return 'AI_BUSY';
  if (/Chat limit reached/i.test(t)) return 'RATE';
  if (/not included in .*licen[cs]e/i.test(t)) return 'NOT_LICENSED';
  if (/Monthly AI limit/i.test(t)) return 'QUOTA';
  if (/could not read the AI switches/i.test(t)) return 'AI_SW';
  if (/switched off/i.test(t)) return 'AI_OFF';
  if (/role could not be checked/i.test(t)) return 'ROLE_ERR';
  if (/role can'?t use the chat/i.test(t)) return 'ROLE';
  if (/too large/i.test(t)) return 'TOO_BIG';
  if (/older version|not made by the Dashboard Builder|did not come from your user/i.test(t)) return 'RELOAD';
  if (/returned no dashboard operations/i.test(t)) return 'NO_OPS';
  return 'AI_UNAVAILABLE';
}

/**
 * The chat error for a relay reply {ok: false, code?, error?, detail?, qUsed?, qLimit?}: a UserError with the sentence
 * and `kind` = the code; the relay's technical text goes to the console only.
 */
export function chatError(r: any): UserError {
  const code: ChatCode = r && typeof r.code === 'string' && r.code ? (r.code as ChatCode) : chatCodeOf(r?.error ?? '');
  if (r && (r.detail || r.error || r.status)) {
    try {
      console.warn('[dbb] chat:', code, r.provider || '', r.status || '', String(r.detail || r.error || '').slice(0, 300));
    } catch {
      /* console missing */
    }
  }
  let n: { used?: string; limit?: string } | undefined;
  if (code === 'QUOTA') {
    const m = /\((\d+) of (\d+)\)/.exec(String(r?.error ?? ''));
    n = r?.qUsed != null ? { used: r.qUsed, limit: r.qLimit } : m ? { used: m[1], limit: m[2] } : undefined;
  }
  return new UserError(chatMessage(code, n), code);
}
