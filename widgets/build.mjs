// Bundles all widget entry points into one IIFE (global IMEX_DBB) and writes per-widget controller glue.
//
// Run from the repo root (`npm run build:widgets`; paths are relative to the cwd). Node, not the browser.
//
// Outputs (all in widgets/dist/):
//   imex-dbb.js              the minified library (entry: widgets/src/entries/all.ts), version stamped in
//   glue.json                {launcher, renderer, listing}: the ThingsBoard controller-script glue per widget
//                            type. Used with imex-dbb.js by widgets/deploy/deploy-browser.js
//                            (window.__dbbLib / window.__dbbGlue).
//   imex-dbb.js.gz.b64       gzip (level 9) + base64 of the library: a compact transport copy (e.g. to
//                            move it into a browser page); nothing in the repo reads it; git-ignored
//   widget-types/imex_dbb_<k>.json  importable ThingsBoard widget types (Widgets library > Widgets > + >
//                            Import widget): library + glue + settings form from widget-types.mjs (D-020)
//
// Versioning: each build gets an ISO timestamp. It replaces the `__VERSION__` placeholder
// (IMEX_DBB.version) and goes into the widget-type description ("... [poc=true] built <version>").
// The [poc=true] marker lets teardown find the widget types (D-005).
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { settingsSchemas, names, sizes } from './widget-types.mjs';

mkdirSync('widgets/dist', { recursive: true });
const version = new Date().toISOString();
await build({
  entryPoints: ['widgets/src/entries/all.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'IMEX_DBB',
  target: 'es2019',
  minify: true,
  legalComments: 'none',
  define: {},
  outfile: 'widgets/dist/imex-dbb.js',
});
// Stamp the build version into the bundle (all.ts exports `version = '__VERSION__'`).
let lib = readFileSync('widgets/dist/imex-dbb.js', 'utf8').replaceAll('__VERSION__', version);
writeFileSync('widgets/dist/imex-dbb.js', lib);

// Controller glue per widget type. The library is embedded in each widget type's controllerScript
// (ThingsBoard evaluates it per widget instance; the IIFE is cheap to re-evaluate).
// Lifecycle mapping: onInit -> <k>.init(self.ctx), onStateChanged -> <k>.onStateChanged(self.ctx),
// onDestroy -> <k>.destroy(self.ctx). onDataUpdated/onResize are no-ops: the widgets use no ThingsBoard
// datasources (typeParameters: datasourcesOptional, maxDatasources 0) and fetch over REST themselves.
const glue = (name, extra = '') => `
self.onInit = function () { IMEX_DBB.${name}.init(self.ctx); };
self.onDataUpdated = function () {};
self.onResize = function () {};
${extra}self.onDestroy = function () { if (IMEX_DBB.${name}.destroy) IMEX_DBB.${name}.destroy(self.ctx); };
self.typeParameters = function () { return { dataKeysOptional: true, datasourcesOptional: true, maxDatasources: 0, hasDataPageLink: false, previewWidth: '420px', previewHeight: '320px' }; };
`;
const out = {
  launcher: glue('launcher', 'self.onStateChanged = function () { IMEX_DBB.launcher.onStateChanged(self.ctx); };\n'),
  renderer: glue('renderer', 'self.onStateChanged = function () { IMEX_DBB.renderer.onStateChanged(self.ctx); };\n'),
  listing: glue('listing', 'self.onStateChanged = function () { IMEX_DBB.listing.onStateChanged(self.ctx); };\n'),
};
// Build id for DBB_DEPLOY: goes into the widget-type description and the store attribute dbb_lib_version (D-022).
out.version = version;
// D-074: the chat assistant's system prompt template and tool (widgets/src/core/chat-prompt.ts) for the rule chain
// "DBB Chat relay (POC)": DBB_DEPLOY / deploy-node.mjs put them into the chain, so the browser no longer sends them.
await build({ entryPoints: ['widgets/src/core/chat-prompt.ts'], bundle: true, format: 'esm', platform: 'node', target: 'node18', outfile: 'widgets/dist/chat-prompt.mjs', logLevel: 'warning' });
const { chatContract } = await import(new URL('./dist/chat-prompt.mjs?' + Date.now(), import.meta.url).href);
out.chat = chatContract();
writeFileSync('widgets/dist/chat-contract.json', JSON.stringify(out.chat, null, 2));
writeFileSync('widgets/dist/glue.json', JSON.stringify(out, null, 2));
const gz = gzipSync(Buffer.from(lib, 'utf8'), { level: 9 });
writeFileSync('widgets/dist/imex-dbb.js.gz.b64', gz.toString('base64'));
console.log(`lib ${(lib.length / 1024).toFixed(1)} KB, gzip+b64 ${(gz.toString('base64').length / 1024).toFixed(1)} KB, version ${version}`);

// One importable widget type per widget (ThingsBoard: Widgets library > Widgets > + > Import widget).
mkdirSync('widgets/dist/widget-types', { recursive: true });
for (const k of ['launcher', 'renderer', 'listing']) {
  // Same descriptor shape as deploy-browser.js writes via POST /api/widgetType; keep the two in sync.
  const type = {
    fqn: `imex_dbb_${k}`,
    name: names[k],
    deprecated: false,
    scada: false,
    description: `iMEX Self-Service POC widget [poc=true] built ${version}`,
    descriptor: {
      type: 'static',
      sizeX: sizes[k][0],
      sizeY: sizes[k][1],
      resources: [],
      templateHtml: '',
      templateCss: '',
      controllerScript: lib + '\n' + out[k],
      settingsSchema: JSON.stringify(settingsSchemas[k]),
      dataKeySettingsSchema: '{}',
      defaultConfig: JSON.stringify({ datasources: [], showTitle: false, backgroundColor: 'rgba(0,0,0,0)', color: 'rgba(0,0,0,0.87)', padding: '0px', settings: {}, title: names[k], dropShadow: false, enableFullscreen: false }),
    },
  };
  writeFileSync(`widgets/dist/widget-types/imex_dbb_${k}.json`, JSON.stringify(type, null, 2));
}
console.log('widget types: ' + ['launcher', 'renderer', 'listing'].map((k) => `widgets/dist/widget-types/imex_dbb_${k}.json`).join(', '));
