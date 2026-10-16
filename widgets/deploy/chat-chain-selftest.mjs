// Offline selftest of the chat relay chain builder and its server mode (nothing is sent anywhere):
//   node --test widgets/deploy/chat-chain-selftest.mjs        (or: node widgets/deploy/chat-chain-selftest.mjs)
// 1. DBB_CHAT_CHAIN (deploy-browser.js) builds exactly what DBB_DEPLOY posts, links point at nodes, no debug, the
//    "Recount" node only with a keeper chain, the config asset's real name in the error texts.
// 2. merge3 (chat-chain-merge.mjs): hand edits kept, our changes applied, conflicts stop, added / deleted nodes, links.
// 3. serverChatChain (chat-chain-server.mjs) against an in-memory fake server: dry run writes nothing, --go needs a base,
//    one metadata POST and nothing else, backup + record, the server's LLM config asset is found and never written,
//    every STOP; the LLM key is never printed.
// 4. If the server's own backup from the 8 Oct migration is on this PC, the first real run is simulated with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalise, merge3, nodeDiff, lineDiff, metadataFromFile, canon } from './chat-chain-merge.mjs';
import { serverChatChain, RC_NAME } from './chat-chain-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'deploy-browser.js'), 'utf8');
const KEEPER = '00000000-0000-4000-8000-00000000beef';
const NULL_CUSTOMER = '13814000-1dd2-11b2-8080-808080808080';
const KEY = 'sk-ant-api03-THISISNOTAREALKEYxxxxxxxxxxxxxxxxxxxx';

// deploy-browser.js in a sandbox of its own (window = the sandbox), with a fetch that answers DBB_DEPLOY's first calls
function load(fetchImpl) {
  const g = { console: { log() {} } };
  g.window = g; g.localStorage = { getItem: () => 'jwt' }; g.__dbbLib = 'lib'; g.__dbbGlue = {};
  new Function('window', 'localStorage', 'fetch', 'console', SRC)(g, g.localStorage, fetchImpl || (() => { throw new Error('no fetch'); }), g.console);
  return g;
}
const W = load();
const chain = (o, keeperId) => W.DBB_CHAT_CHAIN(Object.assign({}, W.DBB_DEPLOY_DEFAULTS, o), keeperId);
const clone = (x) => JSON.parse(JSON.stringify(x));

test('DBB_DEPLOY posts exactly DBB_CHAT_CHAIN', async () => {
  for (const withKeeper of [true, false]) {
    let posted = null;
    const g = load(async (url, init) => {
      const u = String(url), m = (init && init.method) || 'GET';
      const res = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
      if (u.startsWith('/api/tenant/customers')) return res({ id: { id: 'cust' } });
      if (u.startsWith('/api/ruleChains')) return res({ data: [{ name: RC_NAME, id: { id: 'rc' } }, ...(withKeeper ? [{ name: 'iMEX Licence keeper', id: { id: KEEPER } }] : [])], hasNext: false });
      if (u === '/api/ruleChain/rc/metadata') return res({ version: 3, nodes: [] });
      if (u === '/api/ruleChain/metadata' && m === 'POST') { posted = JSON.parse(init.body); throw new Error('CAPTURED'); }
      throw new Error(`unexpected ${m} ${u}`);
    });
    await assert.rejects(g.DBB_DEPLOY({ llmConfigName: 'DBBLLM-CONFIG' }), /CAPTURED/);
    const built = g.DBB_CHAT_CHAIN(Object.assign({}, g.DBB_DEPLOY_DEFAULTS, { llmConfigName: 'DBBLLM-CONFIG' }), withKeeper ? KEEPER : null);
    assert.deepEqual({ nodes: posted.nodes, connections: posted.connections }, built);
    assert.equal(posted.firstNodeIndex, 0);
  }
});

