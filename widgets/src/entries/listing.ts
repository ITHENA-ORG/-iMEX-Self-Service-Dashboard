// Stand-in for the production listing page: scoped hierarchy tree + cards. Clicking a machine opens the
// 'machine' dashboard state, where the renderer widget shows its resolved dashboard.
//
// ThingsBoard widget type: tenant.imex_dbb_listing ("iMEX Listing / Map page (stand-in)", 24x12). One
// widget type, two modes (settings.mode): 'map' = Map page (dashboard state `default`), anything else =
// Listing page (state `listing`) (D-018). Lifecycle, via the controller glue in widgets/build.mjs:
// init(self.ctx) on onInit, onStateChanged(self.ctx) (listing mode reloads), destroy(self.ctx) on onDestroy.
//
// Settings (widgets/widget-types.mjs):
//   mode            'map' or 'listing' (default)
//   machineState    state opened for a machine (default 'machine'), with the device as state entity
//   dashboardState  state for standalone dashboards (default 'dashboard'); '' hides the Dashboards section
//   title, buttonLabel, listingState, siteProfile  map mode: page title, button text, listing state id,
//                   asset profile of site nodes (default 'Site')
//   customerId      customer to show when a tenant admin opens the app (D-018)
//
// Navigation is always tbCtx.stateController.openState(stateId, {entityId, entityName, entityLabel}, false).
// The tree and cards only show the nodes the user sees (D-050: the access core's grants, `imexAccess` or the legacy
// `selectedNodes`; the tree starts at the visible tops, nav nodes above 'all' grants included); that is a UI filter,
// not a permission (D-012). A page the user's role hides (Fleet overview / Machines) shows the app's empty state. Card data is polled over REST (latest telemetry, active
// alarms) every 10 s in listing mode; map mode loads once. Reloads on CHANGED_EVENT (listing mode).
import * as api from '../core/api';
import * as machine from '../core/machine';
import * as scope from '../core/scope';
import * as store from '../core/store';
import type { UserContext, Node } from '../core/scope';
import { CSS, ensureCss, esc, fmtNum, STATUS, loadFont } from '../render/theme';
import { keyMeta } from '../render/widgets';
import { ICON_SVG } from '../render/icons';
import { userContext, stateEntity, CHANGED_EVENT, scheduleRedraw, liveLend, liveRelease, pageGate, NO_ACCESS_HTML } from './common';

