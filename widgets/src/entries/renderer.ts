// Machine dashboard widget: shows the dashboard resolved for the machine in the dashboard state
// (personal > machine > location > customer-wide > default layout). The page itself shows no editing
// controls: for a role with dashboards.build (D-050), edit / customise / reset / thresholds / dashboard switcher are published to the
// navbar's edit menu (user decision 27 Sep 2026). Everyone else only views.
// Also renders a standalone dashboard when the state carries `dbbDashboardId`.
//
// ThingsBoard widget type: tenant.imex_dbb_renderer ("iMEX Machine dashboard", 24x12), placed in the
// app's `machine` state. Lifecycle, via the controller glue in widgets/build.mjs: init(self.ctx) on onInit,
// onStateChanged(self.ctx) (reloads for the new machine), destroy(self.ctx) on onDestroy.
//
// Settings (widgets/widget-types.mjs):
//   refreshSeconds  REST polling interval in seconds when the WebSocket is down (default 10)
//   chatEnabled     enable the Chat tab when "Edit this dashboard" opens the builder
//   analyzerState   the state the bar's Analyzer button opens: 'analytics' (default) or 'trend' (phone, D-057)
//   customerId      customer to show when a tenant admin opens the app (D-018)
//   dashboardId     (not in the settings form) standalone dashboard to show when the state has none
//
// Which machine: the entity of the current dashboard state (currentEntity: state URL first, then the state controller; watched every 500 ms), set by the listing via
// stateController.openState('machine', {entityId, ...}). Which dashboard: store.resolveForDevice
// (D-013 order), or the one picked in the "Show dashboard" switcher (st.override, reset when the
// machine changes).
//
// D-050: the page gate of the app's roles (state machine = Machines, dashboard_overview = Dashboards): a hidden page
// shows the app's "You don't have access to this page" instead. A machine must be granted to the user.
//
// Edit actions (dashboards.build only, UI-only check, D-012) are published with publishActions() for an app menu
// (D-020, see common.ts) and, since D-058, also offered by the bar's own "Edit dashboard" button (openBarMenu), with
// New dashboard and Open Dashboard Builder: the app's side menu has no Builder item any more. Reloads on CHANGED_EVENT.
//
// Refresh (D-021): values come over the ThingsBoard WebSocket (core/live.ts). The grid is redrawn when a
// change is pushed (at most every 2 s) and every 60 s; redraws read the live cache, so they make almost no
// REST calls (see core/api.ts). If the socket is down: REST polling as before (refreshSeconds, default 10 s,
// in realtime; 60 s for historic ranges). Skipped while the tab is hidden. See common.ts scheduleRedraw.
import * as api from '../core/api';
import * as machine from '../core/machine';
import * as scope from '../core/scope';
import * as store from '../core/store';
import type { UserContext } from '../core/scope';
import { normalizeRange, isShiftRange, rangeWindow } from '../core/schema';
import { calendarFor, shiftWindowText } from '../core/shifts';
import { loadView, saveView, viewLabel, viewWindow, presetLabel, hasEnded } from '../core/viewwindow';
import type { ViewWindow } from '../core/viewwindow';
import * as dfmt from '../core/datefmt';
import { openWindowMenu, closeWindowMenu, TW_CSS, TW_CHEV } from './timepicker';
import { ensureKitCss, pageBusy, withBusy } from '../render/kit';
import type { Dashboard } from '../core/schema';
import { Grid, GRID_CSS } from '../render/grid';
import { CSS, ensureCss, esc, STATUS, ago, agoWords, applyTheme } from '../render/theme';
import { defaultWidgets, LATEST_ONLY } from '../render/widgets';
import { CONTENT_TYPES } from '../core/schema';
import { ICON_SVG, UI_ICON } from '../render/icons';
import type { Widget } from '../core/schema';
import { openBuilder } from '../builder/builder';
import { BUILDER_CSS } from '../builder/styles';
import { modal, confirmModal, toast } from '../builder/ui';
import { audit } from '../core/audit';
import { mayBuild, builderLicensed, onLicenceChange, licHas, licenceApi, widgetLicensed } from '../core/licence';
import type { LicenceApi } from '../core/licence';
import { userContextFor, currentEntity, currentParam, RSTATE_KEY, CHANGED_EVENT, notifyChanged, publishActions, EditAction, EditActions, scheduleRedraw, liveLend, liveRelease, pageGate, NO_ACCESS_HTML, isMobileApp } from './common';

