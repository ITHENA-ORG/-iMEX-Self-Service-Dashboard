/**
 * Widget renderers shared by the builder canvas, the machine dashboard renderer and previews.
 *
 * WHERE IT RUNS
 * In the browser, inside a ThingsBoard CE custom widget (D-010). All data comes from the
 * ThingsBoard REST API with the logged-in user's own JWT (via core/api). No framework: plain DOM,
 * HTML strings and SVG (charts come from ./charts).
 *
 * MAIN EXPORTS
 * - renderWidget(container, widget, env)  draws one widget card and returns a WidgetHandle.
 * - resolveBinding / bindingLabel         turn a widget's data source (Binding) into devices / a label.
 * - keyMeta                               display name, unit, decimals, min/max for a property key.
 * - cardVars                              CSS custom properties for a card's style settings.
 * - defaultWidgets                        built-in layout used when no dashboard is assigned (D-013).
 * - RenderEnv, BoundDevices, WidgetHandle types.
 *
 * WHO CALLS IT
 * render/grid.ts (the 12-column grid used by entries/renderer.ts and the builder canvas) calls
 * renderWidget once per widget and keeps the handle. builder/builder.ts uses bindingLabel,
 * defaultWidgets and keyMeta; entries/renderer.ts uses defaultWidgets; render/templates.ts and
 * entries/listing.ts use keyMeta.
 *
 * RENDER PIPELINE
 * renderWidget builds the card chrome (title, icon, info tooltip, footer) and calls draw().
 * draw() branches on widget.type:
 *   1. Content widgets (text, image, embed, link) need no data source and return early.
 *   2. Data widgets: check the key count against WIDGET_CAPS, resolve the binding to devices,
 *      compute the time window, check property kind vs widget type (core/compat), then fetch data
 *      over REST and hand it to a chart function (lineChart, barChart, gauge, sparkline, donut,
 *      stateTimeline, heatmap) or write HTML directly (value, status, multi-value, table, alarms...).
 *   3. draw() returns the colour rule that matched (or null / undefined) and renderWidget applies it
 *      to the card via applyRuleToCard.
 * Any thrown error (for example an api.ApiError) is caught in refresh() and shown as a placeholder
 * inside the card, so one failing widget never breaks the page.
 *
 * BINDINGS -> DEVICES (resolveBinding; scope helpers in core/scope.ts)
 * - none:      content widgets, no devices.
 * - current:   the machine the dashboard is opened for (env.deviceId).
 * - fixed:     specific device ids; ids not in the user's scope are counted in `hidden`.
 * - siblings:  devices of a profile under the same parent asset as the current machine.
 * - nearest:   closest device of a profile walking up from the current machine (e.g. site weather station).
 * - nodeQuery: all devices of a profile below a given asset node.
 * Scope is the user's `selectedNodes` subtree (D-011) and is enforced in the UI only (D-012).
 *
 * TIME RANGE (schema TIME_RANGES / normalizeRange / rangeWindow, D-020, D-047)
 * 'realtime' = latest values; time-based widgets use a rolling last hour. Historic '1h' | '2h' |
 * '4h' | '8h' = fixed window ending now. Longer stored ranges are read as '8h' by normalizeRange.
 * 'shift' = the current shift so far, 'prevshift' = the last ended shift, from the shift calendar of the
 * dashboard's machine (env.deviceId), else the widget's first machine (core/shifts.ts calendarFor). No shifts
 * set up there: time-based widgets say so instead of guessing a window.
 * A widget's settings.timeRange overrides the dashboard's env.timeRange.
 *
 * LIMITS (core/schema)
 * MAX_SERIES (8) caps devices per multi-device widget and lines per chart; the chart says how
 * many were not drawn. MAX_WIDGETS (10) bounds defaultWidgets. MAX_KEYS / MAX_DEVICES are enforced
 * by checkDashboard on save, not here: older dashboards over the limits still render.
 *
 * COLOUR RULES (render/rules.ts, D-019)
 * effectiveRules() gives the widget's rules (legacy bands/statusMap converted). The first match
 * wins. settings.colorTarget chooses what a card-level match colours: 'background' (tint + accent
 * bar, default), 'accent', 'icon' or 'value'. Charts draw number rules as threshold lines, gauges
 * as zones, tables colour cells.
 *
 * LOADING (D-043)
 * Until the first draw a data widget shows a placeholder in the shape of its type (kit skeleton, cardSkeleton) and,
 * with env.busyKey, counts for the app's page bar. A redraw for a new time range or theme (handle.update) shows a
 * 2 px hairline on the card while it loads; live pushes and timer redraws (handle.refresh) stay silent.
 *
 * REFRESH MODEL (D-021)
 * The caller decides when to redraw: entries/renderer.ts calls Grid.refreshAll() when the WebSocket
 * (core/live.ts) pushes a change for a machine on the page (batched, at most every 2 s), plus a safety
 * redraw every 60 s. If the socket is down it falls back to the old REST polling (every
 * settings.refreshSeconds, 60 s for historic ranges). A redraw calls handle.refresh() on every widget,
 * which re-runs draw(); the data calls below are served from the live cache / short caches in
 * core/api.ts, so a redraw normally makes no REST call.
 *
 * ADDING A NEW WIDGET TYPE (checklist)
 * 1. core/schema.ts: add to WIDGET_TYPES, WIDGET_LABELS, WIDGET_GROUPS (palette), WIDGET_CAPS
 *    (key count, multiDevice, needsData), DEFAULT_SIZE; CONTENT_TYPES if it needs no data; any new
 *    settings in WidgetSettings.
 * 2. core/compat.ts: add the accepted property kinds to ACCEPTS.
 * 3. This file: add a branch in draw() (and a chart function in ./charts if needed).
 * 4. builder/builder.ts: defaults when the widget is added (title, keys, settings) and any
 *    type-specific fields in the Settings tab.
 * 5. render/icons.ts: a palette icon in WIDGET_ICON.
 * 6. core/chat.ts: describe the type and its settings in systemPrompt() so the chat can use it.
 */
import * as api from '../core/api';
import * as scope from '../core/scope';
import * as machine from '../core/machine';
import type { UserContext, Node } from '../core/scope';
import type { KeyMeta } from '../core/types';
import { Widget, Binding, WIDGET_CAPS, WIDGET_LABELS, CONTENT_TYPES, MAX_SERIES, MAX_WIDGETS, rangeWindow, isShiftRange, normalizeRange, CardStyle, DashboardTheme, ColorRule } from '../core/schema';
import { calendarFor } from '../core/shifts';
import { viewWindow, hasEnded, presetLabel, chipLabel } from '../core/viewwindow';
import type { ViewWindow } from '../core/viewwindow';
import * as fmt from '../core/datefmt';
import { cardSkeleton, topProgress, pageBusy } from './kit';
import { compatible } from '../core/compat';
import { widgetLicensed } from '../core/licence';
import { SERIES, SERIES_DARK, STATUS, SEVERITY_COLOR, RAMP_BLUE, RAMP_ORANGE, esc, fmtNum, ago, miniMarkdown, fontStack, loadFont, safeUrl, darkColor } from './theme';
import { lineChart, barChart, gauge, sparkline, donut, stateTimeline, heatmap, Slice, TimelineRow, HeatRow } from './charts';
import { effectiveRules, matchRule, thresholdLines, stateLabel, valueType, asBool, cssColor } from './rules';
import { sanitizeHtml, fillPlaceholders, placeholderKeys } from './rich';
import { icon, ICON_SVG } from './icons';

/** Everything a widget needs from its surroundings to draw. One env is shared by all widgets of a grid. */
export interface RenderEnv {
  /** Logged-in user's scope: nodes in scope, profile key catalogue, role (core/scope). */
  ctx: UserContext;
  /** Machine the dashboard is opened for (null for standalone dashboards). */
  deviceId: string | null;
  /** Dashboard time range ('realtime' | '1h' | '2h' | '4h' | '8h'; older values are normalised). */
  timeRange: string;
  /**
   * D-061: the viewer's time window from the page's picker (core/viewwindow.ts). Set: every card shows this window, also
   * one with its own range; null / missing: the dashboard's range (or the card's own).
   */
  view?: ViewWindow | null;
  theme?: DashboardTheme | null;
  /** Dark theme: charts use SERIES_DARK instead of SERIES. */
  dark?: boolean;
  /** D-056: a light dashboard drawn dark because the app is in dark mode: the cards' own light colours are toned down. */
  appDark?: boolean;
  /** Builder canvas: links and buttons don't navigate. */
  editing?: boolean;
  /** Opens a dashboard state (link widgets). nodeId: machine or location to open it for. */
  navigate?(stateId: string, nodeId: string | null): void;
  /** D-043: first draws count for the app's page bar under this key (machine page, Dashboard Overview). */
  busyKey?: string;
  /** D-053: every widget of the dashboard (set by the Grid), for the {{machines}} and {{locations}} counts of text widgets. */
  widgets?: Widget[];
}

/** Result of resolving a widget's Binding. */
export interface BoundDevices {
  /** Devices in the user's scope, in binding order. */
  devices: Node[];
  /** Devices referenced by the binding but outside the user's scope. */
  hidden: number;
  /** User-facing message when the binding can't be resolved (shown instead of data). */
  problem?: string;
}

