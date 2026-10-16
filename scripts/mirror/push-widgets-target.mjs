// Brings the app's WIDGET TYPES from LOCAL to the NEW tenant on the server ("iMEX - AI Features"), and nothing else:
// the dashboard, rule chains, device profiles, assets, attributes and machines on the server are not touched (they are
// edited on the server by hand: service addresses, LLM key, alarm rules, ...).
//   node scripts/mirror/push-widgets-target.mjs          dry run: which widget types would change, how hand edits merge
//   node scripts/mirror/push-widgets-target.mjs --go     backs up the server's widget types, then writes
// As migrate-target.mjs: libraries from the server's own folder (cdn-map.mjs). In addition, local entity ids found in a
// widget's code (e.g. a customer id) are replaced with the server's ids (mirror-data/target-idmap.json).
// Widget types changed on the server since the last run (target-last-run.json, from the audit log) are merged, not
// replaced: base = the version the hand edit started from (BASES, chosen by reading the audit history with
// widget-history.mjs), theirs = the server's version now, mine = the new local version; text parts with git merge-file.
// Any conflict, or a hand-edited widget without a known base, stops the run before anything is written.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { newTenantClient, targetClient } from './clients.mjs';
import { CDN_MAP } from './cdn-map.mjs';

const GO = process.argv.includes('--go');
const OUR_WIDGET = /^(imex_|aiml_)/;
// Never pushed: the developers replaced these pages on the server with their own widgets (Akshay, 9 Oct 2026). The
// server's alert_history state uses tenant.imex_v5_alert_history_page, not the local imex_alert_history.
// imex_v5_alert_history_page (the developers' widget) IS pushed since 10 Oct (Akshay's go-ahead): the UI repo's copy
// with the 4 agreed changes, merged over their server version.
const NEVER_PUSH = new Set(['imex_alert_history']);
// --skip=a,b,prefix_* leaves those widget types as they are on the server for this run (e.g. the Reports and AI widgets
// while their services on pmiserv-thg are not redeployed yet: --skip=imex_rpt_*,aiml_*)
const SKIP = (process.argv.find((a) => a.startsWith('--skip=')) || '').slice(7).split(',').map((s) => s.trim()).filter(Boolean);
// --only=a,b,prefix_* pushes only these widget types and leaves every other one as it is (e.g. one feature's widgets:
// --only=imex_help,imex_side_menu)
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').map((s) => s.trim()).filter(Boolean);
const matches = (list, fqn) => list.some((p) => (p.endsWith('*') ? fqn.startsWith(p.slice(0, -1)) : fqn === p));
const skipped = (fqn) => matches(SKIP, fqn) || (ONLY.length > 0 && !matches(ONLY, fqn));
const LAST_RUN = 'mirror-data/target-last-run.json';
// the save each hand edit on the server started from (UTC, from the audit log):
//   machine cards 09:18 and org hierarchy 09:19 / 11:21 (debug logs commented out) on top of the 07:53 run;
//   user management 06:09 (the server's ITHENA customer id), put back at 09:32, on top of the 05:11 run (8 Oct)
//   9 Oct: side menu 13:20 (the developers' AETHER assistant) and page header 12:56-13:10 on top of the 04:12-04:13 run;
//   the developers' v5 alert history page: created 05:27, last saved 10:38:55, the version the UI repo's copy started from
const BASES = {
  imex_machine_cards: '2026-10-08T07:53:04', imex_org_hierarchy: '2026-10-08T07:53:05', imex_user_management: '2026-10-08T05:11:47',
  // side menu and page header: their latest server saves (AETHER, the mcpUrl setting) were merged into the UI repo by hand
  // on 10 Oct, so those saves are the base; any later server edit is still detected and merged
  // side menu: 13 Oct the developers edited AETHER (07:31, 07:39) on top of the 12 Oct 21:18 run; their edits were taken
  // into the UI repo by hand, so that run is the base
  // sites page: 16 Oct 08:00 ai@imex.com added the ticket-cell width CSS; folded into the UI repo (U-066), so that save is the base
  imex_sites_page: '2026-10-16T08:00:15',
  imex_side_menu: '2026-10-12T21:18:11', imex_page_header: '2026-10-09T13:10:59', imex_v5_alert_history_page: '2026-10-09T10:38:55',
};
const TEXT = ['controllerScript', 'templateHtml', 'templateCss'];
const JSONISH = ['settingsSchema', 'dataKeySettingsSchema', 'latestDataKeySettingsSchema', 'defaultConfig', 'resources', 'sizeX', 'sizeY', 'type', 'settingsForm', 'dataKeySettingsForm', 'latestDataKeySettingsForm', 'settingsDirective', 'dataKeySettingsDirective', 'latestDataKeySettingsDirective', 'hasBasicMode', 'basicModeDirective'];

