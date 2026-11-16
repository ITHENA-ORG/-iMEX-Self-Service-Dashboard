// D-094 (final QA S-01, S-02, D-08, 17 Nov 2026): the phone / tablet layout of the "Self Service Dashboard".
// Below 960 px the platform stacks the widgets of a state one under the other (its "mobile" layout). Three fixes:
//   S-01  the side menu cell of a state must not be hidden there (`mobileHide` on the cell; the server had it on the
//         states "default" and "machine": below 960 px no menu, no dark mode, no kit / AETHER on those pages);
//   S-02  every state's main layout fills the screen (gridSettings mobileAutoFillHeight true, mobileRowHeight 8, as the
//         iMEX Mobile dashboards) and the headless side menu / launcher cells take 1 row (mobileHeight 1), so there is
//         no empty band at 768 px and no double scroll on phones; a page cell without a phone height gets the usual
//         page share (71 rows, 64 under the page header; the server's alarm history);
//   D-08  the Machines listing's "Organization Hierarchy" widget: no platform title bar (showTitle false) and its title
//         spelled right ("Orgnization" on the server). On phones its cell is a 0 px sheet anchor, so it takes 2 rows of
//         the filled layout (mobileHeight 2), or the cards would get only half the screen.
// Everything else of the dashboard (edited on the server by hand) stays as it is. Dry run by default: it prints
// every change and writes nothing. With --go it backs the dashboard up to backups/<day>/ first, then saves it once.
//
//   node scripts/mirror/mobile-layout.mjs                       server (NEW tenant, TGT_TB_*), dashboard db4109a0-…, dry run
//   node scripts/mirror/mobile-layout.mjs --go                  the same, saved (only on Akshay's go-ahead)
//   node scripts/mirror/mobile-layout.mjs --local [--go]        LOCAL's "Self Service Dashboard"
//   node scripts/mirror/mobile-layout.mjs --local --dashboard <id> [--go]   another LOCAL dashboard (e.g. a test copy)
//
// Server guard: the server is reached only through newTenantClient(), which refuses the read-only SOURCE tenant
// (iserv-demov2's original tenant, SRC_TB_*), and on the server the dashboard id must be the expected one unless
// --dashboard names another. A dry run sends GET requests only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { newTenantClient, targetClient } from './clients.mjs';

const argv = process.argv.slice(2);
const GO = argv.includes('--go');
const LOCAL = argv.includes('--local');
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const SERVER_DASHBOARD = 'db4109a0-c279-11f1-9f70-2b66090a5d6c';

const MENU = 'tenant.imex_side_menu';
const LAUNCHER = 'tenant.imex_dbb_launcher';
const HIERARCHY = 'tenant.imex_org_hierarchy';
const HEADER = 'tenant.imex_page_header';
const HIERARCHY_TITLE = 'Organization Hierarchy';
const MOBILE_ROW_HEIGHT = 8;

const T = LOCAL ? await targetClient() : await newTenantClient();
let id = arg('--dashboard');
if (!id) {
  if (LOCAL) {
    const r = await T.api('GET', '/api/tenant/dashboards?pageSize=50&page=0&textSearch=Self%20Service%20Dashboard');
    const hit = r.data.filter((x) => x.title === 'Self Service Dashboard');
    if (hit.length !== 1) { console.error(`LOCAL: ${hit.length} dashboards titled "Self Service Dashboard"; name one with --dashboard`); process.exit(1); }
    id = hit[0].id.id;
  } else id = SERVER_DASHBOARD;
}
const d = await T.api('GET', '/api/dashboard/' + id);
console.log(`${T.label} ${new URL(T.base).host}: dashboard "${d.title}" ${id} (version ${d.version})${GO ? '' : ' — DRY RUN, nothing is written'}`);

const W = d.configuration.widgets || {};
const S = d.configuration.states || {};
const fqn = (wid) => (W[wid] && W[wid].typeFullFqn) || '';
const short = (wid) => fqn(wid).replace(/^tenant\./, '') || wid;
const changes = [];
const notes = [];
const set = (where, obj, key, value) => {
  if (obj[key] === value) return;
  changes.push(`${where}: ${key} ${JSON.stringify(obj[key])} -> ${value === undefined ? '(removed)' : JSON.stringify(value)}`);
  if (value === undefined) delete obj[key]; else obj[key] = value;
};

