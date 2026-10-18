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
//      Is chat request -> Read AI switches (D-070: imexLlm on "System Configuration" via relation UsesAppConfig, the
//      app's master + Builder switch; no relation = "AI switches unreadable" = off) -> Licence and AI usage (the store's customer: imexLicenceStatus, imexLicenceBinding,
//      imexAiUsage; D-066) -> Licence and quota (builder + builder.ai + genAi, mode active / grace, this month's count
//      below llmCallsPerMonth; else the error reply) -> Read LLM settings (config asset attributes via relation UsesLlmConfig) ->
//      Build LLM request (provider picked from the key format) -> Pick provider -> Call Claude | Call OpenAI |
//      Call Gemini -> Parse LLM reply / Error reply -> To the user (reply) -> Save reply attribute (`dbb_chat_resp` on the
//      requesting USER, D-074). D-074: first the writer's role from the role guard's registry ("iMEX Role Registry":
//      Build dashboards) and a per-user hourly count (`dbb_rate_<userId>` on "iMEX Keeper"); the system prompt and the
//      tool are the chain's own (widgets/dist/glue.json `chat`, from core/chat-prompt.ts); other store attribute changes
//      go on to the "iMEX Role guard" chain when it exists. A parsed reply
//      is also metered (D-066): one llm_builder point on the tenant-only asset "iMEX Keeper", then the licence keeper
//      chain recounts the month (when it exists: App UI scripts/relay.mjs).
//      A key pasted into the pre-D-021 "Call LLM" node is moved to the config asset (step 3b).
//   3. Asset profile "DashboardStore" (must carry the POC marker if it exists) with the chat relay as its
//      default rule chain; store asset `storeName` created if missing, assigned to the customer, and
//      SERVER_SCOPE attributes `poc=true` + `dbb_profile_keys` written.
//   3b. Tenant-owned asset `llmConfigName` (never assigned to a customer; the script refuses to continue if it
//      is): attributes dbb_llm_api_key (empty until a tenant admin sets it), dbb_llm_model_{anthropic,openai,gemini}
//      (defaults, written only when missing); relation store --UsesLlmConfig--> config asset; D-070: relation
//      store --UsesAppConfig--> `appConfigName` ("System Configuration", the AI switches imexLlm).
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
// Defaults of DBB_DEPLOY's options (also used when deploy-node.mjs --target=server builds the chat chain alone).
window.DBB_DEPLOY_DEFAULTS = {
  customerTitle: 'ITHENA',
  storeName: 'DBB-STORE-ITHENA',
  appTitle: 'iMEX App (POC)',
  appName: 'iMEX · ITHENA',
  bundleTitle: 'iMEX Self-Service (POC)',
  llmModel: 'claude-sonnet-5',
  openaiModel: 'chat-latest',
  geminiModel: 'gemini-flash-latest',
  llmConfigName: 'DBB-LLM-CONFIG',
  // D-070: the app's configuration asset (the customer's): the chat chain reads the AI switches imexLlm there
  appConfigName: 'System Configuration',
  // D-074: the role guard's tenant-only registry (App UI scripts/role-guard.mjs REGISTRY): the chat checks the writer's role there
  roleRegistryName: 'iMEX Role Registry',
  profileKeys: {},
  userEmails: [],
};

