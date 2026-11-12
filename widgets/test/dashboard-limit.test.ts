// D-086 (Control Centre CC-034): the licensed number of dashboards on an installation (limits.maxDashboards).
// A NEW dashboard (New, Save as, a per-machine copy, the assistant's new dashboard) is refused at the limit with one
// message; editing and viewing existing ones always work; deleting frees a slot. Every saved dashboard counts
// (shared, private, per-machine copies). Limit 0 = none can be created; no limit = nothing is read.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeTB, ithena, asUser } from './fake-tb';
import * as scope from '../src/core/scope';
import * as store from '../src/core/store';
import * as lic from '../src/core/licence';
import { Dashboard } from '../src/core/schema';

let tb: FakeTB;
const mem = new Map<string, string>();
const widget = () => ({ id: 'w1', type: 'value', title: 'P', x: 0, y: 0, w: 3, h: 2, binding: { mode: 'current' }, keys: ['dischargePressure'], settings: {} });
const mk = (ctx: scope.UserContext, name: string, profile: string | null = 'Compressor'): Dashboard => ({ ...store.blankDashboard(ctx, name, profile), widgets: [widget() as any] });

function licence(limits: Record<string, unknown> | null, where: 'limits' | 'payload' = 'limits') {
  const w: any = new EventTarget();
  if (limits) w.__imexLicence = where === 'limits' ? { status: { mode: 'active' }, has: () => true, limits } : { status: { mode: 'active', payload: { limits } }, has: () => true };
  vi.stubGlobal('window', w);
}
async function ctxFor(role: string, nodes: string[]) {
  asUser(tb, `u-${role}`, role, nodes);
  return scope.loadUserContext();
}
const keysReads = () => tb.urls.filter((u) => /\/keys\/attributes\/SERVER_SCOPE/.test(u)).length;

beforeEach(() => {
  tb = ithena();
  mem.clear();
  mem.set('jwt_token', 'x');
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
  licence(null);
});
afterEach(() => vi.unstubAllGlobals());

describe('dashboardLimit (core/licence.ts)', () => {
  it('a whole number 0 or more; absent, blank, negative, boolean or text = no limit; floors; reads status.payload.limits too', () => {
    expect(lic.dashboardLimit(null)).toBeNull();
    expect(lic.dashboardLimit({ limits: {} })).toBeNull();
    expect(lic.dashboardLimit({ limits: { maxDashboards: 20 } })).toBe(20);
    expect(lic.dashboardLimit({ limits: { maxDashboards: 0 } })).toBe(0);
    expect(lic.dashboardLimit({ limits: { maxDashboards: '3' } })).toBe(3);
    expect(lic.dashboardLimit({ limits: { maxDashboards: 5.7 } })).toBe(5);
    expect(lic.dashboardLimit({ limits: { maxDashboards: -1 } })).toBeNull();
    expect(lic.dashboardLimit({ limits: { maxDashboards: '' } })).toBeNull();
    expect(lic.dashboardLimit({ limits: { maxDashboards: null } })).toBeNull();
    expect(lic.dashboardLimit({ limits: { maxDashboards: true } })).toBeNull();
    expect(lic.dashboardLimit({ limits: { maxDashboards: 'many' } })).toBeNull();
    expect(lic.dashboardLimit({ status: { mode: 'active', payload: { limits: { maxDashboards: 7 } } } })).toBe(7);
    licence({ maxDashboards: 4 });
    expect(lic.dashboardLimit()).toBe(4);
    licence({ maxDashboards: 9 }, 'payload');
    expect(lic.dashboardLimit()).toBe(9);
  });
  it('the message names the limit and how dashboards count; limit 0 says the saved ones stay', () => {
    expect(lic.dashboardLimitMessage(10)).toBe('This installation has reached its 10 licensed dashboards (every saved dashboard counts, including private ones and per-machine copies). Delete one or ask for a larger licence.');
    expect(lic.dashboardLimitMessage(0)).toMatch(/allows no new dashboards.*saved ones can still be viewed and edited/);
    expect(lic.dashboardLimitMessage(10, 8, 3)).toMatch(/8 of its 10 licensed dashboards; 3 per-machine copies would go over the limit/);
  });
});

