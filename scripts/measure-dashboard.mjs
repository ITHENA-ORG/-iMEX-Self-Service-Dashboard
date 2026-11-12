// Long-range speed of a builder dashboard (data summaries / data cubes, the UI repo's docs/design/DATA_CUBES.md §9): one
// dashboard of 6 chart widgets, shown for 7 days and for 30 days, time until every chart is drawn. In a real browser on
// the iMEX app (LOCAL only: ThingsBoard on localhost:8080), as the app admin.
//
//   node scripts/measure-dashboard.mjs [runs=3] [periods=7,30] [windows=now,fixed] [end=2026-11-08T00:00:00+05:30]
//                                      [dash=<app dashboard id>] [--baseline] [out=<file.json>]
//
//   periods   days shown. The page's "Time window" offers custom periods up to 7 days (core/viewwindow.ts MAX_CUSTOM_MS);
//             30 days is not offered today. It is shown here through the stored choice of the page (localStorage
//             dbb-tw:<user>:d:<dashboard>, a custom period: loadView does not cap it), so the 30-day line shows what
//             today's readers (series(), the bar and heatmap reads) do over 30 days.
//   windows   now   = the period ends now (on LOCAL the newest day holds little data: the simulators send little)
//             fixed = the period ends at end= (default 8 Nov 2026 00:00 India time, in the dense data of LOCAL; its data
//                     does not change between runs, so before / after compare the same work)
//   cubes=<url> D-083: the charts read from this data summaries service (e.g. http://localhost:8092): the app dashboard
//             as the page receives it gets the builder widgets' setting cubesServiceUrl=<url> (nothing is saved), so the
//             browser calls the service directly (CORS). cubesvia=proxy instead serves the page's /cubes-api/ path from
//             <url> through the test browser, as nginx does on an installation (adds the browser tool's own delay).
//             Without cubes= /cubes-api/ is the platform's own page (no service: each widget library makes one refused
//             call, then the charts read as before). cubes=off: the setting blank (summaries switched off: no call at all),
//             the line a stopped service is compared with (D-084)
//   --baseline writes the "builder" part of <UI repo>/backups/pre-datacubes-20261110/longrange-baseline.json (+ .txt);
//             otherwise out= (default <temp>/longrange-builder.json), compared with the baseline when it exists
//
// The fixture: a dashboard "Speed check (test)" written to the customer's DashboardStore asset in the builder's own
// store format (dbb_d_<id> = the document, dbb_vis_<id> = private: only its owner, the app admin, sees it in a list),
// with the same attribute call the builder's Save makes (POST .../attributes/SERVER_SCOPE, the user's own token). It is
// removed at the end (and a fixture left by an earlier, broken run is removed at the start): dbb_d_ / dbb_h_ / dbb_vis_
// keys of ids starting with "lrbase".
// One measurement: the Machines page is opened (a fresh page: the builder's read caches are empty), then the app moves
// to the dashboard (state dashboard_overview, dbbDashboardId) as a click in the app does (t0):
//   drawn    t0 until all 6 cards show a chart (or "No data in this time range"), no placeholder left
//   settled  t0 until no request for 700 ms (not counted)
// Requests: every /api/ request between t0 and settled (not the WebSocket); "chart" = the history reads among them.
// Credentials: .env TB_URL (must be LOCAL), the app admin APP_ADMIN_EMAIL (default akshayr+imex@ithena.ai) with
// APP_USER_PASSWORD or LOCAL_USER_PASSWORD; nothing is printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(ROOT, '.env'), quiet: true });
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const RUNS = Number(arg('runs', 3)) || 3;
const PERIODS = arg('periods', '7,30').split(',').map(Number).filter((n) => n > 0);
const WINDOWS = arg('windows', 'now,fixed').split(',').filter((w) => w === 'now' || w === 'fixed');
const END = Date.parse(arg('end', '2026-11-08T00:00:00+05:30'));
const UI_REPO = process.env.IMEX_UI_REPO || 'D:/Claude Code/iMEX App UI';
const BASELINE = join(UI_REPO, 'backups', 'pre-datacubes-20261110', 'longrange-baseline.json');
const asBaseline = process.argv.includes('--baseline');
const CUBES = arg('cubes', '').replace(/\/+$/, '');
const OUT = asBaseline ? BASELINE : arg('out', join(tmpdir(), 'longrange-builder.json'));
const base = (process.env.TB_URL || 'http://localhost:8080').replace(/\/+$/, '');
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) { console.error(`TB_URL is not LOCAL (${base}); this script measures LOCAL only.`); process.exit(1); }
const email = process.env.APP_ADMIN_EMAIL || 'akshayr+imex@ithena.ai';
const password = process.env.APP_USER_PASSWORD || process.env.LOCAL_USER_PASSWORD || '';
const dashId = arg('dash', '') || readFileSync(join(UI_REPO, 'backups', 'test-dashboard-id.txt'), 'utf8').trim();
const MACHINES = ['Blower 2', 'Blower 3', 'Blower 4'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const isApi = (u) => { try { const p = new URL(u).pathname; return (p.startsWith('/api/') && !p.startsWith('/api/ws')) || p.startsWith('/cubes-api/'); } catch { return false; } };
if (CUBES && CUBES !== 'off' && arg('cubesvia', 'setting') === 'proxy') await page.route('**/cubes-api/**', async (route) => {
  const u = new URL(route.request().url());
  try { await route.fulfill({ response: await route.fetch({ url: CUBES + u.pathname.replace(/^\/cubes-api/, '') + u.search }) }); } catch { await route.abort(); }
});
else if (CUBES) await page.route(/\/api\/dashboard\/[0-9a-f-]{36}(\?|$)/, async (route) => {
  try {
    const res = await route.fetch();
    const d = await res.json();
    for (const w of Object.values(d?.configuration?.widgets || {})) if (/imex_dbb_/.test(w.typeFullFqn || '')) (w.config.settings ||= {}).cubesServiceUrl = CUBES === 'off' ? '' : CUBES;
    await route.fulfill({ response: res, json: d });
  } catch { await route.continue(); }
});
const log = [];
const open = new Map();
let lastRequest = 0;
page.on('request', (r) => { if (!isApi(r.url())) return; const e = { url: r.url(), t: Date.now(), end: 0, enc: 0, body: 0, status: 0 }; log.push(e); open.set(r, e); lastRequest = Date.now(); });
const finish = (r, failed) => {
  const e = open.get(r);
  if (!e) return;
  open.delete(r);
  e.end = lastRequest = Date.now();
  if (failed) { e.status = -1; return; }
  e.sizing = (async () => {
    try { e.enc = (await r.sizes()).responseBodySize; } catch { /* gone */ }
    try { const res = await r.response(); e.status = res ? res.status() : 0; const b = res ? await res.body() : null; e.body = b ? b.length : 0; } catch { /* not kept */ }
  })();
};
page.on('requestfinished', (r) => finish(r, false));
page.on('requestfailed', (r) => finish(r, true));
const pending = () => { const now = Date.now(); let n = 0; for (const e of open.values()) if (now - e.t < 10000) n++; return n; };
const reset = () => { open.clear(); };

await page.goto(base + '/login');
await page.fill('input#username-input', email);
await page.fill('input#password-input', password);
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 });
// REST as the signed-in user (the token of the page)
const rest = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, headers: { 'X-Authorization': 'Bearer ' + localStorage.getItem('jwt_token'), 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} -> ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}, [method, path, body]);
const me = await rest('GET', '/api/auth/user');
const userId = me.id.id;
const stores = await rest('GET', `/api/customer/${me.customerId.id}/assets?pageSize=5&page=0&type=DashboardStore`);
const store = stores.data[0];
if (!store) { console.error('the customer has no DashboardStore asset'); process.exit(1); }
const storeAttrs = `/api/plugins/telemetry/ASSET/${store.id.id}`;
const devs = await rest('GET', `/api/customer/${me.customerId.id}/deviceInfos?pageSize=200&page=0`);
const ids = MACHINES.map((n) => devs.data.find((d) => d.name === n)?.id.id);
if (ids.some((x) => !x)) { console.error(`machines missing: ${MACHINES.join(', ')}`); process.exit(1); }
const [b2, b3, b4] = ids;

