# Handoff to Claude Code: iMEX Self-Service Dashboards (Dashboard Builder)

Written 5 Oct 2026 at the end of the Cowork session. Read this whole file before doing anything. Then read `DECISIONS.md` (the full history, D-001 to D-034), `README.md` and `docs/DEVELOPER_GUIDE.md` in this repo.

---

## 0. Your first job, in one paragraph

Deploy the latest Dashboard Builder (commit `af9c6fe`, D-034) to **Akshay's local ThingsBoard (Docker on his PC)**. The **iMEX Self-Service Reports** app (In-App Reports) already uses that instance, and both apps must work on the **same customer, assets, devices and users**. Nothing Reports depends on may be changed or deleted.

Order: discover → back up → plan → **get Akshay's OK** → deploy → verify both apps → record. Details are in section 6. After that, Akshay will ask for further changes on the local instance; the workflow is in section 9.

---

## 1. Who you work with and how

- **Akshay R.**, PM and IIoT Practice Lead at ITHENA Technologies (Pune). He owns iMEX / iSERV PM, a ThingsBoard CE-based industrial IoT app.
- **Style he asked for:** direct and practical. No flattery, no filler, no "great question". If an idea is flawed, say so and explain why. Treat him as a smart adult.
- He commits and pushes from his PC. Commit locally, but **push only when he asks**.
- Commit message footer used so far: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **Standing instruction:** every change gets an entry in `DECISIONS.md` (next number **D-072**) with what, why, files and tests.
  - In Cowork there was also a change-log row in the Claude Doc "New widget instructions" (https://claude.ai/code/artifact/1a25e5dc-f57e-49a6-9325-c1e5369bbd8f). You can't edit that doc from Claude Code.
  - Keep `docs/CHANGELOG.md` instead (create it): date, commit, change, file:line, newest first. Tell Akshay when the Claude Doc needs the same rows; he can paste them or ask a Cowork session.

---

## 2. Hard rules (carried over; do not relax without Akshay saying so)

1. **iserv-demov2.ithena.app (his staging app): do not touch it.** No reads, no logins, no changes. User instruction, 2 Oct.
2. **Credentials:**
   - Never type, print, log or commit passwords, JWTs or API keys.
   - ThingsBoard tenant credentials go in `.env` (git-ignored), filled by Akshay himself.
   - Scripts read `.env`; you don't `cat` it or echo values.
   - If a step needs a credential you don't have, ask him to put it in `.env`.
3. **The LLM API key** lives only on the tenant-owned asset `DBB-LLM-CONFIG` (attribute `dbb_llm_api_key`).
   - Never assign that asset to a customer.
   - Never copy the key anywhere else, and never echo it.
   - Don't enable debug mode on the chat relay rule chain's nodes: debug events would store the key in metadata.
4. **No tenant credentials in widgets.** Everything the widgets do runs with the logged-in user's own JWT.
5. **Never run `npm run teardown` or `scripts/lib/teardown.ts` on the local instance.** It deletes every POC-marked entity. Reports may now depend on those devices, assets and users.
6. **Don't run `setup:tb`, `backfill` or `simulator` on the local instance without asking.** They create or extend sample devices and telemetry that Reports would also see.
7. **Only change what is ours** (section 5, "Our footprint"). Anything else on the local instance (Reports' dashboards, widgets, rule chains, attributes, the root rule chain, device profiles) is read-only unless Akshay explicitly asks.
8. Don't obtain or use customer-user tokens (e.g. `/api/user/{id}/token`) without asking. For testing as a customer user, ask Akshay to log in, or to create a test user himself.
9. **Back up before you overwrite.** Export any dashboard, rule chain, widget bundle or attribute you are about to change to `backups/<date>/` (git-ignored) first.

---

## 3. What the product is

Self-service dashboards inside the iMEX app, built entirely as **ThingsBoard CE custom widgets**. There is no external service. The only external dependency is an LLM API (Claude, OpenAI or Gemini).

- **Admins** (user attribute `Role` = Admin) open the **Dashboard Builder** from a pencil icon in the app navbar. They can:
  - drag and drop up to 10 widgets from 19 types;
  - bind each to "this machine", specific machines (up to 4), same-type machines at a location, the nearest machine of a type, or all machines of a type under a location;
  - style it (themes, per-widget styles, colour rules);
  - build or change it through **chat** with an LLM.
- Saving stores the layout on a per-customer **DashboardStore** asset. **Apply** assigns it to one machine, the machines of a type under a location, or customer-wide. The **machine page** then shows the assigned dashboard.
- **Standalone/overview dashboards** (not tied to one machine) open from the **Dashboard list**, in the state `dashboard_overview`.
- Everyone else views only. Scope = user attribute `selectedNodes` (the production format). It is enforced in the UI only; ThingsBoard CE has no attribute-level access control (D-012).

### Three widget types (one bundle "iMEX Self-Service (POC)", alias `imex_dbb`)

| Widget type fqn | Name | Where it goes | Job |
|---|---|---|---|
| `tenant.imex_dbb_launcher` | iMEX Navbar / edit menu | app header state | pencil icon + menu (Edit, Customise, Reset, Thresholds, Show dashboard switcher, Dashboard list, New dashboard, Dashboard Builder); optional stand-in navbar |
| `tenant.imex_dbb_renderer` | iMEX Machine dashboard | machine state and `dashboard_overview` state | renders the resolved dashboard for the state entity, or a standalone one (`dbbDashboardId` state param) |
| `tenant.imex_dbb_listing` | iMEX listing | listing state (optional) | listing page helper |

Each widget type embeds its **own copy** of the library (IIFE `IMEX_DBB`). That is why some cross-widget communication goes through `window` (`__imexDbbActions`, `__imexDbbPlacement`, the events `imex-dbb:changed` and `imex-dbb:actions`).

### Chat relay (rule chain "DBB Chat relay (POC)")

1. The builder writes `dbb_chat_req` (SERVER_SCOPE) on the store asset.
2. The DashboardStore asset profile's **default rule chain** is the relay, so only store messages enter it. The nodes are:
   - Is chat request
   - Read LLM settings: related attributes over the relation `UsesLlmConfig` from the store to `DBB-LLM-CONFIG`
   - Build LLM request: the provider is picked from the key prefix (`sk-ant-` → Claude, `AIza`/`AQ.` → Gemini, other `sk-` → OpenAI)
   - Pick provider
   - Call Claude / OpenAI / Gemini: REST nodes, key substituted from metadata as `${llmKey}`
   - Parse LLM reply / Error reply
   - Save reply attribute: `dbb_chat_resp_<userId>`
3. The TBEL scripts are in `widgets/deploy/relay/*.tbel`, generated by `export-scripts.mjs` from `deploy-browser.js`.
4. Default models: `claude-sonnet-5`, `chat-latest`, `gemini-flash-latest`. Per-provider overrides are the attributes `dbb_llm_model_{anthropic,openai,gemini}` on DBB-LLM-CONFIG.

### Where data lives (all SERVER_SCOPE attributes, JSON)

| Entity | Keys |
|---|---|
| DashboardStore asset (one per customer, assigned to that customer) | `dbb_d_<id>` (layout), `dbb_h_<id>` (last 10 versions), `dbb_vis_<id>`, `dbb_assign_customer`, `dbb_assign_rev`, `dbb_profile_keys` (property catalogue), `dbb_lib_version`, `dbb_chat_req`, `dbb_chat_resp_<userId>`, `dbb_audit` (time series), `poc=true` |
| Site / plant / line asset | `dbb_assign` `{profile: {dashboardId, by, at}}` |
| Device | `dbb_assign` (this machine / copy / customised); `thr_*` alarm thresholds (read by device-profile alarm rules) |
| User | `Role`, `selectedNodes` (production format; Reports probably uses the same; verify), `dbb_personal` |
| `DBB-LLM-CONFIG` (tenant-owned, never customer-assigned) | `dbb_llm_api_key`, `dbb_llm_model_*` |

Resolution order for a machine: personal → device → nearest ancestor location → customer-wide → built-in default layout (`widgets/src/core/store.ts` `resolveForDevice`).

---

## 4. Repo, state and tooling

- **Local repo (use this one):** `D:\Claude Code\iMEX Self Service\imex-repo`. Git `main` at `af9c6fe` (D-034), pushed to `origin` = https://github.com/AkshayR25/-iMEX-Self-Service-Dashboard. The working tree matched the Cowork session byte-for-byte (ignoring CRLF) on 5 Oct.
  - The parent folder `D:\Claude Code\iMEX Self Service\` also holds an **older copy** of the sources (scripts, widgets, docs, `imex-selfservice.bundle`, `_ignore.zip`) from before the repo existed. **Ignore it.**
  - The `Claude outputs` subfolder holds screenshots and the LLM-key brief for Reports (section 8).
- **Windows notes:**
  - Path with spaces: quote it.
  - `git status` may show many files as modified with no real change; these are CRLF-only differences. Check with `git diff --ignore-cr-at-eol --stat` (it was empty). Consider `git config core.autocrlf true`, or add a `.gitattributes` (`* text=auto eol=lf`) after asking.
- **Node ≥ 20.** Run `npm install` first. Then:
  - `npm run typecheck`
  - `npm test`: 93 unit tests with vitest against an in-memory fake ThingsBoard (`widgets/test/fake-tb.ts`)
  - `npm run build:widgets`: writes `widgets/dist/imex-dbb.js`, `glue.json`, and `widget-types/imex_dbb_{launcher,renderer,listing}.json` (importable widget types)
  - `npm run test:e2e`: 66 Playwright scenarios against `widgets/harness`, a fake ThingsBoard page with a stub chat relay; takes about 5 minutes. A failed test writes a screenshot `e2e-fail-*.png` to the temp folder. A subset: `node widgets/e2e/builder.e2e.mjs <words in test name>`.
    - The e2e and bench scripts try the Linux Chromium path `/opt/pw-browsers/...` first and fall back to `chromium.launch()`. On Windows run `npx playwright install chromium` once.
  - `node widgets/e2e/bench.mjs 5 60`: load test (D-028).
- **Harness test globals:** `window.__b` (builder instance, when `?page=builder`), `__tb` (fake TB), `__chatQueue` (stub LLM answers), `__urlSwitch(dev)`, `__builderTop`, `__setPlacement`, `__measureHeaderTop`, `?bench=1`.
- **Code map:** `widgets/src`
  - `core/`: api (REST, in-flight dedupe, data clock), live (WebSocket), scope (user context), store (save/apply/resolve), chat (prompt, ops, validation), schema (zod), compat (property kind vs widget type), design (design pass), audit
  - `render/`: theme, charts, widgets, grid, rules, rich
  - `builder/`: builder, controls (section cards, searchable picker), editors, styles, ui
  - `entries/`: launcher, renderer, listing, common
  - **Line references for every recent change are in `DECISIONS.md` (D-028 to D-034).**
- **Deployed elsewhere (for reference only):**
  - demo.thingsboard.io (shared public demo, POC entities only), as of D-022/D-028; the relay there has pre-D-028 scripts.
  - Ids: app dashboard `d38a7f00-ba38-11f1-b620-2ff6df252135`, store `DBB-STORE-ITHENA` `95ef9f40-ba38-11f1-b620-2ff6df252135`, relay `94784180-ba38-11f1-b620-2ff6df252135`, DBB-LLM-CONFIG `0a0788d0-ba97-11f1-b620-2ff6df252135`, bundle `96aa8ad0-ba38-11f1-b620-2ff6df252135`, customer ITHENA `07337440-b8b5-11f1-9681-6110e8f55c0f`.
  - You don't need demo.thingsboard.io now. If you ever touch it, only modify or delete entities marked `poc=true` / `[poc=true]`.

---

## 5. Our footprint on a ThingsBoard tenant (what the deploy creates or changes)

`widgets/deploy/deploy-browser.js` → `DBB_DEPLOY(opts)` is idempotent: it matches by name/fqn and updates in place.

| # | Thing | Name / key | Notes and risks |
|---|---|---|---|
| 1 | Customer | `opts.customerTitle` | Must already exist; looked up only. |
| 2 | Rule chain | `DBB Chat relay (POC)` | **All its nodes and connections are rewritten** on every run. Not the root chain. |
| 3 | Asset profile | `DashboardStore` | Must carry `[poc=true]` in its description, or the deploy throws. Its default rule chain is set to the relay. |
| 4 | Store asset | `opts.storeName` (e.g. `DBB-STORE-ITHENA`) | Created if missing and assigned to the customer. Writes `poc=true`, `dbb_lib_version`, and **`dbb_profile_keys` = `opts.profileKeys`, which OVERWRITES it. The default `{}` wipes the catalogue; always pass the existing one (read it first) or a fuller one.** |
| 5 | LLM config asset | `DBB-LLM-CONFIG` | Tenant-owned. The deploy throws if it is customer-assigned. Model defaults are written only when missing; the key is never overwritten. Relation store → config `UsesLlmConfig`. |
| 6 | Widget bundle and types | bundle `iMEX Self-Service (POC)`; types `tenant.imex_dbb_launcher/renderer/listing` | **The bundle's widget list is set to exactly these three.** If Reports put its own widget types into this bundle, they would be dropped from the bundle (the types themselves remain). Check first. |
| 7 | Stand-in app dashboard | `opts.appTitle`, default `iMEX App (POC)` | **Its whole configuration is replaced** (states default/listing/machine/dashboard_overview, our navbar and body widgets), then it is assigned to the customer. **Biggest risk:** if Reports added its widgets or states to a dashboard with this title, they would be wiped. See 6.4. |
| 8 | Home dashboards | users in `opts.userEmails` | Sets their home dashboard to the stand-in. Pass `[]` on the local instance. |

Production integration (instead of the stand-in): put the renderer widget into the app's own machine state and a `dashboard_overview` state, and either our launcher widget in the header or the app's own navbar calling `IMEX_DBB.launcher.open(ctx, {deviceId})` / `.dashboardList(ctx, isAdmin)`. See README "Put the button in your real app" and D-030 to D-034.

What we found in Akshay's real app on iserv-demov2 (do not go there; for context only):
- Its navbar widget `tenant.navbar2` embeds its own IMEX_DBB copy and calls `elevateOverlayZIndex()`, which raises the builder overlay to z-index 300000. Advice given: remove it, bind `dbbEditBtn` by delegation on `self.ctx.$container`, and keep all widget types on one build.
- The local instance may have a copy of that app. Check.

---

## 6. TASK 1: deploy D-034 to the local ThingsBoard without breaking Reports

### 6.1 Find the local ThingsBoard

- `docker ps` shows the TB container and its port mapping. Usually http://localhost:8080 for `thingsboard/tb-postgres` / `tb-node`; confirm.
- Ask Akshay to create `.env` from `.env.example` (in the repo root) with `TB_URL=http://localhost:<port>`, `TB_TENANT_USERNAME`, `TB_TENANT_PASSWORD`, and `TB_MIN_DELAY_MS=0` (local, no rate limit).
  - Use the **tenant admin** of the tenant that Reports uses. Ask which one if there are several.
  - Don't read the file aloud.
- `GET /api/system/info` or the UI footer: note the TB version (the demo was 4.x; rule-node config versions in the deploy assume 4.x).
- `scripts/lib/env.ts` → `tenantClient()` logs in with `.env`. Reuse it for every script you write (read-only inventory, deploy wrapper).

### 6.2 Learn what Reports uses (read-only)

- Reports repo: https://github.com/AkshayR25/iMEX-InApp-Reports. **Ask Akshay for its local path** (it is not inside `D:\Claude Code\iMEX Self Service`). Read its README, config/.env.example (not real secrets), deploy/setup scripts and the TB calls in its code.
- What we know:
  - "Self-Service Reports": a Reports icon in the iMEX navbar, a report configurator, scheduling and delivery, all in the TB app, powered by an **external Python service**;
  - v1 is PDF only, delivered by email and download;
  - shown to every user for now;
  - iMEX roles (Admin / Normal user) come from user attributes, not TB roles;
  - its AI summary uses an LLM. Akshay wants it to reuse `DBB-LLM-CONFIG` (section 8).
- List its ThingsBoard footprint:
  - dashboards and states;
  - widget bundles and types (fqns), and which navbar widget it uses or extends;
  - rule chains (and whether it changed the root chain or any profile's default chain);
  - asset and device profiles;
  - the attributes it reads or writes (names, scope, entity);
  - the users and customer it relies on;
  - the TB user or token the Python service authenticates with.

### 6.3 Inventory the local instance (read-only script)

Write `scripts/inventory-local.ts` (read-only, uses `tenantClient()`). Output `docs/local-tb-inventory.md` (no secrets) with:
- tenant, TB version;
- customers;
- asset profiles and device profiles, with their default rule chains;
- assets and devices per customer (name, profile, `poc` flag), and the `Contains` hierarchy;
- users per customer with `Role` and `selectedNodes` present (yes/no, root names only);
- dashboards: title, assigned customers, state ids, the fqns of widgets used per state;
- widget bundles and their widget types;
- rule chains, including the root one and its node count;
- everything named `DBB-*` or `DashboardStore`, `dbb_*` attributes on the store (keys only, sizes), `dbb_lib_version`;
- whether `DBB-LLM-CONFIG` exists and is tenant-owned (don't print the key; just "set / empty").

Then fill a **collision table**: each row of section 5 against what Reports uses. Typical conflicts to look for:
- a dashboard titled `iMEX App (POC)` that Reports extended;
- Reports widgets inside the bundle `iMEX Self-Service (POC)`;
- an existing `DashboardStore` profile without the marker;
- the customer title to use;
- `Role` / `selectedNodes` formats;
- the navbar in use (ours, navbar2, or Reports');
- whether the local instance was set up from our `setup:tb` (customer ITHENA, devices RIC-COMP-01 etc., `poc=true`).

### 6.4 Plan, back up, ask

- Back up everything you will touch: export JSON for the dashboards (`GET /api/dashboard/{id}`), the relay rule chain (`/api/ruleChain/{id}` + `/metadata`), the widget bundle and types, and the store asset's `dbb_*` attributes. Save under `backups/<yyyy-mm-dd>/` and add `backups/` to `.gitignore`.
- **Decide the stand-in dashboard question:**
  - If `iMEX App (POC)` exists and contains anything that isn't ours (another widget fqn, another state, Reports' navbar icon), **do not let the deploy overwrite it**.
  - Add an option `skipAppDashboard: true` to `DBB_DEPLOY` that skips steps 5 and 6 (small code change; keep `export-scripts.mjs` and the docs in sync).
  - Then integrate our widgets into that dashboard **by editing its JSON surgically**: add or replace only our widget instances and the `dashboard_overview` state; keep everything else byte-identical. Diff against the backup before saving.
  - If the dashboard is purely ours (only `tenant.imex_dbb_*` widgets), a normal deploy is fine.
- `profileKeys`: read the current `dbb_profile_keys` from the store (if any) and pass it unchanged, or extend it with the local device profiles' keys (display names, units).
  - `widgets/deploy/profile-keys-draft.js` (a browser-console script; port it to Node like the deploy) builds a draft from the keys devices actually report.
  - Show Akshay the catalogue before writing it.
- Write the plan: exact steps, what changes, what is untouched, and rollback (restore from the backups). **Show it to Akshay and wait for his OK.**

### 6.5 Deploy

- `npm run typecheck && npm test && npm run build:widgets` (and `npm run test:e2e` if any code changed).
- Run the deploy from Node instead of a browser console. Write `widgets/deploy/deploy-node.mjs`:
  - load `.env` (`dotenv`) and log in with `POST {TB_URL}/api/auth/login`, keeping the JWT only in memory;
  - set `globalThis.window = globalThis` and `globalThis.localStorage = { getItem: k => k === 'jwt_token' ? jwt : null }`;
  - wrap `fetch` so that relative paths (`/api/...`) are prefixed with `TB_URL`;
  - set `window.__dbbLib` to the text of `widgets/dist/imex-dbb.js`, and `window.__dbbGlue` to the parsed `widgets/dist/glue.json`;
  - `await import('./deploy-browser.js')` (it only assigns `window.DBB_DEPLOY`, with no DOM use);
  - `await window.DBB_DEPLOY(opts)`, with opts read from a git-ignored `deploy.local.json`: customerTitle, storeName, profileKeys, userEmails `[]`, skipAppDashboard;
  - print the returned `log`, never the JWT.
  - Alternative: Akshay pastes `deploy-browser.js` into a logged-in tenant-admin page's console (README section "One-time setup").
- If the local tenant has no `DBB-LLM-CONFIG` key yet, chat will answer "No LLM API key is set". Akshay sets `dbb_llm_api_key` himself in the UI. You never handle the key.
- Users:
  - Admins need user attribute `Role` = `Admin` (or `Customer Admin` / `Administrator`, or `dbbAdmin=true`).
  - Everyone needs `selectedNodes` in the production format (`[{"ID":..,"name":..,"categoryId":..,"entityId":"<asset uuid>"}]`).
  - If Reports already sets these, reuse them; don't overwrite user attributes without asking.
  - A tenant admin opening the app gets admin mode with the customer from the launcher setting `customerId` (D-018).

### 6.6 Verify both apps

**Dashboard Builder:**
- The pencil menu opens; the builder opens **below the navbar** from every entry point (menu, machine-page Edit / Customise, Dashboard list Edit). This is D-030 to D-034; check it works with the navbar actually in use on the local app.
- Build a dashboard named `ZZ-TEST …`, save it, apply it to one machine; the machine page renders it with the same values as REST latest.
- "Time window" and "Updated x ago" show in the header; the Dashboard list works (including machine types); chat works if a key is set.
- Delete your `ZZ-TEST` dashboards afterwards.

**Reports (unchanged):**
- Run its own tests and a manual report generation for a device and asset the Builder also uses.
- The Reports navbar icon is still there; its scheduled jobs still list; its Python service still authenticates and reads the same entities.

**No collateral changes:** re-run the inventory and diff it against the pre-deploy inventory.
- Expected changes only: our rule chain, profile, store, config asset, bundle/types, and (if agreed) our widgets/states in the app dashboard.
- The root rule chain, Reports' rule chains, device profiles, devices and users must be unchanged.

### 6.7 Record

- Add `DECISIONS.md` **D-035** "Local deployment alongside Self-Service Reports": the footprint table, decisions (stand-in or integrated dashboard, `skipAppDashboard`), how to redeploy, and verification results.
- Update the README / DEVELOPER_GUIDE deploy sections if you added `deploy-node.mjs` or new options.
- Add a `docs/CHANGELOG.md` row.
- Commit; push only when asked.

---

## 7. Open items and history worth knowing

- **Not deployed anywhere yet:** D-023 to D-034 on Akshay's real app. The local instance is the first target now.
- **The Gemini free tier** hit capacity before; prefer a paid or Claude/OpenAI key.
- **Prompt caching for the chat relay: ON HOLD** (Akshay, 4 Oct). For when he resumes it:
  - put an explicit `cache_control` on the system block in the Anthropic branch of "Build LLM request": `system: [{type:"text", text: b.system, cache_control:{type:"ephemeral"}}]`;
  - don't use top-level automatic caching, because the last message (draft JSON + question) changes every turn;
  - verify with `usage.cache_read_input_tokens > 0` on the 2nd message;
  - OpenAI and Gemini cache automatically.
- **Accepted security residuals (D-028 / D-012):**
  - customer users can write attributes through REST (CE has no attribute ACL);
  - chat request and response attributes are readable by that customer's users;
  - there is no server-side chat rate limit (browser limit of 30 per hour per user).
- **ThingsBoard quirks:** see the end of `DECISIONS.md`. Examples:
  - telemetry without `limit` returns at most 100 points;
  - name lookups return 404 instead of an empty list;
  - TBEL: `function` is a keyword, so use `obj["function"]`, and a ternary inside a map literal is mis-parsed;
  - test TBEL with `POST /api/ruleChain/testScript?scriptLang=TBEL`.

---

## 8. Shared LLM key with Self-Service Reports

Akshay wants Reports' AI summary to use the **same key**, so it is maintained in one place.
- Brief and code are in `D:\Claude Code\iMEX Self Service\Claude outputs\llm-key-handover.md` and `shared_llm.py`.
- `shared_llm.py` reads `DBB-LLM-CONFIG` with a tenant-admin token, detects the provider from the key prefix and calls it. It is tested offline with mocks only.
- If Akshay asks you to wire it into Reports:
  - follow that brief;
  - don't rename the `dbb_llm_*` attributes; add `rpt_*` ones if Reports needs its own settings;
  - the key never goes to the browser.

---

## 9. Workflow for every further change

1. Read the relevant DECISIONS entries and code (line references are in D-028 to D-034).
2. Change the code. Add unit tests (`widgets/test`) and e2e scenarios (`widgets/e2e/builder.e2e.mjs`) for the new behaviour.
3. `npm run typecheck && npm test && npm run test:e2e`, all green, then `npm run build:widgets`.
4. Deploy to local:
   - widgets only: re-run the deploy with the agreed options, or import the 3 JSON files from `widgets/dist/widget-types/` in the UI;
   - relay script changes need the deploy (it rewrites the chain), or a paste of `widgets/deploy/relay/*.tbel` into the matching nodes.
5. Verify in the local app as in 6.6, including that Reports still works.
6. `DECISIONS.md` entry (D-0xx), `docs/CHANGELOG.md` row (commit, change, file:line), README/DEVELOPER_GUIDE test counts if they changed. Commit.
7. Tell Akshay in one or two sentences what changed, plus the push commands if he wants to push.

UI conventions from his feedback (keep to them):
- builder components are self-contained: own class prefixes, `all: unset` resets, Inter on every element, no reliance on native label/radio/select or `::before`/`::after`, because host CSS breaks them (D-031, D-033);
- match the app's look: text-only menus, light cyan hover, dark left bar for the selected item;
- searchable pickers instead of long radio lists;
- section cards in side panels;
- the builder opens below the navbar, never full screen (setting `builderTop` = auto).