const L_CSS = `
.dbb-list{display:flex;height:100%;background:#f4f5f7}
.dbb-tree{width:270px;background:#fff;border-right:1px solid var(--line);padding:12px 10px;overflow:auto;flex:none}
.dbb-tree input{width:100%;font:inherit;padding:8px 10px 8px 32px;border:1px solid var(--line);border-radius:10px;margin-bottom:10px;background:#f6f7f9 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23898781' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='M20 20l-4-4'/%3E%3C/svg%3E") no-repeat 10px center/14px}
.dbb-tree input:focus{outline:none;border-color:var(--accent);background-color:#fff;box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
.dbb-tn{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink-2);transition:background .12s}
.dbb-tn svg{width:16px;height:16px;flex:none;color:var(--ink-3)}
.dbb-tn:hover{background:#f3f6fa;color:var(--ink)}
.dbb-tn.on{background:color-mix(in srgb,var(--accent) 12%,#fff);color:#184f95;font-weight:600}
.dbb-tn.on svg{color:var(--accent)}
.dbb-tn .cnt{margin-left:auto;font-size:11px;background:#eef0f3;color:var(--ink-2);border-radius:999px;padding:1px 7px;font-weight:500}
.dbb-cards{flex:1;overflow:auto;padding:18px 20px;display:flex;flex-direction:column;gap:14px;min-width:0}
.dbb-cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.dbb-mc{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 16px;cursor:pointer;display:flex;flex-direction:column;gap:10px;position:relative;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.05);transition:transform .15s,box-shadow .15s,border-color .15s}
.dbb-mc::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--st,transparent)}
.dbb-mc:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--line));box-shadow:0 10px 24px rgba(16,24,40,.1);transform:translateY(-2px)}
.dbb-mc-h{display:flex;align-items:center;gap:10px}
.dbb-mc-ic{width:36px;height:36px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;flex:none;background:color-mix(in srgb,var(--accent) 12%,#fff);color:var(--accent)}
.dbb-mc-ic svg{width:20px;height:20px}
.dbb-mc-t{font-weight:600;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-mc-s{font-size:11.5px;color:var(--ink-3)}
.dbb-mc-h>div{flex:1;min-width:0}
.dbb-stp{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;border-radius:999px;padding:3px 9px 3px 7px;background:color-mix(in srgb,var(--st) 14%,transparent);white-space:nowrap}
.dbb-stp i{width:7px;height:7px;border-radius:50%;background:var(--st)}
.dbb-kv{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dbb-kv>div{background:#f7f8fa;border-radius:9px;padding:7px 9px;min-width:0}
.dbb-kv span{display:block;font-size:11px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-kv b{display:block;font-weight:600;font-size:15px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-kv b small{font-size:11px;font-weight:400;color:var(--ink-3);margin-left:2px}
.dbb-mc-f{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-2)}
.dbb-bar{height:6px;border-radius:999px;background:#eef0f3;overflow:hidden}
.dbb-bar i{display:block;height:100%;border-radius:999px;background:var(--st,var(--accent))}
.dbb-h2{font-size:18px;font-weight:600;letter-spacing:-.01em}
.dbb-h2 small{font-size:12px;font-weight:400;color:var(--ink-3);margin-left:8px}
`;

interface Card {
  node: Node;
  html: string;
}

const M_CSS = `
.dbb-map{height:100%;overflow:auto;display:flex;flex-direction:column;align-items:center;gap:22px;background:#f4f5f7;padding:0 24px 32px;text-align:center}
.dbb-hero{width:calc(100% + 48px);margin:0 -24px;padding:34px 24px 64px;background:radial-gradient(1200px 300px at 50% -80px,#3987e5 0%,#184f95 45%,#0a2458 100%);color:#fff;position:relative;overflow:hidden}
.dbb-hero::after{content:"";position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.14) 1px,transparent 1px);background-size:18px 18px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.6),transparent)}
.dbb-hero h1{font-size:28px;font-weight:600;margin:0;letter-spacing:-.01em;position:relative}
.dbb-hero p{margin:6px 0 0;opacity:.8;font-size:14px;position:relative}
.dbb-sites{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,340px));gap:18px;justify-content:center;width:100%;max-width:1100px;margin-top:-52px;position:relative;z-index:1}
.dbb-site{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px;cursor:pointer;text-align:left;display:flex;flex-direction:column;gap:14px;box-shadow:0 4px 14px rgba(16,24,40,.08);transition:transform .15s,box-shadow .15s,border-color .15s}
.dbb-site:hover{transform:translateY(-3px);box-shadow:0 14px 32px rgba(16,24,40,.14);border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.dbb-site:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dbb-site-h{display:flex;align-items:center;gap:10px}
.dbb-site-h b{font-size:17px;font-weight:600;flex:1}
.dbb-site-h .go{color:var(--ink-3);font-size:18px;transition:transform .15s}
.dbb-site:hover .go{transform:translateX(3px);color:var(--accent)}
.dbb-pin{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#3987e5,#184f95);display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 3px 8px rgba(42,120,214,.3)}
.dbb-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.dbb-stats>div{background:#f7f8fa;border-radius:10px;padding:8px 10px}
.dbb-stats span{display:block;font-size:11px;color:var(--ink-3)}
.dbb-stats b{display:block;font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.dbb-map .dbb-go-list{padding:10px 20px;font-size:14px;font-weight:600;border-radius:12px}
`;

