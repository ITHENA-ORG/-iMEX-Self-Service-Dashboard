// core/perm.ts — the iMEX role core: WHAT a user may do (pages and actions). TypeScript copy for the Dashboard Builder
// (DECISIONS D-050).
//
// Pure functions, no requests. Spec: docs/ROLES.md in the iMEX App UI repo. Contract: widgets/test/perm-vectors.json
// (byte-identical copy of the App UI's tests/perm-vectors.json; the same vectors pin the JavaScript core
// widgets/_shared/perm.js and the Python copies in Reports and AIML). Keep this file a line-by-line port of the
// JavaScript core: same names, same decisions, same answers on bad data. The browser part of the JavaScript core
// (resolve / invalidate) is not ported: core/scope.ts reads the store and builds `ctx.perms` with these functions.
// validateRole and coversScope use core/access.ts (the JavaScript core reads window.imxAccess at call time).
//
// imexRoles (SERVER_SCOPE attribute on the customer's "System Configuration" asset) =
//   { v: 1, rev, at, by, roles: [{ id, name, builtIn, locked, desc, perms: { pageKey: 'hidden' | 'view' | 'full' },
//     actions: { actionId: true }, manageRoles, defaultScope: [grant] }] }
// USER attributes: imexRole (the role id) and Role (its name, for the readers that are not ported).
// A missing page is hidden. Actions are implied at Full, tickable at View, dropped at Hidden. Manage roles needs Users
// at Full. Built-ins: admin (locked: only desc and defaultScope change) and viewer (editable, not deletable; the
// fallback for an unknown or absent role). Tenant admins are unrestricted.
// S14 (App UI round 3, 16 Oct 2026): a catalogue row that is not in BASE_KEYS (the first catalogue, 10 Oct 2026) and
// has no level in a stored role is NEW to that role. The stored Viewer takes the built-in Viewer's level for it
// (parseStore; a stored level wins), a custom role keeps it hidden; newKeys(role) lists those rows.

import * as access from './access';
import type { Access, Grant } from './access';

export type Level = 'hidden' | 'view' | 'full';

export interface CatalogueAction {
  id: string;
  label: string;
}
export interface CatalogueRow {
  key: string;
  label: string;
  section: 'MONITOR' | 'ACT' | 'INSIGHTS' | 'ADMIN';
  parent: string | null;
  states: string[];
  levels: Level[];
  actions: CatalogueAction[];
}

export interface Role {
  id: string | null;
  name: string;
  builtIn: boolean;
  locked: boolean;
  desc: string;
  perms: Record<string, Level>;
  actions: Record<string, true>;
  manageRoles: boolean;
  defaultScope: Grant[];
  template?: string;
}

export interface Store {
  v: 1;
  rev: number;
  roles: Role[];
  source: 'imexRoles' | 'builtins';
  warnings: string[];
}

/** Effective permissions: every catalogue page with its level, the actions that hold, Manage roles. */
export interface Eff {
  unrestricted: boolean;
  pages: Record<string, Level>;
  actions: Record<string, true>;
  manageRoles: boolean;
}

export interface UserRole {
  roleId: string | null;
  role: Role | null;
  source: 'unrestricted' | 'imexRole' | 'legacy';
  warnings: string[];
}