const R_CSS = `
.dbb-rend{height:100%;display:flex;flex-direction:column;background:var(--plane);position:relative}
.dbb-rhead{display:flex;align-items:center;gap:10px;padding:7px 16px;min-height:40px;background:var(--surface);border-bottom:1px solid var(--line);flex-wrap:nowrap;min-width:0}
.dbb-crumb-d{color:var(--ink)}
.dbb-rtitle{flex:0 1 auto;font-size:17px;font-weight:700;display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}
.dbb-crumb{font-size:13px;font-weight:500;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dbb-src-chip{font-size:12px;color:var(--ink-2);background:var(--grid);border-radius:999px;padding:4px 11px}
@keyframes dbb-pulse{50%{box-shadow:0 0 0 6px rgba(12,163,12,0)}}
.dbb-status-pill{flex:none;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;border-radius:999px;padding:3px 10px 3px 8px;background:color-mix(in srgb,var(--pill) 14%,transparent);color:var(--ink)}
.dbb-status-pill .dbb-dot{width:8px;height:8px;background:var(--pill);box-shadow:0 0 0 3px color-mix(in srgb,var(--pill) 25%,transparent)}
.dbb-tw{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:8px;box-sizing:border-box;height:28px;margin-top:0;margin-bottom:0;padding:0 8px 0 11px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--ink);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;max-width:100%;min-width:0;transition:background .12s,border-color .12s}
.dbb-tw:hover,.dbb-tw[aria-expanded="true"]{background:var(--hover);border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.dbb-tw:focus{outline:none}
.dbb-tw:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 30%,transparent)}
.dbb-tw .v{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dbb-tw .c{display:inline-flex;flex:none}
.dbb-tw .c svg{width:14px;height:14px}
.dbb-tw .v.mine{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 55%,transparent)}
html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-tw:hover,html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-tw[aria-expanded="true"]{background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.34)}
html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-tw .v.mine{box-shadow:inset 0 0 0 1px rgba(125,211,252,.75)}
html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-tw:focus-visible{box-shadow:0 0 0 3px rgba(125,211,252,.45)}
/* D-061 (A-046): Create ticket for a view-only role: shown locked */
.dbb-rbtn.locked{opacity:.55;cursor:default}
.dbb-rbtn.locked:hover{background:var(--surface);border-color:var(--line)}
html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-rbtn.locked:hover{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.18)}
.dbb-tw .k{color:var(--ink-3);font-weight:500;display:inline-flex;align-items:center;gap:5px}
.dbb-tw .k svg{width:14px;height:14px}
.dbb-tw .v{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--ink);background:var(--grid);border-radius:999px;padding:3px 10px}
.dbb-tw .v.live::before{content:"";width:7px;height:7px;border-radius:50%;background:#0ca30c;box-shadow:0 0 0 3px rgba(12,163,12,.2);animation:dbb-pulse 2s ease-in-out infinite}
.dbb-upd{flex:none;display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-3);white-space:nowrap;font-variant-numeric:tabular-nums;cursor:default}
.dbb-upd b{font-weight:600;color:var(--ink-2)}
.dbb-upd .d{width:7px;height:7px;border-radius:50%;background:var(--ink-3);flex:none}
.dbb-upd.fresh .d{background:#0ca30c}
.dbb-upd.old .d{background:#e8a317}
@media (max-width:720px){.dbb-tw .k span{display:none}}
@media (max-width:600px){.dbb-rend .dbb-rhead{flex-wrap:wrap;row-gap:6px}.dbb-rend .dbb-rhead .dbb-crumb{flex:1 1 100%}}
html.imx-mobile .dbb-rend .dbb-rhead{flex-wrap:wrap;row-gap:6px;padding:8px 12px}
html.imx-mobile .dbb-rend .dbb-rhead .dbb-crumb{flex:1 1 100%}
.dbb-rtools{margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dbb-rtools select{font:inherit;font-size:12px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)}
.dbb-rbody{flex:1;overflow:auto;min-height:0;padding:4px 6px}
.dbb-ract{flex:none;display:inline-flex;align-items:center;gap:6px}
/* the machine page: time window, freshness and the buttons as one group at the right end (it wraps as a whole, right-aligned) */
.dbb-rright{margin-left:auto;display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px 10px;min-width:0}
.dbb-rright .dbb-tw{margin-left:0}
/* the machine page bar's Analyzer and Create ticket (12 Oct 2026): pills like the time window; in the app (side menu,
   html.imx-menu-shift) the bar is the dark page banner, so they take the banner's translucent look there */
.dbb-ract:empty{display:none}
.dbb-rbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:28px;margin:0;padding:0 11px 0 9px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--ink);font:inherit;font-size:12px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;transition:background .12s,border-color .12s,box-shadow .12s}
.dbb-rbtn svg{width:15px;height:15px;flex:none;color:var(--accent)}
.dbb-rbtn:hover{background:var(--hover);border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.dbb-rbtn:focus{outline:none}
.dbb-rbtn:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 30%,transparent)}
@media (max-width:1100px){.dbb-rbtn{width:28px;padding:0}.dbb-rbtn span{display:none}}
html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-rbtn{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.18);color:#FFFFFF}
html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-rbtn svg{color:var(--imx-a2,#7DD3FC)}
html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-rbtn:hover{background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.34)}
html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-rbtn:focus-visible{box-shadow:0 0 0 3px rgba(125,211,252,.45)}
html.imx-mobile .dbb-rbtn{width:40px;height:40px;padding:0}
html.imx-mobile .dbb-rend .dbb-tw{height:40px;padding:0 10px 0 13px;border-radius:10px}
html.imx-mobile .dbb-rright .dbb-upd{order:3;flex-basis:100%;justify-content:flex-end}
html.imx-mobile .dbb-rbtn span{display:none}
/* D-058: "Edit dashboard" (dashboards.build only): always the last button of the bar; open = the hover look */
.dbb-rbtn.dbb-redit{order:9}
.dbb-rbtn.dbb-redit[aria-expanded="true"]{background:var(--hover);border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-rbtn.dbb-redit[aria-expanded="true"]{background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.34)}
/* its menu (appended to <body>, anchored to the button): the side menu's card look, the app's theme tokens; no filled
   selection (the dashboard shown has a tick) */
.dbb-rmenu{position:fixed;z-index:10050;box-sizing:border-box;width:300px;max-width:calc(100vw - 16px);overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:2px;padding:8px;background:var(--imx-surface,#FFFFFF);color:var(--imx-text,#0F172A);border:1px solid var(--imx-line,#E3E8EF);border-radius:14px;box-shadow:0 14px 34px rgba(15,43,87,.18);font:14px/1.3 var(--imx-font,DM Sans,Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif);letter-spacing:normal;text-transform:none;-webkit-font-smoothing:antialiased;animation:dbb-rm-in .12s ease-out}
.dbb-rmenu *{box-sizing:border-box;font-family:inherit}
.dbb-rmenu *::before,.dbb-rmenu *::after{content:none}
@keyframes dbb-rm-in{from{opacity:0;transform:translateY(-4px)}}
@media (prefers-reduced-motion:reduce){.dbb-rmenu{animation:none}.dbb-rmenu .dbb-rm-sw svg{transition:none}}
.dbb-rm-h{display:flex;flex-direction:column;gap:3px;padding:10px 12px 8px;min-width:0}
.dbb-rm-h b{font-size:14px;font-weight:700;color:var(--imx-text,#0F172A);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-rm-h span{font-size:12px;color:var(--imx-muted,#5B6B82);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-rm-hr{flex:none;height:1px;margin:4px 0;background:var(--imx-skel1,#EEF2F6)}
.dbb-rmenu button{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:40px;padding:0 12px;border-radius:9px;font-family:inherit;font-size:14px;line-height:1.3;color:var(--imx-text,#0F172A);cursor:pointer;transition:background-color .12s}
.dbb-rmenu button .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-rmenu button svg{flex:none;width:16px;height:16px}
.dbb-rmenu button:hover{background:var(--imx-pt,#EFF4FF)}
.dbb-rmenu button:focus-visible{outline:2px solid var(--imx-pr,#93B4F5);outline-offset:-2px}
.dbb-rmenu button.on{font-weight:600;color:var(--imx-p2,#1D4ED8)}
.dbb-rmenu button.danger{color:var(--imx-bad-tx,#B91C1C)}
.dbb-rmenu button.pri{font-weight:600;color:var(--imx-p2,#1D4ED8)}
.dbb-rmenu .dbb-rm-sw svg{color:var(--imx-muted,#5B6B82);transition:transform .12s}
.dbb-rmenu .dbb-rm-sw[aria-expanded="true"] svg{transform:rotate(90deg)}
.dbb-rm-swl{display:flex;flex-direction:column;gap:2px;padding-left:12px}
.dbb-rm-swl[hidden]{display:none}
html[data-imx-mode="dark"] .dbb-rmenu{background:var(--imx-surface,#121A2B);color:var(--imx-text,#E6EBF3);border-color:rgba(148,163,184,.30);box-shadow:0 0 0 1px rgba(0,0,0,.3),0 16px 40px rgba(0,0,0,.6)}
html[data-imx-mode="dark"] .dbb-rm-h b,html[data-imx-mode="dark"] .dbb-rmenu button{color:var(--imx-text,#E6EBF3)}
html[data-imx-mode="dark"] .dbb-rm-h span,html[data-imx-mode="dark"] .dbb-rmenu .dbb-rm-sw svg{color:var(--imx-muted,#97A6BC)}
html[data-imx-mode="dark"] .dbb-rm-hr{background:var(--imx-skel1,#1C2639)}
html[data-imx-mode="dark"] .dbb-rmenu button:hover{background:var(--imx-pt,#17243F)}
html[data-imx-mode="dark"] .dbb-rmenu button.on,html[data-imx-mode="dark"] .dbb-rmenu button.pri{color:var(--imx-p2,#9EC5F4)}
html[data-imx-mode="dark"] .dbb-rmenu button.danger{color:var(--imx-bad-tx,#FCA5A5)}
/* D-063: "?" Help for this page at the right end of the bar (the App UI page header's button: 36 x 36, 18 px icon); on the
   app's dark page banner (html.imx-menu-shift) the page header's colours, in light and dark mode alike */
.dbb-rhelp{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;margin:-4px 0;border-radius:10px;color:var(--ink-3);cursor:pointer;transition:background-color .14s ease,color .14s ease}
.dbb-rhelp svg{flex:none;width:18px;height:18px}
.dbb-rhelp:hover{background:var(--hover);color:var(--ink)}
.dbb-rhelp:focus-visible{outline:2px solid color-mix(in srgb,var(--accent) 60%,transparent);outline-offset:1px}
html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-rhelp{color:rgba(219,229,245,.82)}
html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-rhelp:hover{background:rgba(255,255,255,.12);color:#FFFFFF}
html.imx-menu-shift .dbb-rend .dbb-rhead .dbb-rhelp:focus-visible{outline:2px solid rgba(255,255,255,.7);outline-offset:1px}
.dbb-rhelp[hidden],html.imx-mobile .dbb-rhelp{display:none !important}
/* D-071 (U-096): the bar on two lines (dbb-wrap, measured in init): the title line, then the time window and the buttons
   from the left edge under the title, the "?" at the right end; even padding above and below */
.dbb-root.dbb-rend .dbb-rhead.dbb-wrap{padding-top:10px;padding-bottom:10px;row-gap:8px}
.dbb-root.dbb-rend .dbb-rhead.dbb-wrap>.dbb-rright{flex:1 1 100%;margin-left:0;justify-content:flex-start}
.dbb-root.dbb-rend .dbb-rhead.dbb-wrap>.dbb-rright>.dbb-rhelp{margin-left:auto}
.dbb-rhead-skel{display:flex;align-items:center;gap:12px;flex:1;min-width:0}
.dbb-rhead-skel .imx-skel{flex:none;height:14px}
.dbb-dark .dbb-rhead-skel .imx-skel{--imx-skel1:rgba(255,255,255,.07);--imx-skel2:rgba(255,255,255,.13)}
`;
/** D-043: the header while the page loads (name, path, status and time window in the shape of the real line). */
const HEAD_SKEL = `<div class="dbb-rhead-skel" aria-busy="true" aria-label="Loading"><span class="imx-skel" style="width:150px;height:18px"></span><span class="imx-skel" style="width:min(260px,30%)"></span><span class="imx-skel" style="width:74px;height:20px;border-radius:999px"></span><span class="imx-skel" style="margin-left:auto;width:min(220px,25%);height:24px;border-radius:999px"></span></div>`;

/** D-033: time window in words for the header ("Last 8 hours", "Live · last hour"; D-047 "Current shift"). */
function windowLabel(range: string): string {
  // D-061: the app's preset words ("Last hour", "Last 4 hours"; core/viewwindow.ts)
  return presetLabel(normalizeRange(range));
}
const CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
/**
 * D-033 header items: the page's time window and when its newest data point arrived (filled by the ticker).
 * D-061 (audit H3): the window is a button that opens the Time window menu (entries/timepicker.ts); it names the window
 * the cards show: the viewer's choice (outlined value) or the dashboard's own. `own` = cards with their own window.
 */
