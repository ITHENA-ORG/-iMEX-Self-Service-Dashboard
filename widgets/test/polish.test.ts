// Tests for the 9 Oct 2026 polish (D-043 to D-047): the kit adapter (render/kit.ts), toasts through the app,
// the short dashboard-list cache, the chat reply over a subscription, and the shift time ranges (core/shifts.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeTB, ithena, asUser } from './fake-tb';
import * as api from '../src/core/api';
import * as scope from '../src/core/scope';
import * as store from '../src/core/store';
import * as chat from '../src/core/chat';
import { calendarFor, chainFor, clearShiftCache } from '../src/core/shifts';
import { template } from '../src/core/shiftcal';
import { normalizeRange, rangeLabel, rangeWindow, rangeMs, isShiftRange, Dashboard } from '../src/core/schema';
import { progressBar, cardSkeleton, kitToast, kitConfirm, ensureKitCss, skeletonRows } from '../src/render/kit';
import { KIT_VERSION } from '../src/render/kit-css';
import { toast } from '../src/builder/ui';
import { registerLiveProvider } from '../src/core/tb-socket';

let tb: FakeTB;
const mem = new Map<string, string>();
beforeEach(() => {
  tb = ithena();
  mem.clear();
  mem.set('jwt_token', 'x');
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
  api.clearCaches();
  clearShiftCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const H = 3600e3;
const shifts = (key: string, extra: any = {}) => ({ v: 1, versions: [{ id: 'v1', from: null, shifts: template(key), ...extra }] });

describe('time ranges from the shift calendar (D-047)', () => {
  it('the shift ranges are stored as they are and get their own labels', () => {
    expect(normalizeRange('shift')).toBe('shift');
    expect(normalizeRange('prevshift')).toBe('prevshift');
    expect(normalizeRange('24h')).toBe('8h');
    expect([rangeLabel('shift'), rangeLabel('prevshift'), rangeLabel('4h')]).toEqual(['Current shift', 'Previous shift', 'Last 4 h']);
    expect(isShiftRange('shift') && isShiftRange('prevshift') && !isShiftRange('8h')).toBe(true);
    expect(rangeMs('shift')).toBe(8 * H);
    const d = Dashboard.parse({ schemaVersion: 1, id: 'd1', name: 'x', kind: 'standalone', profile: null, timeRange: 'prevshift', widgets: [], ownerId: 'u', ownerName: 'U', version: 1, updatedAt: 1, updatedBy: 'U' });
    expect(d.timeRange).toBe('prevshift');
  });

  it('rangeWindow: fixed ranges end now; shift = current start to now; between shifts = the previous one; prevshift = the last ended', () => {
    const now = Date.UTC(2026, 9, 9, 10, 0); // 10:00 UTC
    expect(rangeWindow('2h', null, now)).toEqual({ startTs: now - 2 * H, endTs: now });
    const cal = {
      current: (t: number) => (t >= Date.UTC(2026, 9, 9, 6) && t < Date.UTC(2026, 9, 9, 14) ? { name: 'Morning', start: Date.UTC(2026, 9, 9, 6), end: Date.UTC(2026, 9, 9, 14) } : null),
      previous: () => ({ name: 'Night', start: Date.UTC(2026, 9, 8, 22), end: Date.UTC(2026, 9, 9, 6) }),
    };
    expect(rangeWindow('shift', cal, now)).toEqual({ startTs: Date.UTC(2026, 9, 9, 6), endTs: now, shift: { name: 'Morning', start: Date.UTC(2026, 9, 9, 6), end: Date.UTC(2026, 9, 9, 14), ended: false } });
    expect(rangeWindow('prevshift', cal, now)).toMatchObject({ startTs: Date.UTC(2026, 9, 8, 22), endTs: Date.UTC(2026, 9, 9, 6), shift: { name: 'Night', ended: true } });
    const late = Date.UTC(2026, 9, 9, 15);
    expect(rangeWindow('shift', cal, late)).toMatchObject({ between: true, shift: { name: 'Night' } });
    expect(rangeWindow('shift', null, now)).toBeNull();
    expect(rangeWindow('prevshift', { current: () => null, previous: () => null }, now)).toBeNull();
  });

  it('calendarFor: the chain is machine, site, organisation, System Configuration; the zone is the nearest site zone', async () => {
    tb.add({ id: 'sys', entityType: 'ASSET', name: 'System Configuration', type: 'Config' });
    tb.setAttrs('ASSET', 'root', { imexShifts: shifts('3x8'), imexTimeZone: 'Asia/Kolkata' });
    tb.setAttrs('ASSET', 'ric', { imexShifts: shifts('2x12'), imexTimeZone: 'America/New_York' });
    tb.setAttrs('DEVICE', 'pc', { imexShifts: shifts('day') });
    tb.setAttrs('ASSET', 'sys', { imexShifts: shifts('day') });
    asUser(tb, 'u1', 'Admin', ['root']);
    const ctx = await scope.loadUserContext();
    tb.calls = [];
    const ric = await chainFor(ctx, 'rc');
    expect(ric.levels.map((l) => [l.name, l.own])).toEqual([
      ['Richmond Compressor 1', false],
      ['Richmond', true],
      ['ITHENA', true],
      ['System Configuration', true],
    ]);
    expect(ric.tz).toBe('America/New_York');
    // 2 entity queries (assets, the device) + the System Configuration lookup
    expect(tb.calls.filter((c) => c === 'POST /api/entitiesQuery/find').length).toBe(3);
    const cal = await calendarFor(ctx, 'rc');
    expect(cal?.tz).toBe('America/New_York');
    const now = Date.UTC(2026, 9, 9, 15, 0); // 11:00 in New York: the site's own Day shift (2 x 12)
    expect(cal?.current(now)?.name).toBe('Day');
    // Pune has no zone of its own: the organisation's
    const pune = await calendarFor(ctx, 'pw');
    expect(pune?.tz).toBe('Asia/Kolkata');
    expect(pune?.current(Date.UTC(2026, 9, 9, 3, 0))?.name).toBe('Morning'); // 08:30 in Kolkata
    // the machine's own override wins
    const own = await calendarFor(ctx, 'pc');
    expect(own?.current(Date.UTC(2026, 9, 9, 3, 0))?.name).toBe('Day'); // Friday 08:30
    // cached: no more requests for the same machine; a new shiftsRev reads again
    tb.calls = [];
    await calendarFor(ctx, 'rc');
    expect(tb.calls).toEqual([]);
    mem.set('imx-app-config', JSON.stringify({ shiftsRev: 7 }));
    await calendarFor(ctx, 'rc');
    expect(tb.calls.length).toBeGreaterThan(0);
  });

  it('no shifts anywhere up the chain: no calendar (the widgets then say so)', async () => {
    asUser(tb, 'u1', 'Admin', ['root']);
    const ctx = await scope.loadUserContext();
    expect(await calendarFor(ctx, 'rc')).toBeNull();
    expect(await calendarFor(ctx, null)).toBeNull();
  });

  it('the developers\' shift attribute is never read', async () => {
    tb.setAttrs('DEVICE', 'rc', { shift: { name: 'Night' } });
    asUser(tb, 'u1', 'Admin', ['root']);
    const ctx = await scope.loadUserContext();
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (u: string, init: any) => {
      if (init?.body) seen.push(String(init.body));
      seen.push(String(u));
      return tb.fetch(u, init);
    });
    await chainFor(ctx, 'rc');
    expect(seen.join(' ')).not.toMatch(/"key":"shift"|keys=shift\b/);
  });
});

describe('the dashboard list is read once for a few seconds (D-046)', () => {
  it('the Dashboard list reuses a read for 5 s; a write in between, or another caller, reads again', async () => {
    asUser(tb, 'u1', 'Admin', ['root']);
    const ctx = await scope.loadUserContext();
    const doc = { schemaVersion: 1, id: 'dx', name: 'Overview', kind: 'standalone', profile: null, timeRange: 'realtime', widgets: [], ownerId: 'u1', ownerName: 'A', version: 1, updatedAt: 1, updatedBy: 'A' };
    tb.setAttrs('ASSET', 'store', { dbb_d_dx: doc });
    tb.calls = [];
    expect((await store.listDashboards(ctx, store.LIST_REUSE_MS)).map((d) => d.id)).toEqual(['dx']);
    const first = tb.calls.length;
    expect(first).toBe(2);
    await store.listDashboards(ctx, store.LIST_REUSE_MS);
    expect(tb.calls.length).toBe(first);
    // callers without maxAgeMs (builder start screen, Open dialog) always read fresh
    await store.listDashboards(ctx);
    expect(tb.calls.length).toBe(first + 2);
    await api.saveAttrs(ctx.store!, { dbb_vis_dx: 'shared' });
    tb.calls = [];
    await store.listDashboards(ctx, store.LIST_REUSE_MS);
    expect(tb.calls.length).toBe(2);
  });
});

describe('the kit adapter (D-043, D-045)', () => {
  it('progressBar: determinate with a value, indeterminate without; labels are escaped', () => {
    expect(progressBar({ value: 42.4, label: 'Saving <x>' })).toBe(
      '<div class="imx-prog-row"><div class="imx-prog det" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="42" style="--imx-prog-v:42.4%" aria-label="Saving &lt;x&gt;"><i></i></div><span>Saving &lt;x&gt;</span><b>42%</b></div>',
    );
    expect(progressBar()).toBe('<div class="imx-prog ind" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div>');
    expect(progressBar({ value: 150, bare: true })).toContain('--imx-prog-v:100%');
  });

  it('cardSkeleton: a placeholder in the shape of the widget type', () => {
    expect(cardSkeleton('line')).toContain('imx-skel-chart');
    expect(cardSkeleton('table')).toContain('imx-skel-row');
    expect(cardSkeleton('gauge')).toContain('dbb-skel-ring');
    expect(cardSkeleton('value')).toMatch(/^<div class="dbb-skel"/);
    expect(skeletonRows(2, 3).match(/class="imx-skel"/g)!.length).toBe(6);
  });

  it('kitToast / kitConfirm use the app when it is on the page, else hand back', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    expect(kitToast('Saved', 'ok')).toBe(false);
    expect(kitConfirm({ title: 'Delete?', message: 'x' })).toBeNull();
    const got: any[] = [];
    vi.stubGlobal('window', { imxToast: (m: string, o: any) => got.push([m, o.kind]), imxKit: { confirm: async () => true } });
    expect(kitToast('Could not save', 'err')).toBe(true);
    expect(kitToast('Saved')).toBe(true);
    expect(got).toEqual([
      ['Could not save', 'error'],
      ['Saved', 'ok'],
    ]);
    expect(await kitConfirm({ title: 'Delete?', message: 'x', danger: true })).toBe(true);
    // the Builder's toast goes to the app's stack (no DOM of its own needed)
    toast({} as HTMLElement, 'Applied to 2 machines.', 'warn');
    expect(got.pop()).toEqual(['Applied to 2 machines.', 'warn']);
  });

  it('ensureKitCss: injects the kit once, never replaces a newer copy, replaces an older one', () => {
    const els = new Map<string, any>();
    const mk = (tag: string) => ({ tag, id: '', textContent: '', attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; }, getAttribute(k: string) { return this.attrs[k] ?? null; } });
    const head = { appendChild: (e: any) => els.set(e.id, e) };
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { getElementById: (id: string) => els.get(id) ?? null, createElement: mk, head });
    ensureKitCss();
    const kit = els.get('imx-kit-css');
    expect(kit.attrs['data-v']).toBe(KIT_VERSION);
    expect(kit.textContent).toContain('.imx-prog');
    expect(els.get('dbb-css-kit').textContent).toContain('--imx-prog-fill:var(--accent)');
    kit.attrs['data-v'] = '29991231.2359';
    kit.textContent = 'newer';
    ensureKitCss();
    expect(kit.textContent).toBe('newer');
    kit.attrs['data-v'] = '20200101.0000';
    ensureKitCss();
    expect(kit.attrs['data-v']).toBe(KIT_VERSION);
  });
});