const HV: Level[] = ['hidden', 'view'];
const HVF: Level[] = ['hidden', 'view', 'full'];
export const LEVELS: Level[] = ['hidden', 'view', 'full'];
const RANK: Record<string, number> = { hidden: 0, view: 1, full: 2 };
const A = (id: string, label: string): CatalogueAction => ({ id, label });
// the rows of the role editor = the side menu's pages (Notifications and Mobile app are always visible)
export const CATALOGUE: CatalogueRow[] = [
  { key: 'sites', label: 'Overview', section: 'MONITOR', parent: null, states: ['default'], levels: HV, actions: [] },
  { key: 'machines', label: 'Machines', section: 'MONITOR', parent: null, states: ['listing', 'machine'], levels: HV, actions: [] },
  { key: 'alarms', label: 'Alarms', section: 'MONITOR', parent: null, states: ['active_alerts', 'alert_history'], levels: HVF, actions: [A('alarms.acknowledge', 'Acknowledge alarms')] },
  { key: 'andon', label: 'Andon board', section: 'MONITOR', parent: null, states: ['andon'], levels: HVF, actions: [A('andon.layout', 'Edit board layout'), A('andon.boards', 'Manage saved boards')] },
  { key: 'spc', label: 'SPC', section: 'MONITOR', parent: null, states: ['spc'], levels: HVF, actions: [] },
  {
    key: 'dashboards',
    label: 'Dashboards',
    section: 'INSIGHTS',
    parent: null,
    states: ['dashboards', 'dashboard_overview'],
    levels: HVF,
    actions: [A('dashboards.build', 'Build dashboards'), A('dashboards.applyMany', 'Apply to many machines'), A('dashboards.deleteAny', 'Delete any dashboard')],
  },
  // App U-082: Playbooks (pause and resume are actions of their own)
  // App U-101: section ACT after Dashboards (the menu's ACT group, U-099); key and actions unchanged
  {
    key: 'playbooks',
    label: 'Playbooks',
    section: 'ACT',
    parent: null,
    states: ['playbooks'],
    levels: HVF,
    actions: [
      A('playbooks.run', 'Run playbooks (manual starts, Simulate)'),
      A('playbooks.write', 'Run playbooks that change machine values'),
      A('playbooks.edit', 'Create and edit playbooks and instructions'),
      A('playbooks.approve', 'Can be an approver of machine writes'),
      A('playbooks.pause', 'Pause machine writes'),
      A('playbooks.resume', 'Resume machine writes'),
    ],
  },
  { key: 'analyzer', label: 'Analyzer', section: 'INSIGHTS', parent: null, states: ['analytics'], levels: HVF, actions: [A('analyzer.export', 'Export')] },
  { key: 'ai.forecast', label: 'Forecast', section: 'INSIGHTS', parent: 'AI Insights', states: ['aiml_forecast'], levels: HV, actions: [] },
  { key: 'ai.anomalies', label: 'Anomalies', section: 'INSIGHTS', parent: 'AI Insights', states: ['aiml_anomalies'], levels: HV, actions: [] },
  { key: 'ai.maintenance', label: 'Predictive maintenance', section: 'INSIGHTS', parent: 'AI Insights', states: ['aiml_maintenance'], levels: HV, actions: [] },
  { key: 'ai.relations', label: 'Relationships', section: 'INSIGHTS', parent: 'AI Insights', states: ['aiml_relations'], levels: HVF, actions: [A('ai.relations.edit', 'Edit relationships')] },
  {
    key: 'reports',
    label: 'Reports',
    section: 'INSIGHTS',
    parent: null,
    states: ['reports'],
    levels: HVF,
    actions: [A('reports.run', 'Run reports'), A('reports.edit', 'Edit reports'), A('reports.schedule', 'Schedule reports'), A('reports.settings', 'Report settings')],
  },
  { key: 'energy', label: 'Energy & Carbon', section: 'INSIGHTS', parent: null, states: ['energy'], levels: HVF, actions: [] },
  { key: 'value', label: 'Value tracker', section: 'INSIGHTS', parent: null, states: ['value'], levels: HVF, actions: [] },
  // App U-109: Losses & OEE (Analyze > Losses, the machine's Stops page); giving a stop's reason and changing one
  // someone else gave are actions (both implied at Full)
  { key: 'losses', label: 'Losses', section: 'INSIGHTS', parent: null, states: ['losses', 'machine_stops'], levels: HVF, actions: [A('losses.reason', 'Give stop reasons'), A('losses.override', 'Change a stop reason someone else gave')] },
  { key: 'users', label: 'Users & roles', section: 'ADMIN', parent: null, states: ['user_management'], levels: HVF, actions: [] },
  // App U-089: Settings > Crew (who works which shift in which crew role)
  { key: 'crew', label: 'Crew', section: 'ADMIN', parent: null, states: ['crew'], levels: HVF, actions: [] },
  // App U-070 / U-088: Settings > Machines (key, state and action id unchanged; the action covers site details only)
  { key: 'sitesmachines', label: 'Machine settings', section: 'ADMIN', parent: null, states: ['sites_machines'], levels: HVF, actions: [A('sitesmachines.structure', 'Change site details (address, time zone, map position)')] },
  // App U-082: Settings > Machine control
  {
    key: 'machinecontrol',
    label: 'Machine control',
    section: 'ADMIN',
    parent: null,
    states: ['machine_control'],
    levels: HVF,
    actions: [A('playbooks.configure', 'Set up control points, approvals and Verify connection'), A('playbooks.automatic', 'Switch automatic writes on')],
  },
  { key: 'alertrules.default', label: 'Default rules', section: 'ADMIN', parent: 'Alarm rules', states: ['alert_management'], levels: HVF, actions: [A('alertrules.export', 'Export alarm rules')] },
  { key: 'alertrules.custom', label: 'Custom rules', section: 'ADMIN', parent: 'Alarm rules', states: ['custom_alert'], levels: HVF, actions: [] },
  // App UI round 3: the cascade tags (was Configuration > Alarms), the third tab of Alarm rules
  { key: 'alertrules.grouping', label: 'Alarm grouping', section: 'ADMIN', parent: 'Alarm rules', states: ['alarm_grouping'], levels: HVF, actions: [] },
  // App U-072: the texts of alarm notifications per channel, the fourth tab of Alarm rules
  { key: 'alertrules.templates', label: 'Notification templates', section: 'ADMIN', parent: 'Alarm rules', states: ['notify_templates'], levels: HVF, actions: [] },
  { key: 'aisettings', label: 'AI settings', section: 'ADMIN', parent: null, states: ['aiml_settings'], levels: HVF, actions: [A('ai.jobs', 'Run AI jobs')] },
  { key: 'config', label: 'Configuration', section: 'ADMIN', parent: null, states: ['configuration'], levels: HVF, actions: [] },
  { key: 'licence', label: 'Licence', section: 'ADMIN', parent: null, states: ['licence'], levels: HVF, actions: [] },
];
const ROW: Record<string, CatalogueRow> = {};
const STATE: Record<string, CatalogueRow> = {};
const ACTION: Record<string, CatalogueRow> = {};
export const ACTIONS: string[] = [];
for (const r of CATALOGUE) {
  ROW[r.key] = r;
  for (const s of r.states) STATE[s] = r;
  for (const a of r.actions) {
    ACTION[a.id] = r;
    ACTIONS.push(a.id);
  }
}
/** The catalogue of the first roles release (10 Oct 2026), S14. Never add to this list. */
export const BASE_KEYS = ['sites', 'machines', 'alarms', 'andon', 'dashboards', 'analyzer', 'ai.forecast', 'ai.anomalies', 'ai.maintenance', 'ai.relations', 'reports', 'users', 'alertrules.default', 'alertrules.custom', 'aisettings', 'config'];
const BASE: Record<string, true> = {};
for (const k of BASE_KEYS) BASE[k] = true;
export const RESERVED = ['admin', 'customer admin', 'administrator', 'user', 'viewer'];
const LEGACY_ADMIN = ['admin', 'customer admin', 'administrator'];
const ROLE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const NAME_MAX = 40;
const DESC_MAX = 120;
export const LAST_ADMIN = 'This is the last administrator.';

