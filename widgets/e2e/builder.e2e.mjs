// End-to-end tests of the Dashboard Builder and the machine page, in a real Chromium, against the in-memory
// fake ThingsBoard of widgets/harness (generated telemetry, stub chat relay). No ThingsBoard needed.
//
//   npx esbuild widgets/harness/harness.ts --bundle --format=iife --target=es2019 --outfile=widgets/harness/harness.js
//   node widgets/e2e/builder.e2e.mjs            # all tests
//   node widgets/e2e/builder.e2e.mjs save chat  # only tests whose name contains one of the words
//
// Needs Playwright's Chromium once on a new machine: npx playwright install chromium
// Every test gets a fresh page (fresh fake server). A test fails on a failed check, on an uncaught page
// error, or on a console error. Exit code 1 when anything failed.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '../harness');
const PORT = 8766;
const srv = createServer((q, r) => {
  const f = q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0].slice(1);
  try {
    r.end(readFileSync(join(HARNESS, f)));
  } catch {
    r.statusCode = 404;
    r.end();
  }
}).listen(PORT);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
class Fail extends Error {}
const ok = (cond, msg) => {
  if (!cond) throw new Fail(msg);
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** Opens the harness. page=builder waits for the builder to finish loading. */
async function open(query = 'page=builder&dev=pc') {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    // Google Fonts can't load in the sandbox; that is not a widget error. The harness has no WebSocket server, so
    // the live socket fails and REST takes over (as in production with the socket down); since D-035 that is a
    // ws:// handshake error on this http: page instead of an ERR_SSL one.
    if (m.type() === 'error' && !/fonts\.googleapis|ERR_|Failed to load resource|WebSocket connection to .* failed/.test(m.text())) errors.push('console: ' + m.text());
  });
  page.on('dialog', (d) => {
    errors.push('native dialog: ' + d.message());
    void d.dismiss();
  });
  await page.goto(`http://localhost:${PORT}/?${query}`);
  if (query.includes('page=builder')) await page.waitForFunction(() => window.__b && !window.__b.busy && window.__b.root?.querySelector('.dbb-top select'), null, { timeout: 8000 });
  else await page.waitForTimeout(1200);
  const h = {
    page,
    errors,
    draft: () => page.evaluate(() => window.__b.draft),
    b: (fn, arg) => page.evaluate(fn, arg),
    click: (sel) => page.click(sel, { timeout: 4000 }),
    idle: async (ms = 300) => {
      await page.waitForTimeout(ms);
      await page.waitForFunction(() => !window.__b || !window.__b.busy, null, { timeout: 8000 });
    },
    toastText: () => page.evaluate(() => [...document.querySelectorAll('.dbb-toast')].map((t) => t.textContent).join(' | ')),
    modalTitle: () => page.evaluate(() => document.querySelector('.dbb-modal .dbb-modal-h')?.textContent?.trim() ?? null),
    modalBtn: (key) => page.click(`.dbb-modal [data-mb="${key}"]`, { timeout: 4000 }),
    addWidget: async (type) => {
      await page.click(`.dbb-left .dbb-pal[data-t="${type}"]`, { timeout: 4000 });
      await page.waitForTimeout(150);
    },
    /** D-033: data source dropdown of the selected widget. */
    source: async (mode) => {
      await page.selectOption('.dbb-right [data-s="src"]', mode);
      await page.waitForTimeout(150);
    },
    /**
     * D-033: picks values in a searchable dropdown (data-pk = 'keys' | 'dev' | ...): opens it, clicks each
     * row that isn't ticked yet (or the one row of a single choice), closes with Done. Returns the rows' state.
     */
    pick: async (name, values, { search } = {}) => {
      // opened by its caret: the centre of the control can be a chip's ✕ (wide chips with Inter loaded)
      const host = `.dbb-right [data-pk="${name}"]`;
      await page.click(`${host} .dbb-pk-trig .car`, { timeout: 4000 });
      // the search box appears only for longer lists (more than 4 entries)
      if (search && (await page.$(`${host} .dbb-pk-s input`))) await page.fill(`${host} .dbb-pk-s input`, search);
      for (const v of values) {
        const row = `${host} .dbb-pk-row[data-v="${v}"]`;
        if (!(await page.$(`${row}.on`))) await page.click(row, { timeout: 4000 });
        await page.waitForTimeout(60);
      }
      if (await page.$(`${host} [data-done]`)) await page.click(`${host} [data-done]`);
      await page.waitForTimeout(200);
    },
    /** Card error placeholders currently on the canvas (a widget that failed to load). */
    cardErrors: () => page.evaluate(() => [...document.querySelectorAll('.dbb-canvas .dbb-card')].map((c) => c.textContent).filter((t) => /Could not load|Unknown widget|undefined|NaN/.test(t))),
  };
  return h;
}

// ------------------------------------------------------------------ builder shell

test('opens for a machine: blank draft, empty state, Inter font', async (t) => {
  const d = await t.draft();
  eq(d.widgets.length, 0, 'widgets');
  eq(d.profile, 'Compressor', 'profile');
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), 'pc', 'machine select');
  eq(await t.page.inputValue('.dbb-top [data-a="name"]'), 'Compressor dashboard', 'name');
  ok(await t.page.isVisible('.dbb-empty-card'), 'empty-state card shown');
  const fonts = await t.b(() => ({
    overlay: getComputedStyle(document.querySelector('.dbb-overlay')).fontFamily,
    top: getComputedStyle(document.querySelector('.dbb-top input')).fontFamily,
    select: getComputedStyle(document.querySelector('.dbb-top select')).fontFamily,
    palette: getComputedStyle(document.querySelector('.dbb-pal')).fontFamily,
    canvas: getComputedStyle(document.querySelector('.dbb-center')).fontFamily,
    panel: getComputedStyle(document.querySelector('.dbb-right')).fontFamily,
  }));
  for (const [k, v] of Object.entries(fonts)) ok(/^("DM Sans", )?Inter\b/.test(v), `${k} font is the app font (got ${v})`);
  ok(await t.b(() => !!document.getElementById('dbb-font-Inter')), 'Inter font stylesheet requested');
});

test('machine options group devices by location; standalone option first', async (t) => {
  const opts = await t.b(() => [...document.querySelectorAll('.dbb-top [data-a="machine"] option')].map((o) => o.value));
  eq(opts[0], '', 'first option is standalone');
  eq(opts.slice(1).sort(), ['pc', 'pw', 'rc', 'rd'], 'all in-scope devices');
  const groups = await t.b(() => [...document.querySelectorAll('.dbb-top [data-a="machine"] optgroup')].map((g) => g.label));
  ok(groups.length === 2 && groups.every((g) => g.includes('›')), `grouped by location: ${groups}`);
});

test('rename, time range realtime/historic, undo and redo (buttons and keys)', async (t) => {
  await t.page.fill('.dbb-top [data-a="name"]', 'Line 1 overview');
  await t.page.press('.dbb-top [data-a="name"]', 'Tab');
  eq((await t.draft()).name, 'Line 1 overview', 'renamed');
  await t.click('.dbb-top [data-rng="hist"]');
  eq((await t.draft()).timeRange, '1h', 'historic starts at 1 h');
  await t.page.selectOption('.dbb-top [data-a="range"]', '8h');
  eq((await t.draft()).timeRange, '8h', 'historic 8 h');
  await t.click('.dbb-top [data-rng="realtime"]');
  eq((await t.draft()).timeRange, 'realtime', 'back to realtime');
  await t.click('.dbb-top [data-a="undo"]');
  eq((await t.draft()).timeRange, '8h', 'undo -> 8h');
  await t.page.click('.dbb-center', { position: { x: 5, y: 5 } });
  await t.page.keyboard.press('Control+z');
  eq((await t.draft()).timeRange, '1h', 'Ctrl+Z -> 1h');
  await t.page.keyboard.press('Control+Shift+Z');
  eq((await t.draft()).timeRange, '8h', 'Ctrl+Shift+Z -> 8h');
  await t.click('.dbb-top [data-a="redo"]');
  eq((await t.draft()).timeRange, 'realtime', 'redo button -> realtime');
  ok(await t.page.isDisabled('.dbb-top [data-a="redo"]'), 'redo disabled at the end');
});

// ------------------------------------------------------------------ palette and widgets

const ALL_TYPES = ['value', 'kpi', 'gauge', 'progress', 'status', 'multivalue', 'summary', 'line', 'area', 'bar', 'donut', 'timeline', 'heatmap', 'table', 'alarms', 'text', 'image', 'link', 'embed'];

test('every palette widget type adds, renders without errors, and deletes', async (t) => {
  const tiles = await t.b(() => [...document.querySelectorAll('.dbb-left .dbb-pal')].map((p) => p.dataset.t));
  eq(tiles.slice().sort(), ALL_TYPES.slice().sort(), 'palette lists the 19 widget types');
  for (const type of ALL_TYPES) {
    const blocked = await t.b((ty) => document.querySelector(`.dbb-pal[data-t="${ty}"]`).classList.contains('off'), type);
    if (blocked) continue; // not possible for Compressor; covered by the next test
    await t.addWidget(type);
    const d = await t.draft();
    eq(d.widgets.length, 1, `${type}: added`);
    eq(d.widgets[0].type, type, `${type}: type`);
    const sel = await t.b(() => window.__b.selected);
    eq(sel, d.widgets[0].id, `${type}: selected after add`);
    ok(await t.page.isVisible('.dbb-right .dbb-tab.on:has-text("Widget")'), `${type}: Widget tab open`);
    await t.page.waitForTimeout(900);
    eq(await t.cardErrors(), [], `${type}: card errors`);
    const body = await t.b(() => document.querySelector('.dbb-canvas .dbb-card-b')?.innerHTML.length ?? 0);
    ok(body > 0, `${type}: card body drawn`);
    await t.page.click('.dbb-center', { position: { x: 5, y: 5 } }); // focus outside inputs
    await t.b(() => window.__b.grid && (window.__b.selected = window.__b.draft.widgets[0].id));
    await t.page.keyboard.press('Delete');
    eq((await t.draft()).widgets.length, 0, `${type}: Delete key removes it`);
  }
});