/**
 * Resolves a widget's data source to the devices it should show, using only the in-memory scope
 * (no REST calls). See the file header for what each mode means.
 * @param env Render environment; env.deviceId is the "current" machine for relative modes.
 * @param b The widget's binding.
 * @returns Devices in scope, a count of referenced-but-hidden ones, and an optional problem message.
 *   Relative modes (current, siblings, nearest) return a problem when no machine is open.
 *   A current machine or nodeQuery node outside the scope returns no devices and hidden = 1.
 */
export function resolveBinding(env: RenderEnv, b: Binding): BoundDevices {
  const { ctx, deviceId } = env;
  const cur = deviceId ? ctx.nodes.get(deviceId) : undefined;
  switch (b.mode) {
    case 'none':
      return { devices: [], hidden: 0 };
    case 'current':
      if (!deviceId) return { devices: [], hidden: 0, problem: 'Open this dashboard for a machine to see data.' };
      if (!cur) return { devices: [], hidden: 1 };
      return { devices: [cur], hidden: 0 };
    case 'fixed': {
      const devices = b.deviceIds.map((id) => ctx.nodes.get(id)).filter((n): n is Node => !!n && n.entityType === 'DEVICE');
      return { devices, hidden: b.deviceIds.length - devices.length };
    }
    case 'siblings':
      if (!deviceId) return { devices: [], hidden: 0, problem: 'Open this dashboard for a machine to see data.' };
      return { devices: scope.siblings(ctx, deviceId, b.profile), hidden: 0 };
    case 'nearest': {
      if (!deviceId) return { devices: [], hidden: 0, problem: 'Open this dashboard for a machine to see data.' };
      const n = scope.nearest(ctx, deviceId, b.profile);
      return n ? { devices: [n], hidden: 0 } : { devices: [], hidden: 0, problem: `No ${b.profile} found near this machine.` };
    }
    case 'nodeQuery':
      if (!ctx.nodes.has(b.nodeId)) return { devices: [], hidden: 1 };
      return { devices: scope.devicesUnder(ctx, b.nodeId, b.profile), hidden: 0 };
  }
}

/**
 * Display metadata for a property of a machine type, from the store's `dbb_profile_keys` catalogue (D-013).
 * Keys missing from the catalogue still work: they get the key as name, no unit, 1 decimal, range 0-100.
 */
export function keyMeta(ctx: UserContext, profile: string, key: string): KeyMeta {
  const m = ctx.profileKeys[profile]?.find((k) => k.key === key);
  return m ?? { key, displayName: key, unit: '', decimals: 1, min: 0, max: 100 };
}

/** Short human description of a binding for the builder ("This machine", "Nearest Weather Station"...). Out-of-scope ids are named generically, never by name. */
export function bindingLabel(ctx: UserContext, b: Binding): string {
  switch (b.mode) {
    case 'current':
      return 'This machine';
    case 'fixed':
      return b.deviceIds.map((id) => ctx.nodes.get(id)?.label ?? 'machine outside your access').join(', ');
    case 'siblings':
      return `${b.profile} machines at the same location`;
    case 'nearest':
      return `Nearest ${b.profile}`;
    case 'nodeQuery':
      return `All ${b.profile || 'machines'} in ${ctx.nodes.get(b.nodeId)?.label ?? 'a node outside your access'}`;
    default:
      return '';
  }
}

/** Returned by renderWidget. The caller keeps it to refresh or remove the widget. */
export interface WidgetHandle {
  /** Re-fetches data over REST and redraws the body. Never rejects: errors are shown in the card. No-op after destroy(). */
  refresh(): Promise<void>;
  /**
   * D-043: redraws for a new environment (time range, theme) keeping the shown content until the new one is drawn,
   * with a 2 px hairline on the card meanwhile. Not for another machine (Grid re-creates the cards then).
   */
  update(env: RenderEnv): Promise<void>;
  /** Stops further refreshes and empties the container. */
  destroy(): void;
}

/** Unique part of the page-bar keys of cards (D-043). */
let cardSeq = 0;

/** Replaces a widget body with a centred grey message. */
/**
 * Sets static content (image, embedded page) only when it differs from what is shown, so a data refresh
 * does not reload the iframe or re-decode the image (that reload was visible as a flicker every 10 s).
 */
const setStatic = (body: HTMLElement, html: string) => {
  if (body.dataset.static === html && body.firstElementChild) return;
  body.innerHTML = html;
  body.dataset.static = html;
};
const placeholder = (body: HTMLElement, msg: string) => {
  delete body.dataset.static;
  body.innerHTML = `<div class="dbb-ph">${esc(msg)}</div>`;
};

// ---------- card styling ----------

/**
 * WCAG relative luminance (0 = black, 1 = white) of a #rgb / #rrggbb(aa) colour.
 * Returns null for anything else (named colours, rgb(), gradients), so callers leave text colours alone.
 */
function hexLum(c?: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c ?? '');
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (x) => x + x);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Same values as SHADOWS / PADS in theme.ts (card-level overrides of the dashboard theme).
const SHADOW: Record<string, string> = {
  none: 'none',
  soft: '0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.08)',
  strong: '0 4px 10px rgba(16,24,40,.08), 0 12px 28px rgba(16,24,40,.12)',
};
const PAD: Record<string, string> = { compact: '6px', normal: '10px', roomy: '16px' };

/**
 * CSS custom properties for a card from its style settings (Style tab, D-019/D-020).
 * The card CSS in theme.ts reads these (--card-bg, --card-border, --card-title-*, --card-value-*,
 * --card-align*, --card-justify, --card-accent...) and falls back to the dashboard theme tokens.
 * @param st The widget's settings.style (may be undefined).
 * @returns A `style` attribute string ("--a:b;--c:d"), or '' when there is nothing to set.
 */