// ---------------------------------------------------------------------------------------------- helpers
const isArray = Array.isArray;
const has = (o: any, k: string): boolean => o != null && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o: any): o is Record<string, any> => o !== null && typeof o === 'object' && !isArray(o);
const warn = (list: string[], code: string) => {
  if (list.indexOf(code) < 0) list.push(code);
};
const maxLevel = (row: CatalogueRow): Level => row.levels[row.levels.length - 1];
export const copy = <T>(o: T): T => (o == null ? o : JSON.parse(JSON.stringify(o)));
function scopeOf(list: unknown, w?: string[]): Grant[] {
  if (list === undefined || list === null) return [];
  if (!isArray(list)) {
    if (w) warn(w, 'role.scope');
    return [];
  }
  const p = access.parse({ v: 1, grants: list }, null);
  if (p.warnings.length && w) warn(w, 'role.scope');
  return access.normalize(p.grants);
}

// ---------------------------------------------------------------------------------------------- built-ins
function role(id: string | null, name: string, desc: string, perms: Record<string, Level>, actions: Record<string, true>, manageRoles: boolean, scope?: Grant[]): Role {
  return { id, name, builtIn: id === 'admin' || id === 'viewer', locked: id === 'admin', desc, perms, actions, manageRoles: !!manageRoles, defaultScope: scope || [] };
}
function adminRole(scope?: Grant[]): Role {
  const perms: Record<string, Level> = {};
  const actions: Record<string, true> = {};
  for (const r of CATALOGUE) perms[r.key] = maxLevel(r);
  for (const a of ACTIONS) actions[a] = true;
  return role('admin', 'Admin', 'Everything, including users and roles.', perms, actions, true, scope);
}
function viewerRole(): Role {
  const perms: Record<string, Level> = {};
  for (const r of CATALOGUE) if (r.section !== 'ADMIN') perms[r.key] = 'view';
  return role('viewer', 'Viewer', 'Read only.', perms, { 'reports.run': true }, false, []);
}
/** [Admin, Viewer]; adminScope = the Admin's default access (the store keeps its own). */
export function BUILTINS(adminScope?: Grant[]): Role[] {
  return [adminRole(adminScope || []), viewerRole()];
}
/** Starting points for a new role (not stored): Supervisor, Operator. */
export function TEMPLATES(): Role[] {
  const sup: Record<string, Level> = {};
  const op: Record<string, Level> = {};
  for (const r of CATALOGUE) if (r.section !== 'ADMIN') sup[r.key] = 'view';
  for (const k of ['alarms', 'andon', 'ai.relations', 'reports']) sup[k] = 'full';
  sup['alertrules.default'] = 'full';
  sup['alertrules.custom'] = 'full';
  sup['alertrules.grouping'] = 'view'; // a plant-wide setting: as it was under Configuration (view)
  sup['alertrules.templates'] = 'view'; // App U-072: plant-wide too
  sup.sitesmachines = 'view'; // App U-070: Supervisor = View
  sup.users = 'view';
  sup.aisettings = 'view';
  sup.config = 'view';
  sup.machinecontrol = 'view'; // App U-082
  sup.crew = 'full'; // App U-089: the supervisor plans who works which shift
  sup.losses = 'full'; // App U-109: gives and changes stop reasons
  for (const k of ['sites', 'machines', 'alarms', 'andon', 'dashboards', 'analyzer']) op[k] = 'view';
  op.playbooks = 'view'; // App U-082
  op.losses = 'view'; // App U-109: Operator = Losses View + give stop reasons
  const supActions: Record<string, true> = { 'dashboards.build': true, 'dashboards.applyMany': true, 'playbooks.run': true, 'playbooks.write': true, 'playbooks.approve': true, 'playbooks.pause': true };
  return [
    role(null, 'Supervisor', 'Runs the floor: alarms, Andon, reports and alarm rules.', sup, supActions, false, []),
    role(null, 'Operator', 'Watches the machines and acknowledges alarms.', op, { 'alarms.acknowledge': true, 'playbooks.run': true, 'losses.reason': true }, false, []),
  ].map((r) => {
    r.builtIn = false;
    r.locked = false;
    r.template = r.name.toLowerCase();
    return r;
  });
}

