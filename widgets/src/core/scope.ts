// core/scope.ts — the user context: who is logged in, WHAT they may do (role), WHERE they may look (access), the
// hierarchy they see, the customer's DashboardStore asset and the property catalogue (DECISIONS D-011, D-018, D-050).
//
// Main exports:
//   loadUserContext()   builds a UserContext
//   loadPerms()         the role only (D-052: no tree, no relations)
//   liveKeys()          merges the machines' live telemetry keys into ctx.profileKeys (the only other network I/O)
//   clearRelCache()     drops the cached scope relations
//   isGrantedMachine / isVisibleNode / holdsAll / devicesUnder / allDevices / ancestors / pathLabel / siblings /
//   nearest / nodesContaining
//                       pure queries over the loaded tree (no network)
// Called by: entries/common.ts `userContext()` (which caches ONE context per page for 5 minutes,
// or until forced), then passed to everything in core/store.ts, core/chat.ts, the builder and the
// renderer. This module itself does not cache (the relations and the role store aside, below).
//
// How the context is built (D-050: the shared access and role cores, core/access.ts and core/perm.ts, the same rules as
// the iMEX app's widgets and the Reports and AI services):
//   1. GET /api/auth/user, then the user's SERVER_SCOPE attributes (one read: imexAccess, selectedNodes, imexRole,
//      Role, dbbAdmin, names, dbb_personal).
//   2. WHERE = `imexAccess` ({ v: 1, grants: [{ id, type, mode }] }); while it is absent, the legacy `selectedNodes`
//      (every shape seen so far; entries without an id are matched by name, then label, among the customer's assets
//      and devices). An unreadable imexAccess, or none at all, is NO equipment (fail closed). An ASSET 'all' grant is
//      the asset and everything below it, now and later; a DEVICE grant is that machine only.
//   3. WHAT = the role: `imexRole` looked up in the role store `imexRoles` on the customer's "System Configuration"
//      asset (or the app's sessionStorage copy `imex-roles:<customerId>`, 2 minutes); without imexRole the legacy
//      `Role` / `dbbAdmin` (Admin, Customer Admin, Administrator or dbbAdmin = Admin; anything else = Viewer). No store
//      (POC customers) = the built-in Admin and Viewer. `ctx.perms` answers page / can / canState; the Builder's
//      three flags are `canBuild` (dashboards.build), `canApplyMany` (dashboards.applyMany) and `canDeleteAny`
//      (dashboards.deleteAny). `isAdmin` is kept one release as an alias of canBuild.
//   4. Tenant-admin mode (D-018): a TENANT_ADMIN is unrestricted (every page, every action, every machine). The
//      widget setting `customerId` picks the customer; its top-level assets become 'all' grants. D-052: the tops and
//      their trees are the iMEX app's (imxShell.scopeTree: `imex-tops:<userId>` and the shared relations entry of
//      every top, FROM only), read or written here in the same shape (tenantTree): no relation request when the app
//      has just read them, else one per top; no walk up from each asset (only when the tops cannot be read).
//      `loadPerms()` is the role alone (no tree), for the headless launcher's isEditor().
//   5. Tree = ONE relations query per grant in each direction (FROM below an ASSET 'all' grant: assets and devices;
//      TO above every grant: assets), then ONE Entity Data Query per entity type for names, labels, profiles and the
//      `dbb_assign` attributes (D-022). The access core resolves it: `ctx.nodes` = the granted machines, the assets
//      under 'all' grants, and the NAV nodes (the ancestors of every grant, `nav: true`): shown as the path, nothing
//      below them is granted by them, and their children list only what the user sees. `ctx.rootIds` = the visible
//      tops; `ctx.allRoots` = the 'all' grants; `ctx.coversAll` = every top of the organisation is an 'all' grant
//      (required for customer-wide assignments).
//   6. Ancestors above the visible tops that are not in the tree (none in a normal hierarchy: the TO walk reaches the
//      top) stay in `aboveRoot`, with their `dbb_assign` (a location assignment above the user's scope still applies,
//      store.resolveForDevice).
//   7. Store = first asset of type `DashboardStore` assigned to the customer; one read of its attributes
//      `dbb_profile_keys` ({ [profile]: KeyMeta[] }, the property catalogue for the builder and chat),
//      `dbb_assign_customer`, `dbb_assign_rev` and `dbb_lib_version`.
//   Calls for a customer user with one grant: 9, in 4 rounds (auth user; user attributes + store lookup + role store;
//   2 relations queries + store attributes; 2 entity queries); 8 when the app's role store copy is fresh.
//   Problems are collected in `warnings` (shown by the UI) instead of throwing, where possible.
//   8. Not part of the load: `liveKeys(ctx, types)` adds the keys the machines actually send to `ctx.profileKeys`
//      (the catalogue is only an overlay for names and units, 9 Oct 2026). The builder, the chat and the default
//      machine page await it; it is cached per browser session.
//
// SECURITY: in ThingsBoard CE this scope and the role are enforced by the UI only (D-011, D-012, D-050). A customer user
// can read every device of their customer through the REST API and can write their own user attributes.

import * as api from './api';
import * as access from './access';
import * as perm from './perm';
import type { KeyMeta } from './types';
import * as machine from './machine';

/** One entity of the user's visible hierarchy (asset = location/site/line, device = machine). */
export interface Node {
  id: string;
  entityType: 'ASSET' | 'DEVICE';
  name: string;
  label: string;
  profile: string; // asset profile or device profile name (TB `type`)
  parentId: string | null;
  children: string[];
  /**
   * D-050: a location shown only as the path to granted equipment (an ancestor of a grant). Nothing below it is granted
   * by it, its `children` list only what the user sees, and it is no target for "all machines in this location".
   */
  nav?: boolean;
}

/** WHAT the user may do: the role core's answer (core/perm.ts), with the store revision it came from. */
export interface Perms {
  unrestricted: boolean;
  roleId: string | null;
  /** Role name shown in the UI ('Tenant administrator' for a tenant admin). */
  roleName: string;
  source: 'unrestricted' | 'imexRole' | 'legacy' | 'error';
  /** Codes from the cores (roles.store, role.gone, roles.unreadable, user.unreadable). */
  warnings: string[];
  eff: perm.Eff;
  /** `rev` of the role store read (0 = built-ins). */
  rev: number;
  page(key: string): perm.Level;
  can(keyOrAction: string, level?: string): boolean;
  canState(stateId: string): perm.Level;
}