describe('the chat reply comes over a subscription (D-046)', () => {
  it('no polling: the request is written once and the pushed reply is used', async () => {
    asUser(tb, 'u1', 'Admin', ['root']);
    const ctx = await scope.loadUserContext();
    let cb: any = null;
    const tbCtx = {
      $container: [{ isConnected: true }],
      subscriptionApi: {
        createSubscriptionFromInfo(_t: string, _info: any[], options: any) {
          cb = options.callbacks;
          return { subscribe: (ok: (s: any) => void) => ok({ id: 1 }) };
        },
        removeSubscription() {},
      },
    };
    vi.stubGlobal('window', { __imexDbbLiveProviders: [] });
    registerLiveProvider(tbCtx);
    const respKey = 'dbb_chat_resp'; // D-074: on the user
    vi.stubGlobal('fetch', async (u: string, init: any) => {
      const r = await tb.fetch(u, init);
      if (init?.method === 'POST' && /attributes\/SERVER_SCOPE$/.test(String(u))) {
        const reqId = JSON.parse(init.body).dbb_chat_req.reqId;
        setTimeout(() => cb.onDataUpdated({ data: [{ dataKey: { name: respKey }, data: [[Date.now(), JSON.stringify({ reqId, ok: true, toolInput: { reply: 'hi', ops: [] } })]] }] }), 20);
      }
      return r;
    });
    // the current (older) value arrives first, as ThingsBoard sends it on subscribe
    const t0 = Date.now();
    const p = chat.ruleChainTransport(ctx).send({ q: 1 });
    cb.onDataUpdated({ data: [{ dataKey: { name: respKey }, data: [[1, JSON.stringify({ reqId: 'old', ok: true })]] }] });
    tb.calls = [];
    const r = await p;
    expect(r.toolInput).toEqual({ reply: 'hi', ops: [] });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(tb.calls.filter((c) => c.startsWith('GET'))).toEqual([]);
  });
});
