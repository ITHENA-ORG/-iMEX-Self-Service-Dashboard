// D-066: the chat relay's licence and quota gate (deploy-browser.js gateScript) against ThingsBoard's own script engine
// (POST /api/ruleChain/testScript: nothing is stored). LOCAL only. Reads TB_URL / TB_TENANT_* from the repo's .env.
//   node widgets/deploy/relay/gate-selftest.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'deploy-browser.js'), 'utf8');
const i = src.indexOf('const gateScript = [');
const gate = new Function(`return ${src.slice(i + 'const gateScript = '.length, src.indexOf('].join', i) + 1)};`)().join('\n');
const base = (process.env.TB_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('LOCAL only');
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.TB_TENANT_USERNAME, password: process.env.TB_TENANT_PASSWORD }) });
const token = (await login.json()).token;
const run = async (metadata) => {
  const r = await fetch(`${base}/api/ruleChain/testScript?scriptLang=TBEL`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authorization': 'Bearer ' + token }, body: JSON.stringify({ script: gate, scriptType: 'update', argNames: ['msg', 'metadata', 'msgType'], msg: JSON.stringify({ dbb_chat_req: { reqId: 'r1', userId: 'u1', body: {} } }), metadata, msgType: 'ATTRIBUTES_UPDATED' }) });
  const j = await r.json();
  return j.error ? { error: j.error } : JSON.parse(j.output);
};
const month = new Date().toISOString().slice(0, 7);
const parsed = { instanceId: 'I', expiresAt: '2099-01-01T00:00:00Z', features: { builder: true, 'builder.ai': true, genAi: true }, limits: { llmCallsPerMonth: 10 } };
const B = JSON.stringify({ instanceId: 'I', mode: 'enforce' });
const inGrace = new Date(Date.now() - 3 * 86400e3).toISOString().replace(/\.\d+Z$/, 'Z');
const cases = [
  ['licensed, under quota', { lStatus: JSON.stringify({ parsed }), lBind: B, lUsage: JSON.stringify({ month, total: 9 }) }, (o) => !o.metadata.error],
  ['over quota', { lStatus: JSON.stringify({ parsed }), lBind: B, lUsage: JSON.stringify({ month, total: 10 }) }, (o) => o.metadata.error === 'QUOTA' && o.metadata.qUsed === '10' && o.metadata.qLimit === '10'],
  ["last month's count does not count", { lStatus: JSON.stringify({ parsed }), lBind: B, lUsage: JSON.stringify({ month: '2001-01', total: 99 }) }, (o) => !o.metadata.error],
  ['no builder.ai', { lStatus: JSON.stringify({ parsed: { ...parsed, features: { builder: true, genAi: true } } }), lBind: B }, (o) => o.metadata.error === 'NOT_LICENSED'],
  ['no genAi', { lStatus: JSON.stringify({ parsed: { ...parsed, features: { builder: true, 'builder.ai': true } } }), lBind: B }, (o) => o.metadata.error === 'NOT_LICENSED'],
  ['suspended', { lStatus: JSON.stringify({ parsed: { ...parsed, status: 'suspended' } }), lBind: B }, (o) => o.metadata.error === 'NOT_LICENSED'],
  ['expired, within grace', { lStatus: JSON.stringify({ parsed: { ...parsed, expiresAt: inGrace } }), lBind: B }, (o) => !o.metadata.error],
  ['expired past grace', { lStatus: JSON.stringify({ parsed: { ...parsed, expiresAt: '2020-01-01T00:00:00Z' } }), lBind: B }, (o) => o.metadata.error === 'NOT_LICENSED'],
  ['another instance', { lStatus: JSON.stringify({ parsed }), lBind: JSON.stringify({ instanceId: 'X' }) }, (o) => o.metadata.error === 'NOT_LICENSED'],
  ['no licence, enforce by default', {}, (o) => o.metadata.error === 'NOT_LICENSED'],
  ['development binding', { lBind: JSON.stringify({ instanceId: 'I', mode: 'dev-open' }) }, (o) => !o.metadata.error],
];
let fail = 0;
for (const [name, md, test] of cases) {
  const o = await run(md);
  const ok = !o.error && test(o);
  if (!ok) { fail++; console.log('FAIL', name, JSON.stringify(o).slice(0, 300)); }
}
console.log(`gate selftest: ${cases.length - fail} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