for (const [sid, st] of Object.entries(S)) {
  const main = st.layouts && st.layouts.main;
  if (!main) { notes.push(`state ${sid}: no main layout (skipped)`); continue; }
  main.gridSettings = main.gridSettings || {};
  // S-02: the stacked layout fills the screen
  set(`state ${sid} grid`, main.gridSettings, 'mobileAutoFillHeight', true);
  set(`state ${sid} grid`, main.gridSettings, 'mobileRowHeight', MOBILE_ROW_HEIGHT);
  for (const [wid, cell] of Object.entries(main.widgets || {})) {
    const f = fqn(wid);
    if (f === MENU || f === LAUNCHER) {
      // S-01: the menu is never hidden on a phone or tablet (it is headless there and draws the app's phone shell)
      if (f === MENU) set(`state ${sid} ${short(wid)} cell`, cell, 'mobileHide', undefined);
      set(`state ${sid} ${short(wid)} cell`, cell, 'mobileHeight', 1);
    } else if (cell.mobileHeight == null && f !== HEADER) {
      // a page cell without a phone height (the server's alarm history: the developers' widget, placed by hand) would
      // get sizeY x 24 / columns rows (17 of 150-column 106), so the filled layout would give its page header a quarter
      // of the screen: it gets the page share every other state has (71 rows, 64 under a 7-row page header)
      const u = (main.gridSettings.columns || 24) >= 300 ? 2 : 1;
      const header = Object.keys(main.widgets).some((x) => fqn(x) === HEADER);
      set(`state ${sid} ${short(wid)} cell`, cell, 'mobileHeight', (header ? 64 : 71) * u);
    }
    if (cell.mobileHide && f !== MENU) notes.push(`state ${sid} ${short(wid)}: hidden on phones (mobileHide); left as it is`);
  }
}
// the side menu's widget config must not hide it either (older dashboards kept mobileHide there)
for (const [wid, w] of Object.entries(W)) {
  if (fqn(wid) === MENU && w.config && w.config.mobileHide) set(`widget ${short(wid)} ${wid.slice(0, 8)} config`, w.config, 'mobileHide', undefined);
}
// D-08: the Machines listing's hierarchy widget
const listing = S.listing && S.listing.layouts && S.listing.layouts.main;
const hierIds = listing ? Object.keys(listing.widgets || {}).filter((wid) => fqn(wid) === HIERARCHY) : [];
if (!hierIds.length) notes.push('state listing: no imex_org_hierarchy widget found');
for (const wid of hierIds) {
  const c = W[wid].config = W[wid].config || {};
  set(`listing ${short(wid)} config`, c, 'showTitle', false);
  set(`listing ${short(wid)} config`, c, 'title', HIERARCHY_TITLE);
  // below 960 px the tree is a sheet over the cards and its cell is drawn 0 px high (imex_org_hierarchy CSS
  // "gridster.mobile gridster-item.imx-tp-tree{height:0}"); with the filled layout a 71-row share would leave the
  // cards only half the screen; 2 rows, not 1: in a 1-row cell the platform never starts the widget (tested on LOCAL
  // 17 Nov: 1 row = no tree, no "Organisation" button; 2 rows = sheet mode, cards 799 of 844 px at 390 px)
  set(`listing ${short(wid)} cell`, listing.widgets[wid], 'mobileHeight', 2);
}

console.log(`${Object.keys(S).length} states; ${changes.length} change(s):`);
for (const c of changes) console.log('  ' + c);
if (notes.length) { console.log('notes:'); for (const n of notes) console.log('  ' + n); }
if (!changes.length) console.log('nothing to change');
else if (!GO) console.log('Dry run. Re-run with --go to save (server: only on Akshay\'s go-ahead).');
else {
  const day = new Date().toISOString().slice(0, 10);
  mkdirSync(`backups/${day}`, { recursive: true });
  const before = await T.api('GET', '/api/dashboard/' + id); // the untouched copy, as stored
  const file = `backups/${day}/${LOCAL ? 'local' : 'server'}-dashboard-${id}-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(before));
  console.log('backup:', file);
  // the platform refuses a save over a newer version (optimistic locking), so a hand edit in between is never overwritten
  const saved = await T.api('POST', '/api/dashboard', d);
  console.log(`saved: version ${before.version} -> ${saved.version}`);
}