// a fixture left by a broken run
async function removeFixtures() {
  const keys = (await rest('GET', `${storeAttrs}/keys/attributes/SERVER_SCOPE`)).filter((k) => /^dbb_(d|h|vis)_lrbase/.test(k));
  if (keys.length) await rest('DELETE', `${storeAttrs}/SERVER_SCOPE?keys=${encodeURIComponent(keys.join(','))}`);
  return keys.length;
}
const stale = await removeFixtures();
if (stale) console.log(`removed ${stale} keys of an earlier fixture`);

const id = 'lrbase' + randomBytes(5).toString('hex');
const fixed = (deviceIds) => ({ mode: 'fixed', deviceIds });
const W = (n, type, title, x, y, binding, keys, settings = {}) => ({ id: `w${n}`, type, title, x, y, w: 6, h: 4, binding, keys, settings });
const doc = {
  schemaVersion: 1, id, name: 'Speed check (test)', kind: 'standalone', profile: null, timeRange: '8h',
  widgets: [
    W(1, 'line', 'Air temperature and flow', 0, 0, fixed([b2]), ['Discharge_Air_Temperature', 'Airflow_Rate']),
    W(2, 'line', 'Bearing and pressure', 6, 0, fixed([b3]), ['Bearing_Temperature_DE', 'Discharge_Pressure']),
    W(3, 'area', 'Motor current', 0, 4, fixed([b4]), ['Motor_Current']),
    W(4, 'line', 'Inlet temperature, 3 machines', 6, 4, fixed([b2, b3, b4]), ['Inlet_Air_Temperature']),
    W(5, 'bar', 'Motor current per interval', 0, 8, fixed([b2]), ['Motor_Current'], { groupBy: 'hour' }),
    W(6, 'heatmap', 'Discharge pressure, machines x time', 6, 8, fixed([b2, b3, b4]), ['Discharge_Pressure']),
  ],
  ownerId: userId, ownerName: `${me.firstName || ''} ${me.lastName || ''}`.trim() || email, version: 1, updatedAt: Date.now(), updatedBy: 'speed check',
};
const viewKey = `dbb-tw:${userId}:d:${id}`;
const url = (s, params = {}) => `${base}/dashboard/${dashId}?state=${encodeURIComponent(Buffer.from(JSON.stringify([{ id: s, params }])).toString('base64'))}`;
const quiet = async (limit = 60000) => { const t = Date.now(); while (Date.now() - t < limit) { if (pending() === 0 && Date.now() - lastRequest > 700) return true; await page.waitForTimeout(80); } return false; };