// Step 2's rule chain "DBB Chat relay (POC)" as metadata { nodes, connections } (node 0 first). o = DBB_DEPLOY's
// options (llmModel, openaiModel, geminiModel, llmConfigName); keeperChainId = the id of the chain "iMEX Licence keeper"
// (App UI scripts/relay.mjs), or null: then no "Recount (licence keeper)" node. Pure: no REST calls.
window.DBB_CHAT_CHAIN = function (o, keeperChainId, more) {
  // D-074: the system prompt template and the tool are fixed here (o.chatContract, else widgets/dist/glue.json `chat`,
  // built from widgets/src/core/chat-prompt.ts); the browser sends only {v: 2, catalog, machine, messages}.
  const C = o.chatContract || (window.__dbbGlue && window.__dbbGlue.chat);
  if (!C || C.v !== 2 || !C.template || !C.tool) throw new Error('chat contract missing: run npm run build:widgets (widgets/dist/glue.json "chat")');
  const guardChainId = (more && more.guardChainId) || null;
  // TBEL scripts. The builder writes `dbb_chat_req` = {reqId, userId, body} on the store asset, where body (D-074) =
  // {v: 2, catalog (the aliased catalogue JSON), machine (alias or null), messages [{role, content}]} (core/chat.ts
  // buildRequest). Replies go to `dbb_chat_resp` on the requesting user = {reqId, ok, provider, toolInput |
  // toolInputJson | error, usage}.
  const filterScript = "return msgType == 'ATTRIBUTES_UPDATED' && msg.dbb_chat_req != null && msg.dbb_chat_req.body != null;";
  // Key -> provider: sk-ant-... = Anthropic, AIza... or AQ.... (newer AI Studio keys) = Google Gemini, any other sk-... = OpenAI.
  // Model per provider: config asset attribute dbb_llm_model_<provider>, else the default below.
  const buildScript = [
    'var req = msg.dbb_chat_req;',
    'var b = req.body;',
    'var i = 0;',
    // D-028: the reply goes to the user ThingsBoard says wrote the request (REST attribute updates carry
    // metadata.userId / userEmail), never to an id taken from the request body.
    'var uid = metadata.userId;',
    'if (uid == null || uid == "") { uid = "" + req.userId; }',
    'var md = {reqId: "" + req.reqId, userId: "" + uid, userEmail: "" + metadata.userEmail};',
    'if (req.userId != null && ("" + req.userId) != ("" + uid)) { md.error = "USER_MISMATCH"; }',
    // D-074: only the version-2 body: the catalogue (data), the open machine's alias and plain-text messages. The system
    // prompt and the tool are this chain's own, so the relay can't be used as a general LLM proxy.
    'if (md.error == null && (b == null || !(b.v is Number) || b.v != 2)) { md.error = "OLD_CLIENT"; }',
    'var cat = "";',
    `var mach = ${JSON.stringify(C.fill.noMachine)};`,
    'var msgs = [];',
    'if (md.error == null) {',
    '  if (!(b.catalog is String) || !(b.messages is java.util.List)) { md.error = "BAD_REQ"; }',
    '  else if (b.messages.size() < 1 || b.messages.size() > 24) { md.error = "TOO_BIG"; }',
    '  else {',
    '    cat = b.catalog;',
    '    var total = cat.length();',
    '    if (b.machine != null) { if (b.machine is String && b.machine.matches("^D[0-9]{1,5}$")) { mach = b.machine; } else { md.error = "BAD_REQ"; } }',
    '    for (i = 0; i < b.messages.size(); i++) {',
    '      var m = b.messages[i];',
    '      if (m is java.util.Map && m.content is String && (m.role == "user" || m.role == "assistant")) { total = total + m.content.length(); msgs.add({role: "" + m.role, content: "" + m.content}); }',
    '      else { md.error = "BAD_REQ"; }',
    '    }',
    '    if (md.error == null && msgs[msgs.size() - 1].role != "user") { md.error = "BAD_REQ"; }',
    '    if (md.error == null && (cat.length() > 60000 || total > 90000)) { md.error = "TOO_BIG"; }',
    '  }',
    '}',
    // the role's "apply to many machines" (from the registry, D-074) and the licence's alarm list fill the prompt
    `var sys = ${JSON.stringify(C.template)};`,
    `if (metadata.cApplyMany == "1") { sys = sys.replace(${JSON.stringify(C.mark.apply)}, ${JSON.stringify(C.fill.applyYes)}); } else { sys = sys.replace(${JSON.stringify(C.mark.apply)}, ${JSON.stringify(C.fill.applyNo)}); }`,
    `if (metadata.cAlerts == "0") { sys = sys.replace(${JSON.stringify(C.mark.noAlarms)}, ${JSON.stringify(C.fill.noAlarms)}); } else { sys = sys.replace(${JSON.stringify(C.mark.noAlarms)}, ""); }`,
    `sys = sys.replace(${JSON.stringify(C.mark.machine)}, mach);`,
    `sys = sys.replace(${JSON.stringify(C.mark.catalog)}, cat);`,
    'var key = metadata.llmKey;',
    'if (key == null) { key = ""; }',
    'key = key.trim();',
    'var provider = "none";',
    'if (key.startsWith("sk-ant-")) { provider = "anthropic"; } else if (key.startsWith("AIza") || key.startsWith("AQ.")) { provider = "gemini"; } else if (key.startsWith("sk-")) { provider = "openai"; }',
    'if (md.error != null) { provider = "none"; }',
    'md.provider = provider;',
    'md.llmKey = key;',
    'var model = "";',
    'var body = {};',
    'if (provider == "anthropic") {',
    '  model = metadata.llmModelAnthropic;',
    `  if (model == null || model == "") { model = "${o.llmModel}"; }`,
    `  var aTool = JSON.parse(${JSON.stringify(JSON.stringify(C.tool))});`,
    '  body = {model: model, max_tokens: 2048, system: sys, messages: msgs, tools: [aTool], tool_choice: {type: "tool", name: "dashboard_ops"}};',
    '} else if (provider == "openai") {',
    '  model = metadata.llmModelOpenai;',
    `  if (model == null || model == "") { model = "${o.openaiModel}"; }`,
    '  var oMsgs = [{role: "system", content: sys}];',
    '  for (i = 0; i < msgs.size(); i++) { oMsgs.add(msgs[i]); }',
    `  var oTool = JSON.parse(${JSON.stringify(JSON.stringify(C.openaiTool))});`,
    // `function` is a TBEL keyword: set it by index, not in a map literal
    '  var oChoice = {type: "function"};',
    '  oChoice["function"] = {name: "dashboard_ops"};',
    '  body = {model: model, max_completion_tokens: 2048, messages: oMsgs, tools: [oTool], tool_choice: oChoice};',
    '} else if (provider == "gemini") {',
    '  model = metadata.llmModelGemini;',
    `  if (model == null || model == "") { model = "${o.geminiModel}"; }`,
    '  var contents = [];',
    '  for (i = 0; i < msgs.size(); i++) {',
    '    var gm = msgs[i];',
    '    var role = "user";',
    '    if (gm.role == "assistant") { role = "model"; }',
    '    contents.add({role: role, parts: [{text: gm.content}]});',
    '  }',
    `  var gDecl = JSON.parse(${JSON.stringify(JSON.stringify(C.geminiDecl))});`,
    '  body = {systemInstruction: {parts: [{text: sys}]}, contents: contents, tools: [{functionDeclarations: [gDecl]}], toolConfig: {functionCallingConfig: {mode: "ANY", allowedFunctionNames: ["dashboard_ops"]}}, generationConfig: {maxOutputTokens: 2048}};',
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
    // D-070: the app's AI switches (imexLlm on System Configuration, read through store --UsesAppConfig-->, App UI U-097):
    // the master and the Builder switch. Missing attribute = not migrated = on; unreadable = off. A switch that is off
    // wins over the licence reasons (it is what the administrator changed).
    'var sw = asObj(metadata.llmSw);',
    'if (metadata.llmSwErr == "1") { metadata.error = "AI_SW"; }',
    'else if (sw != null) {',
    '  if (!isMap(sw)) { metadata.error = "AI_SW"; }',
    '  else if (!(sw.enabled is Boolean) || sw.enabled != true) { metadata.error = "AI_OFF"; }',
    '  else if (isMap(sw.features) && sw.features.builder is Boolean && sw.features.builder == false) { metadata.error = "AI_OFF"; }',
    '}',
    // D-074: the role check / chat limit wins over everything (it says who may use the chat at all)
    'if (metadata.cRoleErr != null && metadata.cRoleErr != "") { metadata.error = metadata.cRoleErr; }',
    'metadata.remove("cRoleErr");',
    // D-074: the prompt leaves the alarm list out when the licence has no alerts (D-073)
    'metadata.cAlerts = "1";',
    'if ((mode == "active" || mode == "grace") && !(isMap(st.parsed.features) && st.parsed.features.alerts == true)) { metadata.cAlerts = "0"; }',
    'metadata.remove("llmSw");',
    'metadata.remove("llmSwErr");',
    'metadata.remove("lStatus");',
    'metadata.remove("lBind");',
    'metadata.remove("lUsage");',
    'return {msg: msg, metadata: metadata, msgType: msgType};',
  ].join('\n');
  const gateRoute = 'if (metadata.error != null && metadata.error != "") { return ["no"]; } return ["ok"];';
  // D-074 (round 11 audit H5): who may use the chat. The writer's authority and customer come from its user record, its
  // role from the role guard's registry ("iMEX Role Registry", tenant-only: u_<userId>, cfg_imexRoles), never from
  // anything the user can write. Allowed: tenant administrators, and customer users of the store's customer whose role
  // can build dashboards (dashboards.build: implied at Full on Dashboards, tickable at View). The role's "apply to many
  // machines" fills the prompt. Then at most RATE requests per user per hour (dbb_rate_<userId> on "iMEX Keeper", tenant-
  // only; the browser's own limit is 30 turns, a turn makes 1-2 requests). ROLE_TBEL is a copy of App UI
  // scripts/role-guard.mjs ROLE_TBEL (keep in sync).
  const RATE = 60;
  const roleScript = [
    'function asObj(v) { if (v is String) { if (v == "") { return null; } return JSON.parse(v); } return v; }',
    'function isMap(v) { return v != null && v is java.util.Map; }',
    "function isTrue(v) { return (v is Boolean && v == true) || (v is String && v == 'true'); }",
    "function lvl(v) { if (v is String && (v == 'full' || v == 'view' || v == 'hidden')) { return v; } return 'hidden'; }",
    'function storeOk(s) { return isMap(s) && s.v == 1 && s.roles is java.util.List; }',
    'function findRole(s, id) {',
    '  if (!storeOk(s)) { return null; }',
    '  foreach (r : s.roles) { if (isMap(r) && r.id is String && r.id == id) { return r; } }',
    '  return null;',
    '}',
    'function roleOf(u, s) {',
    "  var adm = {'guardAdmin': true};",
    "  if (!isMap(u)) { return findRole(s, 'viewer'); }",
    '  var rid = u.imexRole;',
    "  if (rid is String && rid != '') {",
    "    if (rid == 'admin') { return adm; }",
    '    var r = findRole(s, rid);',
    '    if (r != null) { return r; }',
    "    return findRole(s, 'viewer');",
    '  }',
    "  var name = u.Role is String ? u.Role.trim().toLowerCase() : '';",
    "  if (name == 'admin' || name == 'customer admin' || name == 'administrator' || isTrue(u.dbbAdmin)) { return adm; }",
    "  return findRole(s, 'viewer');",
    '}',
    "function isAdmin(r) { return isMap(r) && r.containsKey('guardAdmin') && isTrue(r.guardAdmin); }",
    'function page(r, key) {',
    "  if (isAdmin(r)) { return 'full'; }",
    "  if (!isMap(r) || !isMap(r.perms)) { return 'hidden'; }",
    '  return lvl(r.perms[key]);',
    '}',
    // perm.js effective(): an action is implied at Full on its page and can be ticked at View
    'function actOk(r, a) {',
    '  if (isAdmin(r)) { return true; }',
    "  var lv = page(r, 'dashboards');",
    "  if (lv == 'full') { return true; }",
    "  return lv == 'view' && isMap(r) && isMap(r.actions) && isTrue(r.actions[a]);",
    '}',
    'var auth = metadata.cActorAuth;',
    'var me = metadata.cActorId;',
    'var NIL = "13814000-1dd2-11b2-8080-808080808080";',
    'var err = "";',
    'var many = "0";',
    'if (me == null || me == "" || me != metadata.userId) { err = "ROLE_ERR"; }',
    'else if (auth == "TENANT_ADMIN") { many = "1"; }',
    'else if (auth != "CUSTOMER_USER") { err = "ROLE"; }',
    'else if (metadata.cActorCust == null || metadata.cActorCust == NIL || metadata.cActorCust != metadata.cStoreCust) { err = "ROLE"; }',
    'else {',
    "  var r = roleOf(asObj(metadata['ss_u_' + me]), asObj(metadata.ss_cfg_imexRoles));",
    '  if (!actOk(r, "dashboards.build")) { err = "ROLE"; }',
    '  else if (actOk(r, "dashboards.applyMany")) { many = "1"; }',
    '}',
    'var hour = new Date().toISOString().substring(0, 13);',
    'var n = 0;',
    "if (me != null && me != '') {",
    "  var rc = asObj(metadata['ss_dbb_rate_' + me]);",
    '  if (isMap(rc) && rc.h == hour && rc.n is Number) { n = rc.n; }',
    "  metadata.remove('ss_u_' + me);",
    "  metadata.remove('ss_dbb_rate_' + me);",
    '}',
    `if (err == "" && metadata.cNoKeeper != "1" && n >= ${RATE}) { err = "RATE"; }`,
    'metadata.remove("ss_cfg_imexRoles");',
    'metadata.cRoleErr = err;',
    'metadata.cApplyMany = many;',
    'metadata.cRate = JSON.stringify({h: hour, n: n + 1});',
    'return {msg: msg, metadata: metadata, msgType: msgType};',
  ].join('\n');
  // counted only when allowed and the keeper was read (else nothing is written). One line of nodes, no fan-out: a node
  // with two outgoing links puts copies back on the queue, which held the request for up to two minutes on LOCAL. So the
  // count record carries the request in metadata (cReq) and "Restore the request" puts it back after the save.
  const countFilter = 'return metadata.cRoleErr == "" && metadata.cNoKeeper != "1" && metadata.cActorId != null && metadata.cActorId != "";';
  const countScript = 'var o = {}; o["dbb_rate_" + metadata.cActorId] = JSON.parse(metadata.cRate); metadata.cReq = JSON.stringify(msg); metadata.cReqType = msgType; return {msg: o, metadata: metadata, msgType: "POST_ATTRIBUTES_REQUEST"};';
  const restoreScript = 'var m = JSON.parse(metadata.cReq); var t = metadata.cReqType; metadata.remove("cReq"); metadata.remove("cReqType"); return {msg: m, metadata: metadata, msgType: t};';
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
    // D-074: on the requesting user (node "To the user (reply)"), not on the customer-writable store
    'out["dbb_chat_resp"] = resp;',
    // D-074: llmCall marks a provider call that answered: metered after the reply is saved (one line, no fan-out)
    'var md = {reqId: "" + metadata.reqId, userId: "" + metadata.userId, userEmail: "" + metadata.userEmail, llmCall: "1"};',
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
    'else if (err.startsWith("BAD_TOOL") || err.startsWith("BAD_REQ")) { err = "The chat request was not made by the Dashboard Builder."; }',
    // D-074
    'else if (err.startsWith("ROLE_ERR")) { err = "Your role could not be checked, so the chat stays off. Try again; if it keeps happening, ask your administrator."; }',
    'else if (err.startsWith("ROLE")) { err = "Your role can\'t use the chat assistant (it needs Build dashboards). Ask your administrator."; }',
    'else if (err.startsWith("RATE")) { err = "Chat limit reached (' + RATE + ' requests per hour). Try again later."; }',
    'else if (err.startsWith("NOT_LICENSED")) { err = "The chat assistant is not included in this installation\'s licence. Ask your administrator."; }',
    'else if (err.startsWith("QUOTA")) { err = "Monthly AI limit reached (" + metadata.qUsed + " of " + metadata.qLimit + ") — contact your administrator"; }',
    'else if (err.startsWith("AI_OFF")) { err = "AI (LLM) use is switched off for the Dashboard builder chat. An administrator can switch it on in Configuration › General › AI (LLM) usage."; }',
    'else if (err.startsWith("AI_SW")) { err = "The chat could not read the AI switches of the application, so it stays off. Ask your administrator."; }',
    'else if (err.startsWith("OLD_CLIENT")) { err = "This page is running an older version of the Dashboard Builder. Reload the page (Ctrl+F5) and try again."; }',
    `else if (p == "") { err = "The chat relay could not read the LLM settings or build the request. Check that asset ${o.llmConfigName} exists and is linked to this store (relation UsesLlmConfig)."; }`,
    `else if (err.contains("401") || err.contains("403") || err.contains("authentication") || err.contains("API key not valid") || err.contains("API_KEY_INVALID")) { err = "The " + p + " API key on ${o.llmConfigName} is invalid or has no access to the model."; }`,
    'else if (err.contains("404")) { err = "The " + p + " model was not found. Set dbb_llm_model_" + p + " on the LLM config asset."; }',
    'else if (err.contains("429")) { err = "The " + p + " API is rate-limited or out of credit. Try again later or switch the key."; }',
    // provider-side capacity problems (Gemini 503 UNAVAILABLE, Claude 529 overloaded_error): not our bug, say so plainly
    'else if (err.contains("503") || err.contains("529") || err.contains("UNAVAILABLE") || err.contains("overloaded")) { err = "The " + p + " service is overloaded right now (a temporary problem on the provider\'s side). Try again in a minute. If it keeps happening, use a paid key or another provider\'s key on ' + o.llmConfigName + '."; }',
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
    // D-074: on the requesting user (node "To the user (reply)")
    'out["dbb_chat_resp"] = resp;',
    'var md = {reqId: "" + rid, userId: "" + uid, userEmail: "" + metadata.userEmail};',
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
    // D-070: the app's AI switches before the licence gate: store --UsesAppConfig--> "System Configuration", attribute
    // imexLlm (no relation = Failure = "unreadable" = off)
    /* 16 */ {
      type: 'org.thingsboard.rule.engine.metadata.TbGetRelatedAttributeNode',
      name: 'Read AI switches',
      configurationVersion: 1,
      configuration: {
        relationsQuery: { direction: 'FROM', maxLevel: 1, fetchLastLevelOnly: false, filters: [{ relationType: 'UsesAppConfig', entityTypes: ['ASSET'], negate: false }] },
        dataToFetch: 'ATTRIBUTES',
        dataMapping: { imexLlm: 'llmSw' },
        fetchTo: 'METADATA',
      },
      additionalInfo: { layoutX: 50, layoutY: 30 },
    },
    /* 17 */ { type: 'org.thingsboard.rule.engine.transform.TbTransformMsgNode', name: 'AI switches unreadable', configuration: tbel('metadata.llmSwErr = "1"; return {msg: msg, metadata: metadata, msgType: msgType};'), additionalInfo: { layoutX: 50, layoutY: 200 } },
  ];
  // D-074: the role check and the per-user count (18-30), between "Is chat request" and "Read AI switches"; the reply
  // goes to the requesting user (31); other store attribute changes go to the role guard (when it exists)
  const byName = (entityType, entityNamePattern) => ({ originatorSource: 'ENTITY', entityType, entityNamePattern, relationsQuery: { direction: 'FROM', maxLevel: 1, filters: [{ relationType: 'Contains', entityTypes: [] }], fetchLastLevelOnly: false } });
  const fetchSrv = (keys) => ({ fetchTo: 'METADATA', clientAttributeNames: [], sharedAttributeNames: [], serverAttributeNames: keys, latestTsKeyNames: [], tellFailureIfAbsent: false, getLatestValueWithTs: false });
  const T = 'org.thingsboard.rule.engine.';
  nodes.push(
    /* 18 */ { type: T + 'metadata.TbGetOriginatorFieldsNode', name: 'The store', configurationVersion: 1, configuration: { fetchTo: 'METADATA', dataMapping: { id: 'cStoreId', name: 'cStoreName', customerId: 'cStoreCust' }, ignoreNullStrings: false }, additionalInfo: { layoutX: 300, layoutY: 600 } },
    /* 19 */ { type: T + 'filter.TbCheckMessageNode', name: 'Made by a user?', configurationVersion: 0, configuration: { messageNames: [], metadataNames: ['userId', 'userEmail'], checkAllKeys: true }, additionalInfo: { layoutX: 550, layoutY: 600 } },
    /* 20 */ { type: T + 'transform.TbChangeOriginatorNode', name: 'To the user', configurationVersion: 0, configuration: byName('USER', '${userEmail}'), additionalInfo: { layoutX: 800, layoutY: 600 } },
    /* 21 */ { type: T + 'metadata.TbGetOriginatorFieldsNode', name: 'The user', configurationVersion: 1, configuration: { fetchTo: 'METADATA', dataMapping: { id: 'cActorId', authority: 'cActorAuth', customerId: 'cActorCust' }, ignoreNullStrings: false }, additionalInfo: { layoutX: 1050, layoutY: 600 } },
    /* 22 */ { type: T + 'transform.TbChangeOriginatorNode', name: 'To the role registry', configurationVersion: 0, configuration: byName('ASSET', o.roleRegistryName), additionalInfo: { layoutX: 1300, layoutY: 600 } },
    /* 23 */ { type: T + 'metadata.TbGetAttributesNode', name: 'Role (registry)', configurationVersion: 1, configuration: fetchSrv(['u_${cActorId}', 'cfg_imexRoles']), additionalInfo: { layoutX: 1550, layoutY: 600 } },
    /* 24 */ { type: T + 'transform.TbChangeOriginatorNode', name: 'To the keeper (count)', configurationVersion: 0, configuration: byName('ASSET', 'iMEX Keeper'), additionalInfo: { layoutX: 1800, layoutY: 600 } },
    /* 25 */ { type: T + 'metadata.TbGetAttributesNode', name: 'Chat count', configurationVersion: 1, configuration: fetchSrv(['dbb_rate_${cActorId}']), additionalInfo: { layoutX: 2050, layoutY: 600 } },
    /* 26 */ { type: T + 'transform.TbTransformMsgNode', name: 'Role and chat limit', configuration: tbel(roleScript), additionalInfo: { layoutX: 2300, layoutY: 600 } },
    /* 27 */ { type: T + 'filter.TbJsFilterNode', name: 'Count it?', configuration: { scriptLang: 'TBEL', tbelScript: countFilter, jsScript: 'return false;' }, additionalInfo: { layoutX: 2300, layoutY: 750 } },
    /* 28 */ { type: T + 'transform.TbTransformMsgNode', name: 'Chat count record', configuration: tbel(countScript), additionalInfo: { layoutX: 2550, layoutY: 750 } },
    /* 29 */ { type: T + 'telemetry.TbMsgAttributesNode', name: 'Save the chat count', configurationVersion: 3, configuration: { processingSettings: { type: 'ON_EVERY_MESSAGE' }, scope: 'SERVER_SCOPE', notifyDevice: false, sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: false }, additionalInfo: { layoutX: 2800, layoutY: 750 } },
    /* 30 */ { type: T + 'transform.TbTransformMsgNode', name: 'Role unreadable', configuration: tbel('metadata.cRoleErr = "ROLE_ERR"; return {msg: msg, metadata: metadata, msgType: msgType};'), additionalInfo: { layoutX: 1300, layoutY: 800 } },
    /* 31 */ { type: T + 'transform.TbTransformMsgNode', name: 'No keeper', configuration: tbel('metadata.cNoKeeper = "1"; return {msg: msg, metadata: metadata, msgType: msgType};'), additionalInfo: { layoutX: 2050, layoutY: 800 } },
    /* 32 */ { type: T + 'transform.TbChangeOriginatorNode', name: 'Back to the store', configurationVersion: 0, configuration: byName('ASSET', '${cStoreName}'), additionalInfo: { layoutX: 2550, layoutY: 600 } },
    /* 33 */ { type: T + 'transform.TbChangeOriginatorNode', name: 'To the user (reply)', configurationVersion: 0, configuration: byName('USER', '${userEmail}'), additionalInfo: { layoutX: 1550, layoutY: 420 } },
    /* 34 */ { type: T + 'transform.TbTransformMsgNode', name: 'Restore the request', configuration: tbel(restoreScript), additionalInfo: { layoutX: 3050, layoutY: 750 } },
    /* 35 */ { type: T + 'filter.TbJsFilterNode', name: 'A provider call?', configuration: { scriptLang: 'TBEL', tbelScript: 'return metadata.llmCall == "1";', jsScript: 'return false;' }, additionalInfo: { layoutX: 1800, layoutY: 300 } },
  );
  // the keeper chain (App UI scripts/relay.mjs) recounts the month after each point; without it the count follows on
  // the keeper's next recount
  const KI = nodes.length;
  if (keeperChainId) nodes.push(/* KI */ { type: 'org.thingsboard.rule.engine.flow.TbRuleChainInputNode', name: 'Recount (licence keeper)', configurationVersion: 1, configuration: { ruleChainId: keeperChainId, forwardMsgToDefaultRuleChain: false }, additionalInfo: { layoutX: 2300, layoutY: 120 } });
  // D-074: every other change of the store's attributes goes to the role guard (App UI scripts/role-guard.mjs), because
  // the store's profile sends them here instead of the root chain; the guard decides which dbb_* keys a role may write
  const GI = nodes.length;
  if (guardChainId) nodes.push(/* GI */ { type: 'org.thingsboard.rule.engine.flow.TbRuleChainInputNode', name: 'Role guard (store changes)', configurationVersion: 1, configuration: { ruleChainId: guardChainId, forwardMsgToDefaultRuleChain: false }, additionalInfo: { layoutX: 300, layoutY: 800 } });
  // D-066: no debug on any node (the LLM key and the user's request pass through them)
  for (const nd of nodes) nd.debugSettings = { failuresEnabled: false, allEnabled: false, allEnabledUntil: 0 };
  const connections = [
    // D-074: the role check and the chat count first (18-31), then back to the store (32)
    { fromIndex: 0, toIndex: 18, type: 'True' },
    { fromIndex: 18, toIndex: 19, type: 'Success' },
    { fromIndex: 18, toIndex: 30, type: 'Failure' },
    { fromIndex: 19, toIndex: 20, type: 'True' },
    { fromIndex: 19, toIndex: 30, type: 'False' },
    { fromIndex: 19, toIndex: 30, type: 'Failure' },
    { fromIndex: 20, toIndex: 21, type: 'Success' },
    { fromIndex: 20, toIndex: 30, type: 'Failure' },
    { fromIndex: 21, toIndex: 22, type: 'Success' },
    { fromIndex: 21, toIndex: 30, type: 'Failure' },
    { fromIndex: 22, toIndex: 23, type: 'Success' },
    { fromIndex: 22, toIndex: 30, type: 'Failure' },
    { fromIndex: 23, toIndex: 24, type: 'Success' },
    { fromIndex: 23, toIndex: 30, type: 'Failure' },
    { fromIndex: 24, toIndex: 25, type: 'Success' },
    { fromIndex: 24, toIndex: 31, type: 'Failure' },
    { fromIndex: 25, toIndex: 26, type: 'Success' },
    { fromIndex: 25, toIndex: 31, type: 'Failure' },
    { fromIndex: 31, toIndex: 26, type: 'Success' },
    { fromIndex: 26, toIndex: 27, type: 'Success' },
    { fromIndex: 26, toIndex: 30, type: 'Failure' },
    { fromIndex: 27, toIndex: 28, type: 'True' },
    { fromIndex: 27, toIndex: 32, type: 'False' },
    { fromIndex: 27, toIndex: 32, type: 'Failure' },
    { fromIndex: 28, toIndex: 29, type: 'Success' },
    { fromIndex: 28, toIndex: 32, type: 'Failure' },
    { fromIndex: 29, toIndex: 34, type: 'Success' },
    { fromIndex: 29, toIndex: 34, type: 'Failure' },
    { fromIndex: 34, toIndex: 32, type: 'Success' },
    { fromIndex: 34, toIndex: 30, type: 'Failure' },
    { fromIndex: 30, toIndex: 32, type: 'Success' },
    // D-070: the AI switches (16), unreadable -> 17 marks it, the gate (11) decides
    { fromIndex: 32, toIndex: 16, type: 'Success' },
    { fromIndex: 16, toIndex: 10, type: 'Success' },
    { fromIndex: 16, toIndex: 17, type: 'Failure' },
    { fromIndex: 17, toIndex: 10, type: 'Success' },
    { fromIndex: 17, toIndex: 8, type: 'Failure' },
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
  // D-074: replies are saved on the requesting user (33 -> 9); without a user (no e-mail) nothing is written
  connections.push({ fromIndex: 7, toIndex: 33, type: 'Success' }, { fromIndex: 7, toIndex: 8, type: 'Failure' }, { fromIndex: 8, toIndex: 33, type: 'Success' }, { fromIndex: 33, toIndex: 9, type: 'Success' });
  // D-066: a parsed reply = one provider call that answered: metered on the keeper
  // D-074: after the reply is saved (9), not as a second link from Parse (a fan-out re-queues copies and delays the reply)
  connections.push({ fromIndex: 9, toIndex: 35, type: 'Success' }, { fromIndex: 35, toIndex: 13, type: 'True' }, { fromIndex: 13, toIndex: 14, type: 'Success' }, { fromIndex: 14, toIndex: 15, type: 'Success' });
  if (keeperChainId) connections.push({ fromIndex: 15, toIndex: KI, type: 'Success' });
  if (guardChainId) connections.push({ fromIndex: 0, toIndex: GI, type: 'False' });
  return { nodes, connections };
};