/**
 * Everything the widgets need to know about the current user. Built by `loadUserContext()`,
 * treated as read-only afterwards (reload to pick up attribute or hierarchy changes).
 */
export interface UserContext {
  /** ThingsBoard user id (key for `dbb_personal` and `dbb_chat_resp_<userId>`). */
  userId: string;
  /** Customer id; for a tenant admin, the widget setting `customerId` ('' when unset). */
  customerId: string;
  email: string;
  displayName: string;
  /** Role name (the role store's name; tenant admins: their `Role` attribute, else 'Admin'). Shown and audited. */
  role: string;
  /** WHAT the user may do (D-050). */
  perms: Perms;
  /** May open the Dashboard Builder, save, customise and reset (`dashboards.build`). */
  canBuild: boolean;
  /** May apply a dashboard to more than one machine, a location or the customer, and change a shared one (`dashboards.applyMany`). */
  canApplyMany: boolean;
  /** May delete dashboards owned by others (`dashboards.deleteAny`). */
  canDeleteAny: boolean;
  /** @deprecated D-050: alias of `canBuild` for one release; use the three flags. */
  isAdmin: boolean;
  /** WHERE the user may look: the access core's answer (tenant admins: unrestricted). */
  access: access.Access;
  /** The visible tops of `nodes` (in grant order): where the tree starts. */
  rootIds: string[];
  /** The ASSET 'all' grants in `nodes` (normalized order); the first is the default location of a new widget. */
  allRoots: string[];
  /** Every top of the organisation is an 'all' grant: the user sees the whole organisation, now and later. */
  coversAll: boolean;
  /** @deprecated D-050: alias of `coversAll` for one release. */
  rootsAreTop: boolean;
  /** Every node the user sees by id: granted machines, assets under 'all' grants and the nav nodes above them. */
  nodes: Map<string, Node>;
  /** The customer's DashboardStore asset; null = saving and chat are unavailable. */
  store: api.EntityRef | null;
  /**
   * Properties per machine type: the catalogue (`catalogue`) plus, once `liveKeys` has run for the type, the keys
   * its machines actually send (9 Oct 2026). Await `liveKeys` first where the full list matters.
   */
  profileKeys: Record<string, KeyMeta[]>;
  /** The store attribute `dbb_profile_keys` as stored: names, units, decimals and limits per machine type. */
  catalogue: Record<string, KeyMeta[]>;
  /** `liveKeys` loads per machine type, in flight or done (each type is merged once per context). */
  liveLoads?: Map<string, Promise<void>>;
  /** Setup problems to show the user (missing store, no access, unresolved grants...). */
  warnings: string[];
  /**
   * Assignment snapshot used by store.resolveForDevice (D-022), so opening a machine page needs no
   * hierarchy walk. Refreshed when the store's `dbb_assign_rev` changes or `stale` is set (every write in
   * core/store.ts does both).
   */
  assign?: AssignSnapshot;
  /** Build of the widget library deployed last (store attribute `dbb_lib_version`, written by DBB_DEPLOY); '' when unknown. */
  deployedVersion?: string;
  /**
   * D-050: what the context was built from, for entries/common.ts: the granted ids in normalized order (the app's
   * `imex-access:<userId>` copy holds the same string) and the role store revision. A change in the app's copies
   * reloads the page's context.
   */
  sig?: { access: string; rolesRev: number; unrestricted: boolean };
}

/** See `UserContext.assign`. */
export interface AssignSnapshot {
  /** `dbb_assign` per device/asset id (nodes in scope and the ancestors above the roots); absent = none. */
  byId: Map<string, any>;
  /** Ancestor assets above each visible top that are not in `nodes`, nearest first: id, name, label. */
  aboveRoot: Map<string, { id: string; name: string; label: string }[]>;
  /** The user's `dbb_personal` ({ deviceId: dashboardId }). */
  personal: Record<string, string>;
  /** Store attribute `dbb_assign_customer`. */
  customer: Record<string, any>;
  /** Store attribute `dbb_assign_rev` when the snapshot was taken ('' = never written). */
  rev: string;
  /** When the snapshot was taken (ms). */
  at: number;
  /** Set by writes in core/store.ts: the next resolve reloads the snapshot. */
  stale: boolean;
}

/**
 * How long the scope's relations are kept in sessionStorage (D-037; D-050: 2 minutes, as the iMEX app's imxShell.tree that
 * shares the key, so a machine added under an 'all' grant shows in the Builder within the 5-minute page context).
 */
export const REL_CACHE_MS = 2 * 60 * 1000;
/** How long the app's copy of the role store (`imex-roles:<customerId>`, imxPerm) is used instead of a read. */
export const ROLES_MIRROR_MS = 2 * 60 * 1000;

/** Options for `loadUserContext`. */
export interface LoadOptions {
  /** Customer to show when a TENANT ADMIN opens the app (widget setting `customerId`). */
  tenantCustomerId?: string | null;
}

const isTenant = (me: any) => me?.authority === 'TENANT_ADMIN' || me?.authority === 'SYS_ADMIN';

/** The Perms of a role core answer. */
export function makePerms(info: { roleId: string | null; role: perm.Role | null; source: Perms['source']; warnings: string[] }, eff: perm.Eff, rev = 0): Perms {
  return {
    unrestricted: !!eff.unrestricted,
    roleId: info.roleId,
    roleName: eff.unrestricted ? 'Tenant administrator' : info.role?.name ?? '',
    source: info.source,
    warnings: info.warnings,
    eff,
    rev,
    page: (k) => perm.page(eff, k),
    can: (k, level) => (eff.unrestricted ? true : perm.can(eff, k, level)),
    canState: (s) => perm.canState(eff, s),
  };
}

/**
 * The customer's role store: the app's sessionStorage copy (`imex-roles:<customerId>`, written by imxPerm in the iMEX
 * app's widgets, same shape { at, raw }) when it is fresh, else one read of `imexRoles` on the System Configuration
 * asset (and the copy is written for the next page). No asset: raw null (the built-ins). A failed read: the built-ins
 * with the warning 'roles.unreadable' (fail closed: a custom role then falls back to Viewer).
 */
export async function readRoleStore(customerId: string): Promise<{ raw: unknown; warn: string | null }> {
  const mk = `imex-roles:${customerId}`;
  try {
    const hit = JSON.parse(sessionStorage.getItem(mk) || 'null');
    if (hit && Date.now() - hit.at < ROLES_MIRROR_MS && Object.prototype.hasOwnProperty.call(hit, 'raw')) return { raw: hit.raw, warn: null };
  } catch {
    /* no session storage, or not JSON */
  }
  try {
    const r = await api.systemConfigRoles();
    if (r)
      try {
        sessionStorage.setItem(mk, JSON.stringify({ at: Date.now(), raw: r.raw }));
      } catch {
        /* storage full or unavailable */
      }
    return { raw: r ? r.raw : null, warn: null };
  } catch {
    return { raw: null, warn: 'roles.unreadable' };
  }
}