describe('the store refuses a new dashboard at the limit (D-086)', () => {
  it('no limit: nothing is read for the check, any number saves', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const before = keysReads();
    for (let i = 0; i < 4; i++) await store.saveDashboard(ctx, mk(ctx, `d${i}`));
    expect(keysReads()).toBe(before);
    expect(await store.countDashboards(ctx)).toBe(4);
    expect(await store.dashboardRoom(ctx)).toBeNull();
  });
  it('limit 2: the third is refused with the message, editing goes on, deleting frees the slot', async () => {
    licence({ maxDashboards: 2 });
    const ctx = await ctxFor('Admin', ['root']);
    const a = await store.saveDashboard(ctx, mk(ctx, 'A'));
    const b = await store.saveDashboard(ctx, mk(ctx, 'B'));
    const refused = store.saveDashboard(ctx, mk(ctx, 'C'));
    await expect(refused).rejects.toBeInstanceOf(store.DashboardLimitError);
    await expect(refused).rejects.toThrow('This installation has reached its 2 licensed dashboards (every saved dashboard counts, including private ones and per-machine copies). Delete one or ask for a larger licence.');
    expect(Object.keys(tb.getAttrs('ASSET', 'store', 'SERVER_SCOPE')).filter((k) => k.startsWith('dbb_d_')).length).toBe(2);
    // editing an existing dashboard never needs a slot (and reads no key list)
    const before = keysReads();
    const a2 = await store.saveDashboard(ctx, { ...a, name: 'A2' });
    expect(a2.version).toBe(2);
    expect(keysReads()).toBe(before);
    expect((await store.restoreVersion(ctx, a.id, 1)).name).toBe('A');
    // a private one counts too
    expect((await store.dashboardRoom(ctx))?.count).toBe(2);
    await store.deleteDashboard(ctx, b);
    expect(await store.dashboardRoom(ctx)).toBeNull();
    const c = await store.saveDashboard(ctx, mk(ctx, 'C'), 'private');
    expect(c.version).toBe(1);
    expect((await store.dashboardRoom(ctx))?.limit).toBe(2);
  });
  it('limit 0: no new dashboard, nothing is read; the saved ones are still edited', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const a = await store.saveDashboard(ctx, mk(ctx, 'A'));
    licence({ maxDashboards: 0 });
    const before = keysReads();
    const room = await store.dashboardRoom(ctx);
    expect(room?.message).toMatch(/allows no new dashboards/);
    expect(keysReads()).toBe(before);
    await expect(store.saveDashboard(ctx, mk(ctx, 'B'))).rejects.toThrow(/allows no new dashboards/);
    expect((await store.saveDashboard(ctx, { ...a, name: 'A2' })).name).toBe('A2');
    expect((await store.listDashboards(ctx)).map((d) => d.name)).toEqual(['A2']);
  });
  it('a per-machine copy (customise) needs a slot; the licence changing while the page is open is read at once', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const t = await store.saveDashboard(ctx, mk(ctx, 'template'));
    await store.apply(ctx, t, { type: 'customer', profile: 'Compressor' });
    licence({ maxDashboards: 1 });
    await expect(store.customise(ctx, 'pc', t)).rejects.toBeInstanceOf(store.DashboardLimitError);
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).dashboard?.id).toBe(t.id);
    licence({ maxDashboards: 2 });
    const copy = await store.customise(ctx, 'pc', t);
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).dashboard?.id).toBe(copy.id);
    expect((await store.dashboardRoom(ctx))?.count).toBe(2);
    // reset deletes the copy: the slot is free again
    await store.resetDevice(ctx, 'pc');
    expect(await store.dashboardRoom(ctx)).toBeNull();
  });
  it('apply as copies: all copies must fit before anything is written; a conflict message names the shortfall', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const t = await store.saveDashboard(ctx, mk(ctx, 'base'));
    licence({ maxDashboards: 2 });
    const writesBefore = tb.calls.length;
    const refused = store.apply(ctx, t, { type: 'devices', deviceIds: ['pc', 'rc'], mode: 'copy' });
    await expect(refused).rejects.toBeInstanceOf(store.DashboardLimitError);
    await expect(refused).rejects.toThrow(/has 1 of its 2 licensed dashboards; 2 per-machine copies would go over the limit/);
    expect(tb.calls.slice(writesBefore).filter((c) => /^(POST|DELETE)/.test(c) && /dbb_assign|SERVER_SCOPE$/.test(c)).length).toBe(0);
    expect(await store.countDashboards(ctx)).toBe(1);
    licence({ maxDashboards: 3 });
    await store.apply(ctx, t, { type: 'devices', deviceIds: ['pc', 'rc'], mode: 'copy' });
    expect(await store.countDashboards(ctx)).toBe(3);
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).dashboard?.copiedFrom).toBe(t.id);
    // linked applies create nothing and are never refused
    licence({ maxDashboards: 1 });
    await store.apply(ctx, t, { type: 'customer', profile: 'Compressor' });
  });
});