export function timeHtml(range: string, view: ViewWindow | null = null, own = 0): string {
  const live = !view && normalizeRange(range) === 'realtime';
  const label = view ? viewLabel(view) : windowLabel(range);
  return `<button type="button" class="dbb-tw" aria-haspopup="menu" aria-expanded="false" title="${esc(windowTip(range, view, own))}"><span class="k">${CLOCK}<span>Time window</span></span><span class="v${live ? ' live' : ''}${view ? ' mine' : ''}">${esc(label)}</span><span class="c">${TW_CHEV}</span></button><span class="dbb-upd" aria-live="off"><span class="d"></span><span class="t">Waiting for data…</span></span>`;
}
/** D-061: the Time window pill's tooltip: what the cards show, who chose it, and how to change it. */
export function windowTip(range: string, view: ViewWindow | null, own = 0): string {
  const n = normalizeRange(range);
  if (view)
    return `Every card shows ${view.range === 'custom' ? viewLabel(view) : presetLabel(view.range).toLowerCase()} (your choice, kept for this page). The dashboard's own window: ${presetLabel(n).toLowerCase()}. Click to change.`;
  const what =
    n === 'realtime'
      ? 'Live values; charts show the last hour'
      : isShiftRange(n)
        ? `Charts and values cover the ${n === 'shift' ? 'current' : 'previous'} shift, from the shift settings of the machine's site`
        : `Charts and values cover the ${presetLabel(n).toLowerCase()}, ending now`;
  const cards = own ? ` ${own} card${own > 1 ? 's have their' : ' has its'} own window (marked on the card).` : '';
  return `${what} (the dashboard's window).${cards} Click to show another period.`;
}
/**
 * Storyboard round (12 Oct 2026): the properties the Analyzer opens with from the machine page bar. The keys the
 * dashboard's widgets show for this machine (bound to the page's machine, to it by name, or to its machine type),
 * unique, at most 15 (the Analyzer's limit); without any, the machine type's first numeric properties.
 */
export function analyzerKeys(widgets: Widget[], deviceId: string, profile: string, catalogue: { key: string; type?: string; states?: Record<string, string> }[] = []): string[] {
  const out: string[] = [];
  for (const w of widgets) {
    const b: any = w.binding;
    const mine = b.mode === 'current' || (b.mode === 'fixed' && (b.deviceIds ?? []).includes(deviceId)) || ((b.mode === 'siblings' || b.mode === 'nearest') && b.profile === profile);
    if (!mine) continue;
    for (const k of w.keys ?? []) if (k && !out.includes(k)) out.push(k);
  }
  if (out.length) return out.slice(0, 15);
  for (const m of catalogue) if (m.type !== 'string' && m.type !== 'boolean' && !m.states && !out.includes(m.key)) out.push(m.key);
  return out.slice(0, 6);
}

/**
 * Where the machine page bar's Analyzer button goes (D-057), from the renderer setting `analyzerState`:
 * - 'analytics' (default, also when empty): the web Analyzer, `{selectedEquipment, entityName, entityLabel, key}` with NO
 *   top-level entityId (the Analyzer's data alias is rooted at the state entity, and a DEVICE there resolves to nothing;
 *   checked 13 Oct 2026; its handleAdditionalParams reads selectedEquipment first; D-055);
 * - 'trend': the phone's Trend screen of the mobile dashboard "iMEX Mobile", `{entityId DEVICE, entityName, entityLabel,
 *   key, selected: the first key}`;
 * - any other state id: the Analyzer's parameters.
 */
export function analyzerTarget(setting: unknown, deviceId: string, node: { name: string; label?: string }, keys: string[]): { state: string; params: Record<string, unknown> } {
  const state = typeof setting === 'string' && setting.trim() ? setting.trim() : 'analytics';
  const entityId = { id: deviceId, entityType: 'DEVICE' };
  const label = node.label || node.name;
  if (state === 'trend') return { state, params: { entityId, entityName: node.name, entityLabel: label, key: keys, selected: keys.find((k) => !/(^|_)(status|state|mode)$/i.test(k)) ?? keys[0] ?? null } };
  return { state, params: { selectedEquipment: { entityName: node.name, entityLabel: label, entityId }, entityName: node.name, entityLabel: label, key: keys } };
}

/** D-057: the ThingsBoard dashboard has this state (a state list that cannot be read counts as yes). */
export function dashHasState(tbCtx: any, id: string): boolean {
  try {
    const sc = tbCtx?.stateController;
    const states = sc && (sc.states ?? sc.statesValue);
    return !(states && typeof states === 'object' && Object.keys(states).length && !states[id]);
  } catch {
    return true;
  }
}

/** D-063: the App UI's Help state and its "?" glyph (imex_page_header: 18 px, stroke 2). */
export const HELP_STATE = 'help';
const HELP_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"></circle><path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 2-2.8 2.6-2.8 4.1"></path><path d="M12 17.6h.01"></path></svg>';
/**
 * D-063: the page the bar's "?" names to Help (its `helpFrom`), as the App UI's page header: the current state id
 * (`fallback` when it cannot be read); null = no "?": the dashboard has no Help state (a state list that cannot be
 * read counts as no, unlike dashHasState), or this is the Help page.
 */
export function helpFrom(tbCtx: any, fallback: string): string | null {
  try {
    const sc = tbCtx?.stateController;
    const states = sc && (sc.states ?? sc.statesValue);
    if (!(states && typeof states === 'object' && states[HELP_STATE])) return null;
    let at = '';
    try {
      at = sc.getStateId?.() || '';
    } catch {
      /* the fallback */
    }
    at = at || fallback;
    return at === HELP_STATE ? null : at;
  } catch {
    return null;
  }
}

/** D-068: the App UI's Playbooks page (U-082) and the licence feature it needs. */
export const PLAYBOOKS_STATE = 'playbooks';
/**
 * D-068: where the machine bar's "Create playbook" goes, or null = no button. Needs all three: the role's action
 * `playbooks.edit` (the Playbooks page opens its editor only for that action), the licence feature `playbooks` (licHas:
 * as the Analyzer button, D-062) and a `playbooks` state on this dashboard (a state list that cannot be read counts as
 * no, as for Help: an older app has no Playbooks page). Params as the Active alarms page's "Respond with a playbook"
 * (U-083), without an alarm type: `{ tab: 'playbooks', newFor: { machineId } }`.
 */
export function playbookTarget(tbCtx: any, perms: { can(k: string): boolean } | null | undefined, deviceId: string, L?: LicenceApi | null): { state: string; params: Record<string, unknown> } | null {
  if (!deviceId) return null;
  try {
    if (!perms || !perms.can('playbooks.edit')) return null;
  } catch {
    return null;
  }
  if (!licHas('playbooks', L === undefined ? licenceApi() : L)) return null;
  try {
    const sc = tbCtx?.stateController;
    const states = sc && (sc.states ?? sc.statesValue);
    if (!(states && typeof states === 'object' && states[PLAYBOOKS_STATE])) return null;
  } catch {
    return null;
  }
  return { state: PLAYBOOKS_STATE, params: { tab: 'playbooks', newFor: { machineId: deviceId } } };
}

/** A date and time for the ticket text ("12 Oct 2026, 1:05 PM"; the app's 12 / 24-hour clock applies). */
const tkTime = (ts: number) => dfmt.dateTime(ts);

/** The page's edit actions plus the two Builder entries of the bar's "Edit dashboard" menu (D-058). */
export interface BarMenu {
  acts: Omit<EditActions, 'owner'>;
  onNew(btn: HTMLElement): void;
  onBuilder(btn: HTMLElement): void;
}

/** D-058: the open "Edit dashboard" menu (one per page) and how to close it. */
let barMenu: { el: HTMLElement; btn: HTMLElement; close(focus?: boolean): void } | null = null;
/** Closes the bar menu (if `within` is given: only when its button is inside that element). */
export function closeBarMenu(within?: HTMLElement) {
  if (barMenu && (!within || within.contains(barMenu.btn))) barMenu.close(false);
}

/**
 * D-058: the bar's "Edit dashboard" menu, as the side menu's former "Dashboard Builder" flyout: a header (machine or
 * dashboard, where its dashboard comes from), the page's edit actions, the 'switch' group under an expandable "Show
 * dashboard" row (the one shown has a tick), a divider, "New dashboard" and "Open Dashboard Builder".
 * Appended to <body> under the button (right edges aligned, kept inside the window, above the button when there is no
 * room below). Keyboard: focus starts on the first item; Up / Down / Home / End move; Right opens "Show dashboard",
 * Left closes it; Escape or Tab closes and gives the focus back to the button. A click outside closes it.
 */
