// core/audit.ts — audit trail for builder actions (DECISIONS D-012).
//
// Each save / apply / restore / delete / chat turn / customise / reset / threshold change is written as one timeseries point, key `dbb_audit`, on the
// customer's DashboardStore asset, so ThingsBoard keeps the full history (who, role, what, when,
// affected machines). Called by the builder and the renderer entry after store operations.
// Best effort: failures are swallowed and never block the user.
//
// Caveat: written from the browser as the user, so it is a convenience log, not tamper-proof
// evidence (a customer user can write telemetry on the store asset directly; D-012).
import * as api from './api';
import type { UserContext } from './scope';

/**
 * D-080: the stored text of an entry. Over 8000 characters the detail is kept as a cut text in `detail` with
 * `truncated: true`; cutting the JSON itself left an unreadable entry (an apply to 200 machines passes the limit).
 */
export function auditEntry(ctx: Pick<UserContext, 'email' | 'userId' | 'role'>, action: string, detail: Record<string, unknown>): string {
  const who = { user: ctx.email, userId: ctx.userId, role: ctx.role, action };
  const full = JSON.stringify({ ...who, ...detail });
  // a cut text at most doubles when it is written as a JSON string
  return full.length <= 8000 ? full : JSON.stringify({ ...who, truncated: true, detail: JSON.stringify(detail).slice(0, 3500) });
}

/**
 * Appends one audit entry.
 * Side effect: POST /api/plugins/telemetry/ASSET/<store>/timeseries/ANY with
 * `dbb_audit` = JSON `{user, userId, role, action, ...detail}` (auditEntry; D-080: stays valid JSON at any size).
 * No-op when the customer has no store asset.
 * @param ctx    current user context (for the store and the user's identity).
 * @param action dotted action name, e.g. 'dashboard.save', 'dashboard.apply', 'chat', 'thresholds.update'.
 * @param detail extra fields merged into the entry (dashboard id, target, affected machines...).
 */
export async function audit(ctx: UserContext, action: string, detail: Record<string, unknown>) {
  if (!ctx.store) return;
  try {
    await api.post(`/api/plugins/telemetry/ASSET/${ctx.store.id}/timeseries/ANY`, {
      ts: Date.now(),
      values: { dbb_audit: auditEntry(ctx, action, detail) },
    });
  } catch {
    /* ignore */
  }
}