/**
 * WHAT: the Perms of the logged-in user from their attributes and the role store (fail closed: an unreadable user has
 * every page hidden; a tenant admin is unrestricted), with the warnings to show. Pure.
 */
function rolePerms(me: any, tenant: boolean, attrs: Record<string, any>, attrsFailed: boolean, st: { raw: unknown; warn: string | null }): { perms: Perms; warnings: string[] } {
  const warnings: string[] = [];
  let perms: Perms;
  if (tenant) perms = makePerms({ roleId: null, role: null, source: 'unrestricted', warnings: [] }, perm.effective('unrestricted'));
  else if (attrsFailed) perms = makePerms({ roleId: null, role: null, source: 'error', warnings: ['user.unreadable'] }, perm.effective(null));
  else {
    const rs = perm.parseStore(st.raw);
    if (st.warn) rs.warnings = rs.warnings.concat([st.warn]);
    const info = perm.parseUser(rs, { imexRole: attrs.imexRole, Role: attrs.Role ?? attrs.role, dbbAdmin: attrs.dbbAdmin, authority: me.authority });
    perms = makePerms({ ...info, warnings: rs.warnings.concat(info.warnings) }, perm.effective(info.role), rs.rev);
    if (info.warnings.includes('role.gone')) warnings.push('Your role no longer exists; you have the Viewer role until an administrator gives you another.');
  }
  if (st.warn) warnings.push('The roles could not be read; custom roles act as Viewer for now.');
  return { perms, warnings };
}

/** The user attributes the role needs (loadPerms reads only these). */
const ROLE_KEYS = ['imexRole', 'Role', 'role', 'dbbAdmin'];

/**
 * D-052: WHAT only: the logged-in user's role, without the tree, the store or the catalogue. Calls: GET /api/auth/user
 * (shared with a load in flight), then the user's role attributes and the role store (or the app's copy of it); a
 * tenant admin: the first call only. No relation request. For the headless launcher's isEditor() (entries/common.ts
 * userPerms), so a page that shows only the app's menu builds no Builder context.
 */
export async function loadPerms(): Promise<Perms> {
  const me = await api.get<any>('/api/auth/user');
  if (isTenant(me)) return rolePerms(me, true, {}, false, { raw: null, warn: null }).perms;
  let attrsFailed = false;
  const [attrs, st] = await Promise.all([
    api.getAttrs({ id: me.id.id, entityType: 'USER' }, ROLE_KEYS).catch(() => {
      attrsFailed = true;
      return {} as Record<string, any>;
    }),
    readRoleStore(me.customerId?.id ?? ''),
  ]);
  return rolePerms(me, false, attrs, attrsFailed, st).perms;
}

/** Relations handed to buildTree instead of asking (D-052: the tenant admin's shared tree), one list per grant. */
interface PreTree {
  down: api.Rel[][];
  up: api.Rel[][];
}

/**
 * D-052: the tenant admin's tops and their trees, shared with the iMEX app's imxShell.scopeTree, so neither asks what
 * the other has just read (and the Builder no longer walks up from every customer asset: that was one relation request
 * per asset on every cold page load).
 *  - Tops: the app's copy `imex-tops:<userId>` ({ at, ids }, 2 minutes) or, without a fresh copy, api.locationTops()
 *    (2 entity queries, no relation request; the copy is written). The assets that Contain machines and lie below no
 *    other asset, of the whole tenant, sorted by id: the normalize() order of 'all' grants, so the key below is the app's.
 *  - Trees: the shared entry `imex-dbb-rel:<userId>:<every top>` in the app's shape ({ at, down, up: [] per top,
 *    names: true, types }; nothing is asked above a top), else one POST /api/relations/info FROM per top, written when
 *    every call answered (a deleted top, 404, adds nothing).
 *  - The customer's tops are the tops among the customer's assets; their `down` lists are returned for buildTree.
 * @param customerAssets the ids of the customer's assets (the store excluded).
 * @returns null when the tops cannot be read (the caller then walks up from each customer asset, as before).
 */
async function tenantTree(userId: string, customerAssets: Set<string>): Promise<{ grants: access.Grant[] } & PreTree | null> {
  let tops: string[] | null = null;
  const tk = `imex-tops:${userId}`;
  try {
    const hit = JSON.parse(sessionStorage.getItem(tk) || 'null');
    if (hit && Date.now() - hit.at < REL_CACHE_MS && Array.isArray(hit.ids) && hit.ids.every((x: unknown) => typeof x === 'string')) tops = hit.ids;
  } catch {
    /* no session storage, or not JSON */
  }
  if (!tops) {
    try {
      tops = await api.locationTops();
    } catch {
      return null;
    }
    try {
      sessionStorage.setItem(tk, JSON.stringify({ at: Date.now(), ids: tops }));
    } catch {
      /* storage full or unavailable */
    }
  }
  const all = tops;
  const grants = access.normalize(all.filter((id) => customerAssets.has(id)).map((id) => ({ id, type: 'ASSET', mode: 'all' })));
  if (!grants.length) return { grants, down: [], up: [] };
  const key = `imex-dbb-rel:${userId}:${all.join(',')}`;
  const types = all.map(() => 'ASSET').join(',');
  let down: api.Rel[][] | null = null;
  try {
    const hit = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (hit && hit.names && (hit.types === undefined || hit.types === types) && Date.now() - hit.at < REL_CACHE_MS && Array.isArray(hit.down) && hit.down.length === all.length && hit.down.every(Array.isArray)) down = hit.down;
  } catch {
    /* no session storage, or not JSON */
  }
  if (!down) {
    let failed = false;
    down = await Promise.all(
      all.map((id) =>
        api.relationInfosTree({ id, entityType: 'ASSET' }, 'FROM', ['ASSET', 'DEVICE']).catch((e) => {
          if (!(e instanceof api.ApiError && e.status === 404)) failed = true;
          return [] as api.RelInfo[];
        }),
      ),
    );
    if (!failed)
      try {
        sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), down, up: all.map(() => []), names: true, types }));
      } catch {
        /* storage full or unavailable: the next page asks again */
      }
  }
  const at = new Map(all.map((id, i) => [id, i]));
  return { grants, down: grants.map((g) => down![at.get(g.id)!] ?? []), up: grants.map(() => []) };
}