test('DBB_CHAT_CHAIN: links point at nodes, no debug, Recount only with the keeper, the asset name in the texts', () => {
  const a = chain({ llmConfigName: 'DBBLLM-CONFIG' }, KEEPER), b = chain({ llmConfigName: 'DBBLLM-CONFIG' }, null);
  assert.equal(a.nodes.length, b.nodes.length + 1);
  const rec = a.nodes.find((n) => n.name === 'Recount (licence keeper)');
  assert.equal(rec.configuration.ruleChainId, KEEPER);
  assert.ok(!b.nodes.some((n) => n.name === 'Recount (licence keeper)'));
  for (const md of [a, b]) {
    assert.equal(new Set(md.nodes.map((n) => n.name)).size, md.nodes.length, 'node names unique (the merge goes by name)');
    for (const c of md.connections) assert.ok(md.nodes[c.fromIndex] && md.nodes[c.toIndex], JSON.stringify(c));
    for (const n of md.nodes) assert.deepEqual(n.debugSettings, { failuresEnabled: false, allEnabled: false, allEnabledUntil: 0 });
  }
  assert.equal(a.nodes[0].name, 'Is chat request');
  const err = a.nodes.find((n) => n.name === 'Error reply').configuration.tbelScript;
  assert.ok(!err.includes('DBB-LLM-CONFIG'), 'no hard-coded asset name');
  assert.ok(err.includes("key on DBBLLM-CONFIG.\""));
  assert.ok(!JSON.stringify(a).includes('sk-ant-api'), 'no key in the chain');
});

// ---- fixtures: ours = today's chain; base = an older one (no D-066 nodes, another Error reply); server = base + edits
const D066 = ['Licence and AI usage', 'Licence and quota', 'Allowed?', 'Meter the call', 'To the licence keeper', 'Save the meter point', 'Recount (licence keeper)'];
const OURS = chain({ llmConfigName: 'DBBLLM-CONFIG' }, KEEPER);
function meta(nodes, links, extra = {}) {
  const idx = new Map(nodes.map((n, i) => [n.name, i]));
  return { firstNodeIndex: 0, nodes, connections: links.filter(([f, , t]) => idx.has(f) && idx.has(t)).map(([f, type, t]) => ({ fromIndex: idx.get(f), toIndex: idx.get(t), type })), ...extra };
}
const linksOf = (m) => m.connections.map((c) => [m.nodes[c.fromIndex].name, c.type, m.nodes[c.toIndex].name]);
function baseMeta() {
  const nodes = clone(OURS.nodes).filter((n) => !D066.includes(n.name));
  nodes.find((n) => n.name === 'Error reply').configuration.tbelScript = 'var err = "old";\nreturn {msg: msg, metadata: metadata, msgType: msgType};';
  const links = linksOf(OURS).filter(([f, , t]) => !D066.includes(f) && !D066.includes(t));
  links.push(['Is chat request', 'True', 'Read LLM settings']);
  return meta(nodes, links);
}
const setNode = (m, name, fn) => { const n = m.nodes.find((x) => x.name === name); fn(n); return m; };

test('merge: no edits on the server -> ours, links and all', () => {
  const r = merge3({ base: normalise(baseMeta()), server: normalise(baseMeta()), ours: normalise(OURS) });
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.changed, true);
  const got = normalise(r.metadata), want = normalise(OURS);
  assert.equal(canon([...got.cmp]), canon([...want.cmp]));
  assert.deepEqual([...got.links].sort(), [...want.links].sort());
  assert.equal(r.metadata.nodes[r.metadata.firstNodeIndex].name, 'Is chat request');
  assert.ok(r.links.removed.some(([f, t, to]) => f === 'Is chat request' && to === 'Read LLM settings'), 'the old direct link goes');
  assert.deepEqual(r.actions.filter((a) => a.action === 'add').map((a) => a.name).sort(), [...D066].sort());
  assert.deepEqual(r.actions.filter((a) => a.action === 'update').map((a) => a.name), ['Error reply']);
});

