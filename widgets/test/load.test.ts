// D-022: first-load call counts and the assignment snapshot.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeTB, ithena, asUser, ROOT, PUN } from './fake-tb';
import * as scope from '../src/core/scope';
import * as store from '../src/core/store';
import * as api from '../src/core/api';

let tb: FakeTB;
const mem = new Map<string, string>();
beforeEach(() => {
  tb = ithena();
  mem.clear();
  mem.set('jwt_token', 'x');
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
});

const widget = { id: 'w1', type: 'value', title: 'P', x: 0, y: 0, w: 3, h: 2, binding: { mode: 'current' }, keys: ['dischargePressure'], settings: {} };
const mk = (ctx: scope.UserContext, name: string) => ({ ...store.blankDashboard(ctx, name, 'Compressor'), widgets: [widget as any] });
async function ctxFor(role: string, nodes: string[], id = `u-${role}`) {
  asUser(tb, id, role, nodes);
  return scope.loadUserContext();
}

/** Adds `sites` sites with `per` compressors each under root. */
function grow(sites: number, per: number) {
  for (let s = 0; s < sites; s++) {
    tb.add({ id: `s${s}`, entityType: 'ASSET', name: `SITE-${s}`, label: `Site ${s}`, type: 'Site' }, 'root');
    for (let d = 0; d < per; d++) tb.add({ id: `s${s}d${d}`, entityType: 'DEVICE', name: `S${s}-COMP-${d}`, type: 'Compressor' }, `s${s}`);
  }
}

describe('first load (D-022)', () => {
  it('user context costs 9 calls whatever the size of the tree (D-050: + the role store; D-064: + the machine model, read once a minute)', async () => {
    await ctxFor('Admin', ['root']);
    const small = tb.calls.length;
    grow(30, 10);
    tb.calls = [];
    const ctx = await ctxFor('Admin', ['root']);
    expect(scope.allDevices(ctx).length).toBe(4 + 300);
    expect(small).toBe(10); // D-064: the first load also reads the machine model (kept a minute)
    expect(tb.calls.length).toBe(9);
    expect(tb.calls.filter((c) => c === 'GET /api/relations/info')).toEqual([]);
  });

  it('resolving a machine right after loading is one call; nothing assigned means the default layout', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    tb.calls = [];
    const r = await store.resolveForDevice(ctx, 'rc', 'Compressor');
    expect(r.level).toBe('default');
    expect(tb.calls).toEqual(['GET /api/plugins/telemetry/ASSET/store/values/attributes/SERVER_SCOPE']);
  });

  it('a location assignment ABOVE the user scope still applies (ancestors loaded with the context)', async () => {
    const admin = await ctxFor('Admin', ['root']);
    const org = await store.saveDashboard(admin, mk(admin, 'org'));
    await store.apply(admin, org, { type: 'node', nodeId: ROOT, profile: 'Compressor' });
    const viewer = await ctxFor('Viewer', ['pun'], 'u-v');
    expect(viewer.coversAll).toBe(false);
    // D-050: the organisation above the Pune grant is a nav node of the tree (the path), nothing is above it
    expect(viewer.rootIds).toEqual([ROOT]);
    expect(viewer.nodes.get(ROOT)!.nav).toBe(true);
    expect(viewer.nodes.get(ROOT)!.children).toEqual([PUN]);
    expect(viewer.assign!.aboveRoot.get(ROOT)).toEqual([]);
    tb.calls = [];
    const r = await store.resolveForDevice(viewer, 'pc', 'Compressor');
    expect(r.dashboard?.name).toBe('org');
    expect(r.sourceLabel).toBe('All Compressor machines in ITHENA');
    expect(tb.calls.length).toBe(1);
  });

  it('an assignment made on another page is picked up through dbb_assign_rev', async () => {
    const viewer = await ctxFor('Viewer', ['pun'], 'u-v');
    const admin = await ctxFor('Admin', ['root']);
    expect((await store.resolveForDevice(viewer, 'pc', 'Compressor')).level).toBe('default');
    const site = await store.saveDashboard(admin, mk(admin, 'site'));
    await store.apply(admin, site, { type: 'node', nodeId: PUN, profile: 'Compressor' });
    tb.calls = [];
    const r = await store.resolveForDevice(viewer, 'pc', 'Compressor');
    expect(r.dashboard?.name).toBe('site');
    // store read (rev changed) + snapshot reload (2 entity queries + user attrs) + the new dashboard
    expect(tb.calls.length).toBe(5);
    tb.calls = [];
    await store.resolveForDevice(viewer, 'pc', 'Compressor');
    expect(tb.calls.length).toBe(1);
  });
});

describe('bulk reads (D-022)', () => {
  it('latestMany reads every machine in one entity query; activeAlarmCounts in one alarm query', async () => {
    tb.alarms = [
      { originator: 'rc', type: 'High' },
      { originator: 'rc', type: 'Low' },
      { originator: 'pw', type: 'Temp' },
    ];
    tb.calls = [];
    const lv = await api.latestMany([
      { deviceId: 'rc', keys: ['dischargePressure', 'runStatus'] },
      { deviceId: 'pc', keys: ['runStatus', 'powerKw'] },
      { deviceId: 'pw', keys: ['temperature'] },
    ]);
    expect(Object.keys(lv.get('rc')!).sort()).toEqual(['dischargePressure', 'runStatus']);
    expect(Object.keys(lv.get('pc')!)).toEqual(['runStatus']); // no powerKw on pc
    expect(lv.get('pw')!.temperature!.value).toBe(1);
    const al = await api.activeAlarmCounts(['rc', 'pc', 'pw']);
    expect([al.get('rc'), al.get('pc'), al.get('pw')]).toEqual([2, undefined, 1]);
    expect(tb.calls).toEqual(['POST /api/entitiesQuery/find', 'POST /api/alarmsQuery/find']);
  });
});

describe('scope relations kept for the browser session (D-037)', () => {
  const rel = () => tb.calls.filter((c) => c === 'POST /api/relations').length;
  it('a second page load in the same session makes no relation calls; another user, an old entry or a failed call does', async () => {
    const ses = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => ses.get(k) ?? null, setItem: (k: string, v: string) => ses.set(k, v) });
    const first = await ctxFor('Admin', ['root']);
    expect(rel()).toBe(2);
    tb.calls = [];
    const second = await ctxFor('Admin', ['root']);
    expect(rel()).toBe(0);
    expect(scope.allDevices(second).map((d) => d.id).sort()).toEqual(scope.allDevices(first).map((d) => d.id).sort());

    // another user does not get the first user's tree
    tb.calls = [];
    await ctxFor('Viewer', ['root'], 'u-other');
    expect(rel()).toBe(2);

    // an entry older than the limit is not used
    for (const [k, v] of ses) ses.set(k, JSON.stringify({ ...JSON.parse(v), at: Date.now() - scope.REL_CACHE_MS - 1 }));
    tb.calls = [];
    await ctxFor('Admin', ['root']);
    expect(rel()).toBe(2);
    vi.unstubAllGlobals();
  });
});