export function openBarMenu(btn: HTMLButtonElement, m: BarMenu) {
  if (barMenu?.btn === btn) return barMenu.close(true);
  closeBarMenu();
  const { acts } = m;
  const main = acts.items.filter((x) => x.group !== 'switch');
  const sw = acts.items.filter((x) => x.group === 'switch');
  const row = (a: EditAction) =>
    `<button type="button" role="${a.checked !== undefined ? 'menuitemradio' : 'menuitem'}" class="${a.danger ? 'danger' : ''}${a.checked ? ' on' : ''}" data-run="${esc(a.id)}"${a.hint ? ` title="${esc(a.hint)}"` : ''}${a.checked !== undefined ? ` aria-checked="${!!a.checked}"` : ''}><span class="t">${esc(a.label)}</span>${a.checked ? UI_ICON.tick : ''}</button>`;
  const el = document.createElement('div');
  el.className = 'dbb-rmenu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', 'Edit dashboard');
  el.innerHTML = `<div class="dbb-rm-h"><b>${esc(acts.title)}</b>${acts.subtitle ? `<span>${esc(acts.subtitle)}</span>` : ''}</div><div class="dbb-rm-hr" role="separator"></div>
    ${main.map(row).join('')}
    ${sw.length ? `<button type="button" role="menuitem" class="dbb-rm-sw" data-sw aria-haspopup="true" aria-expanded="false" title="The dashboards that apply here: pick the one to show"><span class="t">Show dashboard</span>${UI_ICON.chev}</button><div class="dbb-rm-swl" role="group" aria-label="Show dashboard" hidden>${sw.map(row).join('')}</div>` : ''}
    ${main.length || sw.length ? '<div class="dbb-rm-hr" role="separator"></div>' : ''}
    <button type="button" role="menuitem" data-new title="For a machine type, or an overview of several machines"><span class="t">New dashboard</span></button>
    <button type="button" role="menuitem" class="pri" data-builder title="All dashboards, templates and machines"><span class="t">Open Dashboard Builder</span></button>`;
  document.body.appendChild(el);
  const swRow = el.querySelector<HTMLButtonElement>('[data-sw]');
  const swList = el.querySelector<HTMLElement>('.dbb-rm-swl');
  const place = () => {
    if (!btn.isConnected) return close(false);
    const r = btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    el.style.maxHeight = '';
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let top = r.bottom + 6;
    if (top + h > vh - 8 && r.top - 6 - h >= 8) top = r.top - 6 - h;
    top = Math.max(8, top);
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(Math.max(8, Math.min(vw - w - 8, r.right - w)))}px`;
    el.style.maxHeight = `${Math.max(120, vh - top - 8)}px`;
  };
  const setSw = (open: boolean) => {
    if (!swRow || !swList) return;
    swList.hidden = !open;
    swRow.setAttribute('aria-expanded', String(open));
    place();
  };
  const items = () => [...el.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.closest('[hidden]'));
  const onKey = (e: KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length]?.focus();
    };
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'ArrowRight' && document.activeElement === swRow) {
      e.preventDefault();
      setSw(true);
      swList?.querySelector<HTMLButtonElement>('button')?.focus();
    } else if (e.key === 'ArrowLeft' && swList?.contains(document.activeElement)) {
      e.preventDefault();
      setSw(false);
      swRow?.focus();
    }
  };
  // Escape while the focus is outside the menu (e.g. on the page after a scroll) closes it too
  const onOutKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !el.contains(document.activeElement)) close(document.activeElement === btn);
  };
  const onDown = (e: Event) => {
    const t = e.target as Node;
    if (!el.contains(t) && !btn.contains(t)) close(false);
  };
  const onMove = () => place();
  function close(focus = false) {
    if (barMenu?.el !== el) return;
    barMenu = null;
    el.remove();
    btn.setAttribute('aria-expanded', 'false');
    el.removeEventListener('keydown', onKey);
    window.removeEventListener('keydown', onOutKey, true);
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('touchstart', onDown, true);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('scroll', onMove, true);
    if (focus && btn.isConnected) btn.focus();
  }
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    if (b === swRow) return setSw(swList?.hidden ?? false);
    close(false);
    const run = b.dataset.run;
    if (run) acts.run(run);
    else if (b.hasAttribute('data-new')) m.onNew(btn);
    else m.onBuilder(btn);
  });
  barMenu = { el, btn, close };
  btn.setAttribute('aria-expanded', 'true');
  // on the menu itself: in the app a passive document-level keydown listener comes first, and ThingsBoard's zone.js
  // then runs every document keydown listener as passive (preventDefault ignored: arrows would scroll the page)
  el.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onOutKey, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('touchstart', onDown, true);
  window.addEventListener('resize', onMove);
  window.addEventListener('scroll', onMove, true);
  place();
  items()[0]?.focus();
}

/** D-061 (A-046): the refusal of a write to a view-only role, in the AI pages' words (AIML.VIEW_ONLY). */
export const VIEW_ONLY = 'Your role can view only';
/**
 * D-061 (A-046): the role may write (the AI pages' AIML.canWrite and the service's can_write): a tenant administrator, or
 * a role holding at least one page at Full. The built-in Viewer and any view-only custom role only view.
 */
export function mayWrite(ctx: Pick<UserContext, 'perms'> | null | undefined): boolean {
  const p = ctx?.perms;
  if (!p) return false;
  if (p.unrestricted) return true;
  const pages = p.eff?.pages ?? {};
  return Object.keys(pages).some((k) => pages[k] === 'full');
}
/**
 * D-061: the cards that show their own stored window instead of the dashboard's (time-based types with a
 * settings.timeRange other than the dashboard's): the Time window pill's tooltip counts them, the cards carry a chip.
 */
export function ownWindowCards(widgets: Widget[], dashRange: string): number {
  const d = normalizeRange(dashRange);
  return widgets.filter((w) => !CONTENT_TYPES.has(w.type) && !LATEST_ONLY.has(w.type) && w.settings?.timeRange != null && normalizeRange(w.settings.timeRange) !== d).length;
}

/** Counter for unique ids of renderer instances in this library copy (used as the publishActions owner). */
let seq = 0;

/**
 * Widget onInit: builds the header + grid skeleton in `tbCtx.$container`, loads the machine's dashboard
 * and starts the refresh timer.
 *
 * Side effects: injects CSS once per page; stores its state on `tbCtx.__dbb`, cleanup on
 * `tbCtx.__dbbCleanup`, reload hook on `tbCtx.__dbbReload`; listens to CHANGED_EVENT; publishes/clears
 * the edit menu actions. REST reads: user context, store attributes (resolve), latest telemetry and
 * timeseries keys of the device.
 */
export function init(tbCtx: any) {
  liveLend(tbCtx); // D-042: live values over the dashboard's own WebSocket
  ensureCss('dbb-css-core', CSS);
  ensureCss('dbb-css-grid', GRID_CSS);
  ensureCss('dbb-css-builder', BUILDER_CSS);
  ensureCss('dbb-css-rend', R_CSS + TW_CSS);
  ensureKitCss();
  const host: HTMLElement = tbCtx.$container[0];
  const id = `r${++seq}`;
  const st: {
    ctx?: UserContext;
    grid?: Grid;
    deviceId?: string | null;
    shownId?: string | null;
    override?: string | null; // dashboard picked in the switcher
    lastKey?: string;
    /** Incremented by every load(); an older load that finishes late must not draw over a newer one. */
    loadSeq?: number;
    range?: string;
    /** D-061: the viewer's time window (Time window menu), null = the dashboard's; kept per user and page. */
    view?: ViewWindow | null;
    /** D-061: the storage key part of the page shown (the machine id, or d:<dashboard id>). */
    page?: string;
    /** D-061: cards with their own stored window (named in the pill's tooltip). */
    own?: number;
    /** D-061: the end of the window shown when it has ended (null = it ends now). */
    winEnd?: number | null;
    ticks?: number;
    /** The machine's status as the header pill shows it (D-064: the machine model's word, e.g. Running / Stopped / No data), for a ticket's text. */
    status?: string;
    /** The theme of the dashboard shown (D-056: applied again when the app switches light / dark). */
    theme?: Dashboard['theme'] | null;
  } = {};
  (tbCtx as any).__dbb = st;
  // Remember which dashboard state shows machines, as a fallback for the navbar's Dashboard list when the
  // app has no "Dashboard Overview" state (D-025/D-026). Only recorded while a machine is shown.
  const rememberState = () => {
    try {
      const sid = tbCtx.stateController?.getStateId?.();
      if (sid) localStorage.setItem(RSTATE_KEY(), sid);
    } catch {
      /* ignore */
    }
  };
  host.innerHTML = `<div class="dbb-root dbb-rend" id="${id}"><div class="dbb-rhead">${HEAD_SKEL}</div><div class="dbb-rbody"><div class="dbb-rgrid"></div></div></div>`;
  const root = host.querySelector('.dbb-rend') as HTMLElement;
  const head = root.querySelector('.dbb-rhead') as HTMLElement;
  const gridHost = root.querySelector('.dbb-rgrid') as HTMLElement;
  // D-071 (U-096): a bar too narrow for one line puts the time window and the buttons on a second line; that line
  // starts under the title (left-aligned, the "?" at its right end) instead of hanging right-aligned under it. The class
  // dbb-wrap is set by measuring the one-line layout (no class) after every size or content change of the bar.
  let fitRaf = 0;
  const fitHead = () => {
    fitRaf = 0;
    const right = head.querySelector(':scope > .dbb-rright') as HTMLElement | null;
    const first = head.firstElementChild as HTMLElement | null;
    head.classList.remove('dbb-wrap');
    if (!right || !first || first === right) return;
    head.classList.toggle('dbb-wrap', right.getBoundingClientRect().top >= first.getBoundingClientRect().bottom - 1);
  };
  const scheduleFit = () => {
    if (!fitRaf) fitRaf = requestAnimationFrame(fitHead);
  };
  const headRO = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleFit) : null;
  const watchHead = () => {
    if (!headRO) return;
    headRO.disconnect();
    headRO.observe(head);
    const right = head.querySelector(':scope > .dbb-rright');
    if (right) headRO.observe(right);
    scheduleFit();
  };
  const headMO = typeof MutationObserver !== 'undefined' ? new MutationObserver(watchHead) : null;
  headMO?.observe(head, { childList: true });
  watchHead();

  // (Re)loads from the dashboard state: a DEVICE entity -> showDevice; else a `dbbDashboardId` state
  // param or settings.dashboardId -> showStandalone; else a placeholder. `force` reloads the user context.
  // Which page to show: the state entity + standalone dashboard id, read URL-first (currentEntity).
  const pageKey = () => {
    const ent = currentEntity(tbCtx);
    const standaloneId = currentParam(tbCtx, 'dbbDashboardId') ?? tbCtx.settings?.dashboardId;
    return { ent, standaloneId, key: `${ent?.id ?? ''}|${standaloneId ?? ''}` };
  };
  const load = async (force = false) => {
    const seq = (st.loadSeq = (st.loadSeq ?? 0) + 1);
    closeBarMenu(root); // D-058: the bar is drawn again
    closeWindowMenu(root);
    const stale = () => seq !== st.loadSeq;
    // D-043: the app's page bar runs while the page resolves (first open, machine switch, another dashboard)
    pageBusy(`rend-${id}`, true);
    try {
      await loadPage(stale, force);
    } finally {
      if (!stale()) pageBusy(`rend-${id}`, false);
    }
  };
  const loadPage = async (stale: () => boolean, force: boolean) => {
    const { ent, standaloneId, key } = pageKey();
    if (key !== st.lastKey) {
      st.override = null;
      api.resetDataClock();
    }
    st.lastKey = key;
    try {
      // a machine missing from a cached scope (added minutes ago) reloads the scope once before it is refused
      const ctx = await userContextFor(tbCtx, ent?.entityType === 'DEVICE' ? ent.id : null, force);
      if (stale()) return;
      st.ctx = ctx;
      // D-050: the page gate of the app's roles (the machine page is Machines, Dashboard Overview is Dashboards)
      if (pageGate(tbCtx, ctx) === 'hidden') {
        st.deviceId = null;
        head.innerHTML = NO_ACCESS_HTML;
        st.grid?.render([]);
        publishActions(id, null);
        return;
      }
      if (ent?.entityType === 'DEVICE') await showDevice(ctx, ent.id, stale);
      else if (standaloneId) await showStandalone(ctx, standaloneId, stale);
      else {
        head.innerHTML = `<div class="dbb-ph" style="height:auto">Open a machine, or pick a dashboard on the Dashboards page.</div>`;
        st.grid?.render([]);
        publishActions(id, null);
      }
    } catch (e: any) {
      if (stale()) return;
      head.innerHTML = `<div class="dbb-banner err">Could not load the dashboard: ${esc(e.message ?? e)}</div>`;
    }
  };

  const body = root.querySelector('.dbb-rbody') as HTMLElement;
  // Used by link widgets to open another app page; passes the node (if in scope) as the state entity.
  const navigate = (stateId: string, nodeId: string | null) => {
    const n = nodeId && st.ctx ? st.ctx.nodes.get(nodeId) : null;
    const params = n ? { entityId: { id: n.id, entityType: n.entityType }, entityName: n.label, entityLabel: n.label } : {};
    tbCtx.stateController?.openState?.(stateId, params, false);
  };
  // D-061: the shift calendar the page's window uses: the machine's, on a standalone dashboard the organisation's
  // (the first top of the user's equipment)
  const calOf = (ctx: UserContext, deviceId: string | null) => calendarFor(ctx, deviceId ?? ctx.rootIds[0] ?? null).catch(() => null);
  // D-047: the header names the shift the window shows ("Morning · 06:00–14:00"); refreshed every 30 s by the ticker.
  // D-061: also for the viewer's shift choice; and it notes the end of a window that has ended (st.winEnd, for the ticker).
  const shiftLabel = (ctx: UserContext, deviceId: string | null) => {
    const range = st.range;
    const view = st.view ?? null;
    if (!range) return;
    const shift = view ? isShiftRange(view.range) : isShiftRange(range);
    const key = st.lastKey;
    const done = (cal: any) => {
      if (st.range !== range || st.view !== view || st.lastKey !== key) return;
      const win = view ? viewWindow(view, cal) : rangeWindow(range, cal);
      st.winEnd = win && (win.shift?.ended || hasEnded(win)) ? win.endTs : null;
      if (!shift) return;
      const v = head.querySelector('.dbb-tw .v');
      // D-061: the previous shift says so (the current one is the usual case and stays short)
      const prev = (view ? view.range : range) === 'prevshift' && win?.shift;
      if (v) v.textContent = `${prev ? 'Previous shift · ' : ''}${shiftWindowText(win, cal?.tz)}`;
    };
    if (!shift) return done(null);
    void calOf(ctx, deviceId).then(done);
  };
  /**
   * D-061: the bar's Time window pill: opens the menu; a choice is kept for this user and page (localStorage), redraws
   * every card in place for the new window (Grid.setEnv), and the pill names it.
   */
  const wirePill = (ctx: UserContext, deviceId: string | null) => {
    const b = head.querySelector('.dbb-tw') as HTMLButtonElement | null;
    if (!b) return;
    b.addEventListener('click', () =>
      openWindowMenu(b, {
        dashRange: st.range ?? 'realtime',
        view: st.view ?? null,
        cal: calOf(ctx, deviceId).then((cal) => ({ cal, tz: (cal as any)?.tz })),
        onPick: (v) => {
          st.view = v;
          if (st.page) saveView(ctx.userId, st.page, v);
          const old = head.querySelector('.dbb-tw');
          if (old) {
            const t = document.createElement('div');
            t.innerHTML = timeHtml(st.range ?? 'realtime', v, st.own ?? 0);
            old.replaceWith(t.firstElementChild!);
          }
          wirePill(ctx, deviceId);
          shiftLabel(ctx, deviceId);
          if (st.grid) ensureGrid(ctx, deviceId, st.range ?? 'realtime', st.theme ?? undefined);
          (head.querySelector('.dbb-tw') as HTMLElement | null)?.focus();
        },
      }),
    );
  };
  // Applies the dashboard theme and creates the read-only grid once, then only updates its environment.
  const ensureGrid = (ctx: UserContext, deviceId: string | null, range: string, theme?: Dashboard['theme']) => {
    const { dark, appDark } = applyTheme(root, theme);
    void body;
    st.theme = theme ?? null;
    const env = { ctx, deviceId, timeRange: range, view: st.view ?? null, theme: theme ?? null, dark, appDark, navigate, busyKey: id };
    if (!st.grid) st.grid = new Grid(gridHost, env, { editable: false });
    else st.grid.setEnv(env);
    return st.grid;
  };

  /**
   * Shows the machine page for `deviceId`: header (path, name, profile, status, time range) and the
   * resolved dashboard, or the built-in default layout when nothing is assigned. Devices outside the
   * user's scope get a warning only (scope is UI-enforced, D-012); load() has already reloaded a cached scope
   * that did not have the machine (userContextFor).
   * Status (D-064): the machine model's ONE status rule (core/machine.ts, the app's Settings > Sites & machines): the
   * type's status tag through its map, "No data" after the type's No-data time (default 15 min).
   * For a role with dashboards.build (D-050), publishes: edit, customise (shared dashboard from a location/customer assignment),
   * reset (device has a `customised` copy), thresholds, the switcher when several dashboards apply,
   * and "clear personal view" (D-017: personal views are still resolved but no longer created).
   */
  async function showDevice(ctx: UserContext, deviceId: string, stale: () => boolean) {
    st.deviceId = deviceId;
    rememberState();
    const node = scope.isGrantedMachine(ctx, deviceId) ? ctx.nodes.get(deviceId) : undefined;
    if (!node) {
      head.innerHTML = `<div class="dbb-banner warn">This machine is outside your access.</div>`;
      st.grid?.render([]);
      publishActions(id, null);
      return;
    }
    const res = await store.resolveForDevice(ctx, deviceId, node.profile);
    if (stale()) return;
    let dash: Dashboard | null = res.dashboard;
    let label = res.sourceLabel;
    let level = res.level;
    if (st.override) {
      const c = res.candidates.find((x) => x.dashboard.id === st.override);
      if (c) {
        dash = c.dashboard;
        label = c.sourceLabel;
        level = c.level;
      }
    }
    st.shownId = dash?.id ?? null;
    // D-050: editing from the machine page (edit, customise, reset, thresholds) is the role's dashboards.build;
    // D-059: and the licence's builder (viewing stays: the Dashboards viewer is core)
    const admin = mayBuild(ctx);
    const canCustomise = admin && (level === 'node' || level === 'customer');
    const canReset = admin && level === 'device' && res.deviceAssignment?.mode === 'customised';
    const range = normalizeRange(dash?.timeRange ?? 'realtime');
    st.range = range;
    // D-061: the viewer's window for this machine (kept per user), and the cards that keep their own window
    st.page = deviceId;
    st.view = loadView(ctx.userId, deviceId);
    st.winEnd = null;
    st.own = ownWindowCards(dash?.widgets ?? [], range);
    // One compact line: machine name (the page's title), then org › site · dashboard name, status, time range.
    // D-038: the title is back. It was left out on 28 Sep 2026 because the app's navbar showed the machine; with
    // the side menu there is no navbar, and nothing on the page said which machine or dashboard is open. An app
    // that still has its navbar (no side menu on the page) keeps the line without the title.
    // D-054: on a phone (html.imx-mobile, set by the side menu's headless mode) the app's shell bar shows the machine.
    const where = scope.ancestors(ctx, deviceId).reverse().map((a) => a.label).join(' › ');
    const sideMenu = (!!document.querySelector('#imx-menu-root') || document.documentElement.classList.contains('imx-menu-shift')) && !document.documentElement.classList.contains('imx-mobile');
    head.innerHTML = `
      ${sideMenu ? `<div class="dbb-rtitle" title="${esc(node.label)} (${esc(node.profile)})">${esc(node.label)}</div>` : ''}
      <div class="dbb-crumb" title="${esc(where)}${dash ? ` · Dashboard: ${esc(dash.name)}` : ''}">${esc(where)}${dash ? `<span class="dbb-crumb-d"> · ${esc(dash.name)}</span>` : ''}</div>
      <span class="dbb-status-pill" style="--pill:${STATUS.neutral}"><span class="dbb-dot"></span>…</span>
      <div class="dbb-rright">${timeHtml(range, st.view, st.own)}<span class="dbb-ract"></span></div>`;
    helpButton('machine'); // D-063
    st.status = undefined;
    wirePill(ctx, deviceId);
    shiftLabel(ctx, deviceId);
    // the built-in layout uses every key the machine type sends, not only the catalogued ones (9 Oct 2026)
    if (!dash) {
      await scope.liveKeys(ctx, [node.profile]);
      if (stale()) return;
    }
    const grid = ensureGrid(ctx, deviceId, range, dash?.theme);
    // D-073: a card whose module is not licensed (the alarm list without alerts) is not shown; the dashboard keeps it
    const shown = (dash ? dash.widgets : defaultWidgets(ctx, node.profile)).filter((w) => widgetLicensed(w.type));
    grid.render(shown);
    barActions(ctx, deviceId, node, where, dash, shown, range);
    // Status pill after the grid has started loading (D-022): the header no longer holds up the widgets.
    void lastTelemetry(ctx, deviceId, node.profile, node.label).then(({ lastTs, result }) => {
      if (st.deviceId !== deviceId) return;
      const status = [esc(result.label), machine.TONE_COLOR[result.tone] ?? STATUS.neutral];
      const pill = head.querySelector('.dbb-status-pill') as HTMLElement | null;
      if (!pill) return;
      pill.style.setProperty('--pill', status[1]);
      pill.innerHTML = `<span class="dbb-dot"></span>${status[0]}`;
      st.status = status[0];
      pill.title = lastTs ? `Machine last sent data ${ago(lastTs)}` : 'No data from this machine yet';
    });

    // Editing lives in the navbar's edit menu, not on the page.
    if (!admin) return publishActions(id, null);
    const items: EditAction[] = [{ id: 'edit', label: dash ? 'Edit this dashboard' : 'Build a dashboard for this machine', hint: dash ? `Opens “${dash.name}” in the Dashboard Builder` : 'Opens the Dashboard Builder', icon: 'edit' }];
    if (canCustomise && dash) items.push({ id: 'cust', label: 'Customise for this machine', hint: `Gives ${node.label} its own copy`, icon: 'copy' });
    if (canReset) items.push({ id: 'reset', label: 'Reset to shared dashboard', hint: 'Deletes the customised copy', icon: 'reset', danger: true });
    if (licHas('alerts')) items.push({ id: 'thr', label: 'Alarm thresholds…', hint: 'Limits that raise alarms for this machine', icon: 'sliders' }); // D-073
    if (res.candidates.length > 1)
      for (const c of res.candidates) items.push({ id: `switch:${c.dashboard.id}`, label: c.dashboard.name, hint: c.sourceLabel, group: 'switch', checked: c.dashboard.id === st.shownId, icon: 'eye' });
    if (level === 'personal') items.push({ id: 'clearp', label: 'Clear my personal view', icon: 'reset' });
    const acts: Omit<EditActions, 'owner'> = {
      el: root,
      title: node.label,
      subtitle: `From: ${label}${dash ? ` · ${dash.name}` : ''}`,
      items,
      run: (a) => {
        if (a === 'edit') openBuilder({ ctx, deviceId, dashboardId: dash?.id ?? null, chatEnabled: tbCtx.settings?.chatEnabled !== false, onClose: (ch) => ch && notifyChanged() });
        else if (a === 'cust') void customise();
        else if (a === 'reset') void reset();
        else if (a === 'thr') void thresholds(ctx, deviceId, node.label);
        else if (a === 'clearp') void store.clearPersonal(ctx, deviceId).then(notifyChanged);
        else if (a.startsWith('switch:')) {
          st.override = a.slice(7);
          void load();
        }
      },
    };
    publishActions(id, acts);
    // D-058: the same actions from the bar's "Edit dashboard" button (the side menu no longer has a Builder item)
    editButton(acts, { deviceId }, () => st.deviceId === deviceId);
    // Saves a copy of the shared dashboard and assigns it to this device (`dbb_assign` mode `customised`); audited.
    async function customise() {
      if (!(await confirmModal(root, 'Customise for this machine?', `${node!.label} gets its own copy of “${dash!.name}”. It will stop receiving updates made to the shared dashboard.`, 'Customise'))) return;
      try {
        const copy = await store.customise(ctx, deviceId, dash!);
        void audit(ctx, 'dashboard.customise', { deviceId, template: dash!.id, copy: copy.id });
        toast(root, 'Customised copy created.', 'ok');
        notifyChanged();
      } catch (e: any) {
        toast(root, e.message, 'err');
      }
    }
    // Removes the device's `dbb_assign` and its customised copy, so it falls back to the shared dashboard; audited.
    async function reset() {
      if (!(await confirmModal(root, 'Reset to the shared dashboard?', `The customised dashboard for ${node!.label} will be deleted and it will show the shared dashboard again.`, 'Reset', true))) return;
      try {
        await store.resetDevice(ctx, deviceId);
        void audit(ctx, 'dashboard.reset', { deviceId });
        toast(root, 'Reset to the shared dashboard.', 'ok');
        notifyChanged();
      } catch (e: any) {
        toast(root, e.message, 'err');
      }
    }
  }

  /**
   * D-058: "Edit dashboard" (pencil) at the right end of the bar, for a role with dashboards.build (the caller only
   * calls it then): its menu holds the page's edit actions, "New dashboard" (the Builder's New dashboard dialog) and
   * "Open Dashboard Builder" (the Builder on this machine and its dashboard, or on the overview shown). Not on a phone
   * (html.imx-mobile): dashboards are view-only there (D-054). Icon only under 1100 px, like the other bar buttons.
   * `where.deviceId` / `where.dashboardId`: what the Builder opens on; `here()`: the page still shows it.
   */
  function editButton(acts: Omit<EditActions, 'owner'>, where: { deviceId?: string | null; dashboardId?: string | null }, here: () => boolean) {
    const box = head.querySelector('.dbb-ract') as HTMLElement | null;
    if (!box || isMobileApp() || !here()) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dbb-rbtn dbb-redit';
    b.title = 'Edit this dashboard, switch it, or build a new one';
    b.setAttribute('aria-label', 'Edit dashboard');
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.innerHTML = `${UI_ICON.edit}<span>Edit dashboard</span>`;
    // the Builder from the menu: the user context again (a role changed meanwhile applies), busy while it loads
    const builder = (btn: HTMLElement, startNew: boolean) =>
      void withBusy(btn, async () => {
        const ctx = await userContextFor(tbCtx, where.deviceId ?? null, true);
        openBuilder({ ctx, deviceId: where.deviceId ?? null, dashboardId: startNew ? null : where.dashboardId ?? null, startNew, chatEnabled: tbCtx.settings?.chatEnabled !== false, onClose: (ch) => ch && notifyChanged() });
      }).catch((e: any) => toast(root, `Could not open the Dashboard Builder: ${e?.message ?? e}`, 'err'));
    b.addEventListener('click', () => openBarMenu(b, { acts, onNew: (x) => builder(x, true), onBuilder: (x) => builder(x, false) }));
    box.appendChild(b);
  }

  /**
   * D-063: "?" Help for this page, the last item of the bar (the App UI page header's button, U-062 / U-066): opens the
   * app's Help page told which page it was opened from (state 'help' with { helpFrom: the current state id }, as the
   * side menu's Help does), with the app's page bar until the Help page is ready (key 'nav' + window.__imxNav, which
   * the next page's side menu settles). Not when the dashboard has no Help state, and not on a phone (html.imx-mobile).
   * `fallback`: the state id to name when the current one cannot be read.
   */
  function helpButton(fallback: string) {
    if (isMobileApp() || !helpFrom(tbCtx, fallback)) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dbb-rhelp';
    b.dataset.imxTip = 'Help for this page';
    b.setAttribute('aria-label', 'Help for this page');
    b.innerHTML = HELP_SVG;
    b.addEventListener('click', () => {
      const at = helpFrom(tbCtx, fallback);
      if (at) goPage(HELP_STATE, { helpFrom: at });
    });
    // D-071: inside the right-hand group (its last item), so it wraps with the time window and the buttons
    (head.querySelector(':scope > .dbb-rright') ?? head).appendChild(b);
  }
  /**
   * Opens another app page with the app's page bar until it is ready (key 'nav' + window.__imxNav, which the next page's
   * side menu settles): the "?" (D-063) and "Create playbook" (D-068).
   */
  function goPage(state: string, params: Record<string, unknown>) {
    const w = window as any;
    const bar = (on: boolean) => {
      try {
        window.dispatchEvent(new CustomEvent('imx-progress', { detail: { key: 'nav', on, max: 15000 } }));
      } catch {
        /* very old browser */
      }
    };
    w.__imxNav = { at: Date.now(), to: state };
    bar(true);
    try {
      tbCtx.stateController.openState(state, params, false);
    } catch (x) {
      w.__imxNav = null;
      bar(false);
      console.warn(`[dbb] ${state}`, x);
    }
  }

  /**
   * Storyboard round (12 Oct 2026): two compact buttons at the right end of the machine page bar.
   * - Analyzer: opens the app's Analyzer (state `analytics`) with this machine and the properties this dashboard shows
   *   (analyzerKeys); only for a role that can see the Analyzer page.
   * - Create ticket: the app's Create ticket form (window.imxTicket, set up by the side menu; source 'machine') with
   *   the machine, its place, the dashboard, the time window and the status; the user writes subject and description.
   *   Only when the ticket service is on the page and switched on (it can load after this widget: looked for again for
   *   a few seconds).
   * Their tooltips are `title`s (the app's kit shows them as its own tooltip).
   */
  function barActions(ctx: UserContext, deviceId: string, node: scope.Node, where: string, dash: Dashboard | null, shown: Widget[], range: string) {
    const box = head.querySelector('.dbb-ract') as HTMLElement | null;
    if (!box) return;
    const here = () => st.deviceId === deviceId && box.isConnected;
    // D-057: setting analyzerState ('analytics' by default; 'trend' on the phone dashboard "iMEX Mobile": its Trend screen,
    // which counts as the machine's page there, so no Analyzer role is needed). Only where this dashboard has that state
    // (the phone dashboard has no Analyzer).
    const target = analyzerTarget(tbCtx.settings?.analyzerState, deviceId, node, []).state;
    const trend = target === 'trend';
    if (dashHasState(tbCtx, target) && (trend || (ctx.perms.page('analyzer') !== 'hidden' && licHas('analyzer')))) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dbb-rbtn dbb-ran';
      const tip = trend ? 'Show the trend of this machine' : 'Open this machine in the Analyzer';
      b.title = tip;
      b.setAttribute('aria-label', tip);
      b.innerHTML = `${ICON_SVG.chart}<span>${trend ? 'Trend' : 'Analyzer'}</span>`;
      b.addEventListener('click', async () => {
        const keys = analyzerKeys(shown, deviceId, node.profile, ctx.profileKeys[node.profile] ?? []);
        const t = analyzerTarget(tbCtx.settings?.analyzerState, deviceId, node, keys);
        // D-061: the Analyzer opens on the window this page shows (its imxFrom / imxTo, ms)
        if (!trend) {
          const view = st.view ?? null;
          const shift = view ? isShiftRange(view.range) : isShiftRange(range);
          const cal = shift ? await calendarFor(ctx, deviceId).catch(() => null) : null;
          const win = view ? viewWindow(view, cal) : rangeWindow(range, cal);
          if (win) Object.assign(t.params, { imxFrom: Math.round(win.startTs), imxTo: Math.round(win.endTs) });
        }
        tbCtx.stateController?.openState?.(t.state, t.params, false);
      });
      box.appendChild(b);
    }
    // D-068: "Create playbook": the Playbooks page's editor with a new playbook for this machine (playbookTarget: role
    // playbooks.edit + licence playbooks + the dashboard has the page). Not on a phone (no editor there).
    const pb = isMobileApp() ? null : playbookTarget(tbCtx, ctx.perms, deviceId);
    if (pb) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dbb-rbtn dbb-rpb';
      const tip = 'Create a playbook for this machine';
      b.title = tip;
      b.dataset.imxTip = tip;
      b.setAttribute('aria-label', tip);
      b.innerHTML = `${UI_ICON.playbook}<span>Create playbook</span>`;
      b.addEventListener('click', () => goPage(pb.state, pb.params));
      box.appendChild(b);
    }
    // the ticket service: there (open + status) and switched on; null while it is not on the page yet
    const svc = () => {
      const t = (window as any).imxTicket;
      return t && typeof t.open === 'function' && typeof t.status === 'function' ? t : null;
    };
    let tries = 0;
    const addTicket = () => {
      if (!here()) return;
      const T = svc();
      if (!T) {
        if (++tries < 10) setTimeout(addTicket, 1000);
        return;
      }
      void Promise.resolve(T.status()).then(
        (s: any) => {
          if (!here() || !s?.enabled || box.querySelector('.dbb-rtk')) return;
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'dbb-rbtn dbb-rtk';
          // D-061 (A-046): the ticket service refuses a view-only role (403 "Your role can view only"): the button is
          // shown locked with that reason instead of failing after the form
          if (!mayWrite(ctx)) {
            b.classList.add('locked');
            b.setAttribute('aria-disabled', 'true');
            b.title = VIEW_ONLY;
            b.dataset.imxTip = VIEW_ONLY;
            b.setAttribute('aria-label', `Create ticket: ${VIEW_ONLY}`);
            b.innerHTML = `${UI_ICON.lock}<span>Create ticket</span>`;
          } else {
            b.title = 'Create a ticket for this machine';
            b.setAttribute('aria-label', 'Create a ticket for this machine');
            b.innerHTML = `${UI_ICON.ticket}<span>Create ticket</span>`;
            b.addEventListener('click', () => void openTicket(ctx, deviceId, node, where, dash, range));
          }
          // D-058: Edit dashboard stays last (focus order = visual order); D-068: the two Create buttons side by side
          box.insertBefore(b, box.querySelector('.dbb-rpb') ?? box.querySelector('.dbb-redit'));
        },
        () => {
          /* no service answer: no button */
        },
      );
    };
    addTicket();
  }
  /** The Create ticket form for the machine shown, with the page's facts as the description's first lines. */
  async function openTicket(ctx: UserContext, deviceId: string, node: scope.Node, where: string, dash: Dashboard | null, range: string) {
    const T = (window as any).imxTicket;
    if (!T?.open) return;
    // D-061: the window the page shows (the viewer's choice, else the dashboard's)
    const view = st.view ?? null;
    const shift = view ? isShiftRange(view.range) : isShiftRange(range);
    const cal = shift ? await calendarFor(ctx, deviceId).catch(() => null) : null;
    const win = view ? viewWindow(view, cal) : rangeWindow(range, cal);
    // "Last 8 hours, 12 Oct 2026, 4:05 AM - 12:05 PM" (the end's date only when it is another day)
    const sameDay = win && new Date(win.startTs).toDateString() === new Date(win.endTs).toDateString();
    const endText = win ? (sameDay ? dfmt.time(win.endTs) : tkTime(win.endTs)) : '';
    const name = view ? (view.range === 'custom' ? 'Custom' : presetLabel(view.range)) : windowLabel(range);
    const shownWin = win ? `${name}, ${tkTime(win.startTs)} - ${endText}` : name;
    const lines = [
      `Machine: ${node.label || node.name}`,
      where ? `Location: ${where}` : '',
      `Dashboard: ${dash ? dash.name : 'Built-in layout'}`,
      `Time window shown: ${shownWin}`,
      st.status ? `Status: ${st.status}` : '',
      `Created from the machine dashboard at ${tkTime(Date.now())}`,
    ].filter(Boolean);
    try {
      await T.open({ deviceId, deviceName: node.label || node.name, where, source: 'machine', subject: '', description: lines.join('\n') });
    } catch (e: any) {
      toast(root, `The ticket form could not be opened: ${e?.message ?? e}`, 'err');
    }
  }

  /** Shows a stored dashboard not bound to a machine (state param `dbbDashboardId`); a role with dashboards.build gets "Edit". */
  async function showStandalone(ctx: UserContext, dashboardId: string, stale: () => boolean) {
    st.deviceId = null;
    const d = await store.getDashboard(ctx, dashboardId);
    if (stale()) return;
    if (!d) {
      head.innerHTML = `<div class="dbb-banner warn">Dashboard not found.</div>`;
      return;
    }
    const range = normalizeRange(d.timeRange);
    st.range = range;
    st.page = `d:${d.id}`;
    st.view = loadView(ctx.userId, st.page);
    st.winEnd = null;
    st.own = ownWindowCards(d.widgets, range);
    // D-058: the time window and the bar buttons as one group at the right end, as on the machine page
    head.innerHTML = `<div class="dbb-rtitle">${esc(d.name)}</div><div class="dbb-rright">${timeHtml(range, st.view, st.own)}<span class="dbb-ract"></span></div>`;
    helpButton('dashboard_overview'); // D-063
    wirePill(ctx, null);
    shiftLabel(ctx, null);
    ensureGrid(ctx, null, range, d.theme).render(d.widgets.filter((w) => widgetLicensed(w.type))); // D-073
    const acts: Omit<EditActions, 'owner'> | null = mayBuild(ctx) // D-059: role AND licence
      ? { el: root, title: d.name, subtitle: `Dashboard overview · by ${d.ownerName}`, items: [{ id: 'edit', label: 'Edit this dashboard', hint: `Opens “${d.name}” in the Dashboard Builder`, icon: 'edit' }], run: () => openBuilder({ ctx, dashboardId: d.id, chatEnabled: tbCtx.settings?.chatEnabled !== false, onClose: (ch) => ch && notifyChanged() }) }
      : null;
    publishActions(id, acts);
    const key = st.lastKey;
    if (acts) editButton(acts, { dashboardId: d.id }, () => st.lastKey === key && !st.deviceId);
  }

  /**
   * "Alarm thresholds" dialog: edits the device's `thr_*` SERVER_SCOPE attributes, which the device
   * profile alarm rules read as dynamic thresholds (D-003). Empty inputs are left unchanged.
   * Writes via api.saveAttrs and adds a `thresholds.update` audit entry with before/after values.
   */
  async function thresholds(ctx: UserContext, deviceId: string, label: string) {
    const attrs = await api.getAttrs({ id: deviceId, entityType: 'DEVICE' }).catch(() => ({}) as Record<string, any>);
    const keys = Object.keys(attrs).filter((k) => k.startsWith('thr_'));
    if (!keys.length) return toast(root, 'This machine has no threshold attributes.', 'warn');
    const m = modal(
      root,
      `Alarm thresholds — ${label}`,
      `<div class="dbb-form">${keys
        .map((k) => `<label class="dbb-field"><span>${esc(k.replace(/^thr_/, '').replace(/_/g, ' '))}</span><input type="number" step="any" data-k="${esc(k)}" value="${esc(attrs[k])}"/></label>`)
        .join('')}<div class="dbb-hint">An alarm is raised when the value goes above the threshold, and cleared when it drops back.</div></div>`,
      [
        ['cancel', 'Cancel'],
        ['save', 'Save', 'primary'],
      ],
    );
    if ((await m.result) !== 'save') return;
    const vals: Record<string, number> = {};
    m.body.querySelectorAll<HTMLInputElement>('[data-k]').forEach((i) => i.value !== '' && (vals[i.dataset.k!] = Number(i.value)));
    try {
      await api.saveAttrs({ id: deviceId, entityType: 'DEVICE' }, vals);
      void audit(ctx, 'thresholds.update', { deviceId, before: Object.fromEntries(keys.map((k) => [k, attrs[k]])), after: vals });
      toast(root, 'Thresholds saved.', 'ok');
    } catch (e: any) {
      toast(root, e.message, 'err');
    }
  }

  const onChanged = () => void load(true);
  window.addEventListener(CHANGED_EVENT, onChanged);
  // D-059: the licence switched the Builder on or off: the bar's "Edit dashboard" and the published actions follow
  // D-068: also the bar's licensed buttons (Analyzer, Create playbook): the side menu answers yes before it knows
  const licOff = onLicenceChange(() => `${builderLicensed()}|${licHas('analyzer')}|${licHas('playbooks')}|${licHas('alerts')}`, () => void load());
  // Redraws (D-021): on WebSocket pushes (at most every 2 s) + every 60 s; if the socket is down, REST polling
  // every refreshSeconds (10 s) in realtime and every 60 s for historic ranges, as before.
  const stopRedraw = scheduleRedraw(
    () => st.grid?.refreshAll(),
    () => ((st.range && st.range !== 'realtime') || st.view ? 60e3 : (tbCtx.settings?.refreshSeconds ?? 10) * 1000),
  );
  // ThingsBoard does not always call onStateChanged (e.g. an app navbar that switches the machine by
  // changing the state URL), so also watch the page key every 500 ms, like the navbar widget does.
  const watch = setInterval(() => {
    if (pageKey().key !== st.lastKey) void load();
  }, 500);
  // D-033: "Updated x ago" from the newest data point the widgets received (api data clock), every second.
  const tick = () => {
    st.ticks = (st.ticks ?? 0) + 1;
    if (st.ticks % 30 === 0 && st.ctx) shiftLabel(st.ctx, st.deviceId ?? null);
    const el = head.querySelector('.dbb-upd') as HTMLElement | null;
    if (!el) return;
    // D-061: a window that has ended is not live: say so instead of "Updated 3 h ago"
    const end = st.winEnd ?? (st.view?.range === 'custom' && st.view.to! < Date.now() - 90e3 ? st.view.to! : null);
    if (end) {
      const t = el.querySelector('.t') as HTMLElement;
      t.innerHTML = `Not live · ended <b>${esc(dfmt.dateTime(end, { short: true }))}</b>`;
      el.className = 'dbb-upd';
      el.title = 'This time window has ended: the cards show it as it was, with the values at its end. Pick a window that ends now (e.g. Last hour) for live values.';
      return;
    }
    const ts = api.lastDataTs();
    const t = el.querySelector('.t') as HTMLElement;
    if (!ts) {
      t.textContent = 'Waiting for data…';
      el.className = 'dbb-upd';
      el.removeAttribute('title');
      return;
    }
    const age = Date.now() - ts;
    const txt = agoWords(ts);
    t.innerHTML = `Updated <b>${esc(txt)}</b>`;
    el.className = `dbb-upd ${age < 2 * 60e3 ? 'fresh' : age > 15 * 60e3 ? 'old' : ''}`;
    el.title = `Newest data point on this dashboard: ${dfmt.dateTime(ts, { seconds: true })}`;
  };
  const ticker = setInterval(tick, 1000);
  // D-056: the app switched light / dark: the theme again (a light dashboard follows the app), every card redrawn
  const onMode = () => {
    if (st.grid && st.ctx) ensureGrid(st.ctx, st.deviceId ?? null, st.range ?? 'realtime', st.theme ?? undefined);
    else applyTheme(root, st.theme);
  };
  window.addEventListener('imx-mode-changed', onMode);
  (tbCtx as any).__dbbCleanup = () => {
    window.removeEventListener('imx-mode-changed', onMode);
    clearInterval(watch);
    clearInterval(ticker);
    window.removeEventListener(CHANGED_EVENT, onChanged);
    licOff();
    stopRedraw();
    publishActions(id, null);
    closeBarMenu(root);
    closeWindowMenu(root);
    st.grid?.destroy();
    headMO?.disconnect(); // D-071
    headRO?.disconnect();
    if (fitRaf) cancelAnimationFrame(fitRaf);
  };
  // onStateChanged: reload only if the page key changed (the watch may already have done it).
  (tbCtx as any).__dbbReload = () => {
    if (pageKey().key !== st.lastKey) void load();
  };
  void load();
}

/**
 * Most recent telemetry time (max `ts` over the latest values) and the machine's status (D-064: the machine model).
 * Uses the machine type's catalogue keys (dbb_profile_keys, up to 20) plus the type's status keys, read through the
 * WebSocket live cache (D-022: normally no REST call; the widgets subscribe the same keys). Machine types
 * without a catalogue fall back to listing the device's keys (2 REST calls).
 */
async function lastTelemetry(ctx: UserContext, deviceId: string, profile: string, label = ''): Promise<{ lastTs: number | null; result: machine.Result }> {
  let keys = (ctx.profileKeys[profile] ?? []).map((k) => k.key).slice(0, 20);
  if (!keys.length) keys = (await api.timeseriesKeys(deviceId).catch(() => [] as string[])).slice(0, 20);
  const mm = await machine.load(api.systemConfigMachineModel);
  const type = machine.kindOf(profile, label);
  for (const k of machine.statusKeys(mm, type)) if (!keys.includes(k)) keys.push(k);
  const l = await api.latest(deviceId, keys, true).catch(() => ({}) as api.Latest);
  const ts = Object.values(l).map((v) => v?.ts ?? 0);
  return { lastTs: ts.length ? Math.max(...ts) || null : null, result: machine.status(mm, type, l as machine.Latest) };
}

/** Widget onStateChanged: reloads for the new state entity (keeps the user context cache). */
export function onStateChanged(tbCtx: any) {
  (tbCtx as any).__dbbReload?.();
}

/** Widget onDestroy: stops the timer, removes listeners, clears this widget's edit actions, destroys the grid. */
export function destroy(tbCtx: any) {
  if (tbCtx) liveRelease(tbCtx);
  (tbCtx as any).__dbbCleanup?.();
}
