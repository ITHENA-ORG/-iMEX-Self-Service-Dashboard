// D-065 migration: "All <type> machines you manage" assignments saved before D-065 as a FIXED list (a device-level
// `dbb_assign` on every machine of the type the user saw) become location assignments on the locations that user holds
// in full, so machines added there later get the machine page too. Machines granted one by one keep their device-level
// assignment (nothing more can follow for them).
//
// How a fixed list is recognised: two or more device assignments with the same dashboard, mode 'linked', the same
// `by` and the same `at` (one Apply writes them all with one timestamp), all of one machine type. The assigner is the
// user whose display name is `by` (first + last name, else e-mail; exactly one match, else the group is left alone);
// their 'all' grants (`imexAccess`) are the managed locations. A location is migrated only when every machine of the
// type under it that existed at the time of the Apply is in the group (otherwise it was not "all you manage" there),
// and only when it has no other dashboard assigned for that type. Then: `dbb_assign[type]` on the location, the
// group's device assignments under it removed (only where they still are the group's), `dbb_assign_rev` bumped on the
// store so open pages reload. Everything is printed first; a backup of every value it changes goes to
// backups/<date>/ before a write.
//   node scripts/migrate-managed-assign.mjs            dry run on LOCAL (reads only)
//   node scripts/migrate-managed-assign.mjs --go       writes on LOCAL
//   node scripts/migrate-managed-assign.mjs --server [--go]   the NEW tenant (TGT_TB_*), only on Akshay's go-ahead
import { mkdirSync, writeFileSync } from 'node:fs';
import { targetClient, newTenantClient } from './mirror/clients.mjs';

const go = process.argv.includes('--go');
const server = process.argv.includes('--server');
const c = server ? await newTenantClient() : await targetClient();
console.log(`${c.label} (${c.base})${go ? '' : ': DRY RUN (add --go to write)'}`);

const attrsOf = async (type, id, keys) => {
  const rows = (await c.api('GET', `/api/plugins/telemetry/${type}/${id}/values/attributes/SERVER_SCOPE?keys=${keys.join(',')}`)) || [];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
};
const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const parentsOf = async (type, id) => ((await c.api('GET', `/api/relations?toId=${id}&toType=${type}&relationType=Contains&relationTypeGroup=COMMON`)) || []).filter((r) => r.from.entityType === 'ASSET').map((r) => r.from.id);
const childrenOf = async (id) => ((await c.api('GET', `/api/relations?fromId=${id}&fromType=ASSET&relationType=Contains&relationTypeGroup=COMMON`)) || []).map((r) => r.to);

