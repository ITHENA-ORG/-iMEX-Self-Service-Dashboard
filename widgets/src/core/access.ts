// core/access.ts — the iMEX access core: WHERE a user may look (which equipment). TypeScript copy for the Dashboard
// Builder (DECISIONS D-050).
//
// Pure functions, no requests. Spec: docs/ACCESS.md in the iMEX App UI repo. Contract: widgets/test/access-vectors.json
// (byte-identical copy of the App UI's tests/access-vectors.json; the same vectors pin the JavaScript core
// widgets/_shared/access.js and the Python copies in Reports and AIML). Keep this file a line-by-line port of the
// JavaScript core: same names, same decisions, same answers on bad data. The browser part of the JavaScript core
// (resolve / invalidate / miss) is not ported: the Builder loads its tree in core/scope.ts and calls resolveTree.
//
// imexAccess (USER attribute, SERVER_SCOPE) = { v: 1, grants: [{ id, type: 'ASSET' | 'DEVICE', mode: 'all' | 'fixed' }] }
//   ASSET 'all'   the asset and everything under it in the Contains tree, now and later (12 levels)
//   DEVICE fixed  that machine only (DEVICE 'all' is read the same; writers store 'fixed')
//   ASSET fixed   invalid (dropped with a warning)
// Absent imexAccess: the legacy selectedNodes are read instead (every shape seen so far). Present but unreadable or of
// another version: no access at all (never a silent fallback). grants [] = no access. Tenant admins are unrestricted.
//
//   parse(imexAccess, selectedNodes)            -> { source, grants, legacyNames, warnings }
//   normalize(grants, tree?)                    -> grants (valid, once each, DEVICE as 'fixed', nested ones dropped with
//                                                  a tree, ASSET before DEVICE then by id)
//   makeTree({ nodes, rels })                   -> Tree { nodes, children, parents }
//   resolveTree(grants, tree, opts)             -> Access
//   resolveUser(user, imexAccess, selectedNodes, tree, opts) -> Access (tenant admin: unrestricted)
//   pickByName(candidates)                      -> { id, type } | null
//   unrestricted(), rootKey(userId, grants), plain(access)
//   grantsFromSelection, summary, compact, snapshot (the Users page's helpers; ported so every vector runs here too)

/** One access grant. */
export interface Grant {
  id: string;
  type: 'ASSET' | 'DEVICE';
  mode: 'all' | 'fixed';
}

/** A tree node as the core sees it. */
export interface TreeNode {
  id: string;
  entityType: string;
  name: string;
  type?: string;
}

/** The Contains tree: nodes by id, children and parents as id lists. */
export interface Tree {
  nodes: Record<string, TreeNode>;
  children: Record<string, string[]>;
  parents: Record<string, string[]>;
  roots?: any;
}

/** Input of makeTree: nodes by id ({ type | entityType, name }) and relations [[from, to]] or { from, to }. */
export interface TreeSpec {
  nodes?: Record<string, { type?: string; entityType?: string; name?: string } | null>;
  rels?: any[];
  roots?: any;
}

export type Source = 'imexAccess' | 'legacy' | 'invalid' | 'unrestricted' | 'error' | string;

export interface Parsed {
  source: Source;
  grants: Grant[];
  legacyNames: string[];
  warnings: string[];
}

export interface Site {
  id: string;
  name: string;
  path: string[];
  deviceIds: string[];
  full: boolean;
}

export interface Unresolved {
  id: string | null;
  type: string | null;
  name?: string;
  reason: 'gone' | 'name';
}

/** What a user may see. Sets hold ids; has / hasAll / sees answer for one id (always true when unrestricted). */
export interface Access {
  unrestricted: boolean;
  source: Source;
  grants: Grant[];
  warnings: string[];
  legacyNames: string[];
  devices: Set<string>;
  assets: Set<string>;
  nav: Set<string>;
  allRoots: Set<string>;
  under: Set<string>;
  deviceIds: Set<string>;
  assetIds: Set<string>;
  navIds: Set<string>;
  unresolved: Unresolved[];
  dropped: string[];
  coversAll: boolean;
  sites: Site[];
  has(id: string): boolean;
  hasAll(id: string): boolean;
  sees(id: string): boolean;
}

