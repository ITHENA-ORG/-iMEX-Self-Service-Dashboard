// 9 Oct 2026: properties from the keys the machines send (the catalogue is an overlay), and a machine added after
// the scope was cached is not refused.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeTB, ithena, asUser } from './fake-tb';
import * as scope from '../src/core/scope';
import { buildCatalog } from '../src/core/chat';
import { defaultWidgets } from '../src/render/widgets';
import { userContextFor } from '../src/entries/common';

/** sessionStorage stand-in with the parts clearRelCache uses. */
class Mem {
  m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key = (i: number) => [...this.m.keys()][i] ?? null;
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}

let tb: FakeTB;
let ses: Mem;
const mem = new Map<string, string>();
const ts = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, [{ ts: Date.now(), value: 1 }]]));
const keyCalls = () => tb.calls.filter((c) => c.endsWith('/keys/timeseries')).length;
async function ctxFor(role = 'Admin', nodes = ['root'], id = `u-${role}`) {
  asUser(tb, id, role, nodes);
  return scope.loadUserContext();
}

beforeEach(() => {
  tb = ithena();
  ses = new Mem();
  mem.clear();
  mem.set('jwt_token', 'x');
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
  vi.stubGlobal('sessionStorage', ses);
  // pc sends keys the catalogue does not have, an AI output and a pre-aggregated copy; one has a telemetryKeys name
  tb.telemetry.set('pc', ts(['dischargePressure', 'runStatus', 'oil_temp', 'Airflow_Rate', 'aiml_score', 'powerKw_5min', 'motorCurrent_1day']));
  tb.setAttrs('DEVICE', 'pc', { telemetryKeys: JSON.stringify([{ kpi: 'Airflow_Rate', label: 'Airflow Rate (CFM)' }]) });
});