const rows = [];
let failure = null;
try {
  await rest('POST', `${storeAttrs}/attributes/SERVER_SCOPE`, { [`dbb_d_${id}`]: doc, [`dbb_vis_${id}`]: 'private' });
  const combos = PERIODS.flatMap((days) => WINDOWS.map((window) => ({ days, window })));
  const got = combos.map(() => []);
  for (let run = 0; run < RUNS; run++) for (let i = 0; i < combos.length; i++) {
    got[i].push(await measure(combos[i].days, combos[i].window));
    process.stdout.write(`  run ${run + 1}: ${combos[i].days} d ${combos[i].window}: drawn ${sec(got[i].at(-1).drawn)}\n`);
  }
  const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  for (let i = 0; i < combos.length; i++) {
    const m = got[i];
    const pick = (k) => median(m.map((x) => x[k]));
    rows.push({ ...combos[i], drawn: pick('drawn'), settled: pick('settled'), chartRequests: pick('chartRequests'), cubeRequests: pick('cubeRequests'), chartBodyBytes: pick('chartBodyBytes'), requests: pick('requests'), bytes: pick('bytes'), bodyBytes: pick('bodyBytes'), cards: pick('cards'), noData: Math.max(...m.map((x) => x.noData)), failed: Math.max(...m.map((x) => x.failed)), timedOut: m.filter((x) => x.drawn == null).length, asked: m[0].asked, runs: m.map((x) => ({ drawn: x.drawn, settled: x.settled, requests: x.requests })) });
  }
} catch (e) {
  failure = e;
} finally {
  // the fixture goes, whatever happened
  await page.evaluate((k) => { try { localStorage.removeItem(k); } catch { /* blocked */ } }, viewKey).catch(() => {});
  await rest('DELETE', `${storeAttrs}/SERVER_SCOPE?keys=${encodeURIComponent([`dbb_d_${id}`, `dbb_h_${id}`, `dbb_vis_${id}`].join(','))}`).catch((e) => console.error('the fixture could not be removed: ' + e.message));
  const left = (await rest('GET', `${storeAttrs}/keys/attributes/SERVER_SCOPE`).catch(() => [])).filter((k) => k.includes(id));
  console.log(left.length ? `fixture keys left: ${left.join(', ')}` : 'fixture removed');
  await browser.close();
}
if (failure) { console.error(failure); process.exit(1); }