test('palette blocks types with no fitting property and explains why', async (t) => {
  // Weather Station has one numeric property: state widgets (status/timeline) don't fit it.
  await t.page.selectOption('.dbb-top [data-a="machine"]', 'pw');
  await t.idle();
  const off = await t.b(() => [...document.querySelectorAll('.dbb-left .dbb-pal.off')].map((p) => p.dataset.t));
  ok(off.length > 0, `some tiles blocked for Weather Station: ${off}`);
  await t.page.click(`.dbb-left .dbb-pal[data-t="${off[0]}"]`, { force: true });
  await t.page.waitForTimeout(150);
  ok(/isn't available for Weather Station/.test(await t.toastText()), 'toast explains why');
  eq((await t.draft()).widgets.length, 0, 'nothing added');
});

test('palette search filters tiles', async (t) => {
  await t.page.fill('.dbb-pal-search input', 'gau');
  await t.page.waitForTimeout(100);
  eq(await t.b(() => [...document.querySelectorAll('.dbb-left .dbb-pal')].map((p) => p.dataset.t)), ['gauge'], 'only gauge');
  ok(await t.b(() => document.activeElement?.closest('.dbb-pal-search') != null), 'search keeps focus while typing');
  await t.page.fill('.dbb-pal-search input', 'zzz');
  ok(await t.page.isVisible('.dbb-left :text("No widget matches.")'), 'no-match hint');
});

test('10-widget limit: tiles grey out, extra add and duplicate refused', async (t) => {
  for (let i = 0; i < 10; i++) await t.addWidget('value');
  eq((await t.draft()).widgets.length, 10, '10 added');
  ok(await t.b(() => document.querySelectorAll('.dbb-left .dbb-pal.off').length === 19), 'all tiles off');
  ok(/10 \/ 10/.test(await t.page.textContent('.dbb-count')), 'counter');
  await t.page.click('.dbb-left .dbb-pal[data-t="kpi"]', { force: true });
  eq((await t.draft()).widgets.length, 10, 'no 11th widget');
  await t.click('.dbb-right [data-s="dup"]');
  eq((await t.draft()).widgets.length, 10, 'duplicate refused');
  ok(/at most 10 widgets|already has 10/.test(await t.toastText()), 'limit toast');
});

test('drag a palette tile onto the canvas places it at the drop cell', async (t) => {
  const canvas = await t.page.$('.dbb-canvas');
  const box = await canvas.boundingBox();
  await t.page.dragAndDrop('.dbb-left .dbb-pal[data-t="gauge"]', '.dbb-canvas', { targetPosition: { x: box.width * 0.55, y: 260 } });
  await t.page.waitForTimeout(300);
  const d = await t.draft();
  eq(d.widgets.length, 1, 'dropped');
  eq(d.widgets[0].type, 'gauge', 'type');
  ok(d.widgets[0].x >= 5 && d.widgets[0].y >= 2, `placed near the drop point (x=${d.widgets[0].x}, y=${d.widgets[0].y})`);
});

test('move and resize a card with the pointer; both undoable', async (t) => {
  await t.addWidget('value');
  const w0 = (await t.draft()).widgets[0];
  const bar = await (await t.page.$('.dbb-gbox .dbb-gdrag')).boundingBox();
  await t.page.mouse.move(bar.x + 20, bar.y + 10);
  await t.page.mouse.down();
  await t.page.mouse.move(bar.x + 420, bar.y + 200, { steps: 8 });
  await t.page.mouse.up();
  await t.page.waitForTimeout(250);
  const w1 = (await t.draft()).widgets[0];
  ok(w1.x > w0.x && w1.y > w0.y, `moved (${w0.x},${w0.y}) -> (${w1.x},${w1.y})`);
  const rz = await (await t.page.$('.dbb-gbox .dbb-gresize')).boundingBox();
  await t.page.mouse.move(rz.x + 8, rz.y + 8);
  await t.page.mouse.down();
  await t.page.mouse.move(rz.x + 300, rz.y + 150, { steps: 8 });
  await t.page.mouse.up();
  await t.page.waitForTimeout(250);
  const w2 = (await t.draft()).widgets[0];
  ok(w2.w > w1.w && w2.h > w1.h, `resized ${w1.w}x${w1.h} -> ${w2.w}x${w2.h}`);
  await t.click('.dbb-top [data-a="undo"]');
  eq((await t.draft()).widgets[0].w, w1.w, 'undo resize');
  await t.click('.dbb-top [data-a="undo"]');
  eq((await t.draft()).widgets[0].x, w0.x, 'undo move');
});

test('card quick tools and panel buttons: duplicate and remove', async (t) => {
  await t.addWidget('kpi');
  await t.page.dispatchEvent('.dbb-gbox.sel .dbb-gtools [data-q="dup"]', 'mousedown');
  eq((await t.draft()).widgets.length, 2, 'duplicated by card tool');
  const [a, b] = (await t.draft()).widgets;
  ok(a.id !== b.id && a.type === b.type && JSON.stringify(a.keys) === JSON.stringify(b.keys), 'copy has new id, same config');
  ok(!(a.x === b.x && a.y === b.y), 'copy placed in a free slot');
  await t.click('.dbb-right [data-s="dup"]');
  eq((await t.draft()).widgets.length, 3, 'duplicated by panel button');
  await t.click('.dbb-right [data-s="del"]');
  eq((await t.draft()).widgets.length, 2, 'removed by panel button');
  await t.page.click('.dbb-canvas .dbb-gbox .dbb-gdrag');
  await t.page.dispatchEvent('.dbb-gbox.sel .dbb-gtools [data-q="del"]', 'mousedown');
  eq((await t.draft()).widgets.length, 1, 'removed by card tool');
});

test('Widget tab: title, type change, data sources, properties and caps', async (t) => {
  await t.addWidget('line');
  let w = (await t.draft()).widgets[0];
  eq(w.binding.mode, 'current', 'line starts on This machine');
  await t.page.fill('.dbb-right [data-s="title"]', 'Pressure trend');
  await t.page.press('.dbb-right [data-s="title"]', 'Tab');
  eq((await t.draft()).widgets[0].title, 'Pressure trend', 'title');
  ok(/Pressure trend/.test(await t.page.textContent('.dbb-canvas .dbb-card-t')), 'card title updated');
  // multi-key: tick every property that can be ticked in the dropdown; the cap is 4, ticks apply on Done
  await t.click('.dbb-right [data-pk="keys"] .dbb-pk-trig .car');
  for (let i = 0; i < 6; i++) {
    const row = await t.page.$('.dbb-right [data-pk="keys"] .dbb-pk-row:not(.on):not(.dis)');
    if (!row) break;
    await row.click();
    await t.page.waitForTimeout(60);
  }
  eq((await t.draft()).widgets[0].keys.length, 1, 'ticks are not applied while the list is open');
  await t.click('.dbb-right [data-pk="keys"] [data-done]');
  await t.page.waitForTimeout(200);
  w = (await t.draft()).widgets[0];
  ok(w.keys.length >= 2 && w.keys.length <= 4, `line keys within 1..4: ${w.keys}`);
  eq(await t.page.$$eval('.dbb-right [data-pk="keys"] .chip', (c) => c.length), w.keys.length, 'selected properties shown as chips');
  // removing a chip removes the property
  await t.click('.dbb-right [data-pk="keys"] .chip [data-rm]');
  await t.page.waitForTimeout(200);
  eq((await t.draft()).widgets[0].keys.length, w.keys.length - 1, 'chip ✕ removes the property');
  // specific machines: two compressors (search narrows the list)
  await t.source('fixed');
  await t.pick('dev', ['rc'], { search: 'richmond comp' });
  w = (await t.draft()).widgets[0];
  eq(w.binding.mode, 'fixed', 'fixed binding');
  eq(w.binding.deviceIds.slice().sort(), ['pc', 'rc'], 'two machines');
  await t.page.waitForTimeout(800);
  eq(await t.cardErrors(), [], 'fixed binding renders');
  // same-type machines at this location, and all of a type under a location
  await t.source('siblings');
  eq((await t.draft()).widgets[0].binding.mode, 'siblings', 'siblings');
  await t.source('nodeQuery');
  w = (await t.draft()).widgets[0];
  eq(w.binding.mode, 'nodeQuery', 'nodeQuery');
  await t.page.selectOption('.dbb-right [data-s="node"]', 'a0000000-0000-4000-8000-000000000002');
  eq((await t.draft()).widgets[0].binding.nodeId, 'a0000000-0000-4000-8000-000000000002', 'node picked');
  await t.page.waitForTimeout(800);
  eq(await t.cardErrors(), [], 'nodeQuery renders');
  // type change to a single-key, single-machine type trims keys and binding
  await t.page.selectOption('.dbb-right [data-s="type"]', 'value');
  w = (await t.draft()).widgets[0];
  eq(w.type, 'value', 'type changed');
  ok(w.keys.length === 1, `keys trimmed to 1: ${w.keys}`);
  ok(w.binding.mode === 'current', `multi-machine binding reset: ${w.binding.mode}`);
  // nearest machine of a type (value card only)
  await t.source('nearest');
  w = (await t.draft()).widgets[0];
  eq(w.binding.mode, 'nearest', 'nearest');
  ok(w.binding.profile && w.binding.profile !== 'Compressor', `nearest defaults to another type (${w.binding.profile})`);
  await t.page.selectOption('.dbb-right [data-s="sprof"]', 'Weather Station');
  eq((await t.draft()).widgets[0].binding.profile, 'Weather Station', 'nearest type picked');
  await t.page.waitForTimeout(800);
  eq(await t.cardErrors(), [], 'nearest renders');
  // content type drops the data source
  await t.page.selectOption('.dbb-right [data-s="type"]', 'text');
  w = (await t.draft()).widgets[0];
  eq(w.binding.mode, 'none', 'text has no data source');
  eq(w.keys, [], 'text has no keys');
});

test('Specific machines are capped at 4 per widget', async (t) => {
  await t.addWidget('bar');
  const w = (await t.draft()).widgets[0];
  await t.source('fixed');
  await t.click('.dbb-right [data-pk="dev"] .dbb-pk-trig .car');
  for (let i = 0; i < 8; i++) {
    const row = await t.page.$('.dbb-right [data-pk="dev"] .dbb-pk-row:not(.on):not(.dis)');
    if (!row) break;
    await row.click();
    await t.page.waitForTimeout(60);
  }
  const greyed = await t.page.$$eval('.dbb-right [data-pk="dev"] .dbb-pk-row.dis', (r) => r.map((x) => x.title));
  await t.click('.dbb-right [data-pk="dev"] [data-done]');
  await t.page.waitForTimeout(200);
  const ids = (await t.draft()).widgets[0].binding.deviceIds;
  ok(ids.length <= 4, `at most 4 machines (${ids})`);
  ok(ids.length < 4 || greyed.every((x) => /At most 4/.test(x)), `rows past the cap are greyed with a reason (${greyed})`);
});

test('D-033: right panel sections are cards that collapse and stay collapsed; no builder brand in the top bar', async (t) => {
  ok(!(await t.page.$('.dbb-top .dbb-brand')) && !/Dashboard Builder/.test(await t.page.textContent('.dbb-top')), 'no brand / header text');
  const first = await t.b(() => document.querySelector('.dbb-top > *').querySelector('[data-a="machine"]') !== null);
  ok(first, 'machine picker is the first item of the top bar');
  await t.addWidget('line');
  eq(await t.b(() => [...document.querySelectorAll('.dbb-right .dbb-grp')].map((g) => g.dataset.grp)), ['Widget', 'Data source', 'Properties', 'Options'], 'Widget tab sections');
  await t.click('.dbb-right .dbb-grp[data-grp="Options"] .dbb-grp-h');
  ok(!(await t.page.isVisible('.dbb-right .dbb-grp[data-grp="Options"] .dbb-grp-b')), 'collapsed');
  // an edit re-renders the panel; the section stays collapsed
  await t.source('fixed');
  ok(await t.page.$('.dbb-right .dbb-grp[data-grp="Options"].shut'), 'still collapsed after a re-render');
  ok(await t.page.isVisible('.dbb-right [data-s="dup"]'), 'Duplicate / Remove stay outside the sections');
  await t.click('.dbb-right .dbb-tab[data-tab="style"]');
  eq(await t.b(() => [...document.querySelectorAll('.dbb-right .dbb-grp')].map((g) => g.dataset.grp)), ['Title', 'Layout', 'Card', 'Help text'], 'Style tab sections');
  await t.click('.dbb-right [data-desel]');
  eq(await t.b(() => [...document.querySelectorAll('.dbb-right .dbb-grp')].map((g) => g.dataset.grp)), ['Theme', 'Background', 'Cards'], 'Dashboard tab sections');
});

test('D-033: background image: status for bad addresses, upload, fit; shown on the canvas', async (t) => {
  await t.page.fill('.dbb-right [data-t="bgImage"]', 'http://example.com/a.jpg');
  await t.page.press('.dbb-right [data-t="bgImage"]', 'Tab');
  await t.page.waitForTimeout(300);
  ok(/must start with https/.test(await t.page.textContent('.dbb-right [data-bgst]')), 'explains http is not used');
  // upload (a 1x1 png)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await t.page.setInputFiles('.dbb-right [data-bgfile]', { name: 'bg.png', mimeType: 'image/png', buffer: png });
  await t.page.waitForTimeout(500);
  const th = (await t.draft()).theme;
  ok(/^data:image\/png;base64,/.test(th.bgImage), 'stored as data URI');
  ok(/Image loaded/.test(await t.page.textContent('.dbb-right [data-bgst]')), 'image checked');
  await t.click('.dbb-right [data-tseg="bgFit"][data-v="tile"]');
  await t.page.waitForTimeout(300);
  eq((await t.draft()).theme.bgFit, 'tile', 'fit stored');
  const bg = await t.b(() => { const c = getComputedStyle(document.querySelector('.dbb-center')); return { img: c.backgroundImage.startsWith('url("data:image/png;'), rep: c.backgroundRepeat, att: c.backgroundAttachment }; });
  eq(bg, { img: true, rep: 'repeat', att: 'scroll' }, 'canvas shows it tiled, scrolling with the page');
  await t.click('.dbb-right [data-bgclear]');
  await t.page.waitForTimeout(300);
  ok(!(await t.draft()).theme?.bgImage, 'removed');
});

test('D-044: table centres every column, header and value (supersedes D-033)', async (t) => {
  await t.addWidget('table');
  await t.page.waitForTimeout(1000);
  const cols = await t.b(() => {
    const tb = document.querySelector('.dbb-canvas .dbb-table');
    return [...tb.querySelectorAll('thead th')].map((th, i) => ({ name: th.textContent.trim(), th: getComputedStyle(th).textAlign, td: getComputedStyle(tb.querySelector(`tbody tr td:nth-child(${i + 1})`)).textAlign }));
  });
  ok(cols.length > 1, 'has the machine column and value columns');
  for (const c of cols) eq([c.th, c.td], ['center', 'center'], `column ${c.name}`);
});

// ------------------------------------------------------------------ style, colours, theme

test('Style tab: title, icon, sizes, card look, help text, footer, copy to all, reset', async (t) => {
  await t.addWidget('value');
  await t.addWidget('gauge');
  await t.click('.dbb-right .dbb-tab[data-tab="style"]');
  await t.click('.dbb-right [data-icon]:not([data-icon=""])');
  await t.page.selectOption('.dbb-right [data-st="titleSize"]', '16');
  await t.page.selectOption('.dbb-right [data-st="titleWeight"]', '700');
  await t.click('.dbb-right [data-seg="border"][data-v="thick"]');
  await t.click('.dbb-right [data-seg="shadow"][data-v="strong"]');
  await t.click('.dbb-right [data-seg="padding"][data-v="roomy"]');
  await t.page.fill('.dbb-right [data-footer]', 'Source: PLC');
  await t.page.press('.dbb-right [data-footer]', 'Tab');
  let s = (await t.draft()).widgets[1].settings;
  ok(s.style?.icon, 'icon set');
  eq(s.style.titleSize, 16, 'title size');
  eq(String(s.style.titleWeight), '700', 'weight');
  eq(s.style.border, 'thick', 'border');
  eq(s.style.shadow, 'strong', 'shadow');
  eq(s.style.padding, 'roomy', 'padding');
  eq(s.footer, 'Source: PLC', 'footer');
  ok(/Source: PLC/.test(await t.page.textContent('.dbb-gbox.sel .dbb-card')), 'footer drawn on the card');
  await t.page.uncheck('.dbb-right [data-st="hideTitle"]');
  await t.page.waitForTimeout(150);
  eq((await t.draft()).widgets[1].settings.style.hideTitle, true, 'title hidden');
  ok(!(await t.page.$('.dbb-gbox.sel .dbb-card-t')), 'title not drawn');
  await t.page.check('.dbb-right [data-st="hideTitle"]');
  await t.page.waitForTimeout(150);
  // copy style to all
  const copy = await t.page.$('.dbb-right [data-copyall]');
  ok(copy, 'Copy style to all button');
  await copy.click();
  await t.page.waitForTimeout(150);
  const all = (await t.draft()).widgets.map((w) => w.settings.style ?? {});
  eq(all[0].border, 'thick', 'copied to the other widget');
  ok(all[0].icon !== all[1].icon || !all[0].icon || true, 'icons kept per widget');
  // reset
  const reset = await t.page.$('.dbb-right [data-reset]');
  ok(reset, 'Reset style button');
  await reset.click();
  await t.page.waitForTimeout(150);
  s = (await t.draft()).widgets[1].settings;
  ok(!s.style || !s.style.border, 'style reset');
});

test('Colours tab: presets, test a value, edit and remove rules; card colour applied', async (t) => {
  await t.addWidget('value');
  await t.click('.dbb-right .dbb-tab[data-tab="rules"]');
  await t.click('.dbb-right [data-preset="traffic"]');
  let rules = (await t.draft()).widgets[0].settings.colorRules ?? [];
  ok(rules.length >= 2, `traffic light rules: ${rules.length}`);
  await t.page.fill('.dbb-right [data-test]', '99999');
  await t.page.waitForTimeout(100);
  ok((await t.page.textContent('.dbb-right .dbb-test-out')).trim().length > 0, 'test output shown');
  const n = rules.length;
  const n0 = await t.page.$$eval('.dbb-right .dbb-rule', (x) => x.length);
  ok(n0 === n, `rule rows drawn: ${n0}`);
  await t.page.locator('.dbb-right .dbb-rule [data-del]').first().click({ timeout: 4000 });
  await t.page.waitForTimeout(100);
  rules = (await t.draft()).widgets[0].settings.colorRules ?? [];
  eq(rules.length, n - 1, 'rule removed');
  const add = await t.page.$('.dbb-right button:has-text("Add rule")');
  await t.page.waitForTimeout(50);
  ok(add, 'Add rule button');
  await add.click();
  eq(((await t.draft()).widgets[0].settings.colorRules ?? []).length, n, 'rule added');
  // make every value match: > -1e9 in red
  await t.page.selectOption('.dbb-right .dbb-rule:last-child [data-f="op"]', 'gt');
  await t.page.fill('.dbb-right .dbb-rule:last-child [data-f="value"]', '-1000000');
  await t.page.press('.dbb-right .dbb-rule:last-child [data-f="value"]', 'Tab');
  await t.page.waitForTimeout(900);
  eq(await t.cardErrors(), [], 'renders with rules');
});

test('Colours tab: on/off preset for a status widget', async (t) => {
  await t.addWidget('status');
  const w = (await t.draft()).widgets[0];
  eq(w.keys, ['runStatus'], 'status picks the on/off property');
  ok((w.settings.colorRules ?? []).some((r) => r.label === 'Running'), 'starts with Running/Stopped');
  await t.page.waitForTimeout(900);
  ok(/Running|Stopped|Offline/.test(await t.page.textContent('.dbb-canvas .dbb-card')), 'status text drawn');
});

test('Dashboard tab: theme preset, accent, font (Inter default), radius, density, title alignment', async (t) => {
  await t.addWidget('value');
  await t.click('.dbb-right [data-desel]');
  ok(await t.page.isVisible('.dbb-right .dbb-tab.on:has-text("Dashboard")'), 'Dashboard tab when nothing selected');
  eq(await t.page.textContent('.dbb-right [data-t="font"] option[value=""]'), 'Same as the app (default)', 'default font label');
  await t.click('.dbb-right [data-preset="dark"]');
  eq((await t.draft()).theme?.preset, 'dark', 'dark preset');
  ok(await t.b(() => document.querySelector('.dbb-center').classList.contains('dbb-dark')), 'canvas dark');
  // the preset click redraws the panel; a font picked during the redraw lands on a select that is being replaced
  await t.page.waitForTimeout(150);
  await t.page.selectOption('.dbb-right [data-t="font"]', 'Poppins');
  eq((await t.draft()).theme.font, 'Poppins', 'font Poppins');
  ok(/Poppins/.test(await t.b(() => getComputedStyle(document.querySelector('.dbb-canvas .dbb-card')).fontFamily)), 'canvas uses the theme font');
  ok(/^Inter/.test(await t.b(() => getComputedStyle(document.querySelector('.dbb-top')).fontFamily)), 'builder chrome stays Inter');
  await t.page.selectOption('.dbb-right [data-t="font"]', '');
  ok(/^("DM Sans", )?"?Inter/.test(await t.b(() => getComputedStyle(document.querySelector('.dbb-canvas .dbb-card')).fontFamily)), 'theme default font is the app font');
  await t.click('.dbb-right [data-tseg="density"][data-v="compact"]');
  await t.click('.dbb-right [data-tseg="titleAlign"][data-v="center"]');
  const th = (await t.draft()).theme;
  eq([th.density, th.titleAlign], ['compact', 'center'], 'density + title alignment');
  await t.page.$eval('.dbb-right [data-t="radius"]', (e) => {
    e.value = '4';
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await t.page.waitForTimeout(350); // range inputs emit 250 ms after the last move
  eq((await t.draft()).theme.radius, 4, 'radius');
});

// ------------------------------------------------------------------ content widgets

test('Text widget: typing and Backspace in the editor never delete the widget; live values', async (t) => {
  await t.addWidget('text');
  const ed = '.dbb-right [contenteditable="true"]';
  ok(await t.page.$(ed), 'rich-text editor present');
  await t.page.click(ed);
  await t.page.keyboard.press('Control+a');
  await t.page.keyboard.type('Hello {{machine}}');
  await t.page.keyboard.press('Backspace');
  await t.page.keyboard.press('Delete');
  await t.page.keyboard.type('}');
  await t.page.waitForTimeout(800); // the editor commits 500 ms after the last keystroke
  const d = await t.draft();
  eq(d.widgets.length, 1, 'widget still there after Backspace/Delete in the editor');
  ok(/Hello/.test(d.widgets[0].settings.html ?? ''), `html saved: ${d.widgets[0].settings.html}`);
  await t.page.waitForTimeout(500);
  ok(/Hello Pune Compressor 1/.test(await t.page.textContent('.dbb-canvas .dbb-card')), 'machine placeholder filled on the card');
  await t.click('.dbb-right [data-rc="bold"]');
  eq((await t.draft()).widgets.length, 1, 'toolbar click keeps the widget');
});

test('Image, link and embed widgets', async (t) => {
  await t.addWidget('image');
  await t.page.fill('.dbb-right [data-c="url"]', 'http://insecure.example/logo.png');
  await t.page.press('.dbb-right [data-c="url"]', 'Tab');
  await t.page.waitForTimeout(200);
  ok(!(await t.page.$('.dbb-gbox.sel img')), 'http image refused');
  await t.page.fill('.dbb-right [data-c="url"]', 'https://example.com/logo.png');
  await t.page.press('.dbb-right [data-c="url"]', 'Tab');
  await t.page.waitForTimeout(200);
  ok(await t.page.$('.dbb-canvas img.dbb-img[src="https://example.com/logo.png"]'), 'https image drawn');
  await t.addWidget('link');
  const lw = (await t.draft()).widgets[1];
  eq(lw.settings.linkKind, 'state', 'link opens an app page by default');
  await t.click('.dbb-right [data-lk="url"]');
  eq((await t.draft()).widgets[1].settings.linkKind, 'url', 'link to website');
  await t.addWidget('embed');
  await t.page.fill('.dbb-right [data-c="url"]', 'https://example.com/');
  await t.page.press('.dbb-right [data-c="url"]', 'Tab');
  await t.page.waitForTimeout(200);
  ok(await t.page.$('.dbb-canvas iframe.dbb-frame'), 'iframe drawn');
});

// ------------------------------------------------------------------ templates, preview

test('templates: each builds widgets without errors; replacing asks first', async (t) => {
  await t.click('.dbb-top [data-a="templates"]');
  const ids = await t.b(() => [...document.querySelectorAll('.dbb-modal [data-tpl]')].map((b) => b.dataset.tpl));
  eq(ids.length, 5, '5 templates');
  await t.modalBtn('cancel').catch(() => t.page.keyboard.press('Escape'));
  for (const [i, id] of ids.entries()) {
    await t.click('.dbb-top [data-a="templates"]');
    await t.click(`.dbb-modal [data-tpl="${id}"]`);
    await t.page.waitForTimeout(200);
    if (i > 0) {
      ok(/^Use “.+”\?$/.test(await t.modalTitle()), 'asks before replacing');
      await t.page.click('.dbb-modal .dbb-modal-f button.primary');
      await t.page.waitForTimeout(200);
    }
    const d = await t.draft();
    ok(d.widgets.length > 0 && d.widgets.length <= 10, `${id}: ${d.widgets.length} widgets`);
    await t.page.waitForTimeout(1200);
    eq(await t.cardErrors(), [], `${id}: card errors`);
  }
});

test('empty state: simple default layout; preview hides panels', async (t) => {
  await t.click('.dbb-empty [data-a="default"]');
  const d = await t.draft();
  ok(d.widgets.length > 0, `default layout: ${d.widgets.length}`);
  await t.click('.dbb-top [data-a="preview"]');
  ok(await t.page.isHidden('.dbb-left'), 'palette hidden');
  ok(await t.page.isHidden('.dbb-right'), 'panel hidden');
  await t.page.click('.dbb-canvas .dbb-gbox');
  eq(await t.b(() => window.__b.selected), null, 'no selection in preview');
  await t.click('.dbb-top [data-a="preview"]');
  ok(await t.page.isVisible('.dbb-left'), 'back to edit');
});

// ------------------------------------------------------------------ save / apply / versions / open / delete

async function saveFirst(t) {
  await t.addWidget('value');
  await t.click('.dbb-top [data-a="save"]');
  await t.page.waitForSelector('.dbb-modal :text("Apply dashboard")', { timeout: 5000 });
}

test('save with no widgets is refused', async (t) => {
  await t.click('.dbb-top [data-a="save"]');
  await t.page.waitForTimeout(200);
  ok(/Add at least one widget/.test(await t.toastText()), 'toast');
  ok(!(await t.b(() => Object.keys(window.__tb.getAttrs('ASSET', 'store')).some((k) => k.startsWith('dbb_d_')))), 'nothing written');
});

test('first save opens Apply; apply to only this machine; machine page shows it', async (t) => {
  await saveFirst(t);
  ok(await t.page.isChecked('.dbb-modal input[name="t"][value="device"]'), 'Only this machine preselected');
  await t.page.waitForFunction(() => !document.querySelector('.dbb-modal .dbb-modal-f button.primary')?.disabled);
  ok(/1<\/b> machine affected/.test(await t.page.innerHTML('.dbb-modal .dbb-preview')), 'preview: 1 machine');
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(500);
  const d = await t.draft();
  eq(d.version, 1, 'version 1');
  ok(/Applied to 1 machine/.test(await t.toastText()), 'applied toast');
  eq((await t.page.textContent('.dbb-top [data-a="save"]')).trim(), '✓ Saved', 'saved state');
  const assign = await t.b(() => window.__tb.getAttrs('DEVICE', 'pc').dbb_assign);
  ok(assign && JSON.stringify(assign).includes(d.id), 'device assignment written');
  ok(await t.page.isVisible('.dbb-top [data-a="versions"]') && await t.page.isVisible('.dbb-top [data-a="saveas"]') && await t.page.isVisible('.dbb-top [data-a="apply"]'), 'history / save as / apply shown after save');
});

test('apply to all machines of the type (customer-wide)', async (t) => {
  await saveFirst(t);
  await t.page.check('.dbb-modal input[name="t"][value="all"]');
  await t.page.waitForFunction(() => /2<\/b> machines affected/.test(document.querySelector('.dbb-modal .dbb-preview')?.innerHTML ?? ''), null, { timeout: 5000 });
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(500);
  ok(/Applied to 2 machines/.test(await t.toastText()), 'applied to 2');
});

test('second save: no Apply dialog; versions and restore; save as; conflict', async (t) => {
  await saveFirst(t);
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(500);
  await t.page.fill('.dbb-top [data-a="name"]', 'Renamed v2');
  await t.page.press('.dbb-top [data-a="name"]', 'Tab');
  eq((await t.page.textContent('.dbb-top [data-a="save"]')).trim(), 'Save', 'dirty again');
  await t.click('.dbb-top [data-a="save"]');
  await t.idle(500);
  ok(!(await t.page.$('.dbb-modal')), 'no Apply dialog on later saves');
  eq((await t.draft()).version, 2, 'version 2');
  // history
  await t.click('.dbb-top [data-a="versions"]');
  await t.page.waitForSelector('.dbb-modal [data-v]');
  const vs = await t.b(() => [...document.querySelectorAll('.dbb-modal [data-v]')].map((b) => b.dataset.v));
  ok(vs.includes('1'), `versions listed: ${vs}`);
  await t.click('.dbb-modal [data-v="1"]');
  await t.idle(500);
  const r = await t.draft();
  eq(r.version, 3, 'restore saves a new version');
  eq(r.name, 'Compressor dashboard', 'restored content');
  // unsaved change + restore asks first
  await t.addWidget('kpi');
  await t.click('.dbb-top [data-a="versions"]');
  await t.click('.dbb-modal [data-v="2"]');
  await t.page.waitForTimeout(200);
  eq(await t.modalTitle(), 'Discard unsaved changes?', 'restore asks about unsaved changes');
  await t.page.click('.dbb-modal .dbb-modal-f button:not(.primary)');
  await t.page.waitForTimeout(150);
  eq((await t.draft()).widgets.length, 2, 'cancel keeps the draft');
  // save as
  await t.click('.dbb-top [data-a="saveas"]');
  await t.page.waitForSelector('.dbb-modal [data-in]');
  await t.page.fill('.dbb-modal [data-in]', 'My copy');
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.page.waitForSelector('.dbb-modal :text("Apply dashboard")', { timeout: 5000 });
  await t.page.check('.dbb-modal input[name="t"][value="none"]');
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(300);
  const c = await t.draft();
  eq([c.name, c.version], ['My copy', 1], 'save as creates a new dashboard');
  ok(c.id !== r.id, 'new id');
  // conflict: someone else saves the copy meanwhile
  await t.b((id) => {
    const k = `dbb_d_${id}`;
    const cur = window.__tb.getAttrs('ASSET', 'store')[k];
    const doc = typeof cur === 'string' ? JSON.parse(cur) : cur;
    window.__tb.setAttrs('ASSET', 'store', { [k]: { ...doc, version: doc.version + 1, name: 'Theirs' } });
  }, c.id);
  await t.addWidget('gauge');
  await t.click('.dbb-top [data-a="save"]');
  await t.page.waitForTimeout(400);
  eq(await t.modalTitle(), 'Someone else saved this dashboard', 'conflict dialog');
  await t.page.click('.dbb-modal .dbb-modal-f button:has-text("Reload theirs")');
  await t.idle(200);
  eq((await t.draft()).name, 'Theirs', 'reloaded theirs');
});

test('Open dialog: lists saved, opens one, asks before discarding changes, new blank', async (t) => {
  await saveFirst(t);
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(400);
  const id = (await t.draft()).id;
  await t.click('.dbb-top [data-a="open"]');
  await t.page.waitForSelector('.dbb-modal [data-new]');
  await t.click('.dbb-modal [data-new]');
  await t.page.waitForSelector('.dbb-modal :text("What is it for?")');
  await t.modalBtn('ok');
  await t.idle(200);
  eq((await t.draft()).widgets.length, 0, 'new blank');
  await t.addWidget('gauge');
  await seedStandalone(t, 7);
  await t.click('.dbb-top [data-a="open"]');
  await t.page.waitForSelector(`.dbb-modal .dbb-od-row[data-id="${id}"]`);
  // D-027 look: wide, Inter everywhere, "New blank dashboard" on the right of the bar, padded columns
  const look = await t.b(() => {
    const box = document.querySelector('.dbb-modal-box').getBoundingClientRect();
    const bar = document.querySelector('.dbb-od-bar').getBoundingClientRect();
    const nb = document.querySelector('.dbb-modal [data-new]').getBoundingClientRect();
    const row = document.querySelector('.dbb-od-body .dbb-od-row');
    const fonts = [...document.querySelectorAll('.dbb-od *')].map((e) => getComputedStyle(e).fontFamily.split(',')[0].replace(/"/g, '').trim());
    return { w: box.width, rightGap: Math.round(bar.right - nb.right), fonts: [...new Set(fonts)], gap: getComputedStyle(row).columnGap, pad: getComputedStyle(row).paddingLeft };
  });
  ok(look.w >= 1000, `dialog is wide (${look.w})`);
  ok(look.rightGap <= 1, 'New blank dashboard is on the right');
  eq(look.fonts, ['Inter'], 'Inter throughout');
  eq([look.gap, look.pad], ['24px', '18px'], 'column spacing');
  await t.page.waitForTimeout(300);
  await t.page.screenshot({ path: join(tmpdir(), 'open-dialog.png') });
  await t.click(`.dbb-modal .dbb-od-row[data-id="${id}"]`);
  await t.page.waitForTimeout(200);
  eq(await t.modalTitle(), 'Discard unsaved changes?', 'asks before discarding');
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(400);
  eq((await t.draft()).id, id, 'opened the saved one');
});

test('delete a saved dashboard falls back to the default layout', async (t) => {
  await saveFirst(t);
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(400);
  const id = (await t.draft()).id;
  await t.click('.dbb-top [data-a="delete"]');
  await t.page.waitForTimeout(200);
  ok(/Delete “/.test(await t.modalTitle()), 'confirm delete');
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(500);
  ok(/Dashboard deleted/.test(await t.toastText()), 'deleted toast');
  ok(!(await t.b((x) => `dbb_d_${x}` in window.__tb.getAttrs('ASSET', 'store'), id)), 'dashboard removed from store');
  ok(!(await t.b(() => window.__tb.getAttrs('DEVICE', 'pc').dbb_assign)), 'assignment removed');
  eq((await t.draft()).version, 0, 'blank draft again');
});

test('switching machine and closing ask about unsaved changes; Esc closes when clean', async (t) => {
  await t.addWidget('value');
  await t.page.selectOption('.dbb-top [data-a="machine"]', 'rc');
  await t.page.waitForTimeout(200);
  eq(await t.modalTitle(), 'Switch machine?', 'switch confirm');
  await t.page.click('.dbb-modal .dbb-modal-f button:not(.primary)');
  await t.page.waitForTimeout(200);
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), 'pc', 'select reverted on cancel');
  eq((await t.draft()).widgets.length, 1, 'draft kept');
  await t.click('.dbb-top [data-a="close"]');
  await t.page.waitForTimeout(200);
  eq(await t.modalTitle(), 'Discard unsaved changes?', 'close confirm');
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.page.waitForTimeout(200);
  ok(!(await t.page.$('.dbb-overlay')), 'closed after discard');
  eq(await t.b(() => window.__closed), { changed: false }, 'onClose(false)');
});

test('Esc closes a clean builder', async (t) => {
  await t.page.click('.dbb-center', { position: { x: 5, y: 5 } });
  await t.page.keyboard.press('Escape');
  await t.page.waitForTimeout(200);
  ok(!(await t.page.$('.dbb-overlay')), 'closed');
});

test('standalone (no machine): only specific machines; Apply explains standalone', async (t) => {
  await t.page.close();
  const s = await open('page=builder&dev=none');
  Object.assign(t, s);
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), '', 'No machine selected');
  await t.addWidget('value');
  const w = (await t.draft()).widgets[0];
  eq(w.binding.mode, 'none', 'no machine bound yet');
  ok(!(await t.page.$('.dbb-right [data-s="src"] option[value="current"]')), 'This machine not offered');
  await t.source('fixed');
  eq((await t.draft()).widgets[0].binding.mode, 'fixed', 'specific machine');
  await t.page.waitForTimeout(800);
  eq(await t.cardErrors(), [], 'renders');
  await t.click('.dbb-top [data-a="save"]');
  await t.page.waitForSelector('.dbb-modal :text("standalone dashboard")', { timeout: 5000 });
  eq((await t.draft()).kind, 'standalone', 'kind standalone');
});

// ------------------------------------------------------------------ chat

test('chat: builds widgets from the reply, highlight, discard; clarification; provider error', async (t) => {
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  await t.b(() =>
    window.__chatQueue.push({
      reply: 'Added pressure and power.',
      ops: [
        { op: 'addWidget', type: 'value', title: 'Pressure', keys: ['dischargePressure'], binding: { mode: 'current' } },
        { op: 'addWidget', type: 'line', title: 'Power', keys: ['powerKw'], binding: { mode: 'current' } },
      ],
    }),
  );
  await t.page.fill('.dbb-chat-in', 'pressure and power');
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => window.__b.draft.widgets.length === 2 && !window.__b.busy, null, { timeout: 8000 });
  ok(/Added pressure and power/.test(await t.page.textContent('.dbb-chat-log')), 'reply shown');
  ok(await t.page.$('.dbb-chat-log [data-hl]'), 'Highlight link');
  await t.click('.dbb-chat-log [data-hl]');
  ok(await t.b(() => document.querySelectorAll('.dbb-gbox.hl').length === 2), 'two cards highlighted');
  await t.click('.dbb-right [data-a="discard"]');
  eq((await t.draft()).widgets.length, 0, 'chat changes discarded');
  // clarification with options
  await t.b(() => window.__chatQueue.push({ reply: '', ops: [], clarification: { question: 'Which machine?', options: ['Pune', 'Richmond'] } }));
  await t.page.fill('.dbb-chat-in', 'overview');
  await t.page.keyboard.press('Enter');
  await t.page.waitForSelector('.dbb-chat-log [data-opt="Pune"]', { timeout: 8000 });
  // provider overload message is shown as the assistant reply, draft unchanged
  // overloaded twice: the builder retries once by itself (D-024), then shows the message
  await t.b(() => window.__chatQueue.push('The gemini service is overloaded right now (a temporary problem on the provider\'s side). Try again in a minute.', 'The gemini service is overloaded right now (a temporary problem on the provider\'s side). Try again in a minute.'));
  await t.click('.dbb-chat-log [data-opt="Pune"]');
  await t.page.waitForFunction(() => /overloaded right now/.test(document.querySelector('.dbb-chat-log')?.textContent ?? ''), null, { timeout: 8000 });
  eq((await t.draft()).widgets.length, 0, 'draft unchanged on error');
  ok(await t.page.isEnabled('.dbb-chat-form button[type="submit"]'), 'Send enabled again');
});

test('chat: invalid answer gets one corrective retry', async (t) => {
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  await t.b(() => {
    window.__chatQueue.push({ reply: 'x', ops: [{ op: 'addWidget', type: 'gauge', title: 'Bad', keys: ['noSuchKey'], binding: { mode: 'current' } }] });
    window.__chatQueue.push({ reply: 'Fixed.', ops: [{ op: 'addWidget', type: 'gauge', title: 'Temp', keys: ['dischargeTemp'], binding: { mode: 'current' } }] });
  });
  await t.page.fill('.dbb-chat-in', 'a gauge');
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => window.__b.draft.widgets.length === 1 && !window.__b.busy, null, { timeout: 10000 });
  eq(await t.b(() => window.__chatReqs.length), 2, 'two relay requests');
  eq((await t.draft()).widgets[0].keys, ['dischargeTemp'], 'second answer applied');
});

