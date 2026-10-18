// Runs DBB_DEPLOY (deploy-browser.js) from Node instead of a browser console, with the tenant admin from .env.
//   npm run build:widgets
//   node widgets/deploy/deploy-node.mjs          shows the options it would use, deploys nothing
//   node widgets/deploy/deploy-node.mjs --go     deploys
// Options: deploy.local.json (git-ignored), same fields as DBB_DEPLOY's opts. When it has no `profileKeys`, the
// catalogue already stored on the store asset (dbb_profile_keys) is passed back unchanged, because DBB_DEPLOY
// overwrites it and its own default `{}` would wipe it. `userEmails` defaults to [] (home dashboards untouched).
// The JWT is held in memory only (tb-node.mjs); the script prints DBB_DEPLOY's log, never the token.
//
// Server mode: ONLY the chat relay chain (D-066 gate + meter) on the server tenant, nothing else (the Builder widgets
// go through scripts/mirror/push-widgets-target.mjs; the store, profile, LLM config asset and relation stay as they are):
//   node widgets/deploy/deploy-node.mjs --target=server --go-ahead="iMEX - AI Features" [--base=<file>]
//        [--take-ours=<node,...>] [--keep-server=<node,...>] [--go]
// Dry run by default. TGT_TB_* from .env (a tenant admin of exactly that tenant; never the SRC_TB_* tenant). Updates the
// existing "DBB Chat relay (POC)" in place with the LLM config asset the server's store already uses, keeps the
// developers' hand edits (3-way merge against what we last deployed: mirror-data/target-chat-chain.json, or --base for
// the first run) and prints the diff. chat-chain-server.mjs / chat-chain-merge.mjs; selftest: chat-chain-selftest.mjs.
import { readFileSync, existsSync } from 'node:fs';
import { tbLogin, serverAttrs } from './tb-node.mjs';

const argOf = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : undefined; };
const SERVER_TENANT = 'iMEX - AI Features';
if (process.argv.some((a) => a.startsWith('--target'))) {
  if (argOf('target') !== 'server') { console.error('REFUSED: --target takes only "server" (LOCAL is the default without --target)'); process.exit(2); }
  const goAhead = argOf('go-ahead');
  if (goAhead !== SERVER_TENANT) { console.error(`REFUSED: the server needs Akshay's go-ahead: --go-ahead="${SERVER_TENANT}"`); process.exit(2); }
  const { newTenantClient } = await import('../../scripts/mirror/clients.mjs');
  const c = await newTenantClient();
  const t = await c.api('GET', `/api/tenant/${c.tenantId}`);
  if (!t || t.title !== goAhead) { console.error(`REFUSED: TGT_TB_* log in to tenant "${t && t.title}", not "${goAhead}"`); process.exit(2); }
  globalThis.window = globalThis;
  await import('./deploy-browser.js');
  const chain = (o, keeperChainId) => window.DBB_CHAT_CHAIN(Object.assign({}, window.DBB_DEPLOY_DEFAULTS, o), keeperChainId);
  const go = process.argv.includes('--go');
  console.log(`target ${c.base}, tenant "${t.title}" — chat relay chain only — ${go ? 'WRITING' : 'DRY RUN (--go writes)'}`);
  const { serverChatChain } = await import('./chat-chain-server.mjs');
  process.exit(await serverChatChain(c, { go, base: argOf('base'), takeOurs: argOf('take-ours'), keepServer: argOf('keep-server') }, chain));
}

const opts = Object.assign(
  { customerTitle: 'ITHENA', storeName: 'DBB-STORE-ITHENA', userEmails: [] },
  existsSync('deploy.local.json') ? JSON.parse(readFileSync('deploy.local.json', 'utf8')) : {},
);
const { base, token, api, all } = await tbLogin();