const say = (m) => console.log(new Date().toISOString().slice(11, 19), m);
const toServerLibs = (s) => { for (const [path, url] of Object.entries(CDN_MAP)) s = s.split(url).join(path); return s; };
const idmap = JSON.parse(readFileSync('mirror-data/target-idmap.json', 'utf8'));
const toServerIds = (s) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => idmap[id] || id);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const T = await newTenantClient();
const L = await targetClient(); // LOCAL: read only here
const last = JSON.parse(readFileSync(LAST_RUN, 'utf8'));
say(`local ${L.base} -> new tenant ${T.base}   ${GO ? 'WRITING' : 'DRY RUN: nothing is written'}`);

// hand edits since the last run, per widget type. The server logs the last writes of a run a moment after this script
// noted its end (seen 10 Oct: same second), so entries up to 30 s after the end are the run's own and are not edits.
const OWN_WRITES_MS = 30000;
const edited = {};
for (let p = 0; p < 20; p++) {
  const r = await T.api('GET', `/api/audit/logs?pageSize=1000&page=${p}&startTime=${last.end + OWN_WRITES_MS}&endTime=${Date.now()}&sortProperty=createdTime&sortOrder=ASC`);
  for (const a of r.data) if (a.entityId && a.entityId.entityType === 'WIDGET_TYPE' && a.actionType === 'UPDATED') (edited[a.entityId.id] = edited[a.entityId.id] || []).push(a);
  if (!r.hasNext) break;
}

function merge3(base, theirs, mine, label) {
  const dir = `mirror-data/merge/${label}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/base`, base ?? '');
  writeFileSync(`${dir}/theirs`, theirs ?? '');
  writeFileSync(`${dir}/mine`, mine ?? '');
  try {
    return { text: execFileSync('git', ['merge-file', '-p', `${dir}/mine`, `${dir}/base`, `${dir}/theirs`], { encoding: 'utf8', maxBuffer: 64 << 20 }), conflicts: 0 };
  } catch (e) {
    if (typeof e.status === 'number' && e.status > 0) return { text: e.stdout, conflicts: e.status };
    throw e;
  }
}