// ---------------------------------------------------------------------------------------------- the store
// a stored role, cleaned: unknown page keys with a valid level are kept (a newer app may know them), unknown actions
// are dropped (warning action.unknown), defaultScope goes through the access core
function cleanRole(r: any, w: string[]): Role | null {
  if (!isObj(r) || typeof r.id !== 'string' || !ROLE_ID.test(r.id)) {
    warn(w, 'role.invalid');
    return null;
  }
  const perms: Record<string, Level> = {};
  const actions: Record<string, true> = {};
  if (isObj(r.perms)) for (const k of Object.keys(r.perms)) if (has(RANK, r.perms[k])) perms[k] = r.perms[k];
  if (isObj(r.actions))
    for (const a of Object.keys(r.actions)) {
      if (r.actions[a] !== true) continue;
      if (has(ACTION, a)) actions[a] = true;
      else warn(w, 'action.unknown');
    }
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : r.id,
    builtIn: r.id === 'admin' || r.id === 'viewer',
    locked: r.id === 'admin',
    desc: typeof r.desc === 'string' ? r.desc : '',
    perms,
    actions,
    manageRoles: r.manageRoles === true,
    defaultScope: scopeOf(r.defaultScope, w),
  };
}
/** The catalogue rows a stored role has no level for and that are newer than the role system (S14); [] for a built-in role. */
export function newKeys(r: { id?: string | null; builtIn?: boolean; perms?: unknown } | null | undefined): string[] {
  if (!r || (r.builtIn === true && (r.id === 'admin' || r.id === 'viewer'))) return [];
  const perms: Record<string, unknown> = isObj(r.perms) ? r.perms : {};
  return CATALOGUE.filter((row) => !BASE[row.key] && !(has(perms, row.key) && has(RANK, perms[row.key] as string))).map((row) => row.key);
}
const builtinStore = (w: string[]): Store => ({ v: 1, rev: 0, roles: BUILTINS(), source: 'builtins', warnings: w });