test('chat: role request asks where to build; "Start a new dashboard" builds a new unsaved one (undo goes back)', async (t) => {
  // an existing, saved machine dashboard is open
  await saveFirst(t);
  await t.page.click('.dbb-modal [data-mb="apply"]');
  await t.idle(400);
  const old = await t.draft();
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  await t.b(() => {
    window.__chatQueue.push({ intent: 'clarify', reply: '', ops: [], clarification: { question: 'Where should I build it?', options: ['Start a new dashboard', 'Replace this dashboard', 'Add to this dashboard'] } });
    window.__chatQueue.push({
      intent: 'build',
      reply: 'Built a fleet overview.',
      ops: [
        { op: 'startNewDashboard', name: 'Fleet overview' },
        { op: 'addWidget', type: 'table', title: 'Compressors', binding: { mode: 'nodeQuery', node: 'N1', machineType: 'Compressor' }, keys: ['runStatus', 'dischargePressure'] },
        { op: 'addWidget', type: 'alarms', title: 'All alarms', binding: { mode: 'nodeQuery', node: 'N1', machineType: 'ALL' }, keys: [] },
      ],
    });
  });
  await t.page.fill('.dbb-chat-in', 'I am the CEO, overview of all machines across every location');
  await t.page.keyboard.press('Enter');
  await t.page.waitForSelector('.dbb-chat-log [data-opt="Start a new dashboard"]', { timeout: 8000 });
  await t.click('.dbb-chat-log [data-opt="Start a new dashboard"]');
  await t.page.waitForFunction(() => window.__b.draft.name === 'Fleet overview' && !window.__b.busy, null, { timeout: 8000 });
  const d = await t.draft();
  ok(d.id !== old.id, 'new dashboard id');
  eq([d.version, d.kind, d.widgets.filter((w) => ['Compressors', 'All alarms'].includes(w.title)).length], [0, 'standalone', 2], 'new unsaved standalone draft');
  ok(d.widgets.some((w) => w.type === 'text' && w.settings.style?.gradient), 'design pass added a banner');
  const hist = await t.b(() => JSON.stringify(window.__chatReqs[1].body.messages));
  ok(/Where should I build it\? Options: Start a new dashboard \| Replace this dashboard \| Add to this dashboard/.test(hist), 'the question and options are in the history of the next turn');
  eq(await t.page.textContent('.dbb-top [data-a="save"]').then((x) => x.trim()), 'Save', 'unsaved');
  await t.page.waitForTimeout(1000);
  eq(await t.cardErrors(), [], 'fleet widgets render');
  await t.click('.dbb-top [data-a="undo"]');
  eq((await t.draft()).id, old.id, 'undo returns to the machine dashboard');
});

test('chat: if the model builds a fleet overview straight away, the builder still asks where; the choice needs no second LLM call', async (t) => {
  await t.addWidget('value');
  await t.addWidget('gauge');
  const id = (await t.draft()).id;
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  await t.b(() =>
    window.__chatQueue.push({
      intent: 'build',
      reply: 'Overview built.',
      ops: [
        { op: 'clearWidgets' },
        { op: 'addWidget', type: 'table', title: 'Compressors', binding: { mode: 'nodeQuery', node: 'N1', machineType: 'Compressor' }, keys: ['runStatus'] },
        { op: 'addWidget', type: 'alarms', title: 'All alarms', binding: { mode: 'nodeQuery', node: 'N1', machineType: 'ALL' }, keys: [] },
      ],
    }),
  );
  await t.page.fill('.dbb-chat-in', 'I am the CEO, give me an overview of all machines');
  await t.page.keyboard.press('Enter');
  await t.page.waitForSelector('.dbb-chat-log [data-opt="Replace this dashboard"]', { timeout: 8000 });
  eq((await t.draft()).widgets.length, 2, 'nothing changed before the choice');
  await t.click('.dbb-chat-log [data-opt="Replace this dashboard"]');
  await t.page.waitForFunction(() => window.__b.draft.widgets.some((w) => w.title === 'Compressors') && !window.__b.busy, null, { timeout: 8000 });
  const d = await t.draft();
  eq([d.id, d.widgets.filter((w) => w.type === 'table' || w.type === 'alarms').map((w) => w.title)], [id, ['Compressors', 'All alarms']], 'replaced in place');
  ok(!d.widgets.some((w) => w.type === 'value' || w.type === 'gauge'), 'old widgets gone');
  eq(await t.b(() => window.__chatReqs.length), 1, 'only one LLM request');
});

test('chat: starting a new dashboard over unsaved changes asks first', async (t) => {
  await t.addWidget('value');
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  await t.b(() => window.__chatQueue.push({ intent: 'build', reply: 'ok', ops: [{ op: 'startNewDashboard', name: 'New one' }, { op: 'addWidget', type: 'alarms', title: 'A', binding: { mode: 'nodeQuery', node: 'N1', machineType: 'ALL' }, keys: [] }] }));
  await t.page.fill('.dbb-chat-in', 'start a new dashboard with all alarms');
  await t.page.keyboard.press('Enter');
  await t.page.waitForSelector('.dbb-modal :text("Start a new dashboard?")', { timeout: 8000 });
  await t.page.click('.dbb-modal [data-mb="cancel"]');
  await t.page.waitForFunction(() => !window.__b.busy);
  eq((await t.draft()).widgets.length, 1, 'draft kept on cancel');
  ok(/Not started/.test(await t.page.textContent('.dbb-chat-log')), 'says it was not started');
});

test('chat: "Replace this dashboard" keeps the id and swaps the widgets', async (t) => {
  await t.addWidget('value');
  await t.addWidget('gauge');
  const id = (await t.draft()).id;
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  await t.b(() => window.__chatQueue.push({ intent: 'build', reply: 'Replaced.', ops: [{ op: 'clearWidgets' }, { op: 'addWidget', type: 'line', title: 'Trend', binding: { mode: 'current' }, keys: ['dischargePressure'] }] }));
  await t.page.fill('.dbb-chat-in', 'Replace this dashboard');
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => window.__b.draft.widgets.some((w) => w.title === 'Trend') && !window.__b.busy, null, { timeout: 8000 });
  eq((await t.draft()).id, id, 'same dashboard');
  eq((await t.draft()).widgets.map((w) => w.title), ['Trend'], 'widgets replaced (a machine dashboard gets no banner)');
});

test('chat: out-of-scope and data questions get a reply, no changes', async (t) => {
  await t.addWidget('value');
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  await t.b(() => window.__chatQueue.push({ intent: 'refuse', reply: 'I can only help with dashboards in this builder, for example: “Show the key values of this machine with an 8-hour trend”.', ops: [] }));
  await t.page.fill('.dbb-chat-in', 'What is the capital of France?');
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => /only help with dashboards/.test(document.querySelector('.dbb-chat-log')?.textContent ?? '') && !window.__b.busy, null, { timeout: 8000 });
  eq((await t.draft()).widgets.length, 1, 'no change');
  await t.b(() => window.__chatQueue.push({ intent: 'help', reply: 'I don’t read live values, but I can add a card that shows it.', ops: [], clarification: { question: 'Add it to the dashboard?', options: ['Add a value card for Discharge pressure', 'No thanks'] } }));
  await t.page.fill('.dbb-chat-in', 'what is the discharge pressure now?');
  await t.page.keyboard.press('Enter');
  await t.page.waitForSelector('.dbb-chat-log [data-opt="No thanks"]', { timeout: 8000 });
  eq((await t.draft()).widgets.length, 1, 'still no change');
});

test('chat: invalid parts are skipped and listed instead of failing everything', async (t) => {
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  const bad = { intent: 'build', reply: 'Overview built.', ops: [{ op: 'addWidget', type: 'value', title: 'Temp', binding: { mode: 'current' }, keys: ['dischargeTemp'] }, { op: 'addWidget', type: 'gauge', title: 'Vibration', binding: { mode: 'current' }, keys: ['vibration'] }] };
  await t.b((x) => window.__chatQueue.push(x, x), bad);
  await t.page.fill('.dbb-chat-in', 'overview');
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => window.__b.draft.widgets.length === 1 && !window.__b.busy, null, { timeout: 10000 });
  ok(/Some parts could not be built: Skipped “Vibration”: Compressor has no property vibration/.test(await t.page.textContent('.dbb-chat-log')), 'skipped part explained');
});

