/**
 * Helpers shared by the three ThingsBoard widget entry points (launcher.ts, renderer.ts, listing.ts).
 *
 * Runs in the browser, inside a ThingsBoard dashboard, as part of each widget type's controller script.
 * Remember that each widget type embeds its OWN copy of the bundle (see all.ts), so the module-level
 * state here (the cached user context) is per widget type, not per page. Cross-widget communication
 * therefore goes through `window`:
 *   - CHANGED_EVENT (`imex-dbb:changed`): "dashboards/assignments changed, reload" (fired after the
 *     builder closes with changes, after customise/reset/apply). Renderer and listing reload on it.
 *   - ACTIONS_EVENT (`imex-dbb:actions`) + `window.__imexDbbActions`: the renderer publishes the
 *     machine page's edit actions; the launcher's navbar edit menu shows and runs them (D-020).
 *
 *   - D-050: the iMEX app's `imx-access-changed` / `imx-perm-changed` drop the page's user context.
 *
 * Exports: userContext, userPerms, userContextFor, slotStale, pageGate, stateEntity, stateParam, currentState, CHANGED_EVENT,
 * notifyChanged, EditAction, EditActions, ACTIONS_EVENT, publishActions, currentActions.
 */
import { bindWidgetContext } from '../core/api';
import { loadUserContext, loadPerms, clearRelCache, UserContext, Perms } from '../core/scope';
import { parseStore } from '../core/perm';
import { liveHub } from '../core/live';
import { registerLiveProvider, unregisterLiveProvider, currentProvider } from '../core/tb-socket';

/** Build of this library copy (build.mjs stamps it; same value as IMEX_DBB.version). */
export const LIB_VERSION = '__VERSION__';

/** Page-wide cache slot on `window` (D-022): shared by the launcher, renderer and listing widget types. */
interface CtxSlot {
  v: string;
  key: string;
  at: number;
  promise: Promise<UserContext>;
  /** D-050: what the loaded context was built from (UserContext.sig), set once it has loaded. */
  sig?: UserContext['sig'] & { userId: string; customerId: string };
}

/** How long the app's sessionStorage copies (`imex-access:<userId>`, `imex-roles:<customerId>`) count as current. */
const APP_COPY_MS = 120e3;
/** rev of the last role store copy read, by its `at` (a copy is parsed once). */
let rolesCopy: { at: number; rev: number } | null = null;

/**
 * D-050: true when the iMEX app's widgets on this page have since read a different access or role store than the one
 * the slot's context was built from: the app's access resolver keeps the user's granted ids in
 * `sessionStorage['imex-access:<userId>'].sig` (the same string as `ctx.sig.access`) and its role resolver the store in
 * `sessionStorage['imex-roles:<customerId>'].raw` (2 minutes each). So an access or role change that the app has seen
 * reloads the Builder's context too, without a request of its own. (A change of the user's own `imexRole` id shows
 * after the 5-minute slot, or at once after a reload; the app's own saves fire the events below.)
 */
export function slotStale(sig: CtxSlot['sig'] | undefined, now = Date.now()): boolean {
  if (!sig || sig.unrestricted) return false;
  try {
    const a = JSON.parse(sessionStorage.getItem(`imex-access:${sig.userId}`) || 'null');
    if (a && now - a.at < APP_COPY_MS && typeof a.sig === 'string' && a.sig !== sig.access) return true;
    const r = JSON.parse(sessionStorage.getItem(`imex-roles:${sig.customerId}`) || 'null');
    if (r && now - r.at < APP_COPY_MS && Object.prototype.hasOwnProperty.call(r, 'raw')) {
      if (!rolesCopy || rolesCopy.at !== r.at) rolesCopy = { at: r.at, rev: parseStore(r.raw).rev };
      if (rolesCopy.rev !== sig.rolesRev) return true;
    }
  } catch {
    /* no session storage, or not JSON */
  }
  return false;
}

/**
 * D-050: the app fires `imx-access-changed` (imxAccess.invalidate, a save of the current user, or a machine found on a
 * second look) and `imx-perm-changed` (imxPerm.invalidate, a role or user save) on `window`: the page's context is
 * dropped so the next userContext() loads it again. Once per library copy.
 */
