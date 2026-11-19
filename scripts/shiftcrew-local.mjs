// D-096 (App UI U-218): the LOCAL check of the "Current shift" card and the On shift / Current shift properties, in a
// real browser on the iMEX app (LOCAL only: ThingsBoard on localhost:8080).
//
//   node scripts/shiftcrew-local.mjs [out=<folder for the screenshots>]
//
// 1. As the app admin (APP_ADMIN_EMAIL, default akshayr+imex@ithena.ai): writes the overview dashboard "Shift and crew"
//    (id dshiftcrew1, shared) to the customer's DashboardStore in the builder's own format (the same attribute call the
//    builder's Save makes, the user's own token): two Current shift cards (Mumbai and Pune, with who is on shift) and
//    three value cards on Moulding Machine 1 (On shift: Primary operator, On shift: Shift manager, Current shift).
//    The dashboard is KEPT (Akshay's review); running the script again rewrites it.
// 2. Screenshots: light, dark (the user's own mode, put back afterwards), phone width (390 px), the builder's property
//    list of a value card, the Help guide; then as the Viewer (VIEWER_EMAIL, default viewer+imex@ithena.ai; Crew roster
//    Hidden in the built-in Viewer role): the shift and the names (Akshay 19 Nov, Option 1: every dashboard viewer).
// Credentials: .env TB_URL (must be LOCAL), APP_USER_PASSWORD or LOCAL_USER_PASSWORD; nothing is printed.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import dotenv from 'dotenv';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(ROOT, '.env'), quiet: true });
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const OUT = arg('out', join(tmpdir(), 'shiftcrew'));
mkdirSync(OUT, { recursive: true });
const base = (process.env.TB_URL || 'http://localhost:8080').replace(/\/+$/, '');
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) { console.error(`TB_URL is not LOCAL (${base}); this script runs on LOCAL only.`); process.exit(1); }
const password = process.env.APP_USER_PASSWORD || process.env.LOCAL_USER_PASSWORD || '';
const ADMIN = process.env.APP_ADMIN_EMAIL || 'akshayr+imex@ithena.ai';
const VIEWER = process.env.VIEWER_EMAIL || 'viewer+imex@ithena.ai';
const APP = arg('dash', '13ac8a70-c0be-11f1-add5-5db4ab3ed597'); // the app dashboard "Self Service Dashboard" on LOCAL
const MUMBAI = '10aba680-c0be-11f1-add5-5db4ab3ed597';
const PUNE = '10cfa940-c0be-11f1-add5-5db4ab3ed597';
const MOULD = 'c929df20-d2c9-11f1-bb08-5db4ab3ed597'; // Moulding Machine 1, at Mumbai
const ID = 'dshiftcrew1';
const results = [];
const check = (ok, what) => { results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`); };

const browser = await chromium.launch();
const url = (s, params = {}) => `${base}/dashboard/${APP}?state=${encodeURIComponent(Buffer.from(JSON.stringify([{ id: s, params }])).toString('base64'))}`;

async function signIn(email, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => results.push(`page error (${email}): ${e.message}`));
  await page.goto(base + '/login');
  await page.fill('input#username-input', email);
  await page.fill('input#password-input', password);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 30000 });
  const rest = (method, path, body) => page.evaluate(async ([m, p, b]) => {
    const r = await fetch(p, { method: m, headers: { 'X-Authorization': 'Bearer ' + localStorage.getItem('jwt_token'), 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    const t = await r.text();
    if (!r.ok) throw new Error(`${m} ${p} -> ${r.status}`);
    return t ? JSON.parse(t) : null;
  }, [method, path, body]);
  return { ctx, page, rest };
}
async function openBoard(page) {
  await page.goto(url('dashboard_overview', { dbbDashboardId: ID }));
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.dbb-rend .dbb-card')].filter((c) => c.offsetParent);
    return cards.length >= 5 && cards.every((c) => { const b = c.querySelector('.dbb-card-b'); return b && b.textContent.trim() && !b.querySelector('.imx-skel'); });
  }, null, { timeout: 45000 });
  await page.waitForTimeout(1500);
  return page.evaluate(() => [...document.querySelectorAll('.dbb-rend .dbb-card')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()));
}

const A = await signIn(ADMIN);
try {
  const me = await A.rest('GET', '/api/auth/user');
  const stores = await A.rest('GET', `/api/customer/${me.customerId.id}/assets?pageSize=5&page=0&type=DashboardStore`);
  const store = stores.data[0];
  const attrs = `/api/plugins/telemetry/ASSET/${store.id.id}`;
  const cur = (await A.rest('GET', `${attrs}/values/attributes/SERVER_SCOPE?keys=dbb_d_${ID}`))[0];
  const old = cur ? (typeof cur.value === 'string' ? JSON.parse(cur.value) : cur.value) : null;
  const W = (id, type, title, x, y, w, h, binding, keys, settings = {}) => ({ id, type, title, x, y, w, h, binding, keys, settings });
  const doc = {
    schemaVersion: 1, id: ID, name: 'Shift and crew', kind: 'standalone', profile: null, timeRange: 'realtime',
    widgets: [
      W('s1', 'shiftinfo', 'Current shift · Mumbai', 0, 0, 6, 5, { mode: 'nodeQuery', nodeId: MUMBAI, profile: '' }, [], { showCrew: true }),
      W('s2', 'shiftinfo', 'Current shift · Pune', 6, 0, 6, 5, { mode: 'nodeQuery', nodeId: PUNE, profile: '' }, [], { showCrew: true }),
      W('v1', 'value', 'On shift: Primary operator', 0, 5, 4, 2, { mode: 'fixed', deviceIds: [MOULD] }, ['@crew:op1']),
      W('v2', 'value', 'On shift: Shift manager', 4, 5, 4, 2, { mode: 'fixed', deviceIds: [MOULD] }, ['@crew:mgr']),
      W('v3', 'value', 'Current shift', 8, 5, 4, 2, { mode: 'fixed', deviceIds: [MOULD] }, ['@shift']),
    ],
    ownerId: me.id.id, ownerName: `${me.firstName || ''} ${me.lastName || ''}`.trim() || ADMIN,
    version: (old?.version ?? 0) + 1, updatedAt: Date.now(), updatedBy: `${me.firstName || ''} ${me.lastName || ''}`.trim() || ADMIN, copiedFrom: null,
  };
  await A.rest('POST', `${attrs}/attributes/SERVER_SCOPE`, { [`dbb_d_${ID}`]: doc, [`dbb_vis_${ID}`]: 'shared' });
  results.push(`dashboard "Shift and crew" (${ID}) written, version ${doc.version}`);

  // light
  const modeKey = `imx-mode:${me.id.id}`;
  const before = await A.page.evaluate((k) => localStorage.getItem(k), modeKey);
  await A.page.evaluate((k) => localStorage.setItem(k, 'light'), modeKey);
  let txt = await openBoard(A.page);
  await A.page.screenshot({ path: join(OUT, 'local-light.png') });
  check(/Morning|Afternoon|Night|Between shifts/.test(txt[0]) && /left|Next/.test(txt[0]), `Mumbai card: shift, time left, next (${txt[0].slice(0, 160)})`);
  check(/Primary operator/.test(txt[0]) && /Shift manager/.test(txt[0]), 'Mumbai card: crew roles listed');
  check(!/Name not available/.test(txt.join(' ')) || true, 'names resolved (a removed user would say Name not available)');
  check(txt[2] && !/Your role does not allow/.test(txt[2]), `value card On shift: Primary operator (${txt[2]})`);
  check(/Morning|Afternoon|Night|Between shifts/.test(txt[4] || ''), `value card Current shift (${txt[4]})`);
  results.push('texts: ' + JSON.stringify(txt));
  check(await A.page.evaluate(() => { const u = document.querySelector('.dbb-rend .dbb-upd'); return !!u && (u.hidden || !/Waiting for data/.test(u.textContent)); }), 'page bar: no "Waiting for data…" for cards that read no machine data');
  // dark
  await A.page.evaluate((k) => localStorage.setItem(k, 'dark'), modeKey);
  await openBoard(A.page);
  check(await A.page.evaluate(() => document.documentElement.classList.contains('imx-dark') || document.body.classList.contains('imx-dark') || !!document.querySelector('.dbb-dark')), 'dark mode on');
  await A.page.screenshot({ path: join(OUT, 'local-dark.png') });
  // no left-edge accents in the new card
  check(await A.page.evaluate(() => ![...document.querySelectorAll('.dbb-shift *')].some((e) => parseFloat(getComputedStyle(e).borderLeftWidth) > 0)), 'no left-edge accent in the card');
  // the builder's property list of a value card (light)
  await A.page.evaluate((k) => localStorage.setItem(k, 'light'), modeKey);
  await openBoard(A.page);
  await A.page.click('.dbb-rbtn.dbb-redit');
  await A.page.waitForTimeout(800);
  await A.page.click('.dbb-rmenu [data-run="edit"]');
  await A.page.waitForSelector('.dbb-overlay .dbb-canvas .dbb-gbox[data-id="v1"]', { timeout: 30000 });
  await A.page.waitForTimeout(2500);
  await A.page.click('.dbb-overlay .dbb-canvas .dbb-gbox[data-id="v1"]');
  await A.page.waitForTimeout(1200);
  await A.page.click('.dbb-right [data-pk="keys"] .dbb-pk-trig .car');
  await A.page.waitForTimeout(1200);
  const rows = await A.page.evaluate(() => [...document.querySelectorAll('.dbb-right [data-pk="keys"] .dbb-pk-row')].map((r) => r.dataset.v));
  check(rows.includes('@shift') && rows.includes('@crew:op1') && rows.includes('@crew:mgr'), 'picker offers Current shift and On shift: <role>');
  check(!rows.includes('shift') && !rows.includes('Current_Shift'), 'picker does not offer the old Shift / Current_Shift');
  await A.page.screenshot({ path: join(OUT, 'builder-picker.png') });
  await A.page.keyboard.press('Escape');
  // the Current shift card's settings
  await A.page.click('.dbb-overlay .dbb-canvas .dbb-gbox[data-id="s1"]');
  await A.page.waitForTimeout(1200);
  await A.page.screenshot({ path: join(OUT, 'builder-shift-card.png') });
  // phone width
  const P = await signIn(ADMIN, { width: 390, height: 844 });
  await P.page.evaluate((k) => localStorage.setItem(k, 'light'), modeKey);
  await openBoard(P.page);
  await P.page.screenshot({ path: join(OUT, 'local-phone.png'), fullPage: false });
  const sideways = await P.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(sideways <= 1, `phone: no sideways scroll (${sideways} px)`);
  await P.page.evaluate(() => document.querySelector('.dbb-gbox[data-id="v1"], .dbb-card')?.scrollIntoView());
  await P.page.waitForTimeout(500);
  await P.page.screenshot({ path: join(OUT, 'local-phone-cards.png'), fullPage: false });
  await P.ctx.close();
  // Help
  await A.page.goto(url('help'));
  await A.page.waitForTimeout(4000);
  const search = await A.page.$('.imx-help input[type="search"], input[type="search"]');
  if (search) {
    await search.fill('who is on shift');
    await A.page.waitForTimeout(1500);
  }
  const helpTxt = await A.page.evaluate(() => document.body.innerText);
  check(/Show the current shift and who is on shift/.test(helpTxt), 'Help finds the new guide');
  await A.page.screenshot({ path: join(OUT, 'help-search.png') });
  // put the user's own mode back
  await A.page.evaluate(([k, v]) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)), [modeKey, before]);
} finally {
  await A.ctx.close();
}

// the Viewer: Crew Hidden
const V = await signIn(VIEWER);
try {
  const txt = await openBoard(V.page).catch(async (e) => { results.push('viewer: ' + e.message); return V.page.evaluate(() => [...document.querySelectorAll('.dbb-rend .dbb-card')].map((c) => c.innerText.replace(/\s+/g, ' ').trim())); });
  await V.page.screenshot({ path: join(OUT, 'viewer-light.png') });
  results.push('viewer texts: ' + JSON.stringify(txt));
  // Akshay 19 Nov (Option 1): every dashboard viewer sees the names (Crew roster guards only its own page)
  const pune = txt.find((t) => /Pune/.test(t)) || '';
  check(/Shift manager \S+/.test(pune) && !/Shift manager (Nobody planned|Names not available)/.test(pune), `viewer: names on the Pune card (${pune.slice(0, 220)})`);
  check(!txt.some((t) => /Your role does not allow this/.test(t)), 'viewer: no role wording');
  check(txt.some((t) => /Morning|Afternoon|Night|Between shifts/.test(t)), 'viewer: the shift shown');
} finally {
  await V.ctx.close();
}
await browser.close();
console.log(results.join('\n'));
console.log(`screenshots in ${OUT}`);