/**
 * Builds the UserContext for the logged-in user (see the file header for the steps).
 * Reads: /api/auth/user; the user's SERVER attributes; the role store (or the app's copy of it); the customer's assets
 * and devices (only for tenant-admin mode or legacy names); `Contains` relations around the grants and the entities
 * in them; the DashboardStore asset and its `dbb_profile_keys`. Writes nothing (but the sessionStorage copies).
 * callers cache the result (entries/common.ts).
 * @throws when /api/auth/user or the bulk asset/device lookup fails; other problems become `warnings` or are skipped.
 */
export async function loadUserContext(opts: LoadOptions = {}): Promise<UserContext> {
  const me = await api.get<any>('/api/auth/user');
  const tenant = isTenant(me);
  const userRef = { id: me.id.id, entityType: 'USER' };
  // The store (lookup + one attribute read) and the role store load in parallel with the user attributes and the tree.
  const custId: string = tenant ? opts.tenantCustomerId ?? '' : me.customerId?.id ?? '';
  const storeP = (async () => {
    if (!custId) return null;
    const r = await api.get<any>(`/api/customer/${custId}/assets?pageSize=5&page=0&type=DashboardStore`).catch(() => null);
    const a = r?.data?.[0];
    if (!a) return null;
    const ref = { id: a.id.id, entityType: 'ASSET' };
    return { ref, attrs: await api.getAttrs(ref, [...STORE_CTX_KEYS]).catch(() => ({}) as Record<string, any>) };
  })();
  const rolesP = tenant ? Promise.resolve({ raw: null, warn: null }) : readRoleStore(custId);
  let attrsFailed = false;
  const attrs = await api.getAttrs(userRef).catch(() => {
    attrsFailed = true;
    return {} as Record<string, any>;
  });

  // WHAT: the role (fail closed: an unreadable user has every page hidden)
  const { perms, warnings } = rolePerms(me, tenant, attrs, attrsFailed, await rolesP);
  const canBuild = perms.can('dashboards.build');
  const role = tenant ? String(attrs.Role ?? attrs.role ?? 'Admin') : perms.roleName || 'Viewer';

  const ctx: UserContext = {
    userId: me.id.id,
    customerId: tenant ? opts.tenantCustomerId ?? '' : me.customerId?.id,
    email: me.email,
    displayName: [attrs.firstName ?? me.firstName, attrs.lastName ?? me.lastName].filter(Boolean).join(' ') || me.email,
    role,
    perms,
    canBuild,
    canApplyMany: perms.can('dashboards.applyMany'),
    canDeleteAny: perms.can('dashboards.deleteAny'),
    isAdmin: canBuild,
    access: tenant ? access.unrestricted() : access.resolveTree([], null, { source: 'error' }),
    rootIds: [],
    allRoots: [],
    coversAll: tenant,
    rootsAreTop: tenant,
    nodes: new Map(),
    store: null,
    profileKeys: {},
    catalogue: {},
    warnings,
    sig: { access: '', rolesRev: perms.rev, unrestricted: tenant },
  };

  // WHERE: the grants
  let grants: access.Grant[] = [];
  let source: access.Source = 'imexAccess';
  let pre: PreTree | undefined;
  if (tenant) {
    // A tenant admin has no customer and no grants: show the configured customer's whole hierarchy.
    if (!ctx.customerId) warnings.push('Opened as tenant admin: set the widget setting "customerId" to choose which customer to show.');
    else {
      const assets = await api.get<any>(`/api/customer/${ctx.customerId}/assets?pageSize=1000&page=0`).catch(() => ({ data: [] }));
      // at most 1000 customer assets are considered
      const candidates = (assets.data as any[]).filter((a) => a.type !== 'DashboardStore');
      // D-052: the tops and their trees shared with the iMEX app (no relation request when the app has just read them)
      const shared = await tenantTree(ctx.userId, new Set(candidates.map((a) => a.id.id)));
      if (shared) {
        grants = shared.grants;
        pre = { down: shared.down, up: shared.up };
      } else {
        // the tops could not be read: top-level = no parent ASSET via Contains (one request per asset)
        const tops = await Promise.all(
          candidates.map(async (a) => ((await api.parentsOf({ id: a.id.id, entityType: 'ASSET' }).catch(() => [])).some((p) => p.from.entityType === 'ASSET') ? null : a)),
        );
        grants = access.normalize(tops.filter(Boolean).map((a: any) => ({ id: a.id.id, type: 'ASSET', mode: 'all' })));
      }
    }
  } else if (!attrsFailed) {
    const p = access.parse(attrs.imexAccess, attrs.selectedNodes);
    source = p.source;
    grants = p.grants.slice();
    if (p.source === 'invalid') warnings.push('Your equipment access could not be read. Ask your administrator.');
    // legacy entries without an id: by name, then label, among the customer's assets and devices (ASSET first)
    if (p.legacyNames.length && ctx.customerId) {
      const byName = await legacyCandidates(ctx.customerId, p.legacyNames);
      for (const n of p.legacyNames) {
        const hit = access.pickByName(byName[n]);
        if (hit) grants.push({ id: hit.id, type: hit.type, mode: hit.type === 'DEVICE' ? 'fixed' : 'all' });
        else warnings.push(`Selected node "${n}" was not found.`);
      }
    }
    grants = access.normalize(grants);
    // the same string as the app's `imex-access:<userId>` copy (entries/common.ts compares them)
    ctx.sig!.access = grants.map((g) => g.id).join(',');
    if (!grants.length && p.source !== 'invalid' && !warnings.length) warnings.push('No equipment is assigned to you yet. Ask your administrator.');
  } else {
    source = 'error';
    warnings.push('Your user settings could not be read. Reload the page.');
  }

  // D-064: the machine model (names, units, decimals, hidden keys, order per type) is read beside the store
  const [, sto, mm] = await Promise.all([buildTree(ctx, grants, attrs, tenant, source, false, pre), storeP, machine.load(api.systemConfigMachineModel)]);
  if (sto) ctx.store = sto.ref;
  else if (ctx.customerId) warnings.push('Dashboard store asset (type DashboardStore) is missing; saving is disabled.');
  const sa = sto?.attrs ?? {};
  ctx.catalogue = sa.dbb_profile_keys && typeof sa.dbb_profile_keys === 'object' ? sa.dbb_profile_keys : {};
  // a copy per type: liveKeys adds to these lists, the catalogue stays as stored
  // D-064: with the machine model laid over it (the app's Settings > Sites & machines wins over the catalogue)
  ctx.profileKeys = Object.fromEntries(Object.entries(ctx.catalogue).map(([p, ks]) => [p, machine.overlay(mm, p, Array.isArray(ks) ? [...ks] : [])]));
  ctx.deployedVersion = String(sa.dbb_lib_version ?? '');
  if (ctx.assign) {
    ctx.assign.customer = sa.dbb_assign_customer ?? {};
    ctx.assign.rev = String(sa.dbb_assign_rev ?? '');
  }
  return ctx;
}

