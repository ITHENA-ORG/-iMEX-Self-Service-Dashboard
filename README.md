# iMEX Self-Service Dashboard Builder (POC)

Customer users build their own machine dashboards **inside ThingsBoard CE**, by drag and drop or by chatting with Claude. There is no external service: the builder, the renderer and the chat relay are ThingsBoard widgets and a rule chain. See `DECISIONS.md` for why and for every deviation from the original build instructions.

**Setting this up on our own ThingsBoard? Start with [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).**

## Status

| Part | State |
|---|---|
| ThingsBoard sample data, simulator, teardown (Phase 1) | done on demo.thingsboard.io (CE 4.3.0.3) |
| Dashboard Builder widgets, renderer, stand-in app (Map → Machines → machine) | deployed and tested live as admin and viewer |
| Chat relay rule chain (Claude / OpenAI / Gemini, picked from the key) | deployed; scripts tested on ThingsBoard's TBEL engine for all three providers; **needs your API key on DBB-LLM-CONFIG** |
| Live values over the ThingsBoard WebSocket (REST fallback) | see D-021 |
| First page load in a fixed number of calls (machine page 49 → 17, Map 44 → 14, Listing 46 → 15 on the demo) | see D-022 |

## How it works

Everyone is a ThingsBoard customer user. Scope comes from the user attribute `selectedNodes`, role from `Role`.

1. **Map page** (home) → button → **Machines** listing (hierarchy + machine cards) → click a card → **machine page**. The navbar has Map and Machines links and a breadcrumb.
2. **Admins** (`Role` = Admin) see one **edit (pencil) icon** in the navbar. Its menu holds every editing option: *Dashboard Builder* and, on the machine page, *Edit this dashboard*, *Customise for this machine*, *Reset to shared dashboard*, *Alarm thresholds* and *Show dashboard* (switch between the dashboards that apply). The pages themselves show no edit controls.
3. The admin picks a machine and builds by drag and drop, or asks in the Chat tab ("add a power chart for the last 8 hours and the site weather station's temperature").
4. **Save.** The admin is then asked where it should show: only this machine, or all machines of the same type. From then on every user of that customer who opens those machines sees it.
5. **Everyone else only views.** No builder, no edit controls.

## Builder rules and limits (27 Sep 2026)

| Rule | Why |
|---|---|
| At most **10 widgets per page** | load time on the machine page |
| At most **4 properties per widget**, at most 4 specific machines, at most 8 lines in one chart | load on the server |
| **Time range**: *Realtime* (latest values pushed over the WebSocket; charts show a rolling last hour) or *Historic* 1 h / 2 h / 4 h / 8 h (refreshed every 60 s) | nothing longer than 8 h; dashboards saved earlier with 24 h / 7 d / 30 d open as 8 h |
| **Property kind vs widget**: gauge, KPI, level bar, min/avg/max, line, area, bar, heatmap need a number; status and state timeline need on/off or text states; value, multi-value and table take anything | impossible combinations are greyed out in the builder (hover for why) and rejected from chat and on save (`widgets/src/core/compat.ts`) |
| **Alignment**: values and labels left / centre / right and top / middle / bottom; title above or below | Style tab → Layout |

Older dashboards that break a limit still open; they can't be saved until trimmed, and the builder says what to fix.

## Code layout

| Path | What |
|---|---|
| `widgets/src/entries/launcher.ts` | navbar widget with the edit menu (`tenant.imex_dbb_launcher`) |
| `widgets/src/entries/renderer.ts` | machine dashboard widget (`tenant.imex_dbb_renderer`) |
| `widgets/src/entries/listing.ts` | Map and Listing pages of the stand-in app (`tenant.imex_dbb_listing`) |
| `widgets/src/builder/` | the full-screen Dashboard Builder (opened from the edit menu) |
| `widgets/src/render/` | widget drawing, charts, themes, templates, colour rules, rich text |
| `widgets/src/core/` | schema, limits, compatibility rules, store, scope, chat, REST client |
| `widgets/widget-types.mjs` | ThingsBoard names, sizes and settings forms of the 3 widget types |
| `widgets/dist/widget-types/imex_dbb_*.json` | **built, importable widget types** (Widgets library → Widgets → + → Import widget), one per widget |
| `widgets/dist/imex-dbb.js`, `glue.json` | the shared library and per-widget controller glue used by `widgets/deploy/deploy-browser.js` |

## One-time setup in your own ThingsBoard

