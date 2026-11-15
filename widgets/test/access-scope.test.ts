// D-050: the user context built from the shared access and role cores (core/scope.ts loadUserContext), the Builder
// flags that follow from the role, the nav nodes of the tree, and the page context's staleness check (entries/common.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeTB, ithena, asUser, asGrantee, ROOT, RIC, PUN } from './fake-tb';
import * as scope from '../src/core/scope';
import * as store from '../src/core/store';
import * as chat from '../src/core/chat';
import { slotStale } from '../src/entries/common';

let tb: FakeTB;
const mem = new Map<string, string>();
const ses = new Map<string, string>();
// machines with real ids (the access core only takes uuid grants; the sample's machines have short ids)
const RC2 = 'd0000000-0000-4000-8000-000000000001';
const PC2 = 'd0000000-0000-4000-8000-000000000002';
const CONFIG = 'c0000000-0000-4000-8000-000000000001';
beforeEach(() => {
  tb = ithena();
  tb.add({ id: RC2, entityType: 'DEVICE', name: 'RIC-COMP-02', label: 'Richmond Compressor 2', type: 'Compressor' }, 'ric');
  tb.add({ id: PC2, entityType: 'DEVICE', name: 'PUN-COMP-02', label: 'Pune Compressor 2', type: 'Compressor' }, 'pun');
  mem.clear();
  ses.clear();
  mem.set('jwt_token', 'x');
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => ses.get(k) ?? null,
    setItem: (k: string, v: string) => void ses.set(k, v),
    removeItem: (k: string) => void ses.delete(k),
    key: (i: number) => [...ses.keys()][i] ?? null,
    get length() {
      return ses.size;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

/** The customer's role store on its System Configuration asset. */
function roleStore(roles: any[], rev = 3) {
  tb.add({ id: CONFIG, entityType: 'ASSET', name: 'System Configuration', label: 'System Configuration', type: 'Configuration' });
  tb.setAttrs('ASSET', CONFIG, { imexRoles: JSON.stringify({ v: 1, rev, roles: [{ id: 'admin', name: 'Admin' }, { id: 'viewer', name: 'Viewer', perms: { sites: 'view', machines: 'view', dashboards: 'view' }, actions: { 'reports.run': true } }, ...roles] }) });
}
/** A custom role: Machines and Dashboards at View, the given actions ticked. */
const builderRole = (actions: Record<string, true>) => ({ id: 'r_build1', name: 'Line builder', perms: { sites: 'view', machines: 'view', dashboards: 'view' }, actions });
const ids = (ctx: scope.UserContext) => scope.allDevices(ctx).map((d) => d.id).sort();

describe('WHERE: imexAccess first, the legacy selectedNodes only while it is absent', () => {
  it("an 'all' grant on a site: its machines, now and later; the organisation above it is the path (nav)", async () => {
    asGrantee(tb, 'u-a', [{ id: 'pun' }], undefined, { selectedNodes: JSON.stringify([{ entityId: RIC }]) });
    let ctx = await scope.loadUserContext();
    expect(ctx.access.source).toBe('imexAccess');
    expect(ids(ctx)).toEqual([PC2, 'pc', 'pw'].sort());
    expect(ctx.rootIds).toEqual([ROOT]);
    expect(ctx.allRoots).toEqual([PUN]);
    expect(ctx.nodes.get(ROOT)!.nav).toBe(true);
    expect(ctx.nodes.get(ROOT)!.children).toEqual([PUN]);
    expect(ctx.nodes.get(PUN)!.nav).toBeUndefined();
    expect(scope.isVisibleNode(ctx, ROOT)).toBe(true);
    expect(scope.holdsAll(ctx, ROOT)).toBe(false);
    expect(scope.holdsAll(ctx, PUN)).toBe(true);
    expect(ctx.coversAll).toBe(false);
    // a machine added under the site later is in, once the context is loaded again (the cached relations aside)
    tb.add({ id: 'd0000000-0000-4000-8000-000000000009', entityType: 'DEVICE', name: 'PUN-NEW', label: 'Pune New', type: 'Dryer' }, 'pun');
    scope.clearRelCache();
    ctx = await scope.loadUserContext();
    expect(ids(ctx)).toContain('d0000000-0000-4000-8000-000000000009');
  });

  it('fixed machines: only those; their sites and the organisation are nav nodes listing only them', async () => {
    asGrantee(tb, 'u-f', [{ id: RC2, type: 'DEVICE' }, { id: PC2, type: 'DEVICE' }]);
    const ctx = await scope.loadUserContext();
    expect(ids(ctx)).toEqual([RC2, PC2].sort());
    expect(ctx.rootIds).toEqual([ROOT]);
    expect(ctx.allRoots).toEqual([]);
    for (const n of [ROOT, RIC, PUN]) expect(ctx.nodes.get(n)!.nav, n).toBe(true);
    expect(ctx.nodes.get(RIC)!.children).toEqual([RC2]);
    expect(scope.pathLabel(ctx, RC2)).toBe('ITHENA › Richmond › Richmond Compressor 2');
    expect(scope.isGrantedMachine(ctx, RC2)).toBe(true);
    expect(scope.isGrantedMachine(ctx, 'rc')).toBe(false);
    expect(scope.isGrantedMachine(ctx, RIC)).toBe(false);
    expect(scope.devicesUnder(ctx, RIC).map((d) => d.id)).toEqual([RC2]);
    // a machine added to the site later is NOT granted
    tb.add({ id: 'd0000000-0000-4000-8000-000000000009', entityType: 'DEVICE', name: 'RIC-NEW', label: 'Richmond New', type: 'Compressor' }, 'ric');
    scope.clearRelCache();
    expect(ids(await scope.loadUserContext())).toEqual([RC2, PC2].sort());
  });

  it("an 'all' grant on the organisation covers it (customer-wide assignments); two sites do not", async () => {
    asGrantee(tb, 'u-o', [{ id: 'root' }]);
    let ctx = await scope.loadUserContext();
    expect(ctx.coversAll).toBe(true);
    expect(ctx.rootsAreTop).toBe(true);
    asGrantee(tb, 'u-s', [{ id: 'ric' }, { id: 'pun' }]);
    ctx = await scope.loadUserContext();
    expect(ctx.coversAll).toBe(false);
    expect(ctx.rootIds).toEqual([ROOT]);
    expect(ctx.nodes.get(ROOT)!.nav).toBe(true);
    expect(ids(ctx).length).toBe(6);
  });

  it('fail closed: no grants, an empty list or an unreadable imexAccess is no equipment at all', async () => {
    for (const a of [{ v: 1, grants: [] }, { v: 2, grants: [{ id: PUN, type: 'ASSET', mode: 'all' }] }, 'not json']) {
      tb.me = { ...tb.me, id: { id: 'u-x' } };
      tb.attrs.delete('USER:u-x:SERVER_SCOPE');
      tb.setAttrs('USER', 'u-x', { imexAccess: a, selectedNodes: JSON.stringify([{ entityId: PUN }]) });
      const ctx = await scope.loadUserContext();
      expect(ctx.nodes.size, JSON.stringify(a)).toBe(0);
      expect(ctx.warnings.length, JSON.stringify(a)).toBeGreaterThan(0);
    }
    tb.me = { ...tb.me, id: { id: 'u-none' } };
    const none = await scope.loadUserContext();
    expect(none.nodes.size).toBe(0);
    expect(none.warnings.join()).toMatch(/No equipment is assigned/);
  });

  it('a deleted grant is left out with a warning; the rest still loads', async () => {
    asGrantee(tb, 'u-g', [{ id: 'pun' }, { id: 'd0000000-0000-4000-8000-0000000000ff', type: 'DEVICE' }]);
    const ctx = await scope.loadUserContext();
    expect(ids(ctx)).toEqual([PC2, 'pc', 'pw'].sort());
    expect(ctx.warnings.join()).toMatch(/machine assigned to you no longer exists/);
  });

  it('D-051: a deleted granted location (its relations answer 404) drops out; the rest loads and is cached', async () => {
    const gone = 'a0000000-0000-4000-8000-0000000000ff';
    asGrantee(tb, 'u-gl', [{ id: 'pun' }, { id: gone }]);
    const ctx = await scope.loadUserContext();
    expect(tb.calls.filter((c) => c === 'POST /api/relations').length).toBeGreaterThan(0);
    expect(ids(ctx)).toEqual([PC2, 'pc', 'pw'].sort());
    expect(ctx.access.unresolved.map((u) => [u.id, u.reason])).toEqual([[gone, 'gone']]);
    expect(ctx.warnings.join()).toMatch(/location assigned to you no longer exists/);
    expect(ctx.warnings.join()).not.toMatch(/could not be checked/);
    // a 404 is an answer, not a failure: the relations are kept for the next page (the app's key)
    expect([...ses.keys()].filter((k) => k.startsWith('imex-dbb-rel:u-gl:'))).toHaveLength(1);
  });

  it('D-051: any other failed relation call fails closed (no equipment, a warning, nothing cached)', async () => {
    asGrantee(tb, 'u-gf', [{ id: 'pun' }]);
    tb.failNext = { match: /^\/api\/relations$/, status: 403 }; // (a 5xx is retried first)
    const ctx = await scope.loadUserContext();
    expect(ctx.nodes.size).toBe(0);
    expect(scope.allDevices(ctx)).toEqual([]);
    expect(ctx.access.devices.size).toBe(0);
    expect(ctx.warnings.join()).toMatch(/could not be checked/);
    expect([...ses.keys()].filter((k) => k.startsWith('imex-dbb-rel:u-gf:'))).toHaveLength(0);
  });

  it('a legacy bare uuid of a machine (read as a location) is asked again as a machine', async () => {
    tb.me = { ...tb.me, id: { id: 'u-l' } };
    tb.setAttrs('USER', 'u-l', { Role: 'Viewer', selectedNodes: JSON.stringify([RC2]) });
    const ctx = await scope.loadUserContext();
    expect(ctx.access.source).toBe('legacy');
    expect(ids(ctx)).toEqual([RC2]);
    expect(ctx.nodes.get(RIC)!.nav).toBe(true);
  });

  it('the relations are cached under the key the app uses (grant ids in normalized order)', async () => {
    asGrantee(tb, 'u-k', [{ id: PC2, type: 'DEVICE' }, { id: 'ric' }]);
    const ctx = await scope.loadUserContext();
    expect([...ses.keys()].filter((k) => k.startsWith('imex-dbb-rel:'))).toEqual([`imex-dbb-rel:u-k:${ctx.sig!.access}`]);
    expect(ctx.sig!.access).toBe(`${RIC},${PC2}`);
  });
});

describe('WHAT: the role (imexRole in the store, else the legacy Role / dbbAdmin)', () => {
  it('a custom role with dashboards.build only: may build, not apply to many machines, not delete others', async () => {
    roleStore([builderRole({ 'dashboards.build': true })]);
    asGrantee(tb, 'u-b', [{ id: 'root' }], 'r_build1');
    const ctx = await scope.loadUserContext();
    expect(ctx.role).toBe('Line builder');
    expect(ctx.perms.source).toBe('imexRole');
    expect(ctx.perms.rev).toBe(3);
    expect([ctx.canBuild, ctx.canApplyMany, ctx.canDeleteAny, ctx.isAdmin]).toEqual([true, false, false, true]);
    expect(ctx.perms.page('dashboards')).toBe('view');
    expect(ctx.perms.canState('user_management')).toBe('hidden');
    expect(store.canApply(ctx, { type: 'devices', deviceIds: ['pc'], mode: 'linked' })).toBeNull();
    expect(store.canApply(ctx, { type: 'devices', deviceIds: ['pc', 'rc'], mode: 'linked' })).toMatch(/role/);
    expect(store.canApply(ctx, { type: 'customer', profile: 'Compressor' })).toMatch(/role/);
    const other = { ...store.blankDashboard(ctx, 'theirs', 'Compressor'), ownerId: 'someone-else', version: 1 };
    await expect(store.deleteDashboard(ctx, other as any)).rejects.toThrow(/owner/);
    const r = chat.applyOps(ctx, store.blankDashboard(ctx, 'x', 'Compressor'), chat.normaliseToolInput({ reply: '', ops: [{ op: 'setApplyTarget', target: 'customer' }] }), chat.buildCatalog(ctx));
    expect(r.applyProposal).toBeNull();
    expect(r.warnings.join()).toMatch(/role/);
    expect(chat.systemPrompt(ctx, chat.buildCatalog(ctx), null)).toContain('does NOT, so only "this" is allowed');
  });

  it('applyMany and deleteAny ticked: the three flags; a location needs to be held in full', async () => {
    roleStore([builderRole({ 'dashboards.build': true, 'dashboards.applyMany': true, 'dashboards.deleteAny': true })]);
    asGrantee(tb, 'u-m', [{ id: 'pun' }, { id: RC2, type: 'DEVICE' }], 'r_build1');
    const ctx = await scope.loadUserContext();
    expect([ctx.canBuild, ctx.canApplyMany, ctx.canDeleteAny]).toEqual([true, true, true]);
    expect(store.canApply(ctx, { type: 'node', nodeId: PUN, profile: 'Compressor' })).toBeNull();
    expect(store.canApply(ctx, { type: 'node', nodeId: RIC, profile: 'Compressor' })).toMatch(/need all of it/);
    expect(store.canApply(ctx, { type: 'node', nodeId: ROOT, profile: 'Compressor' })).toMatch(/need all of it/);
    expect(store.canApply(ctx, { type: 'customer', profile: 'Compressor' })).toMatch(/whole organisation/);
    expect(scope.nodesContaining(ctx, 'Compressor').map((n) => n.id)).toEqual([PUN]);
    const cat = chat.buildCatalog(ctx);
    const ric = cat.byId.get(RIC)!;
    const r = chat.applyOps(ctx, store.blankDashboard(ctx, 'x', 'Compressor'), chat.normaliseToolInput({ reply: '', ops: [{ op: 'setApplyTarget', target: 'node', node: ric }] }), cat);
    expect(r.applyProposal).toBeNull();
    expect(r.warnings.join()).toMatch(/outside your access/);
  });

  it('customise needs dashboards.build and a granted machine', async () => {
    asUser(tb, 'u-v', 'Viewer', ['root']);
    const viewer = await scope.loadUserContext();
    expect(viewer.canBuild).toBe(false);
    await expect(store.customise(viewer, 'pc', store.blankDashboard(viewer, 't', 'Compressor'))).rejects.toThrow(/role/);
    asGrantee(tb, 'u-ad', [{ id: 'pun' }], 'admin');
    const admin = await scope.loadUserContext();
    expect(admin.canBuild).toBe(true);
    await expect(store.customise(admin, 'rc', store.blankDashboard(admin, 't', 'Compressor'))).rejects.toThrow(/not in your access/);
  });

  it('an imexRole that is gone is the Viewer, with a warning; no store (POC customers) = the built-ins', async () => {
    roleStore([]);
    asGrantee(tb, 'u-gone', [{ id: 'root' }], 'r_deleted');
    let ctx = await scope.loadUserContext();
    expect(ctx.perms.roleId).toBe('viewer');
    expect(ctx.canBuild).toBe(false);
    expect(ctx.warnings.join()).toMatch(/role no longer exists/);
    tb.entities.delete(CONFIG);
    ses.clear();
    asGrantee(tb, 'u-poc', [{ id: 'root' }], 'admin');
    ctx = await scope.loadUserContext();
    expect(ctx.perms.rev).toBe(0);
    expect([ctx.canBuild, ctx.canApplyMany, ctx.canDeleteAny]).toEqual([true, true, true]);
  });

  it('legacy: Admin / Customer Admin / Administrator / dbbAdmin "true" are Admin; User, Viewer, absent are Viewer', async () => {
    for (const [attrs, admin] of [
      [{ Role: 'Admin' }, true],
      [{ Role: 'customer admin' }, true],
      [{ Role: 'Administrator' }, true],
      [{ Role: 'User', dbbAdmin: 'true' }, true],
      [{ Role: 'User' }, false],
      [{ Role: 'Viewer' }, false],
      [{}, false],
      [{ Role: 'Operator' }, false],
    ] as [Record<string, any>, boolean][]) {
      tb.me = { ...tb.me, id: { id: 'u-leg' } };
      tb.attrs.delete('USER:u-leg:SERVER_SCOPE');
      tb.setAttrs('USER', 'u-leg', { ...attrs, imexAccess: { v: 1, grants: [{ id: ROOT, type: 'ASSET', mode: 'all' }] } });
      const ctx = await scope.loadUserContext();
      expect(ctx.perms.source, JSON.stringify(attrs)).toBe('legacy');
      expect([ctx.canBuild, ctx.canApplyMany, ctx.canDeleteAny], JSON.stringify(attrs)).toEqual([admin, admin, admin]);
    }
  });

  it("the app's copy of the role store is used while fresh (one request less), and written after a read", async () => {
    roleStore([builderRole({ 'dashboards.build': true })], 7);
    asGrantee(tb, 'u-c', [{ id: 'root' }], 'r_build1');
    await scope.loadUserContext();
    const copy = JSON.parse(ses.get('imex-roles:c1')!);
    expect(typeof copy.raw).toBe('string');
    const before = tb.calls.length;
    tb.calls = [];
    // the app wrote a newer store meanwhile (another rev, the role gone)
    ses.set('imex-roles:c1', JSON.stringify({ at: Date.now(), raw: { v: 1, rev: 8, roles: [] } }));
    const ctx = await scope.loadUserContext();
    expect(before).toBeGreaterThan(tb.calls.length);
    expect(tb.calls.filter((c) => c === 'POST /api/entitiesQuery/find').length).toBe(2); // the tree's two entity queries only
    expect(ctx.perms.rev).toBe(8);
    expect(ctx.perms.roleId).toBe('viewer');
    // an old copy is not used
    ses.set('imex-roles:c1', JSON.stringify({ at: Date.now() - scope.ROLES_MIRROR_MS - 1, raw: null }));
    expect((await scope.loadUserContext()).perms.rev).toBe(7);
  });

  it('a failed role store read: the built-ins, a warning, custom roles act as Viewer (fail closed)', async () => {
    roleStore([builderRole({ 'dashboards.build': true })]);
    asGrantee(tb, 'u-fail', [{ id: 'root' }], 'r_build1');
    tb.failNext = { match: /entitiesQuery/, status: 403 };
    const ctx = await scope.loadUserContext();
    expect(ctx.perms.warnings).toContain('roles.unreadable');
    expect(ctx.canBuild).toBe(false);
    expect(ctx.warnings.join()).toMatch(/roles could not be read/);
  });

  it('unreadable user attributes: no page, no action, no machine', async () => {
    asGrantee(tb, 'u-err', [{ id: 'root' }], 'admin');
    tb.failNext = { match: /USER\/u-err\/values\/attributes/, status: 403 };
    const ctx = await scope.loadUserContext();
    expect(ctx.perms.source).toBe('error');
    expect(ctx.canBuild).toBe(false);
    expect(ctx.perms.page('machines')).toBe('hidden');
    expect(ctx.nodes.size).toBe(0);
  });

  it('a tenant admin is unrestricted: every page and action, the whole customer', async () => {
    tb.me = { ...tb.me, id: { id: 'u-t' }, authority: 'TENANT_ADMIN' };
    const ctx = await scope.loadUserContext({ tenantCustomerId: 'c1' });
    expect(ctx.perms.unrestricted).toBe(true);
    expect(ctx.access.unrestricted).toBe(true);
    expect([ctx.canBuild, ctx.canApplyMany, ctx.canDeleteAny, ctx.coversAll]).toEqual([true, true, true, true]);
    expect(ctx.perms.canState('user_management')).toBe('full');
    expect(ctx.rootIds).toEqual([ROOT]);
    expect(ids(ctx).length).toBe(6);
    expect(scope.holdsAll(ctx, PUN)).toBe(true);
  });
});

describe("D-052: the tenant admin's tree is the app's (imex-tops + the shared relations entry); the launcher asks the role alone", () => {
  const relCalls = () => tb.calls.filter((c) => /relations/.test(c));
  // a second location tree in the tenant
  const OTHER = 'a0000000-0000-4000-8000-0000000000ff';
  beforeEach(() => {
    tb.me = { ...tb.me, id: { id: 'u-t' }, authority: 'TENANT_ADMIN' };
    tb.add({ id: OTHER, entityType: 'ASSET', name: 'OTHER-SITE', label: 'Other', type: 'Site' });
    tb.add({ id: 'od', entityType: 'DEVICE', name: 'OTHER-01', label: 'Other 1', type: 'Compressor' }, OTHER);
  });

  it('cold: the tops by entity query, then ONE relations/info FROM per top and nothing else; the next page asks none', async () => {
    const ctx = await scope.loadUserContext({ tenantCustomerId: 'c1' });
    // the fake lists every asset as the customer's, so both tops are the customer's here
    expect(relCalls()).toEqual(['POST /api/relations/info', 'POST /api/relations/info']);
    const tops = [ROOT, OTHER].sort();
    expect(JSON.parse(ses.get('imex-tops:u-t')!).ids).toEqual(tops);
    const hit = JSON.parse(ses.get(`imex-dbb-rel:u-t:${tops.join(',')}`)!);
    expect([hit.names, hit.types, hit.up]).toEqual([true, 'ASSET,ASSET', [[], []]]);
    expect(hit.down.flat().every((r: any) => r.toName && r.fromName)).toBe(true);
    expect(ctx.rootIds).toEqual(tops);
    expect(ids(ctx).length).toBe(7);
    tb.calls = [];
    const again = await scope.loadUserContext({ tenantCustomerId: 'c1' });
    expect(relCalls()).toEqual([]);
    expect(ids(again).length).toBe(7);
  });

  it("warm from the app's copies: no relation request, and only the customer's tops", async () => {
    // what imxShell.scopeTree keeps: the tenant's tops and their trees (FROM only, with names), in the app's shape
    const tops = [ROOT, OTHER].sort();
    ses.set('imex-tops:u-t', JSON.stringify({ at: Date.now(), ids: tops }));
    const below = (t: string): string[] => tb.relations.filter((r) => r.from === t).flatMap((r) => [r.to, ...below(r.to)]);
    const down = tops.map((t) =>
      tb.relations
        .filter((r) => r.from === t || below(t).includes(r.from))
        .map((r) => ({ from: { id: r.from, entityType: 'ASSET' }, to: { id: r.to, entityType: tb.entities.get(r.to)!.entityType }, type: 'Contains', fromName: 'x', toName: 'y' })),
    );
    ses.set(`imex-dbb-rel:u-t:${tops.join(',')}`, JSON.stringify({ at: Date.now(), down, up: [[], []], names: true, types: 'ASSET,ASSET' }));
    // the customer's assets: everything but the other customer's site
    const real = tb.fetch;
    vi.stubGlobal('fetch', (url: string, init?: any) =>
      /\/api\/customer\/c1\/assets/.test(url) && !/type=DashboardStore/.test(url)
        ? real(url, init).then(async (r: any) => {
            const b = JSON.parse(await r.text());
            b.data = b.data.filter((a: any) => a.id.id !== OTHER);
            const t = JSON.stringify(b);
            return { status: 200, ok: true, text: async () => t };
          })
        : real(url, init),
    );
    const ctx = await scope.loadUserContext({ tenantCustomerId: 'c1' });
    expect(relCalls()).toEqual([]);
    // names + dbb_assign of assets and devices; no tops query
    expect(tb.calls.filter((c) => c === 'POST /api/entitiesQuery/find').length).toBe(2);
    expect(ctx.rootIds).toEqual([ROOT]);
    expect(ids(ctx).length).toBe(6);
    expect(ctx.nodes.has(OTHER)).toBe(false);
  });

  it('a failed tops query falls back to the walk up from each asset', async () => {
    tb.failNext = { match: /entitiesQuery/, status: 403 };
    const ctx = await scope.loadUserContext({ tenantCustomerId: 'c1' });
    expect([...ctx.rootIds].sort()).toEqual([ROOT, OTHER].sort());
    expect(ses.has('imex-tops:u-t')).toBe(false);
  });

  it('clearRelCache drops the tops copy too', async () => {
    await scope.loadUserContext({ tenantCustomerId: 'c1' });
    scope.clearRelCache('u-t');
    expect([...ses.keys()].filter((k) => k.startsWith('imex-tops:') || k.startsWith('imex-dbb-rel:'))).toEqual([]);
  });

  it('loadPerms: the role without the tree (tenant: one call; customer: user attributes and role store)', async () => {
    let p = await scope.loadPerms();
    expect([p.unrestricted, p.can('dashboards.build')]).toEqual([true, true]);
    expect(tb.calls).toEqual(['GET /api/auth/user']);
    roleStore([builderRole({ 'dashboards.build': true })]);
    asGrantee(tb, 'u-b', [{ id: 'pun' }], 'r_build1');
    tb.calls = [];
    p = await scope.loadPerms();
    expect([p.roleName, p.can('dashboards.build'), p.can('dashboards.applyMany')]).toEqual(['Line builder', true, false]);
    expect(relCalls()).toEqual([]);
    asGrantee(tb, 'u-v', [{ id: 'pun' }], 'viewer');
    ses.clear();
    expect((await scope.loadPerms()).can('dashboards.build')).toBe(false);
  });
});

describe("the page context follows the app's copies (entries/common.ts slotStale)", () => {
  const sig = { access: `${PUN}`, rolesRev: 3, unrestricted: false, userId: 'u1', customerId: 'c1' };
  it("another grant list or role store revision in the app's fresh copies makes the context stale", () => {
    expect(slotStale(sig)).toBe(false);
    ses.set('imex-access:u1', JSON.stringify({ at: Date.now(), sig: PUN, ids: [PUN] }));
    ses.set('imex-roles:c1', JSON.stringify({ at: Date.now(), raw: { v: 1, rev: 3, roles: [] } }));
    expect(slotStale(sig)).toBe(false);
    ses.set('imex-access:u1', JSON.stringify({ at: Date.now(), sig: `${PUN},${RIC}`, ids: [] }));
    expect(slotStale(sig)).toBe(true);
    ses.set('imex-access:u1', JSON.stringify({ at: Date.now(), sig: PUN, ids: [] }));
    ses.set('imex-roles:c1', JSON.stringify({ at: Date.now() + 1, raw: JSON.stringify({ v: 1, rev: 4, roles: [] }) }));
    expect(slotStale(sig)).toBe(true);
  });
  it('old copies, a tenant admin or no context yet never make it stale', () => {
    ses.set('imex-access:u1', JSON.stringify({ at: Date.now() - 121e3, sig: 'other' }));
    ses.set('imex-roles:c1', JSON.stringify({ at: Date.now() - 121e3, raw: { v: 1, rev: 9, roles: [] } }));
    expect(slotStale(sig)).toBe(false);
    ses.set('imex-access:u1', JSON.stringify({ at: Date.now(), sig: 'other' }));
    expect(slotStale({ ...sig, unrestricted: true })).toBe(false);
    expect(slotStale(undefined)).toBe(false);
  });
});
