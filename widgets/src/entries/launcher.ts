// Navbar widget. For a role that may build dashboards (D-050: dashboards.build) it shows one edit (pencil) icon; its menu holds every editing option:
// the Dashboard Builder and, on the machine page, edit / customise / reset / thresholds / switch
// dashboard (published by the renderer widget, see common.ts). The page itself shows no edit controls
// (user decision 27 Sep 2026). Also exposes window.IMEX_DBB.open() for an existing custom header widget.
//
// ThingsBoard widget type: tenant.imex_dbb_launcher ("iMEX Navbar / edit menu", 6x1). Lifecycle, via the
// controller glue generated in widgets/build.mjs: init(self.ctx) on onInit, onStateChanged(self.ctx),
// destroy(self.ctx) on onDestroy.
//
// Settings (widgets/widget-types.mjs):
//   label            tooltip / aria-label of the edit icon
//   adminOnly        no longer used (D-050): the role's dashboards.build decides who gets the edit items
//   hideForRoles     no longer used (D-050): a role whose Dashboards page is Hidden gets no icon
//   overviewState    state id that shows standalone dashboards (default 'dashboard_overview', named
//                    "Dashboard Overview", D-026); it holds the machine dashboard widget like the machine state
//   dashboardList    (default true) every user gets the icon with "Dashboard list" (standalone dashboards,
//                    D-025); users who can't edit see a list icon and only that item
//   navbar           true = full stand-in navbar (app name, Map/Listing links, state chip, breadcrumb,
//                    user avatar); false = only the icon (to drop into an existing header)
//   appName, homeState/homeLabel, listingState/listingLabel, machineState/machineLabel, stateTitles
//                    navbar texts and the dashboard state ids its links open
//   lightStyle       light icon button for light headers (icon-only mode)
//   chatEnabled      enable the builder's Chat tab (chatEnabledRoles: no longer used, D-050; everyone who may build may
//                    chat)
//   customerId       customer to show when a tenant admin opens the app (D-018)
//
// Edit menu (D-020): the items come from the renderer widget via window.__imexDbbActions / ACTIONS_EVENT
// (see common.ts), because the renderer runs in another copy of the library. The launcher adds
// "Dashboard list" (everyone, D-025) and "Dashboard Builder" (editors). The menu is appended to <body> so the navbar cell does not clip it.
//
// Role checks here (icon visibility, open(), the Dashboard list; D-050) are UI-only; a customer user can still write
// attributes through the REST API (D-012).
import { openBuilder, setBuilderPlacement, measureHeaderTop, BUILDER_UNLICENSED } from '../builder/builder';
import { builderLicensed, mayBuild, onLicenceChange } from '../core/licence';
import * as store from '../core/store';
import { CSS, ensureCss, esc, loadFont } from '../render/theme';
import { userContext, userPerms, userContextFor, stateEntity, notifyChanged, currentState, currentActions, ACTIONS_EVENT, EditAction, RSTATE_KEY, CHANGED_EVENT, liveLend, liveRelease, NO_ACCESS_HTML } from './common';
import * as scope from '../core/scope';
import { ensureKitCss, withBusy, kitToast, skeletonRows } from '../render/kit';
import * as dfmt from '../core/datefmt';

