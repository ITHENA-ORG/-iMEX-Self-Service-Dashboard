// D-080 (code review, 10 Nov 2026): long key lists, one reload of the assignments, key-list failures in the preview,
// live subscriptions after a page is left, live history by age, audit entries that stay JSON, alarm counts over 1000.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeTB, ithena, asUser } from './fake-tb';
import * as api from '../src/core/api';
import * as scope from '../src/core/scope';
import * as store from '../src/core/store';
import { auditEntry } from '../src/core/audit';
import { Live, WsLike } from '../src/core/live';

let tb: FakeTB;
const mem = new Map<string, string>();
beforeEach(() => {
  tb = ithena();
  mem.clear();
  mem.set('jwt_token', 'x');
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
});
afterEach(() => vi.unstubAllGlobals());

async function admin() {
  asUser(tb, 'u-admin', 'Admin', ['root']);
  return scope.loadUserContext();
}
const widget = { id: 'w1', type: 'value', title: 'P', x: 0, y: 0, w: 3, h: 2, binding: { mode: 'current' }, keys: ['dischargePressure'], settings: {} };

describe('key lists that do not fit in one URL', () => {
  const keys = Array.from({ length: 900 }, (_, i) => `dbb_d_dmh2x7k9q${i}`);

  it('keyChunks keeps every key and every part short enough', () => {
    const parts = api.keyChunks(keys);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flat()).toEqual(keys);
    for (const p of parts) expect(encodeURIComponent(p.join(',')).length).toBeLessThanOrEqual(api.MAX_KEYS_CHARS);
    expect(api.keyChunks([])).toEqual([]);
  });

  it('getAttrs reads them all, in short requests; a short list stays one request', async () => {
    tb.setAttrs('ASSET', 'store', Object.fromEntries(keys.map((k) => [k, { v: k }])));
    tb.urls = [];
    const got = await api.getAttrs({ id: 'store', entityType: 'ASSET' }, keys);
    expect(Object.keys(got)).toHaveLength(900);
    expect(got[keys[899]]).toEqual({ v: keys[899] });
    expect(tb.urls.length).toBeGreaterThan(1);
    for (const u of tb.urls) expect(u.length).toBeLessThan(8000);
    tb.urls = [];
    await api.getAttrs({ id: 'store', entityType: 'ASSET' }, keys.slice(0, 5));
    expect(tb.urls).toHaveLength(1);
  });

  it('deleteAttrs removes them all, in short requests', async () => {
    tb.setAttrs('ASSET', 'store', Object.fromEntries(keys.map((k) => [k, 1])));
    tb.urls = [];
    await api.deleteAttrs({ id: 'store', entityType: 'ASSET' }, keys);
    expect(await api.getAttrs({ id: 'store', entityType: 'ASSET' }, keys)).toEqual({});
    for (const u of tb.urls) expect(u.length).toBeLessThan(8000);
  });
});

describe('resolving many machines at once', () => {
  it('an old assignment snapshot is reloaded once, not once per machine', async () => {
    const ctx = await admin();
    const doc = { ...store.blankDashboard(ctx, 'x', 'Compressor'), widgets: [widget as any] };
    ctx.assign!.stale = true;
    tb.calls = [];
    await store.usage(ctx, doc);
    // one reload is one query per entity type (assets + devices), for two Compressors
    expect(tb.calls.filter((c) => c === 'POST /api/entitiesQuery/find')).toHaveLength(2);
  });

  it('a key list that cannot be read does not report the keys as missing', async () => {
    const ctx = await admin();
    const doc = { ...store.blankDashboard(ctx, 'x', 'Compressor'), widgets: [widget as any] };
    const orig = tb.fetch;
    vi.stubGlobal('fetch', async (u: string, init: any) => (/keys\/timeseries/.test(u) ? new Response('{}', { status: 403 }) : orig(u, init)));
    const pv = await store.previewApply(ctx, doc, { type: 'devices', deviceIds: ['rc', 'pc'], mode: 'linked' });
    expect(pv.affected).toHaveLength(2);
    expect(pv.missingKeys).toEqual([]);
  });

  it('no widget needs the keys: no key lists are read', async () => {
    const ctx = await admin();
    const doc = { ...store.blankDashboard(ctx, 'x', 'Compressor'), widgets: [{ ...widget, binding: { mode: 'siblings', profile: 'Compressor' } } as any] };
    tb.calls = [];
    await store.previewApply(ctx, doc, { type: 'devices', deviceIds: ['rc', 'pc'], mode: 'linked' });
    expect(tb.calls.filter((c) => c.includes('keys/timeseries'))).toEqual([]);
  });
});