const devices = await c.all('/api/tenant/devices');
const byId = new Map(devices.map((d) => [d.id.id, d]));
// every device assignment
const assigned = [];
for (const d of devices) {
  const a = parse((await attrsOf('DEVICE', d.id.id, ['dbb_assign'])).dbb_assign);
  if (a && a.dashboardId && a.mode === 'linked') assigned.push({ d, a });
}
const groups = new Map();
for (const x of assigned) {
  const k = `${x.a.dashboardId}|${x.a.by}|${x.a.at}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(x);
}
const users = await c.all('/api/users');
const nameOf = async (u) => {
  const at = await attrsOf('USER', u.id.id, ['firstName', 'lastName']).catch(() => ({}));
  return [at.firstName ?? u.firstName, at.lastName ?? u.lastName].filter(Boolean).join(' ') || u.email;
};
const names = new Map();
for (const u of users) { const n = await nameOf(u); if (!names.has(n)) names.set(n, []); names.get(n).push(u); }

// the machines of a type under a location (Contains, down), with their creation time
async function devicesUnder(rootId, type) {
  const out = [], seen = new Set([rootId]), queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    for (const t of await childrenOf(id)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (t.entityType === 'ASSET') queue.push(t.id);
      else if (t.entityType === 'DEVICE' && byId.get(t.id)?.type === type) out.push(byId.get(t.id));
    }
  }
  return out;
}
// the locations above a device, nearest first
async function ancestors(id) {
  const out = [];
  let cur = { type: 'DEVICE', id };
  for (let i = 0; i < 12; i++) {
    const p = (await parentsOf(cur.type, cur.id))[0];
    if (!p || out.includes(p)) break;
    out.push(p);
    cur = { type: 'ASSET', id: p };
  }
  return out;
}

const plan = []; // { root, type, assign, remove: [deviceId] }
let candidates = 0;
for (const list of groups.values()) {
  if (list.length < 2) continue;
  candidates++;
  const { a } = list[0];
  const types = new Set(list.map((x) => x.d.type));
  const label = `"${a.dashboardId}" by ${a.by} at ${new Date(a.at).toISOString()} (${list.length} machines)`;
  if (types.size !== 1) { console.log(`SKIP ${label}: more than one machine type`); continue; }
  const type = [...types][0];
  const who = names.get(a.by) || [];
  if (who.length !== 1) { console.log(`SKIP ${label}: ${who.length ? 'several users are' : 'no user is'} called "${a.by}"`); continue; }
  const acc = parse((await attrsOf('USER', who[0].id.id, ['imexAccess'])).imexAccess);
  const roots = ((acc && acc.grants) || []).filter((g) => g.type === 'ASSET' && g.mode === 'all').map((g) => g.id);
  if (!roots.length) { console.log(`SKIP ${label}: ${a.by} holds no location in full (machines granted one by one: nothing to follow)`); continue; }
  const inGroup = new Set(list.map((x) => x.d.id.id));
  for (const root of roots) {
    const under = await devicesUnder(root, type);
    const then = under.filter((d) => d.createdTime <= a.at);
    const missing = then.filter((d) => !inGroup.has(d.id.id));
    const covered = list.filter((x) => under.some((d) => d.id.id === x.d.id.id));
    if (!covered.length) continue;
    if (missing.length) { console.log(`SKIP ${label} at location ${root}: ${missing.length} ${type} machine(s) there were not in the list (${missing.map((d) => d.name).join(', ')})`); continue; }
    const cur = parse((await attrsOf('ASSET', root, ['dbb_assign'])).dbb_assign) || {};
    if (cur[type]?.dashboardId && cur[type].dashboardId !== a.dashboardId) { console.log(`SKIP ${label} at location ${root}: it already shows dashboard ${cur[type].dashboardId} for ${type}`); continue; }
    const later = under.filter((d) => d.createdTime > a.at && !inGroup.has(d.id.id));
    plan.push({ root, type, before: cur, assign: { dashboardId: a.dashboardId, by: a.by, at: a.at }, remove: covered.map((x) => x.d.id.id), label, later: later.map((d) => d.name) });
  }
}

console.log(`${assigned.length} device assignments, ${candidates} fixed list(s) of 2 or more machines, ${plan.length} location(s) to migrate`);
for (const p of plan) console.log(`  MIGRATE ${p.label}: location ${p.root} gets ${p.type} -> ${p.assign.dashboardId}; ${p.remove.length} device assignment(s) removed${p.later.length ? `; added later and now covered: ${p.later.join(', ')}` : ''}`);
if (!go || !plan.length) process.exit(0);

// backup of every value this changes
const day = new Date().toISOString().slice(0, 10);
mkdirSync(`backups/${day}`, { recursive: true });
const backup = { kind: 'managed-assign', at: Date.now(), base: c.base, locations: plan.map((p) => ({ id: p.root, dbb_assign: p.before })), devices: [] };
for (const p of plan) for (const id of p.remove) backup.devices.push({ id, dbb_assign: assigned.find((x) => x.d.id.id === id)?.a });
const file = `backups/${day}/managed-assign-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(backup, null, 1));
console.log(`backup: ${file}`);

for (const p of plan) {
  const cur = parse((await attrsOf('ASSET', p.root, ['dbb_assign'])).dbb_assign) || {};
  await c.api('POST', `/api/plugins/telemetry/ASSET/${p.root}/attributes/SERVER_SCOPE`, { dbb_assign: { ...cur, [p.type]: p.assign } });
  for (const id of p.remove) {
    const now = parse((await attrsOf('DEVICE', id, ['dbb_assign'])).dbb_assign);
    if (!now || now.dashboardId !== p.assign.dashboardId || now.at !== p.assign.at) continue; // changed meanwhile: kept
    await c.api('DELETE', `/api/plugins/telemetry/DEVICE/${id}/SERVER_SCOPE?keys=dbb_assign`);
  }
  console.log(`  migrated ${p.root} (${p.type})`);
}
// the stores: every open page reloads its assignment snapshot
const stores = (await c.all('/api/tenant/assets?type=DashboardStore'));
for (const s of stores) await c.api('POST', `/api/plugins/telemetry/ASSET/${s.id.id}/attributes/SERVER_SCOPE`, { dbb_assign_rev: `v${Date.now().toString(36)}` });
console.log(`done; dbb_assign_rev bumped on ${stores.length} store(s)`);