export interface ResolveOptions {
  /** Granted ids that still exist for this user (default: the tree's nodes). */
  exists?: string[] | Set<string>;
  owned?: (id: string) => boolean;
  notOwned?: string[];
  /** Names by id (labels in the browser), over the tree's names. */
  names?: Record<string, string> | null;
  /** The customer's top assets (coversAll); default: the tops above the grants. */
  tops?: string[];
  maxDepth?: number;
  source?: Source;
}

export const MAX_DEPTH = 12;
export const MAX_GRANTS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------- small helpers
const isArray = Array.isArray;
const has = (o: any, k: string): boolean => o != null && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o: any): o is Record<string, any> => o !== null && typeof o === 'object' && !isArray(o);
const normId = (x: unknown): string | null => (typeof x === 'string' && UUID.test(x) ? x.toLowerCase() : null);
const cmp = (a: any, b: any): number => (a < b ? -1 : a > b ? 1 : 0);
// arrays of strings, element by element (the same order in every runtime: code units, not the locale)
function cmpArr(a: string[], b: string[]): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const c = cmp(a[i], b[i]);
    if (c) return c;
  }
  return cmp(a.length, b.length);
}
const warn = (list: string[], code: string) => {
  if (list.indexOf(code) < 0) list.push(code);
};
const keys = (set: Set<string>): string[] => [...set].sort(cmp);
const setOf = (list: Iterable<string> | null | undefined): Set<string> => new Set(list ?? []);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** True for a ThingsBoard id (uuid). */
export const isUuid = (s: unknown): boolean => !!normId(s);

// ---------------------------------------------------------------------------------------------- grants
// valid grants, once each ('all' wins over 'fixed'), at most MAX_GRANTS; warnings as codes
function validate(list: unknown, w: string[]): Grant[] {
  let out: Grant[] = [];
  const at: Record<string, number> = {};
  for (const g of isArray(list) ? list : []) {
    if (!isObj(g)) {
      warn(w, 'grant.id');
      continue;
    }
    const id = normId(g.id);
    if (!id) {
      warn(w, 'grant.id');
      continue;
    }
    if (g.type !== 'ASSET' && g.type !== 'DEVICE') {
      warn(w, 'grant.type');
      continue;
    }
    if (g.mode !== 'all' && g.mode !== 'fixed') {
      warn(w, 'grant.mode');
      continue;
    }
    if (g.type === 'ASSET' && g.mode === 'fixed') {
      warn(w, 'grant.assetFixed');
      continue;
    }
    if (has(at, id)) {
      const e = out[at[id]];
      if (e.mode === 'fixed' && g.mode === 'all') {
        e.type = g.type;
        e.mode = 'all';
      }
      continue;
    }
    at[id] = out.length;
    out.push({ id, type: g.type, mode: g.mode });
  }
  if (out.length > MAX_GRANTS) {
    out = out.slice(0, MAX_GRANTS);
    warn(w, 'grants.limit');
  }
  return out;
}