test('merge: a hand edit on a node we do not change is kept; ours applied elsewhere', () => {
  const server = setNode(baseMeta(), 'Call Claude', (n) => { n.configuration.readTimeoutMs = 45000; n.additionalInfo = { layoutX: 1, layoutY: 2 }; });
  const r = merge3({ base: normalise(baseMeta()), server: normalise(server), ours: normalise(OURS) });
  const cc = r.metadata.nodes.find((n) => n.name === 'Call Claude');
  assert.equal(cc.configuration.readTimeoutMs, 45000);
  assert.deepEqual(cc.additionalInfo, { layoutX: 1, layoutY: 2 }, 'their layout kept');
  assert.equal(r.actions.find((a) => a.name === 'Call Claude').action, 'kept (hand edit on the server)');
  assert.ok(r.metadata.nodes.some((n) => n.name === 'Licence and quota'));
  assert.ok(nodeDiff(normalise(baseMeta()).nodes.get('Call Claude'), cc).some((l) => /readTimeoutMs: 28000 -> 45000/.test(l)));
});

test('merge: both sides changed one node -> CONFLICT until resolved', () => {
  const server = setNode(baseMeta(), 'Error reply', (n) => { n.configuration.tbelScript = 'var err = "theirs";\nreturn {msg: msg, metadata: metadata, msgType: msgType};'; });
  const args = { base: normalise(baseMeta()), server: normalise(server), ours: normalise(OURS) };
  assert.deepEqual(merge3(args).conflicts, ['Error reply']);
  const takeOurs = merge3({ ...args, resolve: { 'Error reply': 'ours' } });
  assert.deepEqual(takeOurs.conflicts, []);
  assert.equal(takeOurs.metadata.nodes.find((n) => n.name === 'Error reply').configuration.tbelScript, OURS.nodes.find((n) => n.name === 'Error reply').configuration.tbelScript);
  assert.match(takeOurs.actions.find((a) => a.name === 'Error reply').action, /--take-ours/);
  const keep = merge3({ ...args, resolve: { 'Error reply': 'server' } });
  assert.match(keep.metadata.nodes.find((n) => n.name === 'Error reply').configuration.tbelScript, /theirs/);
});

test('merge: a node and a link the developers added stay; a node / link they deleted stays deleted', () => {
  const s = baseMeta();
  s.nodes.push({ type: 'org.thingsboard.rule.engine.action.TbLogNode', name: 'Dev log', configurationVersion: 0, configuration: { scriptLang: 'TBEL', tbelScript: 'return "x";' }, additionalInfo: {} });
  const links = linksOf(s).filter(([f, t, to]) => !(f === 'Call Gemini' || to === 'Call Gemini') && !(f === 'Pick provider' && t === 'none'));
  links.push(['Save reply attribute', 'Success', 'Dev log']);
  const server = meta(s.nodes.filter((n) => n.name !== 'Call Gemini'), links);
  const r = merge3({ base: normalise(baseMeta()), server: normalise(server), ours: normalise(OURS) });
  assert.deepEqual(r.conflicts, []);
  const names = r.metadata.nodes.map((n) => n.name);
  assert.ok(names.includes('Dev log')); assert.ok(!names.includes('Call Gemini'));
  const L = linksOf(r.metadata);
  assert.ok(L.some(([f, t, to]) => f === 'Save reply attribute' && to === 'Dev log'));
  assert.ok(!L.some(([f, t]) => f === 'Pick provider' && t === 'none'), 'their deleted link stays deleted');
  assert.equal(r.actions.find((a) => a.name === 'Dev log').action, 'kept (added on the server)');
  assert.equal(r.actions.find((a) => a.name === 'Call Gemini').action, 'kept deleted (deleted on the server)');
});

test('merge: debug switched off; no base = ours; already merged = no change', () => {
  const server = setNode(baseMeta(), 'Build LLM request', (n) => { n.debugSettings = { failuresEnabled: true, allEnabled: false, allEnabledUntil: 0 }; });
  const r = merge3({ base: normalise(baseMeta()), server: normalise(server), ours: normalise(OURS) });
  assert.deepEqual(r.debugOn, ['Build LLM request']);
  assert.ok(r.metadata.nodes.every((n) => !n.debugSettings.allEnabled && !n.debugSettings.failuresEnabled));
  const nb = merge3({ base: null, server: normalise(server), ours: normalise(OURS) });
  assert.equal(canon([...normalise(nb.metadata).cmp]), canon([...normalise(OURS).cmp]));
  const done = merge3({ base: normalise(OURS), server: normalise(OURS), ours: normalise(OURS) });
  assert.equal(done.changed, false);
});