const MENU_ICONS: Record<string, string> = {
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  builder: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  list: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h10M7 17h6"/>',
  plus: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>',
};
const svg = (p: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

// The menu is appended to <body> (the navbar widget's own box clips overflow).
// D-033: styled like the app's own dropdowns (alerts menu): plain text rows, light cyan hover with a tiny lift,
// no taglines. D-074 (UI audit H2): the selected row is bold with a check mark on the right (as the side menu and
// the kit drop-downs); no fill and no bar on its left edge.
/** D-074: the check mark of the selected row (the kit drop-downs' icon). */
const MENU_CHECK =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>';
const MENU_CSS = `
.dbb-emenu{position:fixed;z-index:10050;min-width:230px;max-width:320px;background:#fff;color:#1d2939;border:1px solid #e4e7ec;border-radius:10px;box-shadow:0 10px 28px rgba(16,24,40,.16),0 2px 6px rgba(16,24,40,.06);padding:6px 0;font:14px Inter,"Segoe UI",Roboto,Arial,sans-serif;animation:dbb-menu-in .12s ease-out}
.dbb-emenu,.dbb-emenu *{box-sizing:border-box}
.dbb-emenu *::before,.dbb-emenu *::after{content:none}
@keyframes dbb-menu-in{from{opacity:0;transform:translateY(-4px)}}
.dbb-emenu-h{padding:6px 16px 8px;border-bottom:1px solid #eef0f3;margin-bottom:4px}
.dbb-emenu-h b{display:block;font-size:13px;font-weight:600;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-emenu-h span{display:block;font-size:11.5px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-emenu-sec{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#98a2b3;padding:8px 16px 4px}
.dbb-emenu button{all:unset;box-sizing:border-box;position:relative;display:flex;align-items:center;gap:10px;width:100%;padding:10px 16px 10px 22px;font:inherit;font-size:14px;line-height:1.3;color:#1d2939;cursor:pointer;transition:background .12s,transform .12s,box-shadow .12s}
.dbb-emenu button:hover,.dbb-emenu button:focus-visible{background:#e3f6fa;transform:translateY(-1px);box-shadow:0 2px 6px rgba(16,24,40,.08);outline:none;z-index:1}
.dbb-emenu button.sel{font-weight:600}
.dbb-emenu button .ck{flex:none;display:inline-flex;width:16px;color:var(--imx-p2,#1D4ED8)}
.dbb-emenu button.danger{color:#b42323}
.dbb-emenu button.danger:hover{background:#fdf0f0}
.dbb-emenu button .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-emenu hr{border:0;border-top:1px solid #eef0f3;margin:5px 0}
/* D-056: dark mode */
html[data-imx-mode="dark"] .dbb-emenu{background:var(--imx-surface,#121A2B);color:var(--imx-text,#E6EBF3);border-color:var(--imx-line,#26324A);box-shadow:0 12px 32px rgba(0,0,0,.5)}
html[data-imx-mode="dark"] .dbb-emenu-h,html[data-imx-mode="dark"] .dbb-emenu hr{border-color:var(--imx-line,#26324A)}
html[data-imx-mode="dark"] .dbb-emenu-h b,html[data-imx-mode="dark"] .dbb-emenu button{color:var(--imx-text,#E6EBF3)}
html[data-imx-mode="dark"] .dbb-emenu-h span,html[data-imx-mode="dark"] .dbb-emenu-sec{color:var(--imx-muted,#97A6BC)}
html[data-imx-mode="dark"] .dbb-emenu button:hover,html[data-imx-mode="dark"] .dbb-emenu button:focus-visible{background:var(--imx-ph,#1B263C)}
html[data-imx-mode="dark"] .dbb-emenu button .ck{color:var(--imx-a2,#7DD3FC)}
html[data-imx-mode="dark"] .dbb-emenu button.danger{color:var(--imx-bad-tx,#FCA5A5)}
html[data-imx-mode="dark"] .dbb-emenu button.danger:hover{background:var(--imx-bad-bg,rgba(239,68,68,.18))}
`;

const BTN_CSS = `
.dbb-nav{display:flex;align-items:center;gap:14px;height:100%;padding:0 60px 0 16px;background:linear-gradient(90deg,#0a2458 0%,#123a7a 60%,#184f95 100%);color:#fff;box-shadow:0 2px 10px rgba(10,36,88,.25)}
.dbb-nav-app{font-size:16px;font-weight:600;letter-spacing:.01em;display:flex;align-items:center;gap:9px;white-space:nowrap}
.dbb-nav-app::before{content:"";width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#6da7ec,#2a78d6);box-shadow:inset 0 0 0 5px rgba(255,255,255,.18)}
.dbb-nav-link{background:none;border:0;color:#fff;font:500 13px Inter,"Segoe UI",Roboto,Arial,sans-serif;opacity:.8;cursor:pointer;padding:7px 12px;border-radius:999px;white-space:nowrap;transition:background .15s,opacity .15s}
.dbb-nav-link:hover{opacity:1;background:rgba(255,255,255,.1)}
.dbb-nav-link.on{opacity:1;background:rgba(255,255,255,.18);box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
.dbb-nav-state{font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.12);white-space:nowrap;text-transform:uppercase;letter-spacing:.05em}
.dbb-nav-crumb{font-size:13px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-nav-user{display:flex;align-items:center;gap:9px;font-size:12px;line-height:1.2;text-align:right}
.dbb-nav-user .who{display:flex;flex-direction:column}
.dbb-nav-user .who span{opacity:.75}
.dbb-nav-user .av{width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#eb6834,#e87ba4);font-weight:600;font-size:12px;box-shadow:0 0 0 2px rgba(255,255,255,.35)}
.dbb-nav .dbb-launch{height:auto;padding:0}
.dbb-launch{display:flex;align-items:center;justify-content:flex-end;height:100%;padding:0 4px}
.dbb-launch button{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.1);color:inherit;
  font:600 13px Inter,"Segoe UI",Roboto,Arial,sans-serif;padding:8px 14px;border-radius:10px;cursor:pointer;white-space:nowrap;transition:background .15s,transform .1s}
.dbb-nav .dbb-launch button{background:linear-gradient(135deg,#3987e5,#2a78d6);border-color:rgba(255,255,255,.25);box-shadow:0 2px 8px rgba(0,0,0,.2)}
.dbb-launch.light button{border-color:#d7d6d1;background:#fff;color:#0b0b0b}
.dbb-launch button:hover{filter:brightness(1.08)}
.dbb-launch button:active{transform:scale(.98)}
.dbb-launch svg{width:18px;height:18px}
.dbb-launch button.dbb-edit-ic{width:38px;height:38px;padding:0;justify-content:center;border-radius:11px}
.dbb-launch button.dbb-edit-ic[aria-expanded="true"]{background:#fff;color:#123a7a}
`;

/**
 * D-033: a z-index above any open Dashboard Builder overlay (and at least `min`). The builder normally sits at
 * 999 below the navbar, but host apps may raise it (one customer navbar set 300000), which hid the Dashboard
 * list and the menu behind it.
 */
export function aboveBuilder(min: number): number {
  let z = min;
  document.querySelectorAll<HTMLElement>('.dbb-overlay').forEach((o) => {
    const v = parseInt(getComputedStyle(o).zIndex, 10);
    if (Number.isFinite(v)) z = Math.max(z, v + 20);
  });
  return z;
}


/**
 * Opens the full-screen Dashboard Builder. Also reachable as `window.IMEX_DBB.open(opts)` once init ran.
 *
 * Reloads the user context (force) so role changes apply immediately. The machine preselected in the
 * builder is `opts.deviceId`, else the current state's entity if it is a DEVICE.
 * When the builder closes with changes, fires CHANGED_EVENT so renderer and listing reload.
 *
 * @param tbCtx ThingsBoard widget context of the launcher (its settings drive the chat).
 * @param opts.deviceId Machine to open; `opts.dashboardId` a stored dashboard to open directly;
 *   `opts.startNew` opens the "New dashboard" dialog (menu item New dashboard, D-029).
 * What loads (D-029): on a machine page that machine and the dashboard it shows; on the Dashboard Overview state
 * the overview shown there; on any other page (Map, Listing, ...) the start screen (New / Open / recent).
 * @throws Error("Your role can't build dashboards.") without dashboards.build (UI-only check, D-012, D-050), or when
 *   the user context can't be loaded.
 */
export async function open(tbCtx: any, opts: { deviceId?: string | null; dashboardId?: string | null; startNew?: boolean } = {}) {
  const cp = currentState(tbCtx).params ?? {};
  const ent = cp.entityId?.id ? { id: cp.entityId.id, entityType: cp.entityId.entityType } : stateEntity(tbCtx);
  // a machine missing from the cached scope (added minutes ago) reloads the scope once instead of being dropped
  const ctx = await userContextFor(tbCtx, opts.deviceId ?? (ent?.entityType === 'DEVICE' ? ent.id : null), true);
  const settings = tbCtx?.settings ?? {};
  // D-050: the role's dashboards.build (the settings adminOnly and chatEnabledRoles are no longer used)
  if (!ctx.canBuild) throw new Error("Your role can't build dashboards.");
  // D-059: and the instance licence's builder (no licence API on the page = allowed)
  if (!builderLicensed()) throw new Error(BUILDER_UNLICENSED);
  const chatEnabled = settings.chatEnabled !== false;
  registerPlacement(tbCtx);
  // On the Dashboard Overview state the builder opens the standalone dashboard shown there (D-026).
  const shown = !ent && typeof cp.dbbDashboardId === 'string' ? cp.dbbDashboardId : null;
  openBuilder({
    ctx,
    deviceId: opts.deviceId ?? (ent?.entityType === 'DEVICE' ? ent.id : null),
    dashboardId: opts.dashboardId ?? shown,
    chatEnabled,
    startNew: opts.startNew,
    // D-030: start below the app navbar and close when the user navigates with it
    topOffset: () => builderTop(tbCtx),
    pageKey: () => `${location.pathname}|${JSON.stringify(currentState(tbCtx))}`,
    onClose: (changed) => changed && notifyChanged(),
  });
}

/**
 * D-030: where the builder starts (px from the top of the window). Setting `builderTop`:
 *   'auto' (default)  the bottom of the app navbar: the lowest bottom edge among the dashboard widgets that sit in
 *                     the same band as this navbar widget, plus a thin full-width strip directly under it (the iMEX
 *                     status line), i.e. grid rows 1-6 of the iMEX app; the page content (row 7 on) stays covered;
 *   a number          that many px (e.g. 64);
 *   '0' / 'full'      full screen (the builder covers the navbar, as before D-030).
 */
export function builderTop(tbCtx: any): number {
  const v = String(tbCtx?.settings?.builderTop ?? 'auto').trim().toLowerCase();
  if (v === '0' || v === 'full' || v === 'none') return 0;
  if (/^\d+(px)?$/.test(v)) return parseInt(v, 10);
  const host: HTMLElement | undefined = tbCtx?.$container?.[0];
  if (!host?.getBoundingClientRect) return 0;
  // the ThingsBoard widget box this navbar widget lives in (gridster item), else its own element
  const box = (host.closest('gridster-item, .tb-widget-container') as HTMLElement | null) ?? host;
  const r = box.getBoundingClientRect();
  let bottom = r.bottom;
  const grid = box.closest('gridster, .tb-dashboard-layout, tb-dashboard-layout');
  if (grid)
    for (const it of Array.from(grid.querySelectorAll<HTMLElement>('gridster-item'))) {
      const q = it.getBoundingClientRect();
      // same band: starts above the navbar widget's bottom and ends below its top (status line above is excluded,
      // page widgets that start below the navbar are excluded)
      if (q.height > 0 && q.top < r.bottom - 1 && q.bottom > r.top + 1) bottom = Math.max(bottom, q.bottom);
    }
  // a thin full-width strip right under the navbar (the iMEX status line, row 6) belongs to the header too
  if (grid) {
    const gw = (grid as HTMLElement).getBoundingClientRect().width;
    for (let more = true; more; ) {
      more = false;
      for (const it of Array.from(grid.querySelectorAll<HTMLElement>('gridster-item'))) {
        const q = it.getBoundingClientRect();
        if (Math.abs(q.top - bottom) <= 2 && q.height > 0 && q.height <= 24 && q.width >= gw * 0.95 && q.bottom > bottom) {
          bottom = q.bottom;
          more = true;
        }
      }
    }
  }
  return Math.max(0, Math.round(bottom));
}

/**
 * Widget onInit: renders the navbar or the bare edit icon into `tbCtx.$container`, wires the edit menu
 * and registers `window.IMEX_DBB.open`.
 *
 * Side effects: injects CSS once per page; in navbar mode starts a 500 ms interval that watches the
 * dashboard state (stored on `tbCtx.__dbbWatch`); listens to ACTIONS_EVENT; overwrites
 * `window.IMEX_DBB` (the last launcher initialised wins). Cleanup is in destroy().
 */
export function init(tbCtx: any) {
  liveLend(tbCtx); // D-042: live values over the dashboard's own WebSocket
  ensureCss('dbb-css-core', CSS);
  ensureCss('dbb-css-launch', BTN_CSS);
  ensureCss('dbb-css-emenu', MENU_CSS);
  ensureKitCss();
  loadFont('Inter');
  const s = tbCtx.settings ?? {};
  const host: HTMLElement = tbCtx.$container[0];
  // D-036: headless = draws nothing; only provides window.IMEX_DBB for an app menu of its own (e.g. the iMEX side
  // menu), which then opens the builder, the Dashboard list and New dashboard through it.
  if (s.headless) {
    host.innerHTML = '';
    // D-050: isEditor() = the role's dashboards.build (the app's side menu and Dashboards page read it).
    // D-052: asked when first needed, and from the role alone (userPerms): the headless launcher is on every page of the
    // app, and loading the whole context here cost the tree's relation requests on every cold page load. The context
    // loads when a Builder action needs it (open, the Dashboard list). A failed read answers false and is asked again.
    let editorP: Promise<boolean> | null = null;
    const roleEditor = () =>
      (editorP ??= userPerms(tbCtx)
        .then((p) => p.can('dashboards.build'))
        .catch(() => {
          editorP = null;
          return false;
        }));
    // D-059: and the licence's builder, asked on every call (the licence can change while the page is open); the
    // Dashboard list gets the role alone and applies the licence itself (it redraws when the licence changes)
    const isEditor = () => roleEditor().then((v) => v && builderLicensed());
    (window as any).IMEX_DBB = {
      open: (o?: any) => open(tbCtx, o),
      newDashboard: () => open(tbCtx, { startNew: true }),
      dashboardList: async () => dashboardList(tbCtx, await roleEditor()),
      // D-041: the same list drawn inside an element of the app's own Dashboards page (no pop-up); D-058: with
      // "New dashboard" and "Open Dashboard Builder" at its top for editors (opts.buttons, see DashboardPageOpts)
      dashboardPage: async (host: HTMLElement, opts?: DashboardPageOpts) => dashboardList(tbCtx, await roleEditor(), host, opts),
      isEditor,
      actions: () => currentActions(),
    };
    registerPlacement(tbCtx);
    window.dispatchEvent(new CustomEvent('imex-dbb:ready'));
    return;
  }
  const btnHtml = `<button type="button" class="dbb-launch-btn dbb-edit-ic" title="${esc(s.label || 'Edit dashboards')}" aria-label="${esc(s.label || 'Edit dashboards')}" aria-haspopup="menu" aria-expanded="false">${svg(MENU_ICONS.edit)}</button>`;
  if (s.navbar) {
    host.innerHTML = `<div class="dbb-root dbb-nav"><div class="dbb-nav-app">${esc(s.appName || 'iMEX')}</div>
      <button type="button" class="dbb-nav-link" data-go="${esc(s.homeState || 'default')}">${esc(s.homeLabel || 'Map page')}</button>
      <button type="button" class="dbb-nav-link" data-go="${esc(s.listingState || 'listing')}">${esc(s.listingLabel || 'Listing page')}</button>
      <div class="dbb-nav-state"></div><div class="dbb-nav-crumb"></div><div style="flex:1"></div>
      <div class="dbb-launch">${btnHtml}</div><div class="dbb-nav-user"></div></div>`;
    host.querySelectorAll<HTMLElement>('[data-go]').forEach(
      (b) =>
        (b.onclick = () => {
          try {
            // Switch state within this ThingsBoard dashboard (3rd arg: openRightLayout = false).
            tbCtx.stateController.openState(b.dataset.go!, {}, false);
          } catch {
            /* ignore */
          }
        }),
    );
    const crumb = host.querySelector('.dbb-nav-crumb') as HTMLElement;
    const stateEl = host.querySelector('.dbb-nav-state') as HTMLElement;
    // Current dashboard state shown in the navbar ("Map page" / "Listing page" / "Machine page").
    const stateTitles: Record<string, string> = Object.assign(
      { [s.homeState || 'default']: s.homeLabel || 'Map page', [s.listingState || 'listing']: s.listingLabel || 'Listing page', [s.machineState || 'machine']: s.machineLabel || 'Machine page', [s.overviewState || 'dashboard_overview']: 'Dashboard Overview' },
      typeof s.stateTitles === 'object' && s.stateTitles ? s.stateTitles : {},
    );
    let lastKey = '';
    const paintState = () => {
      const cur = currentState(tbCtx);
      const id = cur.id || s.homeState || 'default';
      stateEl.textContent = stateTitles[id] ?? id;
      host.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.classList.toggle('on', b.dataset.go === id));
    };
    // Repaints the state chip plus the user block and breadcrumb (breadcrumb only for entities in scope).
    const paint = () => {
      paintState();
      void userContext(tbCtx)
        .then((c) => {
          const p = currentState(tbCtx).params ?? {};
          const ent = p.entityId?.id ? { id: p.entityId.id } : stateEntity(tbCtx);
          (host.querySelector('.dbb-nav-user') as HTMLElement).innerHTML = `<div class="who"><b>${esc(c.displayName)}</b><span>${esc(c.role)}</span></div><span class="av">${esc(
            c.displayName
              .split(/\s+/)
              .map((x: string) => x[0] ?? '')
              .join('')
              .slice(0, 2)
              .toUpperCase(),
          )}</span>`;
          crumb.textContent = ent && c.nodes.has(ent.id) ? scope.pathLabel(c, ent.id) : '';
        })
        .catch(() => undefined);
    };
    (tbCtx as any).__dbbPaint = paint;
    paint();
    // The navbar widget stays mounted across states and is not always notified, so watch the state.
    const watch = setInterval(() => {
      const cur = currentState(tbCtx);
      const key = cur.id + '|' + (cur.params?.entityId?.id ?? '');
      if (key !== lastKey) {
        lastKey = key;
        paint();
      }
    }, 500);
    (tbCtx as any).__dbbWatch = watch;
  } else host.innerHTML = `<div class="dbb-root dbb-launch ${s.lightStyle ? 'light' : ''}">${btnHtml}</div>`;
  const btn = host.querySelector('.dbb-launch-btn') as HTMLButtonElement;
  // D-050: the edit items need the role's dashboards.build; a role whose Dashboards page is Hidden gets no icon (the
  // settings adminOnly and hideForRoles are no longer used). Hidden until the role is known, so it never flashes.
  // NB: hiding is UI only; see DECISIONS D-012.
  btn.style.display = 'none';
  // D-025: everyone may open the "Dashboard list" (standalone dashboards); only editors get the edit items.
  // Non-editors see a list icon instead of the pencil. settings.dashboardList = false restores admin-only.
  let editor = false;
  void userContext(tbCtx)
    .then((c) => {
      editor = mayBuild(c); // D-059: role AND licence (the menu asks the licence again when it opens)
      if (c.perms.page('dashboards') === 'hidden' || (!editor && s.dashboardList === false)) return btn.remove();
      if (!editor) {
        btn.innerHTML = svg(MENU_ICONS.list);
        btn.title = 'Dashboards';
        btn.setAttribute('aria-label', 'Dashboards');
      }
      btn.style.display = '';
    })
    .catch(() => btn.remove());
  // Errors (e.g. non-admin) are shown as a temporary toast at the top of the page.
  // D-043: the button is busy (disabled, kit bar) while the builder opens
  const openBuilderFromMenu = async (startNew = false) => {
    try {
      await withBusy(btn, () => open(tbCtx, { startNew }));
    } catch (e: any) {
      alertInline(host, `Could not open the builder: ${e.message ?? e}`);
    }
  };
  let menu: HTMLElement | null = null;
  const closeMenu = () => {
    menu?.remove();
    menu = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  // Close on outside click; Escape closes, arrow keys move focus between items.
  const onDoc = (e: MouseEvent) => {
    if (menu && !menu.contains(e.target as Node) && !btn.contains(e.target as Node)) closeMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!menu) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      closeMenu();
      btn.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };
  // D-033: text-only rows; the hint (tagline) becomes the tooltip; a checked item is the selected row.
  const item = (a: Pick<EditAction, 'id' | 'label' | 'hint' | 'danger' | 'checked'> & { icon?: string }) =>
    `<button role="${a.checked !== undefined ? 'menuitemradio' : 'menuitem'}" data-m="${esc(a.id)}" class="${a.danger ? 'danger' : ''}${a.checked ? ' sel' : ''}" ${a.hint ? `title="${esc(a.hint)}"` : ''} ${a.checked !== undefined ? `aria-checked="${!!a.checked}"` : ''}><span class="t">${esc(a.label)}</span>${a.checked ? `<span class="ck" aria-hidden="true">${MENU_CHECK}</span>` : ''}</button>`;
  // Builds the menu from the renderer's published actions (if any) plus the fixed "Dashboard Builder"
  // item, positions it under the icon (clamped to the viewport) and focuses the first item.
  const openMenu = () => {
    // Non-editors: the renderer publishes no actions for them; they only get the Dashboard list.
    const ed = editor && builderLicensed(); // D-059
    const acts = ed ? currentActions() : null;
    const main = acts?.items.filter((x) => x.group !== 'switch') ?? [];
    const sw = acts?.items.filter((x) => x.group === 'switch') ?? [];
    menu = document.createElement('div');
    menu.className = 'dbb-emenu';
    menu.setAttribute('role', 'menu');
    menu.style.zIndex = String(aboveBuilder(10050));
    menu.innerHTML = `${acts ? `<div class="dbb-emenu-h"><b>${esc(acts.title)}</b>${acts.subtitle ? `<span>${esc(acts.subtitle)}</span>` : ''}</div>` : ''}
      ${main.map(item).join('')}
      ${sw.length ? `<div class="dbb-emenu-sec">Show dashboard</div>${sw.map(item).join('')}` : ''}
      ${main.length || sw.length ? '<hr/>' : ''}
      ${s.dashboardList !== false ? item({ id: '__list', label: 'Dashboard list', hint: 'Dashboards not tied to one machine', icon: 'list' }) : ''}
      ${ed ? item({ id: '__new', label: 'New dashboard', hint: 'For a machine type, or an overview of several machines', icon: 'plus' }) : ''}
      ${ed ? item({ id: '__builder', label: 'Dashboard Builder', hint: acts ? 'All dashboards, templates and machines' : 'Build or change dashboards', icon: 'builder' }) : ''}`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth;
    menu.style.top = `${Math.round(r.bottom + 8)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)))}px`;
    btn.setAttribute('aria-expanded', 'true');
    menu.querySelectorAll<HTMLButtonElement>('[data-m]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.m!;
        closeMenu();
        if (id === '__builder') void openBuilderFromMenu();
        else if (id === '__new') void openBuilderFromMenu(true);
        else if (id === '__list') void dashboardList(tbCtx, ed).catch((e) => alertInline(host, `Could not load the dashboards: ${e.message ?? e}`));
        else currentActions()?.run(id);
      }),
    );
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    menu.querySelector<HTMLButtonElement>('button')?.focus();
  };
  btn.onclick = () => (menu ? closeMenu() : openMenu());
  // Actions change when the machine page loads or switches; reopen to pick them up.
  const onActs = () => {
    if (menu) {
      closeMenu();
      openMenu();
    }
  };
  window.addEventListener(ACTIONS_EVENT, onActs);
  (tbCtx as any).__dbbMenuCleanup = () => {
    closeMenu();
    window.removeEventListener(ACTIONS_EVENT, onActs);
  };
  (window as any).IMEX_DBB = { open: (o?: any) => open(tbCtx, o) };
  // D-033: builders opened elsewhere (machine page Edit / Customise, Dashboard list) start below this navbar too.
  registerPlacement(tbCtx);
}