const plan = [];
let stop = false;
for (const t of await L.all('/api/widgetTypes?tenantOnly=true')) {
  if (!OUR_WIDGET.test(t.fqn)) continue;
  if (NEVER_PUSH.has(t.fqn)) { say(`skip ${t.fqn}: the server uses the developers' own widget for this page`); continue; }
  if (skipped(t.fqn)) { say(`skip ${t.fqn}: --skip (left as it is on the server for this run)`); continue; }
  const loc = await L.api('GET', `/api/widgetType/${t.id.id}`);
  const mine = JSON.parse(toServerIds(toServerLibs(JSON.stringify(loc.descriptor))));
  const cur = await T.api('GET', `/api/widgetType?fqn=tenant.${t.fqn}`, undefined, { allow404: true });
  if (!cur) { plan.push({ t, mine, cur: null, note: 'new on the server' }); continue; }
  const hand = edited[cur.id.id];
  let descriptor = mine;
  let note = '';
  if (hand) {
    const baseAt = BASES[t.fqn];
    if (!baseAt) { say(`STOP ${t.fqn}: edited on the server since the last run (${hand.length}x) and no known base: read its history first (widget-history.mjs)`); stop = true; continue; }
    const log = await T.api('GET', `/api/audit/logs/entity/WIDGET_TYPE/${cur.id.id}?pageSize=200&page=0&sortProperty=createdTime&sortOrder=ASC`);
    const baseEntry = log.data.find((a) => new Date(a.createdTime).toISOString().slice(0, 19) === baseAt);
    if (!baseEntry || !baseEntry.actionData || !baseEntry.actionData.entity) { say(`STOP ${t.fqn}: the base save ${baseAt} is not in the audit log`); stop = true; continue; }
    const base = baseEntry.actionData.entity.descriptor;
    const theirs = cur.descriptor;
    descriptor = { ...mine };
    const notes = [];
    for (const k of TEXT) {
      if (same(theirs[k], base[k])) continue;           // not edited on the server
      if (same(mine[k], base[k])) { descriptor[k] = theirs[k]; notes.push(`${k}: theirs`); continue; }
      const m = merge3(base[k], theirs[k], mine[k], `${t.fqn}-${k}`);
      if (m.conflicts) { say(`STOP ${t.fqn} ${k}: ${m.conflicts} conflict(s) merging the server's edit (see mirror-data/merge/${t.fqn}-${k})`); stop = true; }
      descriptor[k] = m.text;
      notes.push(`${k}: merged`);
    }
    for (const k of JSONISH) {
      if (same(theirs[k], base[k]) || theirs[k] === undefined) continue;
      if (same(mine[k], base[k]) || same(mine[k], theirs[k])) { descriptor[k] = theirs[k]; notes.push(`${k}: theirs`); continue; }
      // a settings form (a list of {id, ...}) changed on both sides: ours, plus the settings the server added that the
      // base did not have (a setting the server only re-worded keeps our wording; one we removed stays removed)
      const isForm = (v) => Array.isArray(v) && v.every((x) => x && typeof x === 'object' && x.id);
      if (/SettingsForm$|^settingsForm$/.test(k) && isForm(mine[k]) && isForm(theirs[k]) && isForm(base[k] || [])) {
        const known = new Set((base[k] || []).map((x) => x.id).concat(mine[k].map((x) => x.id)));
        const added = theirs[k].filter((x) => !known.has(x.id));
        descriptor[k] = mine[k].concat(added);
        notes.push(`${k}: ours + the server's new ${added.map((x) => x.id).join(', ') || '(none)'}`);
        continue;
      }
      say(`STOP ${t.fqn} ${k}: changed on the server and locally`); stop = true;
    }
    note = `hand-edited on the server (${hand.length}x), merged with the base of ${baseAt}: ${notes.join(', ') || 'nothing of theirs left to keep'}`;
  }
  const changed = TEXT.concat(JSONISH).filter((k) => !same(descriptor[k], cur.descriptor[k]));
  if (!changed.length && same(loc.name, cur.name)) continue;
  plan.push({ t, loc, cur, descriptor, note, changed });
}
for (const x of plan) say(`${GO ? 'update' : 'would update'} ${x.t.fqn}${x.changed ? ' (' + x.changed.join(', ') + ')' : ''}${x.note ? ' · ' + x.note : ''}`);
if (stop) { say('STOPPED: nothing was written.'); process.exit(1); }
if (!GO) { say(`Dry run: ${plan.length} widget type(s) would change. Re-run with --go.`); process.exit(0); }

// back up the server's widget types, then write
const day = new Date().toISOString().slice(0, 10);
mkdirSync(`backups/${day}`, { recursive: true });
const bkFile = `backups/${day}/server-widget-types-${Date.now()}.json`;
const bk = [];
for (const x of plan) if (x.cur) bk.push(x.cur);
writeFileSync(bkFile, JSON.stringify(bk));
say(`backed up ${bk.length} widget type(s) to ${bkFile}`);
for (const x of plan) {
  const body = { fqn: x.t.fqn, name: x.loc ? x.loc.name : x.t.name, descriptor: x.descriptor || x.mine, description: (x.loc || x.t).description, image: (x.loc || x.t).image, tags: (x.loc || x.t).tags, deprecated: (x.loc || x.t).deprecated, scada: (x.loc || x.t).scada };
  if (x.cur) Object.assign(body, { id: x.cur.id, version: x.cur.version });
  const saved = await T.api('POST', '/api/widgetType', body);
  if (!x.cur) say(`created ${saved.fqn} (add it to its bundle with migrate-target.mjs)`);
}
writeFileSync(LAST_RUN, JSON.stringify({ end: Date.now(), note: 'last push-widgets-target run; later server edits are protected' }));
say(`done: ${plan.length} widget type(s) written`);