/**
 * Sites shown on the map page: assets of profile `siteProfile` (default 'Site', case-insensitive), sorted
 * by label. Fallbacks when there are none: the asset children of a single root asset, else the root assets.
 * Pure function (no REST).
 */
export function mapNodes(ctx: Pick<UserContext, 'nodes' | 'rootIds'>, siteProfile = 'Site'): Node[] {
  const sites = [...ctx.nodes.values()].filter((n) => n.entityType === 'ASSET' && n.profile.toLowerCase() === siteProfile.toLowerCase());
  if (sites.length) return sites.sort((a, b) => a.label.localeCompare(b.label));
  const roots = ctx.rootIds.map((id) => ctx.nodes.get(id)).filter(Boolean) as Node[];
  if (roots.length === 1 && roots[0].entityType === 'ASSET') return roots[0].children.map((c) => ctx.nodes.get(c)!).filter((n) => n?.entityType === 'ASSET');
  return roots.filter((n) => n.entityType === 'ASSET');
}

/**
 * Map page (settings.mode = 'map'): title, one card per site (click opens the listing for that site), and a button to the listing.
 * Per site card: machine count, running count, active alarm count. All machines' values and alarm counts come
 * from 2 calls in total (machineStats, D-022; before: about 4 calls per machine); loaded once, no refresh timer.
 */
function initMap(tbCtx: any, host: HTMLElement) {
  ensureCss('dbb-css-list', L_CSS);
  loadFont('Inter');
  ensureCss('dbb-css-map', M_CSS);
  const s = tbCtx.settings ?? {};
  const listingState = s.listingState || 'listing';
  host.innerHTML = `<div class="dbb-root dbb-map"><div class="dbb-hero"><h1>${esc(s.title || 'Map page')}</h1><p class="dbb-hero-s">Loading sites…</p></div>
    <div class="dbb-sites"><div class="dbb-site" style="cursor:default"><div class="dbb-ph" style="height:auto">Loading sites…</div></div></div>
    <button type="button" class="dbb-btn primary dbb-go-list" data-go>${esc(s.buttonLabel || 'Go to machine listing')} →</button></div>`;
  const sitesEl = host.querySelector('.dbb-sites') as HTMLElement;
  host.querySelector<HTMLElement>('[data-go]')!.onclick = () => tbCtx.stateController.openState(listingState, {}, false);
  const openSite = (n: Node) =>
    tbCtx.stateController.openState(listingState, { entityId: { id: n.id, entityType: 'ASSET' }, entityName: n.label, entityLabel: n.label }, false);
  void (async () => {
    try {
      const ctx = await userContext(tbCtx);
      if (pageGate(tbCtx, ctx) === 'hidden') {
        host.innerHTML = NO_ACCESS_HTML;
        return;
      }
      const sites = mapNodes(ctx, s.siteProfile || 'Site');
      if (!sites.length) {
        sitesEl.innerHTML = `${ctx.warnings.map((w) => `<div class="dbb-banner warn">${esc(w)}</div>`).join('')}<div class="dbb-hint">No sites in your scope.</div>`;
        return;
      }
      // every machine on the page in 2 calls (D-022): latest values + active alarm counts
      const ms = await machineStats(ctx, sites.flatMap((n) => scope.devicesUnder(ctx, n.id)));
      const cards = await Promise.all(
        sites.map(async (n) => {
          const devs = scope.devicesUnder(ctx, n.id);
          const stats = devs.map((d) => ms.get(d.id)!);
          const run = stats.filter((x) => x.running).length;
          const alarms = stats.reduce((a, x) => a + x.alarms, 0);
          const pct = devs.length ? Math.round((run / devs.length) * 100) : 0;
          return `<div class="dbb-site" role="button" tabindex="0" data-site="${n.id}" data-m="${devs.length}">
            <div class="dbb-site-h"><span class="dbb-pin"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg></span><b>${esc(n.label)}</b><span class="go">→</span></div>
            <div class="dbb-stats"><div><span>Machines</span><b>${devs.length}</b></div><div><span>Running</span><b>${run}<small style="font-size:12px;color:var(--ink-3);font-weight:400"> / ${devs.length}</small></b></div><div><span>Alarms</span><b style="color:${alarms ? STATUS.critical : 'inherit'}">${alarms}</b></div></div>
            <div class="dbb-bar" style="--st:${STATUS.good}" title="${pct}% running"><i style="width:${pct}%"></i></div>
            <div class="dbb-chip">${alarms ? `<span class="dbb-dot" style="background:${STATUS.critical}"></span>${alarms} active alarm${alarms > 1 ? 's' : ''}` : `<span class="dbb-dot" style="background:${STATUS.good}"></span>No active alarms`} · ${pct}% running</div></div>`;
        }),
      );
      sitesEl.innerHTML = cards.join('');
      const total = sites.reduce((a, n) => a + scope.devicesUnder(ctx, n.id).length, 0);
      (host.querySelector('.dbb-hero-s') as HTMLElement).textContent = `${sites.length} site${sites.length === 1 ? '' : 's'} · ${total} machine${total === 1 ? '' : 's'} · pick a site to see its machines`;
      sitesEl.querySelectorAll<HTMLElement>('[data-site]').forEach((c) => {
        const go = () => openSite(ctx.nodes.get(c.dataset.site!)!);
        c.onclick = go;
        c.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && go();
      });
    } catch (e: any) {
      sitesEl.innerHTML = `<div class="dbb-banner err">Could not load sites: ${esc(e.message ?? e)}</div>`;
    }
  })();
}