/** Reads imexRoles (object or JSON string). Absent, unreadable or another version: the built-ins. Never throws. */
export function parseStore(raw: unknown): Store {
  const w: string[] = [];
  if (raw === undefined || raw === null || raw === '') return builtinStore(w);
  let v: any = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return builtinStore(['roles.store']);
    }
  }
  if (!isObj(v) || v.v !== 1 || !isArray(v.roles)) return builtinStore(['roles.store']);
  const byId: Record<string, Role> = {};
  const list: Role[] = [];
  for (const r of v.roles) {
    const c = cleanRole(r, w);
    if (!c) continue;
    if (has(byId, c.id!)) {
      warn(w, 'role.duplicate');
      continue;
    }
    byId[c.id!] = c;
    list.push(c);
  }
  // the Admin is always the built-in Admin (only its description and default access are kept); the Viewer always
  // exists and keeps its name
  const adm = adminRole(byId.admin ? byId.admin.defaultScope : []);
  if (byId.admin) adm.desc = byId.admin.desc || adm.desc;
  else warn(w, 'roles.builtinMissing');
  let vw = byId.viewer;
  if (vw) {
    vw.name = 'Viewer';
    vw.builtIn = true;
    vw.locked = false;
    // S14: a page new since the Viewer was saved takes the built-in Viewer's level (a stored level wins)
    const dv = viewerRole().perms;
    for (const k of newKeys({ perms: vw.perms })) if (has(dv, k)) vw.perms[k] = dv[k];
  } else {
    vw = viewerRole();
    warn(w, 'roles.builtinMissing');
  }
  const roles = [adm, vw].concat(list.filter((r) => r.id !== 'admin' && r.id !== 'viewer'));
  const rev = typeof v.rev === 'number' && v.rev >= 0 && isFinite(v.rev) ? Math.floor(v.rev) : 0;
  return { v: 1, rev, roles, source: 'imexRoles', warnings: w };
}
const asStore = (s: any): Store => (s && isArray(s.roles) && s.source ? s : parseStore(s));
function findRole(store: unknown, id: string | null): Role | null {
  for (const r of asStore(store).roles) if (r.id === id) return r;
  return null;
}

// ---------------------------------------------------------------------------------------------- users
const isUnrestrictedUser = (u: any) => !!u && (u.authority === 'TENANT_ADMIN' || u.authority === 'SYS_ADMIN');

/** The user's role: unrestricted (tenant admin), imexRole (unknown id: Viewer + role.gone), else the legacy Role / dbbAdmin. */
export function parseUser(store: unknown, u: { imexRole?: unknown; Role?: unknown; dbbAdmin?: unknown; authority?: string } | null | undefined): UserRole {
  u = u || {};
  if (isUnrestrictedUser(u)) return { roleId: null, role: null, source: 'unrestricted', warnings: [] };
  const S = asStore(store);
  if (typeof u.imexRole === 'string' && u.imexRole !== '') {
    const r = findRole(S, u.imexRole);
    if (r) return { roleId: r.id, role: r, source: 'imexRole', warnings: [] };
    return { roleId: 'viewer', role: findRole(S, 'viewer'), source: 'imexRole', warnings: ['role.gone'] };
  }
  const name = typeof u.Role === 'string' ? u.Role.trim().toLowerCase() : '';
  const admin = LEGACY_ADMIN.indexOf(name) >= 0 || u.dbbAdmin === true || u.dbbAdmin === 'true';
  const id = admin ? 'admin' : 'viewer';
  return { roleId: id, role: findRole(S, id), source: 'legacy', warnings: [] };
}