// the legacy selectedNodes: a bare uuid, { entityId: uuid | { id, entityType } }, { id, entityType },
// { id: { id, entityType } }, a JSON string of any of these, a name, { name, ID }. DEVICE -> fixed, else ASSET all.
function legacy(sel: unknown): Parsed {
  const w: string[] = [];
  const cand: any[] = [];
  const names: string[] = [];
  const entry = (e: any, depth: number): void => {
    if (typeof e === 'string') {
      const id = normId(e);
      if (id) {
        cand.push({ id, type: 'ASSET', mode: 'all' });
        return;
      }
      if (/^\s*[[{]/.test(e) && depth < 3) {
        let v: any;
        try {
          v = JSON.parse(e);
        } catch {
          warn(w, 'legacy.entry');
          return;
        }
        if (isArray(v)) v.forEach((y) => entry(y, depth + 1));
        else entry(v, depth + 1);
        return;
      }
      if (e !== '') names.push(e);
      else warn(w, 'legacy.entry');
      return;
    }
    if (isObj(e)) {
      const ref = e.entityId !== undefined && e.entityId !== null ? e.entityId : e.id;
      let type: string | null = typeof e.entityType === 'string' ? e.entityType : null;
      let rid: string | null = null;
      if (typeof ref === 'string') rid = normId(ref);
      else if (isObj(ref)) {
        rid = normId(ref.id);
        if (!type && typeof ref.entityType === 'string') type = ref.entityType;
      }
      if (rid) {
        cand.push({ id: rid, type: type === 'DEVICE' ? 'DEVICE' : 'ASSET', mode: type === 'DEVICE' ? 'fixed' : 'all' });
        return;
      }
      if (typeof e.name === 'string' && e.name !== '') {
        names.push(e.name);
        return;
      }
    }
    warn(w, 'legacy.entry');
  };
  let list: any = sel;
  if (list === undefined || list === null) list = [];
  if (typeof list === 'string') {
    if (/^\s*[[{"]/.test(list)) {
      try {
        list = JSON.parse(list);
      } catch {
        warn(w, 'legacy.unreadable');
        list = [];
      }
    } else list = [list];
  }
  if (!isArray(list)) list = list === null ? [] : [list];
  (list as any[]).forEach((e) => entry(e, 0));
  const grants = validate(cand, w);
  const seen: Record<string, boolean> = {};
  const uniq: string[] = [];
  for (const n of names)
    if (!has(seen, n)) {
      seen[n] = true;
      uniq.push(n);
    }
  return { source: 'legacy', grants, legacyNames: uniq, warnings: w };
}

/** Reads imexAccess (or, while it is absent, the legacy selectedNodes). Never throws. */
export function parse(imexAccess: unknown, selectedNodes?: unknown): Parsed {
  if (imexAccess === undefined || imexAccess === null) return legacy(selectedNodes);
  let v: any = imexAccess;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return { source: 'invalid', grants: [], legacyNames: [], warnings: ['access.unreadable'] };
    }
  }
  if (!isObj(v) || v.v !== 1 || !isArray(v.grants)) return { source: 'invalid', grants: [], legacyNames: [], warnings: ['access.version'] };
  const w: string[] = [];
  return { source: 'imexAccess', grants: validate(v.grants, w), legacyNames: [], warnings: w };
}

// ---------------------------------------------------------------------------------------------- the tree
/** { nodes: { id: { type | entityType, name } }, rels: [[from, to] | { from, to }] } -> { nodes, children, parents } */
export function makeTree(spec?: TreeSpec | null): Tree {
  spec = spec || {};
  const nodes: Record<string, TreeNode> = {};
  const children: Record<string, string[]> = {};
  const parents: Record<string, string[]> = {};
  const src = spec.nodes || {};
  for (const id of Object.keys(src)) {
    const n: any = src[id] || {};
    nodes[id] = { id, entityType: n.entityType || n.type || '', name: typeof n.name === 'string' ? n.name : '' };
  }
  for (const r of spec.rels || []) {
    const f = isArray(r) ? r[0] : r && (r.from && r.from.id ? r.from.id : r.from);
    const t = isArray(r) ? r[1] : r && (r.to && r.to.id ? r.to.id : r.to);
    if (!f || !t) continue;
    const c = children[f] || (children[f] = []);
    if (c.indexOf(t) < 0) c.push(t);
    const p = parents[t] || (parents[t] = []);
    if (p.indexOf(f) < 0) p.push(f);
  }
  return { nodes, children, parents, roots: spec.roots || null };
}
function asTree(t: any): Tree {
  if (!t) return makeTree({});
  if (t.children && t.parents && t.nodes) return t as Tree;
  return makeTree(t);
}
function typeOf(T: Tree, id: string): string {
  const n: any = T.nodes[id];
  return n ? n.entityType || n.type || '' : '';
}
function nameOf(T: Tree, names: Record<string, string> | null | undefined, id: string): string {
  if (names && has(names, id) && typeof names[id] === 'string') return names[id];
  const n = T.nodes[id];
  return n && n.name ? n.name : '';
}
// ids from id up the first parent, top first (a cycle stops it)
function chainUp(T: Tree, id: string): string[] {
  const out = [id];
  const seen: Record<string, boolean> = { [id]: true };
  for (let cur = id, g = 0; g < 64; g++) {
    const p = (T.parents[cur] || [])[0];
    if (!p || seen[p]) break;
    seen[p] = true;
    out.push(p);
    cur = p;
  }
  return out.reverse();
}
const namePath = (T: Tree, names: Record<string, string> | null | undefined, id: string) => chainUp(T, id).map((x) => nameOf(T, names, x));
// every id below id (breadth first, a visited set, at most maxDepth levels)
function below(T: Tree, id: string, maxDepth: number, fn: (id: string, depth: number) => void) {
  const seen: Record<string, boolean> = { [id]: true };
  const q: [string, number][] = [[id, 0]];
  while (q.length) {
    const x = q.shift()!;
    if (x[1] >= maxDepth) continue;
    const kids = T.children[x[0]] || [];
    for (const c of kids) {
      if (seen[c]) continue;
      seen[c] = true;
      fn(c, x[1] + 1);
      q.push([c, x[1] + 1]);
    }
  }
}
// every ancestor of id (every parent, any number of levels)
function above(T: Tree, id: string, fn: (id: string) => void) {
  const seen: Record<string, boolean> = { [id]: true };
  const q = [id];
  while (q.length) {
    const ps = T.parents[q.shift()!] || [];
    for (const p of ps) {
      if (seen[p]) continue;
      seen[p] = true;
      fn(p);
      q.push(p);
    }
  }
}

/** Valid grants once each, DEVICE as 'fixed'; with a tree, grants inside an ASSET 'all' grant are dropped; sorted. */
export function normalize(grants: unknown, tree?: Tree | TreeSpec | null): Grant[] {
  const w: string[] = [];
  let g: Grant[] = validate(grants, w).map((x) => ({ id: x.id, type: x.type, mode: x.type === 'DEVICE' ? 'fixed' : 'all' }));
  if (tree) {
    const T = asTree(tree);
    const alls: Record<string, boolean> = {};
    for (const x of g) if (x.type === 'ASSET') alls[x.id] = true;
    g = g.filter((x) => {
      let inside = false;
      above(T, x.id, (p) => {
        if (alls[p]) inside = true;
      });
      return !inside;
    });
  }
  return g.sort((a, b) => cmp(a.type === 'ASSET' ? 0 : 1, b.type === 'ASSET' ? 0 : 1) || cmp(a.id, b.id));
}

// ---------------------------------------------------------------------------------------------- resolution
type AccessParts = Omit<Access, 'deviceIds' | 'assetIds' | 'navIds' | 'has' | 'hasAll' | 'sees'>;
function finish(r: AccessParts): Access {
  const a = r as Access;
  a.deviceIds = a.devices;
  a.assetIds = a.assets;
  a.navIds = a.nav;
  a.has = (id) => a.unrestricted || a.devices.has(id);
  a.hasAll = (id) => a.unrestricted || a.under.has(id);
  a.sees = (id) => a.unrestricted || a.devices.has(id) || a.assets.has(id) || a.nav.has(id);
  return a;
}

/** The tenant admin's Access: no filter (has / hasAll / sees are always true). */
export function unrestricted(): Access {
  return finish({
    unrestricted: true,
    source: 'unrestricted',
    grants: [],
    warnings: [],
    legacyNames: [],
    devices: new Set(),
    assets: new Set(),
    nav: new Set(),
    allRoots: new Set(),
    under: new Set(),
    unresolved: [],
    dropped: [],
    coversAll: true,
    sites: [],
  });
}

/** The resolution rule (docs/ACCESS.md): what the grants give in this tree. */
export function resolveTree(grants: unknown, tree: Tree | TreeSpec | null | undefined, opts: ResolveOptions = {}): Access {
  opts = opts || {};
  const T = asTree(tree);
  const w: string[] = [];
  const gs = validate(grants, w);
  const maxDepth = (opts.maxDepth ?? 0) > 0 ? opts.maxDepth! : MAX_DEPTH;
  const names = opts.names || null;
  const exSet = opts.exists ? setOf(opts.exists) : null;
  const exists = (id: string) => (exSet ? exSet.has(id) : has(T.nodes, id));
  const notOwned = opts.notOwned ? setOf(opts.notOwned) : null;
  const owned = typeof opts.owned === 'function' ? opts.owned : notOwned ? (id: string) => !notOwned.has(id) : null;
  const devices = new Set<string>();
  const assets = new Set<string>();
  const nav = new Set<string>();
  const allRoots = new Set<string>();
  const under = new Set<string>();
  const unresolved: Unresolved[] = [];
  const devGrants: string[] = [];
  for (const g of gs) {
    if (!exists(g.id)) {
      unresolved.push({ id: g.id, type: g.type, reason: 'gone' });
      continue;
    }
    // the tree knows the type: an ASSET grant on a machine (a legacy bare uuid) is that machine
    if (g.type === 'DEVICE' || typeOf(T, g.id) === 'DEVICE') {
      devices.add(g.id);
      devGrants.push(g.id);
      continue;
    }
    allRoots.add(g.id);
    assets.add(g.id);
    under.add(g.id);
    below(T, g.id, maxDepth, (c) => {
      under.add(c);
      if (typeOf(T, c) === 'DEVICE') devices.add(c);
      else assets.add(c);
    });
  }
  const starts = keys(allRoots).concat(devGrants);
  for (const s of starts)
    above(T, s, (p) => {
      if (!assets.has(p) && !devices.has(p)) nav.add(p);
    });
  const dropped = new Set<string>();
  if (owned) {
    for (const set of [devices, assets, nav, allRoots, under])
      for (const id of keys(set))
        if (!owned(id)) {
          set.delete(id);
          dropped.add(id);
        }
  }
  // the whole organisation: every top asset (given, or the tops above the grants) is an 'all' root
  let tops: string[] = [];
  if (isArray(opts.tops)) tops = opts.tops.slice();
  else {
    const t: Record<string, boolean> = {};
    for (const s of starts) {
      if (owned && !owned(s)) continue;
      const cand = [s];
      above(T, s, (p) => cand.push(p));
      for (const x of cand) if (!(T.parents[x] || []).length && typeOf(T, x) === 'ASSET' && (!owned || owned(x))) t[x] = true;
    }
    tops = Object.keys(t);
  }
  const coversAll = tops.length > 0 && tops.every((x) => allRoots.has(x));
  // the assets that directly Contain a granted machine
  const siteMap: Record<string, string[]> = {};
  for (const d of keys(devices))
    for (const p of T.parents[d] || []) {
      if (!(assets.has(p) || nav.has(p)) || typeOf(T, p) === 'DEVICE') continue;
      (siteMap[p] = siteMap[p] || []).push(d);
    }
  const sites = Object.keys(siteMap)
    .map((id) => {
      const ids = siteMap[id].filter((x, i, a) => a.indexOf(x) === i).sort(cmp);
      return { id, name: nameOf(T, names, id), path: namePath(T, names, id), deviceIds: ids, full: under.has(id) };
    })
    .sort((a, b) => cmpArr(a.path, b.path) || cmp(a.id, b.id));
  return finish({
    unrestricted: false,
    source: opts.source || 'imexAccess',
    grants: gs,
    warnings: w,
    legacyNames: [],
    devices,
    assets,
    nav,
    allRoots,
    under,
    unresolved,
    dropped: keys(dropped),
    coversAll,
    sites,
  });
}

/** One entity from a legacy name: ASSET by name, DEVICE by name, ASSET by label, DEVICE by label; the first non-empty group must have exactly one. */
export function pickByName(cands: unknown): { id: string; type: 'ASSET' | 'DEVICE' } | null {
  const list: any[] = isArray(cands) ? cands : [];
  const groups: [string, string][] = [
    ['ASSET', 'name'],
    ['DEVICE', 'name'],
    ['ASSET', 'label'],
    ['DEVICE', 'label'],
  ];
  for (const [type, via] of groups) {
    const ids: Record<string, boolean> = {};
    let hit: { id: string; type: 'ASSET' | 'DEVICE' } | null = null;
    let n = 0;
    for (const c of list) {
      const id = c && normId(c.id);
      if (!id || c.type !== type || (c.via || 'name') !== via || has(ids, id)) continue;
      ids[id] = true;
      n++;
      hit = { id, type: c.type };
    }
    if (n === 1) return hit;
    if (n > 1) return null;
  }
  return null;
}

/** Tenant and system administrators are unrestricted. */
export const isUnrestrictedUser = (user: { authority?: string } | null | undefined): boolean => !!user && (user.authority === 'TENANT_ADMIN' || user.authority === 'SYS_ADMIN');

/** parse + legacy names (opts.byName: name -> candidates) + resolveTree, for one user. */
export function resolveUser(
  user: { authority?: string } | null | undefined,
  imexAccess: unknown,
  selectedNodes: unknown,
  tree: Tree | TreeSpec | null | undefined,
  opts: ResolveOptions & { byName?: Record<string, any[]> } = {},
): Access {
  if (isUnrestrictedUser(user)) return unrestricted();
  opts = opts || {};
  const p = parse(imexAccess, selectedNodes);
  const grants: Grant[] = p.grants.slice();
  const byName = opts.byName || {};
  const unresNames: Unresolved[] = [];
  for (const n of p.legacyNames) {
    const hit = pickByName(byName[n]);
    if (hit) grants.push({ id: hit.id, type: hit.type, mode: hit.type === 'DEVICE' ? 'fixed' : 'all' });
    else unresNames.push({ id: null, type: null, name: n, reason: 'name' });
  }
  const o: any = { ...opts, source: p.source };
  const a = resolveTree(grants, tree, o);
  const w = p.warnings.slice();
  for (const c of a.warnings) warn(w, c);
  a.warnings = w;
  a.unresolved = a.unresolved.concat(unresNames);
  a.legacyNames = p.legacyNames.slice();
  return a;
}

/** The shared relations cache key: 'imex-dbb-rel:<userId>:<ids in normalized order>' (core/scope.ts, the app's imxShell.tree). */
export function rootKey(userId: string | null | undefined, grants: unknown): string {
  return `imex-dbb-rel:${userId || ''}:${normalize(grants)
    .map((g) => g.id)
    .join(',')}`;
}

/** The Access with sorted arrays instead of sets, without the functions (vectors, logs). */
export function plain(a: Access): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(a)) {
    const v = (a as any)[k];
    if (typeof v === 'function' || k === 'deviceIds' || k === 'assetIds' || k === 'navIds' || k === 'tree') continue;
    out[k] = v instanceof Set ? keys(v) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- the Users page
// (the App UI's User management writes grants; ported so the TypeScript copy runs every vector section)

/** Tree selection -> grants. hints[id] = 'all' where the node itself was ticked or "Include equipment added later" is on. */
export function grantsFromSelection(tree: Tree | TreeSpec, selected: string[], hints?: Record<string, string> | null, opts: { roots?: any[] } = {}): Grant[] {
  opts = opts || {};
  const T = asTree(tree);
  const S = setOf(selected);
  const H = hints || {};
  const out: Grant[] = [];
  const memo: Record<string, string> = {};
  const busy: Record<string, boolean> = {};
  const state = (id: string): string => {
    if (has(memo, id)) return memo[id];
    if (busy[id]) return 'none';
    busy[id] = true;
    const kids = typeOf(T, id) === 'DEVICE' ? [] : T.children[id] || [];
    let st: string;
    if (!kids.length) st = S.has(id) ? 'full' : 'none';
    else {
      let full = 0;
      let part = 0;
      for (const k of kids) {
        const s = state(k);
        if (s === 'full') full++;
        else if (s === 'partial') part++;
      }
      st = full === kids.length ? 'full' : full + part > 0 ? 'partial' : 'none';
    }
    busy[id] = false;
    memo[id] = st;
    return st;
  };
  const hasDevice = (id: string) => {
    let found = false;
    below(T, id, MAX_DEPTH, (c) => {
      if (typeOf(T, c) === 'DEVICE') found = true;
    });
    return found;
  };
  const emit = (id: string): void => {
    const st = state(id);
    if (st === 'none') return;
    if (typeOf(T, id) === 'DEVICE') {
      if (st === 'full') out.push({ id, type: 'DEVICE', mode: 'fixed' });
      return;
    }
    if (st === 'full' && (H[id] === 'all' || !hasDevice(id))) {
      out.push({ id, type: 'ASSET', mode: 'all' });
      return;
    }
    (T.children[id] || []).forEach(emit);
  };
  const roots: any[] = opts.roots || T.roots || Object.keys(T.nodes).filter((id) => !(T.parents[id] || []).length).sort(cmp);
  for (const r of roots) emit(r && r.id ? r.id : r);
  return normalize(out, T);
}

function devicesUnder(T: Tree, id: string): string[] {
  const out: string[] = [];
  below(T, id, MAX_DEPTH, (c) => {
    if (typeOf(T, c) === 'DEVICE') out.push(c);
  });
  return out;
}
const isSite = (T: Tree, id: string) => (T.children[id] || []).some((c) => typeOf(T, c) === 'DEVICE');
function outsideOf(editor: Access | null | undefined, g: Grant): boolean {
  if (!editor || editor.unrestricted || editor.coversAll) return false;
  return !(g.type === 'ASSET' ? editor.hasAll(g.id) : editor.has(g.id));
}

export interface SummaryLine {
  text: string;
  tip: string;
  kind: 'all' | 'fixed' | 'warn' | 'muted';
}

/** One line per 'all' root and per parent of fixed machines, then what no longer exists and what lies outside the editor's access. */
export function summary(grants: unknown, tree: Tree | TreeSpec, opts: { exists?: string[]; editor?: Access | null; names?: Record<string, string> | null } = {}): SummaryLine[] {
  opts = opts || {};
  const T = asTree(tree);
  const names = opts.names || null;
  const gs = validate(grants, []);
  if (!gs.length) return [{ text: 'No access: this user will see no machines', tip: '', kind: 'muted' }];
  const exSet = opts.exists ? setOf(opts.exists) : null;
  const exists = (id: string) => (exSet ? exSet.has(id) : has(T.nodes, id));
  const alls: string[] = [];
  const fixed: Record<string, string[]> = {};
  let goneA = 0;
  let goneD = 0;
  const outside: Grant[] = [];
  for (const g of gs) {
    if (!exists(g.id)) {
      if (g.type === 'ASSET') goneA++;
      else goneD++;
      continue;
    }
    if (outsideOf(opts.editor, g)) {
      outside.push(g);
      continue;
    }
    if (g.type === 'ASSET') alls.push(g.id);
    else {
      const p = (T.parents[g.id] || [])[0] || '';
      (fixed[p] = fixed[p] || []).push(g.id);
    }
  }
  const byPath = (a: string, b: string) => cmpArr(namePath(T, names, a), namePath(T, names, b)) || cmp(a, b);
  const lines: SummaryLine[] = [];
  for (const id of alls.sort(byPath)) {
    const name = nameOf(T, names, id);
    const devs = devicesUnder(T, id);
    const subs = (T.children[id] || []).some((c) => typeOf(T, c) !== 'DEVICE');
    const line: SummaryLine = { text: '', tip: '', kind: 'all' };
    if (!devs.length) line.text = `${name} · all machines, including new (none yet)`;
    else if (subs) {
      let nSites = 0;
      below(T, id, MAX_DEPTH, (c) => {
        if (typeOf(T, c) !== 'DEVICE' && isSite(T, c)) nSites++;
      });
      if (isSite(T, id)) nSites++;
      line.text = `${name} · all sites and machines, including new`;
      line.tip = `${plural(nSites, 'site', 'sites')}, ${plural(devs.length, 'machine', 'machines')} today`;
    } else {
      line.text = `${name} · all machines, including new`;
      line.tip = `${plural(devs.length, 'machine', 'machines')} today: ${devs
        .map((d) => nameOf(T, names, d))
        .sort(cmp)
        .join(', ')}. Machines added later are included.`;
    }
    lines.push(line);
  }
  for (const p of Object.keys(fixed).sort((a, b) => (a && b ? byPath(a, b) : cmp(a ? 0 : 1, b ? 0 : 1)))) {
    const ids = fixed[p];
    lines.push({
      text: `${p ? nameOf(T, names, p) : 'Not in a location'} · ${plural(ids.length, 'machine', 'machines')} (fixed)`,
      tip: `${ids
        .map((d) => nameOf(T, names, d))
        .sort(cmp)
        .join(', ')}. Machines added later are not included.`,
      kind: 'fixed',
    });
  }
  if (goneA) lines.push({ text: goneA + (goneA === 1 ? ' location no longer exists' : ' locations no longer exist'), tip: 'It will be removed when you save.', kind: 'warn' });
  if (goneD) lines.push({ text: goneD + (goneD === 1 ? ' machine no longer exists' : ' machines no longer exist'), tip: 'It will be removed when you save.', kind: 'warn' });
  if (outside.length)
    lines.push({
      text: `+${plural(outside.length, 'location', 'locations')} outside your access (kept)`,
      tip: outside
        .map((g) => nameOf(T, names, g.id))
        .filter(Boolean)
        .join(', '),
      kind: 'muted',
    });
  return lines;
}

/** The short form for a table cell: 'Pune · all', 'Pune · 2 fixed', 'Whole organisation', 'No access'. */
export function compact(grants: unknown, tree: Tree | TreeSpec, opts: { exists?: string[]; access?: Access | null; names?: Record<string, string> | null } = {}): string {
  opts = opts || {};
  const T = asTree(tree);
  const names = opts.names || null;
  const gs = validate(grants, []);
  if (!gs.length) return 'No access';
  if (opts.access && opts.access.coversAll && !opts.access.unrestricted) return 'Whole organisation';
  const exSet = opts.exists ? setOf(opts.exists) : null;
  const live = gs.filter((g) => (exSet ? exSet.has(g.id) : has(T.nodes, g.id)));
  const alls = live.filter((g) => g.type === 'ASSET');
  const fixed = live.filter((g) => g.type === 'DEVICE');
  const parts: string[] = [];
  if (alls.length === 1) parts.push(`${nameOf(T, names, alls[0].id)} · all`);
  else if (alls.length > 1) parts.push(`${alls.length}${alls.every((g) => isSite(T, g.id)) ? ' sites' : ' locations'} · all`);
  if (fixed.length) {
    const ps: Record<string, boolean> = {};
    for (const g of fixed) ps[(T.parents[g.id] || [])[0] || ''] = true;
    const pk = Object.keys(ps);
    parts.push(pk.length === 1 && pk[0] ? `${nameOf(T, names, pk[0])} · ${fixed.length} fixed` : `${plural(fixed.length, 'machine', 'machines')} · fixed`);
  }
  return parts.length ? parts.join(', ') : 'No access';
}

/** The compatibility copy written with imexAccess: selectedNodes (one entry per grant) and area (every name on the paths, then the machines). */
export function snapshot(access: Access | null | undefined, grants: unknown, tree: Tree | TreeSpec): { selectedNodes: any[]; area: string } {
  const T = asTree(tree);
  const gs = normalize(grants).filter((g) => has(T.nodes, g.id));
  const selectedNodes = gs.map((g) => {
    const path = namePath(T, null, g.id);
    return { ID: path.join('_'), categoryId: path.slice(0, -1).join('_'), name: path[path.length - 1], entityId: g.id, entityType: g.type, expanded: true, selected: true };
  });
  const byPath = (a: string, b: string) => cmpArr(namePath(T, null, a), namePath(T, null, b)) || cmp(a, b);
  const a = access || resolveTree(gs, T);
  const places = keys(a.nav)
    .concat(keys(a.assets))
    .filter((x, i, l) => l.indexOf(x) === i)
    .sort(byPath);
  const machines = keys(a.devices).sort(byPath);
  const seen: Record<string, boolean> = {};
  const area: string[] = [];
  for (const id of places.concat(machines)) {
    const n = nameOf(T, null, id);
    if (n && !has(seen, n)) {
      seen[n] = true;
      area.push(n);
    }
  }
  return { selectedNodes, area: area.join(', ') };
}
