# DECISIONS

Assumptions, deviations from *iMEX Self-Service Configuration POC — Build Instructions* (25 Sep 2026), and ThingsBoard quirks found.

## Environment

- **ThingsBoard:** `https://demo.thingsboard.io`, **CE 4.3.0.3DEMO** (from `/api/system/info`). Shared public server, so all data is fictional.
- REST paths were checked against `/v3/api-docs` on the instance before use.
- The tenant already contains ThingsBoard's own demo entities (33 devices, customers A/B/C and others). The POC never touches them because everything we create carries `poc=true`.

## Decisions

### D-001 Phase 1 scripts run in the browser, from the same code
The build agent's cloud workspace can't reach demo.thingsboard.io (blocked by the org's network policy), and it can't run commands on the user's PC. So Phase 1 was run inside the logged-in ThingsBoard page:

- `npm run build:browser` bundles `scripts/lib/*` into `scripts/output/poc-browser.js`.
- The bundle uses that page's tenant-admin JWT (`localStorage.jwt_token`), so no password was typed or stored by the agent.

The Node entry points (`npm run setup:tb`, `backfill`, `simulator`, `teardown`) run the same library code with `.env` credentials, and are the intended way to run from Phase 2 on.

A consequence: **the live simulator currently runs inside a browser tab.** It stops if that tab reloads. For anything longer-lived, run `npm run simulator` on a PC.

### D-002 No ThingsBoard customer users — SUPERSEDED by D-010
*Kept for history. The user decided against an external service, so app users are ThingsBoard customer users after all (D-010). The risk described here is real and is now handled as described in D-012.*

In CE, a customer user can log in to the ThingsBoard UI or REST API directly. From there they see every device assigned to the customer and can act on alarms, which bypasses our node scope, our role permissions and our audit log. That breaks proofs 4 and 5.

So app users live only in the config service's own database (password hashes, roles, scopes), and the service uses the tenant service account for every ThingsBoard call.

- The three sample users are listed in `scripts/lib/model.ts` (`APP_USERS`). They are seeded into SQLite in Phase 2, with local one-time activation links instead of ThingsBoard activation links.
- This also drops "keep the user's ThingsBoard JWT server-side" from 5.1, because there isn't one.

### D-003 Alarm rules: dynamic threshold, clear rule, propagation
- **Create rule:** `key > threshold`. The threshold is a dynamic value from the device's **server attribute** `thr_*` (source `CURRENT_DEVICE`, no inherit), with the spec default used when the attribute is missing.
- **Clear rule (added; missing from the spec):** `key <= same threshold`. Without a clear rule, device-profile alarms never clear.
- **Propagation:** alarms propagate up `Contains` relations, so site and root assets also see them (useful for Map marker colours). Propagation to owner and tenant is off.
- ThingsBoard 4.3 also offers alarm rules as `ALARM` calculated fields. We kept device-profile rules because the root rule chain on this tenant still has the Device Profile node. Revisit if the target production version drops profile alarms.

### D-004 Backfill via the tenant REST API, not the device API
The backfill posts to `POST /api/plugins/telemetry/DEVICE/{id}/timeseries/ANY`, in batches of 200 with a 1 s pause. That endpoint saves directly, without the rule engine, so history doesn't create alarms. The generator also never exceeds thresholds during backfill (covered by unit tests).

- The backfill ends 10 minutes before "now", so live data owns the latest values.
- The live simulator uses the device transport API (`/api/v1/{token}/telemetry`), which goes through the rule engine and profile alarm rules.

### D-005 POC marker on profiles
Asset and device profiles can't hold attributes. They carry `[poc=true]` in their description instead. Setup refuses to reuse a same-named profile without the marker, and teardown only deletes profiles that have it.

### D-006 Setup refuses to adopt non-POC entities
If an asset, device or customer with a POC name exists without `poc=true`, setup stops with an error rather than reusing or modifying it.

### D-007 Thresholds are only defaulted when missing
On rerun, setup writes `thr_*` attributes only if they are absent. Thresholds a customer edited are not reset.

### D-008 `setup-result.json` holds IDs only
It contains no credentials. The simulator reads access tokens from ThingsBoard at start-up.

### D-009 SQLite seeding moves to Phase 2 — SUPERSEDED by D-010
*There is no SQLite and no service; all state lives in ThingsBoard attributes.*

Spec 4.1 step 8 seeds SQLite during setup. The service schema doesn't exist until Phase 2, so the service will seed itself on first start from `setup-result.json` and `model.ts`.

### D-010 No external service: everything runs as ThingsBoard widgets (user decision, 26 Sep 2026)
The build instructions describe a Node config service plus a React app. The user asked for no service outside ThingsBoard. So:

- The Dashboard Builder, the machine dashboard renderer and a stand-in app listing are **three custom ThingsBoard widgets** (`tenant.imex_dbb_launcher`, `imex_dbb_renderer`, `imex_dbb_listing`) in the bundle "iMEX Self-Service (POC)".
- They are plain TypeScript + DOM + SVG (no framework), bundled by esbuild into one IIFE (`widgets/dist/imex-dbb.js`, about 190 KB) that is embedded in each widget type's controller script.
- The widgets call the ThingsBoard REST API **with the logged-in user's own JWT**. No tenant credentials exist anywhere in the widgets.
- App users are ordinary ThingsBoard **customer users**. Their scope and role come from their existing user attributes (D-011).

### D-011 Scope and role come from the existing user attributes
Matches the production app's user attributes (screenshots from the user, 26 Sep 2026):

- `selectedNodes`: a JSON list of `{entityId, name, ...}`. `entityId` may be a string or `{id, entityType}`, and the name is used as a fallback. The user's scope is these nodes plus everything below them via `Contains` relations.
- `Role`: `Admin` (also `Customer Admin`, `Administrator`, or the attribute `dbbAdmin=true`) may apply a dashboard to several machines, a location or the whole customer. Any other role may only change their own view or the one machine they are editing, and only if that machine is in scope.
- "Customer-wide" is only offered to admins whose scope nodes are top-level (they have no parent asset). A site-scoped admin gets "all machines under a location" instead.
- **Superseded by D-050.** Scope = the `imexAccess` grants (`selectedNodes` only while it is absent), resolved by the shared access core. What a user may do = the role: `imexRole` in the customer's `imexRoles`, with the legacy `Role` / `dbbAdmin` mapping only without it. "Customer-wide" needs `coversAll` (every top an 'all' grant).

### D-012 Security model in CE, and what it does not protect
Checked live on demo.thingsboard.io with a real customer user:

| Customer user can | Result |
|---|---|
| Read telemetry and attributes of every device and asset assigned to the customer | yes (so scope is **UI-enforced only**) |
| Write SERVER/SHARED attributes on those devices and assets, and on their own user | yes |
| Write customer attributes | no (403) |
| Create assets or dashboards | no (403) |
| Read or write other users' attributes | no (403) |

Consequences:

- Dashboards are stored as attributes on one **DashboardStore asset per customer**, which is assigned to the customer (customers can't write customer attributes).
- Admin-only actions (apply to many machines) are **enforced in the widget only**. A user with the browser console and REST knowledge could write `dbb_assign` on any device of their customer. This is the same trust boundary as the existing app: CE has no per-user entity permissions. PE's role-based permissions or a rule-chain validator would close it. Out of scope for the POC; call it out before production.
- Every save and apply writes an audit entry (`dbb_audit` timeseries on the store asset: who, what, when, affected machines).
- **D-050:** the same holds for the new access (`imexAccess`) and role (`imexRole`, `imexRoles`) attributes. The Builder, the app and the services apply them; ThingsBoard CE does not.

### D-013 Storage model
| Where | Key | Content |
|---|---|---|
| Store asset | `dbb_d_<id>` | dashboard JSON (versioned; optimistic concurrency by `version`) |
| Store asset | `dbb_h_<id>` | last 10 versions, for History/restore |
| Store asset | `dbb_assign_customer` | `{profile: {dashboardId, by, at}}` customer-wide defaults |
| Store asset | `dbb_profile_keys` | per profile: key, display name, unit, decimals (the catalogue for the builder and the LLM) |
| Store asset | `dbb_chat_req`, `dbb_chat_resp_<userId>` | chat relay request and responses |
| Asset (site/plant/line) | `dbb_assign` | `{profile: {dashboardId, by, at}}` for all machines of that type below it |
| Device | `dbb_assign` | `{dashboardId, mode: linked\|copy\|customised}` |
| User | `dbb_personal` | `{deviceId: dashboardId}` personal views |

A machine shows the first match of: personal → device → nearest ancestor location → customer-wide → built-in default layout. The renderer header says which one ("From: All Compressor machines") and offers a switcher between all that apply.

### D-014 Chat goes through a rule chain, not the browser
*Provider choice and key location changed in D-021: the key is now on the tenant-owned asset DBB-LLM-CONFIG, and Claude, OpenAI and Gemini are supported.*

The browser can't hold the Anthropic API key safely, and there is no service. So:

1. The builder writes `dbb_chat_req` (catalogue, masked entity names, conversation) to the store asset.
2. Rule chain **"DBB Chat relay (POC)"** (default chain of the DashboardStore asset profile) filters that update, builds the Messages API request, calls `https://api.anthropic.com/v1/messages` with the key held in the **"Call LLM" REST node header** `x-api-key`, and writes `dbb_chat_resp_<userId>` back.
3. The widget polls that attribute for up to 30 s.

- The model returns operations through one tool (`dashboard_ops`). They are validated with Zod, retried once with the validation errors, then auto-laid-out. The user sees a summary and can undo.
- Entity names are replaced by aliases (D1, N1…). Machines outside the user's scope are sent as `OUTSIDE_ACCESS` and can't be referenced.
- Limit: 30 chat requests per user per hour (browser-side).
- The API key is **not set by the agent**. Paste it into the "Call LLM" node (Rule chains → DBB Chat relay (POC) → Call LLM → Headers → `x-api-key`). Until then chat answers "The LLM API key … is missing or invalid."

### D-015 Non-admins can't overwrite a shared dashboard
If a non-admin edits a dashboard that is linked to more than one machine, or that comes from a location/customer assignment, Save offers **Save as copy** instead. The copy can then be applied to "only me" or to the one machine being edited.

### D-016 Deployment into ThingsBoard
`widgets/deploy/deploy-browser.js` defines `DBB_DEPLOY()` for a tenant-admin page. It idempotently creates or updates the rule chain (keeping an existing API key), the DashboardStore profile and store asset, the widget bundle and the 3 widget types, and the stand-in dashboard "iMEX App (POC)", and it sets that as the home dashboard of the listed users. Teardown (`scripts/lib/teardown.ts`) now also removes these.

### D-017 Scope alignment, 27 Sep 2026 (user decision): admin-only builder, view-only users
- **Navigation of the stand-in app:** Map page (title + button, placeholder for a real map) → Machines listing (hierarchy tree + machine cards) → machine page. The navbar has Map and Machines links and a breadcrumb.
- **Dashboard Builder button:** only users with `Role` = Admin see it (`adminOnly` setting, on by default). The builder also refuses to open for non-admins. Both checks are UI-level (D-012).
- **Everyone else views only:** no Edit, no source chip, no switcher, no personal views, no Customise/Reset/Thresholds.
- **Save → apply:** after saving, the admin is asked "Only <this machine>" or "All <type> machines" (customer-wide when the admin's scope is the whole customer, otherwise every machine of that type in their scope), or "Don't apply now".
- **"Saved as a state"** means the per-machine layout stored in attributes and shown in the app's single `machine` state. Real ThingsBoard dashboard states can't be written by customer users (403), and writing them from a rule chain would need tenant credentials.
- Personal views (D-013's `dbb_personal`) are still resolved if present, but nothing in the UI creates them any more.
- **D-050:** "Admin" here is now the role's actions: `dashboards.build` (the button, the builder, the machine page's edit items), `dashboards.applyMany` ("All <type> machines") and `dashboards.deleteAny`. The `adminOnly` setting is a no-op. Customer-wide needs `coversAll`.

### D-018 Three dashboard states, 27 Sep 2026 (user decision)
- The dashboard "iMEX App (POC)" has three real ThingsBoard states: `default` = **Map page** (site cards for Pune and Richmond, plus one button to the listing), `listing` = **Listing page** (clickable hierarchy on the left, machine cards in the centre), and `machine` = **Machine page** (the per-machine dashboard).
- Clicking a site on the Map page opens the Listing page with that site selected. Clicking a machine in the tree or on a card opens the Machine page.
- The navbar shows the current state's name. The navbar widget isn't notified of state changes, so it reads the `state` URL parameter every 500 ms.
- Tenant-admin mode: when a tenant admin opens the dashboard, the widgets use the `customerId` setting and treat the customer's top-level assets as roots, with `isAdmin = true`. This lets the owner view and edit without a customer login. It is UI-only, like D-012.

### D-019 Richer UI, rules, rich text, themes and templates, 27 Sep 2026 (user request)
- **Widgets (19 types):** value, KPI (sparkline + % change), gauge (rule zones), progress/tank, status pill, multi-value, summary (min/avg/max/now), line, area (stackable, smooth), bar (per hour/day or by machine), donut (time-in-state or share by machine), state timeline, heatmap (hour x day), table (rule-coloured cells), alarms, and the content widgets text, image, link/button and embed. Content widgets need no data source. Max 40 per dashboard.
- **Value-based colours ("colour rules"):** per widget, first match wins, optionally scoped to one key. The editor switches on the property type: numbers get >, >=, <, <=, between, =, != with a value box; on/off properties get an "is on / is off" dropdown; text gets equals/contains. Presets: traffic light, running/stopped. Rules can colour the card background + accent bar, the accent only, the value or the icon; they draw gauge zones and chart threshold lines, and colour table cells and status pills. Legacy bands/statusMap are converted automatically.
- **Rich text:** WYSIWYG editor (bold, italic, underline, strike, headings, lists, quote, link, font, size, colour, highlight, alignment) plus `{{key}}` placeholders filled with live values. Output is sanitised with a whitelist (tags, style properties, http(s)/mailto links only) both in the editor and when saved, including chat-generated settings.
- **Per-widget style:** icon (24), title font/size/weight/colour/alignment or hidden, card background or gradient, border, accent bar, radius, shadow, padding, value font/size/colour, description tooltip (ⓘ) and footer. "Copy style to all" and Reset.
- **Dashboard themes:** presets light, dark, slate, ocean, sand; accent, font (6 Google Fonts), background colour or https image, card colour, radius, shadow, density, title alignment. Stored in `Dashboard.theme` (optional, so old saves still load).
- **Templates gallery:** Machine overview, Energy, Alarms & health, Compare machines, Executive (dark). Templates pick keys from the machine's actual properties.
- **Builder:** grouped searchable palette, duplicate/delete on the selected card, Settings / Style / Colours / Chat tabs, Dashboard tab (theme) when nothing is selected.
- **Pages restyled:** gradient navbar with state chip and avatar, hero + stat tiles on the Map page, cards with status stripe on the Listing page.
- Link widgets can open another app page (Map/Listing/Machine) or a website; they're inert while editing.
- Image upload is capped at 150 KB and stored inline as a data URI (schema allows data:image URIs up to 210k characters; web addresses stay capped at 2000). Larger images should use an https address.
- Line/area charts break the line only when the gap is more than max(3x the median sample step, 15 min).

### D-020 Edit menu, alignment, time range, limits, property/widget rules, 27 Sep 2026 (user request)
- **Edit controls moved off the page.** The machine page shows only breadcrumb, machine name, status and a time-range chip. For admins, the navbar shows one edit (pencil) icon; its menu lists *Edit this dashboard*, *Customise for this machine*, *Reset to shared dashboard*, *Alarm thresholds*, *Show dashboard* (switcher, replaces the old dropdown and "From:" chip, which is now the menu subtitle) and *Dashboard Builder*. The renderer publishes its actions on `window.__imexDbbActions` plus an `imex-dbb:actions` event, because each ThingsBoard widget type has its own copy of the library. The menu is appended to `<body>` so the navbar cell doesn't clip it. Still UI-only (D-012).
- **Alignment:** `style.align` (left/centre/right) and new `style.valign` (top/middle/bottom) for value, KPI, level bar, min/avg/max, multi-value (horizontal only) and status; new `style.titlePos` (above/below) for every widget. Style tab → Layout.
- **Time range:** `realtime` or historic `1h`/`2h`/`4h`/`8h`. Realtime = latest values refreshed every 10 s; time-based widgets (charts, KPI trend, min/avg/max, donut, timeline, heatmap, alarms) use a rolling last hour. Historic = fixed window ending now, refreshed every 60 s. Longer stored ranges are read as `8h` (Zod preprocess), so existing saves keep loading; nothing in the store was rewritten. Per-widget overrides take the same values.
- **Knock-on changes from the 8 h cap:** the heatmap is now *machines × time* (5–20 min buckets) instead of hour × day, and bar charts group per 15 min / per hour / by machine (per day is gone; stored `day` draws per hour). The Energy template now uses 8 h.
- **Limits:** 10 widgets per page, 4 properties per widget, 4 machines in a "specific machines" binding, 8 lines per chart (machines × properties; the chart says how many were not drawn). The schema still parses the old limits (40 / 10) so older dashboards open; `checkDashboard` enforces the new ones on save and on chat output. The palette greys out when the page is full.
- **Property kind vs widget type** (`core/compat.ts`, plain rules): kinds are number, on/off, text, coded state (a number with named `states`). Gauge, KPI, level bar, min/avg/max, line, area, bar and heatmap need a number (or coded); status and state timeline need on/off, text or coded; donut needs states for "time in each state" and a number for "share by machine"; value, multi-value and table take anything. The builder greys out unsuitable properties (with the reason on hover), widget types for which the source has no suitable property, and palette tiles for which the machine type has none. Changing a widget's type swaps to a suitable property. Chat gets the kinds in its catalogue and its output is rejected with the reason (the relay retries once). The renderer shows the reason instead of a broken chart for any old mismatch.
- **Checked on the demo before deploying:** all 4 stored dashboards already fit (≤10 widgets, 1 property each, no mismatches). They were saved as 24 h and now read as "Last 8 h".
- **Widget-wise build output:** `widgets/dist/widget-types/imex_dbb_{launcher,renderer,listing}.json` are importable ThingsBoard widget types (library + glue + settings form), generated by `build.mjs` from `widgets/widget-types.mjs`.

### D-021 Multi-provider chat, key on a tenant-owned asset, live values over WebSocket, 27 Sep 2026 (user request)
- **Provider from the key.** The relay accepts a Claude (`sk-ant-…`), OpenAI (other `sk-…`) or Gemini (`AIza…` or the newer `AQ.…`) key and picks the provider from its format. Chain: *Is chat request* → *Read LLM settings* → *Build LLM request* → *Pick provider* (switch) → *Call Claude* / *Call OpenAI* / *Call Gemini* (one REST node each, so each sends only its own auth header) → *Parse LLM reply* / *Error reply* → *Save reply attribute*. The browser sends the tool in all three formats; Gemini gets a reduced schema (no type arrays; free-form objects as JSON strings, parsed back in `normaliseToolInput`). OpenAI's tool arguments come back as a JSON string (`toolInputJson`), parsed in the widget. Models per provider: `dbb_llm_model_{anthropic,openai,gemini}`; defaults `claude-sonnet-5`, `chat-latest`, `gemini-flash-latest` (set a pinned model for production). All four scripts were run through ThingsBoard's own TBEL engine (`/api/ruleChain/testScript`) with sample requests and replies for each provider and each error case. Then end to end on the demo through the deployed chain with deliberately invalid keys: no key → "No LLM API key is set"; `sk-ant-…` → Claude endpoint, 401 → "anthropic API key … invalid"; `sk-proj-…` → OpenAI endpoint, 401; `AIza…` → Gemini endpoint, 400 (read from `error_body`) → "gemini API key … invalid". So routing, header substitution from the config asset and error mapping work; a successful answer still needs a real key.
- **First real call (27 Sep):** Gemini key in the newer AI Studio format `AQ.…` (detection extended; it works with the `x-goog-api-key` header). A full builder request (system prompt, catalogue, Gemini tool schema, 2,424 prompt tokens) returned in 4.9 s with 3 valid ops (gauge, 4 h line chart, status card) that passed `normaliseToolInput` + `applyOps` with no warnings; Gemini sent `settings` as JSON strings, parsed back as designed.
- **Verified:** a customer user (Pune viewer token) gets 403 on the DBB-LLM-CONFIG asset and its attributes, and 200 on the store asset's attributes.
- **Key storage.** The user asked for the keys on an org-level asset. They are on **`DBB-LLM-CONFIG`, a tenant-owned asset never assigned to a customer** (attribute `dbb_llm_api_key`), read server-side through the relation `UsesLlmConfig` from each DashboardStore asset. Not on the store, a site or the org root asset: those are assigned to the customer, and every customer user can read their attributes through the REST API (D-012). The deploy script refuses to continue if the config asset is customer-assigned, writes defaults only when missing, and moves a key found in the old *Call LLM* node there.
- **Live values.** `core/live.ts` keeps one WebSocket per page (`/api/ws`, auth command + `TIMESERIES` `LATEST_TELEMETRY` per device; legacy `/api/ws/plugins/telemetry` as fallback). `api.latest` reads its cache; `api.series` appends pushed points to a REST window (AVG/raw, windows ending now; re-fetched every 5 min); other window queries are cached 60 s, alarms 15 s. Redraw on push (≤ every 2 s) plus every 60 s. If the socket is down, REST polling exactly as in D-020. Protocol checked on the demo: first reply ~1 s, pushed update ~0.1 s after a telemetry save, unsubscribe works. First page load was unchanged here (35 REST calls measured); D-022 reduced it. **Measured on the demo** (deployed build, RIC-COMP-01 machine page, 74 s): 2 REST calls (alarm refreshes) and live value changes by push; the pre-D-021 code makes about 70 calls in that time.
- **Why not `ctx.subscriptionApi`:** it is tied to one widget's datasources; our widgets build their bindings at runtime from saved layouts and share data across widget types. The raw socket is the same endpoint ThingsBoard's own widgets use.

### D-022 First page load in a fixed number of calls; stale-page chat fix, 28 Sep 2026 (user request)
- **Problem.** First load cost 35–50 REST calls and grew with the customer's tree (one relations call per asset, twice: the navbar and the machine widget each loaded the user context, because every widget type has its own copy of the library). Opening a machine walked up the hierarchy one call per level. The Map and Listing pages cost about 4 calls per machine (latest runStatus, active alarms, key list + latest values).
- **Changes.**
  - **One user context per page:** `entries/common.ts` keeps it on `window.__imexDbbCtx` (same build + same logged-in user from the JWT + same `customerId` setting), so the launcher, renderer and listing share it. `force` reloads it for all.
  - **Hierarchy in constant calls:** `core/scope.ts` uses one `POST /api/relations` per root in each direction (whole subtree below; ancestors above) and one Entity Data Query per entity type (`POST /api/entitiesQuery/find`, entityList filter) for names, labels, profiles and `dbb_assign`. A customer user with one scope root: 8 calls in 4 rounds (was about 10 + 1 per asset, twice).
  - **Assignment snapshot:** the context carries `assign` (`dbb_assign` of every node in scope and above the roots, the user's `dbb_personal`, `dbb_assign_customer`, the store's `dbb_assign_rev`). `store.resolveForDevice` builds the candidates from it and does ONE store read (the dashboards + `dbb_assign_rev`). Every assignment write (apply, customise, reset, clear personal, delete) changes `dbb_assign_rev` and marks the snapshot stale, so this page and every other open page reload it (3 calls) on the next resolve. Machines outside the snapshot still use the old walk. `deleteDashboard` uses the snapshot instead of one read per node.
  - **Map / Listing:** `api.latestMany` (live cache, else ONE Entity Data Query with the catalogue keys + runStatus of all machines) and `api.activeAlarmCounts` (ONE `POST /api/alarmsQuery/find`). Online/offline now uses the catalogue keys + runStatus instead of listing every key per machine. The standalone-dashboard list is read on (re)load, not on every live redraw.
  - **Machine page header:** the status pill no longer holds up the widgets (drawn after the grid starts) and reads the catalogue keys through the live cache (no key listing).
  - **Socket grace:** `api.latest` waits up to 1.5 s (`LIVE_WAIT_MS`) for the WebSocket subscription on a cold page instead of making a REST call right away (`Live.waitReady`).
- **Measured on the demo** (tenant admin with the widget setting `customerId`, 4 machines, same harness and same data before and after, simulator traffic excluded): machine page 49 → **17**, Map page 44 → **14**, Listing page 46 → **15**. 4 of the remaining calls are tenant-admin-only (finding the customer's top assets); a customer user saves those. The number no longer grows with the size of the tree; it grows only with the number of widgets that need history (charts, alarm lists). Unit test (`widgets/test/load.test.ts`): 8 calls for the user context with 4 or 304 machines; 1 call to resolve a machine right after load; 5 after another page changed an assignment, then 1 again.
- **Not verified as a customer user:** customer-user tokens can't be obtained from this session. ThingsBoard applies the same customer scoping to `/api/relations`, `/api/entitiesQuery/find` and `/api/alarmsQuery/find` as to the single-entity endpoints; check once as the Pune viewer (`selectedNodes` = Pune) that the Map page shows only Pune.
- **Chat bug found (same day).** The admin's open Chrome tab still ran the builder code from before D-021 (ThingsBoard keeps widget code until the page is reloaded). That code sends no Gemini tool block, so *Build LLM request* failed in TBEL; *Error reply* then wrote a reply without `reqId` (taken from metadata that the failed node never set), so the builder ignored it and showed "did not answer within 30 seconds". Fixed: *Build LLM request* answers `OLD_CLIENT` ("This page is running an older version of the Dashboard Builder. Reload the page (Ctrl+F5)") and *Error reply* takes `reqId`/`userId` from the request itself (tested in TBEL and live: answer in 1.6 s). DBB_DEPLOY now writes the build id to the store attribute `dbb_lib_version`; a page running another build shows "Reload the page" in the builder's banner.
- **Chat re-tested** after the fix, in the real builder with no machine selected: "Overview of Richmond" → Gemini answered in 11 s with 8 valid widgets (two run-status cards, discharge pressure gauge, power and dew point KPIs with 1 h comparison, dryer pressure drop, compressor and dryer trend charts). One weakness: it put pressure (bar) and power (kW) on one chart axis.

### D-023 Builder polish and full E2E test, 28 Sep 2026 (user request)
- **No flicker on updates.** Every refresh replayed a fade-in on each card (`.dbb-card-b>*{animation}`), and image / embedded-page widgets were rebuilt on every refresh (the iframe reloaded every 10 s). The fade now plays on the first draw only (`dbb-first` class, removed after 400 ms), and static content is only replaced when it changes (`setStatic` in render/widgets.ts).
- **Inter font.** The builder (top bar, palette, panels, dialogs), the navbar and its edit menu use Inter, the standard of the other iMEX pages. The dashboard default font (theme font left empty) is now Inter too (`INTER_STACK` in render/theme.ts); a dashboard that explicitly picked another font (including Roboto) keeps it. The builder canvas now really previews the theme font (before, it always showed the overlay's font).
- **Machine page header is one line:** "ORG › Site", status pill, time range. Machine name and type are no longer shown there (the app navbar shows the selected machine); they are in the crumb's tooltip. About 40 px instead of about 70 px.
- **Machine switch in an app navbar.** The renderer read the machine only from the widget's state controller, and only when ThingsBoard called `onStateChanged`. A navbar that switches the machine by changing the state URL left the page on the old dashboard while the edit menu (which reads the URL) already had the new machine. Fixed: the renderer reads the state URL first (`currentEntity` / `currentParam` in entries/common.ts, same as the navbar), watches it every 500 ms, and ignores results of a load that a newer load has overtaken (`loadSeq`).
- **"No machine (standalone dashboard)"** in the builder's Machine list means the dashboard is not tied to a machine or machine type: its widgets use *Specific machines*, it can't be applied to machines, and it is opened from the Dashboards section of the listing (or a link widget / `dbbDashboardId`).
- **Bugs found by the new E2E test and fixed:** (1) Backspace or Delete while typing in a Text widget's editor deleted the whole widget (the key handler skipped inputs but not contenteditable). (2) In the Colours tab the colour picker's invisible input was 60 px wide and covered the rule's ✕, so a rule could not be removed (it opened the colour picker instead). (3) *Open* (another dashboard or *New blank*) and *Restore* in Version history dropped unsaved changes without asking; they now ask.
- **E2E test:** `npm run test:e2e` (widgets/e2e/builder.e2e.mjs) runs 38 scenarios in Chromium against the fake ThingsBoard of widgets/harness: all 19 widget types (add, render in realtime and historic 8 h, delete), palette search / blocking / 10-widget limit, drag-and-drop, move/resize, duplicate/remove, every data-source mode and the 4-property / 4-machine caps, Style / Colours / Dashboard tabs, text / image / link / embed, templates, preview, save / apply (one machine, all machines, replace confirmation) / versions / restore / save as / conflict / open / delete, unsaved-change prompts, Esc, standalone, chat (ops, highlight, discard, clarification, provider error, corrective retry), and the machine page (one-line header, navbar switch, no flicker, edit menu, viewer). Chat is tested with a stub relay, not a real LLM.

### D-024 Chat: role requests, guard rails, mixed equipment, no blanket failures, 29 Sep 2026 (user request)
User decisions (29 Sep): role / fleet requests on an open machine dashboard **ask each time** where to build; chat **does not answer live-data questions** (it offers a widget instead, no plant data goes to the LLM); mixed equipment stays **one widget per machine type or shared properties** (no per-machine properties in one widget).
- **Why "I couldn't build that" happened.** Replaying real answers showed three causes: (1) models (Gemini flash-lite in particular) often add a widget and then set its data source with `updateWidget W<n>` using the alias the new widget would get, which the old code rejected ("no widget W1"); (2) an empty `clarification` object (`{}` / empty question) made the whole answer invalid; (3) one invalid op failed the whole answer, twice, so nothing was built. Also slips like `name` for a widget title, `title` for a dashboard name, a title/keys/binding inside `settings`, a binding's `machineType` next to the binding, `updateWidget` without `widget`.
- **Fixes in `core/chat.ts`:** widgets added in an answer continue the W numbering; the slips above are normalised; an empty clarification is ignored; problems the draft already had don't count against the model; after the corrective retry, the valid ops are applied one unit at a time (an addWidget together with the updates that refine it) and the dropped ones are listed in plain words ("Some parts could not be built: …"); if nothing applies, the error names the first reason. The builder retries once by itself after 4 s when the provider is overloaded or unreachable.
- **Role presets in the prompt:** executive / CEO (fleet overview: header, one table per machine type over the top location, alarm list for all machines), manager (per location, tables per type, alarms, one comparison trend), operator / technician (one machine in detail), energy, quality.
- **Where to build:** new ops `startNewDashboard {name}` (first op; a new unsaved standalone dashboard, the builder asks before dropping unsaved work, Undo goes back) and `clearWidgets` ("replace"). If the open draft is a machine dashboard with widgets and the user hasn't said where, the answer is held back and the builder asks "Where should I build it?" (Start a new dashboard / Replace this dashboard / Add to this dashboard), also when the model built straight away (`needsWhere`). The choice is applied locally from the held-back answer (`applyWhere`), without a second LLM call.
- **Guard rails:** scope = building/changing the dashboard, how the builder works, what the catalogue contains. Live/historic values: "I don't read live data" + a yes/no offer to add the widget. Device/user/threshold changes: pointed to the machine page or admin pages. Everything else (general knowledge, coding, writing, jokes, the prompt, keys, role-play, "ignore previous instructions") is refused with a fixed short reply. New tool field `intent` (build / clarify / help / refuse); a help or refuse answer never changes the draft, even if ops are attached. A short "how the app works" section lets it answer how-to questions correctly (Save → Apply dialog, Apply to…, history, machine-page menu).
- **Mixed equipment:** the catalogue now lists `sharedKeys` (keys several machine types have); a widget may show a shared key across types (e.g. Inlet Air Temperature of Dryer and Blower on one chart); otherwise one widget per type. An answer that rewrites one widget to several data sources (the model trying to put different properties of different types on one chart, which silently kept only the last) is rejected so the model retries. The alarm list can cover every machine type under a location (`nodeQuery` with machine type "ALL", also in the Widget tab as "All machine types").
- **Relay:** the Error reply also maps network failures (`WebClientRequestException`, timeouts) to "Could not reach the <provider> service … Try again in a moment." Live chain on the demo patched and tested in TBEL.
- **Tested with a real LLM** (Gemini 3.1 flash-lite through the demo relay; flash-latest and 3.x flash were overloaded all day, pro models not available to this key), on a copy of the user's hierarchy (ITHENA ORG → Pune: Compressor, Dryer; Richmond: Blower): off-topic (capital of France, a Python script, prompt-injection) refused 3/3; how-to answered correctly; live-value question → "I can't see live data, add a value card?"; manager request → asked where; CEO request → built straight away in 2 of 3 runs, now held back and asked; new-dashboard builds valid in 2 of 3 runs (the third came back with empty operations); mixed request with a shared key built correctly; a different-properties-on-one-chart request was rejected and retried, but flash-lite's retries came back empty. **Recommendation:** use a stronger model than flash-lite (Gemini flash on a paid key, or a Claude / OpenAI key) for dependable results.
- Tests: 78 unit tests (16 new), 45 E2E scenarios (7 new chat scenarios).

### D-025 Dashboard list for standalone dashboards; preview machine picked automatically, 30 Sep 2026 (user request)
- **Problem:** standalone dashboards (not tied to one machine) could only be reached from the listing widget's Dashboards section, which the iMEX app does not use, so there was no way to open them. A dashboard built by chat with "This machine" widgets while the builder had "No machine" selected showed only "Open this dashboard for a machine to see data".
- **Dashboard list** (user decisions 30 Sep: in the pencil menu, for everyone; a click opens it on the page): the navbar menu has "Dashboard list" for every user. Users who can't edit see a list icon (tooltip "Dashboards") instead of the pencil, with only that item; editors keep the edit items and the Dashboard Builder. The list is a centred dialog with the standalone dashboards the user may see (shared + own private), search by name or owner, 8 per page. A row opens the dashboard full-page in the state that holds the machine-dashboard widget (settings.machineState, else the state the renderer last ran in on this ThingsBoard dashboard, remembered in localStorage, else 'machine'), via the state param `dbbDashboardId`. Editors also get Edit (opens the builder). Setting `dashboardList` (default true) on the navbar widget; false restores the admin-only icon.
- **Preview machine:** when the draft has "This machine" widgets and no machine is selected (chat, templates, type changes), the builder picks the first in-scope machine of the draft's type for the preview and says so ("Previewing with …"); the user can pick another at the top.
- Tests: 49 E2E scenarios (4 new).

### D-026 Dashboard Overview state; Dashboard list redesign; design pass for chat-built dashboards, 30 Sep 2026 (user request)
- **Dashboard Overview state.** Standalone dashboards (not tied to one machine) now open in their own state, `dashboard_overview` ("Dashboard Overview"), instead of the machine state. Machine dashboards are unchanged. The navbar setting `overviewState` (default `dashboard_overview`) names it; if the ThingsBoard dashboard has no such state, the list falls back to the machine state as before (and logs a console warning). On that state the navbar's menu keeps all three items: *Edit this dashboard* (opens the shown dashboard in the builder), *Dashboard list*, *Dashboard Builder* (opens the builder on the shown dashboard, not a blank draft). The renderer only remembers the machine state, so the fallback can't pick the overview state. The state must contain the machine-dashboard (renderer) widget; deploy-browser.js creates it.
- **Dashboard list redesign.** Self-contained scoped styles (no reliance on ThingsBoard/Material CSS, which gave unstyled buttons and stray markers): header with icon, title, subtitle and close; search with highlighted matches; sort by name / recently updated; rows with a coloured initials avatar, name, Private badge, widget count, owner, "Updated x ago", Edit and Open buttons; numbered pager and "Showing 1–8 of 11"; empty states; keyboard (Esc, Enter, arrows).
- **Design pass for chat-built dashboards** (core/design.ts). Models pick sensible widgets but lay them out poorly (a one-row text header that cut off its heading, one-machine tables four rows tall stacked on the left, half the page empty) and leave everything grey. Now, deterministically after the model's ops: every table chat adds is sized to its rows (header + one line per machine) and text is at least 2 rows. For a **fresh** dashboard (new, replaced, or built on an empty draft; never when adding to an existing one): ocean theme if none; the short header becomes a gradient banner with the name, machine and location count and live date/time (a banner is created on fleet dashboards without one); Running/Stopped status cards per machine for fleet dashboards without cards (≤ 8 machines, within the 10-widget limit); per machine type an accent bar, icon and icon colour; Running/Stopped colours on run-state columns; KPI sparklines; rows without gaps (banner, cards split evenly, wide charts, bar/donut in pairs, tables in pairs with an odd table next to the alarm list, alarms). Nothing the model styled explicitly is overwritten; if the polished result would fail the dashboard checks, the unpolished one is kept. The executive preset in the prompt now asks for 2–4 headline KPI cards as well.
- Tests: 81 unit tests (3 new), 51 E2E scenarios (navbar/list tests rewritten, 1 new CEO-layout test with screenshot).

### D-027 Builder "Open dashboard" dialog redesign, 30 Sep 2026 (user request)
- The builder's *Open* dialog looked cramped and did not use Inter: it was a plain `<table>`, and ThingsBoard's own table styles overrode our font and size inside the app. It is now built from divs in a CSS grid (`.dbb-od`), with Inter set on every element, so the host page's styles can't change it.
- Wider (up to 1040 px, was 820 px); "+ New blank dashboard" moved to the right, with the count of saved dashboards on the left; 24 px between columns and 18 px row padding; header row sticky; machine type as a pill (standalone in purple); widget count right-aligned (centred since D-044); shorter dates ("Sep 30, 2026, 6:12 PM"); rows keyboard-focusable (Enter opens). `modal()` takes an optional box class (`wide`).
- The navbar's *Dashboard list* was already redesigned in D-026 (not yet deployed on iserv-demov2 at the time of the screenshot).
- Tests: the Open-dialog E2E scenario also checks width, Inter on every element, button position and column spacing, and saves a screenshot.

### D-028 Security and performance review, 30 Sep 2026 (user request: no loopholes, 20–25 users, 30–40 machines, 5 tabs)
A full read-only security review of widgets/src and the chat relay, then fixes, then a worst-case load test.

**Security: found and fixed**
- **Stored XSS (high).** Any customer user can write the store attributes directly (known limitation D-012), so every stored string is untrusted. Four paths could run script in another user's browser (including an admin's) and read the ThingsBoard token:
  1. Legacy colour fields `bands[].color` and `statusMap[].color` were plain strings and went into HTML and SVG. They now must be plain colours; an older document with a bad value loads with grey instead of failing (`LegacyColor`). Every rule colour is also checked again when drawn (`cssColor`, `isColor` in render/rules.ts).
  2. Dashboard, widget, device and node ids were free strings and went into HTML attributes (Listing page, Open dialog, builder editors). They are now restricted to letters, digits, `_` and `-` (`Id` in schema.ts) and escaped where used. A dashboard is only listed if its attribute key matches its id.
  3. Version history entries (`dbb_h_<id>`) were used without validation. They are now validated like dashboards.
  4. Chat answers can set the same fields, so the same checks cover the LLM and a forged chat reply.
- **CSS injection (medium).** `titleFont`, `valueFont` and the theme font accepted any text, which went into a style attribute; a newline could add any CSS (full-page overlay, tracking image). Font names are now letters, digits and spaces only, both in the schema and in `fontStack()`.
- **Chat relay (medium).**
  - The reply now goes to the user ThingsBoard reports as the writer (`metadata.userId`), not to an id from the request. A mismatch is refused.
  - The relay only forwards the builder's own tool (`dashboard_ops`) with a fixed tool choice, and refuses oversized requests (system prompt or a message over 60,000 characters, more than 24 messages), so it can't be used as a general LLM proxy on the tenant's key.
  - Tested with ThingsBoard's TBEL test endpoint on the demo (Claude / OpenAI / Gemini bodies, mismatch, bad tool, too big). **Not yet deployed to the live relay.** If ThingsBoard does not put `userId` in the metadata, the relay falls back to the request's id (same as before).
- **Low.**
  - An entity such as `&#x110000;` crashed the rich-text sanitizer and blanked the page; it now decodes to �.
  - The sanitizer is now linear on input with many `<`, and caches its results.
  - `{{placeholders}}` are no longer filled inside HTML attributes.
  - Pages from the ThingsBoard server itself are not framed by the embed widget (the sandbox would not protect them).
  - A telemetry key in one URL is now encoded.
- **Remaining, accepted:**
  - D-012: store attributes are writable by customer users. They can still spoil or delete dashboards, but can no longer run script.
  - Chat requests and replies on the store asset are readable by all customer users of that customer.
  - No server-side chat rate limit: the builder limits each user to 30 requests per hour in the browser. Set a spending limit on the provider key.
  - The legacy WebSocket fallback puts the token in the URL (only used on ThingsBoard versions before 3.6).
- Regression test: E2E "stored XSS" seeds hostile documents (script in every stored string, bad colours, CSS in fonts, bad ids, bad history, a same-origin embed) and checks that nothing runs in the builder (Open dialog, every widget editor, history) or on the machine page. It fails on the D-027 code.

**Performance: measured and improved**
- **Worst-case load test:** `node widgets/e2e/bench.mjs [tabs] [seconds]` (harness `?bench=1`).
  - Setup: 40 machines, a 10-widget dashboard where every widget shows its maximum (4 machines × up to 4 properties, 40 machines on the page), and a fake WebSocket pushing a new value for every subscribed key of every machine every second. The same dashboard is open in 5 tabs, all visible (worse than a real browser, which pauses hidden tabs).
  - Result per tab over 60 s:
    - 5.5–6.7 % main-thread busy;
    - no long task (> 50 ms) after the first load;
    - the first load's longest task is 230–340 ms;
    - heap about 18 MB and flat;
    - no DOM growth;
    - 16 REST calls per minute (heatmap, bar, timeline and aggregate widgets re-read at most every 60 s; everything else comes over the WebSocket).
- **Changes:**
  - Identical GETs in flight are shared (`api.get`).
  - A widget never runs two refreshes at once: a refresh requested while one is running runs once afterwards, so a slow server doesn't pile up requests.
  - Live history is trimmed in batches.
  - A tab that becomes visible again redraws at once (hidden tabs skip redraws).
- **Server estimate for 25 users with 2 tabs each (50 tabs), worst-case dashboards:** 50 WebSocket sessions, at most 40 subscriptions each, and about 800 REST calls per minute (about 13/s). Dashboards of value cards, gauges, tables and charts use almost no REST in steady state. The same dashboard in 5 tabs costs 5×; sharing one connection across tabs (BroadcastChannel) is possible later if needed.
- Tests: 85 unit tests (4 new), 52 E2E scenarios (1 new), plus the load test.

### D-029 Content-fitting chat widgets, New dashboard, chat layout control, start screen, 1 Oct 2026 (user request)
- **Nothing cut off.**
  - Problem: widgets added by chat used fixed default sizes, so tables with many machines, multi-value cards with 4 properties, long text and chart legends were cut off until the user dragged them bigger.
  - Two layers fix it:
    1. `sizeWidget` (core/design.ts) sizes every widget chat adds or changes from its content: tables by machines, multi-value cards by properties, timelines and heatmaps by machines, line/area charts by legend lines, text by length, minimums for gauges, bars, donuts and alarm lists. Lists are sized exactly; other types only grow.
    2. After drawing, the builder measures each new or changed card and grows any whose content still overflows, in height and if needed width, moving the widgets below down (`Builder.fitToContent`). This is part of the same undo step.
- **New dashboard.**
  - There is a **New** button in the builder's top bar, a **New dashboard** item in the navbar's pencil menu (editors), and "+ New dashboard" in the Open dialog and on the start screen.
  - The dialog asks for a name and what the dashboard is for:
    - **One machine type:** shown on the machine page and reused by every machine of that type. The preview uses the open machine if it has that type, else the first one.
    - **Overview:** several machines or locations, not tied to one machine; opens from the Dashboard list.
  - It asks before dropping unsaved changes, and nothing is saved until Save.
- **Chat can arrange the page.**
  - The draft sent to the model now includes each widget's position and size: x is a column (0–11), y a row, w a width (1–12), h a height in rows of 74 px.
  - `addWidget` and `updateWidget` accept x/y/w/h. Values sent as strings are converted, and out-of-range values are clamped. Moved widgets keep their spot and the others move down (`resolveCollisions`).
  - New op `arrangeLayout` tidies the whole page: rows without gaps, cards side by side, lists as tall as their rows (`layoutPass`, the layout step of the D-026 design pass). Afterwards every widget is fitted to its content.
  - The prompt explains the grid with examples: full width, halves, three or four in a row, to the top, swap.
  - New widgets are still placed automatically unless the user asks for a position.
- **What the builder opens on** (`launcher.open`):
  - **Machine page:** that machine, and the dashboard it shows now (personal → machine → location → customer-wide; a blank draft for its type if it only shows the default layout).
  - **Dashboard Overview state:** the overview dashboard shown there.
  - **Any other page** (Map, Listing, …): a start screen with "What would you like to do?", **+ New dashboard**, **Open a dashboard**, chat, and the 5 most recently updated dashboards (one click opens one).
  - **Navbar → New dashboard:** the builder plus the New dashboard dialog.
- **Nothing from an earlier visit.**
  - Only one builder can be open: a second menu click, or Back while it is open, brings back the open one instead of stacking a second overlay.
  - Cached data series and REST answers are cleared when the builder opens, so previews load fresh.
  - The user context is reloaded (as before), and each opening starts with empty chat, undo and selection.
  - After re-importing the widget types, pages that were already open keep the old code until reloaded; the builder shows its "reload" banner when the library version differs (D-022).
- Tests: 88 unit tests (3 new), 56 E2E scenarios (4 new): nothing cut off after a chat build, including deliberately undersized widgets (measured in the browser); chat move, resize and tidy; New dashboard (button, dialog, both kinds, navbar item, single builder); start screen with recent dashboards.

### D-030 Dashboard Builder opens below the app navbar, 1 Oct 2026 (user decision)
- User decision (1 Oct): the builder must start below the iMEX navbar, like the pages do. The app dashboard uses a 150-column layout with no margins; grid rows 1–6 are the navbar and the status line, and pages start at row 7. Before this, the builder covered the whole window (position fixed, inset 0, z-index 10000).
- **New navbar widget setting `builderTop`** ("Dashboard Builder starts below"):
  - `auto` (default) measures the bottom of the navbar: the lowest bottom edge of the dashboard widgets in the same band as the navbar widget, plus a thin (≤ 24 px), full-width strip directly under it (the status line). A widget that is narrower or taller, such as the listing page's sort bar or the hierarchy panel, is page content and stays covered.
  - A number (e.g. `64`) sets the offset in px; `0` or `full` gives full screen as before.
  - The offset is measured when the builder opens and again on every window resize, and is ignored if it is more than 40 % of the window.
- **Below the navbar the builder uses z-index 999**, so the app's own menus (Angular Material overlays, z-index 1000), such as the equipment dropdown, open above it.
- **The navbar stays usable, so the builder follows navigation.** It watches the page (state and its parameters, every 500 ms):
  - With no unsaved changes, it closes and the new page shows.
  - With unsaved changes, it asks "You opened another page": **Keep editing** leaves the builder open (save, then close it), **Discard and go** closes it.
  - Reloading or closing the browser tab still asks first (beforeunload).
- The builder opened directly (harness, `IMEX_DBB.open` without a navbar widget) stays full screen.
- Tests: 58 E2E scenarios (2 new): the builder starts at the navbar bottom, the navbar stays clickable, the pencil menu opens over the builder, navigation closes it or asks, Keep editing and Discard both work; the offset is measured correctly in a ThingsBoard-like grid (navbar band + status line, not the page's sort bar or side panel; px and full-screen settings).

### D-031 New dashboard dialog readability; stale builder styles replaced, 1 Oct 2026 (user feedback)
- On iserv-demov2 the "New dashboard" dialog looked crowded: titles, descriptions and the type picker ran together on one line with no spacing. The dialog's styles were not applied. The builder's style element (`dbb-css-builder`) from an earlier build was still on the page, and `ensureCss` kept any existing element with the same id, so new rules from a newer build never arrived until a full reload.
- **Fix 1:** `ensureCss` (render/theme.ts) now replaces the content of an existing style element when it differs. This covers widgets re-imported without a full reload, and another widget type still on an older build.
- **Fix 2:** the dialog is rebuilt with its own self-contained styles (`.dbb-nd-*`, Inter on every element, no reliance on `.dbb-field`):
  - "Name" and "What is it for?" labels above full-width inputs (38 px);
  - two option cards with 14–16 px padding, each with a 14 px semibold title and a 13 px description underneath (line height 1.5);
  - the machine-type picker on its own line inside the first card ("Machine type ▾");
  - the selected card is highlighted in blue;
  - the dialog is 560 px wide.
- Tests: 59 E2E scenarios (1 new). It checks that a stale style element is replaced, that title, description and picker are stacked, the font sizes and padding, and Inter; it saves a screenshot.

### D-032 Modern start screen in the builder, 1 Oct 2026 (user feedback)
- The start screen (builder opened from a page without a machine) looked unstyled on iserv-demov2: centred plain buttons, and recent dashboards as bordered text runs with name and details run together. The D-029 build there had a stale builder stylesheet (fixed by D-031), and the layout itself was minimal.
- New self-contained component (`startScreenHtml()`, `.dbb-st-*` styles with Inter on every element; buttons reset with `all: unset`, then styled with stronger selectors):
  - header "Start a dashboard" with a one-line subtitle;
  - three action tiles with an icon, title and description: **New dashboard** (primary, blue), **Open a dashboard**, **Describe it in chat**;
  - "Recently updated" as a list card. Each row has:
    - a coloured initials avatar;
    - the name on its own line;
    - underneath it, a type tag (machine type in blue, Overview in purple), the widget count and the owner;
    - "Updated x ago" and a chevron on the right.
  - The list has hover and focus states and loading placeholders, and shows "No saved dashboards yet" when empty.
  - A hint underneath: "…or drag widgets from the left onto the page".
- Tests: the start-screen E2E checks the three tiles, the stacked rows, the row height and Inter, and saves a screenshot. 59 E2E.

### D-033 Builder panel, list, dialogs and header polish after the live test, 2 Oct 2026 (user feedback, 10 items)
- **Right panel sections:** the Widget, Style and Dashboard tabs are split into section cards (Widget / 1 Data source / 2 Properties / 3 Options; Title / Layout / Card / Value / Help text; Theme / Background / Cards). A click on a section header collapses or expands it. The state is kept per tab and section title while the page is open, so it survives the redraw after every edit. Built by `sectionize()` in the new `builder/controls.ts`, which wraps each `.dbb-sec` header and the fields after it. Duplicate / Remove, "Copy style to all" and "Reset theme" stay outside the sections (`data-nosec`).
- **Searchable dropdowns instead of radio lists:** properties and specific machines use `picker()` (builder/controls.ts):
  - the closed control shows the choice, or chips with ✕ for several;
  - the list has a search box when there are more than 4 entries; every word must match, so "pune 1" finds "Pune Compressor 1", and machine types match too;
  - custom checkboxes or radio dots (real elements, not `::before`/`::after`);
  - greyed rows give the reason in a tooltip (not suitable for this widget type, or the cap of 4 is reached);
  - "n of 4 selected", Clear and Done.
  - With several choices, ticks apply once, when the list closes (Done, a click outside, Escape or Tab). That gives one undo step and one redraw. A single choice applies at once.
  - The data source is a dropdown ("Show data from") with a one-line explanation under it, and the type / location pickers below it as labelled fields.
- **New dashboard dialog (broken on the customer's app):** the host page CSS put the native radio in its own wide column and added diamond markers before the captions. The dialog now has:
  - no `<label>`, native radio or native select;
  - option cards that are `role="radio"` divs with a span dot (arrow keys and Space/Enter work);
  - the machine type as a picker shown under the cards only for "One machine type", opening in the flow (`inline`);
  - `::before`/`::after` switched off inside the dialog and on the modal chrome.
  The E2E test injects hostile host CSS (label grid, wide radios, decorated `::before`) and checks the layout.
- **Background image:** it worked with a valid https address, but nothing told the user why other addresses showed nothing. `background-attachment: fixed` also sized the image to the browser window, so a widget showed only a slice, and it is ignored under transformed parents.
  - Now the Background section has:
    - page colour;
    - image address or **Upload image…** (data URI up to 150 KB, like the image widget; schema `bgImage` up to 210 000 characters for `data:image/` only, web addresses still at most 2000);
    - a status line: ✓ loaded with size; "must start with https://"; or "couldn't load an image from this address";
    - **Image fit** Fill / Fit / Tile (`bgFit`);
    - remove.
  - `applyTheme` uses a centred, scrolling image (no fixed attachment). Chat's setTheme accepts `bgFit`.
- **Builder top bar:** the "Dashboard Builder" logo and title are removed; the machine picker is the first item.
- **Dashboard list over the builder:** the list was hidden because the customer navbar raises the builder overlay to z-index 300000. The list and the navbar menu now take a z-index above any open builder overlay (`aboveBuilder()`, at least 10040 / 10050). Edit from the list while the builder is open loads that dashboard into it (asking about unsaved changes) instead of being ignored.
- **Machine-type dashboards in the Dashboard list (editors):** a dashboard saved with "Don't apply now" could only be found in the builder's Open dialog. Editors now get All / Overviews / Machine types filters.
  - Machine-type rows show the type as a badge, and "Not applied" when no assignment (machine, location, customer or personal) names them. This is read from the cached assignment snapshot.
  - Their action is **Open in builder**, previewed on the open machine if it has that type, else the first machine of the type.
  - Viewers still see overviews only. Search also matches the machine type.
- **Table alignment:** numeric columns (every shown value is a number) are centred, header included; text columns stay right-aligned. *(Superseded by D-044: every column centred.)*
- **Navbar menu restyled like the app's dropdowns:** plain text rows (no icons, no taglines; the old tagline is the tooltip), light cyan hover with a 1 px lift and shadow, and a dark bar on the left of the selected row (the dashboard currently shown, in "Show dashboard").
- **Machine page header:**
  - The range chip is replaced by "**Time window**  Last 8 hours" (or "Live · last hour", with a pulsing dot).
  - On the right of the same row is "● **Updated** 2 seconds ago". This comes from the newest data-point timestamp the widgets received: a data clock in core/api.ts, fed by `latest`, `latestMany` and `series`, reset when another dashboard loads. The header's own status read (`lastTelemetry`) is excluded (`latest(..., quiet)`).
  - The text ticks every second. The dot is green under 2 min and amber over 15 min. The tooltip has the exact time.
  - The status pill no longer repeats "· x ago" (that is its tooltip now).
- **Fixes from the live test:**
  - **(a)** The machine page's Edit / Customise opened the builder full screen. The launcher now registers its placement (`setBuilderPlacement`, also on `window.__imexDbbPlacement` for the other library copies), and `openBuilder` uses it when the caller gives none.
  - **(b)** `currentState()` failed on a state parameter that was percent-encoded twice (`%3D` left after URLSearchParams). The new `decodeStateParam()` decodes up to 3 times, restores `+` and base64 padding, and returns null instead of throwing.
- Tests: 93 unit tests (5 new: state decoding, the data clock and quiet reads, wording, theme schema) and 65 E2E scenarios (6 new: section cards and the removed brand; background image status / upload / fit; table alignment; machine-type dashboards in the list; list and menu above a raised builder; machine page Edit placement). The New dashboard, Widget tab, caps, header and list tests were updated for the new controls.

### D-034 "Edit this dashboard" opens below the app navbar too, 5 Oct 2026 (user report)
- **Problem:** on the customer app, the builder opened below the navbar everywhere except "Edit dashboard" (machine page), which opened full screen. The machine page widget calls `openBuilder` without a position. D-033 had it reuse the placement registered by our launcher's `init`, but there were two gaps:
  - the app's own navbar (navbar2) calls `launcher.open` / `dashboardList` directly and never runs `init`, so nothing was registered;
  - a registration from a navbar widget that was later re-created measures a detached element and returns 0.
- **Fix:**
  - `launcher.open()` and `dashboardList()` now register the placement too (`registerPlacement`). A detached navbar element falls back to measuring the page.
  - `openBuilder` without a position, and with no usable registration, measures the app header from the ThingsBoard page itself (`measureHeaderTop()` in builder/builder.ts). The header is:
    - the dashboard widgets that start in the top row, plus widgets overlapping that band;
    - plus thin full-width strips right under it (the status line);
    - widgets taller than 40 % of the window count as page content;
    - 0 (full screen) when there is no such band.
  - Such builders also follow navigation using a URL page key (path + `state` parameter).
  - The setting `builderTop` = 0 still means full screen.
- **Deploy:** the fix is in the library copy of the **machine dashboard (renderer)** widget type, so re-import `imex_dbb_renderer.json` (and the launcher). It works even if navbar2 still embeds an older bundle.
- Tests: 66 E2E (1 new). It covers an app navbar in a ThingsBoard-like grid with no registration (header 50 px + status line 12 px → the builder starts at 62 px), and a stale registration that returns 0 → also 62 px.

### D-035 Local copy of the iMEX demo app (from iserv-demov2, read-only) with the Dashboard Builder, 5 Oct 2026 (user decision)
- **User decisions (5 Oct):** the handoff's plan (deploy D-034 to the local ThingsBoard next to Reports) was first changed to "stay on demo.thingsboard.io", then to: **copy the iMEX demo app from iserv-demov2 to the local ThingsBoard, into the same tenant as Self-Service Reports**, and run the Dashboard Builder there as it is integrated on the server. iserv-demov2 stays **read-only** ("the rule stays"). On the copy: generators every 10 s instead of 1 s, latest telemetry only, new device access tokens, no activation emails, users with a password Akshay chose, no secrets copied.
- **Instances:** iserv-demov2 = ThingsBoard CE **4.2.1**; local (Docker, `C:\thingsboard`) = CE **4.3.1.5**. Credentials in `.env`: `SRC_TB_*` (server), `TB_*` (local), `LOCAL_USER_PASSWORD` (users the import creates).
- **Copy tooling (`scripts/mirror/`):**
  - `clients.mjs`: the server client is read-only by construction. Any non-GET is refused before sending (except login and the Entity/Alarm Data Query POSTs), and so are GETs with side effects (dashboard star/unstar, user tokens, activation links, device API, OAuth, device credentials).
  - `export-source.mjs` → `mirror-data/source/` (git-ignored). It exports dashboards, tenant widget types, images, rule chains with metadata, profiles, customers, users, assets and devices, with attributes per scope, latest values (strict types) and relations. Secret attribute values (`dbb_llm_api_key`, `authToken`, `*token*/*key*/*secret*/*password*`) and Google Maps keys are masked on read (`redact.mjs`).
  - `fetch-static.mjs` + `cdn-map.mjs`: 8 libraries the server serves from its own web UI (`assets/ithena/devextreme-23.2.11/…`) are mapped to public CDN copies. All are byte-identical except daterangepicker, whose minifier comment differs. The folder is named 23.2.11 but holds DevExtreme **23.2.6**.
  - `import-local.mjs`: backs up the local tenant configuration (`backups/<date>/local-before-import`), then creates or updates by name everything listed below. One source→local id map (`mirror-data/idmap.json`) rewrites every server id inside the copied JSON. It is idempotent.
  - `verify-local.mjs` (leftover server ids, generator data), `diff-local.mjs` (pre-existing local entities unchanged), `smoke-local.mjs` (every app state in headless Chromium as a customer user: screenshots + console errors, tokens masked).
- **What was copied:**
  - customer *Ithena Technology*;
  - device profiles Compressor, Dryer, Blower, Weather Station (alarm rules kept; provisioning off);
  - asset profiles DashboardStore (marked `[poc=true]`) and CATALOGUE_STORE_ASSET;
  - 6 rule chains (4 per-type generator chains, *Ithena Telemetry Simulation*, *[UCA] Shift Detection RC*);
  - 9 assets (ITHENA ORG → Pune, Richmond, Mumbai, Bangalore, Austin; System Configuration; DashboardStore with every Builder dashboard; CATALOGUE_STORE_ASSET) and 15 devices, with attributes, latest values and relations;
  - 19 developer widget types and 4 images;
  - the app dashboard **Self Service Dashboard** (12 states);
  - users aradhyab@, imex_service@ and a new admin **akshayr+imex@ithena.ai** (akshayr@ithena.ai already exists in POC Customer Alpha), each with `Role` and `selectedNodes`.
- **Not copied:**
  - *[WESCO] Performance Monitoring V1*, which is broken on the server (its `_wesco_*` widget types are gone), and *Test*;
  - the server's `imex_rpt_*` (the local Reports build is newer) and `imex_dbb_*` (deployed from this repo);
  - the root chain (the local one is used) and the tenant admin;
  - the LLM key: the local `DBBLLM-CONFIG` already exists and is reused.
- **Changes made to the local copies only:**
  1. Generator period ≥ 10 s.
  2. Five TBEL generators fixed. `clamp()` called `Math.max(0.0, v)` with an integer `v`, which fails in TBEL with "argument type mismatch". Dryer 2/3/4 and Weather Station 3/4 stopped producing data **on the server too** (12:32 UTC on 5 Oct). Local: `clamp` converts to double.
  3. Library URLs point at the CDN copies.
  4. `active_alarm_` called `http://3.110.150.117:8080/api/alarm/DEVICE/` with the stored token. It is now same-origin, so a local token never goes to that address.
  5. The Reports widget's `serviceUrl` is `http://localhost:8090`. On the server it is `http://172.67.145.52:8090/`.
  6. Map `gmApiKey` is empty. The map uses OpenStreetMap and works without it.
- **Dashboard Builder on local:** `deploy-node.mjs --go` with `deploy.local.json` = customer *Ithena Technology*, store *DashboardStore*, config *DBBLLM-CONFIG*, `skipAppDashboard: true` (new option; the copied app dashboard already hosts the widgets, as on the server). The catalogue copied from the server was passed back unchanged (Weather Station 18, Compressor 33, Dryer 20, Blower 21 keys).
- **Two bugs in our code found on local, fixed:**
  - `core/live.ts` hard-coded `wss://`. On a plain-http ThingsBoard the v2 socket failed and the legacy fallback put the JWT into the WebSocket URL. The scheme now follows the page (`secure` option).
  - ThingsBoard 4.3 removed `GET /api/relations/info?fromId=|toId=`, which now returns 500; the path form `/api/relations/info/{from|to}/{type}/{id}` is the only one left. 4.2 has only the query form. `core/api.ts` `relInfo` tries the path form first and after one 404 uses the query form for the page.

  Also in `deploy-browser.js`: relations are saved at `/api/v2/relation` (4.3), falling back to `/api/relation`.
- **Verified on local:**
  - all 15 machines receive data every 10 s;
  - no server ids are left in the dashboard, rule chains, attributes or users. The only exception is the "by" user id of two Builder dashboards saved by server users who were not copied: a label only;
  - every entity, profile, rule chain, dashboard and widget type Reports had before is unchanged (`diff-local.mjs`);
  - the map page renders; the remaining errors per state are listed in the widget review (developer widgets: `authToken` not set yet, 4.3 incompatibilities in `navbar2` and the listing, several DevExtreme versions on one page).
- **Tests:** 96 unit tests (3 new: ws:// on http, relation infos on 4.3 and on 4.2) and 66 E2E. Two E2E tests opened the property / machine picker by clicking the control's centre. With Inter actually loaded (internet on this PC), the centre is the selected chip's ✕, so the click removed the property. They now click the caret. The harness has no WebSocket server; its console filter now also ignores the ws:// handshake error, which used to be an ERR_SSL error and was ignored by accident.

### D-036 Builder next to an app side menu; headless launcher, 5 Oct 2026 (user decision)
- **Why:** the iMEX app is getting a side menu instead of the top navbar (UI redesign, built as native ThingsBoard widgets in a separate repo, `D:Claude CodeiMEX App UI`). The builder could only start below a navbar (`builderTop`, D-030), and its API (`window.IMEX_DBB`) only existed when our navbar widget drew its own pencil icon.
- **App shell insets.** An app shell declares the space it keeps for itself with two CSS custom properties on `<html>`: `--imex-app-inset-left` and `--imex-app-inset-top` (px), and fires the window event `imex-app:insets` when they change (menu collapsed / expanded).
  - The builder overlay starts at that left edge. If the top inset is set (also `0px`), it replaces the navbar measurement; if it is not set, the D-030 / D-034 behaviour is unchanged.
  - The builder re-places itself on that event and on window resize. An inset of more than 40 % of the window is ignored, like the top offset.
  - With an inset the overlay uses z-index 999, so the menu's flyouts and the app's own menus open above it.
  - CSS properties and an event, not a function call, because every widget type has its own copy of the library and the side menu is not our code.
- **Headless launcher.** New navbar-widget setting `headless`: the widget draws nothing and only provides `window.IMEX_DBB` = `open(opts)`, `newDashboard()`, `dashboardList()`, `isEditor()` (Promise), `actions()` (the machine page's edit actions, same as `window.__imexDbbActions`), then fires `imex-dbb:ready`. An app menu calls these instead of reimplementing them. Put the widget in a 1×1 cell of every state.
- **Files:** `widgets/src/builder/builder.ts` (`appInsets`, `placeBelowNavbar`), `widgets/src/entries/launcher.ts` (`init`, headless branch), settings form in `widgets/widget-types.mjs` and `widgets/deploy/deploy-browser.js`, `widgets/harness/harness.ts` (`__mountLauncher`).
- **Tests:** 96 unit, 67 E2E (1 new: builder right of a 248 px menu with top inset 0, follows the collapse to 72 px, headless widget draws nothing, `isEditor`, Dashboard list through the API). The Dashboard-tab theme test picked the font while the panel was still redrawing after the preset click and failed about once in several full runs; it now waits 150 ms first.
- **Deployed** to the local ThingsBoard (build 2026-10-05T13:58:20Z). Not on iserv-demov2.

### D-037 Scope relations kept for the browser session, 5 Oct 2026 (user decision)
- **Why:** the load review of the app (UI repo, `docs/LOAD_REVIEW.md`) measured 2 relation calls per location in the user's scope on every page load: 10 for an admin with 5 sites. The library is loaded again on every page of the app (the headless launcher of D-036 is on each state), and the in-memory cache of `entries/common.ts` does not survive that. 50 locations would cost 100 calls per page change. Akshay: "Yes, please fix that."
- **What:** `buildTree` (`core/scope.ts`) keeps the two relation results in `sessionStorage` under `imex-dbb-rel:<userId>:<root ids>` for `REL_CACHE_MS` = 10 minutes. Per user and per root set, so another login or a changed `selectedNodes` asks again. A failed relation call is not stored. Without `sessionStorage` nothing changes.
- **Cost of it:** a machine or site added to the hierarchy shows up in the builder up to 10 minutes later in a browser tab that was already open. A new tab or sign-in sees it at once. Entities, names and assignments are not cached: only the Contains relations.
- **Measured on local:** relation calls per page load for the admin went from 10 to 0 after the first page of a session.
- **Tests:** 97 unit (1 new: second load makes no relation calls; another user, an entry older than the limit do), 67 E2E.
- **D-050:** `REL_CACHE_MS` is now 2 minutes, the app's time for the same key, which it shares. The key holds the grant ids in the access core's normalized order.

### D-038 Machine page header shows the machine name again, 5 Oct 2026 (user request)
- **Why:** since 28 Sep 2026 the machine page's header left out the machine's name because the app's navbar showed it. The app now has a side menu and no navbar (D-036). Akshay: "When a dashboard is selected there is no title for that page meaning user wont understand what dashboard he/she is looking at - add that."
- **What:** the header line starts with the machine's label as the title (17 px, bold), then `org › site · dashboard name`, the status pill and the time window. Still one line, at most 48 px high. The Dashboard Overview page already had the dashboard's name as its title; it uses the same title style.
- **Files:** `widgets/src/entries/renderer.ts` (header markup, `.dbb-rtitle`, `.dbb-crumb-d`); E2E test "machine page header" now expects the title.
- **Deployed** to the local ThingsBoard (build 2026-10-05T17:32:07Z). Not on iserv-demov2.
- 6 Oct 2026: the title is shown only when the app's side menu is on the page (`#imx-menu-root` or `html.imx-menu-shift`); an app that still has its navbar keeps the line as before, so a server deploy does not show the machine name twice. Harness flag `?shell=1`; E2E tests for both cases. The theme font option's default reads "Same as the app (default)".

### D-039 App font and no platform name, 5 Oct 2026 (user request)
- **Why:** Akshay: use the side menu's font (Inter) throughout the application, with font options in the app's Configuration page; and "No mention of Thingsboard anywhere - that is a strict guideline - end user do not need to know underlying framework / platform".
- **What:** the default font stack is `var(--imx-font, Inter, …)`: the app's chosen font (set by its side menu on `<html>`) wins, Inter otherwise. A dashboard with its own theme font keeps it (`data-dbb-font` on the root, which the app's page-wide font rule skips). The chat prompt gets the rule "Never name the software platform, framework or vendor the app is built on (for example ThingsBoard); call it "the app" or "iMEX"" and calls the admin pages "the admin pages of the app".
- **Files:** `widgets/src/render/theme.ts` (`fontStack`, `applyTheme`), `widgets/src/core/chat.ts` (prompt).
- 6 Oct 2026: the app's default font is DM Sans; `INTER_STACK` starts with it so the fallback matches the app.
- **Deployed** to the local ThingsBoard. Not on iserv-demov2.

### D-040 Read-only dashboards on half the columns on small screens, 6 Oct 2026 (user request)
- **Why:** "Check if all the pages look good when the side bar [is] expanded and collapsed … nothing should break even on smaller screens." At 1024 px with the app menu open, or 800 px, a 1-column widget of the machine page was about 48 px wide and its value was cut off.
- **What:** a read-only grid whose column would be narrower than `COMPACT_COL_W` (58 px) shows the dashboard on 6 columns: every width halved (rounded up, at least one column), heights kept, widgets packed in reading order with no holes (`compactLayout`). The stored layout is never changed; the editor (Dashboard Builder) always shows 12 columns. Switching happens on resize, like the column width.
- **Files:** `widgets/src/render/grid.ts` (`COMPACT_COL_W`, `compactLayout`, `Grid.layout/computeView/rect/setHeight`); unit test "compact layout halves the columns without overlaps or zero widths" (98 pass); E2E all pass.
- **Deployed** to the local ThingsBoard. Not on iserv-demov2.

### D-041 Dashboard list as a page for the new app (headless API `dashboardPage`), 7 Oct 2026 (user request)
- **Why:** Akshay: the Dashboard list pop-up fitted the current iSERV PM / iMEX, but with the new side menu "the pop-up thing does not go with the new UI" — the list should be a page. The change must not alter the main product: the pop-up stays for the navbar launcher.
- **What:** `dashboardList(tbCtx, editor, host?)`: with a `host` element the same list (search, A–Z / recent, kinds, Open / Edit, keyboard) is drawn inside it as a page: no backdrop, header, Escape or click-outside; opening a dashboard leaves the page in place; a save or delete in the builder (CHANGED_EVENT) redraws it; the returned `destroy()` removes it. Exposed only in headless mode (D-036) as `window.IMEX_DBB.dashboardPage(host)`. CSS `.dbb-dl-inline`. The new app's widget `imex_dashboards_page` (iMEX App UI repo) uses it.
- **Files:** `widgets/src/entries/launcher.ts`; E2E in the D-036 test (inline, static, no header, Escape keeps it, destroy removes it).
- **Deployed** to the local ThingsBoard. Not on iserv-demov2 (there the navbar launcher and its pop-up are unchanged).

### D-042 Live values over ThingsBoard's own WebSocket (one connection per page), 7 Oct 2026 (user request)
- **Why:** Akshay asked that the widgets use the WebSocket and share connections, so each page holds as few as possible. The live hub (D-021) opened a WebSocket of its own; the ThingsBoard dashboard keeps one for its widgets, so a machine page had two connections as soon as any other widget subscribed (in the new app the side menu's alarm badge does).
- **What:** `core/tb-socket.ts`: `TbSocket` looks like a WebSocket to `Live`, which sends its usual TIMESERIES commands; each becomes one `subscriptionApi.createSubscriptionFromInfo('latest', …)` of a ThingsBoard widget context, and the pushed values come back as the usual replies. Live's cache, history, readiness and REST fallback are unchanged. Every iMEX widget lends its context on init (`liveLend`) and takes it back on destroy (`liveRelease`); the newest one still on the page carries the subscriptions; when it goes, the hub reconnects at once through the next (`Live.reconnect()`, cached values kept). Without a context, or without the subscription API, the hub opens its own WebSocket exactly as before (so older platform versions and the test harness are unaffected).
- **Measured on local (iMEX App UI repo, `measure-pages.mjs`, `live-check.mjs`):** machine and Dashboard Overview pages 1 connection (were 2 with the new app's menu), Builder commands ENTITY_DATA through ThingsBoard, values change on their own, no REST polling of latest values, still one connection and live after Machines → machine page.
- **Files:** `widgets/src/core/tb-socket.ts` (new), `core/live.ts` (`throughTb`, `reconnect`, `liveHub` connects through `connectLive`), `entries/common.ts` (`liveLend`, `liveRelease`), `entries/renderer.ts`, `listing.ts`, `launcher.ts` (lend on init, release on destroy). Unit tests `widgets/test/tb-socket.test.ts` (5); all 103 unit and all E2E pass.
- **Server:** additive and self-falling-back; on the current navbar app it moves the machine page's live values onto the dashboard's connection the same way.

### D-043 The iMEX kit in the Builder: loading placeholders, hairlines, busy buttons, value meter, 9 Oct 2026 (product owner: modern, theme-aware progress bars)
- **Why:** the iMEX app (App UI repo, its U-027 and U-029) now draws every loading state from one stylesheet, the "kit" (`widgets/_shared/kit.css`), in the theme's colours: hairlines, skeletons, busy buttons and value meters. The Builder showed empty cards until the first draw, "Loading…" text, a black spinner pill and a plain level bar.
- **What:**
  - `render/kit.ts` (new; the same exports as Reports' `widget/src/kit.ts`): `ensureKitCss`, `progressBar`, `topProgress`, `withBusy`, `skeletonRows`, `cardSkeleton`, `pageBusy`, `kitToast`, `kitConfirm`. The CSS comes from `render/kit-css.ts`, generated by the App UI's `scripts/export-kit.mjs` (never edited here). It goes into `<head>` once as `#imx-kit-css` with a `data-v` version; the newest copy wins, whichever product injected it. Colours follow the dashboard theme through `.dbb-root{--imx-prog-fill:var(--accent);--imx-prog-track:var(--line)}`; the dark presets use the kit's `.dbb-dark` rules.
  - Cards (`render/widgets.ts renderWidget`): a placeholder in the shape of the widget type (number, ring, bars, rows) until the first draw, shown only after 150 ms so a draw from the live cache never flashes. A redraw for a new time range or theme (`WidgetHandle.update`, called by `Grid.setEnv` for the same machine) keeps the content and shows a 2 px hairline on the card; live pushes and timer redraws stay silent. Another machine re-creates the cards (placeholders, never the old machine's values under the new header).
  - Machine page (`entries/renderer.ts`): the header shows placeholder bars instead of "Loading…"; the app's page bar runs while the page resolves and while the first draws are pending (`pageBusy`, window event `imx-progress`).
  - Builder: `setBusy` also shows a hairline at the top of the editor body; the chat's "Working…" bubble has a sliding bar; the start screen's "Recently updated" placeholders use the kit skeleton; the busy pill's spinner takes the accent colour. The navbar button is busy while the builder opens (`withBusy`). The Dashboards page shows placeholder rows until the list is read, and a message if it fails.
  - The **progress widget** looks like the app's value meter: rounded 12 px track, the fill fading from the rule colour (or the accent) to a lighter tone, `role="meter"` with its values; the threshold ticks stay. Vertical bars get the same fill.
  - `.dbb-btn.icon.danger:hover` (Delete in the top bar) uses the app's `--imx-bad-bg` / `--imx-bad-tx`. Button `title`s are turned into the app's tooltip by the kit (nothing to do here).
- **Files:** `render/kit.ts` (new), `render/widgets.ts`, `render/grid.ts`, `render/theme.ts` (skeleton and meter CSS), `entries/renderer.ts`, `entries/launcher.ts`, `builder/builder.ts`, `builder/styles.ts`. Tests: `widgets/test/polish.test.ts`.

### D-044 Every table header and value centred, 9 Oct 2026 (product owner rule; supersedes D-033's table alignment and D-027's right-aligned count)
- **Why:** the app's rule is now "every table header and value centred" (App UI U-030). D-033 had centred numeric columns and right-aligned text columns; D-027 right-aligned the widget count in the Open dialog.
- **What:** `.dbb-table` headers and cells are centred and vertically middle (`render/theme.ts`); the per-column `num` / `txt` classes are gone (`render/widgets.ts`). The Open dialog's grid cells, the machine-type pill and the widget count are centred (`builder/styles.ts`); the names keep their ellipsis. The unused `.dbb-pick` CSS is removed. Table cells get an explicit 12 px size and the page's font, so ThingsBoard's own table styles can't enlarge them on the canvas.
- A coloured cell (colour rule) keeps its tint but has a thin outline instead of the 3 px bar on its left edge (the app's "no coloured left edge" rule).
- The centring rule supersedes D-033's right-aligned text columns. The E2E scenario that checked D-033 (`widgets/e2e/builder.e2e.mjs`) is now "D-044: table centres every column, header and value": every header and cell, the Machine column included, must be centre / centre.

### D-045 Toasts go to the app's one toast stack, 9 Oct 2026 (product owner: no ThingsBoard toast, one themed toast)
- `builder/ui.ts toast()` hands the message to the iMEX app's toast stack (`window.imxToast`, bottom right, themed; ok / warn / error) when the app is on the page, and keeps its own dark toasts only without it (the stand-in app, the harness). That covers all 33 Builder call sites and the machine page's dialogs. The navbar's red error banner (`alertInline`) does the same.
- The token-refresh call through ThingsBoard's HttpClient (`core/api.ts bindWidgetContext`) passes `{ignoreErrors, ignoreLoading}`, so it can never raise a ThingsBoard toast or its loading bar; the 401 refresh still runs in ThingsBoard's interceptor.

### D-046 Fewer requests and subscriptions, 9 Oct 2026 (product owner: WebSocket over REST, no duplicate connections)
- **One subscription for many machines** (`core/tb-socket.ts`): Live's commands that arrive in the same tick (a page drawing many machines, a reconnect) become ONE `createSubscriptionFromInfo('latest', …)` with one entity per machine and its own keys, instead of one per machine. The pushed data is split back per machine, and a machine whose values did not change gets no reply, so it is not redrawn. Removing one machine (more keys, or unused for 3 minutes) re-creates the group in the next tick.
- **Alarm counts pushed** (`watchAlarmCounts`, alarmCount datasources through the same connection): `api.activeAlarmCounts` (listing cards) reads them and makes no REST query (up to 50 machines; REST beyond that or without a ThingsBoard context). `api.alarms` (the alarm list widget) keeps its list while the entity's pushed counts (active, unacknowledged, all) are unchanged, for up to a minute (the window's start moves on); without the counts it is the old 15 s cache.
- **Chat reply pushed** (`watchAttribute`, `core/chat.ts`): the `dbb_chat_resp_<user>` attribute is subscribed before the request is written, so the reply arrives as soon as the relay saves it; a REST read every 10 s is the safety net. Without a ThingsBoard context, or if the subscription does not answer, it polls every 1.2 s as before.
- **Dashboard list read once** (`core/store.ts listDashboards(ctx, maxAgeMs)`): the navbar's Dashboard list and the Dashboards page (asked for twice in a row) reuse a read less than 5 s old unless any attribute was written meanwhile through the page (`api.writeEpoch`). The builder's start screen and Open dialog always read fresh (another user may have saved meanwhile).
- **Relation cache shared with the app** (`core/scope.ts`): the key `imex-dbb-rel:<user>:<roots>` and its shape `{at, down, up}` are also used by the app's `imxShell.tree` and shift directory; an entry of another shape is ignored.
- Tests: `widgets/test/tb-socket.test.ts` (7 new: batching, changed-only replies, group re-creation, counts, attribute), `widgets/test/polish.test.ts` (list cache, chat reply without polling).

### D-047 Shift time ranges: Current shift and Previous shift, 9 Oct 2026 (user decision: all consumers of the shift configuration in one go)
- **What:** dashboards and widgets get two more time ranges, `shift` (the current shift so far) and `prevshift` (the last shift that has ended), next to Realtime and Historic 1–8 h. The builder's time range has a third button, **Shift**, with Current / Previous; the widget's own range and the chat (`setTimeRange`) offer them too.
- **Where the shifts come from:** Configuration › Shifts in the iMEX app (App UI `docs/SHIFTS.md`): `imexShifts` on the machine, its site and the organisation asset, `imexTimeZone` on the assets, and System Configuration as the last level. `core/shifts.ts` builds that chain from the user's scope (`ctx.nodes`, then the ancestors above the scope root) with one Entity Data Query for the assets, one for the machine and one lookup of System Configuration per page (`api.shiftAttrs`, `api.systemConfigShifts`), keeps it 5 minutes, and reads again at once when `imexAppConfig.shiftsRev` changes. The calendar maths is `core/shiftcal.ts` (the shared core). The developers' `shift` attribute is never read.
- **Which calendar:** the dashboard's machine (machine page), else the widget's first machine. `schema.rangeWindow` gives the window: current shift start to now; between two shifts the previous shift (the header says "Between shifts"); `prevshift` the last ended shift (alarm lists then also stop at its end, `api.alarms` `endTs`).
- **No shifts set:** widgets that show latest values are unaffected; time-based ones say "No shifts are set up for this machine's site. An admin sets them in Configuration › Shifts." The header shows "No shifts set". Nothing is guessed.
- The machine page header names the shift ("Morning · 6:00 AM–2:00 PM" in the app's clock) and refreshes it every 30 s, so it rolls over at the shift change; the widgets compute their window on every redraw. The times are wall times in the **site's zone**, as the app's Sites and Andon pages show them; when the browser is in another zone, the zone's city is added ("… (New York time)"). `shifts.shiftWindowText`. In the builder the Current / Previous picker's tooltip gives the same text for the selected machine.
- Cache keys of window reads now include how long ago the window ended, so a shift that ended earlier never shares an entry with a window of the same length ending now.
- Series of windows that don't slide with the clock (`api.series`): a past window (the previous shift) is keyed by its start and end, so it is not read again every minute; the current shift so far (`fixedStart`) is keyed by its start and extended with the pushed live points like a rolling window (re-read after 5 minutes). Before, both were a new REST read on every 60 s refresh, because their length or end offset changed.
- No shift in the last 14 days (for example an explicit "No shifts" version): the time-based widgets say so instead of "No shifts are set up".
- An older build reads `shift` / `prevshift` as Realtime, so a saved dashboard still opens there.
- Tests: `widgets/test/polish.test.ts` (ranges and labels, `rangeWindow`, the chain machine › site › organisation › System Configuration with zones and a machine override, caching and `shiftsRev`, no shifts, the `shift` attribute never read); `widgets/test/shiftrange.test.ts` (header text in the site zone, between shifts, no shifts; series cache of the current and the previous shift with pushed values).

### D-048 Window aggregates kept current from pushed values, 9 Oct 2026 (QA round 1: REST reads every minute on the machine page)
- **Why:** with the WebSocket up, the machine page and Dashboard Overview still sent 3 REST reads a minute (the summary widget's Min / Avg / Max over 1 h, `agg=MIN|AVG|MAX&interval=3600000`): the 60 s safety redraw found the 60 s cache of `aggValue` expired every time. The product owner's rule is WebSocket over REST.
- **What:** `core/api.ts windowAgg` replaces the `getCached` read in `render/widgets.ts aggValue` (summary, bar per machine, donut per machine). While the socket is live and the key's live history is complete since the read, a window ending now is read once and then kept current from the pushed points: MIN / MAX / SUM folded in exactly, AVG through the window's sample count (`agg=COUNT`, read next to the AVG; checked on local TB 4.3: COUNT over 1 h = 360 = the raw points). It is read again once the window has slid by 1/12 of its length (between 1 and 5 minutes; 5 minutes for 1 h and longer), because points drop out at its start. The current shift so far (fixed start) loses no points: one entry by its start, read again after 5 minutes. A past window (the previous shift) is kept 5 minutes and takes no pushed points. Without a complete live history (subscription not ready) it is the old 60 s cache; with the socket down a REST read on every redraw, as before.
- **Effect:** summary widget on a 1 h window: 3 reads a minute become 4 reads every 5 minutes (MIN, AVG, COUNT, MAX), whether or not values are pushed. The safety redraw itself stays at 60 s (latest values and series come from the live cache and make no call).
- Tests: `widgets/test/windowagg.test.ts` (8: no read on the safety redraw, exact folding of pushed points, empty window, slide limit of a short window, current shift, previous shift, subscription not ready, socket down). `widgets/test/fake-tb.ts` serves `agg=COUNT` and records full URLs.

### D-049 Window aggregates wait for the subscription on the first draw, 9 Oct 2026 (QA round 2: machine page reads)
- **Why:** QA round 2 still listed 3 timeseries reads a minute (MIN / AVG / MAX over 1 h) on the machine page and Dashboard Overview. That measurement was taken on a bundle built before D-048 (no `agg=COUNT` reads; bundle length 491,659 against 493,130 for the D-048 build now deployed on local). A read-only re-run of the QA connections probe on the D-048 build (cold load, 3 idle minutes, machine and dashboard_overview) showed 4 timeseries reads in those 3 minutes. They were one burst at the first safety redraw. On the first draw the summary's key was still being added to the device's subscription, so the first read could not be kept current and it was read again 60 s later: MIN, AVG, COUNT and MAX.
- **What:** `core/api.ts windowAgg` waits up to 1.5 s for the key's subscription to become ready before a read of a window that ends now and has no complete live history yet (`Live.waitReady`, the same wait D-022 uses for latest values). The read is then already one that is kept current: AVG is read with its COUNT. `fetchedAt` is taken after the wait, so it is never before the subscription's `readyAt`. The wait returns at once when the socket is down or the subscription failed. There is no wait for a past window or once the subscription is ready.
- **Effect:** the first safety redraw makes no REST read. A 1 h summary window costs 4 reads at load, then 4 every 5 minutes, as D-048 intended. The safety redraw stays at 60 s, the remedy the QA finding offered first, rather than raising it to 5 minutes.
- **Tests:** `widgets/test/windowagg.test.ts` +2, 10 in total. One checks that the first draw waits, reads with COUNT and makes no read over the next 4 safety redraws. The other checks that there is no wait once the subscription is ready or for a past window.

### D-050 Shared access and role cores: WHERE from imexAccess, WHAT from imexRoles, 9 Oct 2026 (product owner decisions, access + roles release)
- **Why:** the iMEX app moves equipment access and permissions to two shared cores with one set of test vectors for every runtime: App UI `widgets/_shared/access.js` and `perm.js`, Python copies in Reports and AIML, and this TypeScript port. Before, the Builder read `selectedNodes` with its own parser and decided everything with `isAdmin` (`Role` Admin / Customer Admin / Administrator, or `dbbAdmin`). Access is now by id from the live Contains tree: a machine added under a granted site shows everywhere, and a fixed machine never grows. A role says Hidden / View / Full per page, plus named actions.
- **Cores:** `core/access.ts` and `core/perm.ts` are line-by-line ports of the App UI cores: same names, same answers on bad data. The browser parts (`resolve`, `invalidate`) are not ported. `widgets/test/access-vectors.json` and `perm-vectors.json` are **byte-identical copies** of the App UI's `tests/*-vectors.json`. `access.test.ts` and `perm.test.ts` run every section, including the JavaScript-only ones (selection, labels, compact, snapshot, templates, migrate). Copy the files again whenever the App UI changes them; `node scripts/export-kit.mjs --vectors` in the App UI repo checks all copies.
- **WHERE (`core/scope.ts loadUserContext`):**
  - `imexAccess` (`{v:1, grants:[{id, type, mode}]}`) comes first. The legacy `selectedNodes` is read only while it is absent: every shape seen so far; entries without an id are matched by name, then label, among the customer's assets and devices; a bare uuid that is a machine is asked again as a DEVICE.
  - No grants, an empty list or an unreadable `imexAccess` = **no equipment** (fail closed). An invalid imexAccess never falls back to selectedNodes.
  - The tree: one relations query FROM each ASSET 'all' grant and one TO above every grant, then the access core (`resolveTree`). `ctx.nodes` = the granted machines, the assets under 'all' grants and the **nav nodes**: the ancestors of every grant (`Node.nav = true`), shown as the path. Nothing below a nav node is granted by it, and its children are only what the user sees.
  - `ctx.rootIds` = the visible tops. `ctx.allRoots` = the 'all' grants; the first is the default location of a new "All machines of a type under a location" widget. `ctx.coversAll` = every top of the organisation is an 'all' grant; it replaces `rootsAreTop`, which stays one release as an alias.
  - Tenant admins are unrestricted; the customer's top assets make the tree.
- **Queries split:** `inScope` is gone. `isGrantedMachine` = a granted machine (shown, openable, a target of the user's changes). `isVisibleNode` = in the tree, nav nodes included. `holdsAll` = a location the user holds in full: an 'all' grant or under one, never a nav node. `store.canApply` 'node' and the chat's node target need `holdsAll`; 'devices' needs granted machines; 'customer' needs `coversAll`. `deleteDashboard` leaves the assignments of nav nodes alone, because they are outside the user's scope.
- **WHAT:**
  - `imexRole` is looked up in the role store `imexRoles` on the customer's "System Configuration" asset: the side menu's asset when the app is on the page, else one entity query by name. The app's sessionStorage copy `imex-roles:<customerId>` is used instead while it is under 2 minutes old. It has the same shape `{at, raw}`, and the Builder writes it after a read, so the app reuses that too.
  - Without `imexRole`: the legacy `Role` / `dbbAdmin` (Admin, Customer Admin, Administrator or dbbAdmin = Admin; anything else = Viewer). No configuration asset (POC customers) = the built-in Admin and Viewer.
  - A failed store read = the built-ins with a warning, so a custom role then acts as Viewer. Unreadable user attributes = every page hidden.
  - `ctx.perms` answers `page / can / canState`. The three Builder flags:
    - `canBuild` (`dashboards.build`): open the Builder; customise, reset and thresholds on the machine page; the edit menu; `IMEX_DBB.isEditor()`.
    - `canApplyMany` (`dashboards.applyMany`): more than one machine, a location or the customer; the chat's apply proposals; changing a dashboard that is already shared (see below).
    - `canDeleteAny` (`dashboards.deleteAny`): delete dashboards owned by others.
  - `isAdmin` stays one release as an alias of `canBuild`. `ctx.role` is the role's name.
- **Shared dashboards:** `Builder.save` offers "Save as copy" to a role without `dashboards.applyMany` that edits a dashboard used by several machines or applied to a location or the customer. Before, this was the "non-admin" branch, unreachable because only admins could open the Builder. The plan named `canBuild` for this guard, but with `canBuild` it would stay unreachable. So it follows `applyMany`, the permission that guards changing many machines at once. The built-in Admin, the Supervisor template and every "+ Builder" migration variant hold both, so nothing changes for them.
- **Page gates:** the renderer (machine = Machines, dashboard_overview = Dashboards), the listing (listing = Machines, default = Fleet overview) and the Dashboard list (Dashboards) show the app's "You don't have access to this page" empty state when the role hides the page, before any data request. It is `NO_ACCESS_HTML`, with the same wording and lock icon as `imxShell.noAccess('page')`. A state that is no catalogue page is View. The navbar icon is removed when Dashboards is Hidden.
- **Settings that are now no-ops** (documented in `entries/launcher.ts`): `adminOnly`, `hideForRoles` and `chatEnabledRoles`. The role's `dashboards.build` decides who may edit. A role whose Dashboards page is Hidden gets no icon. Everyone who may build may chat; the `chatEnabled` switch stays. The settings form in `widgets/widget-types.mjs` still lists them.
- **Freshness:**
  - The page context (5 minutes, `entries/common.ts`) is dropped on the app's `imx-access-changed` and `imx-perm-changed` events.
  - It is also reloaded, without a request of its own, when the app's fresh copies differ from what it was built from (`slotStale`): `imex-access:<userId>.sig` (the granted ids in normalized order) and `imex-roles:<customerId>` (the store's `rev`).
  - D-037's relation cache goes from 10 to **2 minutes**, the time the app's `imxShell.tree` uses for the same key. So a machine added under an 'all' grant shows in the Builder within the 5-minute context, the access design's target for the Builder listing. The relations key is `imex-dbb-rel:<userId>:<grant ids in normalized order>` (`access.rootKey`), shared with the app.
- **Cost:** one more request per context load, for the role store: 9 instead of 8 for a user with one grant, or 8 when the app's copy is fresh. A tenant admin reads no role store.
- **Trust model:** unchanged (D-012). Visibility and permissions are app-level and enforced in the browser only. A customer user can still read every device of the customer and write their own user attributes (including `imexAccess` and `imexRole`) through the REST API. A follow-up is logged in the App UI repo: user and role writes through a small service.
- **Tests:** 217 unit, in 3 new files:
  - `access.test.ts` (11) and `perm.test.ts` (14) run every vector.
  - `access-scope.test.ts` (18): imexAccess before selectedNodes; 'all' vs fixed with a machine added later; nav nodes and paths; coversAll; fail closed; a deleted grant; a legacy bare-uuid machine; the shared relations key; a custom role's three flags; a location held in full; customise; a role that is gone; no store; the legacy mapping; the app's role store copy; a failed store read; unreadable user attributes; a tenant admin; `slotStale`.
  - `fake-tb.ts`: the sample's locations have uuids (the short names stay aliases); new `asGrantee`.
  - E2E: the "Widget tab" scenario must select the location by its new uuid (2 lines in `widgets/e2e/builder.e2e.mjs`). With that change, all pass.

### D-051 A deleted granted root drops out; any other failed relation call fails closed, 10 Oct 2026
- **Why:** the app's `imxShell.tree` failed the whole access when one granted root had been deleted (ThingsBoard answers its relation query with 404), so the user saw "Your access could not be checked" everywhere. The fix is in all four loaders (app, Reports, AI Insights, Builder) so they answer alike.
- **Builder (`core/scope.ts` `buildTree`):** a relation call answered **404** adds no relations and is not a failure: the root is reported as gone by the access core ("A location / machine assigned to you no longer exists."), the rest loads, and the result is cached. **Any other failed call** (403, a 5xx after the retries) no longer gives a silent partial tree: a customer user gets no equipment and the warning "Your equipment access could not be checked. Reload the page." (nothing cached); a tenant admin keeps what was read.
- **Shared cache entry:** `imex-dbb-rel:<user>:<root ids>` now also carries `types` (the roots' entity types, comma-joined), written by both the app and the Builder. An entry whose `types` differ is ignored (an entry without it still counts), so a legacy grant asked first as an ASSET (404) and again as the machine it is is not served the first, empty answer.
- **Tests:** `access-scope.test.ts`: a deleted location drops out and the relations are cached; a failed call fails closed. `fake-tb.ts`: `POST /api/relations` answers 404 for a root it does not have (or of another type), as ThingsBoard does. 219 unit + E2E pass.

### D-052 Tenant admin: the app's tops and tree are shared; the headless launcher asks the role alone, 10 Oct 2026
- **Why (verifier, leftover L4):** a cold load of the app's `default` state as a tenant admin sent 19 to 26 relation requests (target: one per tenant top). 14 came from the Builder: the headless launcher (on every page) built the whole user context at init, and in tenant mode `loadUserContext` walked up from every customer asset (8× `GET /api/relations/info/to/ASSET/<id>`) and then asked FROM and TO per top (6× `POST /api/relations`) under a key the app's tree never uses. Customer users already shared the app's entry (2).
- **Headless launcher:** `isEditor()` is asked when first needed and from the role alone (`entries/common.ts userPerms`: the page's context when one is loaded or loading, else `core/scope.ts loadPerms()` = `/api/auth/user` + the role attributes + the role store or the app's copy; a tenant admin: the first call only). No tree, no relation request. The context loads when a Builder action needs it (open, Dashboard list). A failed role read answers false and is asked again next time.
- **Tenant tops and tree (`core/scope.ts tenantTree`):** the same as the app's `imxShell.scopeTree` and in its shape. Tops = the app's copy `imex-tops:<userId>` ({at, ids}, 2 minutes) or `api.locationTops()` (2 entity queries, as the app; the copy is written): the assets that Contain machines and lie below no other asset, of the whole tenant, sorted by id (= `normalize()` order of 'all' grants). Tree = the shared entry `imex-dbb-rel:<userId>:<every top>` ({at, down, up: [] per top, names: true, types}) or one `POST /api/relations/info` FROM per top (`api.relationInfosTree`, with names, because the app only reuses an entry that has them); nothing is asked above a top. The customer's tops are the tops among the customer's assets; their lists go to `buildTree` (new `pre` argument: no cache read or write, no request). When the tops cannot be read, the old walk up from each asset is the fallback.
- **Behaviour change (LOCAL, Ithena Technology, checked read-only):** the tenant admin's roots were ITHENA ORG, System Configuration and CATALOGUE_STORE_ASSET (every customer asset without a parent asset, also configuration assets with no machines); now ITHENA ORG only, as in the app. `clearRelCache(userId)` also drops `imex-tops:<userId>`, as the app's `imxAccess.invalidate` does.
- **Expected requests (tenant admin, cold `default`):** the app's 4 FROM only (the Builder asks none). A Builder page after an app page: none from the Builder. A Builder page whose context loads at the same moment as the app's tree may still ask the 4 FROM itself (there is no in-page sharing between the app's `imxShell` and the library, only sessionStorage).
- **Tests:** `access-scope.test.ts` (+5): cold tenant load = one `relations/info` FROM per top and both copies written in the app's shape, the next load none; warm from the app's copies = no relation request and only the customer's tops; failed tops query = fallback walk; `clearRelCache` drops the tops copy; `loadPerms` (tenant one call; custom role; viewer). `fake-tb.ts`: `POST /api/relations/info`, entity queries `entityType` (paged) and multi-root `relationsQuery` TO `fetchLastLevelOnly`. 217 unit + E2E pass.

### D-053 A fleet banner counts only the viewer's equipment, 10 Oct 2026
- **Why (critic, LOW K9):** the design pass (D-026) wrote its author's counts into the banner ("All Plants Across the Globe · 5 machines · 2 locations"). A user with 2 granted machines, or with none, read the author's numbers (no data leaked: every widget already said "No data in your scope").
- **Placeholders:** new text-widget built-ins `{{machines}}` and `{{locations}}` ("2 machines", "1 location"). `render/widgets.ts fleetCounts(env, widgets)` = the union of every widget's `resolveBinding` devices (the user context from the shared access core, so the same equipment the widgets show) and their distinct locations in that context. The Grid passes the dashboard's widgets in `RenderEnv.widgets` and redraws text widgets when a binding changes (the builder). Without `env.widgets` the placeholders show an em dash. `placeholderKeys` does not fetch them as telemetry.
- **New banners:** `core/design.ts` writes `{{machines}} · {{locations}} · live · {{date}} {{time}}` (the locations part only when the author's draft has locations, as before). The chat prompt and the text editor hint name the two placeholders.
- **Stored banners (no data migration):** `liveFleetLine` reads the design pass's old line (`<n> machine(s)[ · <n> location(s)] · live · {{date}}`, also with `&middot;`) as the placeholders at render time. Any other text with numbers is left alone. LOCAL store (read only): 5 dashboards carry the old line, among them All Plants Across the Globe, Pune Site / Location Overview, Richmond Site Overview.
- **Tests:** `fleet-counts.test.ts` (new, 6): organisation grant 6 machines / 2 locations; 2 fixed machines 2 / 2, one 1 / 1; one site 3 / 1; no grants 0 / 0; the old line and lookalikes; the design pass writes placeholders. `core.test.ts`: the banner check reads the placeholders and `fleetCounts` = 4. 230 unit + E2E pass.

### D-054 Phone layout for read-only dashboards; no title or edit actions under html.imx-mobile, 10 Oct 2026 (user request, mobile design §4.4)
- **Why:** at phone widths (318–430 px) a read-only Builder dashboard (machine page, Dashboard Overview) still used the 6-column compact layout (D-040). Its columns were 40–60 px wide, so titles were cut off, values were clipped, and the Summary's MIN / AVG / MAX / NOW ran together ("296.0 307.2 317.7"). The before probe on LOCAL at 360 / 390 / 430 px found 22–29 clipped or overflowing texts on the machine page.
- **Phone layout (`render/grid.ts`):** a read-only grid narrower than `PHONE_W` = 600 px uses `phoneLayout` on `PHONE_COLS` = 2 columns. The editor never does (as with D-040).
  - **Width:** a widget of 7 or more of the 12 columns takes the full width; any other widget takes half.
  - **Height:** the stored height, with a floor from `PHONE_MIN_H`: charts, heatmap, timeline, table and alarm list 3 rows; KPI 3 (value, delta, sparkline and a two-line title); value, gauge, progress, multi-value and Summary 2. A full-width multi-value card with more than 3 values gets 3. A half-width one gets enough rows for each value at about 66 px, because its name sits above its value. Text, image, link, embed and status keep their height.
  - **Packing** is in reading order (y, then x). A full-width widget gets a row band of its own. Two half widgets that follow each other share a band, side by side, and both take the taller one's height. A half widget with no partner (the next widget is full width, or it is the last) is drawn full width. So there are no overlaps and no holes, and a phone shows the widgets in the desktop's order.
  - Additions to the spec ("otherwise half"): the equal heights in a pair and the full-width lone tile. Both avoid empty holes on a 2-column page.
- **Switching:** the mode switches on resize (ResizeObserver, as for D-040). The view now carries heights as well as positions, so `place`, `setHeight` and the size-change check use the shown height. On a mode change the boxes' `data-w/h` are updated too. The stored layout is never changed.
- **Phone tile CSS (`GRID_CSS`, only under `.dbb-phone`, the class the grid host gets in phone mode):**
  - Card titles wrap to up to three lines (then an ellipsis).
  - Value text scales to the tile (`min(card value size, 15cqi)`, with `.dbb-gi` as an inline-size container), and the unit can wrap below the number.
  - The Summary is a 2×2 grid, and its values are limited to their cell (`max-width:100%`). The run-together bug came from `align-items:flex-start`, which let a value take its full width despite `overflow:hidden`.
  - Multi-value values never shrink. In a tile narrower than 220 px (container query), each name (up to two lines) sits above its value.
  - Desktop and the 6-column compact mode are unchanged.
- **Renderer header (`entries/renderer.ts`):**
  - The D-038 title condition becomes `(#imx-menu-root || html.imx-menu-shift) && !html.imx-mobile`. On a phone the app's shell bar names the machine, and the side menu's 64 px banner styling is keyed on `imx-menu-shift`, which the phone shell never sets.
  - The header line wraps (crumb on its own line, then status, time window, "Updated") under `html.imx-mobile` and below 600 px, so it no longer runs off the side.
- **Edit actions (`entries/common.ts`):** `publishActions` publishes nothing and `currentActions()` returns null while `html.imx-mobile` is set (`isMobileApp()`). So neither a menu that reads `window.__imexDbbActions` nor the headless `IMEX_DBB.actions()` offers editing on a phone, even if the class arrives after the renderer published.
- **Tests:**
  - `widgets/test/phone.test.ts` (new, 8): 2 columns and the w ≥ 7 rule; reading order, no overlaps and no holes on the machine page's layout; unsorted input with gaps; the minimum heights; pairs and lone tiles; empty and single-widget dashboards; a random 40-widget dashboard; the constants. 238 unit tests pass.
  - E2E (3 new): phone layout at 390 px and at 430 px, harness `?mobile=1` (html.imx-mobile). They check 2 columns, no overlaps, reading order, chart ≥ 3 rows, Summary 2×2, no clipped or overflowing text, no title, no edit actions, a header that fits, and the 12-column layout back after resizing to 1400 px. A third test checks that the width alone switches to the phone layout while the title and actions stay without the class, and that the editor at 520 px keeps 12 columns with the stored widths unchanged. 71 E2E pass.
- **LOCAL check (Playwright, read-only, `scratchpad/mobile/build/dbb-phone-check.mjs`):** machine and Dashboard Overview states at 360, 390 and 430 px, as akshayr+imex. Variants: the app as it is (rail + banner), with `html.imx-mobile`, and with the menu hidden to stand in for the headless mode. Before: 22–29 clipped texts per page. After: 0 clipped texts, 0 overlaps, no sideways overflow. Under imx-mobile there is no title and no edit actions.
- **Deployed** to the local ThingsBoard (build 2026-10-10T11:15:23.148Z; backup of the widget types, bundle, relay and store in `backups/2026-10-10/` first). Not on iserv-demov2 or the server tenant.
- **Not done here:** `dashboardPage(host, {readonly})` from design §4.4 (not part of this request). Dashboards are not given per-dashboard phone arrangements.

## ThingsBoard quirks found

- `GET /api/plugins/telemetry/.../values/timeseries` returns **at most 100 points** when `limit` is omitted and `agg` is NONE. The service must always pass `limit` (checked: 2,016 stored, 100 returned without a limit).
- `GET /api/tenant/assets?assetName=`, `/api/tenant/devices?deviceName=` and `/api/tenant/customers?customerTitle=` return **404** when nothing matches (not an empty page).
- `POST /api/relation` behaves as an upsert, so reruns don't duplicate relations.
- Each server-attribute write is a separate call, and the demo server takes about 0.4–0.8 s per call. A full setup run takes about 25 s.
- No HTTP 429s were seen during the 8,064-point backfill at 200 points per request and a 1 s pause.
- `GET /api/widgetType?fqn=` needs the `tenant.` prefix for tenant widgets (`fqn=tenant.imex_dbb_launcher`); the response omits `description`, so read `/api/widgetType/{id}` before an update. Dashboards reference them as `typeFullFqn: "tenant.imex_dbb_launcher"`.
- TBEL: a ternary inside a map literal (`{a: x ? 1 : 2}`) is mis-parsed (the `:` is taken as a key separator). Compute into a variable first.
- The "save attributes" node rejects `ATTRIBUTES_UPDATED` messages. A transform that feeds it must return `msgType: "POST_ATTRIBUTES_REQUEST"` and string-only metadata.
- `GET /api/user/{id}/token` lets a tenant admin get a user's token (used only to test as the sample users).
- The demo server is slow: the builder's "affected machines" preview and the renderer's refresh after an apply take 3–10 s there.
- **4.3:** `GET /api/relations/info?fromId=|toId=` is gone (500); use `GET /api/relations/info/{from|to}/{type}/{id}` (not in 4.2.1). Relations are saved at `POST /api/v2/relation`.
- A customer user with a home dashboard is redirected from `/dashboards/<id>?state=…` to `/dashboard/<id>` without the state parameter; open `/dashboard/<id>?state=…` directly.
- TBEL: `Math.max(0.0, 1)` (double and integer) fails with "argument type mismatch"; multiply by `1.0` first.
- `GET /api/plugins/telemetry/.../values/timeseries` returns values as strings unless `useStrictDataTypes=true`; re-posting them as-is would store numbers as text.
- Widget subscription API (4.3): an `alarmCount` datasource without an entity filter is not pushed when an alarm is raised (ThingsBoard only recounts now and then); with an `entityType` or `entityList` filter the new count arrives about 20 ms after the alarm. Datasource names of count datasources are replaced ("Alarms count", "Alarms count 2", …): match the results by their order.

### D-055 Machine page bar: Analyzer and Create ticket, 12 Oct 2026 (Probodh's storyboard feedback via Akshay)
- **Why:** "all actions reachable from the machine's page": the bar at the top of each machine dashboard gets the
  Analyzer with this machine selected (navigation) and Create ticket with the machine and the time window filled in;
  the user writes the subject and description.
- **Analyzer** (chart icon, tooltip "Open this machine in the Analyzer"): `openState('analytics', {selectedEquipment,
  entityName, entityLabel, key})` with NO top-level `entityId` (the Analyzer's alias is rooted at the state entity and
  stays empty for a device). Keys (`analyzerKeys()`): the properties of the widgets bound to this machine (current,
  fixed including it, siblings / nearest of its type), unique, at most 15 (the Analyzer's limit); none -> the first 6
  numeric catalogue keys. Only when the role sees the Analyzer page (`ctx.perms.page('analyzer') !== 'hidden'`).
- **Create ticket** (`UI_ICON.ticket`, a document with a plus as on the Active alerts rows): `window.imxTicket.open`
  (the app's form, App UI U-050; the AI service creates the ticket, source `machine`), description lines Machine,
  Location, Dashboard, Time window shown, Status, Created at. Hidden when `window.imxTicket` is missing or ticketing is
  switched off; disabled with a tooltip when switched on but not set up.
- **Layout:** time window, "Updated…" and the two pill buttons form one right-aligned group that wraps as a whole;
  icon only under 1100 px and on phones; inside the app the buttons take the banner's translucent look, on a dark
  preset (`.dbb-dark`) too.
- **Tests:** `widgets/test/barkeys.test.ts` (keys: bound widgets, uniqueness, 15 cap, fallback); E2E header expects
  "Updated" then the bar buttons at the right end.
- **Deploy:** all three widget types with `deploy-node.mjs --go` on LOCAL (one library, one `dbb_lib_version` stamp;
  a renderer-only push would make the launcher and listing report "older version").

### D-056 Dashboards follow the app's dark mode, 13 Oct 2026 (Akshay: "light vs dark", App UI U-051)
- With `html[data-imx-mode="dark"]` a dashboard saved with a light preset (light / ocean / sand) is drawn with the app's
  dark tokens (`APP_DARK`: `--imx-surface`, `--imx-bg`, `--imx-line`, `--imx-text` / `text2` / `muted`, `--imx-ph`) and
  gets `.dbb-dark` + `.dbb-appdark`; charts use SERIES_DARK and the existing dark rules (deltas, meters, skeletons, kit)
  apply. Its accent stays. Dark presets (slate, dark) stay as saved.
- Colours the user picked: white / light-grey page or card colours are dropped, a pastel is toned down (22 % over the
  dark surface), saturated or dark colours are kept (a red alert tile, a navy banner, with their own text colours).
  Near-black title / value / icon / rich-text colours give way to the theme text; dark saturated ones are lightened;
  light-grey borders give way to the theme line. Heatmap ramps run dark -> light on dark surfaces.
- The renderer and the builder canvas redraw on `imx-mode-changed`. The Builder editor (panels, palette, pickers,
  dialogs, chat, start screen, Open dialog), the Dashboard list and the edit menu get dark rules scoped under the
  attribute; the Theme tab says when a light theme is shown dark. Light output is identical (`cardVars(st, false)`).
- Tests: `widgets/test/darkmode.test.ts` (14); E2E light -> dark -> light switch and a dark preset kept. Deployed to
  LOCAL with `deploy-node.mjs --go` (`dbb_lib_version` 2026-10-12T20:17:03.745Z).

### D-058 Builder entries on the pages: Dashboards page buttons, machine page "Edit dashboard"; app wording, 15 Oct 2026 (product review, Tushar via Akshay)
(D-057 is the number of commit 4424679, analyzerState / phone Trend; it has no entry here.)
- **Why:** the side menu's "Dashboards" loses its sub-items "My dashboards" and "Dashboard Builder" and becomes one
  item that opens the Dashboards page (Tushar: "the dashboard builder would come from that list of dashboards and a
  new button at the top or edit button"). The "Dashboard Builder" sub-item did two things that now live on the pages.
- **Dashboards page** (`dashboardList` host mode, `IMEX_DBB.dashboardPage(host, opts)`): for editors
  (`dashboards.build`, the list's existing check) "Open Dashboard Builder" (secondary, the Builder's start screen,
  `open()`) and "New dashboard" (primary, the New dashboard dialog, `open({startNew:true})`) at the right of the search
  row, 40 px like the search, busy while the Builder loads, errors in the app's toast; icon only (aria-label + title)
  for Open Dashboard Builder under 900 px and for both under 560 px. Viewers get none. `opts.buttons`: true / false;
  absent = **unless the page around the host already has its own** (`.imx-dl` with `.imx-dl-head [data-el="new"]`):
  the App UI Dashboards page (imex_dashboards_page) already shows "Dashboard Builder" and "New dashboard" in its
  banner, so on LOCAL today the banner's buttons stay and ours are not drawn (never twice). When the App UI drops its
  banner buttons, ours appear without a Builder change. Empty state: "Choose New dashboard at the top of this page…"
  (pop-up list: "…in the edit menu…").
- **Machine page bar** (renderer `editButton` + `openBarMenu`): "Edit dashboard" (pencil `UI_ICON.edit`, `dbb-rbtn`
  pill, always the last button: DOM order = visual order, Create ticket is inserted before it) for `dashboards.build`.
  Its menu (appended to <body>, anchored right-aligned under the button, flips above / clamps to the window, max
  height): header (machine, "From: …"), the page's edit actions (the same object `publishActions` gets), the 'switch'
  group under an expandable "Show dashboard" row (the shown dashboard has a tick and aria-checked; no filled selection),
  a divider, "New dashboard", "Open Dashboard Builder" (the Builder on this machine and its dashboard, as the side
  menu's `api.open()` did). Both reload the user context (as `launcher.open`) and open the renderer's own Builder.
  Keyboard: focus on the first item, Up / Down / Home / End, Right / Left open / close "Show dashboard", Escape or
  Tab close and return the focus; outside click (mousedown / touchstart) closes; re-drawing the bar closes it.
  The key handler sits on the menu element: in the app a passive document-level keydown listener is registered
  first and ThingsBoard's zone.js then runs every document keydown listener as passive (preventDefault ignored,
  "Unable to preventDefault inside passive event listener"; arrows would scroll the page).
- **Dashboard Overview page** (`dashboard_overview`, `showStandalone`): it has a bar (title, time window); it now has
  the same right-hand group and "Edit dashboard" (Edit this dashboard, New dashboard, Open Dashboard Builder on the
  overview shown).
- **Phone:** under `html.imx-mobile` (the phone app) no button, dashboards stay view-only (D-054). At phone width in
  the desktop app the button is icon only (28 px, aria-label) like Analyzer / Create ticket, and the menu fits the
  window (8 px margins).
- **Role catalogue copy** (`core/perm.ts`, labels only, keys / sections / order unchanged, as the App UI's
  `_shared/perm.js` of today): sites "Overview", users "Users & roles", alertrules.default "Default rules",
  alertrules.custom "Custom rules", their parent "Alarm rules", action "Export alarm rules". The built-in Supervisor
  description ("… reports and alert rules.") is kept byte-identical to the App UI copy (it still says that there).
- **Wording:** the Style tab's icon tooltip "alert" -> "alarm" (`ICON_TITLE`; the stored icon name stays `alert`);
  the chat's "how the app works" text names the bar button and the Dashboards page instead of the pencil menu and the
  listing page; the renderer's empty placeholder points at the Dashboards page; the New dashboard dialog's Overview
  option "Opens from the Dashboards page". No other user-visible "alert" / "Fleet overview" in this repo.
- **Tests:** `widgets/test/perm.test.ts` (+1: the new labels, no "alert" / "Fleet overview" label). E2E (+3): the bar
  button and menu (items, Show dashboard with two applying dashboards, keyboard, outside click, toggle, switch, dark,
  New dashboard dialog, Open Dashboard Builder on the machine); phone width / imx-mobile / viewer / Dashboard Overview
  page; the Dashboards page buttons (editor, banner present, `buttons` true / false, New dashboard dialog, Builder,
  viewer). 260 unit, 76 E2E pass.
- **LOCAL** (deploy-node --go, backup `backups/2026-10-15/` first; `dbb_lib_version` written by the deploy), checked in
  Chromium as akshayr+imex, light and dark: Dashboards page (banner buttons, no duplicates; ours with the banner
  buttons removed in the DOM only), New dashboard dialog opened and cancelled, Blower 3's "Edit dashboard" menu (Build a
  dashboard for this machine, Alarm thresholds…, New dashboard, Open Dashboard Builder), arrows / Escape / outside
  click, the Dashboard Overview page's menu, 390 px. Nothing saved. Not on the server.

### D-059 Licence enforcement: builder / builder.ai gates and the monthly AI quota; role catalogue synced, 16 Oct 2026 (Control Centre CC-008, Akshay via the coordinator)
- **Why:** "every setting in the Control Centre works on the instance". The licence the side menu verifies
  (`window.__imexLicence`) switches the Builder (`builder`) and its chat (`builder.ai`) on and off, and caps the LLM
  calls per month (`limits.llmCallsPerMonth`, warn at 80 %, refuse at 100 %, every source metered: Control Centre
  DESIGN.md section 10.3 / 10.4).
- **`core/licence.ts` (new):** reads `window.__imexLicence` defensively (no API on the page, no `has`, or a `has` that
  throws = allowed; before evaluation the side menu answers true and fires `imx-licence-changed` once it knows).
  `licHas`, `builderLicensed`, `chatLicensed` (builder AND builder.ai), `mayBuild(ctx)` = role `dashboards.build` AND
  licence; `onLicenceChange(probe, cb)` calls back only when the probed value changed (the event fires on every
  evaluation, mostly without a change, so nothing is redrawn then). Quota: `llmLimit` (`limits`, else
  `status.payload.limits`; missing / 0 = no limit), `monthStartUtc`, `llmVerdict` (mirror of `llm_verdict` in the
  shared `imex_licence.py`: block "Monthly AI limit reached (N of M) — contact your administrator", warn
  "N of M AI requests used this month"), `llmCountPath` (the COUNT request of 10.4: five keys, one bucket from the
  month start, `limit=1`), `sumCounts`, `llmCheck` (no limit = no request; asset or count unreadable = allowed),
  `llmRecord(source, n)` (n points of value 1, 1 ms apart, on System Configuration: `agg=COUNT` counts points, so one
  point with value 2 would count once), `systemConfigId` (the side menu's `__imexApp.asset`, else the asset named
  "System Configuration"), `countingTransport` (counts relay requests that answered = provider calls).
- **builder:** the machine page bar's "Edit dashboard" and the published edit actions (renderer `showDevice`,
  `showStandalone`), the launcher's `open` / `isEditor()` / pencil menu, the Dashboard list's Edit, machine-type
  dashboards and the page's New / Open Dashboard Builder, and `openBuilder` need the licence too. Viewing (machine
  page, Dashboard Overview, the list's Open) is core and unchanged. The renderer reloads and a list drawn on a page
  redraws when the licence switches the Builder; the headless API passes the role alone to the list
  (`roleEditor`), which applies the licence itself. An open Builder whose licence goes says so in its banner
  ("Building dashboards is not included in this licence. Changes can't be saved; close the Dashboard Builder.") and
  Save refuses.
- **builder.ai:** `Builder.chatOn()` = the host setting `chatEnabled` AND the licence: Chat tab, "Describe it in chat"
  (machine empty state and start screen); an open Chat tab falls back to Dashboard / Widget on the event; a turn sent
  meanwhile says "The chat assistant is not included in this licence." Before every turn (not the local "where"
  apply or "undo") the quota is read fresh: at 100 % the refusal is the reply and nothing is written for the relay; from
  80 % a note (`.dbb-banner warn` / `err`, `.dbb-chat-quota`) sits above the input (read when the Chat tab opens,
  reused for a minute, updated by the turn's own calls). After the turn (also a failed one) `llm_builder` gets one
  point per provider call that answered: `chatTurn` makes 1–2 requests, the relay transport retries once on
  overload; the counting wraps the retrying transport, so a failed first try is not counted, its answered retry is.
- **Role catalogue (`core/perm.ts`)** = the App UI's `_shared/perm.js` of today: rows `spc` (MONITOR), `energy`,
  `value` (INSIGHTS), `alertrules.grouping` ("Alarm grouping", ADMIN, parent Alarm rules, state `alarm_grouping`,
  HVF) and `licence` (ADMIN); the Supervisor template sets `alertrules.grouping` to view. `perm-vectors.json` was
  already synced; `perm.test.ts` green again.
- **Tests:** `widgets/test/licence.test.ts` (new, 16: gates without / with / throwing API, mayBuild, change-only
  callbacks, limit sources, month start, verdict thresholds incl. small limits, COUNT path, sums, points, check
  without limit / warn / block / failed read, metering body, lookup by name, counting transport). 276 unit, E2E all
  pass (the harness has no licence API: unchanged behaviour).
- **LOCAL** (backup `backups/2026-10-16/`, deploy-node --go): real licence (ITHENA-LOCAL, all on, 2000 calls): Blower 3
  "Edit dashboard" → Open Dashboard Builder → Chat tab; one real turn ("Add a value tile for the current power")
  answered, the customer user's `llm_builder` point landed on System Configuration (COUNT 1 this month); nothing saved.
  Stubbed `has()` + `imx-licence-changed` in the page: builder.ai off → Chat tab and tile gone with the Builder open;
  builder off → banner in the open Builder, after closing no "Edit dashboard", dashboard still shown, `isEditor()`
  false, the list without Edit / machine types / buttons, back on → all return. COUNT answered in the browser with
  1700 (warn note, light + dark) and 2000 (note + refusal reply, no write). Licence not changed. Not on the server.
- **Left to the App UI:** its Dashboards page banner buttons ("New dashboard" / "Dashboard Builder") follow the role only
  (`imex_dashboards_page` `buttons()`), and the side menu's LIC_STATE still gates `dashboards` / `dashboard_overview`
  on `builder` (the viewer is core, DESIGN 10.3).