/** Pages with their levels (missing = hidden), implied and ticked actions, Manage roles (needs Users at Full). */
export function effective(r: Role | 'unrestricted' | { unrestricted?: boolean } | null | undefined): Eff {
  const pages: Record<string, Level> = {};
  const actions: Record<string, true> = {};
  if (r === 'unrestricted' || (r && (r as any).unrestricted === true)) {
    for (const row of CATALOGUE) pages[row.key] = maxLevel(row);
    for (const a of ACTIONS) actions[a] = true;
    return { unrestricted: true, pages, actions, manageRoles: true };
  }
  const rr: any = r;
  const perms = rr && isObj(rr.perms) ? rr.perms : {};
  const ticks = rr && isObj(rr.actions) ? rr.actions : {};
  for (const row of CATALOGUE) {
    let lvl: Level = has(perms, row.key) && has(RANK, perms[row.key]) ? perms[row.key] : 'hidden';
    if (row.levels.indexOf(lvl) < 0) lvl = maxLevel(row);
    pages[row.key] = lvl;
    for (const a of row.actions) if (lvl === 'full' || (lvl === 'view' && ticks[a.id] === true)) actions[a.id] = true;
  }
  return { unrestricted: false, pages, actions, manageRoles: !!(rr && rr.manageRoles === true && pages.users === 'full') };
}

/** parseUser + effective. */
export function resolveUser(storeRaw: unknown, u: Parameters<typeof parseUser>[1]): UserRole & { eff: Eff } {
  const p = parseUser(storeRaw, u);
  return { ...p, eff: effective(p.source === 'unrestricted' ? 'unrestricted' : p.role) };
}

/** The level of a catalogue page ('hidden' for an unknown key or no permissions). */
export function page(eff: Eff | null | undefined, key: string): Level {
  if (!eff || !has(ROW, key)) return 'hidden';
  const l = eff.pages && eff.pages[key];
  return has(RANK, l) ? (l as Level) : 'hidden';
}
/** A catalogue action, 'manageRoles', or a page key at a level ('view' = at least view, the default; 'full'). */
export function can(eff: Eff | null | undefined, k: string, level?: string): boolean {
  if (!eff) return false;
  if (k === 'manageRoles') return eff.manageRoles === true;
  if (has(ACTION, k)) return !!(eff.actions && eff.actions[k] === true);
  if (has(ROW, k)) return RANK[page(eff, k)] >= RANK[level && has(RANK, level) ? level : 'view'];
  return false;
}
/** The level of a dashboard state; a state that is no page of the catalogue (notifications, a custom page) is 'view'. */
export function canState(eff: Eff | null | undefined, stateId: string): Level {
  if (!has(STATE, stateId)) return 'view';
  return page(eff, STATE[stateId].key);
}

// ---------------------------------------------------------------------------------------------- rules
export type Missing = { type: 'page'; key: string; have: Level; need: Level } | { type: 'action'; key: string } | { type: 'manageRoles'; key: 'manageRoles' };

/** "Cannot grant more than you hold": every page level, action and Manage roles of the target within the editor's. */
export function covers(editor: Eff | null | undefined, target: Eff | null | undefined): { ok: boolean; missing: Missing[] } {
  const missing: Missing[] = [];
  if (editor && editor.unrestricted) return { ok: true, missing };
  for (const row of CATALOGUE) {
    const have = page(editor, row.key);
    const need = page(target, row.key);
    if (RANK[need] > RANK[have]) missing.push({ type: 'page', key: row.key, have, need });
  }
  for (const a of ACTIONS) if (target && target.actions && target.actions[a] === true && !(editor && editor.actions && editor.actions[a] === true)) missing.push({ type: 'action', key: a });
  if (target && target.manageRoles && !(editor && editor.manageRoles)) missing.push({ type: 'manageRoles', key: 'manageRoles' });
  return { ok: !missing.length, missing };
}
/** The same rule for a default access: every grant inside the editor's access (unless it covers the organisation). */
export function coversScope(editorAccess: Access | null | undefined, grants: unknown): { ok: boolean; outside: Grant[] } {
  const list = access.parse({ v: 1, grants: isArray(grants) ? grants : [] }, null).grants;
  if (editorAccess && (editorAccess.unrestricted || editorAccess.coversAll)) return { ok: true, outside: [] };
  const outside = list.filter((g) => {
    if (!editorAccess) return true;
    return !(g.type === 'ASSET' ? editorAccess.hasAll(g.id) : editorAccess.has(g.id));
  });
  return { ok: !outside.length, outside };
}

