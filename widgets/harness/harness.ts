// Local visual harness: runs the widgets against the in-memory fake ThingsBoard.
import { ithena, asUser } from '../test/fake-tb';
import * as launcher from '../src/entries/launcher';
import * as renderer from '../src/entries/renderer';
import * as listing from '../src/entries/listing';
import { openBuilder, setBuilderPlacement, measureHeaderTop } from '../src/builder/builder';
import { userContext } from '../src/entries/common';

const tb = ithena();
const now = Date.now();
const N = 7 * 24 * 12; // 7 days of 5-minute points
const gen = (base: number, amp: number, seed = 1) =>
  Array.from({ length: N }, (_, i) => {
    const ts = now - (N - i) * 5 * 60e3;
    const h = new Date(ts).getHours();
    const daily = Math.sin(((h - 6) / 24) * Math.PI * 2);
    return { ts, value: +(base + amp * daily + amp * 0.35 * Math.sin(i / (17 + seed)) + (Math.random() - 0.5) * amp * 0.25).toFixed(2) };
  });
const run = () => {
  const out: { ts: number; value: number }[] = [];
  let v = 1;
  for (let i = 0; i < N; i += 1) {
    if (i % 12 === 0 && Math.random() < 0.09) v = v ? 0 : 1;
    out.push({ ts: now - (N - i) * 5 * 60e3, value: v });
  }
  out[out.length - 1].value = 1;
  return out;
};
tb.telemetry.set('rc', { dischargePressure: gen(7, 0.4), dischargeTemp: gen(85, 6), powerKw: gen(60, 8), runStatus: run() });
tb.telemetry.set('pc', { dischargePressure: gen(6.9, 0.4, 3), dischargeTemp: gen(84, 7, 3), powerKw: gen(52, 9, 3), runStatus: run() });
tb.telemetry.set('rd', { dewPoint: gen(3, 0.5) });
tb.telemetry.set('pw', { temperature: gen(29, 4) });
// ---------- ?bench=1: worst-case load test (D-028) ----------
// 40 compressors (the 2 real ones + 38 more), a 10-widget standalone dashboard where every widget shows the
// maximum (4 machines x up to 4 properties, 40 machines in total), and a fake ThingsBoard WebSocket that pushes
// a new value for EVERY subscribed key of EVERY machine once per second. widgets/e2e/bench.mjs opens it in 5 tabs.
const BENCH = new URLSearchParams(location.search).has('bench');
// ?shell=1: the page pretends to have the app's side menu (the renderer then shows the machine name as its title, D-038)
if (new URLSearchParams(location.search).has('shell')) document.documentElement.classList.add('imx-menu-shift');
// ?mobile=1: the app's phone mode (html.imx-mobile, set by the side menu's headless mode on phones, D-054)
if (new URLSearchParams(location.search).has('mobile')) document.documentElement.classList.add('imx-mobile');
if (BENCH) {
  const KEYS = ['dischargePressure', 'dischargeTemp', 'powerKw', 'runStatus'];
  const devs = ['rc', 'pc'];
  for (let i = 1; i <= 38; i++) {
    const id = `b${String(i).padStart(2, '0')}`;
    devs.push(id);
    tb.add({ id, entityType: 'DEVICE', name: `BENCH-COMP-${i}`, label: `Compressor ${i + 2}`, type: 'Compressor' }, i % 2 ? 'ric' : 'pun');
    tb.telemetry.set(id, { dischargePressure: gen(7, 0.4, i), dischargeTemp: gen(85, 6, i), powerKw: gen(60, 8, i), runStatus: run() });
  }
  const g = (i: number) => devs.slice(i * 4, i * 4 + 4);
  const W = (i: number, type: string, keys: string[], x: number, y: number, w: number, h: number, settings: any = {}) => ({ id: `bw${i}`, type, title: `${type} ${i}`, x, y, w, h, binding: { mode: 'fixed', deviceIds: ['kpi', 'gauge', 'value', 'multivalue'].includes(type) ? g(i).slice(0, 1) : g(i) }, keys, settings });
  const widgets = [
    W(0, 'line', ['dischargePressure', 'dischargeTemp'], 0, 0, 6, 4),
    W(1, 'area', ['dischargePressure', 'powerKw'], 6, 0, 6, 4),
    W(2, 'table', KEYS, 0, 4, 6, 4),
    W(3, 'bar', ['powerKw'], 6, 4, 6, 4),
    W(4, 'heatmap', ['dischargeTemp'], 0, 8, 6, 4),
    W(5, 'timeline', ['runStatus'], 6, 8, 6, 4),
    W(6, 'kpi', ['powerKw'], 0, 12, 3, 2, { sparkline: true }),
    W(7, 'gauge', ['dischargePressure'], 3, 12, 3, 2),
    W(8, 'multivalue', KEYS, 6, 12, 3, 2),
    W(9, 'donut', ['powerKw'], 9, 12, 3, 2),
  ];
  tb.setAttrs('ASSET', 'store', { dbb_d_bench: { schemaVersion: 1, id: 'bench', name: 'Worst case', kind: 'standalone', profile: null, timeRange: 'realtime', widgets, ownerId: 'u1', ownerName: 'Asha', version: 1, updatedAt: now, updatedBy: 'Asha', copiedFrom: null } });
  // Fake ThingsBoard WebSocket (v2 protocol, see core/live.ts): initial value on subscribe, then 1 push/s per device.
  const bstats = ((window as any).__bench = { pushes: 0, values: 0, subs: 0 });
  class FakeWs {
    readyState = 0;
    onopen: any = null;
    onmessage: any = null;
    onclose: any = null;
    onerror: any = null;
    subs = new Map<number, { dev: string; keys: string[] }>();
    timer: any;
    constructor() {
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
        this.timer = setInterval(() => this.tick(), 1000);
      }, 20);
    }
    val(k: string) {
      return k === 'runStatus' ? (Math.random() < 0.9 ? '1' : '0') : String(+(50 + Math.random() * 40).toFixed(2));
    }
    reply(cmdId: number, keys: string[]) {
      const ts = Date.now();
      const data: any = {};
      for (const k of keys) data[k] = [[ts, this.val(k)]];
      bstats.values += keys.length;
      this.onmessage?.({ data: JSON.stringify({ subscriptionId: cmdId, errorCode: 0, data }) });
    }
    send(raw: string) {
      const m = JSON.parse(raw);
      for (const c of m.cmds ?? []) {
        if (c.unsubscribe) this.subs.delete(c.cmdId);
        else {
          this.subs.set(c.cmdId, { dev: c.entityId, keys: String(c.keys).split(',') });
          bstats.subs = this.subs.size;
          setTimeout(() => this.reply(c.cmdId, String(c.keys).split(',')), 5);
        }
      }
    }
    tick() {
      bstats.pushes++;
      for (const [cmdId, s] of this.subs) this.reply(cmdId, s.keys);
    }
    close() {
      clearInterval(this.timer);
      this.readyState = 3;
    }
  }
  (window as any).WebSocket = FakeWs;
}
const role = new URLSearchParams(location.search).get('role') ?? 'Admin';
asUser(tb, 'u1', role, [role === 'Viewer' ? 'pun' : role === 'Manager' ? 'ric' : 'root']);
localStorage.setItem('jwt_token', 'x');
// Chat relay stub (E2E): when the builder writes dbb_chat_req, answer with the next scripted tool input
// from window.__chatQueue (or an error string) as the rule chain would, in dbb_chat_resp_<userId>.
(window as any).__chatQueue = [] as any[];
(window as any).__chatReqs = [] as any[];
const baseFetch = tb.fetch;
(window as any).fetch = async (url: string, init: any = {}) => {
  const r = await baseFetch(url, init);
  if ((init.method ?? 'GET').toUpperCase() === 'POST' && /\/attributes\/SERVER_SCOPE$/.test(url) && init.body?.includes('dbb_chat_req')) {
    const req = JSON.parse(init.body).dbb_chat_req;
    (window as any).__chatReqs.push(req);
    const next = (window as any).__chatQueue.shift();
    setTimeout(() => {
      const resp = typeof next === 'string' ? { reqId: req.reqId, ok: false, provider: 'gemini', error: next } : { reqId: req.reqId, ok: true, provider: 'gemini', toolInput: next ?? { reply: 'ok', ops: [] } };
      tb.setAttrs('ASSET', 'store', { [`dbb_chat_resp_${req.userId}`]: resp });
    }, 200);
  }
  return r;
};
(window as any).__tb = tb;
(window as any).__builderTop = launcher.builderTop; // E2E: navbar-bottom measurement (D-030)
(window as any).__setPlacement = setBuilderPlacement; // E2E: simulate an app navbar that never ran our launcher's init (D-034)
(window as any).__measureHeaderTop = measureHeaderTop;