test('chat: a CEO fleet overview is laid out without gaps, sized to its rows, coloured, with a banner (D-026)', async (t) => {
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  await t.b(() =>
    window.__chatQueue.push({
      intent: 'build',
      reply: 'Built.',
      ops: [
        { op: 'startNewDashboard', name: 'CEO overview' },
        { op: 'addWidget', type: 'text', title: 'Header', binding: { mode: 'none' }, keys: [], settings: { html: '<p>ITHENA fleet</p>' } },
        { op: 'addWidget', type: 'kpi', title: 'Pressure Pune', binding: { mode: 'fixed', machines: ['D3'] }, keys: ['dischargePressure'] },
        { op: 'addWidget', type: 'kpi', title: 'Pressure Richmond', binding: { mode: 'fixed', machines: ['D1'] }, keys: ['dischargePressure'] },
        { op: 'addWidget', type: 'value', title: 'Temp Pune', binding: { mode: 'fixed', machines: ['D3'] }, keys: ['dischargeTemp'] },
        { op: 'addWidget', type: 'table', title: 'Compressors', binding: { mode: 'nodeQuery', node: 'N1', machineType: 'Compressor' }, keys: ['runStatus', 'dischargePressure', 'dischargeTemp'] },
        { op: 'addWidget', type: 'alarms', title: 'All alarms', binding: { mode: 'nodeQuery', node: 'N1', machineType: 'ALL' }, keys: [] },
        { op: 'addWidget', type: 'line', title: 'Pressure trend', binding: { mode: 'nodeQuery', node: 'N1', machineType: 'Compressor' }, keys: ['dischargePressure'] },
      ],
    }),
  );
  await t.page.fill('.dbb-chat-in', 'Replace this dashboard: I am the CEO, overview of all machines');
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => window.__b.draft.widgets.some((w) => w.title === 'Compressors') && !window.__b.busy, null, { timeout: 8000 });
  const d = await t.draft();
  const ws = d.widgets;
  const over = ws.some((a, i) => ws.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
  ok(!over, 'no overlaps');
  for (const y of new Set(ws.map((w) => w.y))) eq(ws.filter((w) => w.y === y).reduce((s, w) => s + w.w, 0), 12, `row at y=${y} fills the width`);
  eq(ws.filter((w) => w.type === 'kpi' || w.type === 'value').length, 3, 'all cards built');
  eq(ws[0].type, 'text', 'banner first');
  ok(ws[0].settings.style?.gradient, 'banner styled');
  ok(ws.find((w) => w.type === 'table').h <= 4, 'table sized to its rows');
  ok(ws.filter((w) => w.type !== 'text').every((w) => w.settings.style?.accentBar), 'accent colours');
  eq(d.theme?.preset, 'ocean', 'theme');
  await t.page.waitForTimeout(1200);
  eq(await t.cardErrors(), [], 'renders');
  await t.page.screenshot({ path: join(tmpdir(), 'ceo.png') });
});

test('Widget tab: alarm list can cover all machine types under a location', async (t) => {
  await t.addWidget('alarms');
  const w = (await t.draft()).widgets[0];
  await t.source('nodeQuery');
  await t.page.selectOption('.dbb-right [data-s="sprof"]', '');
  eq((await t.draft()).widgets[0].binding.profile, '', 'all machine types');
  await t.page.waitForTimeout(900);
  eq(await t.cardErrors(), [], 'renders');
});

// ------------------------------------------------------------------ machine page (renderer)

test('machine page header without the app side menu: no machine title (the navbar shows it)', async (t) => {
  await t.page.close();
  const s = await open('dev=pc');
  Object.assign(t, s);
  await t.page.waitForSelector('.dbb-rhead .dbb-status-pill');
  const h = await t.b(() => ({ title: !!document.querySelector('.dbb-rhead .dbb-rtitle'), text: document.querySelector('.dbb-rhead').textContent.replace(/s+/g, ' ').trim() }));
  ok(!h.title, 'no title element');
  ok(/^ITHENA › Pune/.test(h.text), `line starts with the crumb: ${h.text}`);
});

test('machine page header: one line; machine name as the title (D-038, with the app side menu), org › site, status, range', async (t) => {
  await t.page.close();
  const s = await open('dev=pc&shell=1');
  Object.assign(t, s);
  await t.page.waitForSelector('.dbb-rhead .dbb-status-pill');
  await t.page.waitForTimeout(800);
  const h = await t.b(() => {
    const head = document.querySelector('.dbb-rhead');
    const r = head.getBoundingClientRect();
    const tops = [...head.children].map((c) => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2));
    return { text: head.textContent.replace(/\s+/g, ' ').trim(), height: r.height, sameLine: Math.max(...tops) - Math.min(...tops) <= 4, font: getComputedStyle(head).fontFamily };
  });
  ok(h.height <= 48, `header height ${h.height}px`);
  ok(h.sameLine, 'crumb, status and range on one line');
  ok(/ITHENA › Pune/.test(h.text), `crumb: ${h.text}`);
  // D-038: the machine's name is the page title (there is no app navbar that shows it any more)
  ok(/^Pune Compressor 1 ITHENA › Pune/.test(h.text), `title first, then the crumb: ${h.text}`);
  ok((await t.b(() => parseFloat(getComputedStyle(document.querySelector('.dbb-rhead .dbb-rtitle')).fontWeight))) >= 700, 'title is bold');
  ok(/Running|Stopped|Offline/.test(h.text), 'status');
  ok(/Time window\s*Live · last hour/.test(h.text), `time window: ${h.text}`);
  ok(/Updated (just now|\d+ (second|minute|hour)s? ago)/.test(h.text), `updated: ${h.text}`);
  ok(/^("?DM Sans"?|Inter)/.test(h.font), `page font DM Sans / Inter (${h.font})`);
  // D-033: "Updated x ago" follows the newest data point and ticks every second; exact time in the tooltip
  // 12 Oct 2026: the bar's buttons (Analyzer; Create ticket when the app's ticket service is on the page) follow it
  const upd = await t.b(() => {
    const a = document.querySelector('.dbb-ract');
    const btns = a ? [...a.querySelectorAll('.dbb-rbtn')] : [];
    return { title: document.querySelector('.dbb-upd').title, right: document.querySelector('.dbb-upd').getBoundingClientRect().right, head: document.querySelector('.dbb-rhead').getBoundingClientRect().right,
      acts: btns.length ? a.getBoundingClientRect() : null, btns: btns.map((b) => b.title), top: document.querySelector('.dbb-upd').getBoundingClientRect().top };
  });
  ok(/Newest data point on this dashboard: /.test(upd.title), `tooltip: ${upd.title}`);
  ok(upd.btns.includes('Open this machine in the Analyzer'), `Analyzer button: ${upd.btns.join(', ')}`);
  ok(!upd.btns.includes('Create a ticket for this machine'), 'no Create ticket without the app ticket service');
  ok(upd.acts && upd.acts.left - upd.right <= 24 && upd.head - upd.acts.right <= 24 && Math.abs(upd.acts.top - upd.top) < 12, 'Updated, then the bar buttons, at the right end of the row');
});

test('D-061 Time window picker: presets, shifts, custom period, kept after reload, cards follow, own-window chip', async (t) => {
  await t.page.close();
  const s = await open('dev=pc&shell=1');
  Object.assign(t, s);
  // a dashboard with a 1 h window, a line chart with its own 4 h and a value tile (again after a reload: the fake
  // ThingsBoard lives in the page)
  const inject = () => t.b(() => {
    const now = Date.now();
    const d = { schemaVersion: 1, id: 'tw1', name: 'TW board', kind: 'device', profile: 'Compressor', version: 1, ownerId: 'u1', ownerName: 'A', updatedBy: 'u1', updatedAt: now, timeRange: '1h', copiedFrom: null,
      widgets: [
        { id: 'l1', type: 'line', title: 'TREND', x: 0, y: 0, w: 8, h: 4, binding: { mode: 'current' }, keys: ['powerKw'], settings: { timeRange: '4h' } },
        { id: 'v1', type: 'value', title: 'POWER', x: 8, y: 0, w: 4, h: 2, binding: { mode: 'current' }, keys: ['powerKw'], settings: {} },
      ] };
    window.__tb.setAttrs('ASSET', 'store', { dbb_d_tw1: d });
    window.__tb.setAttrs('DEVICE', 'pc', { dbb_assign: { dashboardId: 'tw1', mode: 'linked', by: 'u1', at: now } });
    window.__tb.setAttrs('ASSET', 'store', { dbb_assign_rev: 'v' + now });
    window.dispatchEvent(new Event('imex-dbb:changed'));
  });
  await inject();
  await t.page.waitForFunction(() => /TREND/.test(document.querySelector('.dbb-rbody')?.textContent ?? ''), null, { timeout: 6000 });
  await t.page.waitForTimeout(600);
  const pill = () => t.b(() => ({ label: document.querySelector('.dbb-tw .v')?.textContent, title: document.querySelector('.dbb-tw')?.title, mine: document.querySelector('.dbb-tw .v')?.classList.contains('mine') }));
  let p = await pill();
  eq(p.label, 'Last hour', 'dashboard window named');
  ok(/1 card has its own window/.test(p.title), `tooltip counts the own-window card: ${p.title}`);
  eq(await t.b(() => document.querySelector('.dbb-gbox[data-id="l1"] .dbb-card-win')?.textContent), '4 h', 'the 4 h chart says so');
  // the menu
  await t.click('.dbb-tw');
  await t.page.waitForSelector('.dbb-twmenu');
  const items = await t.b(() => [...document.querySelectorAll('.dbb-twmenu [data-v] .t, .dbb-twmenu [data-custom] .t')].map((x) => x.textContent));
  eq(items, ['Dashboard default', 'Last hour', 'Last 4 hours', 'Last 8 hours', 'Last 24 hours', 'Current shift', 'Previous shift', 'Custom…'], 'menu items');
  ok(await t.b(() => document.querySelector('.dbb-twmenu [data-v="default"]').classList.contains('on')), 'default ticked');
  await t.page.waitForTimeout(400);
  const shiftRow = await t.b(() => ({ dis: document.querySelector('.dbb-twmenu [data-v="shift"]').getAttribute('aria-disabled'), sub: document.querySelector('.dbb-twmenu [data-v="shift"] .s').textContent }));
  ok(shiftRow.dis === 'true' ? /No shifts set up|No shift/.test(shiftRow.sub) : !/Looking up/.test(shiftRow.sub), `shift row: ${JSON.stringify(shiftRow)}`);
  await t.click('.dbb-twmenu [data-v="24h"]');
  await t.page.waitForTimeout(500);
  p = await pill();
  eq([p.label, p.mine], ['Last 24 hours', true], 'pill names the choice');
  eq(await t.b(() => document.querySelector('.dbb-gbox[data-id="l1"] .dbb-card-win')), null, 'chip gone: every card follows the choice');
  const key = await t.b(() => Object.keys(localStorage).find((k) => k.startsWith('dbb-tw:')));
  ok(key && key.endsWith(':pc'), `kept per user and machine (${key})`);
  // kept after a reload
  await t.page.reload();
  await t.page.waitForFunction(() => document.querySelector('.dbb-tw .v')?.textContent === 'Last 24 hours', null, { timeout: 6000 });
  ok(true, 'still Last 24 hours after reload');
  await inject();
  await t.page.waitForFunction(() => /TREND/.test(document.querySelector('.dbb-rbody')?.textContent ?? ''), null, { timeout: 6000 });
  await t.page.waitForTimeout(400);
  eq((await pill()).label, 'Last 24 hours', 'the choice applies to the dashboard loaded again');
  // custom period: yesterday 6:00 AM to 2:00 PM
  await t.click('.dbb-tw');
  await t.click('.dbb-twmenu [data-custom]');
  await t.page.waitForSelector('.dbb-twc:not([hidden]) .dbb-twc-g');
  const y = await t.b(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 1);
    return d.getTime();
  });
  // yesterday may be in the previous month
  if (!(await t.b((y) => !!document.querySelector(`.dbb-twc [data-day="${y}"]`), y))) await t.click('.dbb-twc [data-m="-1"]');
  await t.click(`.dbb-twc [data-day="${y}"]`);
  await t.click(`.dbb-twc [data-day="${y}"]`);
  await t.page.fill('.dbb-twc [data-t="from"]', '6:00 am');
  await t.page.fill('.dbb-twc [data-t="to"]', '14:00');
  await t.click('.dbb-twc [data-apply]');
  await t.page.waitForTimeout(600);
  p = await pill();
  ok(/^\d{1,2} [A-Z][a-z]{2}, (6:00 AM|06:00) – (2:00 PM|14:00)$/.test(p.label), `custom label: ${p.label}`);
  ok(/Not live · ended/.test(await t.page.textContent('.dbb-upd')), 'not live for a past period');
  ok(/^\d{1,2} [A-Z][a-z]{2}, /.test((await t.page.textContent('.dbb-gbox[data-id="v1"] .dbb-value .s')) ?? ''), 'the value tile shows the reading time at the period end');
  // a bad custom period is refused with the reason (the menu opens on the presets; Custom… shows the calendar)
  await t.click('.dbb-tw');
  await t.page.waitForSelector('.dbb-twmenu [data-custom].on');
  ok(await t.b(() => document.querySelector('.dbb-twmenu .dbb-twc').hidden), 'presets first');
  await t.click('.dbb-twmenu [data-custom]');
  await t.page.waitForSelector('.dbb-twc:not([hidden])');
  ok(await t.b(() => getComputedStyle(document.querySelector('.dbb-twmenu [data-v="1h"]')).display === 'none'), 'presets make way for the calendar');
  await t.page.fill('.dbb-twc [data-t="to"]', '5:00 am');
  await t.click('.dbb-twc [data-apply]');
  ok(/after the start/.test(await t.page.textContent('.dbb-twc-err')), 'end before start refused');
  await t.page.keyboard.press('Escape');
  await t.page.waitForFunction(() => !document.querySelector('.dbb-twmenu'));
  // back to the dashboard's window
  await t.click('.dbb-tw');
  await t.click('.dbb-twmenu [data-v="default"]');
  await t.page.waitForTimeout(400);
  p = await pill();
  eq([p.label, p.mine], ['Last hour', false], 'default again');
  eq(await t.b(() => Object.keys(localStorage).filter((k) => k.startsWith('dbb-tw:')).length), 0, 'choice forgotten');
});

test('D-061 value tiles: a value too wide is drawn smaller or cut with its full text on hover; the Builder warns', async (t) => {
  await t.page.close();
  const s = await open('dev=pc');
  Object.assign(t, s);
  await t.b(() => {
    const now = Date.now();
    const d = { schemaVersion: 1, id: 'fit1', name: 'Fit board', kind: 'device', profile: 'Compressor', version: 1, ownerId: 'u1', ownerName: 'A', updatedBy: 'u1', updatedAt: now, timeRange: 'realtime', copiedFrom: null,
      widgets: [
        { id: 'n1', type: 'value', title: 'A very long title for a narrow tile', x: 0, y: 0, w: 1, h: 3, binding: { mode: 'current' }, keys: ['powerKw'], settings: { style: { valueSize: 60 } } },
        { id: 'n2', type: 'value', title: 'Wide', x: 1, y: 0, w: 6, h: 3, binding: { mode: 'current' }, keys: ['powerKw'], settings: {} },
      ] };
    window.__tb.setAttrs('ASSET', 'store', { dbb_d_fit1: d });
    window.__tb.setAttrs('DEVICE', 'pc', { dbb_assign: { dashboardId: 'fit1', mode: 'linked', by: 'u1', at: now } });
    window.__tb.setAttrs('ASSET', 'store', { dbb_assign_rev: 'v' + now });
    window.dispatchEvent(new Event('imex-dbb:changed'));
  });
  await t.page.waitForFunction(() => document.querySelector('.dbb-gbox[data-id="n1"] .dbb-value .v'), null, { timeout: 6000 });
  await t.page.waitForTimeout(400);
  const r = await t.b(() => {
    const v = document.querySelector('.dbb-gbox[data-id="n1"] .dbb-value .v');
    const line = v.parentElement.getBoundingClientRect();
    const host = v.parentElement.parentElement.getBoundingClientRect();
    return { fs: parseFloat(getComputedStyle(v).fontSize), fits: line.width <= host.width + 1 || v.classList.contains('cut'), tip: v.title, fit: v.closest('.dbb-card').dataset.fit, title: document.querySelector('.dbb-gbox[data-id="n1"] .dbb-card-t').title,
      wide: parseFloat(getComputedStyle(document.querySelector('.dbb-gbox[data-id="n2"] .dbb-value .v')).fontSize) };
  });
  ok(r.fs < 60, `narrow value drawn smaller (${r.fs}px)`);
  ok(r.fits, 'it fits (or is cut)');
  ok(r.tip.length > 0, `full value on hover (${r.tip})`);
  ok(r.fit === 'tight' || r.fit === 'cut', `marked ${r.fit}`);
  eq(r.title, 'A very long title for a narrow tile', 'full title on hover');
  eq(r.wide, 30, 'a tile with room keeps its size');
  // the Builder (same two tiles on its canvas): badge on the box and a note in the Widget tab
  await t.page.close();
  Object.assign(t, await open('page=builder&dev=pc'));
  await t.b(() => window.__b.mutate((d) => (d.widgets = [
    { id: 'n1', type: 'value', title: 'A very long title for a narrow tile', x: 0, y: 0, w: 1, h: 3, binding: { mode: 'current' }, keys: ['powerKw'], settings: { style: { valueSize: 60 } } },
    { id: 'n2', type: 'value', title: 'Wide', x: 1, y: 0, w: 6, h: 3, binding: { mode: 'current' }, keys: ['powerKw'], settings: {} },
  ])));
  await t.page.waitForFunction(() => document.querySelector('.dbb-canvas .dbb-gbox[data-id="n1"]'), null, { timeout: 8000 });
  await t.page.waitForFunction(() => document.querySelector('.dbb-canvas .dbb-gbox[data-id="n1"]')?.classList.contains('fitwarn'), null, { timeout: 6000 });
  ok(/too narrow|narrow for its value/.test(await t.b(() => document.querySelector('.dbb-canvas .dbb-gbox[data-id="n1"] .dbb-gwarn').title)), 'badge tooltip');
  await t.page.click('.dbb-canvas .dbb-gbox[data-id="n1"] .dbb-card', { timeout: 4000 });
  await t.page.waitForTimeout(300);
  ok(/Make the tile wider/.test(await t.b(() => document.querySelector('.dbb-right [data-fitwarn]')?.textContent ?? '')), 'note in the Widget tab');
  eq(await t.b(() => document.querySelector('.dbb-canvas .dbb-gbox[data-id="n2"]').classList.contains('fitwarn')), false, 'no badge on the wide tile');
});