/**
 * Widget onInit. Map mode delegates to initMap. Listing mode renders a searchable hierarchy tree on the
 * left and cards for the children of the selected node (assets: machine/alarm/running summary; devices:
 * up to 4 catalogue values, status and alarms), plus standalone dashboards when enabled.
 *
 * Side effects: injects CSS once; live redraws (scheduleRedraw, D-021; 10 s REST polling if the socket is down); CHANGED_EVENT
 * listener; `tbCtx.__dbbReload` / `tbCtx.__dbbCleanup` hooks. REST reads only.
 */
export function init(tbCtx: any) {
  liveLend(tbCtx); // D-042: live values over the dashboard's own WebSocket
  ensureCss('dbb-css-core', CSS);
  const host: HTMLElement = tbCtx.$container[0];
  if (tbCtx.settings?.mode === 'map') return initMap(tbCtx, host);
  ensureCss('dbb-css-list', L_CSS);
  host.innerHTML = `<div class="dbb-root dbb-list"><aside class="dbb-tree"><input placeholder="Search" aria-label="Search the hierarchy"/><div class="dbb-tlist"></div></aside><section class="dbb-cards"><div class="dbb-ph">Loading…</div></section></div>`;
  const treeEl = host.querySelector('.dbb-tlist') as HTMLElement;
  const cardsEl = host.querySelector('.dbb-cards') as HTMLElement;
  const search = host.querySelector('.dbb-tree input') as HTMLInputElement;
  let ctx: UserContext;
  let selected: string | null = null;
  let lastEnt: string | null = null;
  let dashList = '';
  let dashListFor: UserContext | null = null;
  /** D-050: the user's role hides this page (nothing is drawn or redrawn). */
  let denied = false;

  const openMachine = (n: Node) =>
    tbCtx.stateController.openState(tbCtx.settings?.machineState || 'machine', { entityId: { id: n.id, entityType: 'DEVICE' }, entityName: n.label, entityLabel: n.label }, false);
  const openDash = (id: string, name: string) => tbCtx.stateController.openState(tbCtx.settings?.dashboardState || 'dashboard', { dbbDashboardId: id, entityName: name }, false);

  // Rebuilds the tree, filtered by the search box: a node stays if its label or any device below it matches.
  const drawTree = () => {
    const f = search.value.trim().toLowerCase();
    const rows: string[] = [];
    const walk = (id: string, depth: number) => {
      const n = ctx.nodes.get(id);
      if (!n) return;
      const match = !f || n.label.toLowerCase().includes(f) || scope.devicesUnder(ctx, id).some((d) => d.label.toLowerCase().includes(f));
      if (!match && n.entityType === 'ASSET') return;
      if (!match) return;
      const count = n.entityType === 'ASSET' ? scope.devicesUnder(ctx, id).length : 0;
      rows.push(
        `<div class="dbb-tn ${id === selected ? 'on' : ''}" data-id="${id}" style="padding-left:${8 + depth * 16}px">${n.entityType === 'DEVICE' ? ICON_SVG.cpu : depth === 0 ? ICON_SVG.factory : ICON_SVG.pin}<span style="overflow:hidden;text-overflow:ellipsis">${esc(n.label)}</span>${
          count ? `<span class="cnt">${count}</span>` : ''
        }</div>`,
      );
      if (n.entityType === 'ASSET') n.children.forEach((c) => walk(c, depth + 1));
    };
    ctx.rootIds.forEach((r) => walk(r, 0));
    treeEl.innerHTML = rows.join('') || '<div class="dbb-hint">Nothing matches.</div>';
    treeEl.querySelectorAll<HTMLElement>('.dbb-tn').forEach(
      (r) =>
        (r.onclick = () => {
          const n = ctx.nodes.get(r.dataset.id!)!;
          if (n.entityType === 'DEVICE') return openMachine(n);
          selected = n.id;
          drawTree();
          void drawCards();
        }),
    );
  };

  // Machine card. Shows up to 4 catalogue keys (dbb_profile_keys) excluding status/hours keys.
  // D-064: the status is the machine model's (core/machine.ts): its word and colour.
  const deviceCard = (d: Node, m: MStat): string => {
    const metas = (ctx.profileKeys[d.profile] ?? []).filter((k) => !/status|hours/i.test(k.key)).slice(0, 4);
    const { values: lv, lastTs: ts } = m;
    const al = { length: m.alarms };
    const [st, col] = [esc(m.result.label), machine.TONE_COLOR[m.result.tone] ?? STATUS.neutral];
    return `<div class="dbb-mc" data-dev="${esc(d.id)}" style="--st:${col}"><div class="dbb-mc-h"><span class="dbb-mc-ic">${ICON_SVG.cpu}</span><div><div class="dbb-mc-t">${esc(d.label)}</div><div class="dbb-mc-s">${esc(d.profile)}</div></div><span class="dbb-stp"><i></i>${st}</span></div>
      <div class="dbb-kv">${metas
        .map((m) => `<div><span>${esc(m.displayName)}</span><b>${lv[m.key] ? `${fmtNum(lv[m.key]!.value, m.decimals)}<small>${esc(m.unit)}</small>` : '—'}</b></div>`)
        .join('')}</div>
      <div class="dbb-mc-f">${al.length ? `<span class="dbb-dot" style="background:${STATUS.critical}"></span><b style="color:${STATUS.critical}">${al.length} active alarm${al.length > 1 ? 's' : ''}</b>` : `<span class="dbb-dot" style="background:${STATUS.good}"></span>No active alarms`}${ts ? `<span style="margin-left:auto;color:var(--ink-3)">${agoTxt(ts)}</span>` : ''}</div></div>`;
  };

  // Location card: counts over every device below the node (from the page's machineStats, D-022).
  const nodeCard = (n: Node, ms: Map<string, MStat>): string => {
    const devs = scope.devicesUnder(ctx, n.id);
    const stats = devs.map((d) => ms.get(d.id)!);
    const run = stats.filter((s) => s.running).length;
    const alarms = stats.reduce((a, s) => a + s.alarms, 0);
    const pct = devs.length ? Math.round((run / devs.length) * 100) : 0;
    return `<div class="dbb-mc" data-node="${n.id}" style="--st:${alarms ? STATUS.critical : STATUS.good}"><div class="dbb-mc-h"><span class="dbb-mc-ic">${ICON_SVG.pin}</span><div><div class="dbb-mc-t">${esc(n.label)}</div><div class="dbb-mc-s">${esc(n.profile)}</div></div><span style="color:var(--ink-3)">→</span></div>
      <div class="dbb-kv"><div><span>Machines</span><b>${devs.length}</b></div><div><span>Active alarms</span><b style="color:${alarms ? STATUS.critical : 'inherit'}">${alarms}</b></div></div>
      <div class="dbb-mc-f"><span>${pct}% running</span></div><div class="dbb-bar" style="--st:${STATUS.good}"><i style="width:${pct}%"></i></div></div>`;
  };

  // Cards for the children of the selected node (or the roots when nothing is selected).
  const drawCards = async () => {
    const n = selected ? ctx.nodes.get(selected) : null;
    const children = n ? n.children.map((c) => ctx.nodes.get(c)!).filter(Boolean) : ctx.rootIds.map((r) => ctx.nodes.get(r)!).filter(Boolean);
    // all machines behind the cards in 2 calls (D-022)
    const ms = await machineStats(ctx, [...new Set(children.flatMap((c) => scope.devicesUnder(ctx, c.id)))]);
    const cards: Card[] = children.map((c) => ({ node: c, html: c.entityType === 'DEVICE' ? deviceCard(c, ms.get(c.id)!) : nodeCard(c, ms) }));
    // standalone dashboards are listed only when the app has a state for them (settings.dashboardState not empty);
    // read on (re)load only, not on every live redraw (D-022)
    if (tbCtx.settings?.dashboardState !== '' && dashListFor !== ctx) {
      dashListFor = ctx;
      dashList = '';
      try {
        const ds = (await store.listDashboards(ctx)).filter((d) => d.kind === 'standalone');
        if (ds.length)
          dashList = `<div class="dbb-h2">Dashboards</div><div class="dbb-cgrid">${ds
            .map((d) => `<div class="dbb-mc" data-dash="${esc(d.id)}" data-name="${esc(d.name)}"><div class="dbb-mc-t">${esc(d.name)}</div><div class="dbb-muted">${d.widgets.length} widgets · by ${esc(d.ownerName)}</div></div>`)
            .join('')}</div>`;
      } catch {
        /* no store */
      }
    }
    cardsEl.innerHTML = `${ctx.warnings.map((w) => `<div class="dbb-banner warn">${esc(w)}</div>`).join('')}
      <div class="dbb-h2">${esc(n ? scope.pathLabel(ctx, n.id) : 'All locations')}<small>${cards.length} item${cards.length === 1 ? '' : 's'}</small></div>
      <div class="dbb-cgrid">${cards.map((c) => c.html).join('') || '<div class="dbb-hint">Nothing here.</div>'}</div>${dashList}`;
    cardsEl.querySelectorAll<HTMLElement>('[data-dev]').forEach((c) => (c.onclick = () => openMachine(ctx.nodes.get(c.dataset.dev!)!)));
    cardsEl.querySelectorAll<HTMLElement>('[data-node]').forEach(
      (c) =>
        (c.onclick = () => {
          selected = c.dataset.node!;
          drawTree();
          void drawCards();
        }),
    );
    cardsEl.querySelectorAll<HTMLElement>('[data-dash]').forEach((c) => (c.onclick = () => openDash(c.dataset.dash!, c.dataset.name!)));
  };

  // Selects the ASSET from the state entity (e.g. a site clicked on the map page) only when it changed,
  // so a manual selection survives refreshes; defaults to the single root.
  const load = async (force = false) => {
    try {
      ctx = await userContext(tbCtx, force);
      denied = pageGate(tbCtx, ctx) === 'hidden';
      if (denied) {
        treeEl.innerHTML = '';
        cardsEl.innerHTML = NO_ACCESS_HTML;
        return;
      }
      const ent = stateEntity(tbCtx);
      if (ent && ent.entityType === 'ASSET' && ctx.nodes.has(ent.id) && ent.id !== lastEnt) selected = ent.id;
      lastEnt = ent?.id ?? null;
      if (!selected && ctx.rootIds.length === 1) selected = ctx.rootIds[0];
      drawTree();
      await drawCards();
    } catch (e: any) {
      cardsEl.innerHTML = `<div class="dbb-banner err">Could not load: ${esc(e.message ?? e)}</div>`;
    }
  };
  search.oninput = () => ctx && !denied && drawTree();
  const onChanged = () => void load(true);
  window.addEventListener(CHANGED_EVENT, onChanged);
  // Card values come from the WebSocket live cache (D-021): redraw on pushes (at most every 2 s) and every
  // 60 s; REST polling every 10 s if the socket is down.
  const stopRedraw = scheduleRedraw(() => ctx && !denied && void drawCards(), () => 10000);
  (tbCtx as any).__dbbReload = () => void load();
  (tbCtx as any).__dbbCleanup = () => {
    stopRedraw();
    window.removeEventListener(CHANGED_EVENT, onChanged);
  };
  void load();
  void keyMeta;
}

