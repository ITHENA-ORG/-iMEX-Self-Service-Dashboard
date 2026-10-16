// D-065: "All <type> machines you manage" (a user whose access does not cover the whole organisation) is resolved by
// type at view time: a location assignment on every location the user holds in full, a device assignment only on the
// machines granted one by one. It was a fixed list of machines, so a machine added later got no machine page.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeTB, ithena, asGrantee, PUN, RIC } from './fake-tb';
import * as scope from '../src/core/scope';
import * as store from '../src/core/store';
import { Dashboard } from '../src/core/schema';

// a machine granted alone needs a real (uuid) id
const RC2 = 'd0000000-0000-4000-8000-000000000001';
let tb: FakeTB;
const mem = new Map<string, string>();
beforeEach(() => {
  tb = ithena();
  tb.add({ id: RC2, entityType: 'DEVICE', name: 'RIC-COMP-02', label: 'Richmond Compressor 2', type: 'Compressor' }, 'ric');
  mem.clear();
  mem.set('jwt_token', 'x');
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
});
const widget = { id: 'w1', type: 'value', title: 'P', x: 0, y: 0, w: 3, h: 2, binding: { mode: 'current' }, keys: ['dischargePressure'], settings: {} };
const mk = (ctx: scope.UserContext, name: string, profile = 'Compressor'): Dashboard => ({ ...store.blankDashboard(ctx, name, profile), widgets: [widget as any] });
// an Admin who holds Pune in full and Richmond Compressor 2 alone
async function siteAdmin() {
  asGrantee(tb, 'u-site', [{ id: 'pun' }, { id: RC2, type: 'DEVICE' }], 'admin');
  return scope.loadUserContext();
}

describe('D-065 managed plan and apply', () => {
  it('the plan: the location held in full, the machine granted alone, every machine of the type', async () => {
    const ctx = await siteAdmin();
    expect(ctx.coversAll).toBe(false);
    const plan = store.managedPlan(ctx, 'Compressor');
    expect(plan.nodes.map((n) => n.id)).toEqual([PUN]);
    expect(plan.devices.map((d) => d.id)).toEqual([RC2]);
    expect(plan.all.map((d) => d.id).sort()).toEqual([RC2, 'pc']);
    expect(store.canApply(ctx, { type: 'managed', profile: 'Compressor' })).toBeNull();
    expect(store.canApply(ctx, { type: 'managed', profile: 'Blower' })).toMatch(/no machines/);
  });

  it('apply: Pune gets a location assignment (a compressor added there later follows), Richmond 2 a device one', async () => {
    const ctx = await siteAdmin();
    const t = await store.saveDashboard(ctx, mk(ctx, 'Compressor page'));
    const ids = await store.apply(ctx, t, { type: 'managed', profile: 'Compressor' });
    expect(ids.sort()).toEqual([RC2, 'pc']);
    expect(tb.getAttrs('ASSET', PUN)['dbb_assign']?.Compressor?.dashboardId).toBe(t.id);
    expect(tb.getAttrs('DEVICE', 'pc')['dbb_assign']).toBeUndefined(); // no fixed entry for a machine under Pune
    expect(tb.getAttrs('DEVICE', RC2)['dbb_assign']).toMatchObject({ dashboardId: t.id, mode: 'linked' });
    expect(tb.getAttrs('ASSET', RIC)['dbb_assign']).toBeUndefined(); // Richmond is not the user's to assign
    let r = await store.resolveForDevice(ctx, 'pc', 'Compressor');
    expect([r.dashboard?.id, r.level]).toEqual([t.id, 'node']);
    r = await store.resolveForDevice(ctx, RC2, 'Compressor');
    expect([r.dashboard?.id, r.level]).toEqual([t.id, 'device']);
    // the bug: a compressor added to Pune after the apply had no page
    tb.add({ id: 'pc2', entityType: 'DEVICE', name: 'PUN-COMP-02', label: 'Pune Compressor 2', type: 'Compressor' }, 'pun');
    const later = await scope.loadUserContext();
    r = await store.resolveForDevice(later, 'pc2', 'Compressor');
    expect([r.dashboard?.id, r.level]).toEqual([t.id, 'node']);
    // other machine types under Pune are not touched
    expect((await store.resolveForDevice(later, 'pw', 'Weather Station')).level).toBe('default');
  });

  it('a location held in full with no machine of the type yet still gets the assignment (the first one follows)', async () => {
    asGrantee(tb, 'u-site', [{ id: 'pun' }], 'admin');
    const ctx = await scope.loadUserContext();
    const d = await store.saveDashboard(ctx, mk(ctx, 'Dryer page', 'Weather Station'));
    await store.apply(ctx, d, { type: 'managed', profile: 'Weather Station' });
    expect(tb.getAttrs('ASSET', PUN)['dbb_assign']?.['Weather Station']?.dashboardId).toBe(d.id);
  });

  it('preview: a machine with its own dashboard keeps it, an existing location assignment asks to be replaced', async () => {
    const ctx = await siteAdmin();
    const a = await store.saveDashboard(ctx, mk(ctx, 'A'));
    const b = await store.saveDashboard(ctx, mk(ctx, 'B'));
    const own = await store.saveDashboard(ctx, mk(ctx, 'own'));
    await store.apply(ctx, b, { type: 'node', nodeId: PUN, profile: 'Compressor' });
    await store.apply(ctx, own, { type: 'devices', deviceIds: ['pc'], mode: 'linked' });
    const pv = await store.previewApply(ctx, a, { type: 'managed', profile: 'Compressor' });
    expect(pv.errors).toEqual([]);
    expect(pv.affected.map((x) => x.id).sort()).toEqual([RC2, 'pc']);
    expect(pv.replacesAssignment?.name).toBe('B');
    expect(pv.keepOwn.map((x) => x.id)).toEqual(['pc']);
    expect(pv.replaced.map((x) => x.id)).toEqual([]);
  });

  it('a role without dashboards.applyMany cannot use it', async () => {
    asGrantee(tb, 'u-v', [{ id: 'pun' }], 'viewer');
    const ctx = await scope.loadUserContext();
    expect(store.canApply(ctx, { type: 'managed', profile: 'Compressor' })).toMatch(/role/i);
  });
});