/** Store attributes read with the user context (one call). */
export const STORE_CTX_KEYS = ['dbb_profile_keys', 'dbb_assign_customer', 'dbb_assign_rev', 'dbb_lib_version'] as const;

/**
 * Legacy `selectedNodes` names: candidates by name and by label among the customer's assets and devices (at most 1000
 * of each), in the shape `access.pickByName` takes. A list that cannot be read gives no candidates.
 */
async function legacyCandidates(customerId: string, names: string[]): Promise<Record<string, { id: string; type: 'ASSET' | 'DEVICE'; via: 'name' | 'label' }[]>> {
  const out: Record<string, { id: string; type: 'ASSET' | 'DEVICE'; via: 'name' | 'label' }[]> = {};
  for (const n of names) out[n] = [];
  const lists = await Promise.all(
    (['ASSET', 'DEVICE'] as const).map((t) =>
      api
        .get<any>(`/api/customer/${customerId}/${t === 'ASSET' ? 'assets' : 'devices'}?pageSize=1000&page=0`)
        .then((r) => ({ t, rows: (r?.data ?? []) as any[] }))
        .catch(() => ({ t, rows: [] as any[] })),
    ),
  );
  for (const { t, rows } of lists)
    for (const e of rows) {
      const id = e?.id?.id;
      if (!id) continue;
      if (Object.prototype.hasOwnProperty.call(out, e.name)) out[e.name].push({ id, type: t, via: 'name' });
      if (e.label && Object.prototype.hasOwnProperty.call(out, e.label)) out[e.label].push({ id, type: t, via: 'label' });
    }
  return out;
}

/**
 * (Re)loads `dbb_assign` of the given devices/assets in one Entity Data Query per entity type.
 * @returns id -> dbb_assign (ids without one are absent) plus the entity rows (names, labels, profiles).
 */
export async function loadAssignments(assetIds: string[], deviceIds: string[]) {
  const [assets, devices] = await Promise.all([
    assetIds.length ? api.entityData('ASSET', assetIds, { attrs: ['dbb_assign'] }) : Promise.resolve([] as api.EntityRow[]),
    deviceIds.length ? api.entityData('DEVICE', deviceIds, { attrs: ['dbb_assign'] }) : Promise.resolve([] as api.EntityRow[]),
  ]);
  const byId = new Map<string, any>();
  for (const r of [...assets, ...devices]) if (r.attrs.dbb_assign != null && r.attrs.dbb_assign !== '') byId.set(r.id, r.attrs.dbb_assign);
  return { byId, assets, devices };
}

/**
 * Loads the hierarchy around the grants into `ctx.nodes`, `ctx.rootIds`, `ctx.allRoots`, `ctx.access`, `ctx.coversAll`
 * and the assignment snapshot `ctx.assign` (D-022, D-050).
 * Structure: one POST /api/relations per grant in each direction (all levels at once): FROM below an ASSET grant
 * (assets and devices), TO above every grant (assets). The access core (`access.resolveTree`) decides what is granted
 * (12 levels below an 'all' grant, cycle-safe) and what is only the path (nav). Parents: walked breadth-first from the
 * visible tops, first parent wins. Entities: one Entity Data Query for all assets and one for all devices (names,
 * labels, profiles, `dbb_assign`); they also tell which grants still exist (a deleted id is left out, with a warning).
 * A legacy ASSET grant whose id is a machine (a bare uuid in selectedNodes) is asked again as a DEVICE (one more
 * query) and the tree is loaded again for it.
 * @param userAttrs the user's SERVER attributes (for `dbb_personal`).
 * @param pre D-052: the relations already read (the tenant admin's shared tree, tenantTree): no cache, no request.
 */