export interface AdminUser {
  id: string;
  enabled?: boolean;
  roleId?: string | null;
  eff: Eff | null;
}
export type AdminChange = { userId?: string; roleId?: string; newEff?: Eff | null; enabled?: boolean };

/** At least one enabled user who can manage roles must remain. */
export function lastAdminCheck(users: AdminUser[] | null | undefined, change: AdminChange | null | undefined): { ok: boolean; code: string; reason: string } {
  const list = isArray(users) ? users : [];
  const ch: AdminChange = change || {};
  const holds = (eff: Eff | null | undefined, enabled: boolean | undefined) => enabled !== false && !!eff && (eff.manageRoles === true || eff.unrestricted === true);
  let before = 0;
  let after = 0;
  for (const u of list) {
    if (!u) continue;
    if (holds(u.eff, u.enabled)) before++;
    let eff = u.eff;
    let enabled = u.enabled;
    if (ch.userId !== undefined && u.id === ch.userId) {
      if (has(ch, 'newEff')) eff = ch.newEff ?? null;
      if (ch.enabled === false) enabled = false;
    } else if (ch.roleId !== undefined && u.roleId === ch.roleId && has(ch, 'newEff')) eff = ch.newEff ?? null;
    if (holds(eff, enabled)) after++;
  }
  if (before > 0 && after === 0) return { ok: false, code: 'lastAdmin', reason: LAST_ADMIN };
  return { ok: true, code: '', reason: '' };
}

function sameMap(a: Record<string, any> | null | undefined, b: Record<string, any> | null | undefined): boolean {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  if (ka.join('\u0001') !== kb.join('\u0001')) return false;
  for (const k of ka) if (a![k] !== b![k]) return false;
  return true;
}

/** The checks of a role save: name, reserved names, the locked Admin, levels, actions, Manage roles, scope, covers. */
export function validateRole(r: any, store: unknown, editorEff: Eff | null | undefined, editorAccess: Access | null | undefined): { role: Role | null; errors: string[]; missing: Missing[]; outside: Grant[] } {
  const errors: string[] = [];
  const w: string[] = [];
  const S = asStore(store);
  let c = cleanRole(r, w);
  if (!c) return { role: null, errors: ['role.invalid'], missing: [], outside: [] };
  const name = c.name.trim();
  c.name = name;
  if (!name) errors.push('name.required');
  else if (name.length > NAME_MAX) errors.push('name.length');
  if (!c.builtIn && RESERVED.indexOf(name.toLowerCase()) >= 0) errors.push('name.reserved');
  if (name && S.roles.some((x) => x.id !== c!.id && x.name.trim().toLowerCase() === name.toLowerCase())) errors.push('name.duplicate');
  if (c.desc.length > DESC_MAX) errors.push('desc.length');
  if (c.id === 'viewer' && name !== 'Viewer') errors.push('name.builtIn');
  if (c.id === 'admin') {
    const b = adminRole([]);
    const perms: Record<string, Level> = {};
    for (const row of CATALOGUE) if (has(c.perms, row.key)) perms[row.key] = c.perms[row.key];
    if (name !== b.name || !sameMap(perms, b.perms) || !sameMap(c.actions, b.actions) || c.manageRoles !== true) errors.push('role.locked');
    const keep = adminRole(c.defaultScope);
    keep.desc = c.desc;
    c = keep;
  }
  const rp = isObj(r.perms) ? r.perms : {};
  for (const row of CATALOGUE)
    if (has(rp, row.key) && row.levels.indexOf(rp[row.key]) < 0) {
      if (errors.indexOf('perm.level') < 0) errors.push('perm.level');
    }
  if (w.indexOf('action.unknown') >= 0) errors.push('action.unknown');
  if (c.manageRoles && c.perms.users !== 'full') errors.push('manageRoles.needsUsersFull');
  if (w.indexOf('role.scope') >= 0) errors.push('scope.invalid');
  const cv = covers(editorEff, effective(c));
  if (!cv.ok) errors.push('covers');
  // grants outside the editor's access are allowed only when the stored role already had them (kept as they are)
  const old = findRole(S, c.id);
  const kept: Record<string, boolean> = {};
  for (const g of (old && old.defaultScope) || []) kept[g.id] = true;
  const outside = coversScope(editorAccess, c.defaultScope).outside.filter((g) => !kept[g.id]);
  if (outside.length) errors.push('scope.outside');
  return { role: c, errors, missing: cv.missing, outside };
}

