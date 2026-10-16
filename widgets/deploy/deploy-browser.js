// Deploys the Dashboard Builder POC into ThingsBoard. Run in a logged-in TENANT ADMIN page's console
// after window.__dbbLib (library code) and window.__dbbGlue (per-widget glue) are set.
// Idempotent: finds everything by name / fqn and updates it in place. Only touches POC-marked items.
// Usage: await DBB_DEPLOY({ customerTitle: 'ITHENA', storeName: 'DBB-STORE-ITHENA', userEmails: [...] })
//
// Where it runs: pasted into the browser console of a ThingsBoard page logged in as TENANT ADMIN. It calls
// the REST API with that page's JWT (localStorage.jwt_token); no credentials are typed or stored (D-001, D-016).
//
// Inputs:
//   window.__dbbLib   contents of widgets/dist/imex-dbb.js   (from `npm run build:widgets`)
//   window.__dbbGlue  parsed widgets/dist/glue.json          ({launcher, renderer, listing} glue strings)
//   window.IMEX_DBB_VERSION  optional, only used in the widget-type description
//   opts (all optional; defaults below):
//     customerTitle  existing ThingsBoard customer to deploy for (must exist; not created here)
//     storeName      name of that customer's DashboardStore asset (one per customer, D-012/D-013)
//     appTitle       title of the stand-in app dashboard;  appName  text in its navbar
//     bundleTitle    widget bundle title
//     llmModel       default Claude model (used when dbb_llm_model_anthropic is not set on the config asset)
//     openaiModel    default OpenAI model;  geminiModel  default Gemini model (same rule)
//     llmConfigName  tenant-owned asset holding the LLM API key (default DBB-LLM-CONFIG; D-021)
//     profileKeys    {profile: [{key, displayName, unit, decimals, min, max}]} catalogue, written to the
//                    store as `dbb_profile_keys` (OVERWRITES the stored catalogue on every run)
//     userEmails     customer users whose home dashboard becomes the stand-in app (empty in production)
//     skipAppDashboard  true: skip steps 5 and 6, for a tenant whose own app dashboard already contains the
//                    navbar and renderer widgets (D-035); its configuration is then never touched
//
// Steps (each is create-or-update, so the whole call is idempotent and safe to re-run per customer):
//   1. Customer: looked up by title (throws if missing).
//   2. Rule chain "DBB Chat relay (POC)" (D-014, D-021): created if missing, then its metadata is rewritten:
//      Is chat request -> Licence and AI usage (the store's customer: imexLicenceStatus, imexLicenceBinding,
//      imexAiUsage; D-066) -> Licence and quota (builder + builder.ai + genAi, mode active / grace, this month's count
//      below llmCallsPerMonth; else the error reply) -> Read LLM settings (config asset attributes via relation UsesLlmConfig) ->
//      Build LLM request (provider picked from the key format) -> Pick provider -> Call Claude | Call OpenAI |
//      Call Gemini -> Parse LLM reply / Error reply -> Save reply attribute (`dbb_chat_resp_<userId>`); a parsed reply
//      is also metered (D-066): one llm_builder point on the tenant-only asset "iMEX Keeper", then the licence keeper
//      chain recounts the month (when it exists: App UI scripts/relay.mjs).
//      A key pasted into the pre-D-021 "Call LLM" node is moved to the config asset (step 3b).
//   3. Asset profile "DashboardStore" (must carry the POC marker if it exists) with the chat relay as its
//      default rule chain; store asset `storeName` created if missing, assigned to the customer, and
//      SERVER_SCOPE attributes `poc=true` + `dbb_profile_keys` written.
//   3b. Tenant-owned asset `llmConfigName` (never assigned to a customer; the script refuses to continue if it
//      is): attributes dbb_llm_api_key (empty until a tenant admin sets it), dbb_llm_model_{anthropic,openai,gemini}
//      (defaults, written only when missing); relation store --UsesLlmConfig--> config asset.
//   4. Widget bundle `bundleTitle` and the widget types tenant.imex_dbb_{launcher,renderer,listing}
//      (controller script = library + glue; settings forms duplicated from widgets/widget-types.mjs),
//      then the bundle's widget type list is set to those three.
//   5. Stand-in dashboard `appTitle` with states default (Map page), listing and machine (D-018), each
//      navbar + one body widget; overwritten in place if it exists, then assigned to the customer.
//   6. Home/default dashboard (fullscreen, toolbar hidden) of the customer users listed in userEmails.
//
// POC marker: new rule chain, profile, bundle, widget types and dashboard carry "[poc=true]" in their
// description (D-005) and the store asset gets the `poc=true` attribute, so teardown (scripts/lib/teardown.ts)
// can find them. Only the DashboardStore profile is checked for the marker before reuse; the rule chain,
// bundle, widget types and dashboard are matched by name/fqn and updated without that check.
//
// Returns {log, dashboardId, storeId, ruleChainId, bundleId}. Throws on the first failing REST call.
window.DBB_DEPLOY = async function (opts) {
  const o = Object.assign(
    {
      customerTitle: 'ITHENA',
      storeName: 'DBB-STORE-ITHENA',
      appTitle: 'iMEX App (POC)',
      appName: 'iMEX · ITHENA',
      bundleTitle: 'iMEX Self-Service (POC)',
      llmModel: 'claude-sonnet-5',
      openaiModel: 'chat-latest',
      geminiModel: 'gemini-flash-latest',
      llmConfigName: 'DBB-LLM-CONFIG',
      profileKeys: {},
      userEmails: [],
    },
    opts || {},
  );
  const MARK = '[poc=true]'; // same marker as scripts/lib/model.ts POC_MARKER
  const log = [];
  const say = (m) => (log.push(m), console.log('[DBB deploy] ' + m));
  const h = () => ({ 'X-Authorization': 'Bearer ' + localStorage.getItem('jwt_token'), 'Content-Type': 'application/json' });
  // Minimal REST helper: JSON in/out; returns null for 404 when allow404, throws on other non-2xx.
  const api = async (method, path, body, allow404) => {
    const r = await fetch(path, { method, headers: h(), body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    if (r.status === 404 && allow404) return null;
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${t.slice(0, 300)}`);
    return t ? JSON.parse(t) : null;
  };
  // Reads every page of a ThingsBoard PageData endpoint.
  const all = async (path) => {
    const out = [];
    for (let p = 0; ; p++) {
      const r = await api('GET', `${path}${path.includes('?') ? '&' : '?'}pageSize=100&page=${p}`);
      out.push(...r.data);
      if (!r.hasNext) return out;
    }
  };
  if (!window.__dbbLib || !window.__dbbGlue) throw new Error('library not loaded');

  // --- customer
  const customer = await api('GET', `/api/tenant/customers?customerTitle=${encodeURIComponent(o.customerTitle)}`);
  const cid = customer.id.id;

  // --- rule chain for chat relay (multi-provider, D-021)
  // The API key is NOT stored in the rule chain or in any widget. It lives on a tenant-owned asset
  // (`llmConfigName`, default DBB-LLM-CONFIG) that is never assigned to a customer, so customer users
  // cannot read it (a customer-assigned asset's attributes are readable by every user of that customer).
  // The chain reads it server-side through the relation store --UsesLlmConfig--> config asset.
  const rcName = 'DBB Chat relay (POC)';
  let rc = (await all(`/api/ruleChains?textSearch=${encodeURIComponent(rcName)}`)).find((x) => x.name === rcName);
  if (!rc) rc = await api('POST', '/api/ruleChain', { name: rcName, type: 'CORE', debugMode: false, configuration: { description: `${MARK} Relays Dashboard Builder chat requests to the LLM (Claude, OpenAI or Gemini, picked from the key on ${o.llmConfigName}).` } });
  const existingMeta = await api('GET', `/api/ruleChain/${rc.id.id}/metadata`);
  // A key pasted into the old single-provider "Call LLM" node (before D-021) is migrated to the config asset below.
  const oldRest = (existingMeta.nodes || []).find((n) => n.name === 'Call LLM');
  const oldKey = oldRest && oldRest.configuration && oldRest.configuration.headers && oldRest.configuration.headers['x-api-key'];
  const legacyKey = oldKey && !/PASTE_/.test(oldKey) && !oldKey.includes('${') ? oldKey : null;
  // TBEL scripts. The builder writes `dbb_chat_req` = {reqId, userId, body} on the store asset, where body =
  // {system, messages, tools, tool_choice (Anthropic format), openai: {tools, tool_choice}, gemini: {tools, toolConfig}}
  // (core/chat.ts buildRequest). Replies go to `dbb_chat_resp_<userId>` =
  // {reqId, ok, provider, toolInput | toolInputJson | error, usage}.
  const filterScript = "return msgType == 'ATTRIBUTES_UPDATED' && msg.dbb_chat_req != null && msg.dbb_chat_req.body != null;";
  // Key -> provider: sk-ant-... = Anthropic, AIza... or AQ.... (newer AI Studio keys) = Google Gemini, any other sk-... = OpenAI.
  // Model per provider: config asset attribute dbb_llm_model_<provider>, else the default below.
  const buildScript = [
    'var req = msg.dbb_chat_req;',
    'var b = req.body;',
    'var i = 0;',
    // D-028: the reply goes to the user ThingsBoard says wrote the request (REST attribute updates carry
    // metadata.userId), never to an id taken from the request body.
    'var uid = metadata.userId;',
    'if (uid == null || uid == "") { uid = "" + req.userId; }',
    'var md = {reqId: "" + req.reqId, userId: "" + uid};',
    'if (req.userId != null && ("" + req.userId) != ("" + uid)) { md.error = "USER_MISMATCH"; }',
    // D-028: size caps and only the builder's own tool, so the relay can't be used as a general LLM proxy
    'if (md.error == null) {',
    '  if (b.system == null || b.messages == null || ("" + b.system).length() > 60000 || b.messages.size() > 24) { md.error = "TOO_BIG"; }',
    '  else { for (i = 0; i < b.messages.size(); i++) { if (("" + b.messages[i].content).length() > 60000) { md.error = "TOO_BIG"; } } }',
    '}',
    'if (md.error == null && (b.tools == null || b.tools.size() != 1 || b.tools[0].name != "dashboard_ops")) { md.error = "BAD_TOOL"; }',
    'var key = metadata.llmKey;',
    'if (key == null) { key = ""; }',
    'key = key.trim();',
    'var provider = "none";',
    'if (key.startsWith("sk-ant-")) { provider = "anthropic"; } else if (key.startsWith("AIza") || key.startsWith("AQ.")) { provider = "gemini"; } else if (key.startsWith("sk-")) { provider = "openai"; }',
    // a builder page loaded before D-021 sends no openai/gemini tool block: answer with a clear error instead of failing inside TBEL
    'if ((provider == "openai" && b.openai == null) || (provider == "gemini" && b.gemini == null)) { provider = "none"; md.error = "OLD_CLIENT"; }',
    'if (md.error != null) { provider = "none"; }',
    'md.provider = provider;',
    'md.llmKey = key;',
    'var model = "";',
    'var body = {};',
    'if (provider == "anthropic") {',
    '  model = metadata.llmModelAnthropic;',
    `  if (model == null || model == "") { model = "${o.llmModel}"; }`,
    '  body = {model: model, max_tokens: 2048, system: b.system, messages: b.messages, tools: [b.tools[0]], tool_choice: {type: "tool", name: "dashboard_ops"}};',
    '} else if (provider == "openai") {',
    '  model = metadata.llmModelOpenai;',
    `  if (model == null || model == "") { model = "${o.openaiModel}"; }`,
    '  var msgs = [{role: "system", content: b.system}];',
    '  for (i = 0; i < b.messages.size(); i++) { msgs.add(b.messages[i]); }',
    '  var oTool = b.openai.tools[0];',
    '  oTool["function"]["name"] = "dashboard_ops";',
    // `function` is a TBEL keyword: set it by index, not in a map literal
    '  var oChoice = {type: "function"};',
    '  oChoice["function"] = {name: "dashboard_ops"};',
    '  body = {model: model, max_completion_tokens: 2048, messages: msgs, tools: [oTool], tool_choice: oChoice};',
    '} else if (provider == "gemini") {',
    '  model = metadata.llmModelGemini;',
    `  if (model == null || model == "") { model = "${o.geminiModel}"; }`,
    '  var contents = [];',
    '  for (i = 0; i < b.messages.size(); i++) {',
    '    var m = b.messages[i];',
    '    var role = "user";',
    '    if (m.role == "assistant") { role = "model"; }',
    '    contents.add({role: role, parts: [{text: m.content}]});',
    '  }',
    '  var gDecl = b.gemini.tools[0].functionDeclarations[0];',
    '  gDecl.name = "dashboard_ops";',
    '  body = {systemInstruction: {parts: [{text: b.system}]}, contents: contents, tools: [{functionDeclarations: [gDecl]}], toolConfig: {functionCallingConfig: {mode: "ANY", allowedFunctionNames: ["dashboard_ops"]}}, generationConfig: {maxOutputTokens: 2048}};',
    '} else {',
    `  if (md.error == null) { md.error = "NO_KEY"; }`,
    '}',
    'md.llmModel = model;',
    'return {msg: body, metadata: md, msgType: msgType};',
  ].join('\n');
  const switchScript = 'return [metadata.provider];';
  // D-066: the licence (one place: the app customer's imexLicenceStatus.parsed as the keeper read it, the binding) and the
  // month's AI count (imexAiUsage, the keeper's COUNT of llm_* on "iMEX Keeper"), at server time. The browser's own check
  // is only a note: this is the gate. Unlicensed / over quota -> metadata.error (NOT_LICENSED / QUOTA) -> Error reply.
  const gateScript = [
    'function asObj(v) { if (v is String) { if (v == "") { return null; } return JSON.parse(v); } return v; }',
    'function isMap(v) { return v != null && v is java.util.Map; }',
    // MVEL types "var x = 0" as an int (a Long put in it later is cut): times come from a function
    'function ms(v) { if (v is String && v.length() >= 20) { return new Date(v).getTime(); } return new Date(0).getTime(); }',
    'var st = asObj(metadata.lStatus);',
    'var bind = asObj(metadata.lBind);',
    'var use = asObj(metadata.lUsage);',
    'var now = new Date().getTime();',
    'var mode = "none";',
    'if (isMap(bind) && bind.mode == "dev-open") { mode = "open"; }',
    'else if (isMap(st) && isMap(st.parsed) && isMap(bind) && bind.instanceId is String && st.parsed.instanceId == bind.instanceId) {',
    '  var p = st.parsed;',
    '  var exp = ms(p.expiresAt);',
    '  var grace = 14.0;',
    '  if (p.graceDays is Number) { grace = p.graceDays * 1.0; }',
    '  if (p.status is String && p.status.toLowerCase() == "suspended") { mode = "suspended"; }',
    '  else if (exp > 0 && now <= exp) { mode = "active"; }',
    '  else if (exp > 0 && now <= exp + grace * 86400000.0) { mode = "grace"; }',
    '  else { mode = "expired"; }',
    '}',
    'var ok = mode == "open";',
    'var limit = 0;',
    'if (mode == "active" || mode == "grace") {',
    '  var f = st.parsed.features;',
    '  ok = isMap(f) && f.builder == true && f["builder.ai"] == true && f.genAi == true;',
    '  var l = st.parsed.limits;',
    '  if (isMap(l) && l.llmCallsPerMonth is Number && l.llmCallsPerMonth > 0) { limit = l.llmCallsPerMonth; }',
    '}',
    'if (!ok) { metadata.error = "NOT_LICENSED"; }',
    'else if (limit > 0) {',
    '  var used = 0;',
    '  if (isMap(use) && use.month == new Date().toISOString().substring(0, 7) && use.total is Number) { used = use.total; }',
    '  if (used >= limit) { metadata.error = "QUOTA"; metadata.qUsed = "" + used; metadata.qLimit = "" + limit; }',
    '}',
    'metadata.remove("lStatus");',
    'metadata.remove("lBind");',
    'metadata.remove("lUsage");',
    'return {msg: msg, metadata: metadata, msgType: msgType};',
  ].join('\n');
  const gateRoute = 'if (metadata.error != null && metadata.error != "") { return ["no"]; } return ["ok"];';
  // D-066: one point per provider call that answered, server time, on the tenant-only keeper asset (customers can
  // neither read nor delete it); kKind 'recount' makes the keeper chain recount the month (imexAiUsage)
  const meterScript = 'var m = {}; m.llm_builder = 1; var md = {}; md.kKind = "recount"; return {msg: m, metadata: md, msgType: "POST_TELEMETRY_REQUEST"};';
  // NB: TBEL does not allow ternaries inside map literals (the ':' is parsed as a key separator);
  // `function` is a keyword, hence tc[0]["function"].
  const parseScript = [
    'var p = metadata.provider;',
    'var tool = null;',
    'var toolJson = "";',
    'var usage = null;',
    'var i = 0;',
    'if (p == "openai") {',
    '  if (msg.choices != null && msg.choices.size() > 0 && msg.choices[0].message != null) {',
    '    var tc = msg.choices[0].message.tool_calls;',
    '    if (tc != null && tc.size() > 0) { toolJson = "" + tc[0]["function"]["arguments"]; }',
    '  }',
    '  usage = msg.usage;',
    '} else if (p == "gemini") {',
    '  if (msg.candidates != null && msg.candidates.size() > 0 && msg.candidates[0].content != null) {',
    '    var parts = msg.candidates[0].content.parts;',
    '    if (parts != null) { for (i = 0; i < parts.size(); i++) { if (parts[i].functionCall != null) { tool = parts[i].functionCall.args; } } }',
    '  }',
    '  usage = msg.usageMetadata;',
    '} else {',
    '  if (msg.content != null) { for (i = 0; i < msg.content.size(); i++) { var c = msg.content[i]; if (c.type == "tool_use") { tool = c.input; } } }',
    '  usage = msg.usage;',
    '}',
    'var ok = tool != null || toolJson != "";',
    'var errText = "";',
    'if (!ok) { errText = "The model returned no dashboard operations."; }',
    'var resp = {reqId: metadata.reqId, ok: ok, provider: p, toolInput: tool, toolInputJson: toolJson, usage: usage, error: errText};',
    'var out = {};',
    'out["dbb_chat_resp_" + metadata.userId] = resp;',
    'var md = {reqId: "" + metadata.reqId, userId: "" + metadata.userId};',
    'return {msg: out, metadata: md, msgType: "POST_ATTRIBUTES_REQUEST"};',
  ].join('\n');
  // Also reached when the config asset is not linked (related-data node failure) or no key is set.
  // Never echoes the key: only the provider's error text, capped at 300 characters.
  const errScript = [
    'var err = "LLM call failed";',
    'if (metadata.error != null) { err = "" + metadata.error; }',
    // the REST node puts the provider's response body in error_body (Gemini reports a bad key as a plain 400)
    'var body = "";',
    'if (metadata.error_body != null) { body = "" + metadata.error_body; }',
    'err = err + " " + body;',
    'var p = metadata.provider;',
    'if (p == null) { p = ""; }',
    `if (err.startsWith("NO_KEY")) { err = "No LLM API key is set. A tenant admin sets dbb_llm_api_key (Claude, OpenAI or Gemini key) on the asset ${o.llmConfigName}."; }`,
    'else if (err.startsWith("USER_MISMATCH")) { err = "The chat request did not come from your user. Reload the page and try again."; }',
    'else if (err.startsWith("TOO_BIG")) { err = "The chat request is too large. Start a new conversation or ask for fewer changes at once."; }',
    'else if (err.startsWith("BAD_TOOL")) { err = "The chat request was not made by the Dashboard Builder."; }',
    'else if (err.startsWith("NOT_LICENSED")) { err = "The chat assistant is not included in this installation\'s licence. Ask your administrator."; }',
    'else if (err.startsWith("QUOTA")) { err = "Monthly AI limit reached (" + metadata.qUsed + " of " + metadata.qLimit + ") — contact your administrator"; }',
    'else if (err.startsWith("OLD_CLIENT")) { err = "This page is running an older version of the Dashboard Builder. Reload the page (Ctrl+F5) and try again."; }',
    `else if (p == "") { err = "The chat relay could not read the LLM settings or build the request. Check that asset ${o.llmConfigName} exists and is linked to this store (relation UsesLlmConfig)."; }`,
    `else if (err.contains("401") || err.contains("403") || err.contains("authentication") || err.contains("API key not valid") || err.contains("API_KEY_INVALID")) { err = "The " + p + " API key on ${o.llmConfigName} is invalid or has no access to the model."; }`,
    'else if (err.contains("404")) { err = "The " + p + " model was not found. Set dbb_llm_model_" + p + " on the LLM config asset."; }',
    'else if (err.contains("429")) { err = "The " + p + " API is rate-limited or out of credit. Try again later or switch the key."; }',
    // provider-side capacity problems (Gemini 503 UNAVAILABLE, Claude 529 overloaded_error): not our bug, say so plainly
    'else if (err.contains("503") || err.contains("529") || err.contains("UNAVAILABLE") || err.contains("overloaded")) { err = "The " + p + " service is overloaded right now (a temporary problem on the provider\'s side). Try again in a minute. If it keeps happening, use a paid key or another provider\'s key on " + "DBB-LLM-CONFIG."; }',
    // network problems between ThingsBoard and the provider (seen as "WebClientRequestException: null" / timeouts, D-024)
    'else if (err.contains("WebClientRequestException") || err.contains("ReadTimeout") || err.contains("timed out") || err.contains("Connection reset")) { err = "Could not reach the " + p + " service (a network problem between ThingsBoard and the provider). Try again in a moment."; }',
    'else if (body != "") { err = p + " rejected the request: " + body; }',
    'if (err.length() > 300) { err = err.substring(0, 300); }',
    // failures before "Build LLM request" have no reqId/userId in metadata yet: take them from the request itself,
    // otherwise the builder ignores the reply and waits for its 30 s timeout
    'var rid = metadata.reqId;',
    'var uid = metadata.userId;',
    'if (msg.dbb_chat_req != null) { if (rid == null) { rid = msg.dbb_chat_req.reqId; } if (uid == null) { uid = msg.dbb_chat_req.userId; } }',
    'var resp = {reqId: rid, ok: false, provider: p, status: "" + metadata.status, error: err};',
    'var out = {};',
    'out["dbb_chat_resp_" + uid] = resp;',
    'var md = {reqId: "" + rid, userId: "" + uid};',
    'return {msg: out, metadata: md, msgType: "POST_ATTRIBUTES_REQUEST"};',
  ].join('\n');
  // Node order matters: connections below refer to nodes by index (0 = first node).
  const tbel = (s) => ({ scriptLang: 'TBEL', tbelScript: s, jsScript: 'return msg;' });
  // One REST node per provider: each sends only its own auth header (the key comes from metadata.llmKey,
  // set by "Build LLM request"; ThingsBoard substitutes ${...} in URL and header values).
  const rest = (name, url, headers, y) => ({
    type: 'org.thingsboard.rule.engine.rest.TbRestApiCallNode',
    name,
    configurationVersion: 3,
    configuration: {
      restEndpointUrlPattern: url,
      requestMethod: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      useSimpleClientHttpFactory: false,
      readTimeoutMs: 28000,
      maxParallelRequestsCount: 4,
      parseToPlainText: false,
      enableProxy: false,
      useSystemProxyProperties: false,
      proxyHost: null,
      proxyPort: 0,
      proxyUser: null,
      proxyPassword: null,
      proxyScheme: null,
      credentials: { type: 'anonymous' },
      ignoreRequestBody: false,
      maxInMemoryBufferSizeInKb: 512,
    },
    additionalInfo: { layoutX: 1050, layoutY: y },
  });
  const nodes = [
    /* 0 */ { type: 'org.thingsboard.rule.engine.filter.TbJsFilterNode', name: 'Is chat request', configuration: { scriptLang: 'TBEL', tbelScript: filterScript, jsScript: 'return false;' }, additionalInfo: { layoutX: 300, layoutY: 150 } },
    /* 1 */ {
      type: 'org.thingsboard.rule.engine.metadata.TbGetRelatedAttributeNode',
      name: 'Read LLM settings',
      configurationVersion: 1,
      configuration: {
        relationsQuery: { direction: 'FROM', maxLevel: 1, fetchLastLevelOnly: false, filters: [{ relationType: 'UsesLlmConfig', entityTypes: ['ASSET'], negate: false }] },
        dataToFetch: 'ATTRIBUTES',
        dataMapping: { dbb_llm_api_key: 'llmKey', dbb_llm_model_anthropic: 'llmModelAnthropic', dbb_llm_model_openai: 'llmModelOpenai', dbb_llm_model_gemini: 'llmModelGemini' },
        fetchTo: 'METADATA',
      },
      additionalInfo: { layoutX: 300, layoutY: 300 },
    },
    /* 2 */ { type: 'org.thingsboard.rule.engine.transform.TbTransformMsgNode', name: 'Build LLM request', configuration: tbel(buildScript), additionalInfo: { layoutX: 550, layoutY: 300 } },
    /* 3 */ { type: 'org.thingsboard.rule.engine.filter.TbJsSwitchNode', name: 'Pick provider', configuration: { scriptLang: 'TBEL', tbelScript: switchScript, jsScript: 'return [metadata.provider];' }, additionalInfo: { layoutX: 800, layoutY: 300 } },
    /* 4 */ rest('Call Claude', 'https://api.anthropic.com/v1/messages', { 'anthropic-version': '2023-06-01', 'x-api-key': '${llmKey}' }, 150),
    /* 5 */ rest('Call OpenAI', 'https://api.openai.com/v1/chat/completions', { Authorization: 'Bearer ${llmKey}' }, 300),
    /* 6 */ rest('Call Gemini', 'https://generativelanguage.googleapis.com/v1beta/models/${llmModel}:generateContent', { 'x-goog-api-key': '${llmKey}' }, 450),
    /* 7 */ { type: 'org.thingsboard.rule.engine.transform.TbTransformMsgNode', name: 'Parse LLM reply', configuration: tbel(parseScript), additionalInfo: { layoutX: 1300, layoutY: 200 } },
    /* 8 */ { type: 'org.thingsboard.rule.engine.transform.TbTransformMsgNode', name: 'Error reply', configuration: tbel(errScript), additionalInfo: { layoutX: 1300, layoutY: 420 } },
    /* 9 */ {
      type: 'org.thingsboard.rule.engine.telemetry.TbMsgAttributesNode',
      name: 'Save reply attribute',
      configurationVersion: 3,
      configuration: { processingSettings: { type: 'ON_EVERY_MESSAGE' }, scope: 'SERVER_SCOPE', notifyDevice: false, sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: false },
      additionalInfo: { layoutX: 1550, layoutY: 300 },
    },
    // D-066: the licence and quota gate (10-12) and the server-side meter (13-16)
    /* 10 */ {
      type: 'org.thingsboard.rule.engine.metadata.TbGetCustomerAttributeNode',
      name: 'Licence and AI usage',
      configurationVersion: 1,
      configuration: { fetchTo: 'METADATA', dataToFetch: 'ATTRIBUTES', dataMapping: { imexLicenceStatus: 'lStatus', imexLicenceBinding: 'lBind', imexAiUsage: 'lUsage' } },
      additionalInfo: { layoutX: 300, layoutY: 30 },
    },
    /* 11 */ { type: 'org.thingsboard.rule.engine.transform.TbTransformMsgNode', name: 'Licence and quota', configuration: tbel(gateScript), additionalInfo: { layoutX: 550, layoutY: 30 } },
    /* 12 */ { type: 'org.thingsboard.rule.engine.filter.TbJsSwitchNode', name: 'Allowed?', configuration: { scriptLang: 'TBEL', tbelScript: gateRoute, jsScript: 'return ["ok"];' }, additionalInfo: { layoutX: 800, layoutY: 30 } },
    /* 13 */ { type: 'org.thingsboard.rule.engine.transform.TbTransformMsgNode', name: 'Meter the call', configuration: tbel(meterScript), additionalInfo: { layoutX: 1550, layoutY: 120 } },
    /* 14 */ {
      type: 'org.thingsboard.rule.engine.transform.TbChangeOriginatorNode',
      name: 'To the licence keeper',
      configurationVersion: 0,
      configuration: { originatorSource: 'ENTITY', entityType: 'ASSET', entityNamePattern: 'iMEX Keeper', relationsQuery: { direction: 'FROM', maxLevel: 1, filters: [{ relationType: 'Contains', entityTypes: [] }], fetchLastLevelOnly: false } },
      additionalInfo: { layoutX: 1800, layoutY: 120 },
    },
    /* 15 */ {
      type: 'org.thingsboard.rule.engine.telemetry.TbMsgTimeseriesNode',
      name: 'Save the meter point',
      configurationVersion: 1,
      configuration: { defaultTTL: 0, useServerTs: true, processingSettings: { type: 'ON_EVERY_MESSAGE' } },
      additionalInfo: { layoutX: 2050, layoutY: 120 },
    },
  ];
  // the keeper chain (App UI scripts/relay.mjs) recounts the month after each point; without it the count follows on
  // the keeper's next recount
  const keeperChain = (await all(`/api/ruleChains?textSearch=${encodeURIComponent('iMEX Licence keeper')}`)).find((x) => x.name === 'iMEX Licence keeper');
  if (keeperChain) nodes.push(/* 16 */ { type: 'org.thingsboard.rule.engine.flow.TbRuleChainInputNode', name: 'Recount (licence keeper)', configurationVersion: 1, configuration: { ruleChainId: keeperChain.id.id, forwardMsgToDefaultRuleChain: false }, additionalInfo: { layoutX: 2300, layoutY: 120 } });
  // D-066: no debug on any node (the LLM key and the user's request pass through them)
  for (const nd of nodes) nd.debugSettings = { failuresEnabled: false, allEnabled: false, allEnabledUntil: 0 };
  const connections = [
    { fromIndex: 0, toIndex: 10, type: 'True' },
    // D-066: licence and quota before anything is sent to a provider
    { fromIndex: 10, toIndex: 11, type: 'Success' },
    { fromIndex: 10, toIndex: 11, type: 'Failure' },
    { fromIndex: 11, toIndex: 12, type: 'Success' },
    { fromIndex: 11, toIndex: 8, type: 'Failure' },
    { fromIndex: 12, toIndex: 1, type: 'ok' },
    { fromIndex: 12, toIndex: 8, type: 'no' },
    { fromIndex: 12, toIndex: 8, type: 'Failure' },
    { fromIndex: 1, toIndex: 2, type: 'Success' },
    { fromIndex: 1, toIndex: 8, type: 'Failure' },
    { fromIndex: 2, toIndex: 3, type: 'Success' },
    { fromIndex: 2, toIndex: 8, type: 'Failure' },
    { fromIndex: 3, toIndex: 4, type: 'anthropic' },
    { fromIndex: 3, toIndex: 5, type: 'openai' },
    { fromIndex: 3, toIndex: 6, type: 'gemini' },
    { fromIndex: 3, toIndex: 8, type: 'none' },
    { fromIndex: 3, toIndex: 8, type: 'Failure' },
  ];
  for (const r of [4, 5, 6]) connections.push({ fromIndex: r, toIndex: 7, type: 'Success' }, { fromIndex: r, toIndex: 8, type: 'Failure' });
  connections.push({ fromIndex: 7, toIndex: 9, type: 'Success' }, { fromIndex: 7, toIndex: 8, type: 'Failure' }, { fromIndex: 8, toIndex: 9, type: 'Success' });
  // D-066: a parsed reply = one provider call that answered: metered on the keeper
  connections.push({ fromIndex: 7, toIndex: 13, type: 'Success' }, { fromIndex: 13, toIndex: 14, type: 'Success' }, { fromIndex: 14, toIndex: 15, type: 'Success' });
  if (keeperChain) connections.push({ fromIndex: 15, toIndex: 16, type: 'Success' });
  // Replaces all nodes and connections of the chain (passing the current version for optimistic locking).
  await api('POST', '/api/ruleChain/metadata', { ruleChainId: rc.id, version: existingMeta.version, firstNodeIndex: 0, nodes, connections, ruleChainConnections: null });
  say(`rule chain "${rcName}" written (Claude / OpenAI / Gemini, key read from ${o.llmConfigName})`);

  // --- asset profile + store asset
  const apName = 'DashboardStore';
  let ap = (await all(`/api/assetProfiles?textSearch=${apName}`)).find((x) => x.name === apName);
  if (ap && !String(ap.description || '').includes(MARK)) throw new Error('Asset profile DashboardStore exists without the POC marker');
  if (!ap) ap = await api('POST', '/api/assetProfile', { name: apName, description: `${MARK} Dashboard Builder store (one asset per customer)` });
  // Re-read the full profile before saving, so the POST doesn't drop fields the list view omits.
  ap = await api('GET', `/api/assetProfile/${ap.id.id}`);
  ap.defaultRuleChainId = rc.id;
  await api('POST', '/api/assetProfile', ap);
  say('asset profile DashboardStore → chat relay rule chain');

  let store = await api('GET', `/api/tenant/assets?assetName=${encodeURIComponent(o.storeName)}`, undefined, true);
  if (!store) {
    store = await api('POST', '/api/asset', { name: o.storeName, label: 'Dashboard store', assetProfileId: ap.id });
    say('store asset created');
  }
  // Customers can't write customer attributes, so the store is an asset assigned to the customer (D-012).
  if (!store.customerId || store.customerId.id !== cid) await api('POST', `/api/customer/${cid}/asset/${store.id.id}`);
  await api('POST', `/api/plugins/telemetry/ASSET/${store.id.id}/attributes/SERVER_SCOPE`, { poc: true, dbb_profile_keys: o.profileKeys });
  say('store asset assigned to ' + o.customerTitle + ', profile keys written');

  // --- tenant-owned LLM config asset (D-021): holds the API key; never assigned to a customer.
  const NULL_CUSTOMER = '13814000-1dd2-11b2-8080-808080808080';
  let cfg = await api('GET', `/api/tenant/assets?assetName=${encodeURIComponent(o.llmConfigName)}`, undefined, true);
  if (!cfg) {
    cfg = await api('POST', '/api/asset', { name: o.llmConfigName, label: 'LLM API key (tenant only, never assign to a customer)' });
    say(`LLM config asset ${o.llmConfigName} created (tenant-owned)`);
  }
  // Safety: a customer-assigned config asset would expose the key to that customer's users.
  if (cfg.customerId && cfg.customerId.id !== NULL_CUSTOMER) throw new Error(`${o.llmConfigName} is assigned to a customer; unassign it first (its API key would be readable by that customer's users).`);
  const cfgAttrs = {};
  for (const a of (await api('GET', `/api/plugins/telemetry/ASSET/${cfg.id.id}/values/attributes/SERVER_SCOPE`)) || []) cfgAttrs[a.key] = a.value;
  // Only missing values are written, so a key or model set by an admin is never overwritten.
  const cfgNew = { poc: true };
  if (!cfgAttrs.dbb_llm_model_anthropic) cfgNew.dbb_llm_model_anthropic = o.llmModel;
  if (!cfgAttrs.dbb_llm_model_openai) cfgNew.dbb_llm_model_openai = o.openaiModel;
  if (!cfgAttrs.dbb_llm_model_gemini) cfgNew.dbb_llm_model_gemini = o.geminiModel;
  if (!cfgAttrs.dbb_llm_api_key) cfgNew.dbb_llm_api_key = legacyKey || '';
  await api('POST', `/api/plugins/telemetry/ASSET/${cfg.id.id}/attributes/SERVER_SCOPE`, cfgNew);
  if (legacyKey && !cfgAttrs.dbb_llm_api_key) say('API key from the old "Call LLM" node moved to ' + o.llmConfigName);
  // store --UsesLlmConfig--> config (read by the "Read LLM settings" node). Idempotent (POST updates in place).
  // ThingsBoard 4.3 saves relations at /api/v2/relation; older versions only have /api/relation.
  const rel = { from: store.id, to: cfg.id, type: 'UsesLlmConfig', typeGroup: 'COMMON' };
  await api('POST', '/api/v2/relation', rel).catch(() => api('POST', '/api/relation', rel));
  say(`store linked to ${o.llmConfigName}` + (cfgAttrs.dbb_llm_api_key || legacyKey ? '' : ' (set dbb_llm_api_key on it to enable chat)'));

  // --- widget bundle + types
  const bundles = await all('/api/widgetsBundles?tenantOnly=true');
  let bundle = bundles.find((b) => b.title === o.bundleTitle);
  if (!bundle) bundle = await api('POST', '/api/widgetsBundle', { title: o.bundleTitle, alias: 'imex_dbb', description: `${MARK} iMEX Dashboard Builder POC widgets` });
  // Copy of widgets/widget-types.mjs (this file is pasted into a console and can't import it). Keep in sync.
  const settingsSchemas = {
    launcher: {
      schema: {
        type: 'object',
        properties: {
          label: { title: 'Edit icon tooltip', type: 'string', default: 'Edit dashboards' },
          adminOnly: { title: 'Show the edit icon to admins only (Role = Admin)', type: 'boolean', default: true },
          homeState: { title: 'Home (map) state id', type: 'string', default: 'default' },
          homeLabel: { title: 'Home link label', type: 'string', default: 'Map page' },
          listingState: { title: 'Listing state id', type: 'string', default: 'listing' },
          listingLabel: { title: 'Listing link label', type: 'string', default: 'Listing page' },
          machineState: { title: 'Machine state id', type: 'string', default: 'machine' },
          machineLabel: { title: 'Machine state label', type: 'string', default: 'Machine page' },
          customerId: { title: 'Customer id to show when a tenant admin opens the app', type: 'string', default: '' },
          navbar: { title: 'Render as full navbar (stand-in app)', type: 'boolean', default: false },
          appName: { title: 'App name (navbar mode)', type: 'string', default: 'iMEX' },
          lightStyle: { title: 'Light icon button (for light headers)', type: 'boolean', default: false },
          chatEnabled: { title: 'Enable chat', type: 'boolean', default: true },
          chatEnabledRoles: { title: 'Chat only for roles (comma separated, empty = all)', type: 'string', default: '' },
          hideForRoles: { title: 'Hide the edit icon for roles (comma separated)', type: 'string', default: '' },
          dashboardList: { title: 'Show "Dashboard list" (standalone dashboards) to every user', type: 'boolean', default: true },
          overviewState: { title: 'Dashboard Overview state id (standalone dashboards)', type: 'string', default: 'dashboard_overview' },
          builderTop: { title: 'Dashboard Builder starts below (auto = below the navbar; px; 0 = full screen)', type: 'string', default: 'auto' },
          headless: { title: 'Headless: draw nothing, only provide the builder API (window.IMEX_DBB) for an app menu of its own', type: 'boolean', default: false },
        },
      },
      form: ['label', 'adminOnly', 'navbar', 'appName', 'homeState', 'homeLabel', 'listingState', 'listingLabel', 'machineState', 'machineLabel', 'customerId', 'lightStyle', 'chatEnabled', 'chatEnabledRoles', 'hideForRoles', 'dashboardList', 'overviewState', 'builderTop', 'headless'],
    },
    renderer: {
      schema: { type: 'object', properties: { refreshSeconds: { title: 'Refresh every (s)', type: 'number', default: 10 }, chatEnabled: { title: 'Enable chat in builder', type: 'boolean', default: true }, customerId: { title: 'Customer id for tenant admins', type: 'string', default: '' } } },
      form: ['refreshSeconds', 'chatEnabled', 'customerId'],
    },
    listing: {
      schema: {
        type: 'object',
        properties: {
          mode: { title: "Mode ('listing' or 'map')", type: 'string', default: 'listing' },
          machineState: { title: 'Machine state id', type: 'string', default: 'machine' },
          dashboardState: { title: 'Standalone dashboard state id', type: 'string', default: 'dashboard' },
          title: { title: 'Map mode: title', type: 'string', default: 'Map page' },
          buttonLabel: { title: 'Map mode: button label', type: 'string', default: 'Go to machine listing' },
          listingState: { title: 'Map mode: listing state id', type: 'string', default: 'listing' },
          siteProfile: { title: 'Map mode: asset profile of the site nodes', type: 'string', default: 'Site' },
          customerId: { title: 'Customer id for tenant admins', type: 'string', default: '' },
        },
      },
      form: ['mode', 'machineState', 'dashboardState', 'title', 'buttonLabel', 'listingState', 'siteProfile', 'customerId'],
    },
  };
  const names = { launcher: 'iMEX Navbar / edit menu', renderer: 'iMEX Machine dashboard', listing: 'iMEX Listing / Map page (stand-in)' };
  const sizes = { launcher: [6, 1], renderer: [24, 12], listing: [24, 12] };
  const fqns = [];
  for (const k of ['launcher', 'renderer', 'listing']) {
    const fqn = `imex_dbb_${k}`;
    // Lookup needs the `tenant.` prefix; the response omits `description`, which is set below anyway.
    let wt = await api('GET', `/api/widgetType?fqn=tenant.${fqn}`, undefined, true);
    const descriptor = {
      type: 'static',
      sizeX: sizes[k][0],
      sizeY: sizes[k][1],
      resources: [],
      templateHtml: '',
      templateCss: '',
      controllerScript: window.__dbbLib + '\n' + window.__dbbGlue[k],
      settingsSchema: JSON.stringify(settingsSchemas[k]),
      dataKeySettingsSchema: '{}',
      defaultConfig: JSON.stringify({ datasources: [], showTitle: false, backgroundColor: 'rgba(0,0,0,0)', color: 'rgba(0,0,0,0.87)', padding: '0px', settings: {}, title: names[k], dropShadow: false, enableFullscreen: false }),
    };
    // Merging into the existing type keeps its id/version, so POST updates it in place.
    const body = Object.assign(wt || {}, { fqn, name: names[k], descriptor, description: `${MARK} built ${window.__dbbGlue.version || ''}`, deprecated: false, scada: false });
    wt = await api('POST', '/api/widgetType', body);
    fqns.push(wt.fqn);
    say(`widget type ${fqn} saved (${Math.round(descriptor.controllerScript.length / 1024)} KB)`);
  }
  // Sets (replaces) the bundle's widget type list.
  await api('POST', `/api/widgetsBundle/${bundle.id.id}/widgetTypeFqns`, fqns);
  // Build now deployed (D-022): pages still running an older build see "reload the page" in the builder.
  // Written only after the widget types are saved, so a failed deploy never claims a newer build.
  if (window.__dbbGlue.version) {
    await api('POST', `/api/plugins/telemetry/ASSET/${store.id.id}/attributes/SERVER_SCOPE`, { dbb_lib_version: window.__dbbGlue.version });
    say('store: dbb_lib_version = ' + window.__dbbGlue.version);
  }

  // --- stand-in app dashboard (skipped when the real app dashboard already hosts our widgets, D-035)
  if (o.skipAppDashboard) {
    say('app dashboard and home dashboards skipped (skipAppDashboard)');
    return { log, dashboardId: null, storeId: store.id.id, ruleChainId: rc.id.id, bundleId: bundle.id.id };
  }
  // Unused (fixed ids below are used instead; `void wid` silences the linter).
  const wid = (n) => `dbb-${n}-0000-0000-000000000000`.slice(0, 36);
  const W = {
    nav: { key: 'nav', fqn: 'tenant.imex_dbb_launcher', settings: { navbar: true, appName: o.appName, label: 'Edit dashboards', adminOnly: true, homeState: 'default', homeLabel: 'Map page', listingState: 'listing', listingLabel: 'Listing page', machineState: 'machine', machineLabel: 'Machine page', overviewState: 'dashboard_overview', customerId: cid }, bg: '#0a2458' },
    map: { key: 'map', fqn: 'tenant.imex_dbb_listing', settings: { mode: 'map', title: 'Map page', buttonLabel: 'Go to machine listing', listingState: 'listing', siteProfile: 'Site', customerId: cid }, bg: '#f6f6f4' },
    list: { key: 'list', fqn: 'tenant.imex_dbb_listing', settings: { machineState: 'machine', dashboardState: '', customerId: cid }, bg: '#f6f6f4' },
    mach: { key: 'mach', fqn: 'tenant.imex_dbb_renderer', settings: { refreshSeconds: 10, customerId: cid }, bg: '#f6f6f4' },
  };
  // Fixed widget ids so re-deploys overwrite the same widgets in the dashboard configuration.
  const ids = { nav: 'a1b2c3d4-0001-4000-8000-000000000001', list: 'a1b2c3d4-0002-4000-8000-000000000002', mach: 'a1b2c3d4-0003-4000-8000-000000000003', map: 'a1b2c3d4-0005-4000-8000-000000000005' };
  void wid;
  const widgets = {};
  for (const [k, w] of Object.entries(W))
    widgets[ids[k]] = {
      id: ids[k],
      typeFullFqn: w.fqn,
      type: 'static',
      sizeX: 24,
      sizeY: k === 'nav' ? 1 : 14,
      config: { datasources: [], showTitle: false, backgroundColor: w.bg, color: 'rgba(0,0,0,0.87)', padding: '0px', margin: '0px', settings: w.settings, title: k, dropShadow: false, enableFullscreen: false, borderRadius: '0px', actions: {} },
      row: 0,
      col: 0,
    };
  const grid = { layoutType: 'default', backgroundColor: '#f6f6f4', columns: 24, margin: 0, outerMargin: false, backgroundSizeMode: '100%', autoFillHeight: true, mobileAutoFillHeight: true, mobileRowHeight: 70 };
  // Every state: the navbar (row 0) above one full-width body widget.
  const layout = (body) => ({ main: { widgets: { [ids.nav]: { sizeX: 24, sizeY: 1, row: 0, col: 0 }, [ids[body]]: { sizeX: 24, sizeY: 14, row: 1, col: 0 } }, gridSettings: grid } });
  const configuration = {
    description: `${MARK} Stand-in for the production app, 4 states: Map page (sites) → Listing page (hierarchy + cards) → Machine page, plus Dashboard Overview (standalone dashboards). Navbar shows the current state and an admin-only Dashboard Builder button`,
    widgets,
    states: {
      default: { name: 'Map page', root: true, layouts: layout('map') },
      listing: { name: 'Listing page', root: false, layouts: layout('list') },
      machine: { name: 'Machine page', root: false, layouts: layout('mach') },
      // D-026: standalone dashboards (Dashboard list) open here; same machine-dashboard widget.
      dashboard_overview: { name: 'Dashboard Overview', root: false, layouts: layout('mach') },
    },
    entityAliases: {},
    filters: {},
    timewindow: { realtime: { realtimeType: 1, timewindowMs: 86400000, interval: 60000 }, aggregation: { type: 'NONE', limit: 200 } },
    settings: { stateControllerId: 'entity', showTitle: false, showDashboardsSelect: false, showEntitiesSelect: false, showDashboardTimewindow: false, showDashboardExport: false, showDashboardLogo: false, toolbarAlwaysOpen: false, hideToolbar: true, showFilters: false, showUpdateDashboardImage: false },
  };
  // Existing dashboard: replace only its configuration (title, assignments etc. kept).
  let dash = (await all(`/api/tenant/dashboards?textSearch=${encodeURIComponent(o.appTitle)}`)).find((d) => d.title === o.appTitle);
  if (dash) {
    const full = await api('GET', `/api/dashboard/${dash.id.id}`);
    dash = await api('POST', '/api/dashboard', Object.assign(full, { configuration }));
  } else dash = await api('POST', '/api/dashboard', { title: o.appTitle, configuration });
  await api('POST', `/api/customer/${cid}/dashboard/${dash.id.id}`);
  say(`dashboard "${o.appTitle}" saved and assigned`);

  // --- home dashboard for the POC users
  // Only users of this customer whose email is listed; others are left alone.
  const users = await all(`/api/customer/${cid}/users`);
  for (const u of users.filter((x) => o.userEmails.includes(x.email))) {
    const full = await api('GET', `/api/user/${u.id.id}`);
    full.additionalInfo = Object.assign(full.additionalInfo || {}, { defaultDashboardId: dash.id.id, defaultDashboardFullscreen: true, homeDashboardId: dash.id.id, homeDashboardHideToolbar: true });
    await api('POST', '/api/user?sendActivationMail=false', full);
  }
  say(`home dashboard set for ${o.userEmails.length} users`);
  return { log, dashboardId: dash.id.id, storeId: store.id.id, ruleChainId: rc.id.id, bundleId: bundle.id.id };
};
// Last expression, so the console prints a confirmation when the script is pasted.
'deploy script loaded';