/**
 * D-033/D-034: tells builders opened from other entry points (machine page Edit / Customise, Dashboard list) to
 * start below this navbar. Called from init and also from open() / dashboardList(), because an app navbar may
 * call those directly without ever running init (the iMEX navbar2 widget does). When the navbar widget's element
 * is gone (the widget was re-created on a state change), the header is measured from the page instead.
 */
function registerPlacement(tbCtx: any) {
  const host: HTMLElement | undefined = tbCtx?.$container?.[0];
  setBuilderPlacement({
    // -1 = full screen on purpose (setting builderTop 0); 0 from a detached element = unknown, measure the page
    topOffset: () => (/^(0|full|none)$/i.test(String(tbCtx?.settings?.builderTop ?? '').trim()) ? -1 : host?.isConnected ? builderTop(tbCtx) : measureHeaderTop()),
    pageKey: () => `${location.pathname}|${JSON.stringify(currentState(tbCtx))}`,
  });
}

/** Rows per page in the Dashboard list. */
const LIST_PAGE = 8;

// Dashboard list styles (D-026). Self-contained and scoped under .dbb-dl, with resets, so the host app's
// global CSS (Material buttons, table and input styles) can't restyle it. Injected once with ensureCss.
const DL_CSS = `
.dbb-dl{position:fixed;inset:0;z-index:10040;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(9,20,40,.46);backdrop-filter:blur(3px);animation:dbb-dl-fade .14s ease-out}
.dbb-dl,.dbb-dl *{box-sizing:border-box;font-family:Inter,"Segoe UI",Roboto,Arial,sans-serif;letter-spacing:normal;text-transform:none;line-height:1.35}
@keyframes dbb-dl-fade{from{opacity:0}}
@keyframes dbb-dl-up{from{opacity:0;transform:translateY(10px) scale(.985)}}
.dbb-dl.dbb-dl-inline{position:static;inset:auto;z-index:auto;display:block;height:100%;padding:0;background:none;animation:none}
.dbb-dl.dbb-dl-inline .box{width:100%;max-width:none;height:100%;max-height:none;border-radius:16px;box-shadow:none;border:1px solid #e4e7ec;animation:none}
.dbb-dl.dbb-dl-inline .hd{display:none}
.dbb-dl.dbb-dl-inline .tools{padding-top:16px}
.dbb-dl button{all:unset;box-sizing:border-box;cursor:pointer;font-family:inherit}
.dbb-dl input{all:unset;box-sizing:border-box;font-family:inherit}
.dbb-dl svg{display:block}
.dbb-dl .box{width:min(760px,100%);max-height:min(720px,92vh);display:flex;flex-direction:column;background:#fff;color:#0f1a2a;border-radius:18px;box-shadow:0 24px 64px rgba(9,20,40,.32),0 2px 8px rgba(9,20,40,.12);overflow:hidden;animation:dbb-dl-up .18s ease-out}
.dbb-dl .hd{display:flex;align-items:center;gap:14px;padding:20px 22px 14px}
.dbb-dl .logo{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#2a78d6,#6d4ce0);box-shadow:0 6px 16px rgba(42,120,214,.35);flex:none}
.dbb-dl .logo svg{width:22px;height:22px}
.dbb-dl .ttl{flex:1;min-width:0}
.dbb-dl .ttl b{display:block;font-size:18px;font-weight:700;color:#0f1a2a}
.dbb-dl .ttl span{display:block;font-size:13px;color:#667085;margin-top:2px}
.dbb-dl .x{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#667085}
.dbb-dl .x:hover{background:#f2f4f7;color:#0f1a2a}
.dbb-dl .x svg{width:18px;height:18px}
.dbb-dl .tools{display:flex;gap:10px;align-items:center;padding:0 22px 14px}
.dbb-dl .search{flex:1;display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;border:1px solid #e4e7ec;border-radius:11px;background:#f9fafb;transition:border-color .12s,box-shadow .12s,background .12s}
.dbb-dl .search:focus-within{border-color:#2a78d6;background:#fff;box-shadow:0 0 0 4px rgba(42,120,214,.14)}
.dbb-dl .search svg{width:16px;height:16px;color:#98a2b3;flex:none}
.dbb-dl .search input{flex:1;height:100%;font-size:14px;color:#0f1a2a}
.dbb-dl .search input::placeholder{color:#98a2b3}
.dbb-dl .seg{display:flex;background:#f2f4f7;border-radius:10px;padding:3px}
.dbb-dl .seg button{padding:7px 11px;border-radius:8px;font-size:12.5px;font-weight:500;color:#475467;white-space:nowrap}
.dbb-dl .seg button.on{background:#fff;color:#0f1a2a;box-shadow:0 1px 3px rgba(16,24,40,.12)}
.dbb-dl .list{flex:1;overflow:auto;padding:4px 14px 8px;border-top:1px solid #eef0f3}
.dbb-dl .row{display:flex;align-items:center;gap:14px;padding:9px 10px;border-radius:12px;cursor:pointer;outline:none;transition:background .12s}
.dbb-dl .row + .row{border-top:1px solid #f2f4f7}
.dbb-dl .row:hover,.dbb-dl .row:focus-visible{background:#f4f8fe}
.dbb-dl .row:hover + .row,.dbb-dl .row:focus-visible + .row{border-top-color:transparent}
.dbb-dl .av{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#fff;flex:none}
.dbb-dl .main{flex:1;min-width:0}
.dbb-dl .nm{display:flex;align-items:center;gap:8px;font-size:14.5px;font-weight:600;color:#0f1a2a}
.dbb-dl .nm span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* D-071 (U-096): on a narrow page the tags go to a line of their own instead of squeezing the name to nothing */
.dbb-dl .nm{flex-wrap:wrap;row-gap:3px}
.dbb-dl .nm>span:first-child{max-width:100%}
@media (max-width:560px){.dbb-dl .row{flex-wrap:wrap;row-gap:8px}.dbb-dl .row .acts{flex:1 1 100%;padding-left:54px}}
.dbb-dl .nm mark{all:unset;background:#fff3c4;border-radius:3px}
.dbb-dl .badge{flex:none;font-style:normal;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:#f2f4f7;color:#475467}
.dbb-dl .badge.priv{background:#fef0c7;color:#93370d}
.dbb-dl .badge.type{background:#eaf2fd;color:#1f66bd}
.dbb-dl .badge.na{background:#fff4e5;color:#b54708}
.dbb-dl .kinds{display:flex;gap:4px;padding:0 22px 10px}
.dbb-dl .kinds button{padding:6px 12px;border-radius:999px;font-size:12.5px;font-weight:500;color:#475467;border:1px solid #e4e7ec;background:#fff}
.dbb-dl .kinds button:hover{background:#f9fafb}
.dbb-dl .kinds button.on{background:#0f1a2a;border-color:#0f1a2a;color:#fff}
.dbb-dl .meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin-top:4px;font-size:12.5px;color:#667085}
.dbb-dl .meta i{font-style:normal;display:inline-flex;align-items:center;gap:5px}
.dbb-dl .meta svg{width:13px;height:13px;color:#98a2b3}
.dbb-dl .own{width:18px;height:18px;border-radius:50%;background:#e0eaff;color:#2a55b8;font-size:9.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
.dbb-dl .acts{display:flex;gap:8px;flex:none}
.dbb-dl .btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 13px;border-radius:9px;font-size:13px;font-weight:600;white-space:nowrap}
.dbb-dl .btn svg{width:15px;height:15px}
.dbb-dl .btn.open{background:#2a78d6;color:#fff;box-shadow:0 1px 2px rgba(16,24,40,.14)}
.dbb-dl .btn.open:hover{background:#1f66bd}
.dbb-dl .btn.edit{border:1px solid #d0d5dd;color:#344054;background:#fff}
.dbb-dl .btn.edit:hover{background:#f9fafb;border-color:#98a2b3}
.dbb-dl .empty{padding:44px 20px;text-align:center;color:#667085;font-size:13.5px}
.dbb-dl .empty .ic{width:54px;height:54px;margin:0 auto 12px;border-radius:16px;background:#eef4ff;color:#2a78d6;display:flex;align-items:center;justify-content:center}
.dbb-dl .empty .ic svg{width:26px;height:26px}
.dbb-dl .empty b{display:block;color:#0f1a2a;font-size:15px;margin-bottom:4px}
.dbb-dl .ft{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 22px;border-top:1px solid #eef0f3;background:#fcfcfd;font-size:12.5px;color:#667085}
.dbb-dl .pager{display:flex;gap:4px;align-items:center}
.dbb-dl .pager button{min-width:32px;height:32px;padding:0 8px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:500;color:#344054}
.dbb-dl .pager button:hover:not([disabled]){background:#f2f4f7}
.dbb-dl .pager button.on{background:#eaf2fd;color:#1f66bd;font-weight:700}
.dbb-dl .pager button[disabled]{opacity:.35;cursor:default}
.dbb-dl .pager svg{width:16px;height:16px}
/* D-058: the page's New dashboard / Open Dashboard Builder at the right of the search row, 40 px high like the search;
   the App UI page gives .btn.open / .btn.edit its theme colours; icon only (aria-label, title) on narrow pages */
.dbb-dl .tools{flex-wrap:wrap}
.dbb-dl .pacts{display:flex;gap:8px;margin-left:auto;flex:none}
.dbb-dl .pacts .btn{height:40px;padding:0 14px;border-radius:10px;font-size:13.5px;gap:8px}
.dbb-dl .pacts .btn svg{width:16px;height:16px}
.dbb-dl .pacts .btn:focus-visible{outline:2px solid var(--imx-pr,#93B4F5);outline-offset:2px}
@media (max-width:900px){.dbb-dl .pacts .pbld span{display:none}.dbb-dl .pacts .pbld{width:40px;padding:0;justify-content:center}}
@media (max-width:560px){.dbb-dl .acts .edit{display:none}.dbb-dl .seg{display:none}.dbb-dl .pacts .btn span{display:none}.dbb-dl .pacts .btn{width:40px;padding:0;justify-content:center}}
/* D-056: the app's dark mode (html[data-imx-mode="dark"]); light mode is untouched */
html[data-imx-mode="dark"] .dbb-dl{background:rgba(2,6,15,.62)}
html[data-imx-mode="dark"] .dbb-dl.dbb-dl-inline{background:none}
html[data-imx-mode="dark"] .dbb-dl .box{background:var(--imx-surface,#121A2B);color:var(--imx-text,#E6EBF3);box-shadow:0 24px 64px rgba(0,0,0,.55)}
html[data-imx-mode="dark"] .dbb-dl.dbb-dl-inline .box{border-color:var(--imx-line,#26324A);box-shadow:none}
html[data-imx-mode="dark"] .dbb-dl .ttl b,html[data-imx-mode="dark"] .dbb-dl .nm,html[data-imx-mode="dark"] .dbb-dl .empty b,html[data-imx-mode="dark"] .dbb-dl .search input{color:var(--imx-text,#E6EBF3)}
html[data-imx-mode="dark"] .dbb-dl .ttl span,html[data-imx-mode="dark"] .dbb-dl .x,html[data-imx-mode="dark"] .dbb-dl .search svg,html[data-imx-mode="dark"] .dbb-dl .meta,html[data-imx-mode="dark"] .dbb-dl .meta svg,html[data-imx-mode="dark"] .dbb-dl .empty,html[data-imx-mode="dark"] .dbb-dl .ft{color:var(--imx-muted,#97A6BC)}
html[data-imx-mode="dark"] .dbb-dl .search input::placeholder{color:var(--imx-muted,#97A6BC)}
html[data-imx-mode="dark"] .dbb-dl .x:hover{background:var(--imx-ph,#1B263C);color:var(--imx-text,#E6EBF3)}
html[data-imx-mode="dark"] .dbb-dl .search{border-color:var(--imx-line2,#33415C);background:var(--imx-surface2,#162036)}
html[data-imx-mode="dark"] .dbb-dl .search:focus-within{border-color:#3987e5;background:var(--imx-surface2,#162036);box-shadow:0 0 0 4px rgba(57,135,229,.22)}
html[data-imx-mode="dark"] .dbb-dl .seg{background:var(--imx-surface2,#162036)}
html[data-imx-mode="dark"] .dbb-dl .seg button{color:var(--imx-text2,#C9D3E1)}
html[data-imx-mode="dark"] .dbb-dl .seg button.on{background:var(--imx-line,#26324A);color:var(--imx-text,#E6EBF3);box-shadow:none}
html[data-imx-mode="dark"] .dbb-dl .list{border-top-color:var(--imx-line,#26324A)}
html[data-imx-mode="dark"] .dbb-dl .row + .row{border-top-color:var(--imx-line,#26324A)}
html[data-imx-mode="dark"] .dbb-dl .row:hover,html[data-imx-mode="dark"] .dbb-dl .row:focus-visible{background:var(--imx-ph,#1B263C)}
html[data-imx-mode="dark"] .dbb-dl .nm mark{background:rgba(250,204,21,.3)}
html[data-imx-mode="dark"] .dbb-dl .badge{background:var(--imx-surface2,#162036);color:var(--imx-text2,#C9D3E1)}
html[data-imx-mode="dark"] .dbb-dl .badge.priv,html[data-imx-mode="dark"] .dbb-dl .badge.na{background:var(--imx-warn-bg,rgba(245,158,11,.18));color:var(--imx-warn-tx,#FCD34D)}
html[data-imx-mode="dark"] .dbb-dl .badge.type,html[data-imx-mode="dark"] .dbb-dl .own,html[data-imx-mode="dark"] .dbb-dl .pager button.on{background:rgba(57,135,229,.2);color:#9EC5F4}
html[data-imx-mode="dark"] .dbb-dl .kinds button{color:var(--imx-text2,#C9D3E1);border-color:var(--imx-line2,#33415C);background:var(--imx-surface,#121A2B)}
html[data-imx-mode="dark"] .dbb-dl .kinds button:hover{background:var(--imx-ph,#1B263C)}
html[data-imx-mode="dark"] .dbb-dl .kinds button.on{background:var(--imx-text,#E6EBF3);border-color:var(--imx-text,#E6EBF3);color:#0B1220}
html[data-imx-mode="dark"] .dbb-dl .btn.edit{border-color:var(--imx-line2,#33415C);color:var(--imx-text,#E6EBF3);background:var(--imx-surface,#121A2B)}
html[data-imx-mode="dark"] .dbb-dl .btn.edit:hover{background:var(--imx-ph,#1B263C);border-color:var(--imx-muted,#97A6BC)}
html[data-imx-mode="dark"] .dbb-dl .empty .ic{background:rgba(57,135,229,.16);color:#6DA7EC}
html[data-imx-mode="dark"] .dbb-dl .ft{border-top-color:var(--imx-line,#26324A);background:var(--imx-surface2,#162036)}
html[data-imx-mode="dark"] .dbb-dl .pager button{color:var(--imx-text2,#C9D3E1)}
html[data-imx-mode="dark"] .dbb-dl .pager button:hover:not([disabled]){background:var(--imx-ph,#1B263C)}
`;

