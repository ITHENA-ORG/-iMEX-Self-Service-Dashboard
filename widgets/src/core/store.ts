// core/store.ts — dashboard storage, assignments and resolution (DECISIONS D-013, D-015, D-017, D-050).
//
// Everything lives in ThingsBoard SERVER_SCOPE attributes, written as the logged-in customer user
// (no tenant credentials, D-010). Customers can't write customer attributes (D-012), so dashboards
// live on one DashboardStore asset per customer (`ctx.store`, found by core/scope.ts).
//
// Store asset (type DashboardStore, one per TB customer):
//   dbb_d_<id>            Dashboard JSON (core/schema.ts format)
//   dbb_h_<id>            last 10 previous versions [{version, savedAt, savedBy, doc}], newest first
//   dbb_vis_<id>          'private' | 'shared' (missing = shared; private = listed for the owner only)
//   dbb_assign_customer   { [profile]: Assignment }        customer-wide per machine type
// Asset (site/plant/line/org):
//   dbb_assign            { [profile]: Assignment }        all machines of a type under this node
// Device:
//   dbb_assign            DeviceAssignment                 this machine only / copy / customised
// User:
//   dbb_personal          { [deviceId]: dashboardId }      personal override (only this user;
//                                                         still resolved, no longer created by the UI, D-017)
//
//   dbb_assign_rev        changes on every assignment write (D-022; tells other pages their snapshot is old)
//   dbb_lib_version       build of the widget library deployed last (written by DBB_DEPLOY)
//
// Resolution (`resolveForDevice`): first match of
//   personal > device > nearest ancestor location (walking the REAL hierarchy up) > customer-wide
//   > built-in default layout (dashboard null).
// All matches are returned as `candidates` for the "Show dashboard" switcher.
// D-022: the assignments come from the snapshot loaded with the user context (`ctx.assign`), so a machine
// page costs ONE store read (dashboards + `dbb_assign_rev`); the snapshot is reloaded (3 calls) only when
// `dbb_assign_rev` changed or this page wrote an assignment. Devices outside the snapshot use the old walk.
//
// Saving: `saveDashboard` validates (Zod + checkDashboard incl. property kinds), then uses
// optimistic concurrency on `version` and keeps history. Two attribute writes are not atomic in
// ThingsBoard, so two users saving at the same moment can still both succeed (last write wins).
//
// Apply / customise / reset: `apply` writes assignments; `customise` makes a per-machine copy;
// `resetDevice` removes the device assignment (and its copy). Callers (builder, renderer entry)
// write the audit entry (core/audit.ts) after each of these.
//
// SECURITY (D-012): every permission check here (`canApply`, owner / `dashboards.deleteAny` on delete, scope checks;
// D-050: the role flags and the access core's grants of core/scope.ts) runs in the browser only. A customer user can
// write any of these attributes directly via REST.

import * as api from './api';
import { Dashboard, checkDashboard, newId } from './schema';
import { metaLookup } from './compat';
import type { UserContext } from './scope';
import * as scope from './scope';

/** A dashboard assigned at node or customer level: which dashboard, who assigned it (display name), when (ms). */
export interface Assignment {
  dashboardId: string;
  by: string;
  at: number;
}
/**
 * Device-level assignment. `linked` = follows the shared dashboard; `copy` = an independent copy
 * made by a copy-mode apply; `customised` = copy made by "Customise for this machine".
 */
export interface DeviceAssignment extends Assignment {
  mode: 'linked' | 'copy' | 'customised';
}

/** Where the dashboard shown on a machine comes from; 'node' = an ancestor location. */
export type SourceLevel = 'personal' | 'device' | 'node' | 'customer' | 'default';
/** Result of `resolveForDevice`. */
export interface Resolved {
  dashboard: Dashboard | null; // null => default auto layout
  level: SourceLevel;
  sourceLabel: string;
  sourceNodeId?: string;
  deviceAssignment?: DeviceAssignment | null;
  /** Every dashboard that applies to this device, most specific first (for the switcher). */
  candidates: { dashboard: Dashboard; level: SourceLevel; sourceLabel: string }[];
}

// attribute key builders and entity refs
const D = (id: string) => `dbb_d_${id}`;
const H = (id: string) => `dbb_h_${id}`;
const VIS = (id: string) => `dbb_vis_${id}`;
const dev = (id: string): api.EntityRef => ({ id, entityType: 'DEVICE' });
const asset = (id: string): api.EntityRef => ({ id, entityType: 'ASSET' });

/** D-074: largest dashboard document (characters of its JSON) and largest single save (document + kept versions). */
export const DOC_CHARS = 2_500_000;
export const SAVE_CHARS = 8_000_000;

/** Thrown by `saveDashboard` when the stored version differs from the one being saved; carries the stored copy. */
export class ConflictError extends Error {
  constructor(public current: Dashboard) {
    super(`This dashboard was changed by ${current.updatedBy} (version ${current.version}).`);
  }
}

/** The customer's store asset, or throws when the customer has none (saving disabled). */
function requireStore(ctx: UserContext): api.EntityRef {
  if (!ctx.store) throw new Error('Dashboard store is not set up for this customer.');
  return ctx.store;
}

// ---------- dashboards ----------

/**
 * All dashboards on the store asset, newest first, with their visibility.
 * Reads the store's SERVER attribute key list, then every `dbb_d_*` / `dbb_vis_*` value (so it grows
 * with the number of dashboards). Documents that fail the schema are skipped silently; private
 * dashboards of other users are hidden (UI-only, D-012).
 */
export async function listDashboards(ctx: UserContext, maxAgeMs = 0): Promise<(Dashboard & { visibility: string })[]> {
  const store = requireStore(ctx);
  // D-046: with maxAgeMs (the Dashboard list / Dashboards page, which is asked for twice in a row) a list read less
  // than maxAgeMs ago is served again, unless anything was written meanwhile through this page (api.writeEpoch).
  // Everyone else reads fresh, as before.
  const key = `${store.id}|${ctx.userId}`;
  const ep = api.writeEpoch();
  if (maxAgeMs > 0 && listCache && listCache.key === key && listCache.epoch === ep && Date.now() - listCache.at < maxAgeMs) return (await listCache.p).slice();
  const entry = { key, epoch: ep, at: Date.now(), p: readDashboards(ctx, store) };
  listCache = entry;
  entry.p.catch(() => {
    if (listCache === entry) listCache = null;
  });
  return (await entry.p).slice();
}