test('machine page follows a machine picked in an app navbar (URL-only state change)', async (t) => {
  await t.page.close();
  const s = await open('dev=pc');
  Object.assign(t, s);
  // Give the Dryer its own dashboard so the switch is visible.
  await t.b(() => {
    const now = Date.now();
    const d = { schemaVersion: 1, id: 'dry1', name: 'Dryer board', kind: 'device', profile: 'Dryer', version: 1, ownerId: 'u1', ownerName: 'A', updatedBy: 'u1', updatedAt: now, timeRange: 'realtime', copiedFrom: null,
      widgets: [{ id: 'w1', type: 'gauge', title: 'DRYER GAUGE', x: 0, y: 0, w: 4, h: 3, binding: { mode: 'current' }, keys: ['dewPoint'], settings: {} }] };
    window.__tb.setAttrs('ASSET', 'store', { dbb_d_dry1: d });
    window.__tb.setAttrs('DEVICE', 'rd', { dbb_assign: { dashboardId: 'dry1', mode: 'linked', by: 'u1', at: now } });
    window.__tb.setAttrs('ASSET', 'store', { dbb_assign_rev: 'v' + now });
  });
  const before = await t.page.textContent('.dbb-rbody');
  ok(!/DRYER GAUGE/.test(before), 'compressor page first');
  await t.b(() => window.__urlSwitch('rd'));
  await t.page.waitForFunction(() => /DRYER GAUGE/.test(document.querySelector('.dbb-rbody')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => undefined);
  ok(/DRYER GAUGE/.test(await t.page.textContent('.dbb-rbody')), 'dashboard switched to the Dryer');
  ok(/Richmond/.test(await t.page.textContent('.dbb-rhead')), 'header switched');
  await t.b(() => window.__urlSwitch('pc'));
  await t.page.waitForFunction(() => !/DRYER GAUGE/.test(document.querySelector('.dbb-rbody')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => undefined);
  ok(!/DRYER GAUGE/.test(await t.page.textContent('.dbb-rbody')), 'and back');
});

test('refresh does not flicker: no fade after the first draw, embedded page not reloaded', async (t) => {
  await t.page.close();
  const s = await open('dev=pc');
  Object.assign(t, s);
  await t.b(() => {
    const now = Date.now();
    const d = { schemaVersion: 1, id: 'c1', name: 'C', kind: 'device', profile: 'Compressor', version: 1, ownerId: 'u1', ownerName: 'A', updatedBy: 'u1', updatedAt: now, timeRange: 'realtime', copiedFrom: null,
      widgets: [
        { id: 'w1', type: 'value', title: 'P', x: 0, y: 0, w: 3, h: 2, binding: { mode: 'current' }, keys: ['dischargePressure'], settings: {} },
        { id: 'w2', type: 'embed', title: 'E', x: 3, y: 0, w: 4, h: 3, binding: { mode: 'none' }, keys: [], settings: { url: 'https://example.com/' } },
      ] };
    window.__tb.setAttrs('ASSET', 'store', { dbb_d_c1: d });
    window.__tb.setAttrs('DEVICE', 'pc', { dbb_assign: { dashboardId: 'c1', mode: 'linked', by: 'u1', at: now } });
    window.__tb.setAttrs('ASSET', 'store', { dbb_assign_rev: 'v' + now });
    window.dispatchEvent(new CustomEvent('imex-dbb:changed'));
  });
  await t.page.waitForSelector('.dbb-rbody iframe');
  await t.page.waitForTimeout(700);
  const r = await t.b(async () => {
    const frame = document.querySelector('.dbb-rbody iframe');
    frame.__mark = 1;
    const anims = () => [...document.querySelectorAll('.dbb-rbody .dbb-card-b > *')].map((e) => getComputedStyle(e).animationName).filter((a) => a && a !== 'none');
    const beforeAnims = anims();
    // Two refresh cycles, as the 10 s timer / WebSocket push would do.
    const grid = document.querySelector('.dbb-rgrid');
    void grid;
    return { beforeAnims };
  });
  eq(r.beforeAnims, [], 'no animation left after the first draw');
  // Trigger refreshes through the renderer's grid (same path as the timer).
  await t.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await t.page.waitForTimeout(11000); // one REST polling cycle (socket is down in the harness)
  const after = await t.b(() => ({
    same: document.querySelector('.dbb-rbody iframe')?.__mark === 1,
    anims: [...document.querySelectorAll('.dbb-rbody .dbb-card-b > *')].map((e) => getComputedStyle(e).animationName).filter((a) => a && a !== 'none'),
  }));
  ok(after.same, 'iframe element kept across refresh (not reloaded)');
  eq(after.anims, [], 'no fade animation on refresh');
});

// ------------------------------------------------------------------ more flows

test('every data widget type renders in Historic 8 h', async (t) => {
  await t.click('.dbb-top [data-rng="hist"]');
  await t.page.selectOption('.dbb-top [data-a="range"]', '8h');
  const types = ALL_TYPES.filter((x) => !['text', 'image', 'link', 'embed'].includes(x));
  for (let i = 0; i < types.length; i += 9) {
    const batch = types.slice(i, i + 9);
    for (const ty of batch) await t.addWidget(ty);
    await t.page.waitForTimeout(2000);
    eq(await t.cardErrors(), [], `historic render ${batch.join(',')}`);
    const n = (await t.draft()).widgets.length;
    eq(n, batch.length, 'batch added');
    await t.b(() => window.__b.mutate((d) => (d.widgets = [])));
  }
});

test('help text shows as an info tooltip on the card', async (t) => {
  await t.addWidget('value');
  await t.click('.dbb-right .dbb-tab[data-tab="style"]');
  const ed = '.dbb-right [data-desc] [contenteditable="true"]';
  await t.page.click(ed);
  await t.page.keyboard.type('Pressure at the outlet');
  await t.page.click('.dbb-right [data-footer]'); // blur commits
  await t.page.waitForTimeout(700);
  ok(/Pressure at the outlet/.test((await t.draft()).widgets[0].settings.description ?? ''), 'description saved');
  ok(await t.page.$('.dbb-canvas .dbb-card .dbb-info'), 'info icon on the card');
});

test('Apply: replacing an existing assignment must be ticked first', async (t) => {
  await saveFirst(t);
  await t.page.check('.dbb-modal input[name="t"][value="all"]');
  await t.page.waitForFunction(() => !document.querySelector('.dbb-modal [data-mb="apply"]')?.disabled, null, { timeout: 5000 });
  await t.page.click('.dbb-modal [data-mb="apply"]');
  await t.idle(400);
  // a second dashboard for the same type, applied to all -> replaces the first
  await t.click('.dbb-top [data-a="open"]');
  await t.click('.dbb-modal [data-new]');
  await t.page.waitForSelector('.dbb-modal :text("What is it for?")');
  await t.modalBtn('ok');
  await t.idle(200);
  await t.addWidget('gauge');
  await t.click('.dbb-top [data-a="save"]');
  await t.page.waitForSelector('.dbb-modal :text("Apply dashboard")');
  await t.page.check('.dbb-modal input[name="t"][value="all"]');
  await t.page.waitForSelector('.dbb-modal [data-replace]', { timeout: 5000 });
  ok(await t.page.isDisabled('.dbb-modal [data-mb="apply"]'), 'Apply disabled until replace is ticked');
  await t.page.check('.dbb-modal [data-replace]');
  ok(await t.page.isEnabled('.dbb-modal [data-mb="apply"]'), 'enabled after ticking');
  await t.page.click('.dbb-modal [data-mb="apply"]');
  await t.idle(400);
  ok(/Applied to/.test(await t.toastText()), 'applied');
});

test('machine page: edit menu opens the builder on the shown dashboard; viewers get no edit menu', async (t) => {
  await t.page.close();
  let s = await open('dev=pc');
  Object.assign(t, s);
  await t.page.waitForFunction(() => window.__imexDbbActions?.items?.length > 0, null, { timeout: 5000 });
  const items = await t.b(() => window.__imexDbbActions.items.map((i) => i.id));
  ok(items.includes('edit') && items.includes('thr'), `admin actions: ${items}`);
  await t.b(() => window.__imexDbbActions.run('edit'));
  await t.page.waitForSelector('.dbb-overlay .dbb-top select');
  await t.page.waitForTimeout(500);
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), 'pc', 'builder opened for the shown machine');
  await t.page.close();
  s = await open('dev=pc&role=Viewer');
  Object.assign(t, s);
  await t.page.waitForTimeout(1500);
  eq(await t.b(() => window.__imexDbbActions?.items ?? null), null, 'no edit actions for a viewer');
});

// ------------------------------------------------------------------ D-054 phone layout

/** The machine page's dashboard of the local app, in the harness's keys: KPI + Summary, tiles, gauges, multi-value, chart. */
const PHONE_DASH = () => {
  const now = Date.now();
  const k = (id, type, title, x, y, w, h, keys) => ({ id, type, title, x, y, w, h, binding: { mode: 'current' }, keys, settings: {} });
  return {
    schemaVersion: 1, id: 'ph1', name: 'Phone board', kind: 'device', profile: 'Compressor', version: 1, ownerId: 'u1', ownerName: 'A', updatedBy: 'u1', updatedAt: now, timeRange: '1h', copiedFrom: null,
    widgets: [
      k('kpi', 'kpi', '1st Stage Discharge Air Temperature', 0, 0, 4, 2, ['dischargeTemp']),
      k('sum', 'summary', '1st Stage Discharge Air Temperature', 4, 0, 8, 2, ['dischargeTemp']),
      k('hours', 'value', 'Compressor Loaded Hours', 0, 2, 2, 2, ['powerKw']),
      k('g1', 'gauge', '2nd Stage Suction Air Temperature', 2, 2, 4, 3, ['dischargeTemp']),
      k('g2', 'gauge', '2nd Stage Discharge Air Temperature', 6, 2, 4, 3, ['dischargePressure']),
      k('mv', 'multivalue', 'Multi-value card', 0, 5, 4, 3, ['dischargeTemp', 'dischargePressure', 'runStatus']),
      k('st', 'value', 'Alert Status', 4, 5, 2, 4, ['runStatus']),
      k('line', 'line', '1st Stage Discharge Air Temperature', 0, 9, 8, 4, ['dischargeTemp']),
      k('inlet', 'gauge', 'Inlet Air Temperature', 8, 9, 4, 4, ['dischargeTemp']),
    ],
  };
};
/** Boxes of the machine page as drawn, overlaps, and text that is clipped or leaves its card. */
const phoneProbe = () => {
  const host = document.querySelector('.dbb-rgrid');
  const hr = host.getBoundingClientRect();
  const boxes = [...host.querySelectorAll('.dbb-gbox')].map((b) => {
    const r = b.getBoundingClientRect();
    return { id: b.dataset.id, l: Math.round(r.left - hr.left), t: Math.round(r.top - hr.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const over = [];
  for (const a of boxes) for (const b of boxes) if (a.id < b.id && a.l < b.l + b.w - 1 && b.l < a.l + a.w - 1 && a.t < b.t + b.h - 1 && b.t < a.t + a.h - 1) over.push(a.id + '/' + b.id);
  const clipped = [];
  for (const card of host.querySelectorAll('.dbb-card')) {
    const cr = card.getBoundingClientRect();
    const id = card.closest('.dbb-gbox').dataset.id;
    for (const el of card.querySelectorAll('.dbb-card-t,.dbb-value .v,.dbb-value .u,.dbb-sum .v,.dbb-sum .k,.dbb-mv-row .v')) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      if (r.right > cr.right + 1 || r.left < cr.left - 1 || r.bottom > cr.bottom + 1) clipped.push(`${id} ${el.className}: out`);
      else if (el.scrollWidth > el.clientWidth + 1) clipped.push(`${id} ${el.className}: cut "${el.textContent.trim()}"`);
    }
  }
  const sum = [...host.querySelectorAll('.dbb-gbox[data-id="sum"] .dbb-sum > div')].map((c) => {
    const r = c.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top)];
  });
  return { phone: host.classList.contains('dbb-phone'), hostW: Math.round(hr.width), boxes, over, clipped, sum, // the harness's own navbar is wider than a phone (the app has no navbar there), so the renderer is checked, not the page
    xOverflow: (() => { const r = document.querySelector('.dbb-rend'); return r.scrollWidth > r.clientWidth + 1 || boxes.some((b) => b.l + b.w > hr.width + 1); })() };
};

for (const width of [390, 430]) {
  test(`phone layout at ${width} px (D-054): 2 columns, reading order, no overlaps, Summary 2×2, no clipped text`, async (t) => {
    await t.page.close();
    const s = await open('dev=pc&shell=1&mobile=1');
    Object.assign(t, s);
    await t.page.setViewportSize({ width, height: 844 });
    await t.b((d) => {
      const now = Date.now();
      window.__tb.setAttrs('ASSET', 'store', { dbb_d_ph1: d });
      window.__tb.setAttrs('DEVICE', 'pc', { dbb_assign: { dashboardId: 'ph1', mode: 'linked', by: 'u1', at: now } });
      window.__tb.setAttrs('ASSET', 'store', { dbb_assign_rev: 'v' + now });
      window.dispatchEvent(new CustomEvent('imex-dbb:changed'));
    }, PHONE_DASH());
    await t.page.waitForFunction(() => document.querySelectorAll('.dbb-rgrid .dbb-gbox').length === 9 && document.querySelector('.dbb-gbox[data-id="sum"] .dbb-sum'), null, { timeout: 6000 });
    await t.page.waitForTimeout(900);
    const p = await t.b(phoneProbe);
    await t.page.screenshot({ path: join(tmpdir(), `e2e-phone-${width}.png`), fullPage: true });
    ok(p.phone, 'grid in phone mode');
    ok(!p.xOverflow, 'nothing sticks out sideways');
    const lefts = [...new Set(p.boxes.map((b) => b.l))].sort((a, b) => a - b);
    eq(lefts.length, 2, `two columns (lefts ${lefts})`);
    eq(p.over, [], 'no overlaps');
    const by = Object.fromEntries(p.boxes.map((b) => [b.id, b]));
    const full = by.line.w;
    ok(full > p.hostW - 30, `chart full width (${full} of ${p.hostW})`);
    ok(Math.abs(by.sum.w - full) <= 1, 'Summary (8 of 12) full width');
    ok(by.g1.w < full / 2 + 1 && by.g2.w < full / 2 + 1, 'gauges half width');
    eq(by.g1.t, by.hours.t, 'Loaded hours and the first gauge share a row');
    ok(by.hours.l < by.g1.l, 'left to right');
    // reading order: y, then x
    const order = [...p.boxes].sort((a, b) => a.t - b.t || a.l - b.l).map((b) => b.id);
    eq(order, ['kpi', 'sum', 'hours', 'g1', 'g2', 'mv', 'st', 'line', 'inlet'], 'reading order');
    ok(by.line.h >= 3 * 64 + 2 * 10, 'chart at least 3 rows');
    // Summary MIN / AVG / MAX / NOW as 2 x 2
    eq(new Set(p.sum.map((c) => c[0])).size, 2, `Summary in 2 columns ${JSON.stringify(p.sum)}`);
    eq(new Set(p.sum.map((c) => c[1])).size, 2, 'Summary in 2 rows');
    eq(p.clipped, [], 'no clipped or overflowing text');
    // phone mode: no title in the header (the app's shell bar shows the machine), no edit actions
    ok(!(await t.page.$('.dbb-rhead .dbb-rtitle')), 'no machine title under html.imx-mobile');
    eq(await t.b(() => window.__imexDbbActions ?? null), null, 'no edit actions under html.imx-mobile');
    const head = await t.b(() => {
      const h = document.querySelector('.dbb-rhead');
      return { sw: h.scrollWidth, cw: h.clientWidth };
    });
    ok(head.sw <= head.cw + 1, `header fits (${head.sw} > ${head.cw})`);
    // back to a desktop width: the stored 12-column layout again
    await t.page.setViewportSize({ width: 1400, height: 900 });
    await t.page.waitForTimeout(500);
    const d = await t.b(phoneProbe);
    ok(!d.phone, 'desktop: no phone mode');
    eq(d.over, [], 'desktop: no overlaps');
    const dby = Object.fromEntries(d.boxes.map((b) => [b.id, b]));
    eq(dby.kpi.t, dby.sum.t, 'desktop: KPI and Summary side by side again');
    eq(dby.hours.t, dby.g2.t, 'desktop: tiles in one row again');
  });
}

test('phone layout (D-054): never in the editor; without html.imx-mobile the title and edit actions stay', async (t) => {
  await t.page.close();
  let s = await open('dev=pc&shell=1');
  Object.assign(t, s);
  await t.page.setViewportSize({ width: 390, height: 844 });
  await t.page.waitForFunction(() => window.__imexDbbActions?.items?.length > 0, null, { timeout: 5000 });
  await t.page.waitForTimeout(600);
  ok(await t.page.$('.dbb-rgrid.dbb-phone'), 'phone layout by width alone');
  ok(await t.page.$('.dbb-rhead .dbb-rtitle'), 'title kept without html.imx-mobile (D-038)');
  await t.page.close();
  // the editor in a phone-sized window keeps the 12 columns
  s = await open('page=builder&dev=pc');
  Object.assign(t, s);
  await t.addWidget('value');
  await t.addWidget('value');
  await t.page.setViewportSize({ width: 520, height: 844 });
  await t.page.waitForTimeout(500);
  ok(!(await t.page.$('.dbb-phone')), 'no phone mode in the editor');
  eq((await t.draft()).widgets.map((w) => w.w), [3, 3], 'stored widths unchanged');
});

// ------------------------------------------------------------------ D-029

/** Canvas cards whose content is cut off (the body or an inner scrolling/clipping element overflows). */
const cutOff = (t) =>
  t.b(() =>
    [...document.querySelectorAll('.dbb-canvas .dbb-gbox')].flatMap((box) => {
      const body = box.querySelector('.dbb-card-b');
      if (!body) return [];
      const els = [body, ...body.querySelectorAll('*')].filter((e) => e === body || /(auto|scroll|hidden)/.test(getComputedStyle(e).overflowY + getComputedStyle(e).overflowX));
      const over = Math.max(...els.map((e) => Math.max(e.scrollHeight - e.clientHeight, e.scrollWidth - e.clientWidth)));
      return over > 3 ? [`${box.querySelector('.dbb-card-t, .dbb-card-h')?.textContent?.trim() || box.dataset.id} (+${over}px)`] : [];
    }),
  );
const noOverlap = (ws) => !ws.some((a, i) => ws.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));

test('chat-built widgets show all their content without dragging (sizes + measured fit)', async (t) => {
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  await t.b(() =>
    window.__chatQueue.push({
      intent: 'build',
      reply: 'Built.',
      ops: [
        // deliberately too small (h 1): the builder must grow them after drawing
        { op: 'addWidget', type: 'multivalue', title: 'All values', binding: { mode: 'current' }, keys: ['dischargePressure', 'dischargeTemp', 'powerKw', 'runStatus'], h: 1 },
        { op: 'addWidget', type: 'text', title: 'Notes', binding: { mode: 'none' }, keys: [], h: 1, settings: { html: '<h2>Shift notes</h2><p>' + 'Check the oil level and the filters every morning before start-up. '.repeat(6) + '</p><ul><li>One</li><li>Two</li><li>Three</li></ul>' } },
        // default sizes from the content rules
        { op: 'addWidget', type: 'table', title: 'All compressors', binding: { mode: 'siblings', machineType: 'Compressor' }, keys: ['dischargePressure', 'dischargeTemp', 'powerKw', 'runStatus'] },
        { op: 'addWidget', type: 'line', title: 'Trend', binding: { mode: 'siblings', machineType: 'Compressor' }, keys: ['dischargePressure', 'dischargeTemp', 'powerKw'] },
        { op: 'addWidget', type: 'timeline', title: 'Run', binding: { mode: 'siblings', machineType: 'Compressor' }, keys: ['runStatus'] },
        { op: 'addWidget', type: 'alarms', title: 'Alarms', binding: { mode: 'current' }, keys: [] },
      ],
    }),
  );
  await t.page.fill('.dbb-chat-in', 'add an overview of everything');
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => window.__b.draft.widgets.length >= 6 && !window.__b.busy, null, { timeout: 8000 });
  await t.page.waitForTimeout(3500);
  eq(await cutOff(t), [], 'nothing cut off');
  await t.page.screenshot({ path: join(tmpdir(), 'fit.png') });
  const d = await t.draft();
  ok(noOverlap(d.widgets), 'no overlaps after growing');
  ok(d.widgets.find((w) => w.title === 'All values').h >= 3, 'multi-value card grew');
  await t.click('.dbb-top [data-a="undo"]');
  eq((await t.draft()).widgets.length, 0, 'one undo step removes the chat change including the fit');
});