// LOCAL, chain only (D-070): node widgets/deploy/deploy-node.mjs --chain-only [--go]. Rewrites "DBB Chat relay (POC)"
// from deploy-browser.js and links the store to the app's configuration asset (UsesAppConfig, the AI switches); the
// widget types, bundle, store attributes and dashboards are NOT touched (a chain change while the widgets' build may be
// someone else's work in progress).
if (process.argv.includes('--chain-only')) {
  globalThis.window = globalThis;
  await import('./deploy-browser.js');
  const o = Object.assign({}, window.DBB_DEPLOY_DEFAULTS, opts);
  const rc = (await all(`/api/ruleChains?textSearch=${encodeURIComponent('DBB Chat relay')}`)).find((x) => x.name === 'DBB Chat relay (POC)');
  if (!rc) { console.error('no rule chain "DBB Chat relay (POC)": run the full deploy (--go) first'); process.exit(1); }
  const keeper = (await all(`/api/ruleChains?textSearch=${encodeURIComponent('iMEX Licence keeper')}`)).find((x) => x.name === 'iMEX Licence keeper');
  const { nodes, connections } = window.DBB_CHAT_CHAIN(o, keeper ? keeper.id.id : null);
  const store = await api('GET', `/api/tenant/assets?assetName=${encodeURIComponent(o.storeName)}`, undefined, true);
  const appCfg = await api('GET', `/api/tenant/assets?assetName=${encodeURIComponent(o.appConfigName)}`, undefined, true);
  console.log(`chain "${rc.name}": ${nodes.length} nodes / ${connections.length} links (key from ${o.llmConfigName}, AI switches from ${o.appConfigName}); store ${store ? store.name : 'MISSING'}`);
  if (!process.argv.includes('--go')) { console.log('Dry run. Re-run with --chain-only --go.'); process.exit(0); }
  const cur = await api('GET', `/api/ruleChain/${rc.id.id}/metadata`);
  await api('POST', '/api/ruleChain/metadata', { ruleChainId: rc.id, version: cur.version, firstNodeIndex: 0, nodes, connections, ruleChainConnections: null });
  console.log('rule chain written');
  if (store && appCfg) {
    const rel = { from: store.id, to: appCfg.id, type: 'UsesAppConfig', typeGroup: 'COMMON' };
    await api('POST', '/api/v2/relation', rel).catch(() => api('POST', '/api/relation', rel));
    console.log(`store ${store.name} --UsesAppConfig--> ${appCfg.name}`);
  } else console.log(`NOTE: ${store ? 'no asset "' + o.appConfigName + '"' : 'no store'}: the chat answers "could not read the AI switches"`);
  process.exit(0);
}

if (!opts.profileKeys) {
  const store = await api('GET', `/api/tenant/assets?assetName=${encodeURIComponent(opts.storeName)}`, undefined, true);
  const pk = store ? (await serverAttrs(api, 'ASSET', store.id.id)).dbb_profile_keys : null;
  opts.profileKeys = pk ? (typeof pk === 'string' ? JSON.parse(pk) : pk) : {};
}
const glue = JSON.parse(readFileSync('widgets/dist/glue.json', 'utf8'));
console.log(`target ${base}, build ${glue.version}`);
console.log(`customer ${opts.customerTitle}, store ${opts.storeName}, home dashboards for ${opts.userEmails.length} users`);
console.log(`profileKeys: ${Object.entries(opts.profileKeys).map(([p, ks]) => `${p} (${ks.length})`).join(', ') || 'EMPTY (the store catalogue will be cleared)'}`);
if (!process.argv.includes('--go')) {
  console.log('Dry run. Re-run with --go to deploy.');
  process.exit(0);
}

// deploy-browser.js expects a browser page: window, localStorage.jwt_token and relative /api paths.
globalThis.window = globalThis;
// defineProperty: newer Node versions have their own localStorage global
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k) => (k === 'jwt_token' ? token() : null) }, configurable: true });
const nodeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => nodeFetch(typeof url === 'string' && url.startsWith('/') ? base + url : url, init);
window.__dbbLib = readFileSync('widgets/dist/imex-dbb.js', 'utf8');
window.__dbbGlue = glue;
await import('./deploy-browser.js');
const res = await window.DBB_DEPLOY(opts);
console.log(JSON.stringify({ dashboardId: res.dashboardId, storeId: res.storeId, ruleChainId: res.ruleChainId, bundleId: res.bundleId }, null, 2));