test('printing: line diff, masking, the file formats', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc'), ['  a', '- b', '+ B', '  c']);
  const a = { type: 'x', configuration: { headers: { 'x-api-key': KEY } } }, b = { type: 'x', configuration: { headers: { 'x-api-key': '${llmKey}' } } };
  const d = nodeDiff(a, b).join('\n');
  assert.ok(!d.includes(KEY) && d.includes('<key masked>'));
  const m = baseMeta();
  for (const j of [m, { metadata: m }, { meta: m }, [{ ruleChain: { name: 'Other' }, metadata: {} }, { ruleChain: { name: RC_NAME }, metadata: m }]]) assert.equal(metadataFromFile(j, RC_NAME), m);
  assert.throws(() => metadataFromFile([{ ruleChain: { name: 'Other' }, metadata: m }], RC_NAME), /no rule chain/);
  assert.throws(() => normalise({ nodes: [{ name: 'a' }, { name: 'a' }], connections: [] }), /not unique/);
});

// ---- the server mode against an in-memory server
function fakeServer(meta0, opt = {}) {
  let meta = clone(meta0); meta.version = 7;
  meta.nodes.forEach((n, i) => { n.id = { id: 'n' + i }; n.ruleChainId = { id: 'rc' }; n.singletonMode = false; n.queueName = null; n.debugSettings = n.debugSettings || { failuresEnabled: false, allEnabled: false, allEnabledUntil: 0 }; });
  const writes = [];
  let reads = 0;
  const cfgs = opt.cfgs || [{ id: 'cfg1', name: 'DBBLLM-CONFIG', customer: NULL_CUSTOMER, from: ['store1'] }];
  const stores = opt.stores || [{ id: { id: 'store1' }, name: 'DashboardStore', assetProfileId: { id: 'ap' }, customerId: { id: 'ithena' } }];
  const assets = [...stores, ...cfgs.map((x) => ({ id: { id: x.id }, name: x.name, assetProfileId: { id: 'default' }, customerId: { id: x.customer } })), { id: { id: 'z' }, name: 'DBB-LLM-CONFIG', assetProfileId: { id: 'default' }, customerId: { id: NULL_CUSTOMER } }, { id: { id: 'sc' }, name: 'System Configuration', assetProfileId: { id: 'default' }, customerId: { id: 'ithena' } }];
  const chains = [{ name: RC_NAME, id: { id: 'rc' } }, ...(opt.noKeeper ? [] : [{ name: 'iMEX Licence keeper', id: { id: KEEPER } }])];
  const page = (data) => data;
  const api = async (method, path, body) => {
    if (method !== 'GET') {
      writes.push([method, path]);
      if (path === '/api/ruleChain/metadata' && method === 'POST') {
        if (body.version !== meta.version) throw new Error('version');
        meta = clone(body); meta.version += 1; delete meta.ruleChainId;
        meta.nodes.forEach((n, i) => { n.id = { id: 'm' + i }; n.ruleChainId = { id: 'rc' }; n.singletonMode = n.singletonMode || false; n.queueName = n.queueName || null; });
        return meta;
      }
      throw new Error(`fake server: unexpected ${method} ${path}`);
    }
    if (path === '/api/ruleChain/rc/metadata') { reads++; if (opt.editOnRead === reads) setNode(meta, 'Call OpenAI', (n) => { n.configuration.readTimeoutMs = 1; }); return clone(meta); }
    if (path === '/api/assetProfile/ap') return { id: { id: 'ap' }, name: 'DashboardStore', defaultRuleChainId: { id: 'rc' } };
    let m = /^\/api\/relations\?fromId=([^&]+)&fromType=ASSET&relationType=UsesLlmConfig$/.exec(path);
    if (m) return cfgs.filter((x) => x.from.includes(m[1])).map((x) => ({ from: { entityType: 'ASSET', id: m[1] }, to: { entityType: 'ASSET', id: x.id }, type: 'UsesLlmConfig' }));
    m = /^\/api\/asset\/(.+)$/.exec(path);
    if (m) return assets.find((a) => a.id.id === m[1]);
    m = /^\/api\/plugins\/telemetry\/ASSET\/(.+)\/values\/attributes\/SERVER_SCOPE$/.exec(path);
    if (m) return [{ key: 'dbb_llm_api_key', value: KEY }, { key: 'dbb_llm_model_anthropic', value: 'claude-sonnet-5' }];
    throw new Error(`fake server: unexpected GET ${path}`);
  };
  const all = async (path) => {
    if (path.startsWith('/api/ruleChains')) return page(chains.filter((c) => c.name.includes(decodeURIComponent(path.split('textSearch=')[1] || ''))));
    if (path.startsWith('/api/assetProfiles')) return [{ id: { id: 'ap' }, name: 'DashboardStore' }];
    if (path === '/api/tenant/assets') return assets;
    throw new Error(`fake server: unexpected list ${path}`);
  };
  return { c: { base: 'https://fake.example', api, all }, writes, meta: () => meta };
}
async function run(srv, o) {
  const out = [];
  const dir = mkdtempSync(join(tmpdir(), 'chat-chain-'));
  const code = await serverChatChain(srv.c, { record: join(dir, 'record.json'), backupDir: join(dir, 'backups'), now: Date.UTC(2026, 9, 17), ...o }, chain, (l) => out.push(l));
  const text = out.join('\n');
  assert.ok(!text.includes(KEY), 'the key is never printed');
  return { code, text, dir };
}
const writeBase = (dir, m) => { const f = join(dir, 'base.json'); return import('node:fs').then((fs) => { fs.writeFileSync(f, JSON.stringify({ ruleChain: { name: RC_NAME }, metadata: m })); return f; }); };