1. **Build:** `npm install && npm run build:widgets` → `widgets/dist/imex-dbb.js` and `glue.json`.
2. **Deploy:** in a logged-in tenant-admin page, set `window.__dbbLib` to the contents of `imex-dbb.js` and `window.__dbbGlue` to `glue.json`, paste `widgets/deploy/deploy-browser.js`, then run:
   ```js
   await DBB_DEPLOY({
     customerTitle: 'UCA',                 // your customer
     storeName: 'DBB-STORE-UCA',           // one DashboardStore asset per customer
     profileKeys: { Compressor: [{ key: 'dischargePressure', displayName: 'Discharge pressure', unit: 'bar', decimals: 2, min: 0, max: 10 }] },
     userEmails: [],                       // leave empty in production (it sets home dashboards)
   });
   ```
   Repeat per customer (it creates a store asset for each). `profileKeys` is the catalogue shown in the builder and given to the LLM; keys not listed are still usable, just without nice names and units.
3. **API key:** Assets → **DBB-LLM-CONFIG** (tenant-owned; created by the deploy script; never assign it to a customer) → Attributes → Server attributes → set `dbb_llm_api_key` to a Claude (`sk-ant-…`), OpenAI (`sk-…`) or Gemini (`AIza…` or the newer `AQ.…`) key. The relay picks the provider from the key; swap providers by replacing it. Optional model per provider: `dbb_llm_model_anthropic` / `_openai` / `_gemini`. Re-deploys keep all of these.
4. **Put the button in your real app.** Two options:
   - Add the widget **iMEX Navbar / edit menu** (bundle "iMEX Self-Service (POC)") to your app's header state. Its edit icon shows only for `Role` = Admin (setting `adminOnly`); with `navbar` off it renders only the icon, or
   - keep your own header button and call `window.IMEX_DBB.open({ deviceId })` from its action. That function is registered by the launcher widget, so the launcher widget must also be on the page (a small cell is enough).
   - In the iMEX app the launcher runs headless (setting `headless`): `window.IMEX_DBB` = `open(opts)`, `newDashboard()`, `dashboardList()`, `dashboardPage(host, { buttons })` (the Dashboards page; editors get "New dashboard" and "Open Dashboard Builder" at its top unless the page has its own, D-058), `isEditor()`, `actions()`.
5. **Show the dashboards:** put the **iMEX Machine dashboard** widget in your machine-detail state. It reads the machine from the dashboard state entity, as the stand-in app does. For a role that may build dashboards its page bar has **Edit dashboard** (D-058): the page's edit actions, New dashboard and Open Dashboard Builder.

The stand-in app on the demo is the dashboard **iMEX App (POC)** (home dashboard of the three sample users).

## Sample data (Phase 1)

- Customer **ITHENA**, hierarchy ITHENA-ROOT → SITE-RICHMOND (RIC-COMP-01, RIC-DRY-01) and SITE-PUNE (PUN-COMP-01, PUN-WS-01), all `poc=true`.
- Device profiles Compressor, Dryer, Weather Station, each with a dynamic-threshold alarm and clear rule.
- Three customer users: an admin (whole tree), a Richmond manager and a Pune viewer, with `selectedNodes` and `Role` in the production format.

```bash
cp .env.example .env      # fill TB_URL, TB_TENANT_USERNAME, TB_TENANT_PASSWORD yourself
npm run setup:tb          # idempotent
npm run backfill          # 7 days at 5-min intervals
npm run simulator         # live telemetry every 10 s
npm run teardown          # lists every POC entity (incl. widgets, dashboard, rule chain), deletes after you type DELETE
npm test                  # 260 unit tests (store, scope, first-load call counts, chat ops, providers, live WebSocket, rules, limits, compatibility, generator)
npm run test:e2e          # 76 end-to-end scenarios of the builder and machine page in Chromium (fake ThingsBoard, D-023, D-026)
node widgets/e2e/bench.mjs 5 60   # worst-case load test: 5 tabs, 40 machines, every value every second (D-028)
npm run typecheck
```

The same scripts can run inside a logged-in ThingsBoard page: `npm run build:browser`, paste `scripts/output/poc-browser.js` into the console, then use `POC.setup()`, `POC.backfill()`, `POC.startSimulator()` and so on.

## Repository layout

```
scripts/            Phase 1: ThingsBoard setup, backfill, simulator, teardown
widgets/src/core    REST client, scope, store (save/apply/resolve), chat ops, audit, schema
widgets/src/render  theme, SVG charts, widget renderers, 12-column grid
widgets/src/builder full-screen builder UI
widgets/src/entries launcher (button/navbar), renderer, listing
widgets/deploy      DBB_DEPLOY for a tenant-admin page
widgets/harness     local harness + Playwright screenshots against a fake ThingsBoard
widgets/test        unit tests with an in-memory fake ThingsBoard
```

## Known limits

- **Scope and admin rights are enforced in the UI only.** In CE, a customer user can read every device of their customer and write server attributes on them through the REST API (DECISIONS D-012).
- The chat needs the API key (above) and allows 30 requests per user per hour.
- One DashboardStore asset per customer must exist before that customer's users can save.