describe('active alarm counts', () => {
  it('counts every page (more than 1000 active alarms)', async () => {
    const orig = tb.fetch;
    let page = 0;
    vi.stubGlobal('fetch', async (u: string, init: any) => {
      if (!/alarmsQuery/.test(u)) return orig(u, init);
      page = JSON.parse(init.body).pageLink.page;
      const data = Array.from({ length: page === 0 ? 1000 : 3 }, () => ({ originator: { id: 'rc', entityType: 'DEVICE' }, type: 'T' }));
      return new Response(JSON.stringify({ data, hasNext: page === 0 }), { status: 200 });
    });
    const m = await api.activeAlarmCounts(['rc']);
    expect(page).toBe(1);
    expect(m.get('rc')).toBe(1003);
  });
});

describe('audit entries', () => {
  const who = { email: 'a@x', userId: 'u', role: 'Admin' };
  it('stay valid JSON when the detail is very long', () => {
    const s = auditEntry(who, 'dashboard.apply', { id: 'd1', target: { deviceIds: Array.from({ length: 2000 }, (_, i) => `id"${i}`) } });
    expect(s.length).toBeLessThanOrEqual(8000);
    const e = JSON.parse(s);
    expect(e).toMatchObject({ user: 'a@x', action: 'dashboard.apply', truncated: true });
    expect(e.detail).toContain('d1');
  });
  it('a short one is unchanged', () => {
    expect(JSON.parse(auditEntry(who, 'dashboard.save', { id: 'd1' }))).toEqual({ user: 'a@x', userId: 'u', role: 'Admin', action: 'dashboard.save', id: 'd1' });
  });
});

describe('the live hub after a page is left', () => {
  class FakeWs implements WsLike {
    readyState = 0;
    sent: any[] = [];
    closed = false;
    onopen: any = null;
    onmessage: any = null;
    onclose: any = null;
    onerror: any = null;
    send(d: string) {
      this.sent.push(JSON.parse(d));
    }
    close() {
      this.closed = true;
    }
    reply(m: any) {
      this.onmessage?.({ data: JSON.stringify(m) });
    }
  }
  function setup() {
    const sockets: FakeWs[] = [];
    let now = 1_000_000;
    const live = new Live({
      host: 'tb.test',
      token: () => 'jwt',
      connect: () => {
        const w = new FakeWs();
        sockets.push(w);
        return w;
      },
      now: () => now,
      later: () => 0,
    });
    return { live, sockets, tick: (ms: number) => (now += ms) };
  }

  it('drops subscriptions nobody asked for lately and closes the socket when none is left', () => {
    const { live, sockets, tick } = setup();
    live.want('m1', ['p']);
    sockets[0].onopen({});
    const c = sockets[0].sent[0].cmds[0].cmdId;
    sockets[0].reply({ subscriptionId: c, data: { p: [[1, '1']] } });
    expect(live.isLive()).toBe(true);
    tick(4 * 60e3);
    sockets[0].reply({ subscriptionId: c, data: { p: [[2, '2']] } });
    expect(sockets[0].sent.at(-1).cmds[0]).toEqual({ type: 'TIMESERIES', cmdId: c, unsubscribe: true });
    expect(sockets[0].closed).toBe(true);
    expect(live.isLive()).toBe(false);
    // a later page opens it again
    live.want('m2', ['p']);
    expect(sockets).toHaveLength(2);
  });

  it('keeps subscriptions in use', () => {
    const { live, sockets, tick } = setup();
    live.want('m1', ['p']);
    sockets[0].onopen({});
    const c = sockets[0].sent[0].cmds[0].cmdId;
    for (let i = 1; i <= 6; i++) {
      tick(60e3);
      live.want('m1', ['p']);
      sockets[0].reply({ subscriptionId: c, data: { p: [[i, String(i)]] } });
    }
    expect(sockets[0].closed).toBe(false);
    expect(live.get('m1', ['p'])).toEqual({ p: { ts: 6, value: 6 } });
  });

  it('keeps live points by age, whatever the device clock says', () => {
    const { live, sockets, tick } = setup();
    live.want('m1', ['p']);
    sockets[0].onopen({});
    const c = sockets[0].sent[0].cmds[0].cmdId;
    const base = 5_000_000_000_000; // a device clock far from the page's
    for (let i = 0; i <= 60 * 6; i++) {
      tick(100); // keeps the sweep out of the way
      live.want('m1', ['p']);
      sockets[0].reply({ subscriptionId: c, data: { p: [[base + i * 10e3, '1']] } });
    }
    const pts = live.since('m1', 'p', 0)!;
    expect(pts[pts.length - 1].ts).toBe(base + 3600e3);
    expect(pts[0].ts).toBeGreaterThanOrEqual(base + 3600e3 - 21 * 60e3);
    expect(pts.length).toBeLessThanOrEqual(21 * 6 + 1);
    expect(pts.length).toBeGreaterThanOrEqual(20 * 6);
  });
});