async function buildTree(ctx: UserContext, grants: access.Grant[], userAttrs: Record<string, any>, tenant: boolean, source: access.Source, retyped = false, pre?: PreTree): Promise<void> {
  const refs = grants.map((g) => ({ id: g.id, entityType: g.type }));
  // D-037: the relations (2 calls per grant) are kept for the browser session per user and grant set (D-050: 2 minutes,
  // the app's time for the same key; it was 10).
  // Every page of the app loads the library again (the headless launcher is on each state), so without this a
  // user with 50 locations paid 100 relation calls on every page change. A failed call is never cached.
  // D-046: the iMEX app's widgets (imxShell.tree, the access resolver and the shift directory) read and write the same
  // key in the same shape {at, down, up} (one list per root, in root order; theirs may add `names`), so a page after
  // an app page needs no relation call here and the other way round. An entry of another shape is ignored.
  // D-050: the roots are the grants in the access core's normalized order (access.rootKey), as in the app.
  // D-051: the entry also records the roots' types (`types`, as the app writes it): a legacy grant asked as an ASSET and
  // then again as the machine it is (retyped) is not served the first answer. An entry without `types` still counts.
  const cacheKey = `imex-dbb-rel:${ctx.userId}:${refs.map((r) => r.id).join(',')}`;
  const rootTypes = refs.map((r) => r.entityType).join(',');
  let cached: { at: number; down: api.Rel[][]; up: api.Rel[][] } | null = pre && pre.down.length === refs.length && pre.up.length === refs.length ? { at: 0, ...pre } : null;
  if (!cached)
    try {
      const hit = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
      if (hit && (hit.types === undefined || hit.types === rootTypes) && Date.now() - hit.at < REL_CACHE_MS && Array.isArray(hit.down) && Array.isArray(hit.up) && hit.down.length === refs.length && hit.up.length === refs.length && [...hit.down, ...hit.up].every(Array.isArray)) cached = hit;
    } catch {
      /* no session storage, or not JSON */
    }
  // D-051: a granted root ThingsBoard no longer has (404: deleted) simply adds no relations (the access core reports it
  // as gone, the result may be cached, as the app's imxShell.tree does); any other failed call fails closed below
  let failed = false;
  const miss = (e: unknown): api.Rel[] => {
    if (e instanceof api.ApiError && e.status === 404) return [];
    failed = true;
    return [];
  };
  const [down, up] = cached
    ? [cached.down, cached.up]
    : refs.length
      ? await Promise.all([
          Promise.all(refs.map((r) => (r.entityType === 'ASSET' ? api.relationsTree(r, 'FROM', ['ASSET', 'DEVICE']).catch(miss) : Promise.resolve([] as api.Rel[])))),
          Promise.all(refs.map((r) => api.relationsTree(r, 'TO', ['ASSET']).catch(miss))),
        ])
      : [[], []];
  if (!cached && !failed && refs.length) {
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), down, up, types: rootTypes }));
    } catch {
      /* storage full or unavailable: the next page asks again */
    }
  }
  // D-051: a part of the tree that could not be read is no partial access: a customer user gets none (fail closed, as
  // the app's "Your access could not be checked"); a tenant admin (unrestricted) keeps what was read
  if (failed && !tenant) {
    ctx.warnings.push('Your equipment access could not be checked. Reload the page.');
    return;
  }

  // the Contains tree for the access core: below the grants (asset -> asset | device), above them (asset -> anything)
  const types = new Map<string, string>();
  const rels: [string, string][] = [];
  for (const r of refs) types.set(r.id, r.entityType);
  const link = (rel: api.Rel) => {
    if (rel.type && rel.type !== 'Contains') return;
    if (rel.from.entityType !== 'ASSET' || (rel.to.entityType !== 'ASSET' && rel.to.entityType !== 'DEVICE')) return;
    // the relation's types are ThingsBoard's (a legacy grant may have guessed ASSET for a machine)
    types.set(rel.from.id, rel.from.entityType);
    types.set(rel.to.id, rel.to.entityType);
    rels.push([rel.from.id, rel.to.id]);
  };
  for (const rel of down.flat()) link(rel);
  for (const rel of up.flat()) link(rel);

  // every entity of the tree in 2 queries: names, labels, profiles, dbb_assign; what is missing no longer exists
  const ids = (t: string) => [...types].filter(([, v]) => v === t).map(([id]) => id);
  const { byId, assets, devices } = await loadAssignments(ids('ASSET'), ids('DEVICE'));
  const rows = new Map<string, api.EntityRow>();
  for (const r of [...assets, ...devices]) rows.set(r.id, r);

  // a legacy ASSET grant that is no asset may be a machine (a bare uuid in selectedNodes): ask once, then reload
  const lost = grants.filter((g) => g.type === 'ASSET' && !rows.has(g.id)).map((g) => g.id);
  if (lost.length && !retyped && !tenant) {
    const asDev = await api.entityData('DEVICE', lost, { fields: [] }).catch(() => [] as api.EntityRow[]);
    if (asDev.length) {
      const dev = new Set(asDev.map((r) => r.id));
      const fixed = access.normalize(grants.map((g) => (dev.has(g.id) ? { id: g.id, type: 'DEVICE', mode: 'fixed' } : g)));
      return buildTree(ctx, fixed, userAttrs, tenant, source, true);
    }
  }

  const spec: access.TreeSpec = { nodes: {}, rels };
  for (const [id, t] of types) spec.nodes![id] = { entityType: t, name: rows.get(id)?.fields.name ?? '' };
  const T = access.makeTree(spec);
  const label = (r: api.EntityRow) => r.fields.label || r.fields.name;
  const names: Record<string, string> = {};
  for (const [id, r] of rows) names[id] = label(r);
  // tenant admins: the tops resolve like 'all' grants for the tree; their access stays unrestricted
  const res = access.resolveTree(grants, T, { exists: [...rows.keys()], names, source });
  for (const u of res.unresolved) ctx.warnings.push(u.type === 'DEVICE' ? 'A machine assigned to you no longer exists.' : 'A location assigned to you no longer exists.');
  if (!tenant) {
    ctx.access = res;
    ctx.coversAll = ctx.rootsAreTop = res.coversAll;
  }

  // the nodes the user sees (and that could be loaded)
  const visible = (id: string) => rows.has(id) && (res.devices.has(id) || res.assets.has(id) || res.nav.has(id));
  const visParents = (id: string) => (T.parents[id] ?? []).filter(visible);
  // tops in grant order: walk up each grant's first visible parent
  const tops: string[] = [];
  for (const g of grants) {
    if (!visible(g.id)) continue;
    let cur = g.id;
    const guard = new Set([cur]);
    for (let p = visParents(cur)[0]; p && !guard.has(p); p = visParents(cur)[0]) {
      guard.add(p);
      cur = p;
    }
    if (!tops.includes(cur)) tops.push(cur);
  }
  const parent = new Map<string, string | null>();
  const bfs = (starts: string[]) => {
    let level = starts.filter((s) => !parent.has(s)).map((id) => ({ id, parentId: null as string | null }));
    while (level.length) {
      const next: typeof level = [];
      for (const n of level) {
        if (parent.has(n.id)) continue;
        parent.set(n.id, n.parentId);
        if (T.nodes[n.id]?.entityType === 'DEVICE') continue;
        for (const k of T.children[n.id] ?? []) if (visible(k)) next.push({ id: k, parentId: n.id });
      }
      level = next;
    }
  };
  bfs(tops);
  // anything not reached from a top (a cycle of nav nodes): its own start, in id order
  const rest = [...rows.keys()].filter((id) => visible(id) && !parent.has(id)).sort();
  for (const id of rest)
    if (!parent.has(id)) {
      tops.push(id);
      bfs([id]);
    }
  for (const id of parent.keys()) {
    const r = rows.get(id)!;
    const isDev = r.entityType === 'DEVICE';
    const n: Node = {
      id,
      entityType: isDev ? 'DEVICE' : 'ASSET',
      name: r.fields.name,
      label: label(r),
      profile: r.fields.type,
      parentId: parent.get(id) ?? null,
      children: isDev ? [] : (T.children[id] ?? []).filter(visible),
    };
    if (!isDev && res.nav.has(id)) n.nav = true;
    ctx.nodes.set(id, n);
  }
  ctx.rootIds = tops;
  ctx.allRoots = grants.filter((g) => res.allRoots.has(g.id) && ctx.nodes.has(g.id)).map((g) => g.id);

  // ancestors above the visible tops that are not in the tree (nearest first, first parent, cycle-safe)
  const aboveRoot = new Map<string, { id: string; name: string; label: string }[]>();
  for (const t of tops) {
    const chain: { id: string; name: string; label: string }[] = [];
    const guard = new Set([t]);
    for (let p = (T.parents[t] ?? [])[0]; p && !guard.has(p) && !ctx.nodes.has(p); p = (T.parents[p] ?? [])[0]) {
      guard.add(p);
      const r = rows.get(p);
      chain.push({ id: p, name: r?.fields.name ?? p, label: r ? label(r) : p });
    }
    aboveRoot.set(t, chain);
  }
  const personal = api.parseMaybeJson(userAttrs.dbb_personal);
  ctx.assign = { byId, aboveRoot, personal: personal && typeof personal === 'object' ? personal : {}, customer: {}, rev: '', at: Date.now(), stale: false };
}