export function cardVars(st: CardStyle | undefined, appDark = false): string {
  if (!st) return '';
  // D-056: in the app's dark mode a light dashboard's white / light-grey card colours give way to the dark surface,
  // pastel tints are toned down, near-black text colours give way to the dark theme's text; coloured tiles stay.
  if (appDark) st = darkCardStyle(st);
  const v: string[] = [];
  if (st.bg) {
    // A hex background also switches the text/grid tokens to light or dark ink for contrast.
    v.push(`--card-bg:${st.gradient ? `linear-gradient(135deg, ${st.bg}, color-mix(in srgb, ${st.bg} 72%, #000))` : st.bg}`);
    const L = hexLum(st.bg);
    if (L !== null && L < 0.3) v.push('--ink:#ffffff;--ink-2:rgba(255,255,255,.8);--ink-3:rgba(255,255,255,.62);--grid:rgba(255,255,255,.14);--line:rgba(255,255,255,.2);--hover:rgba(255,255,255,.08)');
    else if (L !== null) v.push('--ink:#0b0b0b;--ink-2:#52514e;--ink-3:#6e6d68;--grid:rgba(0,0,0,.07);--line:rgba(0,0,0,.1);--hover:rgba(0,0,0,.04)');
  }
  if (st.border) v.push(`--card-border:${st.border === 'none' ? '0' : `${st.border === 'thick' ? 2 : 1}px solid ${st.borderColor ?? 'var(--line)'}`}`);
  else if (st.borderColor) v.push(`--card-border:1px solid ${st.borderColor}`);
  if (st.radius !== undefined) v.push(`--card-radius:${st.radius}px`);
  if (st.shadow) v.push(`--card-shadow:${SHADOW[st.shadow]}`);
  if (st.padding) v.push(`--card-pad:${PAD[st.padding]}`);
  if (st.titleColor) v.push(`--card-title-color:${st.titleColor}`);
  if (st.titleSize) v.push(`--card-title-size:${st.titleSize}px`);
  if (st.titleWeight) v.push(`--card-title-weight:${st.titleWeight}`);
  if (st.titleFont) v.push(`--card-title-font:${fontStack(st.titleFont)}`);
  if (st.titleAlign) v.push(`--card-title-justify:${st.titleAlign === 'center' ? 'center' : st.titleAlign === 'right' ? 'flex-end' : 'flex-start'}`);
  if (st.iconColor) v.push(`--card-icon:${st.iconColor}`);
  if (st.valueSize) v.push(`--card-value-size:${st.valueSize}px`);
  if (st.valueColor) v.push(`--card-value-color:${st.valueColor}`);
  if (st.valueFont) v.push(`--card-value-font:${fontStack(st.valueFont)}`);
  if (st.align) v.push(`--card-align:${st.align};--card-align-items:${st.align === 'center' ? 'center' : st.align === 'right' ? 'flex-end' : 'flex-start'}`);
  if (st.valign) v.push(`--card-justify:${st.valign === 'top' ? 'flex-start' : st.valign === 'bottom' ? 'flex-end' : 'center'};--card-valign:${st.valign === 'top' ? 'start' : st.valign === 'bottom' ? 'end' : 'center'}`);
  if (st.accentBar) v.push(`--card-accent:${st.accentBar}`);
  return v.join(';');
}

const INFO = ICON_SVG.info;

/** True when `url` is on the page's own origin (D-028). */
function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === location.origin;
  } catch {
    return true;
  }
}

/**
 * Applies the matched colour rule to the card according to settings.colorTarget:
 * 'background' (default) = accent bar + 13% tint over the card background, 'accent' = bar only,
 * 'icon' = title icon colour, 'value' = value text colour. With no rule it resets the tint and
 * restores the style's own accent bar. Called after every refresh, so it must be idempotent.
 */
function applyRuleToCard(card: HTMLElement, w: Widget, rule: ColorRule | null) {
  const target = w.settings.colorTarget ?? 'background';
  card.classList.toggle('accent', !!(rule && target !== 'value' && target !== 'icon') || !!w.settings.style?.accentBar);
  card.style.background = '';
  if (!rule) {
    if (w.settings.style?.accentBar) card.style.setProperty('--card-accent', w.settings.style.accentBar);
    return;
  }
  if (target === 'background') {
    card.style.setProperty('--card-accent', rule.color);
    card.style.background = `linear-gradient(0deg, color-mix(in srgb, ${rule.color} 13%, transparent), color-mix(in srgb, ${rule.color} 13%, transparent)), var(--card-bg, var(--surface))`;
  } else if (target === 'accent') card.style.setProperty('--card-accent', rule.color);
  else if (target === 'icon') card.style.setProperty('--card-icon', rule.color);
  else card.style.setProperty('--card-value-color', rule.color);
}

/**
 * Draws one widget as a card inside `container` and starts its first data load.
 * @param container Element to fill; its previous content is removed.
 * @param w The widget (type, binding, keys, settings).
 * @param env Render environment (user scope, current machine, time range, theme).
 * @param opts.chrome false = hide the title row (used for compact previews).
 * @returns A handle whose refresh() re-fetches and redraws; the caller schedules refreshes (see header).
 * Side effects: may inject a Google Fonts <link> (loadFont) and issues the REST calls of draw().
 * The first load is started immediately and not awaited.
 */
export function renderWidget(container: HTMLElement, w: Widget, env: RenderEnv, opts: { chrome?: boolean } = {}): WidgetHandle {
  container.innerHTML = '';
  const st = w.settings.style;
  if (st?.titleFont) loadFont(st.titleFont);
  if (st?.valueFont) loadFont(st.valueFont);
  const card = document.createElement('div');
  card.className = 'dbb-card';
  card.dataset.type = w.type;
  if (st?.titlePos === 'bottom') card.classList.add('title-bottom');
  if (st?.align) card.classList.add(`al-${st.align}`);
  const vars = cardVars(st, !!env.appDark);
  if (vars) card.setAttribute('style', vars);
  const content = CONTENT_TYPES.has(w.type);
  // Content widgets show a title only if one was typed; a link's title is its button label instead.
  const hasTitle = content ? !!w.title && w.type !== 'link' : true;
  const showTitle = hasTitle && !st?.hideTitle && opts.chrome !== false;
  const desc = w.settings.description ? sanitizeHtml(w.settings.description) : '';
  const ic = icon(st?.icon);
  card.innerHTML = `${
    showTitle || desc
      ? `<div class="dbb-card-h">${ic && showTitle ? `<span class="dbb-card-i">${ic}</span>` : ''}${showTitle ? `<div class="dbb-card-t" title="${esc(w.title || WIDGET_LABELS[w.type])}">${esc(w.title || WIDGET_LABELS[w.type])}</div>` : ''}<span class="grow"></span>${
          desc ? `<span class="dbb-info" tabindex="0" aria-label="About this widget">${INFO}<span class="dbb-info-pop">${desc}</span></span>` : ''
        }</div>`
      : ''
  }<div class="dbb-card-b"></div>${w.settings.footer ? `<div class="dbb-card-f">${esc(w.settings.footer)}</div>` : ''}`;
  if (st?.accentBar) {
    card.classList.add('accent');
    card.style.setProperty('--card-accent', st.accentBar);
  }
  // An unstyled link widget is just the button, without card background or border.
  if (w.type === 'link' && st?.bg === undefined && st?.border === undefined) card.classList.add('plain');
  container.appendChild(card);
  const body = card.querySelector('.dbb-card-b') as HTMLElement;
  if (w.type === 'image' || w.type === 'embed' || w.type === 'link') body.style.padding = showTitle ? '4px var(--card-pad,var(--pad)) var(--card-pad,var(--pad))' : w.type === 'link' ? '0' : 'var(--card-pad,var(--pad))';
  let alive = true;

  // The fade-in plays on the first draw only; later refreshes replace the content without any animation
  // (the fade on every refresh was the flicker seen when new values arrived).
  body.classList.add('dbb-first');
  let drawn = false;
  // D-043: a data widget shows a placeholder in its own shape until the first draw (and counts for the page bar).
  // Only after 150 ms: a draw served from the live cache (most redraws while editing) shows no flash.
  const skel = !content;
  const skelTimer = skel
    ? setTimeout(() => {
        if (alive && !drawn && !body.firstElementChild) body.innerHTML = cardSkeleton(w.type);
      }, 150)
    : null;
  const busyKey = env.busyKey && skel ? `${env.busyKey}:${w.id}:${++cardSeq}` : null;
  if (busyKey) pageBusy(busyKey, true);
  // D-028: one draw at a time per widget; a refresh asked for while one is running runs once afterwards
  // (on a slow server, overlapping refreshes would otherwise pile up requests).
  let running: Promise<void> | null = null;
  let again = false;
  const refresh = async (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = drawOnce().finally(() => (running = null));
    await running;
    if (again && alive) {
      again = false;
      return refresh();
    }
  };
  const firstDone = () => {
    if (drawn) return;
    drawn = true;
    if (busyKey) pageBusy(busyKey, false);
    setTimeout(() => body.classList.remove('dbb-first'), 400);
  };
  const drawOnce = async () => {
    if (!alive) return;
    try {
      const rule = await draw(body, w, env);
      if (!alive) return;
      // D-061 (M10): a value too wide for its tile is drawn smaller (or cut, with the full value on hover); the
      // Builder hears about tiles where that went far (event dbb-fit, Grid shows a warning on the box)
      const fit = fitValue(body);
      const fitState = fit === 'tight' || fit === 'cut' ? fit : '';
      if ((card.dataset.fit ?? '') !== fitState) {
        card.dataset.fit = fitState;
        card.dispatchEvent(new CustomEvent('dbb-fit', { bubbles: true, detail: { id: w.id, state: fitState } }));
      }
      // a type that drew nothing must not keep its placeholder
      if (body.firstElementChild?.classList.contains('dbb-skel')) body.innerHTML = '';
      firstDone();
      // undefined = this widget type doesn't colour the card; null = clear any previous rule colour.
      if (rule !== undefined) applyRuleToCard(card, w, rule);
    } catch (e: any) {
      if (!alive) return;
      firstDone();
      placeholder(body, `Could not load data (${e?.status ?? ''} ${e?.message?.slice(0, 80) ?? e})`);
    }
  };
  void refresh();
  return {
    refresh,
    async update(next: RenderEnv) {
      env = next;
      if (!alive) return;
      // a card still on its placeholder needs no hairline
      const bar = drawn && !content ? topProgress(card, { height: 2, cls: 'dbb-hair', label: 'Updating' }) : null;
      await refresh();
      bar?.done();
    },
    destroy() {
      alive = false;
      if (skelTimer) clearTimeout(skelTimer);
      if (busyKey && !drawn) pageBusy(busyKey, false);
      container.innerHTML = '';
    },
  };
}

// ---------- data helpers ----------

/**
 * Cache-key part for a window: its length and how long ago it ended, in minutes (D-047: a shift window that ended
 * earlier must not share a cache entry with a window of the same length ending now).
 */
const winKey = (startTs: number, endTs: number) => `${Math.round((endTs - startTs) / 60e3)}|${Math.max(0, Math.round((Date.now() - endTs) / 60e3))}`;

/**
 * Raw (not aggregated) points of one key, oldest first. Used for state segments (donut "state", timeline).
 * REST: GET /api/plugins/telemetry/DEVICE/{id}/values/timeseries?agg=NONE&limit=5000
 * (limit is always passed: ThingsBoard returns only 100 points without it). Values stay strings.
 */
async function rawSeries(deviceId: string, key: string, startTs: number, endTs: number): Promise<{ ts: number; value: string }[]> {
  // 60 s cache while the WebSocket is live (D-021); plain REST otherwise.
  const r = await api.getCached<Record<string, { ts: number; value: string }[]>>(
    `raw|${deviceId}|${key}|${winKey(startTs, endTs)}`,
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${encodeURIComponent(key)}&startTs=${startTs}&endTs=${endTs}&agg=NONE&orderBy=ASC&limit=${rawLimit(startTs, endTs)}`,
    60e3,
  );
  return (r?.[key] ?? []).slice().sort((a, b) => a.ts - b.ts);
}

/**
 * One aggregate (MIN / MAX / AVG / SUM) of a key over the whole window: core/api.ts windowAgg (D-048), which keeps a
 * window ending now current from the pushed live points instead of a REST read on every 60 s redraw.
 * @returns The number, or null when there is no data in the window.
 */
function aggValue(deviceId: string, key: string, startTs: number, endTs: number, agg: string, fixedStart = false): Promise<number | null> {
  return api.windowAgg(deviceId, key, startTs, endTs, agg as 'MIN' | 'MAX' | 'AVG' | 'SUM', { fixedStart });
}

/** State segments: a value holds until the next point; gaps longer than max(3x median step, 15 min) are "no data". */
function toSegments(pts: { ts: number; value: string }[], endTs: number) {
  // Median sample step sets the gap tolerance; the last point holds until endTs (or now), capped by maxGap.
  const steps = pts.slice(1).map((p, i) => p.ts - pts[i].ts).sort((a, b) => a - b);
  const maxGap = Math.max(15 * 60e3, 3 * (steps[Math.floor(steps.length / 2)] || 0));
  const segs: { start: number; end: number; value: string }[] = [];
  pts.forEach((p, i) => {
    const next = i + 1 < pts.length ? pts[i + 1].ts : Math.min(endTs, Date.now());
    const end = Math.min(next, p.ts + maxGap);
    const last = segs[segs.length - 1];
    // Extend the previous segment when the value repeats without a gap.
    if (last && last.value === String(p.value) && last.end >= p.ts - 1) last.end = end;
    else segs.push({ start: p.ts, end, value: String(p.value) });
  });
  return segs.filter((s) => s.end > s.start);
}

/**
 * Colour of a state value: matching colour rule, else good/neutral for on/off, else the next
 * palette colour. `order` is mutated (unseen values are appended) so one value keeps one colour
 * across all rows of a timeline or all slices of a donut.
 */
function stateColor(raw: string, rules: ColorRule[], key: string, order: string[], palette: string[]): string {
  const r = matchRule(rules, raw, key);
  if (r) return r.color;
  const b = asBool(raw);
  if (b === true) return STATUS.good;
  if (b === false) return STATUS.neutral;
  let i = order.indexOf(raw);
  if (i < 0) i = order.push(raw) - 1;
  return palette[i % palette.length];
}

/** Coloured pill with the rule's label (dark or white text by luminance), or '' when the rule has no label. */
function ruleLabelPill(rule: ColorRule | null): string {
  return rule?.label ? `<span class="lbl" style="background:${rule.color};color:${(hexLum(rule.color) ?? 0) > 0.45 ? '#0b0b0b' : '#fff'}">${esc(rule.label)}</span>` : '';
}

/** Formats numeric values with `dec` decimals; anything else (text, booleans, empty) is escaped as is ('—' for null). Returns HTML. */
/** Widget types that show latest values only: they need no time window (D-047). */
export const LATEST_ONLY = new Set(['value', 'gauge', 'status', 'progress', 'multivalue', 'table']);

/**
 * D-061: page size of a raw (agg NONE) read: 5000 points for windows up to about 11 h, more for the viewer's longer
 * windows (one point per 8 s, the simulator sends one per 10 s), at most 100 000. A smaller limit would cut the window's
 * end off (oldest first).
 */
export const rawLimit = (startTs: number, endTs: number) => Math.min(100000, Math.max(5000, Math.ceil((endTs - startTs) / 8000)));

/**
 * D-061: the chip in a card's title row naming the card's own time window ("4 h", "Shift") while the page shows the
 * dashboard's window; `range` null removes it. A card without a title row gets the note as its tooltip instead.
 */
function windowChip(body: HTMLElement, range: string | null) {
  const card = body.closest('.dbb-card') as HTMLElement | null;
  if (!card) return;
  const head = card.querySelector(':scope > .dbb-card-h') as HTMLElement | null;
  let chip = card.querySelector(':scope > .dbb-card-h > .dbb-card-win') as HTMLElement | null;
  const tip = range ? `This card has its own time window: ${presetLabel(range)}. Pick a time window at the top of the page to show every card for the same period.` : '';
  if (!range) {
    chip?.remove();
    if (card.dataset.wintip) {
      card.removeAttribute('title');
      delete card.dataset.wintip;
    }
    return;
  }
  if (!head) {
    card.title = tip;
    card.dataset.wintip = '1';
    return;
  }
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'dbb-card-win';
    head.insertBefore(chip, head.querySelector(':scope > .dbb-info'));
  }
  chip.textContent = chipLabel(range);
  chip.title = tip;
  chip.setAttribute('aria-label', tip);
}

/** Smallest font size a tile's value is drawn at (px); the status pill's text stops at 10 px. */
export const MIN_VALUE_PX = 12;
/**
 * D-061 (audit M10): fits the big value of a value / KPI / progress / status tile into its width. Too wide: the value's
 * font is made smaller (not below MIN_VALUE_PX), and if it still does not fit the value is cut with an ellipsis; either
 * way the full value is its tooltip. The unit and the change pill keep their size.
 * @returns 'ok' (fits as drawn), 'shrunk' (fits at ≥ 60 % of its size), 'tight' (fits only below 60 %), 'cut', or null
 *          when the card has no such value or is not laid out (hidden).
 */
export function fitValue(body: HTMLElement): 'ok' | 'shrunk' | 'tight' | 'cut' | null {
  const pill = body.querySelector(':scope > .dbb-value > .dbb-pill') as HTMLElement | null;
  const v = pill ? (pill.querySelector('.pt') as HTMLElement | null) : (body.querySelector('.dbb-value .vl > .v') as HTMLElement | null);
  if (!v) return null;
  const line = pill ?? (v.parentElement as HTMLElement);
  const host = line.parentElement as HTMLElement;
  const sizeOf = pill ?? v;
  sizeOf.style.fontSize = '';
  v.classList.remove('cut');
  v.style.maxWidth = '';
  const avail = host.getBoundingClientRect().width;
  if (!avail) return null;
  const need = line.getBoundingClientRect().width;
  if (need <= avail + 0.5) {
    if (v.dataset.fitTip) {
      v.removeAttribute('title');
      delete v.dataset.fitTip;
    }
    return 'ok';
  }
  if (!v.title || v.dataset.fitTip) {
    v.title = (line.textContent ?? '').replace(/\s+/g, ' ').trim();
    v.dataset.fitTip = '1';
  }
  const base = parseFloat(getComputedStyle(sizeOf).fontSize) || 30;
  const sw = v.getBoundingClientRect().width;
  const other = need - sw;
  const min = pill ? 10 : MIN_VALUE_PX;
  const f = Math.max(min, Math.floor((base * Math.max(0, avail - other - 1)) / Math.max(1, sw)));
  sizeOf.style.fontSize = `${f}px`;
  const after = line.getBoundingClientRect().width;
  if (after > avail + 0.5) {
    v.classList.add('cut');
    v.style.maxWidth = `${Math.max(0, v.getBoundingClientRect().width - (after - avail) - 1)}px`;
    return 'cut';
  }
  return f < base * 0.6 ? 'tight' : 'shrunk';
}

const fmtVal = (raw: unknown, dec: number) => (Number.isFinite(Number(raw)) && raw !== '' && raw !== null && typeof raw !== 'boolean' ? fmtNum(raw, dec) : esc(String(raw ?? '—')));

// ---------- drawing ----------

/**
 * Draws the widget body. Returns the colour rule to apply to the card (undefined = leave card as is).
 * One branch per widget type; see the file header for the common steps and how to add a type.
 * Data calls (all through core/api with the user's JWT):
 * - api.latest: WebSocket live cache; REST GET .../values/timeseries?keys=... only until the subscription is ready
 * - api.series: REST once, then extended with live points (AVG/NONE windows ending now); re-fetched every 5 min
 * - aggValue: api.windowAgg, kept current from pushed points while live (D-048; re-read after 1-5 min)
 * - rawSeries and the bar/heatmap queries: REST via api.getCached (60 s while live)
 * - api.alarms: REST GET /api/v2/alarm/DEVICE/{id}?... (15 s cache while live)
 * Multi-device widgets issue one request per device (in parallel, except line/area which go in sequence).
 * Throws on REST errors; renderWidget's refresh() turns them into a placeholder.
 */
async function draw(body: HTMLElement, w: Widget, env: RenderEnv): Promise<ColorRule | null | undefined> {
  const { ctx } = env;
  const s = w.settings;
  const palette = env.dark ? SERIES_DARK : SERIES;
  const rules = effectiveRules(s);

  if (w.type === 'text') return drawText(body, w, env);
  if (w.type === 'image') {
    const u = safeUrl(s.url);
    setStatic(body, u ? `<img class="dbb-img" src="${esc(u)}" alt="${esc(w.title || 'Image')}" style="object-fit:${s.fit ?? 'contain'}" referrerpolicy="no-referrer"/>` : `<div class="dbb-ph">Add an image address (https://…) in the widget settings.</div>`);
    return undefined;
  }
  if (w.type === 'embed') {
    // safeUrl also allows data:image URIs; only https pages may be framed (sandboxed, no referrer).
    const u0 = safeUrl(s.url);
    // D-028: a page from this ThingsBoard server would run with our origin despite the sandbox; not framed.
    const u = u0 && u0.startsWith('https://') && !sameOrigin(u0) ? u0 : null;
    setStatic(body, u
      ? `<iframe class="dbb-frame" src="${esc(u)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerpolicy="no-referrer" loading="lazy" title="${esc(w.title || 'Embedded page')}"></iframe>`
      : `<div class="dbb-ph">Add a page address (https://…) in the widget settings. Some sites refuse to be embedded.</div>`);
    return undefined;
  }
  if (w.type === 'link') return drawLink(body, w, env);

  // ---- data widgets: common checks, device resolution and time window ----
  const cap = WIDGET_CAPS[w.type];
  if (w.type !== 'alarms' && w.keys.length < cap.keys[0]) return void placeholder(body, 'Choose a property in the widget settings.');
  const bound = resolveBinding(env, w.binding);
  if (bound.problem) return void placeholder(body, bound.problem);
  if (!bound.devices.length) return void placeholder(body, bound.hidden ? 'No data in your scope' : 'No machines match this data source.');
  // Single-device types use only the first device; multi-device types stop at MAX_SERIES devices.
  const devices = cap.multiDevice ? bound.devices.slice(0, MAX_SERIES) : bound.devices.slice(0, 1);
  const moreDevices = cap.multiDevice ? Math.max(0, bound.devices.length - MAX_SERIES) : 0;
  // Per-widget range overrides the dashboard's; 'realtime' becomes a rolling 1 h window (rangeWindow).
  // D-061: the viewer's window (the page's picker) overrides both.
  const range = normalizeRange(s.timeRange ?? env.timeRange);
  const view = env.view ?? null;
  const ownRange = !view && s.timeRange != null && range !== normalizeRange(env.timeRange);
  // Property kind vs widget type (plain rules; see core/compat). Older dashboards may still hold a mismatch.
  for (const k of w.keys) {
    const c = compatible(w.type, keyMeta(ctx, bound.devices[0].profile, k), { donutMode: s.donutMode ?? (devices.length > 1 ? 'devices' : 'state') });
    if (!c.ok) return void placeholder(body, `${c.reason} Choose another property or widget type.`);
  }
  const d0 = devices[0];
  // The time window (D-047). Widgets that show latest values need none, so a shift range without a calendar only
  // stops the time-based ones.
  let startTs = Date.now() - 3600e3;
  let endTs = Date.now();
  let ended = false;
  // D-061: the window is resolved for the latest-value types too: a window that has ended shows its end values.
  const shiftRange = view ? isShiftRange(view.range) : isShiftRange(range);
  const cal = shiftRange ? await calendarFor(ctx, env.deviceId ?? d0.id) : null;
  const win = view ? viewWindow(view, cal) : rangeWindow(range, cal);
  if (win) {
    ({ startTs, endTs } = win);
    ended = !!win.shift?.ended || hasEnded(win);
  } else if (!LATEST_ONLY.has(w.type)) {
    const which = view ? view.range : range;
    return void placeholder(body, cal ? (which === 'shift' ? 'No shift now or in the last 14 days.' : 'No shift has ended in the last 14 days.') : "No shifts are set up for this machine's site. An admin sets them in Configuration › Shifts.");
  }
  // D-061: a time-based card with its own stored range (no viewer choice) says so on the card, so the page's
  // "Time window" never claims a period the card does not show.
  windowChip(body, ownRange && !LATEST_ONLY.has(w.type) ? range : null);
  // The current shift so far (or a custom window still running) grows from a fixed start: its series are cached by that
  // start (api.series).
  const fixedStart = (view ? view.range === 'shift' || view.range === 'custom' : isShiftRange(range)) && !ended;
  // Values: the latest (live) ones, or for a window that has ended the last ones before its end (D-061).
  const valuesOf = (id: string, keys: string[]) => (ended ? api.latestAt(id, keys, endTs) : api.latest(id, keys));
  // Data age: "9s ago" while live; the reading's time for an ended window ("16 Oct, 1:58 PM").
  const when = (ts: number) => (ended ? fmt.dateTime(ts, { short: true }) : ago(ts));
  // Sub-line under a value: machine name (unless it is the current machine) and data age.
  const sub = (d: Node, ts: number) => `${w.binding.mode !== 'current' ? esc(d.label) + ' · ' : ''}${esc(when(ts))}`;
  // KPI comparison: what the change is measured against.
  const vsText = view
    ? view.range === 'shift'
      ? ended ? 'vs the start of that shift' : 'vs the shift start'
      : view.range === 'prevshift'
        ? 'vs the start of that shift'
        : view.range === 'custom'
          ? 'vs the window start'
          : `vs ${view.range.replace('h', ' h')} ago`
    : isShiftRange(range)
      ? ended ? 'vs the start of that shift' : 'vs the shift start'
      : `vs ${range === 'realtime' ? '1 h' : range.replace('h', ' h')} ago`;

  // Single-value widgets: one key of one device, latest value (+ a series for the KPI trend).
  if (w.type === 'value' || w.type === 'gauge' || w.type === 'status' || w.type === 'progress' || w.type === 'kpi') {
    const key = w.keys[0];
    const meta = keyMeta(ctx, d0.profile, key);
    const lv = (await valuesOf(d0.id, [key]))[key];
    if (!lv) return void placeholder(body, ended ? `No ${meta.displayName} value before the end of this time window` : `Not available on this device (${d0.label} doesn't report ${meta.displayName})`);
    const v = Number(lv.value);
    const unit = s.unit ?? meta.unit;
    const dec = s.decimals ?? meta.decimals;
    const rule = matchRule(rules, lv.value, key);
    const min = s.min ?? meta.min;
    const max = s.max ?? meta.max;

    if (w.type === 'value') {
      const vt = valueType(meta, lv.value);
      const shown = vt === 'number' ? fmtVal(lv.value, dec) : esc(rule?.label ?? stateLabel(lv.value, rules, meta, key));
      body.innerHTML = `<div class="dbb-value"><div class="vl"><span class="v">${shown}</span>${vt === 'number' ? `<span class="u">${esc(unit)}</span>` : ''}</div>${vt === 'number' ? ruleLabelPill(rule) : ''}<div class="s">${sub(d0, lv.ts)}</div></div>`;
      return rule;
    }
    if (w.type === 'gauge') {
      gauge(body, v, { min, max, unit, decimals: dec, rules, key, sub: sub(d0, lv.ts), label: rule?.label ? `${unit} · ${rule.label}` : unit, valueColor: (s.colorTarget ?? 'background') === 'value' && rule ? rule.color : undefined });
      // The gauge already coloured its value text itself, so the card isn't coloured for 'value'.
      return (s.colorTarget ?? 'background') === 'value' ? null : rule;
    }
    if (w.type === 'progress') {
      const pct = Math.max(0, Math.min(100, ((v - min) / (max - min || 1)) * 100));
      const col = rule?.color ?? 'var(--accent)';
      const vert = s.orientation === 'vertical';
      const ticks = thresholdLines(rules, key)
        .filter((t) => t.value > min && t.value < max)
        .map((t) => {
          const p = ((t.value - min) / (max - min)) * 100;
          return vert ? `<span class="dbb-prog-tick" style="left:0;right:0;bottom:${p}%;height:2px" title="${esc(t.label ?? fmtNum(t.value, dec))}"></span>` : `<span class="dbb-prog-tick" style="top:0;bottom:0;left:${p}%;width:2px" title="${esc(t.label ?? fmtNum(t.value, dec))}"></span>`;
        })
        .join('');
      // The fill bar already shows the rule colour, so a 'background' target doesn't tint the card too.
      const txt = `<div class="dbb-value" style="height:auto"><div class="vl"><span class="v">${fmtVal(lv.value, dec)}</span><span class="u">${esc(unit)}</span></div>${ruleLabelPill(rule)}<div class="s">${fmtNum(pct, 0)}% of ${fmtNum(max, 0)} ${esc(unit)} · ${esc(when(lv.ts))}</div></div>`;
      // D-043: the iMEX value meter (kit .imx-meter): rounded track, a fill fading from the colour to a lighter tone
      const col2 = `color-mix(in srgb, ${col} 62%, #ffffff)`;
      const aria = `role="meter" aria-valuemin="${esc(min)}" aria-valuemax="${esc(max)}" aria-valuenow="${esc(v)}" aria-label="${esc(`${w.title || meta.displayName}: ${fmtNum(pct, 0)}%`)}"`;
      body.innerHTML = vert
        ? `<div class="dbb-prog vert"><div class="dbb-prog-track" ${aria} style="width:${Math.max(28, Math.min(64, body.clientWidth / 4))}px;height:100%;border-radius:10px"><div class="dbb-prog-fill" style="width:100%;height:${pct}%;background:linear-gradient(0deg,${col},${col2});border-radius:8px"></div>${ticks}</div>${txt}</div>`
        : `<div class="dbb-prog">${txt}<div class="imx-meter dbb-meter" ${aria} style="--m:${col};--m2:${col2}"><span class="tr"><i style="--v:${pct.toFixed(1)}%"></i>${ticks}</span></div></div>`;
      return (s.colorTarget ?? 'background') === 'background' ? null : rule;
    }
    if (w.type === 'kpi') {
      const data = s.sparkline === false && s.compare === 'none' ? {} : await api.series(d0.id, [key], startTs, endTs, 'AVG', 120, { fixedStart });
      const pts = (data as any)[key] ?? [];
      // % change of the latest value vs the first averaged point of the window; upIsGood=false swaps the colours.
      let delta = '';
      if (s.compare !== 'none' && pts.length > 1 && Number.isFinite(v)) {
        const first = pts[0].value;
        const ch = first ? ((v - first) / Math.abs(first)) * 100 : 0;
        const dir = Math.abs(ch) < 0.5 ? 'flat' : ch > 0 ? 'up' : 'down';
        const good = s.upIsGood === false ? (dir === 'up' ? 'down' : dir === 'down' ? 'up' : 'flat') : dir;
        delta = `<span class="dbb-delta ${good}" title="Change since the start of the time range">${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'} ${fmtNum(Math.abs(ch), 1)}%</span>`;
      }
      body.innerHTML = `<div class="dbb-kpi"><div class="dbb-value" style="height:auto"><div class="row"><span class="vl"><span class="v">${fmtVal(lv.value, dec)}</span><span class="u">${esc(unit)}</span></span>${delta}</div>${ruleLabelPill(rule)}<div class="s">${sub(d0, lv.ts)} · ${esc(vsText)}</div></div>${s.sparkline !== false ? '<div class="dbb-spark"></div>' : ''}</div>`;
      const sp = body.querySelector('.dbb-spark') as HTMLElement | null;
      // Next frame, so the sparkline host has its laid-out size.
      if (sp) requestAnimationFrame(() => sparkline(sp, pts, rule?.color ?? palette[0]));
      return rule;
    }
    // status: colour rules if the widget has its own; else legacy statusMap; else (D-064) the machine model's map when
    // the key is the type's status tag, or a 1 = Running / 0 = Stopped default. A latest value older than the type's
    // No-data time (the machine model's, default 15 min) shows "No data" regardless.
    const mm = machine.model();
    const mtype = machine.kindOf(d0.profile, d0.label);
    const offline = (ended ? endTs : Date.now()) - lv.ts > machine.offlineMs(mm, mtype);
    const mcfg = machine.typeOf(mm, mtype).status;
    const byModel = !(rules.length && s.colorRules?.length) && !s.statusMap?.length && (mcfg.key ? mcfg.key === key : machine.RUN_KEYS.includes(key)) ? machine.classify(mcfg, lv.value) : null;
    let label: string;
    let color: string;
    if (byModel) {
      label = byModel.label;
      color = machine.TONE_COLOR[byModel.tone] ?? STATUS.neutral;
    } else if (rules.length && s.colorRules?.length) {
      label = rule?.label ?? stateLabel(lv.value, rules, meta, key);
      color = rule?.color ?? STATUS.neutral;
    } else {
      const map = s.statusMap?.length
        ? s.statusMap
        : [
            { value: 1, label: meta.states?.['1'] ?? 'Running', color: STATUS.good },
            { value: 0, label: meta.states?.['0'] ?? 'Stopped', color: STATUS.neutral },
          ];
      const hit = map.find((m) => String(m.value) === String(lv.value) || Number(m.value) === v);
      label = hit?.label ?? String(lv.value);
      color = cssColor(hit?.color ?? STATUS.neutral);
    }
    if (offline) {
      label = 'No data';
      color = machine.TONE_COLOR.warn;
    }
    body.innerHTML = `<div class="dbb-value"><div class="dbb-pill" style="--pill:${color}"><span class="dbb-dot"></span><span class="pt">${esc(label)}</span></div><div class="s" style="margin-top:8px">${sub(d0, lv.ts)}</div></div>`;
    // The card is coloured only if a colorTarget was chosen explicitly; a synthetic rule carries the pill colour.
    return s.colorTarget && s.colorTarget !== 'value' ? ({ op: 'eq', value: '', color } as ColorRule) : null;
  }

  if (w.type === 'multivalue') {
    const lv = await valuesOf(d0.id, w.keys);
    body.innerHTML = `<div class="dbb-mv">${w.keys
      .map((k) => {
        const meta = keyMeta(ctx, d0.profile, k);
        const x = lv[k];
        const r = x ? matchRule(rules, x.value, k) : null;
        const vt = valueType(meta, x?.value);
        const val = !x ? '<span class="u" title="Not available on this device">—</span>' : vt === 'number' ? `${fmtVal(x.value, s.decimals ?? meta.decimals)}<span class="u">${esc(meta.unit)}</span>` : esc(r?.label ?? stateLabel(x.value, rules, meta, k));
        const colorText = r && s.colorTarget === 'value';
        return `<div class="dbb-mv-row"><span class="dbb-dot" style="background:${r?.color ?? 'var(--grid)'}"></span><span class="k" title="${esc(meta.displayName)}">${esc(meta.displayName)}</span><span class="v" ${colorText ? `style="color:${r!.color}"` : ''}>${val}</span>${r?.label && vt === 'number' ? `<span class="dbb-muted" style="font-size:11px;color:${r.color};font-weight:600">${esc(r.label)}</span>` : ''}</div>`;
      })
      .join('')}</div>`;
    return undefined;
  }

  if (w.type === 'summary') {
    const key = w.keys[0];
    const meta = keyMeta(ctx, d0.profile, key);
    const dec = s.decimals ?? meta.decimals;
    const unit = s.unit ?? meta.unit;
    const [mn, av, mx, lv] = await Promise.all([
      aggValue(d0.id, key, startTs, endTs, 'MIN', fixedStart),
      aggValue(d0.id, key, startTs, endTs, 'AVG', fixedStart),
      aggValue(d0.id, key, startTs, endTs, 'MAX', fixedStart),
      valuesOf(d0.id, [key]).then((l) => l[key]),
    ]);
    const cell = (k: string, v: number | string | null | undefined) => {
      const r = v == null ? null : matchRule(rules, v, key);
      return `<div><span class="k">${k}</span><span class="v" ${r ? `style="color:${r.color}"` : ''} title="${r?.label ? esc(r.label) : ''}">${v == null ? '—' : fmtVal(v, dec)}<span class="dbb-muted" style="font-weight:400"> ${esc(unit)}</span></span></div>`;
    };
    body.innerHTML = `<div class="dbb-sum">${cell('Min', mn)}${cell('Avg', av)}${cell('Max', mx)}${cell(ended ? 'At end' : 'Now', lv?.value ?? null)}</div>`;
    return undefined;
  }

  // One line per device x key, capped at MAX_SERIES; api.series picks the bucket size (~500 points).
  if (w.type === 'line' || w.type === 'area') {
    const agg = s.agg ?? 'AVG';
    const series: Parameters<typeof lineChart>[1] = [];
    let slot = 0;
    for (const d of devices) {
      const data = await api.series(d.id, w.keys, startTs, endTs, agg, 500, { fixedStart });
      for (const k of w.keys) {
        if (series.length >= MAX_SERIES) break;
        const meta = keyMeta(ctx, d.profile, k);
        series.push({
          name: devices.length > 1 ? `${d.label} · ${meta.displayName}` : meta.displayName,
          color: palette[slot++ % palette.length],
          unit: s.unit ?? meta.unit,
          decimals: s.decimals ?? meta.decimals,
          points: data[k] ?? [],
        });
      }
    }
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    // With several keys, threshold lines are drawn only if no rule is scoped to a single key (the axis is shared).
    const thr = s.showThresholds === false ? [] : thresholdLines(rules, w.keys.length === 1 ? w.keys[0] : undefined).filter((t) => w.keys.length === 1 || !rules.some((r) => r.key));
    lineChart(body, series, { startTs, endTs, showLegend: s.showLegend, area: w.type === 'area', stacked: w.type === 'area' && !!s.stacked, smooth: s.smooth, thresholds: thr });
    if (bound.hidden) body.insertAdjacentHTML('beforeend', `<div class="dbb-ph" style="height:auto">${bound.hidden} machine(s) not shown: no data in your scope</div>`);
    // Lines cut by the MAX_SERIES cap: from drawn devices and from devices beyond the cap.
    const dropped = devices.length * w.keys.length - series.length + moreDevices * w.keys.length;
    if (dropped > 0) body.insertAdjacentHTML('beforeend', `<div class="dbb-ph" style="height:auto">Showing the first ${MAX_SERIES} lines; ${dropped} more not drawn.</div>`);
    return undefined;
  }

  if (w.type === 'bar') {
    const key = w.keys[0];
    const agg = s.agg && s.agg !== 'NONE' ? s.agg : 'AVG';
    // Grouping: stored 'day' draws per hour (D-020); default is by machine for several devices,
    // else per 15 min up to 2 h and per hour beyond.
    const group = s.groupBy === 'day' ? 'hour' : s.groupBy ?? (devices.length > 1 ? 'device' : endTs - startTs <= 2 * 3600e3 ? '15m' : 'hour');
    const meta = keyMeta(ctx, d0.profile, key);
    const dec = s.decimals ?? meta.decimals;
    // Bar colour: matching rule colour, else the series colour.
    const col = (v: number | null, fallback: string) => (v != null && matchRule(rules, v, key)?.color) || fallback;
    const thr = s.showThresholds === false ? [] : thresholdLines(rules, key);
    if (group === 'device') {
      const bars = await Promise.all(
        devices.map(async (d, i) => {
          const v = await aggValue(d.id, key, startTs, endTs, agg, fixedStart);
          return { label: d.label, value: v, color: col(v, palette[i % palette.length]), detail: `${d.label} · ${agg.toLowerCase()} ${meta.displayName}` };
        }),
      );
      barChart(body, bars, { unit: s.unit ?? meta.unit, decimals: dec, thresholds: thr });
    } else {
      // D-061: a viewer's window over 2 days gets one bar per day instead of up to 168 hourly bars
      const step = group === '15m' ? 15 * 60e3 : endTs - startTs > 48 * 3600e3 ? 86400e3 : 3600e3;
      const r = await api.getCached<any>(
        `bar|${d0.id}|${key}|${agg}|${step}|${winKey(startTs, endTs)}`,
        `/api/plugins/telemetry/DEVICE/${d0.id}/values/timeseries?keys=${encodeURIComponent(key)}&startTs=${startTs}&endTs=${endTs}&agg=${agg}&interval=${step}&limit=1000&orderBy=ASC`,
        60e3,
      );
      const pts: { ts: number; value: string }[] = r?.[key] ?? [];
      const bars = pts.map((p) => {
        // D-061 (M2): the app's date-time format
        const label = step >= 86400e3 ? fmt.date(p.ts, { short: true }) : fmt.time(p.ts);
        return { label, value: Number(p.value), color: col(Number(p.value), palette[0]), detail: `${d0.label} · ${fmt.dateTime(p.ts, { short: true })}` };
      });
      barChart(body, bars, { unit: s.unit ?? meta.unit, decimals: dec, thresholds: thr });
    }
    return undefined;
  }

  if (w.type === 'donut') {
    const key = w.keys[0];
    const meta = keyMeta(ctx, d0.profile, key);
    const mode = s.donutMode ?? (devices.length > 1 ? 'devices' : 'state');
    // 'devices' = share of an aggregate by machine; 'state' = hours spent in each state of one machine.
    if (mode === 'devices') {
      const agg = s.agg && s.agg !== 'NONE' ? s.agg : 'AVG';
      const vals = await Promise.all(devices.map((d) => aggValue(d.id, key, startTs, endTs, agg, fixedStart)));
      const slices: Slice[] = devices.map((d, i) => ({ label: d.label, value: Math.max(0, vals[i] ?? 0), color: palette[i % palette.length], detail: `${d.label} · ${agg.toLowerCase()} ${meta.displayName}` }));
      donut(body, slices, { unit: s.unit ?? meta.unit, decimals: s.decimals ?? meta.decimals });
    } else {
      const pts = await rawSeries(d0.id, key, startTs, endTs);
      const segs = toSegments(pts, endTs);
      const by = new Map<string, number>();
      for (const g of segs) by.set(g.value, (by.get(g.value) ?? 0) + (g.end - g.start));
      const order: string[] = [];
      const slices: Slice[] = [...by.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([val, ms]) => ({ label: stateLabel(val, rules, meta, key), value: ms / 3600e3, color: stateColor(val, rules, key, order, palette), detail: `${stateLabel(val, rules, meta, key)} · ${fmtNum(ms / 3600e3, 1)} h` }));
      // merge slices that share a label (e.g. two raw values mapped to one rule)
      const merged = new Map<string, Slice>();
      for (const x of slices) {
        const m = merged.get(x.label);
        if (m) m.value += x.value;
        else merged.set(x.label, { ...x });
      }
      donut(body, [...merged.values()], { unit: 'h', decimals: 1 });
    }
    return undefined;
  }

  if (w.type === 'timeline') {
    const key = w.keys[0];
    const order: string[] = [];
    const legend = new Map<string, string>();
    const rows: TimelineRow[] = [];
    for (const d of devices) {
      const meta = keyMeta(ctx, d.profile, key);
      const pts = await rawSeries(d.id, key, startTs, endTs);
      rows.push({
        label: d.label,
        segments: toSegments(pts, endTs).map((g) => {
          const color = stateColor(g.value, rules, key, order, palette);
          const label = stateLabel(g.value, rules, meta, key);
          legend.set(label, color);
          return { start: g.start, end: g.end, color, label };
        }),
      });
    }
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    stateTimeline(body, devices.length > 1 ? rows : rows.map((r) => ({ ...r, label: '' })), { startTs, endTs, legend: [...legend.entries()].map(([label, color]) => ({ label, color })) });
    return undefined;
  }

  if (w.type === 'heatmap') {
    // Machines as rows, time buckets as columns (5-20 min buckets; ranges stop at 8 h).
    const key = w.keys[0];
    const meta = keyMeta(ctx, d0.profile, key);
    const span = endTs - startTs;
    // About 24 columns, bucket rounded up to whole 5 min (5 min for 1-2 h, 20 min for 8 h); aligned to the bucket grid.
    const bucketMs = Math.max(5 * 60e3, Math.ceil(span / 24 / (5 * 60e3)) * 5 * 60e3);
    const first = Math.floor(startTs / bucketMs) * bucketMs;
    const cols: number[] = [];
    for (let t = first; t < endTs; t += bucketMs) cols.push(t);
    const agg = s.agg && s.agg !== 'NONE' ? s.agg : 'AVG';
    const rows: HeatRow[] = await Promise.all(
      devices.map(async (d) => {
        const r = await api.getCached<any>(
          `heat|${d.id}|${key}|${agg}|${bucketMs}|${first}`,
          `/api/plugins/telemetry/DEVICE/${d.id}/values/timeseries?keys=${encodeURIComponent(key)}&startTs=${first}&endTs=${endTs}&agg=${agg}&interval=${bucketMs}&limit=500&orderBy=ASC`,
          60e3,
        );
        const cells: (number | null)[] = cols.map(() => null);
        for (const p of r?.[key] ?? []) {
          const i = Math.floor((p.ts - first) / bucketMs);
          if (i >= 0 && i < cells.length) cells[i] = Number(p.value);
        }
        return { label: devices.length > 1 ? d.label : '', cells };
      }),
    );
    // Cells take the rule colour when heatColor = 'rules', else a position on the blue/orange ramp between min and max.
    // D-056: on a dark surface the ramp runs from dark (low) to light (high), so high values stand out; its darkest
    // step (close to the card colour) is left out
    const ramp0 = s.heatColor === 'orange' ? RAMP_ORANGE : RAMP_BLUE;
    const ramp = env.dark ? [...ramp0].reverse().slice(1) : ramp0;
    const useRules = s.heatColor === 'rules' && rules.length;
    heatmap(body, rows, cols, {
      bucketMs,
      unit: s.unit ?? meta.unit,
      decimals: s.decimals ?? meta.decimals,
      legend: useRules ? undefined : ramp,
      colorOf: (v, lo, hi) => (useRules ? matchRule(rules, v, key)?.color ?? 'var(--grid)' : ramp[Math.min(ramp.length - 1, Math.floor(((v - lo) / (hi - lo || 1)) * ramp.length))]),
    });
    return undefined;
  }

  if (w.type === 'table') {
    const rows = await Promise.all(devices.map(async (d) => ({ d, v: await valuesOf(d.id, w.keys) })));
    // Column headers use the first device's profile; rows are machines, cells are latest values.
    const metas = w.keys.map((k) => keyMeta(ctx, devices[0].profile, k));
    // D-044 (user rule, 9 Oct 2026): every header and value centred (supersedes D-033's centred numbers and
    // right-aligned text), in the CSS of .dbb-table (theme.ts).
    body.innerHTML =
      `<div class="dbb-scroll"><table class="dbb-table"><thead><tr><th>Machine</th>${metas
        .map((m) => `<th>${esc(m.displayName)}${m.unit ? ` (${esc(m.unit)})` : ''}</th>`)
        .join('')}</tr></thead><tbody>` +
      rows
        .map(
          ({ d, v }) =>
            `<tr><td>${esc(d.label)}</td>${w.keys
              .map((k, i) => {
                const x = v[k];
                if (!x) return `<td><span title="Not available on this device">—</span></td>`;
                const r = matchRule(rules, x.value, k);
                const vt = valueType(metas[i], x.value);
                const txt = vt === 'number' ? fmtVal(x.value, s.decimals ?? metas[i].decimals) : esc(stateLabel(x.value, rules, metas[i], k));
                return `<td>${r ? `<span class="cell" style="background:color-mix(in srgb, ${r.color} 18%, transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb, ${r.color} 45%, transparent)" title="${esc(r.label ?? '')}">${txt}</span>` : txt}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('') +
      `</tbody></table>${bound.hidden ? `<div class="dbb-ph" style="height:auto">${bound.hidden} machine(s) outside your scope not shown</div>` : ''}</div>`;
    return undefined;
  }

  if (w.type === 'alarms') {
    // D-073: without the Alarms module the card stays empty (the renderer does not even place it; the Builder's canvas
    // keeps it so a save does not lose it): nothing is read, no error
    if (!widgetLicensed('alarms')) return void (body.innerHTML = '');
    // Alarms raised since the window start, per device, merged newest first and cut to maxRows.
    const lists = await Promise.all(devices.map((d) => api.alarms({ id: d.id, entityType: 'DEVICE' }, { status: s.alarmStatus ?? 'ANY', severities: s.severities, limit: s.maxRows ?? 20, startTs, endTs: ended ? endTs : undefined })));
    const all = lists
      .flat()
      .sort((a, b) => b.startTs - a.startTs)
      .slice(0, s.maxRows ?? 20);
    if (!all.length) return void (body.innerHTML = `<div class="dbb-ph"><span style="display:inline-flex;align-items:center;gap:6px;color:${STATUS.good}"><span style="width:18px;height:18px;display:inline-flex">${ICON_SVG.check}</span></span>&nbsp;No alarms in this time range</div>`);
    body.innerHTML =
      `<div class="dbb-scroll"><table class="dbb-table"><thead><tr><th>Time</th><th>Machine</th><th>Alarm</th><th>Severity</th><th>Status</th></tr></thead><tbody>` +
      all
        .map(
          (a) =>
            `<tr><td>${esc(fmt.dateTime(a.startTs, { short: true }))}</td><td>${esc(
              ctx.nodes.get(a.originatorId)?.label ?? a.originatorLabel ?? a.originatorName,
            )}</td><td>${esc(a.type)}</td><td><span class="dbb-sev"><span class="dbb-dot" style="background:${SEVERITY_COLOR[a.severity] ?? STATUS.neutral}"></span>${esc(a.severity)}</span></td><td>${a.cleared ? 'Cleared' : 'Active'}${a.acknowledged ? ' · ack' : ''}</td></tr>`,
        )
        .join('') +
      `</tbody></table></div>`;
    return undefined;
  }
  return undefined;
}

/**
 * D-053: machines and locations a dashboard shows to THIS viewer: the union of every widget's resolveBinding devices
 * (the user context built from the access core, so only equipment in the viewer's access) and their distinct
 * locations in that context. Feeds {{machines}} and {{locations}}, so a banner never counts equipment the viewer
 * cannot see.
 */
export function fleetCounts(env: RenderEnv, widgets: Widget[]): { machines: number; locations: number } {
  const machines = new Set<string>();
  const sites = new Set<string>();
  for (const w of widgets)
    for (const n of resolveBinding(env, w.binding).devices) {
      machines.add(n.id);
      if (n.parentId && env.ctx.nodes.has(n.parentId)) sites.add(n.parentId);
    }
  return { machines: machines.size, locations: sites.size };
}

const DOT = '(?:·|&middot;|&#183;)';
const BAKED_FLEET = new RegExp(`\\b\\d+ machines?( ${DOT} \\d+ locations?)?( ${DOT} live ${DOT} \\{\\{\\s*date\\s*\\}\\})`, 'g');

/**
 * D-053: a fleet banner made before 10 Oct 2026 has its author's counts baked in ("5 machines · 2 locations · live ·
 * {{date}} {{time}}", core/design.ts). Turns that line into the live placeholders, so stored dashboards count the
 * viewer's equipment without a data migration. Any other text is left as it is.
 */
export function liveFleetLine(html: string): string {
  return html.replace(BAKED_FLEET, (_m, loc: string | undefined, tail: string) => `{{machines}}${loc ? ' · {{locations}}' : ''}${tail}`);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Rich text widget. settings.html is sanitised (render/rich.ts); older widgets use settings.markdown.
 * `{{key}}` placeholders are filled with the current machine's latest values (one api.latest call,
 * errors ignored) plus {{machine}}, {{type}}, {{location}}, {{time}} and {{date}}.
 * Without a current machine only time and date are filled. D-053: {{machines}} and {{locations}} count the
 * dashboard's equipment in the viewer's access (fleetCounts; env.widgets from the Grid, an em dash without it).
 */
async function drawText(body: HTMLElement, w: Widget, env: RenderEnv): Promise<undefined> {
  const s = w.settings;
  let html = s.html !== undefined ? sanitizeHtml(s.html) : miniMarkdown(s.markdown ?? w.title ?? '');
  if (/\{\{/.test(html)) {
    const values: Record<string, string> = {};
    if (env.widgets) {
      html = liveFleetLine(html);
      const f = fleetCounts(env, env.widgets);
      values.machines = plural(f.machines, 'machine');
      values.locations = plural(f.locations, 'location');
    }
    const dev = env.deviceId ? env.ctx.nodes.get(env.deviceId) : null;
    values.time = fmt.time(Date.now());
    values.date = fmt.date(Date.now());
    if (dev) {
      values.machine = dev.label;
      values.type = dev.profile;
      values.location = dev.parentId ? env.ctx.nodes.get(dev.parentId)?.label ?? '' : '';
      const keys = placeholderKeys(html);
      if (keys.length) {
        const lv = await api.latest(dev.id, keys).catch(() => ({}) as api.Latest);
        for (const k of keys) {
          const x = lv[k];
          if (!x) continue;
          const meta = keyMeta(env.ctx, dev.profile, k);
          values[k] = valueType(meta, x.value) === 'number' ? `${fmtNum(x.value, meta.decimals)}${meta.unit ? ' ' + meta.unit : ''}` : stateLabel(x.value, undefined, meta, k);
        }
      }
    }
    html = fillPlaceholders(html, values);
  }
  body.innerHTML = `<div class="dbb-md">${html}</div>`;
  if (env.appDark) darkInlineColors(body);
  return undefined;
}

/** D-056: a card style with its colours made fit for the app's dark mode (darkColor; a dropped colour is removed). */
export function darkCardStyle(st: CardStyle): CardStyle {
  const o: CardStyle = { ...st };
  let tinted = false;
  if (o.bg) {
    const b = darkColor(o.bg, 'bg');
    if (b === null) delete o.bg;
    else if (b !== o.bg) {
      o.bg = b;
      tinted = true;
    }
  }
  // text on a kept coloured tile keeps its colour (it was chosen for that tile)
  const onTile = !!o.bg && !tinted && o.bg !== 'transparent';
  for (const k of ['titleColor', 'valueColor', 'iconColor'] as const) {
    if (!o[k] || onTile) continue;
    const c = darkColor(o[k], 'text');
    if (c === null) delete o[k];
    else o[k] = c;
  }
  if (o.borderColor) {
    const c = darkColor(o.borderColor, 'border');
    if (c === null) delete o.borderColor;
  }
  return o;
}

/** D-056: inline colours of rich text (typed on a light dashboard) made readable on the app's dark cards. */
function darkInlineColors(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[style]').forEach((e) => {
    const c = e.style.color;
    if (c) {
      const d = darkColor(c, 'text');
      if (d === null) e.style.removeProperty('color');
      else if (d !== c) e.style.color = d;
    }
    const b = e.style.backgroundColor;
    if (b) {
      const d = darkColor(b, 'bg');
      if (d === null) e.style.removeProperty('background-color');
      else if (d !== b) e.style.backgroundColor = d;
    }
  });
}

/**
 * Link / button widget. linkKind 'url' opens an https address in a new tab (safeUrl); 'state' opens
 * another page of the app through env.navigate (Map / Listing / Machine), for the current machine,
 * its location or a fixed node. Inert while editing (env.editing) or when no navigate is given.
 */
function drawLink(body: HTMLElement, w: Widget, env: RenderEnv): undefined {
  const s = w.settings;
  const st = s.style;
  const kind = s.linkKind ?? 'state';
  const color = s.buttonColor ?? 'var(--accent)';
  const ic = icon(st?.icon ?? (kind === 'url' ? 'link' : 'list'));
  const label = esc(w.title || 'Open');
  const cls = `dbb-go ${s.buttonStyle ?? 'filled'}`;
  const url = kind === 'url' ? safeUrl(s.url) : null;
  const inner = `${ic ? `<span class="ic" style="display:inline-flex">${ic}</span>` : ''}<span>${label}</span>`;
  if (kind === 'url')
    body.innerHTML = `<div class="dbb-linkw">${url && !env.editing ? `<a class="${cls}" style="--go:${color}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<span class="${cls}" style="--go:${color}" aria-disabled="true" title="${url ? 'Links are disabled while editing' : 'Set an https:// address'}">${inner}</span>`}</div>`;
  else {
    body.innerHTML = `<div class="dbb-linkw"><button class="${cls}" style="--go:${color}" ${env.editing || !env.navigate ? 'aria-disabled="true"' : ''} title="${env.editing ? 'Buttons are disabled while editing' : ''}">${inner}</button></div>`;
    const btn = body.querySelector('button')!;
    btn.onclick = (e) => {
      e.stopPropagation();
      if (env.editing || !env.navigate) return;
      const target = s.linkDevice === 'current' ? env.deviceId : s.linkDevice === 'location' ? (env.deviceId ? env.ctx.nodes.get(env.deviceId)?.parentId ?? null : null) : s.linkDevice || null;
      env.navigate(s.linkState || 'default', target);
    };
  }
  return undefined;
}

/**
 * Default layout when no dashboard is assigned: value cards for the main properties, a trend of up to two numeric ones, active alarms. Stays within MAX_WIDGETS.
 * Built from `ctx.profileKeys[profile]`: the catalogue in dbb_profile_keys first, then the keys the machines send once
 * scope.liveKeys has run for the type (the renderer awaits it; no keys at all = alarms only). Pure: no REST calls.
 * @param ctx User context (for the key catalogue).
 * @param profile Machine type (device profile name).
 * @returns Widgets bound to 'current', laid out 4 cards per row on the 12-column grid.
 */
export function defaultWidgets(ctx: UserContext, profile: string): Widget[] {
  const metas = ctx.profileKeys[profile] ?? [];
  const cur = { mode: 'current' as const };
  const ws: Widget[] = [];
  // Skip counters like runHours: a steadily rising total makes a poor trend.
  const trend = metas.filter((m) => compatible('line', m).ok && !/hours/i.test(m.key)).slice(0, 2);
  const cards = metas.slice(0, MAX_WIDGETS - trend.length - 1);
  cards.forEach((m, i) => {
    const isStatus = compatible('status', m).ok;
    ws.push({ id: `def-${m.key}`, type: isStatus ? 'status' : 'value', title: m.displayName, x: (i % 4) * 3, y: Math.floor(i / 4) * 2, w: 3, h: 2, binding: cur, keys: [m.key], settings: {} });
  });
  const rows = Math.ceil(cards.length / 4) * 2;
  // one chart per main key (different units never share an axis)
  trend.forEach((m, i) =>
    ws.push({ id: `def-trend-${m.key}`, type: 'line', title: `${m.displayName} trend`, x: trend.length === 1 ? 0 : i * 6, y: rows, w: trend.length === 1 ? 12 : 6, h: 4, binding: cur, keys: [m.key], settings: {} }),
  );
  const ay = rows + (trend.length ? 4 : 0);
  if (!widgetLicensed('alarms')) return ws; // D-073: no alarm list without the Alarms module
  ws.push({ id: 'def-alarms', type: 'alarms', title: 'Active alarms', x: 0, y: ay, w: 12, h: 3, binding: cur, keys: [], settings: { alarmStatus: 'ACTIVE', maxRows: 10 } });
  return ws;
}