async function measure(days, window) {
  const to = window === 'fixed' ? END : Date.now();
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [viewKey, { range: 'custom', from: to - days * 86400e3, to }]);
  // a fresh page first (the builder's read caches live in the page), then into the dashboard as the app moves
  reset();
  await page.goto(url('listing'));
  await page.waitForSelector('#imx-menu-root .imx-menu-it', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await quiet();
  const from = log.length;
  const t0 = Date.now();
  await page.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')); }, url('dashboard_overview', { dbbDashboardId: id }));
  let drawnAt = 0, settledAt = 0, state = null;
  for (;;) {
    const now = Date.now();
    if (now - t0 > 120000) break;
    if (!drawnAt) {
      state = await page.evaluate((name) => {
        const t = [...document.querySelectorAll('.dbb-rtitle')].find((e) => e.textContent.trim() === name);
        if (!t) return null;
        const root = t.closest('.dbb-rend') || document;
        const cards = [...root.querySelectorAll('.dbb-card')].filter((c) => c.offsetParent);
        const done = cards.filter((c) => { const b = c.querySelector('.dbb-card-b'); return b && !b.querySelector('.dbb-skel') && (b.querySelector('svg') || b.querySelector('.dbb-ph')); });
        return { cards: cards.length, done: done.length, noData: cards.filter((c) => /No data/.test(c.querySelector('.dbb-card-b')?.textContent || '')).length };
      }, doc.name).catch(() => null);
      if (state && state.cards === 6 && state.done === 6) drawnAt = Date.now();
    }
    if (drawnAt && pending() === 0 && now - lastRequest > 700) { settledAt = Math.max(drawnAt, lastRequest); break; }
    await page.waitForTimeout(40);
  }
  const reqs = log.slice(from).filter((e) => e.t >= t0 && (!settledAt || e.t <= settledAt));
  await Promise.all(reqs.map((e) => e.sizing).filter(Boolean));
  const sum = (a, k) => a.reduce((s, e) => s + (e[k] || 0), 0);
  if (process.env.LR_DEBUG) for (const e of reqs) console.log(`    ${e.t - t0} ms +${e.end - e.t} ms  ${e.status}  ${e.body} B  ${decodeURIComponent(e.url.replace(base, '')).slice(0, 200)}`);
  const ts = reqs.filter((e) => /\/values\/timeseries/.test(e.url));
  const cubeReqs = reqs.filter((e) => /\/cubes-api\/|\/api\/v1\/series/.test(e.url));
  // the charts' own requests: the history reads (the rest is the page: widget code, user, store, catalogue, the document)
  const chart = ts;
  return {
    drawn: drawnAt ? drawnAt - t0 : null, settled: settledAt ? settledAt - t0 : null, cards: state?.cards ?? 0, noData: state?.noData ?? 0,
    chartRequests: chart.length, cubeRequests: cubeReqs.length, chartBodyBytes: sum(chart, 'body'), requests: reqs.length, bytes: sum(reqs, 'enc'), bodyBytes: sum(reqs, 'body'),
    failed: reqs.filter((e) => e.status < 0 || e.status >= 400).length,
    asked: [...new Set(ts.map((e) => { const q = new URL(e.url).searchParams; return `agg=${q.get('agg') || 'NONE'}${q.get('interval') ? ' interval=' + q.get('interval') : ''}${q.get('intervalType') ? ' ' + q.get('intervalType') : ''}${q.get('limit') ? ' limit=' + q.get('limit') : ''}`; }))],
  };
}