/**
 * Drops the cached scope relations (D-037) of `userId` (every user when omitted), so the next loadUserContext
 * asks ThingsBoard again. Used when a machine is opened that the cached tree does not have yet (a machine
 * added after the cache was filled would otherwise be refused for up to REL_CACHE_MS). D-052: also the tenant admin's
 * tops copy `imex-tops:<userId>` (a machine in a new site), as the app's imxAccess.invalidate does.
 */
export function clearRelCache(userId?: string) {
  const prefixes = [`imex-dbb-rel:${userId ? `${userId}:` : ''}`, userId ? `imex-tops:${userId}` : 'imex-tops:'];
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && (k.startsWith(prefixes[0]) || (userId ? k === prefixes[1] : k.startsWith(prefixes[1])))) sessionStorage.removeItem(k);
    }
  } catch {
    /* no session storage */
  }
}

// ---------- live property keys (9 Oct 2026) ----------
// The catalogue `dbb_profile_keys` is written by DBB_DEPLOY and goes stale: a key a machine starts sending, or a
// machine type nobody catalogued, was missing from the property picker, the default machine page and the chat.
// The catalogue is now an overlay: the properties of a type are the keys its machines send (up to
// LIVE_KEYS_MAX_DEVICES of them in scope), with the catalogue's names, units, decimals and limits where it has them.

/** Machines of one type whose keys are listed (in parallel); the first ones in scope. */
export const LIVE_KEYS_MAX_DEVICES = 20;
/** How long the listed keys of a type are kept in sessionStorage. */
export const LIVE_KEYS_CACHE_MS = 5 * 60 * 1000;
/** Keys that are not properties: AI Insights outputs and the pre-aggregated copies of a value. */
export const NOT_A_PROPERTY = /^aiml_|_(2min|5min|30min|2hrs|6hrs|1day)$/;

