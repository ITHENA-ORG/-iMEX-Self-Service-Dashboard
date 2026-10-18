// Writes the chat relay's TBEL scripts from deploy-browser.js as paste-ready files (D-028), with the default models
// and config asset name. Use them to update an existing relay rule chain by hand:
//   npm run build:widgets   (D-074: the prompt and the tool come from widgets/dist/chat-contract.json)
//   node widgets/deploy/relay/export-scripts.mjs
//   Rule chains > "DBB Chat relay (POC)" > node "Build LLM request" > paste build-llm-request.tbel (TBEL) > Apply;
//   node "Error reply" > paste error-reply.tbel > Apply; Save the rule chain.
// D-074: the chain also has new nodes (role check, chat count, reply on the user): pasting scripts alone is not enough
// any more; deploy the chain with deploy-node.mjs (LOCAL) or deploy-node.mjs --target=server (the server).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'deploy-browser.js'), 'utf8');
const chatContract = JSON.parse(readFileSync(join(here, '..', '..', 'dist', 'chat-contract.json'), 'utf8'));
const g = { console: { log() {} } };
g.window = g;
new Function('window', 'console', src)(g, g.console);
const o = Object.assign({}, g.DBB_DEPLOY_DEFAULTS, { llmModel: 'claude-sonnet-5', openaiModel: 'chat-latest', geminiModel: 'gemini-flash-latest', llmConfigName: 'DBB-LLM-CONFIG', chatContract });
const { nodes } = g.DBB_CHAT_CHAIN(o, null);
const script = (name) => nodes.find((n) => n.name === name).configuration.tbelScript;
// D-066: the licence and quota gate too; D-074: the role check and chat limit
for (const [name, file] of [['Build LLM request', 'build-llm-request.tbel'], ['Parse LLM reply', 'parse-llm-reply.tbel'], ['Error reply', 'error-reply.tbel'], ['Licence and quota', 'licence-quota-gate.tbel'], ['Role and chat limit', 'role-and-limit.tbel']]) {
  writeFileSync(join(here, file), script(name) + '\n');
  console.log('wrote', file);
}