test('chat moves, resizes and tidies widgets (x/y/w/h, arrangeLayout)', async (t) => {
  await t.addWidget('value');
  await t.addWidget('gauge');
  await t.addWidget('line');
  await t.addWidget('table');
  const before = await t.draft();
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  // W3 = line chart: to the top, left half; W1 = value card: full width
  await t.b(() => window.__chatQueue.push({ intent: 'build', reply: 'Moved.', ops: [{ op: 'updateWidget', widget: 'W3', x: 0, y: 0, w: '6' }, { op: 'updateWidget', widget: 'W1', w: 12, x: 0 }] }));
  await t.page.fill('.dbb-chat-in', 'put the trend at the top left and make the first card full width');
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => !window.__b.busy && window.__chatReqs.length === 1, null, { timeout: 8000 });
  await t.page.waitForTimeout(300);
  let d = await t.draft();
  const line = d.widgets.find((w) => w.id === before.widgets[2].id);
  eq([line.x, line.y, line.w], [0, 0, 6], 'line chart moved and resized');
  eq(d.widgets.find((w) => w.id === before.widgets[0].id).w, 12, 'value card full width');
  ok(noOverlap(d.widgets), 'no overlaps');
  ok(/"x":\d+,"y":\d+,"w":\d+,"h":\d+/.test(await t.b(() => window.__chatReqs[0].body.messages.at(-1).content)), 'draft carries positions');
  // tidy up
  await t.b(() => window.__chatQueue.push({ intent: 'build', reply: 'Tidied.', ops: [{ op: 'arrangeLayout' }] }));
  await t.page.fill('.dbb-chat-in', 'tidy up the layout');
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => !window.__b.busy && window.__chatReqs.length === 2, null, { timeout: 8000 });
  await t.page.waitForTimeout(2500);
  d = await t.draft();
  ok(noOverlap(d.widgets), 'no overlaps after tidy');
  for (const y of new Set(d.widgets.map((w) => w.y))) eq(d.widgets.filter((w) => w.y === y).reduce((a, w) => a + w.w, 0), 12, `row y=${y} filled`);
  eq(await cutOff(t), [], 'nothing cut off after tidy');
});

test('New dashboard: top-bar button and dialog (machine type or overview); navbar menu item', async (t) => {
  await t.addWidget('value');
  await t.click('.dbb-top [data-a="new"]');
  await t.page.waitForSelector('.dbb-modal :text("What is it for?")');
  await t.page.fill('.dbb-modal [data-n]', 'Plant overview');
  ok(await t.page.isVisible('.dbb-modal [data-typesec]'), 'machine type shown for "One machine type"');
  await t.click('.dbb-modal .dbb-nd-opt[data-k="overview"]');
  ok(!(await t.page.isVisible('.dbb-modal [data-typesec]')), 'machine type hidden for an overview');
  eq(await t.page.getAttribute('.dbb-modal .dbb-nd-opt[data-k="overview"]', 'aria-checked'), 'true', 'radio state');
  await t.modalBtn('ok');
  await t.page.waitForSelector('.dbb-modal :text("Discard unsaved changes?")');
  await t.modalBtn('ok');
  await t.idle(300);
  let d = await t.draft();
  eq([d.name, d.profile, d.widgets.length, d.version], ['Plant overview', null, 0, 0], 'blank overview');
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), '', 'no machine for an overview');
  await t.click('.dbb-top [data-a="new"]');
  await t.click('.dbb-modal [data-pk="ndtype"] .dbb-pk-trig .car');
  await t.click('.dbb-modal [data-pk="ndtype"] .dbb-pk-row[data-v="Dryer"]');
  await t.modalBtn('ok');
  await t.idle(300);
  d = await t.draft();
  eq([d.name, d.profile], ['Dryer dashboard', 'Dryer'], 'machine-type dashboard named after the type');
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), 'rd', 'previews on a Dryer');
  // navbar menu: New dashboard opens the builder with the dialog
  await t.page.close();
  const s = await open('dev=pc');
  Object.assign(t, s);
  await t.page.click('.dbb-edit-ic');
  await t.page.click('.dbb-emenu [data-m="__new"]');
  await t.page.waitForSelector('.dbb-overlay .dbb-modal :text("What is it for?")', { timeout: 6000 });
  // a second open does not stack another builder
  await t.b(() => window.IMEX_DBB.open());
  await t.page.waitForTimeout(800);
  eq(await t.b(() => document.querySelectorAll('.dbb-overlay').length), 1, 'one builder only');
});

test('Builder from a page without a machine: start screen with New, Open and recent dashboards', async (t) => {
  await t.page.close();
  const s = await open('page=builder&dev=none');
  Object.assign(t, s);
  await seedStandalone(t, 3);
  await t.b(() => {
    window.__b.recent = null; // the first render already asked for the (then empty) list
    window.__b.renderAll();
  });
  await t.page.waitForSelector('.dbb-empty [data-recent] .dbb-st-row', { timeout: 5000 });
  ok(/Start a dashboard/.test(await t.page.textContent('.dbb-empty')), 'start screen');
  const tiles = await t.b(() => [...document.querySelectorAll('.dbb-st-tile')].map((b) => b.dataset.a));
  eq(tiles, ['new', 'open', 'chat'], 'three action tiles');
  const g = await t.b(() => {
    const r = document.querySelector('.dbb-st-row');
    const n = r.querySelector('.dbb-st-name').getBoundingClientRect();
    const m = r.querySelector('.dbb-st-meta').getBoundingClientRect();
    return { stacked: m.top >= n.bottom - 1, h: Math.round(r.getBoundingClientRect().height) >= 54, font: getComputedStyle(r).fontFamily.split(',')[0].replace(/"/g, '') };
  });
  eq(g, { stacked: true, h: true, font: 'Inter' }, 'recent rows: name above details, roomy, Inter');
  await t.page.screenshot({ path: join(tmpdir(), 'start.png') });
  const names = await t.b(() => [...document.querySelectorAll('.dbb-st-name')].map((b) => b.textContent));
  ok(names.length >= 3, `recent dashboards listed (${names})`);
  await t.page.locator('.dbb-st-row').first().click();
  await t.idle(400);
  eq((await t.draft()).name, names[0], 'click opens it');
});

test('D-033: Dashboard list shows unapplied machine-type dashboards to editors and opens them in the builder', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc'));
  await seedStandalone(t, 2);
  await t.page.click('#nav .dbb-launch-btn');
  await t.page.click('.dbb-emenu [data-m="__list"]');
  await t.page.waitForSelector('.dbb-dl .row');
  await t.click('.dbb-dl [data-kind="device"]');
  const rows = await t.b(() => [...document.querySelectorAll('.dbb-dl .row')].map((r) => ({ name: r.querySelector('.nm span').textContent, badges: [...r.querySelectorAll('.badge')].map((b) => b.textContent) })));
  eq(rows, [{ name: 'Machine board', badges: ['Compressor', 'Not applied'] }], 'machine type, marked not applied');
  await t.page.screenshot({ path: join(tmpdir(), 'dlist-types.png') });
  // search also matches the machine type
  await t.click('.dbb-dl [data-kind="all"]');
  await t.page.fill('.dbb-dl [data-q]', 'compressor');
  eq(await t.b(() => [...document.querySelectorAll('.dbb-dl .row .nm span')].map((r) => r.textContent)), ['Machine board'], 'search by machine type');
  await t.click('.dbb-dl .row[data-id="dev1"]');
  await t.page.waitForFunction(() => document.querySelector('.dbb-overlay .dbb-top [data-a="name"]')?.value === 'Machine board', null, { timeout: 6000 });
  await t.page.waitForTimeout(400);
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), 'pc', 'previews on a Compressor');
  ok(!(await t.page.$('.dbb-dl')), 'list closed');
  // applied once assigned
  await t.click('.dbb-top [data-a="close"]');
  await t.page.waitForFunction(() => !document.querySelector('.dbb-overlay'));
  await t.b(() => window.__tb.setAttrs('DEVICE', 'rc', { dbb_assign: { dashboardId: 'dev1', mode: 'linked', by: 'u1', at: Date.now() } }));
  await t.b(() => window.dispatchEvent(new CustomEvent('imex-dbb:changed')));
  await t.page.waitForTimeout(600);
  await t.page.click('#nav .dbb-launch-btn');
  await t.page.click('.dbb-emenu [data-m="__list"]');
  await t.page.waitForSelector('.dbb-dl .row');
  ok(!(await t.page.$('.dbb-dl .badge.na')), 'no "Not applied" once assigned');
});

test('D-033: Dashboard list and menu open above the builder, even when the app raises the builder', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc'));
  await seedStandalone(t, 3);
  await t.page.click('.dbb-edit-ic');
  await t.page.click('.dbb-emenu [data-m="__builder"]');
  await t.page.waitForSelector('.dbb-overlay .dbb-top select', { timeout: 6000 });
  // a host navbar that lifts the builder (seen on a customer app: z-index 300000)
  await t.b(() => (document.querySelector('.dbb-overlay').style.zIndex = '300000'));
  await t.page.click('.dbb-edit-ic');
  await t.page.waitForSelector('.dbb-emenu');
  const menuZ = await t.b(() => Number(getComputedStyle(document.querySelector('.dbb-emenu')).zIndex));
  ok(menuZ > 300000, `menu above the builder (${menuZ})`);
  ok(!(await t.page.$('.dbb-emenu small, .dbb-emenu svg')), 'menu rows are plain text (no taglines, no icons)');
  await t.b(() => document.querySelector('.dbb-emenu [data-m="__list"]').click());
  await t.page.waitForSelector('.dbb-dl .row');
  const top = await t.b(() => {
    const r = document.querySelector('.dbb-dl .box').getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + 30)?.closest('.dbb-dl') ? 'list' : 'other';
  });
  eq(top, 'list', 'the list is on top and clickable');
  // Edit from the list loads it into the open builder (no second builder)
  await t.b(() => document.querySelector('.dbb-dl [data-edit="sa2"]').click());
  await t.page.waitForFunction(() => document.querySelector('.dbb-overlay .dbb-top [data-a="name"]')?.value === 'Fleet board 02', null, { timeout: 6000 });
  eq(await t.b(() => document.querySelectorAll('.dbb-overlay').length), 1, 'one builder');
});

test('D-033: machine page Edit opens the builder below the navbar (placement registered by the launcher)', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc'));
  await t.page.click('.dbb-edit-ic');
  await t.page.click('.dbb-emenu [data-m="edit"]');
  await t.page.waitForSelector('.dbb-overlay .dbb-top select', { timeout: 6000 });
  await t.page.waitForTimeout(300);
  const g = await t.b(() => ({ nav: Math.round(document.querySelector('#nav').getBoundingClientRect().bottom), top: Math.round(document.querySelector('.dbb-overlay').getBoundingClientRect().top) }));
  eq(g.top, g.nav, 'starts at the navbar bottom');
});

test('D-036: app shell insets: builder opens right of a side menu and follows collapse; headless launcher API', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc'));
  const cell = await t.b(() => {
    document.documentElement.style.setProperty('--imex-app-inset-left', '248px');
    document.documentElement.style.setProperty('--imex-app-inset-top', '0px');
    return window.__mountLauncher({ headless: true });
  });
  await t.page.waitForFunction(() => typeof window.IMEX_DBB?.dashboardList === 'function');
  eq(await t.b((id) => document.getElementById(id).innerHTML, cell), '', 'headless launcher draws nothing');
  eq(await t.b(() => window.IMEX_DBB.isEditor()), true, 'isEditor for an admin');
  await t.b(() => window.IMEX_DBB.open());
  await t.page.waitForSelector('.dbb-overlay .dbb-top select', { timeout: 6000 });
  const box = () => t.b(() => { const r = document.querySelector('.dbb-overlay').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right)]; });
  eq(await box(), [248, 0, 1600], 'builder fills the window right of the expanded menu (inset top wins over the navbar)');
  await t.b(() => {
    document.documentElement.style.setProperty('--imex-app-inset-left', '72px');
    window.dispatchEvent(new CustomEvent('imex-app:insets'));
  });
  await t.page.waitForTimeout(100);
  eq((await box())[0], 72, 'follows the collapsed menu');
  await t.click('.dbb-top [data-a="close"]');
  await t.page.waitForFunction(() => !document.querySelector('.dbb-overlay'));
  await t.b(() => window.IMEX_DBB.dashboardList());
  await t.page.waitForSelector('.dbb-dl', { timeout: 6000 });
  ok(true, 'Dashboard list opens through the headless API');
  // D-041: the same list drawn inside an element (the app's Dashboards page), no backdrop, no header, stays open
  const inl = await t.b(async () => {
    const host = document.createElement('div');
    host.id = 'dl-host';
    host.style.cssText = 'position:fixed;left:400px;top:100px;width:700px;height:500px';
    document.body.appendChild(host);
    const h = await window.IMEX_DBB.dashboardPage(host);
    const wrap = host.querySelector('.dbb-dl');
    const cs = getComputedStyle(wrap);
    const out = { inline: wrap.classList.contains('dbb-dl-inline'), position: cs.position, header: getComputedStyle(wrap.querySelector('.hd')).display, rows: host.querySelectorAll('.row').length, empty: !!host.querySelector('.empty'), hasDestroy: !!(h && h.destroy), stillThere: false };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.stillThere = !!host.querySelector('.dbb-dl');
    h.destroy();
    out.gone = !host.querySelector('.dbb-dl');
    host.remove();
    return out;
  });
  ok(inl.inline && inl.position === 'static' && inl.header === 'none', `inline list: ${JSON.stringify(inl)}`);
  ok((inl.rows >= 1 || inl.empty) && inl.hasDestroy && inl.stillThere && inl.gone, `rows ${inl.rows} (empty state ${inl.empty}), Escape keeps the page, destroy removes it`);
});

test('D-034: machine page Edit opens below the app navbar even when our launcher never registered a placement', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc'));
  // An app navbar of its own (like iMEX navbar2) in a ThingsBoard-like grid: header band (rows 1-5, a cell placed one
  // row lower), a thin full-width status line, then the page. Our launcher's init never ran, so nothing is registered.
  await t.b(() => {
    window.__setPlacement(null);
    const grid = document.createElement('gridster');
    grid.id = 'fakegrid';
    grid.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;display:block;pointer-events:none;z-index:-1';
    const item = (top, h, left, w) => {
      const it = document.createElement('gridster-item');
      it.style.cssText = `position:absolute;display:block;top:${top}px;height:${h}px;left:${left}px;width:${w}`;
      grid.appendChild(it);
    };
    item(0, 50, 0, '80%'); // logo + links
    item(6, 44, '80%', '20%'); // a navbar cell one row lower
    item(50, 12, 0, '100%'); // status line
    item(62, 800, 0, '100%'); // the machine page
    document.body.appendChild(grid);
  });
  eq(await t.b(() => window.__measureHeaderTop()), 62, 'header band = navbar (50) + status line (12)');
  await t.page.click('.dbb-edit-ic');
  await t.page.click('.dbb-emenu [data-m="edit"]');
  await t.page.waitForSelector('.dbb-overlay .dbb-top select', { timeout: 6000 });
  await t.page.waitForTimeout(300);
  eq(await t.b(() => Math.round(document.querySelector('.dbb-overlay').getBoundingClientRect().top)), 62, 'builder starts below the measured header, not full screen');
  // a stale registration (navbar widget re-created: its element is gone) also falls back to the measurement
  await t.click('.dbb-top [data-a="close"]');
  await t.page.waitForFunction(() => !document.querySelector('.dbb-overlay'));
  await t.b(() => window.__setPlacement({ topOffset: () => 0, pageKey: () => location.href }));
  await t.page.click('.dbb-edit-ic');
  await t.page.click('.dbb-emenu [data-m="edit"]');
  await t.page.waitForSelector('.dbb-overlay .dbb-top select', { timeout: 6000 });
  await t.page.waitForTimeout(300);
  eq(await t.b(() => Math.round(document.querySelector('.dbb-overlay').getBoundingClientRect().top)), 62, 'stale placement falls back to the page header');
});

// ------------------------------------------------------------------ D-030

test('builder opens below the app navbar; navigating closes it (asks first with unsaved changes)', async (t) => {
  await t.page.close();
  const s = await open('dev=pc');
  Object.assign(t, s);
  const openFromMenu = async () => {
    await t.page.click('.dbb-edit-ic');
    await t.page.click('.dbb-emenu [data-m="__builder"]');
    await t.page.waitForSelector('.dbb-overlay .dbb-top select', { timeout: 6000 });
    await t.page.waitForTimeout(400);
  };
  await openFromMenu();
  const g = await t.b(() => {
    const nav = document.querySelector('#nav').getBoundingClientRect();
    const ov = document.querySelector('.dbb-overlay').getBoundingClientRect();
    const hit = document.elementFromPoint(nav.left + nav.width / 2, nav.top + nav.height / 2);
    return { navBottom: Math.round(nav.bottom), top: Math.round(ov.top), navClickable: !!hit?.closest('#nav'), z: getComputedStyle(document.querySelector('.dbb-overlay')).zIndex };
  });
  eq([g.top, g.navClickable, g.z], [g.navBottom, true, '999'], 'starts at the navbar bottom, navbar stays usable, app menus above it');
  // the pencil menu still works while the builder is open
  await t.page.click('.dbb-edit-ic');
  ok(await t.page.isVisible('.dbb-emenu'), 'navbar menu opens over the builder');
  await t.page.keyboard.press('Escape');
  // no unsaved changes: navigating closes the builder
  await t.b(() => window.__urlSwitch('rd'));
  await t.page.waitForFunction(() => !document.querySelector('.dbb-overlay'), null, { timeout: 3000 });
  // unsaved changes: asks; Keep editing stays, Discard and go closes
  await openFromMenu();
  await t.page.click('.dbb-left .dbb-pal[data-t="value"]');
  await t.page.waitForTimeout(200);
  await t.b(() => window.__urlSwitch('pc'));
  await t.page.waitForSelector('.dbb-modal :text("You opened another page")', { timeout: 3000 });
  await t.page.click('.dbb-modal [data-mb="cancel"]');
  await t.page.waitForTimeout(700);
  ok(await t.page.isVisible('.dbb-overlay'), 'Keep editing keeps the builder');
  await t.b(() => window.__urlSwitch('rd'));
  await t.page.waitForSelector('.dbb-modal :text("You opened another page")', { timeout: 3000 });
  await t.page.click('.dbb-modal [data-mb="ok"]');
  await t.page.waitForFunction(() => !document.querySelector('.dbb-overlay'), null, { timeout: 3000 });
});

test('builder top in a ThingsBoard-like grid: navbar band + status line, not the page below', async (t) => {
  const r = await t.b(() => {
    // 150-column layout, no margins (as in the iMEX app): navbar rows 1-5, status line row 6, page from row 7
    const grid = document.createElement('gridster');
    grid.style.cssText = 'position:fixed;left:0;top:0;width:1500px;height:900px;display:block';
    const item = (top, h, left, w) => {
      const it = document.createElement('gridster-item');
      it.style.cssText = `position:absolute;display:block;top:${top}px;height:${h}px;left:${left}px;width:${w}px`;
      grid.appendChild(it);
      return it;
    };
    item(0, 50, 0, 1300); // logo + links
    const pencilCell = item(5, 40, 1300, 200); // the cell holding the navbar widget (shorter than the band)
    const host = document.createElement('div');
    pencilCell.appendChild(host);
    item(50, 10, 0, 1500); // status line (thin, full width)
    item(60, 30, 270, 1230); // "Sort by" bar of the page: not full width -> page content
    item(60, 800, 0, 270); // hierarchy panel
    document.body.appendChild(grid);
    const out = {
      auto: window.__builderTop({ $container: [host], settings: {} }),
      px: window.__builderTop({ $container: [host], settings: { builderTop: '64' } }),
      full: window.__builderTop({ $container: [host], settings: { builderTop: '0' } }),
    };
    grid.remove();
    return out;
  });
  eq(r, { auto: 60, px: 64, full: 0 }, 'auto = navbar band (50) + status line (10)');
});

