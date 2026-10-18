// deploy-node.mjs --target=server: ONLY the rule chain "DBB Chat relay (POC)" on the server tenant (D-066 licence /
// quota gate + llm_builder meter). Everything else DBB_DEPLOY does (profile, store, LLM config asset, relation, widget
// types, bundle, dashboards) is NOT done here: the widgets reach the server through scripts/mirror/push-widgets-target.mjs.
//
// What it reads (GET only until --go):
//   - the chain (must exist: never created here), the keeper chain "iMEX Licence keeper" (App UI relay.mjs --install,
//     must exist: the meter's "Recount" node links to it)
//   - the LLM config asset THE SERVER USES: the asset its DashboardStore store(s) point to with the relation
//     UsesLlmConfig (exactly one, tenant-owned). Never created, never written; its name only goes into the error texts.
//   - the base: what we last left on the server (mirror-data/target-chat-chain.json, written after every --go here), or
//     --base=<file> (first run: the server's own backup from the migration)
// Then the 3-way merge (chat-chain-merge.mjs): the developers' hand edits since the base are kept; both sides changed
// = CONFLICT, nothing written until resolved with --take-ours=<node,...> / --keep-server=<node,...>.
// --go: backup of the server chain (backups/<day>/server-chat-chain-<ts>.json), the chain re-read and compared just
// before the save (an edit during the run = STOP), one POST /api/ruleChain/metadata, re-read, record written.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalise, merge3, metadataFromFile, nodeDiff, mask, canon } from './chat-chain-merge.mjs';

export const RC_NAME = 'DBB Chat relay (POC)';
export const KEEPER_CHAIN = 'iMEX Licence keeper';
// D-074: the chat checks the writer's role in the role guard's registry, and passes other store changes to the guard
export const GUARD_CHAIN = 'iMEX Role guard';
export const REGISTRY = 'iMEX Role Registry';
export const RECORD = 'mirror-data/target-chat-chain.json';
const NULL_CUSTOMER = '13814000-1dd2-11b2-8080-808080808080';
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * c = { api(method, path, body, { allow404 }), all(path), base }; o = { go, base, takeOurs, keepServer, record, backupDir,
 * now }; chain(o, keeperChainId, more) = window.DBB_CHAT_CHAIN with DBB_DEPLOY_DEFAULTS (and the chat contract) merged in.
 * Returns an exit code.
 */