test('server mode: dry run reads only and shows the plan; --go without a base is refused', async () => {
  const srv = fakeServer(baseMeta());
  const dry = await run(srv, {});
  assert.equal(dry.code, 0); assert.deepEqual(srv.writes, []);
  assert.match(dry.text, /LLM config asset: "DBBLLM-CONFIG" \(tenant-owned, linked from DashboardStore\), key set/);
  assert.match(dry.text, /"DBB-LLM-CONFIG" exist\(s\) but no store uses it: left alone/);
  assert.match(dry.text, /base: NONE/);
  assert.match(dry.text, /Give --base=<file> first/);
  const go = await run(srv, { go: true });
  assert.equal(go.code, 1); assert.deepEqual(srv.writes, []); assert.match(go.text, /STOP: no base/);
});

test('server mode: --go with a base = one metadata POST, hand edit kept, backup + record, then no change', async () => {
  const server = setNode(baseMeta(), 'Call Claude', (n) => { n.configuration.readTimeoutMs = 45000; });
  const srv = fakeServer(server);
  const dir = mkdtempSync(join(tmpdir(), 'chat-chain-base-'));
  const base = await writeBase(dir, baseMeta());
  const dry = await run(srv, { base });
  assert.equal(dry.code, 0); assert.deepEqual(srv.writes, []);
  assert.match(dry.text, /server vs base: 1 node\(s\) edited on the server since \(Call Claude\)/);
  assert.match(dry.text, /readTimeoutMs: 28000 -> 45000/);
  assert.match(dry.text, /add +Licence and quota/);
  const go = await run(srv, { base, go: true });
  assert.equal(go.code, 0, go.text);
  assert.deepEqual(srv.writes, [['POST', '/api/ruleChain/metadata']], 'nothing but the chain is written');
  const after = srv.meta();
  assert.equal(after.nodes.find((n) => n.name === 'Call Claude').configuration.readTimeoutMs, 45000);
  assert.ok(after.nodes.some((n) => n.name === 'Recount (licence keeper)' && n.configuration.ruleChainId === KEEPER));
  assert.ok(after.nodes.find((n) => n.name === 'Error reply').configuration.tbelScript.includes('key on DBBLLM-CONFIG.'));
  const rec = JSON.parse(readFileSync(join(go.dir, 'record.json'), 'utf8'));
  assert.equal(rec.ruleChainId, 'rc');
  assert.ok(existsSync(join(go.dir, 'backups', '2026-10-17', `server-chat-chain-${Date.UTC(2026, 9, 17)}.json`)));
  // the next run takes the record as its base: nothing to do, and the hand edit is still not a conflict
  const again = await serverChatChain(srv.c, { record: join(go.dir, 'record.json'), backupDir: join(go.dir, 'backups') }, chain, () => {});
  assert.equal(again, 0); assert.equal(srv.writes.length, 1);
});