describe('live property keys (catalogue as an overlay)', () => {
  it('offers the union of the machines\' keys with the catalogue\'s names first; AI and aggregate keys are left out', async () => {
    const ctx = await ctxFor();
    expect(ctx.profileKeys.Compressor.map((k) => k.key)).toEqual(['dischargePressure', 'dischargeTemp', 'powerKw', 'runStatus']);
    await scope.liveKeys(ctx);
    const c = ctx.profileKeys.Compressor;
    expect(c.map((k) => k.key)).toEqual(['dischargePressure', 'dischargeTemp', 'powerKw', 'runStatus', 'Airflow_Rate', 'oil_temp']);
    expect(c[0]).toMatchObject({ displayName: 'Discharge pressure', unit: 'bar', decimals: 2, max: 10 });
    expect(c.find((k) => k.key === 'Airflow_Rate')).toMatchObject({ displayName: 'Airflow Rate', unit: 'CFM' });
    expect(c.find((k) => k.key === 'oil_temp')).toMatchObject({ displayName: 'Oil temp', unit: '' });
    // the stored catalogue is untouched
    expect(ctx.catalogue.Compressor.length).toBe(4);
    // the default machine page and the chat context see them too
    expect(defaultWidgets(ctx, 'Compressor').some((w) => w.keys[0] === 'oil_temp')).toBe(true);
    expect(buildCatalog(ctx).profiles.Compressor.map((k) => k.key)).toContain('Airflow_Rate');
  });

  it('a machine type the catalogue does not know gets its properties from its machines', async () => {
    tb.add({ id: 'pb', entityType: 'DEVICE', name: 'PUN-BLW-01', label: 'Pune Blower 1', type: 'Blower' }, 'pun');
    tb.telemetry.set('pb', ts(['motorSpeed', 'aiml_forecast']));
    const ctx = await ctxFor();
    expect(ctx.profileKeys.Blower).toBeUndefined();
    await scope.liveKeys(ctx, ['Blower']);
    expect(ctx.profileKeys.Blower).toEqual([{ key: 'motorSpeed', displayName: 'Motor Speed', unit: '', decimals: 1, min: 0, max: 100 }]);
    expect(keyCalls()).toBe(1); // only the type asked for
  });

  it('queries at most LIVE_KEYS_MAX_DEVICES machines per type, once per context, and keeps the answer for the session', async () => {
    for (let i = 0; i < 30; i++) tb.add({ id: `x${i}`, entityType: 'DEVICE', name: `X-COMP-${i}`, type: 'Compressor' }, 'pun');
    const ctx = await ctxFor();
    tb.calls = [];
    await Promise.all([scope.liveKeys(ctx, ['Compressor']), scope.liveKeys(ctx, ['Compressor'])]);
    expect(keyCalls()).toBe(scope.LIVE_KEYS_MAX_DEVICES);
    expect(tb.calls.filter((c) => c === 'POST /api/entitiesQuery/find').length).toBe(1);
    tb.calls = [];
    await scope.liveKeys(ctx, ['Compressor']);
    const again = await ctxFor();
    await scope.liveKeys(again, ['Compressor']);
    expect(keyCalls()).toBe(0);
    expect(again.profileKeys.Compressor.map((k) => k.key)).toContain('oil_temp');
    // an old entry is asked again
    for (const [k, v] of ses.m) if (k.startsWith('imex-dbb-keys:')) ses.m.set(k, JSON.stringify({ ...JSON.parse(v), at: Date.now() - scope.LIVE_KEYS_CACHE_MS - 1 }));
    tb.calls = [];
    await scope.liveKeys(await ctxFor(), ['Compressor']);
    expect(keyCalls()).toBe(scope.LIVE_KEYS_MAX_DEVICES);
  });

  it('a failed read keeps the catalogue and is not cached', async () => {
    const ctx = await ctxFor();
    tb.failNext = { match: /keys\/timeseries$/, status: 403 };
    await scope.liveKeys(ctx, ['Compressor']);
    expect([...ses.m.keys()].some((k) => k.startsWith('imex-dbb-keys:'))).toBe(false);
    expect(ctx.profileKeys.Compressor.slice(0, 4)).toEqual(ctx.catalogue.Compressor);
  });

  it('mergeKeys and readableKey', () => {
    expect(scope.readableKey('dischargePressure')).toBe('Discharge Pressure');
    expect(scope.readableKey('oil_temp')).toBe('Oil temp');
    // D-064: no unit is guessed from a key's suffix (units come from the machine model / the catalogue)
    expect(scope.guessKey('line_pressure_bar')).toEqual({ name: 'Line pressure bar', unit: '' });
    expect(scope.guessKey('motor_temp_f')).toEqual({ name: 'Motor temp f', unit: '' });
    expect(scope.guessKey('phase_a')).toEqual({ name: 'Phase a', unit: '' });
    expect(scope.guessKey('Machine_Status_1')).toEqual({ name: 'Machine Status 1', unit: '' });
    const named = new Map([['b', { label: 'Bee', unit: 'u' }]]);
    expect(scope.mergeKeys([], ['c', 'b', 'a', 'x_30min', 'y_2hrs', 'aiml_z'], named).map((k) => k.key)).toEqual(['b', 'a', 'c']);
  });
});

describe('a machine added after the scope was cached', () => {
  it('is found after one forced reload with the cached relations dropped', async () => {
    vi.stubGlobal('window', { dispatchEvent: () => true });
    asUser(tb, 'u-Admin', 'Admin', ['root']);
    const tbCtx = { settings: {} };
    const first = await userContextFor(tbCtx, 'rc');
    expect(first.nodes.has('new')).toBe(false);
    tb.add({ id: 'new', entityType: 'DEVICE', name: 'PUN-COMP-09', label: 'Pune Compressor 9', type: 'Compressor' }, 'pun');
    // the cached relations alone would still miss it
    expect((await scope.loadUserContext()).nodes.has('new')).toBe(false);
    tb.calls = [];
    const ctx = await userContextFor(tbCtx, 'new');
    expect(ctx.nodes.has('new')).toBe(true);
    expect(tb.calls.filter((c) => c === 'POST /api/relations').length).toBe(2);
    // a machine that really is outside the scope costs one reload per minute, not one per page
    await userContextFor(tbCtx, 'nowhere');
    tb.calls = [];
    const again = await userContextFor(tbCtx, 'nowhere');
    expect(again.nodes.has('nowhere')).toBe(false);
    expect(tb.calls.length).toBe(0);
  });
});