export async function serverChatChain(c, o, chain, say = console.log) {
  const now = o.now || Date.now();
  const record = o.record || RECORD;
  // ---- what is there
  const rcs = await c.all(`/api/ruleChains?textSearch=${encodeURIComponent('DBB Chat relay')}`);
  const rc = rcs.find((x) => x.name === RC_NAME);
  if (!rc) { say(`STOP: no rule chain "${RC_NAME}" on the server (this mode only updates the existing chain)`); return 1; }
  const keeper = (await c.all(`/api/ruleChains?textSearch=${encodeURIComponent(KEEPER_CHAIN)}`)).find((x) => x.name === KEEPER_CHAIN);
  if (!keeper) { say(`STOP: no rule chain "${KEEPER_CHAIN}": install the relay first (App UI relay.mjs --install), then run this`); return 1; }
  const guard = (await c.all(`/api/ruleChains?textSearch=${encodeURIComponent(GUARD_CHAIN)}`)).find((x) => x.name === GUARD_CHAIN);

  // the LLM config asset the server's chain reads: store --UsesLlmConfig--> config
  const ap = (await c.all('/api/assetProfiles?textSearch=DashboardStore')).find((x) => x.name === 'DashboardStore');
  if (!ap) { say('STOP: no asset profile "DashboardStore" on the server'); return 1; }
  const prof = await c.api('GET', `/api/assetProfile/${ap.id.id}`);
  const assets = await c.all('/api/tenant/assets');
  // D-074: without the registry every chat turn would answer "your role could not be checked"
  if (!assets.some((a) => a.name === REGISTRY)) { say(`STOP: no asset "${REGISTRY}": install the role guard first (App UI role-guard.mjs --install), then run this`); return 1; }
  const stores = assets.filter((a) => a.assetProfileId && a.assetProfileId.id === ap.id.id);
  const cfgIds = new Map();
  for (const s of stores) {
    const rels = (await c.api('GET', `/api/relations?fromId=${s.id.id}&fromType=ASSET&relationType=UsesLlmConfig`)) || [];
    for (const r of rels) if (r.to && r.to.entityType === 'ASSET') cfgIds.set(r.to.id, [...(cfgIds.get(r.to.id) || []), s.name]);
  }
  if (cfgIds.size !== 1) {
    say(`STOP: ${cfgIds.size ? cfgIds.size + ' LLM config assets are' : 'no LLM config asset is'} linked from the stores (${stores.map((s) => s.name).join(', ') || 'none'}) with UsesLlmConfig; this mode never creates or picks one`);
    for (const [id, by] of cfgIds) say(`  ${id} <- ${by.join(', ')}`);
    return 1;
  }
  const [cfgId, cfgStores] = [...cfgIds][0];
  const cfg = await c.api('GET', `/api/asset/${cfgId}`);
  if (cfg.customerId && cfg.customerId.id !== NULL_CUSTOMER) { say(`STOP: the LLM config asset "${cfg.name}" is assigned to a customer: unassign it first (its key would be readable)`); return 1; }
  const cfgAttrs = {};
  for (const a of (await c.api('GET', `/api/plugins/telemetry/ASSET/${cfgId}/values/attributes/SERVER_SCOPE`)) || []) cfgAttrs[a.key] = a.value;
  const models = ['anthropic', 'openai', 'gemini'].map((p) => `${p} ${cfgAttrs['dbb_llm_model_' + p] ? JSON.stringify(String(cfgAttrs['dbb_llm_model_' + p])) : '(default)'}`).join(', ');
  const others = assets.filter((a) => /^DBB-?LLM-CONFIG$/i.test(a.name) && a.id.id !== cfgId).map((a) => a.name);
  // the gate reads the licence from the STORE's customer: it must be the app customer (the owner of System Configuration)
  const sc = assets.find((a) => a.name === 'System Configuration');
  const appCust = sc && sc.customerId && sc.customerId.id !== NULL_CUSTOMER ? sc.customerId.id : null;
  const notApp = stores.filter((s) => cfgStores.includes(s.name) && (!s.customerId || s.customerId.id !== appCust)).map((s) => s.name);
  if (!appCust || notApp.length) { say(`STOP: ${!appCust ? 'no app customer ("System Configuration" has no customer)' : 'store(s) ' + notApp.join(', ') + ' do not belong to the app customer'}: the licence gate would refuse every chat request`); return 1; }
  // D-070: the chain reads the app's AI switches (imexLlm) through store --UsesAppConfig--> "System Configuration". The one
  // thing this mode adds besides the chain: that relation, for the stores that lack it (written with --go only)
  const needRel = [];
  for (const s of stores.filter((x) => cfgStores.includes(x.name))) {
    const rels = (await c.api('GET', `/api/relations?fromId=${s.id.id}&fromType=ASSET&relationType=UsesAppConfig`)) || [];
    if (!rels.some((r) => r.to && r.to.id === sc.id.id)) needRel.push(s);
  }

  say(`chain "${RC_NAME}" ${rc.id.id}; keeper chain ${keeper.id.id}; role guard ${guard ? guard.id.id + ' (other store changes go there)' : 'NOT INSTALLED (store changes are not checked)'}`);
  say(`LLM config asset: "${cfg.name}" (tenant-owned, linked from ${cfgStores.join(', ')}), key ${cfgAttrs.dbb_llm_api_key ? 'set' : 'EMPTY'}, models ${models} — read only, kept as it is`);
  if (others.length) say(`  note: ${others.map((n) => '"' + n + '"').join(', ')} exist(s) but no store uses it: left alone`);
  say(needRel.length ? `AI switches: relation UsesAppConfig to "System Configuration" missing from ${needRel.map((s) => s.name).join(', ')}: added with --go (without it the chat answers "could not read the AI switches")` : 'AI switches: the store(s) are linked to "System Configuration" (UsesAppConfig)');
  say(`DashboardStore profile -> ${prof.defaultRuleChainId && prof.defaultRuleChainId.id === rc.id.id ? 'this chain' : 'ANOTHER chain (' + (prof.defaultRuleChainId ? prof.defaultRuleChainId.id : 'none') + '): not changed here; chat requests do not reach this chain'}`);

  // ---- the three versions
  const curMeta = await c.api('GET', `/api/ruleChain/${rc.id.id}/metadata`);
  const server = normalise(curMeta);
  const ours = normalise(chain({ llmConfigName: cfg.name }, keeper.id.id, { guardChainId: guard ? guard.id.id : null }));
  let base = null, baseFrom = null;
  const baseFile = o.base || (existsSync(record) ? record : null);
  if (baseFile) {
    base = normalise(metadataFromFile(JSON.parse(readFileSync(baseFile, 'utf8')), RC_NAME));
    baseFrom = baseFile;
  }
  say(`base: ${baseFrom ? baseFrom : 'NONE (no ' + record + ', no --base): every server difference is shown, nothing can be written'}`);
  const resolve = {};
  for (const n of list(o.takeOurs)) resolve[n] = 'ours';
  for (const n of list(o.keepServer)) resolve[n] = 'server';
  const m = merge3({ base, server, ours, resolve });

  // ---- the report
  if (base) {
    const hand = [...new Set([...base.order, ...server.order])].filter((n) => base.cmp.get(n) !== server.cmp.get(n));
    const linkEd = [...server.links].filter((l) => !base.links.has(l)).length + [...base.links].filter((l) => !server.links.has(l)).length;
    say(`server vs base: ${hand.length ? hand.length + ' node(s) edited on the server since (' + hand.join(', ') + ')' : 'no node edited on the server since'}${linkEd ? ', ' + linkEd + ' link(s) changed' : ''}`);
    for (const n of hand) { say(`  ~ ${n} (server edit):`); for (const l of nodeDiff(base.nodes.get(n), server.nodes.get(n))) say('  ' + l); }
  }
  for (const a of m.actions) {
    if (a.action === 'same') continue;
    say(`${a.action.padEnd(32)} ${a.name}`);
    if (a.from === 'ours' || a.from === 'conflict') for (const l of nodeDiff(server.nodes.get(a.name), ours.nodes.get(a.name))) say('  ' + l);
  }
  const same = m.actions.filter((a) => a.action === 'same').length;
  if (same) say(`same                             ${same} node(s)`);
  for (const [f, t, to] of m.links.added) say(`+ link ${f} -${t}-> ${to}`);
  for (const [f, t, to] of m.links.removed) say(`- link ${f} -${t}-> ${to}`);
  if (m.debugOn.length) say(`debug is on for ${m.debugOn.join(', ')} on the server: switched off (D-066)`);

  if (m.conflicts.length) {
    say(`CONFLICT: ${m.conflicts.join(', ')} changed on the server AND by us. Look at both diffs above, then re-run with --take-ours=<node,...> (ours replaces their edit: fold it into deploy-browser.js first if it must stay) or --keep-server=<node,...>. Nothing written.`);
    return 1;
  }
  const addRels = async () => {
    for (const s of needRel) {
      const rel = { from: s.id, to: sc.id, type: 'UsesAppConfig', typeGroup: 'COMMON' };
      await c.api('POST', '/api/v2/relation', rel).catch(() => c.api('POST', '/api/relation', rel));
      say(`relation added: ${s.name} --UsesAppConfig--> System Configuration`);
    }
  };
  if (!m.changed) {
    say('No change: the server chain already is the merged chain.');
    if (needRel.length) { if (o.go) await addRels(); else say('Dry run: only the UsesAppConfig relation would be added. Re-run with --go.'); }
    return 0;
  }
  if (!o.go) { say(`Dry run: the chain would be saved with ${m.metadata.nodes.length} nodes / ${m.metadata.connections.length} links. ${base ? 'Re-run with --go.' : 'Give --base=<file> first (see the runbook).'}`); return 0; }
  if (!base) { say('STOP: no base: without it the developers\' edits cannot be told from an older deploy. Give --base=<file>. Nothing written.'); return 1; }

  // ---- write
  const day = new Date(now).toISOString().slice(0, 10);
  const bkDir = `${o.backupDir || 'backups'}/${day}`;
  mkdirSync(bkDir, { recursive: true });
  const bk = `${bkDir}/server-chat-chain-${now}.json`;
  const bkText = JSON.stringify({ ruleChain: rc, metadata: curMeta });
  writeFileSync(bk, mask(bkText));
  say(`backed up the server chain to ${bk}${mask(bkText) !== bkText ? ' (a key-like value in it was masked: look at the chain)' : ''}`);
  const again = await c.api('GET', `/api/ruleChain/${rc.id.id}/metadata`);
  const n2 = normalise(again);
  if (canon([...n2.cmp]) !== canon([...server.cmp]) || canon([...n2.links].sort()) !== canon([...server.links].sort())) { say('STOP: the chain changed on the server during this run: run again. Nothing written.'); return 1; }
  // D-074 (services audit S2): the relation first; a relation without the new chain is harmless, the new chain without
  // it would answer every turn "could not read the AI switches"
  await addRels();
  await c.api('POST', '/api/ruleChain/metadata', { ruleChainId: rc.id, version: again.version, firstNodeIndex: m.metadata.firstNodeIndex, nodes: m.metadata.nodes, connections: m.metadata.connections, ruleChainConnections: null });
  const after = await c.api('GET', `/api/ruleChain/${rc.id.id}/metadata`);
  const na = normalise(after), want = normalise(m.metadata);
  const off = [...want.order].filter((n) => na.cmp.get(n) !== want.cmp.get(n));
  say(`saved: ${after.nodes.length} nodes / ${(after.connections || []).length} links${off.length ? '; the server stored these differently from what was sent (TB defaults): ' + off.join(', ') : ''}`);
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, mask(JSON.stringify({ note: 'the chat relay chain as deploy-node.mjs --target=server last left it on the server: the base of the next run', at: new Date(now).toISOString(), target: c.base, ruleChainId: rc.id.id, metadata: after }, null, 1)));
  say(`record: ${record} (the base of the next run)`);
  return 0;
}