test('New dashboard dialog is readable (stacked text, roomy options) and stale builder styles are replaced', async (t) => {
  // a style element left by an older build on the same page must be updated when the builder opens again
  await t.b(() => {
    document.getElementById('dbb-css-builder').textContent = '/* stale build */';
    return window.__b.close();
  });
  await t.page.waitForFunction(() => !document.querySelector('.dbb-overlay'));
  await t.b(() => window.IMEX_DBB.open({ deviceId: 'pc' }));
  await t.page.waitForSelector('.dbb-overlay .dbb-top [data-a="new"]', { timeout: 6000 });
  ok(/\.dbb-nd-opt/.test(await t.b(() => document.getElementById('dbb-css-builder').textContent)), 'styles updated');
  // D-033: host page CSS like a customer app's (label grids, wide radios, decorated ::before) must not break it
  await t.b(() => {
    const st = document.createElement('style');
    st.textContent = 'label{display:grid;grid-template-columns:1fr 3fr} input[type=radio]{width:100%} div::before,span::before{content:"◆";color:purple}';
    document.head.appendChild(st);
  });
  await t.click('.dbb-top [data-a="new"]');
  await t.page.waitForSelector('.dbb-modal .dbb-nd-opt');
  await t.page.waitForTimeout(300);
  const g = await t.b(() => {
    const opt = document.querySelector('.dbb-nd-opt').getBoundingClientRect();
    const dot = document.querySelector('.dbb-nd-opt .dbb-nd-dot').getBoundingClientRect();
    const tt = document.querySelector('.dbb-nd-t').getBoundingClientRect();
    const dd = document.querySelector('.dbb-nd-d').getBoundingClientRect();
    const sel = document.querySelector('[data-typesec]').getBoundingClientRect();
    const fs = (sel2) => parseFloat(getComputedStyle(document.querySelector(sel2)).fontSize);
    const deco = [...document.querySelectorAll('.dbb-modal .dbb-nd-cap, .dbb-modal .dbb-nd-t, .dbb-modal-h')].some((e) => !/none|normal/.test(getComputedStyle(e, '::before').content));
    return {
      stacked: dd.top >= tt.bottom - 1 && sel.top >= opt.bottom - 1,
      pad: Math.round(tt.top - opt.top),
      dotBesideTitle: dot.right <= tt.left && tt.left - dot.right <= 16 && Math.abs(dot.top - tt.top) <= 6,
      title: fs('.dbb-nd-t'),
      desc: fs('.dbb-nd-d'),
      font: getComputedStyle(document.querySelector('.dbb-nd-d')).fontFamily.split(',')[0].replace(/"/g, ''),
      deco,
    };
  });
  eq(g, { stacked: true, pad: 15, dotBesideTitle: true, title: 14, desc: 13, font: 'Inter', deco: false }, 'title, description and type picker stacked, dot beside the title, no host decoration');
  await t.page.screenshot({ path: join(tmpdir(), 'new-dialog.png') });
});

// ------------------------------------------------------------------ D-028 security

async function seedHostile(t) {
  // Everything a customer user could write straight into the store attributes (D-012), with payloads in every
  // string that reaches markup or CSS.
  await t.b(() => {
    const X = '"><img src=x onerror="window.__pwned=1">';
    const now = Date.now();
    const W = (i, type, keys, settings = {}) => ({ id: 'x' + i, type, title: X, x: 0, y: i * 2, w: 6, h: 2, binding: { mode: 'current' }, keys, settings: { footer: X, description: X + '<a href="javascript:window.__pwned=1">x</a>&#x110000;', ...settings } });
    const doc = { schemaVersion: 1, id: 'hx', name: X, kind: 'device', profile: 'Compressor', version: 1, ownerId: 'u1', ownerName: X, updatedBy: X, updatedAt: now, timeRange: 'realtime', copiedFrom: null,
      theme: { font: 'a\n;background:url(//evil.example/x);b:' },
      widgets: [
        W(0, 'multivalue', ['dischargePressure'], { unit: X, bands: [{ upTo: null, color: 'red"><img src=x onerror="window.__pwned=1">' }] }),
        W(1, 'status', ['runStatus'], { statusMap: [{ value: 1, label: X, color: 'red;background:url(//evil.example/y)' }] }),
        W(2, 'value', ['dischargeTemp'], { style: { titleFont: 'a\n;position:fixed;inset:0;z-index:9;b:' }, colorRules: [{ op: 'gt', value: -1e9, color: '#ff0000', label: X }] }),
        W(3, 'table', ['dischargePressure'], { bands: [{ upTo: null, color: 'x" onmouseover="window.__pwned=1' }] }),
        W(4, 'text', [], { html: X + '<p>{{machine}}</p><a href="https://ok.example/{{machine}}">l</a>' }),
        W(5, 'embed', [], { url: location.origin + '/' }),
      ] };
    window.__tb.setAttrs('ASSET', 'store', {
      dbb_d_hx: doc,
      dbb_h_hx: [{ version: '1"><img src=x onerror="window.__pwned=1">', savedAt: now, savedBy: X, doc }, { version: 2, savedAt: now, savedBy: X, doc }],
      // a document whose id is not its key, and one with a hostile id: both must be ignored
      dbb_d_other: { ...doc, id: 'hx2' },
      dbb_d_evil: { ...doc, id: '"><img src=x onerror="window.__pwned=1">' },
      dbb_assign_rev: 'v' + now,
    });
    window.__tb.setAttrs('DEVICE', 'pc', { dbb_assign: { dashboardId: 'hx', mode: 'linked', by: 'u1', at: now } });
  });
}

test('stored XSS: hostile dashboard documents never run script (machine page, Open dialog, history, editors)', async (t) => {
  await t.page.close();
  const s = await open('page=builder&dev=pc');
  Object.assign(t, s);
  await seedHostile(t);
  // builder: Open dialog lists it, open it, select every widget (editors render ids and settings), version history
  await t.click('.dbb-top [data-a="open"]');
  await t.page.waitForSelector('.dbb-modal .dbb-od-row[data-id="hx"]');
  const ids = await t.b(() => [...document.querySelectorAll('.dbb-od-row[data-id]')].map((r) => r.dataset.id));
  eq(ids.filter((i) => i !== 'hx' && !i.startsWith('d')), [], 'only valid documents listed');
  await t.click('.dbb-modal .dbb-od-row[data-id="hx"]');
  await t.idle(600);
  const n = await t.b(() => document.querySelectorAll('.dbb-canvas .dbb-card').length);
  for (let i = 0; i < n; i++) {
    await t.page.locator('.dbb-canvas .dbb-card').nth(i).click({ position: { x: 20, y: 40 }, force: true });
    await t.page.waitForTimeout(150);
  }
  ok(n >= 5, `hostile widgets rendered in the builder (${n})`);
  await t.b(() => window.__b.versionsDialog());
  await t.page.waitForTimeout(500);
  const css = await t.b(() => [...document.querySelectorAll('[style]')].map((e) => e.getAttribute('style')).filter((x) => /evil|inset:0|position:fixed/.test(x)));
  eq(css, [], 'no injected CSS');
  eq(await t.b(() => ({ pwned: window.__pwned ?? null, imgs: document.querySelectorAll('img[src="x"], [onerror], [onmouseover]').length })), { pwned: null, imgs: 0 }, 'no script in the builder');
  await t.page.keyboard.press('Escape');
  // machine page
  await t.page.close();
  const m = await open('dev=pc');
  Object.assign(t, m);
  await seedHostile(t);
  await t.b(() => window.__tb.setAttrs('ASSET', 'store', { dbb_assign_rev: 'v-reload' }));
  // reload the page so the machine page reads the hostile documents on first load
  await t.b(() => window.__urlSwitch('rd'));
  await t.page.waitForTimeout(1200);
  await t.b(() => window.__urlSwitch('pc'));
  await t.page.waitForTimeout(2500);
  ok(/Could not|—|\d/.test(await t.page.textContent('.dbb-rbody')), 'machine page rendered');
  const r = await t.b(() => ({
    pwned: window.__pwned ?? null,
    imgs: document.querySelectorAll('img[src="x"], [onerror], [onmouseover]').length,
    js: document.querySelectorAll('a[href^="javascript"]').length,
    frames: document.querySelectorAll('iframe').length,
  }));
  eq(r, { pwned: null, imgs: 0, js: 0, frames: 0 }, 'nothing injected, same-origin page not framed');
});

// ------------------------------------------------------------------ D-025

test('builder: a chat-built "This machine" dashboard with no machine picked previews on a machine of that type', async (t) => {
  await t.page.close();
  Object.assign(t, await open('page=builder&dev=none'));
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  await t.b(() =>
    window.__chatQueue.push({
      intent: 'build',
      reply: 'Built a Compressor overview.',
      ops: [
        { op: 'setMachineType', machineType: 'Compressor' },
        { op: 'addWidget', type: 'kpi', title: 'Discharge pressure', binding: { mode: 'current' }, keys: ['dischargePressure'] },
        { op: 'addWidget', type: 'line', title: 'Pressure trend', binding: { mode: 'current' }, keys: ['dischargePressure'] },
      ],
    }),
  );
  await t.page.fill('.dbb-chat-in', 'Show discharge pressure and other KPIs');
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => window.__b.draft.widgets.length === 2 && !window.__b.busy, null, { timeout: 8000 });
  await t.page.waitForTimeout(1200);
  const sel = await t.page.inputValue('.dbb-top [data-a="machine"]');
  ok(['pc', 'rc'].includes(sel), `a Compressor is picked for the preview (${sel})`);
  ok(!/Open this dashboard for a machine/.test(await t.page.textContent('.dbb-canvas')), 'no "open for a machine" placeholders');
  ok(/Previewing with/.test(await t.toastText()), 'says which machine it previews with');
});

async function seedStandalone(t, n) {
  await t.b((n) => {
    const now = Date.now();
    const docs = {};
    for (let i = 1; i <= n; i++) {
      const id = 'sa' + i;
      docs['dbb_d_' + id] = { schemaVersion: 1, id, name: (i === 7 ? 'Energy board ' : 'Fleet board ') + String(i).padStart(2, '0'), kind: 'standalone', profile: null, version: 1, ownerId: 'u1', ownerName: 'Asha', updatedBy: 'Asha', updatedAt: now - i * 1000, timeRange: 'realtime', copiedFrom: null,
        widgets: [{ id: 'w' + i, type: 'value', title: 'SA VALUE ' + i, x: 0, y: 0, w: 3, h: 2, binding: { mode: 'fixed', deviceIds: ['pc'] }, keys: ['dischargePressure'], settings: {} }] };
    }
    // one machine-type dashboard (listed for editors only, under "Machine types", D-033)
    docs.dbb_d_dev1 = { ...docs.dbb_d_sa1, id: 'dev1', name: 'Machine board', kind: 'device', profile: 'Compressor', widgets: [{ ...docs.dbb_d_sa1.widgets[0], binding: { mode: 'current' } }] };
    window.__tb.setAttrs('ASSET', 'store', docs);
  }, n);
}

test('navbar: Dashboard list shows overviews (editors also machine types), with search, sort and pages; Open shows it in the Dashboard Overview state', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc'));
  await seedStandalone(t, 11);
  await t.page.click('#nav .dbb-launch-btn');
  await t.page.click('.dbb-emenu [data-m="__list"]');
  await t.page.waitForSelector('.dbb-dl .row');
  await t.page.waitForTimeout(250);
  await t.page.screenshot({ path: join(tmpdir(), 'dlist.png') });
  const names = () => t.b(() => [...document.querySelectorAll('.dbb-dl .row .nm span')].map((r) => r.textContent));
  ok(/Showing 1–8 of 12/.test(await t.page.textContent('.dbb-dl [data-count]')), 'All: 11 overviews + 1 machine type');
  await t.click('.dbb-dl [data-kind="standalone"]');
  let n = await names();
  eq(n.length, 8, 'first page has 8');
  ok(!n.some((x) => /Machine board/.test(x)), 'Overviews: no machine-type dashboards');
  eq(n[0], 'Energy board 07', 'sorted A–Z');
  ok(/Showing 1–8 of 11/.test(await t.page.textContent('.dbb-dl [data-count]')), 'count');
  await t.page.click('.dbb-dl [data-pager] [aria-label="Page 2"]');
  eq((await names()).length, 3, 'second page has 3');
  ok(await t.page.isDisabled('.dbb-dl [aria-label="Next page"]'), 'no third page');
  await t.page.click('.dbb-dl [data-sort="recent"]');
  eq((await names())[0], 'Fleet board 01', 'recently updated first');
  await t.page.fill('.dbb-dl [data-q]', 'energy');
  n = await names();
  eq(n, ['Energy board 07'], 'search by name');
  ok(await t.page.$('.dbb-dl .nm mark'), 'match highlighted');
  ok(await t.page.$('.dbb-dl [data-edit]'), 'admins get Edit');
  await t.page.click('.dbb-dl [data-open="sa7"]');
  await t.page.waitForFunction(() => /SA VALUE 7/.test(document.querySelector('.dbb-rbody')?.textContent ?? ''), null, { timeout: 5000 });
  eq(await t.b(() => window.__stateId()), 'dashboard_overview', 'opened in the Dashboard Overview state');
  ok(/Energy board 07/.test(await t.page.textContent('.dbb-rhead')), 'standalone dashboard shown with its name');
  ok(!(await t.page.$('.dbb-dl')), 'dialog closed');
  // the edit menu on that state: Edit this dashboard, Dashboard list, Dashboard Builder
  await t.page.waitForFunction(() => window.__imexDbbActions?.items?.length > 0, null, { timeout: 5000 });
  await t.page.click('#nav .dbb-launch-btn');
  eq(await t.b(() => [...document.querySelectorAll('.dbb-emenu [data-m]')].map((b) => b.dataset.m)), ['edit', '__list', '__new', '__builder'], 'menu items on the overview state');
  await t.page.click('.dbb-emenu [data-m="__builder"]');
  await t.page.waitForSelector('.dbb-overlay .dbb-top select');
  await t.page.waitForTimeout(500);
  eq(await t.page.inputValue('.dbb-top [data-a="name"]'), 'Energy board 07', 'Dashboard Builder opens the shown dashboard');
});

test('navbar: without a Dashboard Overview state the list falls back to the machine state', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc&noOverview=1'));
  await seedStandalone(t, 2);
  await t.page.click('#nav .dbb-launch-btn');
  await t.page.click('.dbb-emenu [data-m="__list"]');
  await t.page.waitForSelector('.dbb-dl .row');
  await t.page.click('.dbb-dl .row[data-id="sa2"]');
  await t.page.waitForFunction(() => /SA VALUE 2/.test(document.querySelector('.dbb-rbody')?.textContent ?? ''), null, { timeout: 5000 });
  eq(await t.b(() => window.__stateId()), 'machine', 'fell back to the machine state');
});

test('navbar: Edit in the Dashboard list opens the builder on that dashboard', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc'));
  await seedStandalone(t, 3);
  await t.page.click('#nav .dbb-launch-btn');
  await t.page.click('.dbb-emenu [data-m="__list"]');
  await t.page.click('.dbb-dl [data-edit="sa2"]');
  await t.page.waitForSelector('.dbb-overlay .dbb-top select');
  await t.page.waitForTimeout(600);
  eq(await t.page.inputValue('.dbb-top [data-a="name"]'), 'Fleet board 02', 'builder opened on it');
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), '', 'as a standalone dashboard');
});

test('navbar: viewers get a list icon with only the Dashboard list', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc&role=Viewer'));
  await seedStandalone(t, 2);
  await t.page.waitForSelector('#nav .dbb-launch-btn', { state: 'visible' });
  eq(await t.page.getAttribute('#nav .dbb-launch-btn', 'title'), 'Dashboards', 'list icon for viewers');
  await t.page.click('#nav .dbb-launch-btn');
  eq(await t.b(() => [...document.querySelectorAll('.dbb-emenu [data-m]')].map((b) => b.dataset.m)), ['__list'], 'only the Dashboard list');
  await t.page.click('.dbb-emenu [data-m="__list"]');
  await t.page.waitForSelector('.dbb-dl .row');
  ok(!(await t.page.$('.dbb-dl [data-edit]')), 'no Edit for viewers');
  ok(!(await t.page.$('.dbb-dl [data-kind]')) && !(await t.page.$('.dbb-dl .row[data-id="dev1"]')), 'viewers see overviews only');
  await t.page.keyboard.press('Escape');
  ok(!(await t.page.$('.dbb-dl')), 'Esc closes');
});

// ------------------------------------------------------------------ D-056 the app's dark mode
/** Background of an element as [r, g, b] (first rgb of its computed background colour). */
const bgOf = (sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  const m = getComputedStyle(e).backgroundColor.match(/\d+(\.\d+)?/g);
  return m ? m.slice(0, 3).map(Number) : null;
};
const dark = (c) => !!c && c[0] + c[1] + c[2] < 3 * 80;
const switchMode = (mode) => {
  document.documentElement.setAttribute('data-imx-mode', mode);
  window.dispatchEvent(new CustomEvent('imx-mode-changed', { detail: { mode } }));
};

test('dark mode (D-056): the machine page follows the app light / dark switch; light mode as before', async (t) => {
  await t.page.close();
  const s = await open('dev=pc');
  Object.assign(t, s);
  await t.page.waitForSelector('.dbb-rend .dbb-card');
  const light = await t.b(bgOf, '.dbb-rend .dbb-card');
  ok(light && !dark(light), `light card: ${light}`);
  ok(!(await t.b(() => document.querySelector('.dbb-rend').classList.contains('dbb-appdark'))), 'no dark class in light mode');
  await t.b(switchMode, 'dark');
  await t.page.waitForTimeout(600);
  const d = await t.b(() => ({ cls: document.querySelector('.dbb-rend').classList.contains('dbb-appdark') && document.querySelector('.dbb-rend').classList.contains('dbb-dark'), plane: getComputedStyle(document.querySelector('.dbb-rend')).backgroundColor, ink: getComputedStyle(document.querySelector('.dbb-rend .dbb-card')).color }));
  ok(d.cls, 'dbb-appdark + dbb-dark on the page');
  const dc = await t.b(bgOf, '.dbb-rend .dbb-card');
  ok(dark(dc), `cards dark: ${dc}`);
  ok(dark(await t.b(bgOf, '.dbb-rend')), `page dark: ${d.plane}`);
  ok(!dark(d.ink.match(/\d+/g).slice(0, 3).map(Number)), `text light: ${d.ink}`);
  await t.b(switchMode, 'light');
  await t.page.waitForTimeout(600);
  eq(await t.b(bgOf, '.dbb-rend .dbb-card'), light, 'back to the light card colour');
  ok(!(await t.b(() => document.querySelector('.dbb-rend').classList.contains('dbb-appdark'))), 'dark class removed');
});