let listening = false;
function listenForAppChanges() {
  if (listening || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listening = true;
  const drop = () => {
    (window as any).__imexDbbCtx = undefined;
  };
  window.addEventListener('imx-access-changed', drop);
  window.addEventListener('imx-perm-changed', drop);
}

/**
 * Returns the logged-in user's context (scope nodes, access, role and permissions, profile catalogue, assignment
 * snapshot; see core/scope.ts).
 *
 * Cached for 5 minutes for the whole PAGE in `window.__imexDbbCtx` (D-022): each widget type runs its own
 * copy of the library, and before D-022 each copy loaded the context itself (the navbar and the machine
 * dashboard both did, doubling the calls). The slot is only shared between copies of the same build and
 * for the same user/customer setting. `force` reloads it for every widget, e.g. after CHANGED_EVENT; a failed
 * load clears it so the next call retries.
 * Also binds the widget context to the REST client so it can refresh the ThingsBoard JWT.
 *
 * @param tbCtx ThingsBoard widget context (`self.ctx`). `settings.customerId` is used when a tenant
 *   admin opens the app (tenant-admin mode, D-018): that customer's top-level assets become the roots.
 * @param force Bypass the cache.
 * @returns Shared promise of the user context; rejects if the user attributes/hierarchy can't be read.
 */
export function userContext(tbCtx: any, force = false): Promise<UserContext> {
  bindWidgetContext(tbCtx);
  listenForAppChanges();
  const w = window as any;
  const cust = tbCtx?.settings?.customerId || null;
  // keyed by the logged-in user (from the JWT) so another login in the same tab never gets this context; D-050: and
  // by what it was built from (access grants, role store revision), checked against the app's copies (slotStale)
  const key = `${jwtUserId()}|${cust ?? ''}`;
  const slot = force ? undefined : currentSlot(key);
  if (slot) return slot.promise;
  const next: CtxSlot = {
    v: LIB_VERSION,
    key,
    at: Date.now(),
    promise: loadUserContext({ tenantCustomerId: cust }).then((c) => {
      // shown by the builder's banner strip and the listing
      if (isOutdated(c)) c.warnings.unshift('This page runs an older version of the iMEX widgets than the one deployed. Reload the page (Ctrl+F5) before building or chatting.');
      if (c.sig) next.sig = { ...c.sig, userId: c.userId, customerId: c.customerId };
      return c;
    }).catch((e) => {
      if (w.__imexDbbCtx === next) w.__imexDbbCtx = undefined;
      throw e;
    }),
  };
  w.__imexDbbCtx = next;
  return next.promise;
}

/** The page's context slot when it can be used for `key` (this build, under 5 minutes, not stale); else undefined. */
function currentSlot(key: string): CtxSlot | undefined {
  const slot: CtxSlot | undefined = (window as any).__imexDbbCtx;
  return slot && slot.v === LIB_VERSION && Date.now() - slot.at < 5 * 60e3 && slot.key === key && !slotStale(slot.sig) ? slot : undefined;
}

/**
 * D-052: the logged-in user's role only, for the headless launcher's isEditor(): the page's context when one is
 * loaded or loading (no call of its own), else core/scope.ts loadPerms() (the role without the tree: no relation
 * request). So a page that only shows the app's menu builds no Builder context; the context loads when a Builder
 * action (open, Dashboard list) needs it.
 */
export function userPerms(tbCtx: any): Promise<Perms> {
  bindWidgetContext(tbCtx);
  listenForAppChanges();
  const slot = currentSlot(`${jwtUserId()}|${tbCtx?.settings?.customerId || ''}`);
  return slot ? slot.promise.then((c) => c.perms) : loadPerms();
}

/** When each machine last caused a forced reload in userContextFor (ms), so a machine outside the scope costs one. */
const rechecked = new Map<string, number>();

/**
 * userContext for a page that shows `deviceId`. When the context does not have that machine, the scope may just be
 * old: the relations are cached for the browser session (D-037; 2 minutes since D-050) and the context for 5 minutes, so a
 * machine added meanwhile was refused as "outside your access". Then the cached relations are dropped and the
 * context is loaded again with force, once per machine per minute; the caller decides on the reloaded context.
 * @param deviceId machine the page is about to show (null/undefined = no check).
 * @param force passed to userContext for the first load.
 */
export async function userContextFor(tbCtx: any, deviceId: string | null | undefined, force = false): Promise<UserContext> {
  const ctx = await userContext(tbCtx, force);
  if (!deviceId || ctx.nodes.has(deviceId) || Date.now() - (rechecked.get(deviceId) ?? 0) < 60e3) return ctx;
  rechecked.set(deviceId, Date.now());
  clearRelCache(ctx.userId);
  return userContext(tbCtx, true);
}

/** User id claim of the current ThingsBoard JWT ('' when there is none or it can't be read). */
function jwtUserId(): string {
  try {
    const t = localStorage.getItem('jwt_token') ?? '';
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return String(p.userId ?? p.sub ?? '');
  } catch {
    return '';
  }
}

/**
 * True when a newer widget library has been deployed than the one running on this page (the store
 * attribute `dbb_lib_version` written by DBB_DEPLOY differs from LIB_VERSION). ThingsBoard keeps widget code
 * loaded until the page is reloaded, so an open tab can run old code after a deploy (D-022).
 */
export function isOutdated(ctx: UserContext): boolean {
  return !!ctx.deployedVersion && !LIB_VERSION.startsWith('__') && ctx.deployedVersion !== LIB_VERSION;
}

/**
 * Entity of the current dashboard state, as set by `stateController.openState(state, {entityId, ...})`.
 * Accepts `params.entityId` directly or the first nested param object that carries an `entityId`
 * (ThingsBoard nests params per state in some cases).
 * @returns `{id, entityType, name}` or null when the state has no entity or the controller throws.
 */
export function stateEntity(tbCtx: any): { id: string; entityType: string; name?: string } | null {
  try {
    const p = tbCtx.stateController?.getStateParams?.() ?? {};
    const e = p.entityId ?? p[Object.keys(p).find((k) => p[k]?.entityId) ?? '']?.entityId;
    if (e?.id) return { id: e.id, entityType: e.entityType, name: p.entityName };
  } catch {
    /* ignore */
  }
  return null;
}

/** One raw parameter of the current dashboard state (e.g. `dbbDashboardId`), or undefined. */
export function stateParam(tbCtx: any, key: string): any {
  try {
    return tbCtx.stateController?.getStateParams?.()?.[key];
  } catch {
    return undefined;
  }
}

/** localStorage key (per ThingsBoard dashboard URL) of the state that holds the renderer widget (D-025). */
export const RSTATE_KEY = () => `dbb_rstate_${location.pathname}`;

/**
 * D-050: the page gate of the iMEX app (roles): the level of the current dashboard state for this user ('hidden',
 * 'view' or 'full'). A state that is no page of the role catalogue is 'view'. The app's side menu also turns a hidden
 * state away; a widget that shows a page's content checks this too, because a dashboard may lack the menu.
 */
export function pageGate(tbCtx: any, ctx: UserContext): 'hidden' | 'view' | 'full' {
  const id = currentState(tbCtx).id;
  return id ? ctx.perms.canState(id) : 'view';
}

/**
 * The app's empty state for a page the user's role hides (imxShell.noAccess('page'): the lock icon, the same wording,
 * theme tokens with fallbacks), drawn instead of the page before any data request.
 */
export const NO_ACCESS_HTML =
  '<div class="dbb-denied" role="status" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:100%;min-height:120px;padding:18px;text-align:center;font-family:var(--imx-font,Inter,\'Segoe UI\',Roboto,Arial,sans-serif)">' +
  '<span style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin-bottom:4px;border-radius:13px;background:var(--imx-off-bg,#F1F5F9);color:var(--imx-muted,#5B6B82)">' +
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>' +
  '<b style="font-size:14px;font-weight:700;color:var(--imx-text,#0F172A)">You don\'t have access to this page</b>' +
  '<span style="font-size:12.5px;color:var(--imx-muted,#5B6B82);white-space:normal">Ask your administrator if you need it.</span></div>';

/**
 * D-094 (final QA R-07): the app's empty state for a machine outside the user's access (imxShell.noAccess('machine'),
 * ROLES / ACCESS: "This machine is not in your access"): the kit's own when the app's shell is on the page, else this
 * copy of it.
 */
export function machineNoAccessHtml(): string {
  const k = (globalThis as any).imxShell;
  if (k && typeof k.noAccess === 'function') {
    try {
      const h = k.noAccess('machine');
      if (typeof h === 'string' && h) return h;
    } catch {
      /* the copy below */
    }
  }
  return NO_ACCESS_HTML.replace("You don't have access to this page", 'This machine is not in your access').replace(
    'Ask your administrator if you need it.',
    'Choose another machine, or ask your administrator.',
  );
}

/** Window event meaning "stored dashboards or assignments changed"; listeners reload with force. */
export const CHANGED_EVENT = 'imex-dbb:changed';
/** Fires CHANGED_EVENT on `window`, reaching every widget (every library copy) on the page. */
export const notifyChanged = () => window.dispatchEvent(new CustomEvent(CHANGED_EVENT));

/**
 * Decodes ThingsBoard's `state` URL parameter: URL-safe base64 of the UTF-8 JSON state stack.
 * D-033: on some ThingsBoard setups the value is percent-encoded twice, so after URLSearchParams it still
 * holds `%3D` etc.; it is decoded again (up to 3 times) and base64 padding is restored before atob.
 * @returns the state stack array, or null when it can't be decoded.
 */
export function decodeStateParam(raw: string): any[] | null {
  try {
    let v = raw.trim();
    for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(v); i++) v = decodeURIComponent(v);
    v = v.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '+');
    v = v.replace(/=+$/, '');
    v += '='.repeat((4 - (v.length % 4)) % 4);
    const arr = JSON.parse(decodeURIComponent(escape(atob(v))));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/** Current dashboard state {id, params}. Reads the `state` URL parameter (entity state controller) first,
 *  then the widget's state controller. Used by the navbar, which is not always told about state changes. */
export function currentState(tbCtx: any): { id: string; params: any } {
  try {
    const raw = new URLSearchParams(location.search).get('state');
    if (raw) {
      // The entity state controller stores the state stack as URL-safe base64 of UTF-8 JSON.
      const arr = decodeStateParam(raw);
      const last = arr ? arr[arr.length - 1] : null;
      if (last?.id) return { id: last.id, params: last.params ?? {} };
    }
  } catch {
    /* fall through */
  }
  try {
    return { id: tbCtx.stateController?.getStateId?.() || '', params: tbCtx.stateController?.getStateParams?.() ?? {} };
  } catch {
    return { id: '', params: {} };
  }
}

/**
 * Entity of the page as the user sees it: the current state's params from the URL first (currentState),
 * then the widget's state controller (stateEntity). The renderer used only the state controller, which
 * missed a machine picked in an app navbar that changes the state URL without notifying the widget: the
 * page kept the old machine's dashboard while the edit menu (URL-based) already had the new one (28 Sep 2026).
 */
export function currentEntity(tbCtx: any): { id: string; entityType: string; name?: string } | null {
  const p = currentState(tbCtx).params ?? {};
  const e = p.entityId ?? p[Object.keys(p).find((k) => p[k]?.entityId) ?? '']?.entityId;
  if (e?.id) return { id: e.id, entityType: e.entityType, name: p.entityName };
  return stateEntity(tbCtx);
}

/** One parameter of the current state, URL first (see currentEntity), then the state controller. */
export function currentParam(tbCtx: any, key: string): any {
  return currentState(tbCtx).params?.[key] ?? stateParam(tbCtx, key);
}

// ---------- edit actions shown in the navbar's edit menu ----------
// The navbar (launcher widget) and the machine dashboard (renderer widget) are separate ThingsBoard
// widgets, each with its own copy of this library, so they talk through `window` and an event.

/** One item of the navbar edit menu. `id` is passed back to EditActions.run(). */
export interface EditAction {
  id: string;
  label: string;
  hint?: string;
  /** 'switch' items are listed under "Show dashboard" with a check mark. */
  group?: 'main' | 'switch';
  checked?: boolean;
  danger?: boolean;
  icon?: 'edit' | 'copy' | 'reset' | 'sliders' | 'eye';
}

/** The set of edit actions currently published on `window.__imexDbbActions`. */
export interface EditActions {
  /** Id of the publishing widget instance; only the owner may clear the slot. */
  owner: string;
  /** The widget that published the actions; stale once it leaves the page. */
  el: HTMLElement;
  title: string;
  subtitle?: string;
  items: EditAction[];
  /** Runs the action; called by the launcher with the clicked item's id. */
  run(id: string): void;
}

/** Window event fired whenever `window.__imexDbbActions` is replaced or cleared. */
export const ACTIONS_EVENT = 'imex-dbb:actions';

/**
 * Publishes (or clears, with `a = null`) the edit actions for the navbar's edit menu.
 * Side effects: writes `window.__imexDbbActions` and dispatches ACTIONS_EVENT.
 * Clearing only takes effect if `owner` still owns the slot, so a destroyed widget can't wipe the
 * actions of a newer one. Admin-only filtering is done by the caller (UI only, D-012).
 * D-054: on a phone (html.imx-mobile) nothing is published: dashboards are view-only there.
 */
export function publishActions(owner: string, a: Omit<EditActions, 'owner'> | null) {
  const w = window as any;
  if (a && isMobileApp()) a = null;
  if (a) w.__imexDbbActions = { ...a, owner };
  else if (w.__imexDbbActions?.owner === owner) w.__imexDbbActions = null;
  window.dispatchEvent(new CustomEvent(ACTIONS_EVENT));
}

/**
 * Actions currently published for the edit menu, or null. Ignores actions whose publishing element
 * is no longer in the DOM (the widget left the page without clearing them), and every action on a phone (D-054).
 */
export function currentActions(): EditActions | null {
  const a = (window as any).__imexDbbActions as EditActions | null | undefined;
  return a && a.el?.isConnected && !isMobileApp() ? a : null;
}

/** D-054: the app runs in its phone mode (`html.imx-mobile`, set by the side menu's headless mode): no edit actions. */
export function isMobileApp(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('imx-mobile');
}

/**
 * Redraw scheduling shared by the renderer and the listing (D-021).
 * - WebSocket live: `redraw` runs when ThingsBoard pushes a change (batched: at most once per `minGapMs`),
 *   plus a safety redraw every 60 s.
 * - Socket down (or no WebSocket): polls like before, every `pollMs()` (read on each tick, so a range
 *   change takes effect at once).
 * Skipped while the browser tab is hidden. Returns a stop function (call it on widget destroy).
 * @param pollMs fallback poll interval in ms (e.g. 10 000 realtime, 60 000 historic).
 */
/**
 * D-042: the widget lends its ThingsBoard context to the live hub, which then subscribes through the dashboard's own
 * WebSocket instead of opening one of its own. Call on init; liveRelease on destroy.
 */
export function liveLend(tbCtx: any) {
  if (!registerLiveProvider(tbCtx)) return;
  const L = liveHub();
  if (L && !L.throughTb()) L.reconnect();
}
export function liveRelease(tbCtx: any) {
  unregisterLiveProvider(tbCtx);
  const L = liveHub();
  // another widget can carry the subscriptions: move there at once (without one, Live's own back-off applies)
  if (L && !L.throughTb() && currentProvider()) L.reconnect();
}

export function scheduleRedraw(redraw: () => void, pollMs: () => number, minGapMs = 2000): () => void {
  const L = liveHub();
  let last = Date.now();
  let queued: any = null;
  const run = () => {
    queued = null;
    if (document.hidden) return;
    last = Date.now();
    redraw();
  };
  const off = L?.onChange(() => {
    if (queued) return;
    queued = setTimeout(run, Math.max(0, minGapMs - (Date.now() - last)));
  });
  // 1 s tick: decides between the fallback poll (socket down) and the 60 s safety redraw (socket live).
  const tick = setInterval(() => {
    const live = L?.isLive() ?? false;
    const every = live ? 60e3 : pollMs();
    if (Date.now() - last >= every) run();
  }, 1000);
  // D-028: hidden tabs skip redraws; bring a tab up to date as soon as it is shown again
  const onVis = () => !document.hidden && Date.now() - last > minGapMs && run();
  document.addEventListener('visibilitychange', onVis);
  return () => {
    off?.();
    clearInterval(tick);
    if (queued) clearTimeout(queued);
    document.removeEventListener('visibilitychange', onVis);
  };
}