// Returns {log, dashboardId, storeId, ruleChainId, bundleId}. Throws on the first failing REST call.
window.DBB_DEPLOY = async function (opts) {
  const o = Object.assign({}, window.DBB_DEPLOY_DEFAULTS, opts || {});
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
  const keeperChain = (await all(`/api/ruleChains?textSearch=${encodeURIComponent('iMEX Licence keeper')}`)).find((x) => x.name === 'iMEX Licence keeper');
  // D-074: other store attribute changes go on to the role guard (App UI scripts/role-guard.mjs) when it is installed
  const guardChain = (await all(`/api/ruleChains?textSearch=${encodeURIComponent('iMEX Role guard')}`)).find((x) => x.name === 'iMEX Role guard');
  const { nodes, connections } = window.DBB_CHAT_CHAIN(o, keeperChain ? keeperChain.id.id : null, { guardChainId: guardChain ? guardChain.id.id : null });
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
  // D-070: store --UsesAppConfig--> the app's configuration asset (read by "Read AI switches": imexLlm, App UI U-097)
  const appCfg = await api('GET', `/api/tenant/assets?assetName=${encodeURIComponent(o.appConfigName)}`, undefined, true);
  if (appCfg) {
    const rel2 = { from: store.id, to: appCfg.id, type: 'UsesAppConfig', typeGroup: 'COMMON' };
    await api('POST', '/api/v2/relation', rel2).catch(() => api('POST', '/api/relation', rel2));
    say(`store linked to ${o.appConfigName} (AI switches)`);
  } else say(`NOTE: no asset "${o.appConfigName}": the chat answers "could not read the AI switches" until it exists and the store is linked to it`);

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