/** How long the Dashboard list may reuse a list it has just read (ms; listDashboards maxAgeMs). */
export const LIST_REUSE_MS = 5000;
let listCache: { key: string; epoch: number; at: number; p: Promise<(Dashboard & { visibility: string })[]> } | null = null;

/** Reads every dashboard of the store (see listDashboards). */
async function readDashboards(ctx: UserContext, store: api.EntityRef): Promise<(Dashboard & { visibility: string })[]> {
  const keys = await api.get<string[]>(`/api/plugins/telemetry/ASSET/${store.id}/keys/attributes/SERVER_SCOPE`);
  const want = keys.filter((k) => k.startsWith('dbb_d_') || k.startsWith('dbb_vis_'));
  if (!want.length) return [];
  const attrs = await api.getAttrs(store, want);
  const out: (Dashboard & { visibility: string })[] = [];
  for (const k of Object.keys(attrs)) {
    if (!k.startsWith('dbb_d_')) continue;
    const p = Dashboard.safeParse(attrs[k]);
    // D-028: the document must be the one its key names (an id inside the JSON is not trusted on its own)
    if (!p.success || k !== `dbb_d_${p.data.id}`) continue;
    const vis = attrs[VIS(p.data.id)] ?? 'shared';
    if (vis === 'private' && p.data.ownerId !== ctx.userId) continue;
    out.push({ ...p.data, visibility: vis });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One dashboard from `dbb_d_<id>`, or null when missing or not a valid dashboard. */
export async function getDashboard(ctx: UserContext, id: string): Promise<Dashboard | null> {
  const a = await api.getAttrs(requireStore(ctx), [D(id)]);
  const p = Dashboard.safeParse(a[D(id)]);
  return p.success ? p.data : null;
}

/**
 * Saves a dashboard to the store asset with optimistic concurrency.
 * Steps: Zod parse -> `checkDashboard` with property kinds (throws all problems as one message) ->
 * read `dbb_d_<id>` and `dbb_h_<id>` -> version check -> write the new document (version + 1,
 * updatedAt/updatedBy = now/this user) and the history (previous document prepended, max 10) in
 * one attribute POST. Visibility `dbb_vis_<id>` is written when given, or 'shared' for a new dashboard.
 * @param doc        the draft; `doc.version` must equal the stored version (0 for a new dashboard).
 * @param visibility optional new visibility.
 * @returns the saved document (with the new version).
 * @throws ConflictError when someone else saved in between (the UI offers reload / save as copy);
 *         Error when a non-zero version no longer exists, or the store is missing.
 * Permission to overwrite a shared dashboard (D-015) is decided by the builder, not here.
 */
export async function saveDashboard(
  ctx: UserContext,
  doc: Dashboard,
  visibility?: 'private' | 'shared',
): Promise<Dashboard> {
  const store = requireStore(ctx);
  const parsed = Dashboard.parse(doc);
  const problems = checkDashboard(parsed, metaLookup(ctx, parsed));
  if (problems.length) throw new Error(problems.join(' '));
  const cur = await api.getAttrs(store, [D(doc.id), H(doc.id)]);
  const existing = Dashboard.safeParse(cur[D(doc.id)]);
  if (existing.success && existing.data.version !== doc.version) throw new ConflictError(existing.data);
  if (!existing.success && doc.version !== 0) throw new Error('Dashboard no longer exists; use Save as.');
  const next: Dashboard = { ...parsed, version: doc.version + 1, updatedAt: Date.now(), updatedBy: ctx.displayName };
  const hist: any[] = Array.isArray(cur[H(doc.id)]) ? cur[H(doc.id)] : [];
  if (existing.success) hist.unshift({ version: existing.data.version, savedAt: existing.data.updatedAt, savedBy: existing.data.updatedBy, doc: existing.data });
  // D-074: one save stays well under the platform's request limit: the document is capped (uploaded images: checkDashboard)
  // and only as many earlier versions are kept as fit in SAVE_CHARS (newest first; at most 10)
  const docChars = JSON.stringify(next).length;
  if (docChars > DOC_CHARS) throw new Error(`This dashboard is too large to save (${Math.round(docChars / 1024)} KB; at most ${Math.round(DOC_CHARS / 1024)} KB). Remove uploaded images or widgets, or use https:// image addresses.`);
  const keep = hist.slice(0, 10);
  let histChars = JSON.stringify(keep).length;
  while (keep.length && docChars + histChars > SAVE_CHARS) histChars -= JSON.stringify(keep.pop()).length + 1;
  const attrs: Record<string, unknown> = { [D(doc.id)]: next, [H(doc.id)]: keep };
  if (visibility) attrs[VIS(doc.id)] = visibility;
  else if (!existing.success) attrs[VIS(doc.id)] = 'shared';
  await api.saveAttrs(store, attrs);
  return next;
}

/** Previous versions of a dashboard from `dbb_h_<id>` (newest first, at most 10); [] when none. */
export async function versions(ctx: UserContext, id: string): Promise<{ version: number; savedAt: number; savedBy: string; doc: Dashboard }[]> {
  const a = await api.getAttrs(requireStore(ctx), [H(id)]);
  const raw: unknown[] = Array.isArray(a[H(id)]) ? a[H(id)] : [];
  // D-028: history entries are validated like dashboards (they are rendered and can be restored)
  const out: { version: number; savedAt: number; savedBy: string; doc: Dashboard }[] = [];
  for (const v of raw.slice(0, 10) as any[]) {
    const doc = Dashboard.safeParse(v?.doc);
    if (!doc.success || !Number.isInteger(v.version) || typeof v.savedAt !== 'number') continue;
    out.push({ version: v.version, savedAt: v.savedAt, savedBy: String(v.savedBy ?? '').slice(0, 120), doc: doc.data });
  }
  return out;
}

/**
 * Restores an older version by saving its document as a NEW version on top of the current one
 * (so the restore itself is in the history). Goes through `saveDashboard`, so the old version must
 * pass the current limits; throws when it does not, or when the version is not found.
 */
export async function restoreVersion(ctx: UserContext, id: string, version: number): Promise<Dashboard> {
  const [cur, hist] = await Promise.all([getDashboard(ctx, id), versions(ctx, id)]);
  const v = hist.find((h) => h.version === version);
  if (!cur || !v) throw new Error('Version not found.');
  return saveDashboard(ctx, { ...v.doc, version: cur.version });
}

/** New empty dashboard owned by the user (version 0, realtime); 'device' kind when a profile is given. Not saved. */
export function blankDashboard(ctx: UserContext, name: string, profile: string | null): Dashboard {
  return {
    schemaVersion: 1,
    id: newId('d'),
    name,
    kind: profile ? 'device' : 'standalone',
    profile,
    timeRange: 'realtime',
    widgets: [],
    ownerId: ctx.userId,
    ownerName: ctx.displayName,
    version: 0,
    updatedAt: Date.now(),
    updatedBy: ctx.displayName,
    copiedFrom: null,
  };
}

// ---------- assignments ----------

/** `dbb_assign` of a device or asset, or null (read errors are treated as "no assignment"). */
async function readAssign(e: api.EntityRef): Promise<any> {
  const a = await api.getAttrs(e, ['dbb_assign']).catch(() => ({}) as any);
  return a.dbb_assign ?? null;
}

/**
 * Walks up Contains relations through the real hierarchy (not limited to the user's scope), nearest
 * first, following the first ASSET parent at each level; at most 12 levels, cycle-safe.
 * Using the real hierarchy means a location assignment above the user's scope root still applies.
 * One REST call per level.
 */
export async function realAncestors(deviceId: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let cur: api.EntityRef = dev(deviceId);
  const guard = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const ps = await api.parentsOf(cur);
    const p = ps.find((r) => r.from.entityType === 'ASSET');
    if (!p || guard.has(p.from.id)) break;
    guard.add(p.from.id);
    out.push({ id: p.from.id, name: p.fromName ?? p.from.id });
    cur = p.from;
  }
  return out;
}

/**
 * Which dashboard a machine shows for this user (D-013): first match of personal (user
 * `dbb_personal`) > device (`dbb_assign` on the device) > nearest ancestor location (`dbb_assign[profile]`
 * on each real ancestor, nearest first) > customer-wide (store `dbb_assign_customer[profile]`)
 * > default layout (`dashboard: null`, level 'default').
 * Assignments whose dashboard is missing or invalid are skipped, so the next level wins.
 * Read-only. Normally ONE call (see D-022 in the file header); 3 more when the assignment snapshot is
 * reloaded; the old walk (about 3 + 2 x depth calls) for machines outside the snapshot.
 * @param profile the machine's device profile (assignments above device level are per profile).
 */
export async function resolveForDevice(ctx: UserContext, deviceId: string, profile: string): Promise<Resolved> {
  const snap = ctx.assign;
  if (!snap || !ctx.nodes.has(deviceId) || !ctx.store) return resolveFresh(ctx, deviceId, profile);
  const store = ctx.store;
  const read = async (ids: string[]) => api.getAttrs(store, [...ids.map(D), 'dbb_assign_rev', 'dbb_assign_customer']);
  let cands = snapshotCandidates(ctx, deviceId, profile);
  let got = await read([...new Set(cands.map((c) => c.id))]);
  if (snap.stale || String(got.dbb_assign_rev ?? '') !== snap.rev) {
    await refreshAssign(ctx, got);
    cands = snapshotCandidates(ctx, deviceId, profile);
    const need = [...new Set(cands.map((c) => c.id))].filter((id) => !(D(id) in got));
    if (need.length) got = { ...got, ...(await api.getAttrs(store, need.map(D))) };
  }
  return finish(cands, got, ctx.assign!.byId.get(deviceId) ?? null);
}

type Cand = { id: string; level: SourceLevel; sourceLabel: string; nodeId?: string };

/** Candidates from the assignment snapshot: personal, device, in-scope ancestors, ancestors above the root, customer. */
function snapshotCandidates(ctx: UserContext, deviceId: string, profile: string): Cand[] {
  const snap = ctx.assign!;
  const cands: Cand[] = [];
  const personal = snap.personal?.[deviceId];
  if (personal) cands.push({ id: personal, level: 'personal', sourceLabel: 'Your personal view' });
  const devAssign = snap.byId.get(deviceId);
  if (devAssign?.dashboardId)
    cands.push({ id: devAssign.dashboardId, level: 'device', sourceLabel: devAssign.mode === 'customised' ? 'Customised for this machine' : 'Assigned to this machine' });
  const inScope = scope.ancestors(ctx, deviceId);
  const top = inScope.length ? inScope[inScope.length - 1].id : deviceId;
  const chain = [...inScope.map((n) => ({ id: n.id, label: n.label })), ...(snap.aboveRoot.get(top) ?? []).map((a) => ({ id: a.id, label: a.label }))];
  for (const a of chain) {
    const as = snap.byId.get(a.id)?.[profile];
    if (as?.dashboardId) cands.push({ id: as.dashboardId, level: 'node', sourceLabel: `All ${profile} machines in ${a.label}`, nodeId: a.id });
  }
  const cw = snap.customer?.[profile];
  if (cw?.dashboardId) cands.push({ id: cw.dashboardId, level: 'customer', sourceLabel: `All ${profile} machines` });
  return cands;
}

/**
 * Reloads the assignment snapshot (`ctx.assign`): `dbb_assign` of every node in scope and above the roots
 * (2 entity queries) and the user's `dbb_personal` (1 read). `storeAttrs` must hold the store's current
 * `dbb_assign_rev` / `dbb_assign_customer`; when omitted they are read too.
 */
export async function refreshAssign(ctx: UserContext, storeAttrs?: Record<string, any>): Promise<scope.AssignSnapshot> {
  const snap = ctx.assign!;
  const assets = [...ctx.nodes.values()].filter((n) => n.entityType === 'ASSET').map((n) => n.id);
  const devices = [...ctx.nodes.values()].filter((n) => n.entityType === 'DEVICE').map((n) => n.id);
  const above = [...new Set([...snap.aboveRoot.values()].flat().map((a) => a.id))].filter((id) => !ctx.nodes.has(id));
  const [a, u, st] = await Promise.all([
    scope.loadAssignments([...assets, ...above], devices),
    api.getAttrs({ id: ctx.userId, entityType: 'USER' }, ['dbb_personal']).catch(() => ({}) as any),
    storeAttrs ?? (ctx.store ? api.getAttrs(ctx.store, ['dbb_assign_rev', 'dbb_assign_customer']) : Promise.resolve({} as any)),
  ]);
  snap.byId = a.byId;
  snap.personal = u.dbb_personal && typeof u.dbb_personal === 'object' ? u.dbb_personal : {};
  snap.customer = st.dbb_assign_customer ?? {};
  snap.rev = String(st.dbb_assign_rev ?? '');
  snap.at = Date.now();
  snap.stale = false;
  return snap;
}

/**
 * Marks the snapshot stale and changes the store's `dbb_assign_rev`, after any assignment write, so this
 * page and every other open page reload their snapshot on the next resolve. Best effort.
 * @param extra other store attributes to write in the same call.
 */
async function assignChanged(ctx: UserContext, extra: Record<string, unknown> = {}) {
  if (ctx.assign) ctx.assign.stale = true;
  if (ctx.store) await api.saveAttrs(ctx.store, { ...extra, dbb_assign_rev: newId('v') }).catch(() => undefined);
}

/** Builds the Resolved result from candidates and the loaded dashboard documents. */
function finish(cands: Cand[], docs: Record<string, any>, devAssign: DeviceAssignment | null): Resolved {
  const candidates: Resolved['candidates'] = [];
  for (const c of cands) {
    const p = Dashboard.safeParse(docs[D(c.id)]);
    if (p.success) candidates.push({ dashboard: p.data, level: c.level, sourceLabel: c.sourceLabel });
  }
  const first = candidates[0];
  const nodeC = cands.find((c) => first && c.id === first.dashboard.id && c.level === first.level);
  return {
    dashboard: first?.dashboard ?? null,
    level: first?.level ?? 'default',
    sourceLabel: first?.sourceLabel ?? 'Default layout',
    sourceNodeId: nodeC?.nodeId,
    deviceAssignment: devAssign,
    candidates,
  };
}

/** Resolution by walking the real hierarchy with fresh reads (machines outside the snapshot; before D-022 the only path). */
async function resolveFresh(ctx: UserContext, deviceId: string, profile: string): Promise<Resolved> {
  const store = ctx.store;
  const [userAttrs, devAssign, anc, storeAttrs] = await Promise.all([
    api.getAttrs({ id: ctx.userId, entityType: 'USER' }, ['dbb_personal']).catch(() => ({}) as any),
    readAssign(dev(deviceId)),
    realAncestors(deviceId),
    store ? api.getAttrs(store, ['dbb_assign_customer']).catch(() => ({}) as any) : Promise.resolve({} as any),
  ]);
  const cands: { id: string; level: SourceLevel; sourceLabel: string; nodeId?: string }[] = [];
  const personal = userAttrs.dbb_personal?.[deviceId];
  if (personal) cands.push({ id: personal, level: 'personal', sourceLabel: 'Your personal view' });
  if (devAssign?.dashboardId)
    cands.push({
      id: devAssign.dashboardId,
      level: 'device',
      sourceLabel: devAssign.mode === 'customised' ? 'Customised for this machine' : 'Assigned to this machine',
    });
  const ancAssigns = await Promise.all(anc.map((a) => readAssign(asset(a.id))));
  anc.forEach((a, i) => {
    const as = ancAssigns[i]?.[profile];
    if (as?.dashboardId) {
      const label = ctx.nodes.get(a.id)?.label ?? a.name;
      cands.push({ id: as.dashboardId, level: 'node', sourceLabel: `All ${profile} machines in ${label}`, nodeId: a.id });
    }
  });
  const cw = storeAttrs.dbb_assign_customer?.[profile];
  if (cw?.dashboardId) cands.push({ id: cw.dashboardId, level: 'customer', sourceLabel: `All ${profile} machines` });

  // load the dashboards (dedupe)
  const ids = [...new Set(cands.map((c) => c.id))];
  const docs = ids.length && store ? await api.getAttrs(store, ids.map(D)) : {};
  return finish(cands, docs, devAssign);
}

/**
 * Where to apply a saved dashboard: the user's personal view of one machine, specific machines
 * (linked, or one independent copy each), all machines of a type under a location, all machines of
 * a type of the customer, or nowhere.
 */
export type ApplyTarget =
  | { type: 'personal'; deviceId: string }
  | { type: 'devices'; deviceIds: string[]; mode: 'linked' | 'copy' }
  | { type: 'node'; nodeId: string; profile: string }
  | { type: 'customer'; profile: string }
  | { type: 'managed'; profile: string }
  | { type: 'none' };

/**
 * D-065: "All <type> machines you manage" for a user whose access does not cover the whole organisation. It used to
 * be saved as a fixed list of machines (a device-level assignment on each), so a machine added later got no machine
 * page. Now it is resolved by type at view time, as far as the access allows:
 * - nodes:   every location the user holds in full (`ctx.allRoots`, 'all' grants): a location assignment
 *            `dbb_assign[profile]` there, which every machine of the type under it follows, also one added later;
 * - devices: the granted machines of the type outside those locations (fixed equipment grants: a machine added later is
 *            not in the user's access, so nothing more can follow): a device-level assignment each, as before;
 * - all:     every machine of the type the user sees now (the preview's "affected").
 */
export function managedPlan(ctx: Pick<UserContext, 'nodes' | 'access' | 'allRoots'>, profile: string): { nodes: scope.Node[]; devices: scope.Node[]; all: scope.Node[] } {
  const nodes = (ctx.allRoots ?? []).filter((id) => scope.holdsAll(ctx, id)).map((id) => ctx.nodes.get(id)!).filter(Boolean);
  const under = new Set<string>();
  for (const n of nodes) for (const d of scope.devicesUnder(ctx, n.id, profile)) under.add(d.id);
  const all = scope.allDevices(ctx, profile);
  return { nodes, devices: all.filter((d) => !under.has(d.id)), all };
}

/** The managed location of `deviceId` in a plan (the 'all' grant above it), or null for a fixed-grant machine. */
function planRootOf(ctx: Pick<UserContext, 'nodes'>, deviceId: string, rootIds: Set<string>): string | null {
  for (const a of scope.ancestors(ctx, deviceId)) if (rootIds.has(a.id)) return a.id;
  return null;
}

/** What an apply would do, shown before the admin confirms (`previewApply`). */
export interface ApplyPreview {
  affected: { id: string; label: string }[];
  /** Devices that currently show a different assigned dashboard and would switch. */
  replaced: { id: string; label: string; from: string }[];
  /** Devices with their own (device-level) dashboard, which a node/customer assignment will NOT override. */
  keepOwn: { id: string; label: string }[];
  /** Same-level assignment that will be replaced (asks "Replace existing?"). */
  replacesAssignment: { dashboardId: string; name: string } | null;
  missingKeys: { key: string; devices: string[] }[];
  errors: string[];
  /** D-074: the dashboard each slot the apply will write points at now (slotKey -> id or null); pass it to `apply`. */
  seen?: Record<string, string | null>;
}

/**
 * Permission check for an apply target (D-011, D-017, D-050). Returns a user-facing reason, or null if allowed.
 * - personal / none: always allowed.
 * - devices: all must be machines granted to the user; more than one needs `dashboards.applyMany`.
 * - node / customer: `dashboards.applyMany`; the node must be a location the user holds in full (an 'all' grant or
 *   under one: every machine there, now and later; a nav node is not enough); customer-wide needs `ctx.coversAll`.
 * SECURITY: UI-only (D-012); nothing on the server enforces this.
 */
export function canApply(ctx: UserContext, t: ApplyTarget): string | null {
  if (t.type === 'none' || t.type === 'personal') return null;
  if (t.type === 'devices') {
    if (t.deviceIds.length > 1 && !ctx.canApplyMany) return "Your role can't apply a dashboard to more than one machine.";
    const out = t.deviceIds.filter((d) => !scope.isGrantedMachine(ctx, d));
    return out.length ? 'Some machines are outside your access.' : null;
  }
  if (!ctx.canApplyMany) return "Your role can't apply a dashboard to all machines of a type.";
  if (t.type === 'node' && !scope.holdsAll(ctx, t.nodeId)) return 'That location is outside your access (you need all of it).';
  // D-065: the plan only holds locations the user holds in full and machines granted to them (managedPlan)
  if (t.type === 'managed' && !managedPlan(ctx, t.profile).all.length) return 'You manage no machines of this type.';
  if (t.type === 'customer') {
    // customer-wide requires the user's access to cover the whole organisation (every top is an 'all' grant)
    if (!ctx.coversAll) return 'Customer-wide assignment requires access to the whole organisation.';
  }
  return null;
}

/** Telemetry keys of a device; empty set on error. */
async function keysOf(ctx: UserContext, deviceId: string): Promise<Set<string>> {
  return new Set(await api.timeseriesKeys(deviceId).catch(() => []));
}

/**
 * Dry run of `apply` for the confirmation dialog. Read-only.
 * Fills: affected machines (in scope), machines that would switch from another dashboard,
 * machines keeping their own device-level dashboard (node/customer targets never override those),
 * a same-level assignment that would be replaced, keys used by 'current' widgets that some machines
 * have never reported, and the `canApply` error if any.
 * Cost: a full `resolveForDevice` plus a key listing per affected machine (slow on the demo server).
 */
export async function previewApply(ctx: UserContext, doc: Dashboard, t: ApplyTarget): Promise<ApplyPreview> {
  const pv: ApplyPreview = { affected: [], replaced: [], keepOwn: [], replacesAssignment: null, missingKeys: [], errors: [] };
  const deny = canApply(ctx, t);
  if (deny) pv.errors.push(deny);
  if (t.type === 'none') return pv;
  let devices: scope.Node[] = [];
  if (t.type === 'personal') devices = [ctx.nodes.get(t.deviceId)!].filter(Boolean);
  if (t.type === 'devices') devices = t.deviceIds.map((d) => ctx.nodes.get(d)!).filter(Boolean);
  if (t.type === 'node') devices = scope.devicesUnder(ctx, t.nodeId, t.profile);
  if (t.type === 'customer') devices = scope.allDevices(ctx, t.profile);
  // D-065: the managed locations (each a location assignment) and the fixed-grant machines (each a device assignment)
  const plan = t.type === 'managed' ? managedPlan(ctx, t.profile) : null;
  const planRoots = new Set(plan ? plan.nodes.map((n) => n.id) : []);
  const planFixed = new Set(plan ? plan.devices.map((d) => d.id) : []);
  if (plan) devices = plan.all;
  pv.affected = devices.map((d) => ({ id: d.id, label: d.label }));

  if (plan) {
    // a managed location that already shows another dashboard for this type: "Replace existing assignment?"
    const others: string[] = [];
    for (const n of plan.nodes) {
      const cur = (await readAssign(asset(n.id)))?.[t.type === 'managed' ? t.profile : ''];
      if (cur?.dashboardId && cur.dashboardId !== doc.id) others.push(cur.dashboardId);
    }
    if (others.length) {
      const other = await getDashboard(ctx, others[0]);
      const more = others.length > 1 ? ` and ${others.length - 1} more` : '';
      pv.replacesAssignment = { dashboardId: others[0], name: (other?.name ?? others[0]) + more };
    }
  }

  if (t.type === 'node') {
    const cur = (await readAssign(asset(t.nodeId)))?.[t.profile];
    if (cur?.dashboardId && cur.dashboardId !== doc.id) {
      const other = await getDashboard(ctx, cur.dashboardId);
      pv.replacesAssignment = { dashboardId: cur.dashboardId, name: other?.name ?? cur.dashboardId };
    }
  }
  if (t.type === 'customer' && ctx.store) {
    const cur = (await api.getAttrs(ctx.store, ['dbb_assign_customer'])).dbb_assign_customer?.[t.profile];
    if (cur?.dashboardId && cur.dashboardId !== doc.id) {
      const other = await getDashboard(ctx, cur.dashboardId);
      pv.replacesAssignment = { dashboardId: cur.dashboardId, name: other?.name ?? cur.dashboardId };
    }
  }

  // per-device: current resolution + key availability
  const usedKeys = [...new Set(doc.widgets.filter((w) => w.binding.mode === 'current').flatMap((w) => w.keys))];
  const missing = new Map<string, string[]>();
  await Promise.all(
    devices.map(async (d) => {
      const [res, keys] = await Promise.all([resolveForDevice(ctx, d.id, d.profile), keysOf(ctx, d.id)]);
      const root = plan && !planFixed.has(d.id) ? planRootOf(ctx, d.id, planRoots) : null;
      // D-065: under a managed location a machine keeps its own (device-level) dashboard, or the one of a location
      // between it and the managed one (the nearest location wins); a fixed-grant machine is assigned directly
      const closer = (): boolean => {
        if (!root || res.level !== 'node' || !res.sourceNodeId || res.dashboard?.id === doc.id) return false;
        const anc = scope.ancestors(ctx, d.id).map((a) => a.id);
        const i = anc.indexOf(res.sourceNodeId);
        return i >= 0 && i < anc.indexOf(root);
      };
      if (root && ((res.deviceAssignment?.dashboardId && res.deviceAssignment.dashboardId !== doc.id) || closer())) pv.keepOwn.push({ id: d.id, label: d.label });
      else if ((t.type === 'node' || t.type === 'customer') && res.deviceAssignment?.dashboardId) pv.keepOwn.push({ id: d.id, label: d.label });
      else if (res.dashboard && res.dashboard.id !== doc.id && res.level !== 'personal')
        pv.replaced.push({ id: d.id, label: d.label, from: res.dashboard.name });
      for (const k of usedKeys) if (!keys.has(k)) missing.set(k, [...(missing.get(k) ?? []), d.label]);
    }),
  );
  pv.missingKeys = [...missing.entries()].map(([key, devs]) => ({ key, devices: devs }));
  // D-074: what the apply will overwrite, as it is now (apply refuses when it changed meanwhile)
  pv.seen = await seenSlots(ctx, doc, t);
  return pv;
}

/** D-074: one attribute an apply writes: a device's or location's `dbb_assign`, or the store's `dbb_assign_customer`. */
interface Slot {
  e: api.EntityRef;
  key: 'dbb_assign' | 'dbb_assign_customer';
  /** set for the per-type maps (location `dbb_assign`, `dbb_assign_customer`); unset for a device's own assignment */
  profile?: string;
  label: string;
}
interface SlotWrite {
  slot: Slot;
  /** the new value from the current one and the dashboard to assign (a copy's id in copy mode) */
  make: (cur: any, dashId: string) => unknown;
  /** copy mode: this machine gets its own copy of the dashboard first */
  copyFor?: string;
}
/** Key of a slot in `ApplyPreview.seen`. */
export const slotKey = (s: Pick<Slot, 'e' | 'key' | 'profile'>) => `${s.e.entityType}:${s.e.id}:${s.key}:${s.profile ?? ''}`;
/** The dashboard a slot's current value points at, or null. */
function slotDash(cur: any, s: Slot): string | null {
  const v = s.profile !== undefined ? cur?.[s.profile] : cur;
  return v && typeof v === 'object' && typeof v.dashboardId === 'string' ? v.dashboardId : null;
}

/** Thrown by `apply` when an assignment it would overwrite changed since the preview (another administrator). */
export class ApplyConflictError extends Error {}

/** What `apply` writes for a target (not personal / none) and which machines it covers. Pure. */
function planWrites(ctx: UserContext, doc: Dashboard, t: ApplyTarget, now: number): { writes: SlotWrite[]; covers: string[] } {
  const label = (id: string) => ctx.nodes.get(id)?.label ?? id;
  const a: Assignment = { dashboardId: doc.id, by: ctx.displayName, at: now };
  const merge = (profile: string) => (cur: any) => ({ ...(cur && typeof cur === 'object' ? cur : {}), [profile]: a });
  if (t.type === 'devices')
    return {
      writes: t.deviceIds.map((id) => ({ slot: { e: dev(id), key: 'dbb_assign', label: label(id) }, make: (_c: any, dashId: string): DeviceAssignment => ({ dashboardId: dashId, mode: t.mode, by: ctx.displayName, at: now }), copyFor: t.mode === 'copy' ? id : undefined })),
      covers: [...t.deviceIds],
    };
  if (t.type === 'managed') {
    // D-065: a location assignment on every managed location (followed by machines added there later), a device
    // assignment on each fixed-grant machine (see managedPlan)
    const plan = managedPlan(ctx, t.profile);
    return {
      writes: [
        ...plan.nodes.map((n) => ({ slot: { e: asset(n.id), key: 'dbb_assign' as const, profile: t.profile, label: n.label }, make: merge(t.profile) })),
        ...plan.devices.map((d) => ({ slot: { e: dev(d.id), key: 'dbb_assign' as const, label: d.label }, make: (): DeviceAssignment => ({ ...a, mode: 'linked' }) })),
      ],
      covers: plan.all.map((d) => d.id),
    };
  }
  if (t.type === 'node') return { writes: [{ slot: { e: asset(t.nodeId), key: 'dbb_assign', profile: t.profile, label: label(t.nodeId) }, make: merge(t.profile) }], covers: scope.devicesUnder(ctx, t.nodeId, t.profile).map((d) => d.id) };
  if (t.type === 'customer') return { writes: [{ slot: { e: requireStore(ctx), key: 'dbb_assign_customer', profile: t.profile, label: `all ${t.profile} machines` }, make: merge(t.profile) }], covers: scope.allDevices(ctx, t.profile).map((d) => d.id) };
  return { writes: [], covers: [] };
}

/**
 * D-074: the dashboard each slot an apply would write points at now, for `ApplyPreview.seen` (fresh reads, one per
 * slot; a slot that can't be read is left out and so not checked).
 */
async function seenSlots(ctx: UserContext, doc: Dashboard, t: ApplyTarget): Promise<Record<string, string | null>> {
  if (t.type === 'none' || t.type === 'personal' || canApply(ctx, t)) return {};
  const { writes } = planWrites(ctx, doc, t, Date.now());
  const out: Record<string, string | null> = {};
  await Promise.all(
    writes.map(async (w) => {
      const r = await api.getAttrs(w.slot.e, [w.slot.key]).catch(() => null);
      if (r) out[slotKey(w.slot)] = slotDash(r[w.slot.key] ?? null, w.slot);
    }),
  );
  return out;
}

/**
 * Applies a saved dashboard to a target (checks `canApply` first, throws its reason).
 * Writes:
 * - personal: user attribute `dbb_personal[deviceId]`.
 * - devices:  device `dbb_assign` = DeviceAssignment; in copy mode first saves one independent
 *             dashboard per machine (`copiedFrom` = doc.id) and assigns that.
 * - node:     asset `dbb_assign[profile]` (merged with other profiles' entries).
 * - customer: store `dbb_assign_customer[profile]` (merged).
 * - managed:  D-065: asset `dbb_assign[profile]` on every managed location + device `dbb_assign` on each fixed-grant
 *             machine of the type (managedPlan).
 * D-074 (round 11 audit):
 * - every slot is read fresh first; with `opts.seen` (the preview's `seen`) a slot whose dashboard changed since the
 *   preview stops the apply before anything is written (`ApplyConflictError`: two administrators no longer overwrite
 *   each other silently); the per-type maps are merged into the fresh value;
 * - a write that fails part-way puts back what this apply already wrote (and deletes its copies), tells the other
 *   pages (`dbb_assign_rev`) and throws a message that says so; nothing is reported as applied;
 * - the customer-wide assignment is no longer written inside the best-effort revision bump (its failure was swallowed
 *   and the Builder said "Applied").
 * Device-level assignments are not touched by node/customer applies (they keep winning).
 * @returns ids of the machines in scope that the assignment covers (for the audit/summary).
 */
export async function apply(ctx: UserContext, doc: Dashboard, t: ApplyTarget, opts: { seen?: Record<string, string | null> } = {}): Promise<string[]> {
  const deny = canApply(ctx, t);
  if (deny) throw new Error(deny);
  const now = Date.now();
  if (t.type === 'none') return [];
  if (t.type === 'personal') {
    const cur = (await api.getAttrs({ id: ctx.userId, entityType: 'USER' }, ['dbb_personal'])).dbb_personal ?? {};
    await api.saveAttrs({ id: ctx.userId, entityType: 'USER' }, { dbb_personal: { ...cur, [t.deviceId]: doc.id } });
    await assignChanged(ctx);
    return [t.deviceId];
  }
  const { writes, covers } = planWrites(ctx, doc, t, now);
  // 1. what is there now (a read error stops here, before anything is written)
  const cur = await Promise.all(writes.map((w) => api.getAttrs(w.slot.e, [w.slot.key]).then((r) => (r[w.slot.key] === undefined ? null : r[w.slot.key]))));
  const seen = opts.seen;
  if (seen) {
    const moved = writes.filter((w, i) => Object.prototype.hasOwnProperty.call(seen, slotKey(w.slot)) && slotDash(cur[i], w.slot) !== seen[slotKey(w.slot)]);
    if (moved.length)
      throw new ApplyConflictError(`Someone else changed the dashboard of ${moved.slice(0, 3).map((w) => w.slot.label).join(', ')}${moved.length > 3 ? ` and ${moved.length - 3} more` : ''} after you opened this. Nothing was applied. Check the preview again, then apply.`);
  }
  // 2. write, remembering what was written; on a failure put it back
  const done: number[] = [];
  const copies: string[] = [];
  try {
    for (let i = 0; i < writes.length; i++) {
      const w = writes[i];
      let dashId = doc.id;
      if (w.copyFor) {
        const copy = await saveDashboard(ctx, { ...doc, id: newId('d'), name: `${doc.name} — ${w.slot.label}`, version: 0, copiedFrom: doc.id, ownerId: ctx.userId, ownerName: ctx.displayName });
        copies.push(copy.id);
        dashId = copy.id;
      }
      await api.saveAttrs(w.slot.e, { [w.slot.key]: w.make(cur[i], dashId) });
      done.push(i);
    }
  } catch (e: any) {
    const stuck: string[] = [];
    for (const i of [...done].reverse()) {
      const w = writes[i];
      try {
        if (cur[i] === null) await api.deleteAttrs(w.slot.e, [w.slot.key]);
        else await api.saveAttrs(w.slot.e, { [w.slot.key]: cur[i] });
      } catch {
        stuck.push(w.slot.label);
      }
    }
    if (ctx.store && copies.length) await api.deleteAttrs(ctx.store, copies.flatMap((id) => [D(id), H(id), VIS(id)])).catch(() => stuck.push(`${copies.length} machine cop${copies.length === 1 ? 'y' : 'ies'} of the dashboard`));
    if (done.length) await assignChanged(ctx);
    const why = String(e?.message ?? e).replace(/[.\s]+$/, '');
    const what = !done.length ? 'Nothing was changed.' : stuck.length ? `It stopped after ${done.length} of ${writes.length} changes; these could not be put back: ${stuck.join(', ')}.` : `It stopped after ${done.length} of ${writes.length} changes, which were undone.`;
    throw new Error(`${why}. ${what}`);
  }
  // 3. tell the other pages (a cache hint: best effort)
  await assignChanged(ctx);
  return covers;
}

/**
 * "Customise for this machine": saves a copy of `template` (new id, version 0, `copiedFrom`) and
 * assigns it to the device with mode 'customised', so the machine stops following the template.
 * Writes: store `dbb_d_/dbb_h_/dbb_vis_<copy>`, device `dbb_assign`. Needs `dashboards.build` and a machine granted to
 * the user (D-050; before, an admin could customise any machine). UI-only checks (D-012).
 */
export async function customise(ctx: UserContext, deviceId: string, template: Dashboard): Promise<Dashboard> {
  if (!ctx.canBuild) throw new Error("Your role can't build dashboards.");
  if (!scope.isGrantedMachine(ctx, deviceId)) throw new Error('Machine is outside your access.');
  const label = ctx.nodes.get(deviceId)?.label ?? deviceId;
  const copy = await saveDashboard(ctx, {
    ...template,
    id: newId('d'),
    name: `${template.name} (customised: ${label})`,
    version: 0,
    copiedFrom: template.id,
    ownerId: ctx.userId,
    ownerName: ctx.displayName,
  });
  await api.saveAttrs(dev(deviceId), { dbb_assign: { dashboardId: copy.id, mode: 'customised', by: ctx.displayName, at: Date.now() } });
  await assignChanged(ctx);
  return copy;
}

/**
 * "Reset to shared dashboard": deletes the device's `dbb_assign`, so the machine falls back to the
 * location / customer-wide / default dashboard. When that assignment was a 'customised' or 'copy'
 * dashboard, its `dbb_d_/dbb_h_/dbb_vis_` attributes are deleted too (best effort).
 * No permission check here; callers restrict it to `dashboards.build` (UI-only, D-012, D-050).
 */
export async function resetDevice(ctx: UserContext, deviceId: string): Promise<void> {
  const a: DeviceAssignment | null = await readAssign(dev(deviceId));
  await api.deleteAttrs(dev(deviceId), ['dbb_assign']);
  await assignChanged(ctx);
  if (a && (a.mode === 'customised' || a.mode === 'copy') && ctx.store) {
    await api.deleteAttrs(ctx.store, [D(a.dashboardId), H(a.dashboardId), VIS(a.dashboardId)]).catch(() => undefined);
  }
}

/** Removes the user's personal view for one machine (user attribute `dbb_personal`). */
export async function clearPersonal(ctx: UserContext, deviceId: string) {
  const u = { id: ctx.userId, entityType: 'USER' };
  const cur = (await api.getAttrs(u, ['dbb_personal'])).dbb_personal ?? {};
  delete cur[deviceId];
  await api.saveAttrs(u, { dbb_personal: cur });
  await assignChanged(ctx);
}

/**
 * Where a dashboard is used (machines in scope of its profile whose non-personal resolution is it),
 * and which machines have customised copies of it. Returns machine labels. Runs `resolveForDevice`
 * for every machine of the profile, so it is slow on large scopes.
 */
export async function usage(ctx: UserContext, doc: Dashboard): Promise<{ devices: string[]; customised: string[] }> {
  if (!doc.profile) return { devices: [], customised: [] };
  const devices: string[] = [];
  const customised: string[] = [];
  await Promise.all(
    scope.allDevices(ctx, doc.profile).map(async (d) => {
      const r = await resolveForDevice(ctx, d.id, d.profile);
      const nonPersonal = r.candidates.find((c) => c.level !== 'personal');
      if (nonPersonal?.dashboard.id === doc.id) devices.push(d.label);
      else if (nonPersonal?.dashboard.copiedFrom === doc.id && r.deviceAssignment?.mode === 'customised') customised.push(d.label);
    }),
  );
  return { devices, customised };
}

/**
 * Deletes a dashboard and every assignment in the user's scope that points at it: device
 * `dbb_assign`, entries in asset `dbb_assign`, entries in store `dbb_assign_customer`; then the
 * store's `dbb_d_/dbb_h_/dbb_vis_<id>`. Assignments outside the user's scope are left dangling
 * (resolution skips them because the dashboard no longer loads). Per-machine copies are kept.
 * Only the owner, or a role with `dashboards.deleteAny` (D-050; UI-only, D-012). Nav nodes (the path above the user's
 * grants, D-050) are outside the user's scope and keep theirs. Sequential calls: one read per node in scope.
 * @returns labels of what was unassigned, for the confirmation/audit.
 */
export async function deleteDashboard(ctx: UserContext, doc: Dashboard): Promise<string[]> {
  if (doc.ownerId !== ctx.userId && !ctx.canDeleteAny) throw new Error("Only the owner can delete this dashboard: your role can't delete others' dashboards.");
  const store = requireStore(ctx);
  const affected: string[] = [];
  // current assignments of every node in scope in 2 calls (D-022) instead of one read per node
  const snap = ctx.assign ? await refreshAssign(ctx) : null;
  let changed = false;
  for (const n of ctx.nodes.values()) {
    if (n.nav) continue;
    const a = snap ? snap.byId.get(n.id) : await readAssign(n.entityType === 'DEVICE' ? dev(n.id) : asset(n.id));
    if (!a) continue;
    if (n.entityType === 'DEVICE' && a.dashboardId === doc.id) {
      await api.deleteAttrs(dev(n.id), ['dbb_assign']);
      changed = true;
      affected.push(n.label);
    } else if (n.entityType === 'ASSET') {
      const keep = Object.fromEntries(Object.entries(a).filter(([, v]: any) => v?.dashboardId !== doc.id));
      if (Object.keys(keep).length !== Object.keys(a).length) {
        await api.saveAttrs(asset(n.id), { dbb_assign: keep });
        changed = true;
        affected.push(`${n.label} (all ${doc.profile})`);
      }
    }
  }
  const cw = (await api.getAttrs(store, ['dbb_assign_customer'])).dbb_assign_customer ?? {};
  const keep = Object.fromEntries(Object.entries(cw).filter(([, v]: any) => v?.dashboardId !== doc.id));
  if (Object.keys(keep).length !== Object.keys(cw).length) {
    await api.saveAttrs(store, { dbb_assign_customer: keep });
    affected.push(`All ${doc.profile} machines`);
  }
  if (changed || affected.length) await assignChanged(ctx);
  await api.deleteAttrs(store, [D(doc.id), H(doc.id), VIS(doc.id)]);
  return affected;
}