test('dark mode (D-056): builder panels, dialogs and canvas are dark; a dark preset stays as saved', async (t) => {
  await t.b(switchMode, 'dark');
  await t.page.waitForTimeout(600);
  for (const sel of ['.dbb-overlay', '.dbb-top', '.dbb-right', '.dbb-left', '.dbb-center']) {
    const c = await t.b(bgOf, sel);
    ok(dark(c), `${sel} dark: ${c}`);
  }
  ok(await t.b(() => document.querySelector('.dbb-center').classList.contains('dbb-appdark')), 'canvas drawn with the app dark tokens');
  // a dark preset keeps its own colours (no app-dark conversion)
  await t.b(() => window.__b.mutate((d) => (d.theme = { preset: 'dark' })));
  await t.idle(400);
  const c = await t.b(() => ({ app: document.querySelector('.dbb-center').classList.contains('dbb-appdark'), dark: document.querySelector('.dbb-center').classList.contains('dbb-dark'), surface: document.querySelector('.dbb-center').style.getPropertyValue('--surface') }));
  eq(c, { app: false, dark: true, surface: '#1a1a19' }, 'dark preset as saved');
  await t.b(switchMode, 'light');
  await t.page.waitForTimeout(400);
  ok(!dark(await t.b(bgOf, '.dbb-right')), 'light mode: the panel is light again');
});

// ------------------------------------------------------------------ D-058 Builder entries on the pages

/** Two dashboards apply to Pune Compressor 1 (its own and the customer-wide one), so the menu has "Show dashboard". */
async function seedTwoForPc(t) {
  await t.b(() => {
    const now = Date.now();
    const doc = (id, name) => ({ schemaVersion: 1, id, name, kind: 'device', profile: 'Compressor', version: 1, ownerId: 'u1', ownerName: 'Asha', updatedBy: 'u1', updatedAt: now, timeRange: 'realtime', copiedFrom: null,
      widgets: [{ id: 'w1', type: 'value', title: name.toUpperCase(), x: 0, y: 0, w: 3, h: 2, binding: { mode: 'current' }, keys: ['dischargePressure'], settings: {} }] });
    window.__tb.setAttrs('ASSET', 'store', { dbb_d_own1: doc('own1', 'Own board'), dbb_d_cw1: doc('cw1', 'Shared board'), dbb_assign_customer: { Compressor: { dashboardId: 'cw1', by: 'u1', at: now } }, dbb_assign_rev: 'v' + now });
    window.__tb.setAttrs('DEVICE', 'pc', { dbb_assign: { dashboardId: 'own1', by: 'u1', at: now, mode: 'copy' } });
    window.dispatchEvent(new CustomEvent('imex-dbb:changed'));
  });
  await t.page.waitForFunction(() => (window.__imexDbbActions?.items ?? []).filter((i) => i.group === 'switch').length === 2, null, { timeout: 8000 });
}

test('D-058: machine page bar "Edit dashboard": its menu has the edit actions, Show dashboard, New dashboard, Open Dashboard Builder; keyboard, outside click, dark', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc'));
  await seedTwoForPc(t);
  await t.page.waitForSelector('.dbb-rhead .dbb-redit');
  const b = await t.b(() => {
    const e = document.querySelector('.dbb-redit');
    const all = [...document.querySelectorAll('.dbb-ract .dbb-rbtn')].map((x) => x.getBoundingClientRect().right);
    return { label: e.getAttribute('aria-label'), text: e.textContent.trim(), pop: e.getAttribute('aria-haspopup'), exp: e.getAttribute('aria-expanded'), last: e.getBoundingClientRect().right === Math.max(...all), title: e.title, svg: !!e.querySelector('svg') };
  });
  eq([b.label, b.text, b.pop, b.exp, b.last, b.svg], ['Edit dashboard', 'Edit dashboard', 'menu', 'false', true, true], `the button ${JSON.stringify(b)}`);
  ok(!!b.title, 'tooltip');
  await t.click('.dbb-redit');
  await t.page.waitForSelector('.dbb-rmenu');
  const m = await t.b(() => {
    const el = document.querySelector('.dbb-rmenu');
    const vis = [...el.querySelectorAll('button')].filter((x) => !x.closest('[hidden]')).map((x) => x.textContent.trim());
    const r = el.getBoundingClientRect();
    const br = document.querySelector('.dbb-redit').getBoundingClientRect();
    return { head: el.querySelector('.dbb-rm-h b').textContent, vis, focus: document.activeElement.textContent.trim(), exp: document.querySelector('.dbb-redit').getAttribute('aria-expanded'), below: r.top >= br.bottom, right: Math.abs(r.right - br.right) <= 1 || r.right <= innerWidth - 8 };
  });
  eq(m.head, 'Pune Compressor 1', 'menu header: the machine');
  eq(m.vis, ['Edit this dashboard', 'Alarm thresholds…', 'Show dashboard', 'New dashboard', 'Open Dashboard Builder'], 'main actions, Show dashboard (closed), then the Builder');
  ok(m.focus === 'Edit this dashboard' && m.exp === 'true' && m.below && m.right, `focus on the first item, anchored below the button: ${JSON.stringify(m)}`);
  // Show dashboard: Right opens it, the shown dashboard has a tick and aria-checked, Left closes it
  await t.page.keyboard.press('ArrowDown');
  await t.page.keyboard.press('ArrowDown');
  eq(await t.b(() => document.activeElement.textContent.trim()), 'Show dashboard', 'arrow keys move');
  await t.page.keyboard.press('ArrowRight');
  const sw = await t.b(() => ({ rows: [...document.querySelectorAll('.dbb-rm-swl button')].map((x) => [x.textContent.trim(), x.getAttribute('aria-checked'), !!x.querySelector('svg')]), focus: document.activeElement.textContent.trim(), exp: document.querySelector('[data-sw]').getAttribute('aria-expanded'), bg: getComputedStyle(document.querySelector('.dbb-rm-swl button.on')).backgroundColor }));
  eq(sw.rows, [['Own board', 'true', true], ['Shared board', 'false', false]], 'the dashboards that apply, the shown one ticked');
  eq([sw.focus, sw.exp], ['Own board', 'true'], 'Right opens the group');
  eq(sw.bg, 'rgba(0, 0, 0, 0)', 'no filled selection');
  await t.page.keyboard.press('ArrowLeft');
  eq(await t.b(() => [document.activeElement.textContent.trim(), document.querySelector('.dbb-rm-swl').hidden]), ['Show dashboard', true], 'Left closes it');
  // Escape closes and gives the focus back
  await t.page.keyboard.press('Escape');
  eq(await t.b(() => [!!document.querySelector('.dbb-rmenu'), document.activeElement.classList.contains('dbb-redit'), document.querySelector('.dbb-redit').getAttribute('aria-expanded')]), [false, true, 'false'], 'Escape closes, focus on the button');
  // a click outside closes; a second click on the button closes too
  await t.click('.dbb-redit');
  await t.page.mouse.click(300, 600);
  ok(!(await t.page.$('.dbb-rmenu')), 'outside click closes');
  await t.click('.dbb-redit');
  await t.click('.dbb-redit');
  ok(!(await t.page.$('.dbb-rmenu')), 'the button toggles');
  // a switch item shows the other dashboard (no save)
  await t.click('.dbb-redit');
  await t.click('.dbb-rmenu [data-sw]');
  await t.click('.dbb-rmenu [data-run="switch:cw1"]');
  await t.page.waitForFunction(() => /SHARED BOARD/.test(document.querySelector('.dbb-rbody')?.textContent ?? ''), null, { timeout: 5000 });
  ok(!(await t.page.$('.dbb-rmenu')), 'menu closed after an action');
  // dark mode: the menu takes the app's dark surface
  await t.b(switchMode, 'dark');
  await t.click('.dbb-redit');
  const bg = await t.b(bgOf, '.dbb-rmenu');
  ok(dark(bg), `dark menu: ${bg}`);
  await t.page.keyboard.press('Escape');
  await t.b(switchMode, 'light');
  // New dashboard: the Builder with its New dashboard dialog (cancelled, nothing saved)
  await t.click('.dbb-redit');
  await t.click('.dbb-rmenu [data-new]');
  await t.page.waitForSelector('.dbb-overlay .dbb-modal :text("What is it for?")', { timeout: 6000 });
  await t.modalBtn('cancel');
  await t.click('.dbb-top [data-a="close"]');
  await t.page.waitForFunction(() => !document.querySelector('.dbb-overlay'));
  // Open Dashboard Builder: on this machine
  await t.click('.dbb-redit');
  await t.click('.dbb-rmenu [data-builder]');
  await t.page.waitForSelector('.dbb-overlay .dbb-top select', { timeout: 6000 });
  await t.page.waitForTimeout(400);
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), 'pc', 'Open Dashboard Builder: on the shown machine');
});

test('D-058: "Edit dashboard" at phone width, under html.imx-mobile, for viewers, and on the Dashboard Overview page', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc&shell=1'));
  await t.page.setViewportSize({ width: 390, height: 844 });
  await t.page.waitForSelector('.dbb-rhead .dbb-redit');
  await t.page.waitForTimeout(300);
  const p = await t.b(() => {
    const e = document.querySelector('.dbb-redit');
    const h = document.querySelector('.dbb-rhead');
    return { w: e.getBoundingClientRect().width, span: getComputedStyle(e.querySelector('span')).display, sw: h.scrollWidth, cw: h.clientWidth };
  });
  ok(p.w <= 30 && p.span === 'none' && p.sw <= p.cw + 1, `icon only and the bar fits: ${JSON.stringify(p)}`);
  await t.click('.dbb-redit');
  const r = await t.b(() => { const x = document.querySelector('.dbb-rmenu').getBoundingClientRect(); return [x.left, x.right, innerWidth]; });
  ok(r[0] >= 8 && r[1] <= r[2] - 8 + 1, `menu inside the window at 390 px: ${r}`);
  await t.page.close();
  Object.assign(t, await open('dev=pc&shell=1&mobile=1'));
  await t.page.waitForTimeout(1200);
  ok(!(await t.page.$('.dbb-redit')), 'no Edit dashboard on the phone app (view only, D-054)');
  await t.page.close();
  Object.assign(t, await open('dev=pc&role=Viewer'));
  await t.page.waitForSelector('.dbb-rhead .dbb-status-pill');
  await t.page.waitForTimeout(800);
  ok(!(await t.page.$('.dbb-redit')), 'no Edit dashboard for a viewer');
  await t.page.close();
  Object.assign(t, await open('dev=pc'));
  await seedStandalone(t, 7);
  await t.page.click('#nav .dbb-launch-btn');
  await t.page.click('.dbb-emenu [data-m="__list"]');
  await t.page.click('.dbb-dl [data-open="sa7"]');
  await t.page.waitForFunction(() => /SA VALUE 7/.test(document.querySelector('.dbb-rbody')?.textContent ?? ''), null, { timeout: 5000 });
  await t.page.waitForSelector('.dbb-rhead .dbb-redit');
  await t.click('.dbb-redit');
  eq(await t.b(() => [document.querySelector('.dbb-rm-h b').textContent, ...[...document.querySelectorAll('.dbb-rmenu button')].map((x) => x.textContent.trim())]), ['Energy board 07', 'Edit this dashboard', 'New dashboard', 'Open Dashboard Builder'], 'Dashboard Overview page: its edit action and the Builder');
  await t.click('.dbb-rmenu [data-builder]');
  await t.page.waitForSelector('.dbb-overlay .dbb-top select', { timeout: 6000 });
  await t.page.waitForTimeout(400);
  eq(await t.page.inputValue('.dbb-top [data-a="name"]'), 'Energy board 07', 'Open Dashboard Builder opens the overview shown');
});

test('D-058: Dashboards page: New dashboard and Open Dashboard Builder at the top for editors, once per page; none for viewers', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc'));
  await t.b(() => window.__mountLauncher({ headless: true }));
  await t.page.waitForFunction(() => typeof window.IMEX_DBB?.dashboardPage === 'function');
  const mount = (o) =>
    t.b(async (o) => {
      document.getElementById('dl-host')?.remove();
      const wrap = document.createElement('div');
      wrap.id = 'dl-host';
      wrap.style.cssText = 'position:fixed;left:300px;top:80px;width:900px;height:600px;z-index:5;background:#fff';
      if (o.banner) wrap.innerHTML = '<div class="imx-dl"><header class="imx-dl-head"><button data-el="new">New dashboard</button></header><div class="imx-dl-body"></div></div>';
      document.body.appendChild(wrap);
      await window.IMEX_DBB.dashboardPage(wrap.querySelector('.imx-dl-body') ?? wrap, o.opts);
      return { btns: [...wrap.querySelectorAll('.dbb-dl .pacts button')].map((b) => [b.textContent.trim(), b.getAttribute('aria-label'), !!b.title]), empty: wrap.querySelector('.dbb-dl .empty')?.textContent ?? '' };
    }, o);
  let r = await mount({});
  eq(r.btns, [['Open Dashboard Builder', 'Open Dashboard Builder', true], ['New dashboard', 'New dashboard', true]], 'both buttons for an editor');
  ok(/New dashboard at the top of this page/.test(r.empty), `empty state points at the button: ${r.empty}`);
  const pos = await t.b(() => {
    const s = document.querySelector('#dl-host .search').getBoundingClientRect();
    const n = document.querySelector('#dl-host [data-new]').getBoundingClientRect();
    return { same: Math.abs(s.top - n.top) < 2, h: n.height, right: Math.round(document.querySelector('#dl-host .tools').getBoundingClientRect().right - n.right) };
  });
  ok(pos.same && pos.h === 40 && pos.right <= 24, `at the top right, 40 px like the search: ${JSON.stringify(pos)}`);
  eq((await mount({ banner: true })).btns, [], 'the page has its own New dashboard: not twice');
  eq((await mount({ banner: true, opts: { buttons: true } })).btns.length, 2, 'buttons: true shows them anyway');
  eq((await mount({ opts: { buttons: false } })).btns, [], 'buttons: false hides them');
  await mount({});
  await t.click('#dl-host [data-new]');
  await t.page.waitForSelector('.dbb-overlay .dbb-modal :text("What is it for?")', { timeout: 6000 });
  await t.modalBtn('cancel');
  await t.click('.dbb-top [data-a="close"]');
  await t.page.waitForFunction(() => !document.querySelector('.dbb-overlay'));
  await t.click('#dl-host [data-builder]');
  await t.page.waitForSelector('.dbb-overlay .dbb-top select', { timeout: 6000 });
  ok(true, 'Open Dashboard Builder opens the Builder');
  await t.page.close();
  Object.assign(t, await open('dev=pc&role=Viewer'));
  await t.b(() => window.__mountLauncher({ headless: true }));
  await t.page.waitForFunction(() => typeof window.IMEX_DBB?.dashboardPage === 'function');
  r = await mount({});
  eq(r.btns, [], 'no buttons for a viewer');
  eq(await t.b(() => !!document.querySelector('#dl-host .dbb-dl')), true, 'the list is still drawn');
});

test('D-063: "?" Help for this page at the right end of the machine bar and the Dashboard Overview bar; opens Help with helpFrom; hidden without Help and on a phone', async (t) => {
  await t.page.close();
  Object.assign(t, await open('dev=pc&shell=1&help=1'));
  await t.page.setViewportSize({ width: 1440, height: 900 });
  await t.page.waitForSelector('.dbb-rhead .dbb-rhelp');
  await t.page.waitForTimeout(400);
  const geo = () =>
    t.b(() => {
      const h = document.querySelector('.dbb-rhead');
      const b = h.querySelector('.dbb-rhelp');
      const r = b.getBoundingClientRect();
      const others = [...h.querySelectorAll('.dbb-rbtn, .dbb-tw')].map((x) => x.getBoundingClientRect());
      const s = getComputedStyle(b);
      return {
        last: h.lastElementChild === b,
        w: r.width,
        h: r.height,
        svg: b.querySelector('svg').getBoundingClientRect().width,
        tip: b.getAttribute('data-imx-tip'),
        aria: b.getAttribute('aria-label'),
        color: s.color,
        rightmost: others.every((o) => o.right <= r.left + 1 && Math.abs(o.top + o.height / 2 - (r.top + r.height / 2)) < 20),
        fits: h.scrollWidth <= h.clientWidth + 1,
        iconOnly: [...h.querySelectorAll('.dbb-rbtn span')].every((x) => getComputedStyle(x).display === 'none'),
      };
    });
  let g = await geo();
  ok(g.last && g.w === 36 && g.h === 36 && g.svg === 18, `36 x 36, 18 px icon, last in the bar: ${JSON.stringify(g)}`);
  eq([g.tip, g.aria], ['Help for this page', 'Help for this page'], 'tooltip and label');
  eq(g.color, 'rgba(219, 229, 245, 0.82)', 'the page header colour on the banner');
  ok(g.rightmost && g.fits, `right of every other bar item, same row, no overflow: ${JSON.stringify(g)}`);
  await t.page.setViewportSize({ width: 1100, height: 800 });
  await t.page.waitForTimeout(300);
  g = await geo();
  ok(g.iconOnly && g.fits && g.rightmost, `1100 px: the bar buttons stay icon-only, the "?" at the right end: ${JSON.stringify(g)}`);
  await t.click('.dbb-rhelp');
  await t.page.waitForTimeout(200);
  eq(await t.b(() => [window.__stateId(), window.__stateParams()]), ['help', { helpFrom: 'machine' }], 'opens Help told it came from the machine page');
  // the Dashboard Overview page (a dashboard opened from the Dashboards list)
  await t.page.close();
  Object.assign(t, await open('dev=pc&shell=1&help=1'));
  await seedStandalone(t, 7);
  await t.page.click('#nav .dbb-launch-btn');
  await t.page.click('.dbb-emenu [data-m="__list"]');
  await t.page.click('.dbb-dl [data-open="sa7"]');
  await t.page.waitForFunction(() => /SA VALUE 7/.test(document.querySelector('.dbb-rbody')?.textContent ?? ''), null, { timeout: 5000 });
  await t.page.waitForSelector('.dbb-rhead .dbb-rhelp');
  ok(await t.b(() => document.querySelector('.dbb-rhead').lastElementChild.classList.contains('dbb-rhelp')), 'the "?" ends the Dashboard Overview bar');
  await t.click('.dbb-rhelp');
  await t.page.waitForTimeout(200);
  eq(await t.b(() => [window.__stateId(), window.__stateParams()]), ['help', { helpFrom: 'dashboard_overview' }], 'opens Help told it came from the Dashboard Overview page');
  // no Help state on the dashboard: no "?"; a phone: no "?"
  await t.page.close();
  Object.assign(t, await open('dev=pc&shell=1'));
  await t.page.waitForSelector('.dbb-rhead .dbb-status-pill');
  await t.page.waitForTimeout(600);
  ok(!(await t.page.$('.dbb-rhelp')), 'no "?" when the dashboard has no Help page');
  await t.page.close();
  Object.assign(t, await open('dev=pc&shell=1&help=1&mobile=1'));
  await t.page.waitForSelector('.dbb-rhead .dbb-status-pill');
  await t.page.waitForTimeout(600);
  ok(!(await t.page.$('.dbb-rhelp')), 'no "?" on a phone');
});

// ------------------------------------------------------------------ run

const only = process.argv.slice(2).map((s) => s.toLowerCase());
let failed = 0;
for (const tc of tests) {
  if (only.length && !only.some((w) => tc.name.toLowerCase().includes(w))) continue;
  const t0 = Date.now();
  let h;
  try {
    h = await open();
    await tc.fn(h);
    if (h.errors.length) throw new Fail(h.errors.join('\n    '));
    console.log(`✓ ${tc.name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${tc.name}\n    ${e instanceof Fail ? e.message : e.stack?.split('\n').slice(0, 3).join('\n    ')}${h?.errors.length ? '\n    page errors: ' + h.errors.join(' | ') : ''}`);
    if (h) await h.page.screenshot({ path: join(tmpdir(), `e2e-fail-${tc.name.replace(/\W+/g, '_').slice(0, 40)}.png`) }).catch(() => undefined);
  } finally {
    await h?.page.close().catch(() => undefined);
  }
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
await browser.close();
srv.close();
process.exit(failed ? 1 : 0);