/** Colours for dashboard avatars, picked by a hash of the name (stable per dashboard). */
const AV_COLORS = ['linear-gradient(135deg,#2a78d6,#5b9cf0)', 'linear-gradient(135deg,#6d4ce0,#9b7cf5)', 'linear-gradient(135deg,#0f9d8f,#35c2b2)', 'linear-gradient(135deg,#e8590c,#f59f4c)', 'linear-gradient(135deg,#c2185b,#e5578e)', 'linear-gradient(135deg,#3f51b5,#7986cb)'];
const DL_ICONS = {
  grid: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  widgets: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  builder: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
};
const dlsvg = (k: keyof typeof DL_ICONS) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DL_ICONS[k]}</svg>`;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else the date. */
function relTime(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return dfmt.date(ts); // D-061 (M2): "16 Oct 2026", never a numeric date
}

/** Up to two initials of a name ("Ithena Fleet Overview" -> "IF"). */
const initials = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/**
 * "Dashboard list" (D-025; redesigned D-026): a centred dialog with the standalone dashboards (not tied to one
 * machine) this user may see (shared ones and their own private ones, store.listDashboards). Search by name
 * or owner (matches highlighted), sort by name or last update, 8 per page with numbered pages. Open (or a
 * click on the row / Enter) shows it in the Dashboard Overview state (openStandalone); editors also get Edit
 * (Dashboard Builder). Esc or a click on the backdrop closes it.
 */
/** Options of the Dashboards page (`dashboardPage(host, opts)`, D-058). */
export interface DashboardPageOpts {
  /**
   * "New dashboard" (primary) and "Open Dashboard Builder" (secondary) at the top of the list, for editors only.
   * true = always, false = never; absent = unless the page around `host` already has its own (the App UI Dashboards
   * page's banner buttons, `.imx-dl-head [data-el="new"]`), so the page never shows them twice.
   */
  buttons?: boolean;
}

/** D-058: whether the page around `host` already offers New dashboard (the App UI Dashboards page's banner). */
export function hostHasOwnButtons(host: HTMLElement): boolean {
  return !!host.closest('.imx-dl')?.querySelector('.imx-dl-head [data-el="new"]');
}

/**
 * The Dashboard list: as a pop-up (no `host`), or drawn inside `host` as a page (D-041, headless API
 * `dashboardPage`). Inside a host there is no backdrop, header or Escape; the list redraws when a dashboard was
 * saved (CHANGED_EVENT) and is removed with the returned `destroy()`.
 * D-058: on the page, editors get "New dashboard" and "Open Dashboard Builder" at the top (`opts.buttons`); they
 * replace the side menu's former "Dashboard Builder" sub-item.
 */
export async function dashboardList(tbCtx: any, roleEditor: boolean, host?: HTMLElement, opts: DashboardPageOpts = {}): Promise<{ destroy: () => void } | void> {
  // D-059: Edit, machine-type dashboards and the page's New / Open Dashboard Builder need the licence's builder too;
  // without it an editor sees the list as a viewer does (viewing is core)
  const editor = roleEditor && builderLicensed();
  ensureCss('dbb-css-dlist', DL_CSS);
  registerPlacement(tbCtx);
  // D-043: the page shows placeholder rows while the dashboards load (the list replaces them)
  if (host) {
    ensureKitCss();
    host.innerHTML = `<div class="dbb-dl dbb-dl-inline" aria-busy="true" aria-label="Loading dashboards"><div class="box"><div class="list">${skeletonRows(5, 3)}</div></div></div>`;
  }
  let ctx: Awaited<ReturnType<typeof userContext>>;
  let all: Awaited<ReturnType<typeof store.listDashboards>>;
  try {
    ctx = await userContext(tbCtx);
    // D-050: the Dashboards page of the app's roles; Hidden = no list
    if (ctx.perms.page('dashboards') === 'hidden') {
      if (host) {
        host.innerHTML = NO_ACCESS_HTML;
        return { destroy: () => void (host.innerHTML = '') };
      }
      const msg = "You don't have access to the dashboards. Ask your administrator if you need it.";
      if (!kitToast(msg, 'warn')) throw new Error(msg);
      return;
    }
    // D-033: editors also see machine-type dashboards (e.g. one saved with "Don't apply now", which otherwise
    // could only be found through the builder's Open dialog); everyone else sees overviews only.
    all = (await store.listDashboards(ctx, store.LIST_REUSE_MS)).filter((d) => d.kind === 'standalone' || (editor && d.profile));
  } catch (e) {
    if (host) host.innerHTML = '<div class="dbb-dl dbb-dl-inline"><div class="box"><div class="empty"><b>Could not load the dashboards</b>Reload the page to try again.</div></div></div>';
    throw e;
  }
  // Whether a machine-type dashboard is applied anywhere: any assignment (machine, location, customer) naming it.
  let applied: ((id: string) => boolean) | null = null;
  if (editor && all.some((d) => d.kind !== 'standalone'))
    try {
      const a = ctx.assign && !ctx.assign.stale ? ctx.assign : await store.refreshAssign(ctx);
      const blob = JSON.stringify([[...a.byId.values()], a.customer]);
      const mine = new Set(Object.values(a.personal ?? {}));
      applied = (id) => mine.has(id) || blob.includes(`"dashboardId":"${id}"`);
    } catch {
      applied = null;
    }
  // D-058: the page's own New dashboard / Open Dashboard Builder (editors only; once per page, see DashboardPageOpts)
  const buttons = !!host && editor && (opts.buttons ?? !hostHasOwnButtons(host));
  const wrap = document.createElement('div');
  wrap.className = host ? 'dbb-dl dbb-dl-inline' : 'dbb-dl';
  if (host) {
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'Dashboards');
  } else {
    wrap.style.zIndex = String(aboveBuilder(10040));
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Dashboard list');
  }
  wrap.innerHTML = `<div class="box">
    <div class="hd"><div class="logo">${dlsvg('grid')}</div><div class="ttl"><b>Dashboards</b><span>${editor ? 'Overviews, and the dashboards made for a machine type' : "Overviews that aren't tied to one machine"}</span></div><button class="x" data-close aria-label="Close" title="Close (Esc)">${dlsvg('x')}</button></div>
    <div class="tools"><label class="search">${dlsvg('search')}<input data-q type="text" placeholder="${editor ? 'Search by name, owner or machine type' : 'Search by name or owner'}" aria-label="Search dashboards" autocomplete="off"/></label>
      <div class="seg" role="radiogroup" aria-label="Sort"><button data-sort="name" class="on">A–Z</button><button data-sort="recent">Recently updated</button></div>${
        buttons
          ? `<div class="pacts"><button type="button" class="btn edit pbld" data-builder title="Open the Dashboard Builder: all dashboards, templates and machines" aria-label="Open Dashboard Builder">${dlsvg('builder')}<span>Open Dashboard Builder</span></button><button type="button" class="btn open pnew" data-new title="Build a new dashboard: for a machine type, or an overview of several machines" aria-label="New dashboard">${dlsvg('plus')}<span>New dashboard</span></button></div>`
          : ''
      }</div>
    ${editor ? `<div class="kinds" role="tablist" aria-label="Kind"><button role="tab" data-kind="all" class="on">All</button><button role="tab" data-kind="standalone">Overviews</button><button role="tab" data-kind="device">Machine types</button></div>` : ''}
    <div class="list" data-rows role="list"></div>
    <div class="ft"><span data-count></span><div class="pager" data-pager></div></div></div>`;
  if (host) {
    host.innerHTML = '';
    host.appendChild(wrap);
  } else document.body.appendChild(wrap);
  const q = wrap.querySelector('[data-q]') as HTMLInputElement;
  const rows = wrap.querySelector('[data-rows]') as HTMLElement;
  let page = 0;
  let sort: 'name' | 'recent' = 'name';
  let kind: 'all' | 'standalone' | 'device' = 'all';
  // inside a host the page stays when a dashboard is opened; the pop-up closes
  const close = () => {
    if (host) return;
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  if (!host) document.addEventListener('keydown', onKey, true);
  const hl = (text: string, f: string) => {
    if (!f) return esc(text);
    const i = text.toLowerCase().indexOf(f);
    return i < 0 ? esc(text) : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + f.length))}</mark>${esc(text.slice(i + f.length))}`;
  };
  const colorOf = (s: string) => AV_COLORS[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AV_COLORS.length];
  const draw = () => {
    const f = q.value.trim().toLowerCase();
    const hits = all
      .filter((d) => kind === 'all' || (kind === 'standalone') === (d.kind === 'standalone'))
      .filter((d) => !f || d.name.toLowerCase().includes(f) || (d.ownerName ?? '').toLowerCase().includes(f) || (d.profile ?? '').toLowerCase().includes(f))
      .sort((a, b) => (sort === 'recent' ? b.updatedAt - a.updatedAt : a.name.localeCompare(b.name)));
    const pages = Math.max(1, Math.ceil(hits.length / LIST_PAGE));
    page = Math.max(0, Math.min(page, pages - 1));
    const shown = hits.slice(page * LIST_PAGE, (page + 1) * LIST_PAGE);
    rows.innerHTML = shown.length
      ? shown
          .map(
            (d) => {
              const dev = d.kind !== 'standalone';
              const tags = `${dev ? `<em class="badge type" title="Made for every machine of this type">${esc(d.profile ?? '')}</em>` : ''}${
                dev && applied && !applied(d.id) ? '<em class="badge na" title="Not shown on any machine yet. Open it in the builder and use Apply to…">Not applied</em>' : ''
              }${d.visibility === 'private' ? '<em class="badge priv">Private</em>' : ''}`;
              // Machine-type dashboards open in the builder (previewed on a machine of that type), not on the overview page.
              const acts = dev
                ? `<button class="btn open" data-edit="${esc(d.id)}" title="Open in the Dashboard Builder (previewed on a ${esc(d.profile ?? '')} machine)">${dlsvg('edit')}Open in builder</button>`
                : `${editor ? `<button class="btn edit" data-edit="${esc(d.id)}" title="Edit in the Dashboard Builder">${dlsvg('edit')}Edit</button>` : ''}<button class="btn open" data-open="${esc(d.id)}">${dlsvg('open')}Open</button>`;
              return `<div class="row" role="listitem" tabindex="0" data-id="${esc(d.id)}" data-dev="${dev ? 1 : ''}" title="${dev ? 'Edit' : 'Open'} “${esc(d.name)}”">
        <div class="av" style="background:${colorOf(d.name)}">${esc(initials(d.name))}</div>
        <div class="main"><div class="nm"><span>${hl(d.name, f)}</span>${tags}</div>
          <div class="meta"><i>${dlsvg('widgets')}${d.widgets.length} widget${d.widgets.length === 1 ? '' : 's'}</i><i><span class="own">${esc(initials(d.ownerName ?? ''))}</span>${hl(d.ownerName ?? '', f)}</i><i>${dlsvg('clock')}Updated ${esc(relTime(d.updatedAt))}</i></div></div>
        <div class="acts">${acts}</div></div>`;
            },
          )
          .join('')
      : `<div class="empty"><div class="ic">${dlsvg(all.length ? 'search' : 'grid')}</div><b>${all.length ? 'No dashboard matches' : 'No dashboards yet'}</b>${
          all.length ? 'Try another name, owner or machine type.' : editor
            ? host
              ? 'Choose New dashboard at the top of this page to build one, or ask the chat in the Dashboard Builder for an overview.'
              : 'Choose New dashboard in the edit menu to build one, or ask the chat in the Dashboard Builder for an overview.'
            : 'Dashboards shared with you will appear here.'
        }</div>`;
    (wrap.querySelector('[data-count]') as HTMLElement).textContent = hits.length ? `Showing ${page * LIST_PAGE + 1}–${page * LIST_PAGE + shown.length} of ${hits.length}` : `0 of ${all.length}`;
    const nums = Array.from({ length: pages }, (_, i) => i).filter((i) => pages <= 7 || i === 0 || i === pages - 1 || Math.abs(i - page) <= 1);
    let last = -1;
    (wrap.querySelector('[data-pager]') as HTMLElement).innerHTML =
      `<button data-go="${page - 1}" ${page === 0 ? 'disabled' : ''} aria-label="Previous page">${dlsvg('left')}</button>` +
      nums.map((i) => `${i - last > 1 ? '<span>…</span>' : ''}${((last = i), '')}<button data-go="${i}" class="${i === page ? 'on' : ''}" aria-label="Page ${i + 1}">${i + 1}</button>`).join('') +
      `<button data-go="${page + 1}" ${page >= pages - 1 ? 'disabled' : ''} aria-label="Next page">${dlsvg('right')}</button>`;
  };
  q.addEventListener('input', () => {
    page = 0;
    draw();
  });
  wrap.querySelectorAll<HTMLElement>('[data-sort]').forEach((b) =>
    b.addEventListener('click', () => {
      sort = b.dataset.sort as 'name' | 'recent';
      wrap.querySelectorAll('[data-sort]').forEach((x) => x.classList.toggle('on', x === b));
      page = 0;
      draw();
    }),
  );
  wrap.querySelectorAll<HTMLElement>('[data-kind]').forEach((b) =>
    b.addEventListener('click', () => {
      kind = b.dataset.kind as typeof kind;
      wrap.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x === b));
      page = 0;
      draw();
    }),
  );
  wrap.querySelector('[data-pager]')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-go]');
    if (!b || b.disabled) return;
    page = Number(b.dataset.go);
    draw();
  });
  const openOnPage = (id: string) => {
    close();
    try {
      openStandalone(tbCtx, id);
    } catch (e: any) {
      alertInline(wrap, `Could not open the dashboard: ${e.message ?? e}`);
    }
  };
  // Opens a dashboard in the builder (below the navbar: openBuilder uses the launcher's placement). With the
  // builder already open it loads the dashboard there, asking first about unsaved changes (D-033).
  const editIn = (id: string) => {
    close();
    const d = all.find((x) => x.id === id);
    const cur = currentState(tbCtx).params?.entityId;
    const curProf = cur?.id ? ctx.nodes.get(cur.id)?.profile : undefined;
    const deviceId = d?.profile ? (curProf === d.profile ? cur.id : scope.allDevices(ctx, d.profile)[0]?.id ?? null) : null;
    try {
      openBuilder({ ctx, dashboardId: id, deviceId, chatEnabled: tbCtx.settings?.chatEnabled !== false, onClose: (ch) => ch && notifyChanged() });
    } catch (e: any) {
      alertInline(wrap, `Could not open the builder: ${e.message ?? e}`);
    }
  };
  wrap.querySelector('[data-close]')!.addEventListener('click', close);
  // D-058: New dashboard (the builder's New dashboard dialog) and Open Dashboard Builder (its start screen); busy while
  // the builder loads; errors go to the app's toast (never ThingsBoard's)
  const pageBtn = (sel: string, startNew: boolean) =>
    wrap.querySelector<HTMLButtonElement>(sel)?.addEventListener('click', (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      void withBusy(b, () => open(tbCtx, { startNew })).catch((err: any) => alertInline(wrap, `Could not open the Dashboard Builder: ${err?.message ?? err}`));
    });
  pageBtn('[data-new]', true);
  pageBtn('[data-builder]', false);
  if (!host) wrap.addEventListener('mousedown', (e) => e.target === wrap && close());
  rows.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const ed = t.closest<HTMLElement>('[data-edit]');
    if (ed) return editIn(ed.dataset.edit!);
    const row = t.closest<HTMLElement>('[data-id]');
    if (row) row.dataset.dev ? editIn(row.dataset.id!) : openOnPage(row.dataset.id!);
  });
  rows.addEventListener('keydown', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row[data-id]');
    if (!row) return;
    if (e.key === 'Enter') row.dataset.dev ? editIn(row.dataset.id!) : openOnPage(row.dataset.id!);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      ((e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null)?.focus();
    }
  });
  draw();
  if (!host) setTimeout(() => q.focus(), 0);
  if (host) {
    // a dashboard saved or deleted in the builder: the page shows the new list
    let alive = true;
    const onChanged = () => {
      if (!alive || !host.isConnected) return void window.removeEventListener(CHANGED_EVENT, onChanged);
      alive = false;
      window.removeEventListener(CHANGED_EVENT, onChanged);
      licOff();
      void dashboardList(tbCtx, roleEditor, host, opts);
    };
    window.addEventListener(CHANGED_EVENT, onChanged);
    // D-059: the licence switched the Builder on or off: the list is drawn again with or without the edit parts
    const licOff = onLicenceChange(builderLicensed, () => (host.isConnected ? onChanged() : licOff()));
    return {
      destroy: () => {
        alive = false;
        window.removeEventListener(CHANGED_EVENT, onChanged);
        licOff();
        wrap.remove();
      },
    };
  }
}