/** Relative time label ("12s ago", "3 min ago", "2 h ago", "1 d ago"). */
function agoTxt(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}

/** Status of one machine for the map/listing cards. */
interface MStat {
  values: api.Latest;
  /** Latest telemetry time over the catalogue keys + the type's status keys (0 = none). */
  lastTs: number;
  offline: boolean;
  running: boolean;
  /** D-064: the machine model's status (word, colour, state). */
  result: machine.Result;
  alarms: number;
}

/**
 * Status of many machines in 2 calls (D-022): latest values of each machine type's catalogue keys (up to 20)
 * plus the type's status keys (api.latestMany: WebSocket live cache, else one Entity Data Query), and active alarm
 * counts (api.activeAlarmCounts: one Alarm Data Query). Machine types without a catalogue list their keys first
 * (one call per such machine). D-064: the status is the machine model's ONE rule (core/machine.ts): the type's
 * status tag through its map, "No data" after the type's No-data time. Failed reads count as no data / no alarms.
 */
async function machineStats(ctx: UserContext, devs: Node[]): Promise<Map<string, MStat>> {
  const mm = await machine.load(api.systemConfigMachineModel);
  const req = await Promise.all(
    devs.map(async (d) => {
      let keys = (ctx.profileKeys[d.profile] ?? []).map((k) => k.key).slice(0, 20);
      if (!keys.length) keys = (await api.timeseriesKeys(d.id).catch(() => [] as string[])).slice(0, 20);
      for (const k of machine.statusKeys(mm, machine.kindOf(d.profile, d.label))) if (!keys.includes(k)) keys.push(k);
      return { deviceId: d.id, keys };
    }),
  );
  const [lv, al] = await Promise.all([
    api.latestMany(req).catch(() => new Map<string, api.Latest>()),
    api.activeAlarmCounts(devs.map((d) => d.id)).catch(() => new Map<string, number>()),
  ]);
  const out = new Map<string, MStat>();
  for (const d of devs) {
    const values = lv.get(d.id) ?? {};
    const lastTs = Math.max(0, ...Object.values(values).map((v) => v?.ts ?? 0));
    const result = machine.status(mm, machine.kindOf(d.profile, d.label), values as machine.Latest);
    out.set(d.id, { values, lastTs, offline: result.state === 'offline', running: result.state === 'running', result, alarms: al.get(d.id) ?? 0 });
  }
  return out;
}

/** Widget onStateChanged: reloads the listing (no-op in map mode, which sets no reload hook). */
export function onStateChanged(tbCtx: any) {
  (tbCtx as any).__dbbReload?.();
}

/** Widget onDestroy: stops the refresh timer and removes the CHANGED_EVENT listener (listing mode). */
export function destroy(tbCtx: any) {
  if (tbCtx) liveRelease(tbCtx);
  (tbCtx as any).__dbbCleanup?.();
}