/** A role can be deleted when it exists, is not built in and no user has it. */
export function deleteCheck(roleId: string, store: unknown, users: { roleId?: string | null }[] | null | undefined): { ok: boolean; code: string; reason: string; count: number } {
  const r = findRole(store, roleId);
  if (!r) return { ok: false, code: 'role.unknown', reason: 'This role no longer exists', count: 0 };
  if (r.builtIn) return { ok: false, code: 'role.builtIn.delete', reason: 'Built-in role', count: 0 };
  const n = (isArray(users) ? users : []).filter((u) => u && u.roleId === roleId).length;
  if (n) return { ok: false, code: 'role.inUse', reason: `Reassign ${n}${n === 1 ? ' user' : ' users'} first`, count: n };
  return { ok: true, code: '', reason: '', count: 0 };
}

/** The Role attribute value written next to imexRole: the role's name. */
export const legacyName = (r: { name?: unknown } | null | undefined): string => (r && typeof r.name === 'string' && r.name ? r.name : 'Viewer');

/** The migration's mapping of today's USER attributes (scripts/roles-migrate.mjs in the App UI repo). */
export function migrateRole(u: { Role?: unknown; dbbAdmin?: unknown } | null | undefined, opts?: { strictNames?: boolean } | null): { roleId: string | null; createName: string | null; builder: boolean } {
  u = u || {};
  const raw = typeof u.Role === 'string' ? u.Role.trim() : '';
  const low = raw.toLowerCase();
  const out = { roleId: null as string | null, createName: null as string | null, builder: false };
  if (low === 'admin' || ((low === 'customer admin' || low === 'administrator') && !(opts && opts.strictNames))) out.roleId = 'admin';
  else if (low === '' || low === 'viewer' || low === 'user') out.roleId = 'viewer';
  else out.createName = raw;
  out.builder = out.roleId !== 'admin' && (u.dbbAdmin === true || u.dbbAdmin === 'true');
  return out;
}
/** A role's "+ Builder" variant: the same, with Dashboards at Full. */
export function builderVariant(r: Role | null | undefined): Role {
  const v: Role = copy(r) || role(null, 'Viewer', '', {}, {}, false, []);
  v.id = null;
  v.name = `${r && r.name ? r.name : 'Viewer'} + Builder`;
  v.builtIn = false;
  v.locked = false;
  v.perms = v.perms || {};
  v.perms.dashboards = 'full';
  return v;
}
/** 'r_' + 6 base36 characters, not in use. */
export function newRoleId(existing: (string | { id?: string | null })[] | null | undefined, rnd?: () => number): string {
  const taken: Record<string, boolean> = {};
  for (const x of existing || []) taken[typeof x === 'string' ? x : (x && x.id) || ''] = true;
  const rand = typeof rnd === 'function' ? rnd : Math.random;
  for (let t = 0; t < 1000; t++) {
    let s = 'r_';
    for (let i = 0; i < 6; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'.charAt(Math.floor(rand() * 36) % 36);
    if (!taken[s]) return s;
  }
  return `r_${Date.now().toString(36)}`;
}
/** The catalogue row of a page key, a state or an action. */
export const rowOf = (keyOrState: string): CatalogueRow | null => ROW[keyOrState] || STATE[keyOrState] || ACTION[keyOrState] || null;