/**
 * Opens standalone dashboard `id` in the app's "Dashboard Overview" state (D-026, user request 30 Sep 2026:
 * standalone dashboards get their own state; machine dashboards are unchanged). The state id is
 * settings.overviewState (default 'dashboard_overview'). ThingsBoard ignores openState for a state that
 * doesn't exist, so if the state didn't change, it falls back to the machine-dashboard state and says
 * how to add the Dashboard Overview state.
 */
export function openStandalone(tbCtx: any, id: string) {
  const sc = tbCtx.stateController;
  const target = tbCtx.settings?.overviewState || 'dashboard_overview';
  sc?.openState?.(target, { dbbDashboardId: id }, false);
  let now: string | undefined;
  try {
    now = sc?.getStateId?.();
  } catch {
    now = undefined;
  }
  if (now !== undefined && now !== target) {
    sc?.openState?.(rendererState(tbCtx), { dbbDashboardId: id }, false);
    console.warn(`[iMEX] No dashboard state "${target}". Add a state with this id (name "Dashboard Overview") holding the machine dashboard widget, or set "Dashboard Overview state id" on the navbar widget.`);
  }
}

/**
 * State that holds the machine dashboard (renderer) widget: settings.machineState, else the state the renderer
 * last ran in on this ThingsBoard dashboard (remembered by the renderer, see RSTATE_KEY), else 'machine'.
 * Apps name their states differently, so a fixed 'machine' is not enough (D-025).
 */
function rendererState(tbCtx: any): string {
  if (tbCtx.settings?.machineState) return tbCtx.settings.machineState;
  try {
    const v = localStorage.getItem(RSTATE_KEY());
    if (v) return v;
  } catch {
    /* ignore */
  }
  return 'machine';
}

/**
 * Shows `msg` as an error: D-045, the iMEX app's toast when the app is on the page; else a red toast at the top of
 * the page for 6 s (appended to <body>).
 */
function alertInline(host: HTMLElement, msg: string) {
  if (kitToast(msg, 'err')) return;
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#8e2222;color:#fff;padding:8px 14px;border-radius:8px;z-index:10001;font:13px Inter,Roboto,Arial';
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 6000);
  void host;
}

/** Widget onStateChanged: repaints the navbar (no-op in icon-only mode). The 500 ms watch covers missed calls. */
export function onStateChanged(tbCtx: any) {
  (tbCtx as any).__dbbPaint?.();
}

/** Widget onDestroy: stops the state watch, closes the menu and removes the ACTIONS_EVENT listener. */
export function destroy(tbCtx?: any) {
  if (tbCtx) liveRelease(tbCtx);
  clearInterval(tbCtx?.__dbbWatch);
  tbCtx?.__dbbMenuCleanup?.();
}