test('server mode: conflicts, edits during the run and wrong setups stop with nothing written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-chain-stop-'));
  const base = await writeBase(dir, baseMeta());
  const conflict = fakeServer(setNode(baseMeta(), 'Error reply', (n) => { n.configuration.tbelScript = 'var err = "theirs";'; }));
  const c1 = await run(conflict, { base, go: true });
  assert.equal(c1.code, 1); assert.match(c1.text, /CONFLICT: Error reply/); assert.deepEqual(conflict.writes, []);
  const c2 = await run(conflict, { base, go: true, takeOurs: 'Error reply' });
  assert.equal(c2.code, 0); assert.equal(conflict.writes.length, 1);
  const during = fakeServer(baseMeta(), { editOnRead: 2 });
  const d = await run(during, { base, go: true });
  assert.equal(d.code, 1); assert.match(d.text, /changed on the server during this run/); assert.deepEqual(during.writes, []);
  for (const [opt, re] of [
    [{ noKeeper: true }, /no rule chain "iMEX Licence keeper"/],
    [{ cfgs: [] }, /no LLM config asset is linked/],
    [{ cfgs: [{ id: 'c1', name: 'A', customer: NULL_CUSTOMER, from: ['store1'] }, { id: 'c2', name: 'B', customer: NULL_CUSTOMER, from: ['store1'] }] }, /2 LLM config assets are linked/],
    [{ cfgs: [{ id: 'c1', name: 'DBBLLM-CONFIG', customer: 'some-customer', from: ['store1'] }] }, /assigned to a customer/],
    [{ stores: [{ id: { id: 'store1' }, name: 'DashboardStore', assetProfileId: { id: 'ap' }, customerId: { id: 'other' } }] }, /do not belong to the app customer/],
  ]) {
    const s = fakeServer(baseMeta(), opt);
    const r = await run(s, { base, go: true });
    assert.equal(r.code, 1, String(re)); assert.match(r.text, re); assert.deepEqual(s.writes, []);
  }
});

// ---- the first real run, simulated with the server's own copy from the 8 Oct migration (if this PC has it)
const SNAP = join(here, '..', '..', 'backups', '2026-10-08', 'new-tenant-before-migration', 'rule-chains.json');
test('first server run with the 8 Oct server backup as base and as the server: ours, no conflict', { skip: !existsSync(SNAP) && 'no 8 Oct backup on this PC' }, () => {
  const m = metadataFromFile(JSON.parse(readFileSync(SNAP, 'utf8')), RC_NAME);
  const r = merge3({ base: normalise(m), server: normalise(m), ours: normalise(OURS) });
  assert.deepEqual(r.conflicts, []);
  assert.equal(canon([...normalise(r.metadata).cmp]), canon([...normalise(OURS).cmp]));
  const untouched = r.actions.filter((a) => a.action === 'same').map((a) => a.name);
  // nodes D-066 did not change compare equal although the server copy is the STORED form: TB keeps configurations as sent
  for (const n of ['Is chat request', 'Read LLM settings', 'Call Claude', 'Save reply attribute']) assert.ok(untouched.includes(n), n + ' same');
});