let state: any = BENCH ? { dbbDashboardId: 'bench' } : { entityId: { id: new URLSearchParams(location.search).get('dev') ?? 'pc', entityType: 'DEVICE' } };
// Simulates an app navbar that switches the machine by rewriting the state URL only (no onStateChanged,
// state controller unchanged): the case reported on 28 Sep 2026.
(window as any).__urlSwitch = (dev: string) => {
  const arr = [{ id: 'machine', params: { entityId: { id: dev, entityType: 'DEVICE' } } }];
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(arr)))).replace(/\+/g, '-').replace(/\//g, '_');
  const u = new URL(location.href);
  u.searchParams.set('state', b64);
  history.replaceState(null, '', u.toString());
};
// States of the fake app dashboard; ?noOverview=1 simulates an app without the Dashboard Overview state.
const states = ['default', 'listing', 'machine', ...(new URLSearchParams(location.search).get('noOverview') ? [] : ['dashboard_overview'])];
// ?help=1 (D-063): the app's Help page and Analyzer exist, and the state list can be read (stateController.states)
const withHelp = new URLSearchParams(location.search).has('help');
if (withHelp) states.push('help', 'analytics');
let stateId = 'machine';
(window as any).__stateId = () => stateId;
(window as any).__stateParams = () => state;
const mk = (sel: string, settings: any) => ({
  $container: [document.querySelector(sel)],
  settings,
  stateController: {
    getStateParams: () => state,
    getStateId: () => stateId,
    ...(withHelp ? { states: Object.fromEntries(states.map((x) => [x, { name: x }])) } : {}),
    // Like ThingsBoard: opening an unknown state does nothing.
    openState: (s: string, p: any) => {
      if (!states.includes(s)) return;
      stateId = s;
      state = p;
      renderer.onStateChanged(rctx);
    },
  },
});
const rctx = mk('#body', {});
launcher.init(mk('#nav', { navbar: true, appName: 'iMEX · ITHENA' }));
// E2E (D-036): mount another launcher (e.g. headless) into a new cell, like a second widget on the page
(window as any).__mountLauncher = (settings: any) => {
  const cell = document.createElement('div');
  cell.id = 'cell' + Math.random().toString(36).slice(2, 8);
  document.body.appendChild(cell);
  launcher.init(mk('#' + cell.id, settings));
  return cell.id;
};
const pg = new URLSearchParams(location.search).get('page');
if (pg === 'builder') {
  // Builder E2E: open the builder directly for ?dev= (or no machine with dev=none); instance on window.__b.
  const dev = new URLSearchParams(location.search).get('dev');
  void userContext(rctx).then((ctx) => {
    (window as any).__closed = null;
    (window as any).__b = openBuilder({ ctx, deviceId: dev === 'none' ? null : dev ?? 'pc', dashboardId: null, chatEnabled: true, onClose: (ch) => ((window as any).__closed = { changed: ch }) });
  });
} else if (pg === 'list') listing.init(mk('#body', {}));
else if (pg === 'map') listing.init(mk('#body', { mode: 'map' }));
else renderer.init(rctx);
