// Writes the chat relay's TBEL scripts from deploy-browser.js as paste-ready files (D-028), with the default models
// and config asset name. Use them to update an existing relay rule chain by hand:
//   node widgets/deploy/relay/export-scripts.mjs
//   Rule chains > "DBB Chat relay (POC)" > node "Build LLM request" > paste build-llm-request.tbel (TBEL) > Apply;
//   node "Error reply" > paste error-reply.tbel > Apply; Save the rule chain.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'deploy-browser.js'), 'utf8');
const o = { llmModel: 'claude-sonnet-5', openaiModel: 'chat-latest', geminiModel: 'gemini-flash-latest', llmConfigName: 'DBB-LLM-CONFIG' };
const grab = (name) => {
  const i = src.indexOf(`const ${name} = [`);
  const j = src.indexOf('].join', i);
  // the array literal only uses string and template literals that reference `o`
  return new Function('o', `return ${src.slice(i + `const ${name} = `.length, j + 1)};`)(o).join('\n');
};
// D-066: the licence and quota gate too
for (const [name, file] of [['buildScript', 'build-llm-request.tbel'], ['parseScript', 'parse-llm-reply.tbel'], ['errScript', 'error-reply.tbel'], ['gateScript', 'licence-quota-gate.tbel']]) {
  writeFileSync(join(here, file), grab(name) + '\n');
  console.log('wrote', file);
}