/** Readable name for a key without a catalogue entry: "dischargePressure" / "discharge_pressure" -> "Discharge Pressure" / "Discharge pressure". */
export function readableKey(key: string): string {
  const s = key
    .replace(/[_\s]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

/**
 * Name for a key nobody has named: "line_speed" -> {name: "Line speed", unit: ""}. D-064: no unit is guessed from the
 * key's suffix any more (a guess such as "_f" -> °F was wrong as often as right): units come from the machine model
 * (the app's Settings > Sites & machines), the catalogue or the machines' telemetryKeys names.
 */
export function guessKey(key: string): { name: string; unit: string } {
  return { name: readableKey(key), unit: '' };
}

/** Name and unit from a machine's `telemetryKeys` entry label, e.g. "Airflow Rate (CFM)" -> {label: "Airflow Rate", unit: "CFM"}. */
function splitLabel(text: string): { label: string; unit: string } {
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(text);
  return m ? { label: m[1], unit: m[2] } : { label: text, unit: '' };
}

/**
 * Properties of one machine type: the catalogue entries first (as stored, also keys no machine sends yet, so
 * saved widgets keep theirs), then every other live key except NOT_A_PROPERTY. Those get the name and unit of
 * the machines' `telemetryKeys` list when it has them (in that list's order), else a readable name and the unit
 * of a snake_case suffix (guessKey); decimals 1,
 * range 0-100 like `keyMeta` gives unknown keys. Pure.
 * @param named key -> name/unit from the machines' `telemetryKeys` attribute (insertion order = list order).
 */
export function mergeKeys(catalogue: KeyMeta[], live: string[], named: Map<string, { label: string; unit: string }> = new Map()): KeyMeta[] {
  const have = new Set(catalogue.map((k) => k.key));
  const extra = [...new Set(live)].filter((k) => !have.has(k) && !NOT_A_PROPERTY.test(k));
  const order = [...named.keys()];
  const rank = (k: string) => (named.has(k) ? order.indexOf(k) : order.length);
  extra.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [
    ...catalogue,
    ...extra.map((key) => {
      const n = named.get(key);
      const g = guessKey(key);
      return { key, displayName: n?.label || g.name, unit: n?.unit || g.unit, decimals: 1, min: 0, max: 100 };
    }),
  ];
}

/** sessionStorage entry of one type's live keys. */
interface LiveEntry {
  at: number;
  keys: string[];
  named: [string, string, string][]; // key, name, unit
}

/**
 * Merges the live keys of the given machine types (default: every type in scope) into `ctx.profileKeys`.
 * Per type: GET /api/plugins/telemetry/DEVICE/{id}/keys/timeseries for up to LIVE_KEYS_MAX_DEVICES of its machines
 * in scope, plus ONE entity query (all types together) for their `telemetryKeys` attribute; kept in sessionStorage
 * for LIVE_KEYS_CACHE_MS per user and type. Each type is loaded once per context (concurrent callers share the
 * load). Never rejects: a failed read leaves the type's catalogue as it is (and is not cached).
 */
export function liveKeys(ctx: UserContext, profiles?: string[]): Promise<void> {
  const loads = (ctx.liveLoads ??= new Map());
  const want = [...new Set(profiles ?? allDevices(ctx).map((d) => d.profile))].filter((p) => p && !loads.has(p));
  if (want.length) {
    const job = loadLive(ctx, want).catch(() => undefined);
    for (const p of want) loads.set(p, job);
  }
  const all = [...new Set(profiles ?? [...loads.keys()])].map((p) => loads.get(p));
  return Promise.all(all).then(() => undefined);
}

async function loadLive(ctx: UserContext, profiles: string[]) {
  const cacheKey = (p: string) => `imex-dbb-keys:${ctx.userId}:${p}`;
  const fresh = new Map<string, LiveEntry>();
  const todo: string[] = [];
  for (const p of profiles) {
    try {
      const hit = JSON.parse(sessionStorage.getItem(cacheKey(p)) || 'null') as LiveEntry | null;
      if (hit && Date.now() - hit.at < LIVE_KEYS_CACHE_MS && Array.isArray(hit.keys) && Array.isArray(hit.named)) {
        fresh.set(p, hit);
        continue;
      }
    } catch {
      /* no session storage, or not JSON */
    }
    todo.push(p);
  }
  const devs = new Map(todo.map((p) => [p, allDevices(ctx, p).slice(0, LIVE_KEYS_MAX_DEVICES).map((d) => d.id)]));
  const ids = [...devs.values()].flat();
  if (ids.length) {
    let failed = 0;
    const [lists, rows] = await Promise.all([
      Promise.all(
        ids.map((id) =>
          api.timeseriesKeys(id).catch(() => {
            failed++;
            return [] as string[];
          }),
        ),
      ),
      api.entityData('DEVICE', ids, { fields: [], attrs: ['telemetryKeys'] }).catch(() => {
        failed++;
        return [] as api.EntityRow[];
      }),
    ]);
    const keysOf = new Map(ids.map((id, i) => [id, lists[i]]));
    const tkOf = new Map(rows.map((r) => [r.id, r.attrs.telemetryKeys]));
    for (const [p, dids] of devs) {
      const keys = [...new Set(dids.flatMap((id) => keysOf.get(id) ?? []))];
      const named = new Map<string, [string, string, string]>();
      for (const id of dids) {
        const list = api.parseMaybeJson(tkOf.get(id));
        for (const v of Array.isArray(list) ? list : []) {
          if (!v || typeof v.kpi !== 'string' || !v.label || named.has(v.kpi)) continue;
          const { label, unit } = splitLabel(String(v.label));
          named.set(v.kpi, [v.kpi, label, unit]);
        }
      }
      const e: LiveEntry = { at: Date.now(), keys, named: [...named.values()] };
      fresh.set(p, e);
      if (!failed)
        try {
          sessionStorage.setItem(cacheKey(p), JSON.stringify(e));
        } catch {
          /* storage full or unavailable */
        }
    }
  }
  for (const [p, e] of fresh) {
    const named = new Map(e.named.map(([k, label, unit]) => [k, { label, unit }]));
    ctx.profileKeys[p] = machine.overlay(machine.model(), p, mergeKeys(ctx.catalogue?.[p] ?? ctx.profileKeys[p] ?? [], e.keys, named));
  }
}

// ---------- tree queries (pure) ----------
// All work on the already-loaded `ctx.nodes` only, i.e. within what the user sees. D-050: a nav node (the path to
// granted equipment) is visible, but nothing below it is granted by it; its children are only what the user sees, so
// devicesUnder / siblings / nearest stay within the user's machines. UI-level checks only (D-012).

/** True when the machine is granted to the user (shown, openable, a target of their own changes). */
export function isGrantedMachine(ctx: Pick<UserContext, 'nodes'>, id: string): boolean {
  return ctx.nodes.get(id)?.entityType === 'DEVICE';
}

/** True when the node is shown to the user: a granted machine, an asset under an 'all' grant, or a nav node. */
export function isVisibleNode(ctx: Pick<UserContext, 'nodes'>, id: string): boolean {
  return ctx.nodes.has(id);
}

/**
 * True when the user holds the whole location: it is an 'all' grant or lies under one (every machine in it, now and
 * later). Needed for "all machines of a type in this location"; a nav node is never held.
 */
export function holdsAll(ctx: Pick<UserContext, 'nodes' | 'access'>, id: string): boolean {
  const n = ctx.nodes.get(id);
  return !!n && n.entityType === 'ASSET' && !n.nav && ctx.access.hasAll(id);
}

/** Devices at or below `nodeId` (a device id returns itself), optionally only of `profile`. */
export function devicesUnder(ctx: Pick<UserContext, 'nodes'>, nodeId: string, profile?: string): Node[] {
  const out: Node[] = [];
  const walk = (id: string) => {
    const n = ctx.nodes.get(id);
    if (!n) return;
    if (n.entityType === 'DEVICE') {
      if (!profile || n.profile === profile) out.push(n);
      return;
    }
    n.children.forEach(walk);
  };
  walk(nodeId);
  return out;
}

/** Every device in scope, optionally only of `profile`. */
export function allDevices(ctx: Pick<UserContext, 'nodes'>, profile?: string): Node[] {
  return [...ctx.nodes.values()].filter((n) => n.entityType === 'DEVICE' && (!profile || n.profile === profile));
}

/** Parents of a node within scope, nearest first (stops at the scope root; cycle-safe). */
export function ancestors(ctx: Pick<UserContext, 'nodes'>, id: string): Node[] {
  const out: Node[] = [];
  let cur = ctx.nodes.get(id)?.parentId ?? null;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const n = ctx.nodes.get(cur);
    if (!n) break;
    out.push(n);
    cur = n.parentId;
  }
  return out;
}

/** Breadcrumb label "Root › Site › Machine" within scope; '' for unknown ids. */
export function pathLabel(ctx: Pick<UserContext, 'nodes'>, id: string): string {
  const n = ctx.nodes.get(id);
  if (!n) return '';
  return [...ancestors(ctx, id).reverse().map((a) => a.label), n.label].join(' › ');
}

/** Devices of `profile` with the same parent as `deviceId` (includes the device itself when it matches); [] for a root. */
export function siblings(ctx: Pick<UserContext, 'nodes'>, deviceId: string, profile: string): Node[] {
  const p = ctx.nodes.get(deviceId)?.parentId;
  if (!p) return [];
  return (ctx.nodes.get(p)?.children ?? [])
    .map((c) => ctx.nodes.get(c)!)
    .filter((n) => n && n.entityType === 'DEVICE' && n.profile === profile);
}

/**
 * Closest other device of `profile` walking up from the device (checking each ancestor's subtree,
 * nearest first), e.g. the site weather station. Excludes the device itself; null when none in scope.
 */
export function nearest(ctx: Pick<UserContext, 'nodes'>, deviceId: string, profile: string): Node | null {
  for (const a of ancestors(ctx, deviceId)) {
    const hits = devicesUnder(ctx, a.id, profile).filter((d) => d.id !== deviceId);
    if (hits.length) return hits[0];
  }
  return null;
}

/** Locations the user holds in full (holdsAll) that contain at least one device of the profile (for "apply to node" options). */
export function nodesContaining(ctx: Pick<UserContext, 'nodes' | 'access'>, profile: string): Node[] {
  return [...ctx.nodes.values()].filter((n) => holdsAll(ctx, n.id) && devicesUnder(ctx, n.id, profile).length > 0);
}