function sec(ms) { return ms == null ? '> 120 s' : (ms / 1000).toFixed(1) + ' s'; }
function kb(b) { return b == null ? '-' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB'; }
function line(r, b) {
  const d = b && b.drawn != null && r.drawn != null ? `  (baseline ${sec(b.drawn)}, ${r.drawn <= b.drawn ? '' : '+'}${Math.round(((r.drawn - b.drawn) / b.drawn) * 100)} %)` : '';
  return `${String(r.days).padStart(2)} days ${(r.window === 'fixed' ? 'fixed' : 'to now').padEnd(6)}  6 charts drawn ${sec(r.drawn).padStart(7)}  settled ${sec(r.settled).padStart(7)}  chart: ${String(r.chartRequests).padStart(2)} requests ${kb(r.chartBodyBytes).padStart(7)}${r.cubeRequests ? ` + ${r.cubeRequests} summaries` : ""}  whole load: ${String(r.requests).padStart(2)} requests ${kb(r.bodyBytes).padStart(7)}${r.noData ? `  ${r.noData} card(s) no data` : ''}${r.failed ? `  ${r.failed} failed` : ''}${r.timedOut ? `  ${r.timedOut} timed out` : ''}${d}`;
}
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const prevRows = readJson(BASELINE)?.builder?.rows || [];
const same = (a, b) => a.days === b.days && a.window === b.window;
console.log('');
for (const r of rows) console.log(line(r, asBaseline ? null : prevRows.find((b) => same(b, r))));
const result = { measured: new Date().toISOString(), host: base, who: email, runs: RUNS, cubes: CUBES || null, fixedEnd: new Date(END).toISOString(), machines: MACHINES, widgets: doc.widgets.map((w) => `${w.type}: ${w.keys.join('+')} on ${w.binding.deviceIds.length} machine(s)`), how: 'Machines page opened, then into the dashboard (state dashboard_overview); period = a custom period stored as the page\'s time window (30 days is not offered by the picker today)', rows };
if (!asBaseline && prevRows.length) result.compare = rows.map((r) => { const b = prevRows.find((x) => same(x, r)); return { days: r.days, window: r.window, drawn: r.drawn, baseline: b ? b.drawn : null, pct: b && b.drawn ? Math.round(((r.drawn - b.drawn) / b.drawn) * 100) : null, slower: !!(b && r.drawn != null && b.drawn != null && r.drawn > b.drawn * 1.1 + 200) }; });
writePart(OUT, 'builder', result, [
  `Builder dashboard (${email}; 6 charts on ${MACHINES.join(', ')}; median of ${RUNS}; measured ${result.measured.slice(0, 16).replace('T', ' ')} UTC)`,
  ...result.widgets.map((w) => '  ' + w),
  `  ("fixed" ends ${result.fixedEnd}; "to now" ends now. 30 days: not offered by the time window picker today, set as the stored window)`,
  ...rows.map((r) => '  ' + line(r)),
  ...rows.map((r) => `    ${r.days} d ${r.window}: asked ${r.asked.join('; ')}`),
].join('\n'));
console.log(`\nwritten: ${OUT}`);

// one part of the shared result files (json: one key per part; txt: one block per part between markers)
function writePart(file, part, data, txt) {
  mkdirSync(dirname(file), { recursive: true });
  const all = readJson(file) || {};
  all[part] = data;
  writeFileSync(file, JSON.stringify(all, null, 1));
  const tf = file.replace(/\.json$/i, '.txt');
  let t = existsSync(tf) ? readFileSync(tf, 'utf8') : '';
  const a = `== ${part} ==`, z = `== /${part} ==`;
  const block = `${a}\n${txt}\n${z}`;
  const i = t.indexOf(a), k = t.indexOf(z);
  t = i >= 0 && k > i ? t.slice(0, i) + block + t.slice(k + z.length) : (t ? t.replace(/\s*$/, '\n\n') : '') + block + '\n';
  writeFileSync(tf, t);
}
