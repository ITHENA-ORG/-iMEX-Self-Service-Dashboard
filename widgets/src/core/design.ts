// core/design.ts — design pass for dashboards built by chat (DECISIONS D-026).
//
// Why: models compose reasonable widgets but lay them out poorly (tables four rows tall for one machine,
// a one-row text header that cuts its heading off, half the page empty) and leave everything grey.
// This module makes the result look designed, deterministically, after the model's ops were applied:
//
//   sizeWidget(ctx, w)   every widget chat adds: tables as tall as their rows, text at least 2 rows.
//   designPass(ctx, d)   only for FRESH dashboards (new, replaced, or built on an empty draft):
//     1. theme       'ocean' (tinted page, blue accent) when the model set none
//     2. banner      the first short text widget (or a new one on fleet dashboards) becomes a gradient banner: name, machine and
//                    location count, live time
//     3. status row  a fleet dashboard without any small cards gets one status card per shown machine
//                    (on/off property, Running/Stopped colours) when there is room (<= 8 machines, 10-widget cap)
//     4. colours     per machine type: accent bar + icon colour; icons from the type or the property unit;
//                    Running/Stopped colours on run-state columns and status cards; KPI sparklines on
//     5. layout      rows without gaps: banner, cards (evenly split), charts, tables two per row (an odd
//                    table shares its row with the alarm list), alarm list, the rest
//   Nothing the model set explicitly (a theme, a card style, colour rules) is overwritten. If the polished
//   dashboard would fail checkDashboard, the unpolished one is kept.
import type { UserContext, Node } from './scope';
import * as machine from './machine';
import * as scope from './scope';
import { Dashboard, Widget, ColorRule, MAX_WIDGETS, checkDashboard, newId } from './schema';
import { metaLookup, propKind } from './compat';
import { sanitizeHtml } from '../render/rich';

/** Colours per machine type (in order of first appearance); status colours are not reused here. */
export const TYPE_COLORS = ['#2a78d6', '#7c4dff', '#0f9d8f', '#e8590c', '#c2185b', '#3f51b5', '#00838f', '#8d6e00'];
/** Running / Stopped colours for on/off run-state properties. */
export const RUN_RULES: ColorRule[] = [
  { op: 'isTrue', color: '#0ca30c', label: 'Running' },
  { op: 'isFalse', color: '#8a8983', label: 'Stopped' },
];
const CARD = new Set(['value', 'kpi', 'gauge', 'progress', 'status', 'summary', 'multivalue']);
const CHART = new Set(['line', 'area', 'timeline', 'heatmap', 'bar', 'donut']);
/** One grid row is 64 px + 10 px gap (render/grid.ts ROW_H + GAP). */
const UNIT = 74;

/** Devices a widget shows, resolved without a current machine (relative bindings give []). */
export function devicesOf(ctx: UserContext, w: Widget): Node[] {
  const b = w.binding;
  if (b.mode === 'fixed') return b.deviceIds.map((id) => ctx.nodes.get(id)).filter((n): n is Node => !!n);
  if (b.mode === 'nodeQuery') return scope.devicesUnder(ctx, b.nodeId, b.profile || undefined);
  return [];
}

/** Machine type a widget is about (single-type bindings), or null. */
function typeOf(ctx: UserContext, w: Widget, draft: Dashboard): string | null {
  const b = w.binding;
  if (b.mode === 'current') return draft.profile;
  if ((b.mode === 'nodeQuery' || b.mode === 'siblings' || b.mode === 'nearest') && b.profile) return b.profile;
  if (b.mode === 'fixed') {
    const ps = [...new Set(devicesOf(ctx, w).map((n) => n.profile))];
    return ps.length === 1 ? ps[0] : null;
  }
  return null;
}

/** The on/off run-state property of a machine type, if its catalogue has one. */
export function runKey(ctx: UserContext, profile: string): string | null {
  const ks = ctx.profileKeys[profile] ?? [];
  const byName = ks.find((k) => /run.?status|running|on.?off|machine.?state/i.test(`${k.key} ${k.displayName}`));
  if (byName) return byName.key;
  return ks.find((k) => propKind(k) === 'boolean')?.key ?? null;
}

/**
 * D-064: icon for a machine type: the one chosen for the type on the app's Settings > Sites & machines (the machine
 * model), else the neutral factory icon. Nothing is guessed from the type's name.
 */
const MODEL_ICON: Record<string, string> = { machine: 'factory', gauge: 'gauge', drop: 'droplet', wind: 'wind', cloud: 'wind', bolt: 'bolt', box: 'factory', cog: 'wrench' };
export function typeIcon(profile: string): Widget['settings']['style'] extends infer S ? (S extends { icon?: infer I } ? I : never) : never {
  return (MODEL_ICON[machine.look(machine.model(), profile).icon] ?? 'factory') as any;
}

/** Icon for a property from its unit or name. */
function keyIcon(ctx: UserContext, profile: string | null, key: string | undefined): any {
  if (!profile || !key) return 'chart';
  const m = ctx.profileKeys[profile]?.find((k) => k.key === key);
  const u = `${m?.unit ?? ''}`.toLowerCase();
  const n = `${key} ${m?.displayName ?? ''}`.toLowerCase();
  if (/°|deg|temp/.test(u + n)) return 'thermometer';
  if (/psi|bar|kpa|pa\b|press/.test(u + n)) return 'gauge';
  if (/\bkw|kwh|\bw\b|\ba\b|amp|volt|power|current/.test(u + ' ' + n)) return 'bolt';
  if (/m3|l\/min|flow/.test(u + n)) return 'wind';
  if (/hrs|hour|service|time/.test(u + n)) return 'clock';
  if (/rpm|speed/.test(u + n)) return 'speed';
  if (/%|level/.test(u + n)) return 'battery';
  if (/run|status|state/.test(n)) return 'power';
  return 'chart';
}

/** Rows needed for `px` pixels of card content (title bar ~40 px + content), at least `min`. */
const rowsFor = (px: number, min: number) => Math.max(min, Math.ceil((px + 40 + 10) / UNIT));

/**
 * Content-aware size for a widget chat adds (D-026, extended D-029), so nothing is cut off by default:
 * tables as tall as their rows, multi-value cards one line per property, charts tall enough for their
 * legend, timelines and heatmaps one lane per machine, text by its length. Lists are sized exactly, other types only grow; never above 10 rows.
 * The builder then measures the drawn cards and grows any that still overflow (Builder.fitToContent).
 * Mutates `w`.
 */
export function sizeWidget(ctx: UserContext, w: Widget) {
  const devs = devicesOf(ctx, w).length || (w.binding.mode === 'siblings' ? scope.allDevices(ctx, w.binding.profile).length : 1) || 1;
  const keys = Math.max(1, w.keys.length);
  let h = w.h;
  switch (w.type) {
    case 'table':
      h = rowsFor(34 + Math.min(devs, 12) * 36, 2);
      break;
    case 'multivalue':
      h = rowsFor(keys * 32, 2);
      break;
    case 'line':
    case 'area': {
      const series = Math.min(8, devs * keys);
      // legend wraps at about 3 entries per row on a half-width card, 5 on a full-width one
      const legendRows = Math.ceil(series / (w.w >= 12 ? 5 : 3));
      h = rowsFor(200 + legendRows * 18, 3);
      break;
    }
    case 'timeline':
    case 'heatmap':
      h = rowsFor(Math.min(devs, 10) * 40 + 50, 3);
      break;
    case 'bar':
    case 'donut':
      h = Math.max(h, 3);
      break;
    case 'alarms':
      h = Math.max(h, 4);
      break;
    case 'gauge':
      h = Math.max(h, 3);
      break;
    case 'text': {
      const len = textOf(w.settings.html ?? '').length;
      const lines = Math.ceil(len / Math.max(20, w.w * 9)) + ((w.settings.html ?? '').match(/<(h[1-3]|p|li|div)\b/g)?.length ?? 1);
      h = rowsFor(lines * 22, 2);
      break;
    }
  }
  // rows of a list are known exactly: those fit their content (also smaller than the default); others only grow
  const exact = ['table', 'multivalue', 'timeline', 'heatmap'].includes(w.type);
  w.h = Math.min(10, exact ? h : Math.max(w.h, h));
}

/** Plain text of a small HTML fragment. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Makes a fresh chat-built dashboard look designed (see the file header). Pure: returns a new dashboard,
 * or `d` itself when the polished version would not pass checkDashboard.
 */
export function designPass(ctx: UserContext, d0: Dashboard): Dashboard {
  const d: Dashboard = JSON.parse(JSON.stringify(d0));
  if (!d.widgets.length) return d0;
  const machines = new Map<string, Node>();
  for (const w of d.widgets) for (const n of devicesOf(ctx, w)) machines.set(n.id, n);
  if (d.profile && !machines.size) for (const n of scope.allDevices(ctx, d.profile)) machines.set(n.id, n);
  const types = [...new Set([...machines.values()].map((n) => n.profile))];
  const color = (t: string | null) => (t ? TYPE_COLORS[Math.max(0, types.indexOf(t)) % TYPE_COLORS.length] : '#2a78d6');
  const sites = new Set([...machines.values()].map((n) => n.parentId).filter(Boolean));

  // 1. theme
  if (!d.theme) d.theme = { preset: 'ocean', radius: 14, shadow: 'soft' };

  // 2. banner (a new one only on fleet dashboards; a machine dashboard's own short header is styled too)
  const fleet = types.length > 1 || d.widgets.some((w) => w.binding.mode === 'nodeQuery' || (w.binding.mode === 'fixed' && w.binding.deviceIds.length > 1));
  let banner = d.widgets.find((w) => w.type === 'text');
  if (!banner && fleet && d.widgets.length < MAX_WIDGETS) {
    banner = { id: newId(), type: 'text', title: '', x: 0, y: 0, w: 12, h: 2, binding: { mode: 'none' }, keys: [], settings: {} };
    d.widgets.unshift(banner);
  }
  if (banner && textOf(banner.settings.html ?? '').length <= 80 && !banner.settings.style) {
    const heading = textOf(banner.settings.html ?? '') || banner.title || d.name;
    // D-053: the fleet counts are placeholders, filled per viewer at render time (only equipment in their access)
    const sub = d.kind === 'device' ? '{{machine}} · {{location}} · live · {{date}} {{time}}' : `{{machines}}${sites.size ? ' · {{locations}}' : ''} · live · {{date}} {{time}}`;
    banner.settings.html = sanitizeHtml(`<h2 style="color:#ffffff;font-size:26px">${heading.replace(/[<>&]/g, '')}</h2><p style="color:#cfe0ff;font-size:13px">${sub}</p>`);
    banner.settings.style = { bg: '#0b3a7e', gradient: true, border: 'none', hideTitle: true, shadow: 'strong', valign: 'middle', padding: 'roomy' };
    banner.title = banner.title || heading.slice(0, 120);
  }

  // 3. status row for fleet dashboards without small cards
  const cards = d.widgets.filter((w) => CARD.has(w.type)).length;
  const withRun = [...machines.values()].filter((n) => runKey(ctx, n.profile));
  if (fleet && !cards && withRun.length && withRun.length <= 8 && d.widgets.length + withRun.length <= MAX_WIDGETS)
    for (const n of withRun)
      d.widgets.push({ id: newId(), type: 'status', title: n.label, x: 0, y: 0, w: 3, h: 2, binding: { mode: 'fixed', deviceIds: [n.id] }, keys: [runKey(ctx, n.profile)!], settings: { colorRules: RUN_RULES.map((r) => ({ ...r })) } });

  // 4. colours and icons (never over what the model set)
  for (const w of d.widgets) {
    if (w.type === 'text' || w.type === 'image' || w.type === 'link' || w.type === 'embed') continue;
    const t = typeOf(ctx, w, d);
    const s = w.settings;
    if (!s.style) {
      const c = w.type === 'alarms' ? '#d03b3b' : color(t);
      s.style = { accentBar: c, iconColor: c, icon: w.type === 'alarms' ? 'alert' : w.type === 'table' && t ? typeIcon(t) : w.type === 'status' && t ? typeIcon(t) : CHART.has(w.type) ? 'chart' : keyIcon(ctx, t, w.keys[0]) };
    }
    const rk = t ? runKey(ctx, t) : null;
    if (rk && !s.colorRules?.length && (w.type === 'status' || w.type === 'table') && w.keys.includes(rk)) s.colorRules = RUN_RULES.map((r) => ({ ...r, ...(w.type === 'table' ? { key: rk } : {}) }));
    if (w.type === 'kpi' && s.sparkline === undefined) s.sparkline = true;
    sizeWidget(ctx, w);
  }

  // 5. layout
  layoutPass(d.widgets);

  const p = Dashboard.safeParse(d);
  if (!p.success) return d0;
  const before = new Set(checkDashboard(d0, metaLookup(ctx, d0)));
  const now = checkDashboard(p.data, metaLookup(ctx, p.data)).filter((e) => !before.has(e));
  return now.length ? d0 : p.data;
}

/**
 * Arranges widgets in rows without gaps (D-026; also the chat op arrangeLayout, D-029): text first, small
 * cards in rows of up to 4 (the last row split evenly), wide charts full width, bar/donut in pairs, tables in
 * pairs (an odd table next to the alarm list), alarm lists, then the rest in pairs. Mutates x/y/w (and h to
 * even out a row) and sorts `ws` by position.
 */
export function layoutPass(ws: Widget[]): Widget[] {
  const place = (w: Widget, x: number, y: number, wd: number) => Object.assign(w, { x, y, w: wd });
  let y = 0;
  const texts = ws.filter((w) => w.type === 'text');
  const smalls = ws.filter((w) => CARD.has(w.type));
  const charts = ws.filter((w) => CHART.has(w.type));
  const tables = ws.filter((w) => w.type === 'table');
  const alarms = ws.filter((w) => w.type === 'alarms');
  const rest = ws.filter((w) => !texts.includes(w) && !smalls.includes(w) && !charts.includes(w) && !tables.includes(w) && !alarms.includes(w));
  for (const w of texts) {
    place(w, 0, y, 12);
    y += w.h;
  }
  // cards: rows of up to 4, the last row split evenly so it fills the width
  for (let i = 0; i < smalls.length; ) {
    const left = smalls.length - i;
    const per = left <= 4 ? left : left === 5 || left === 6 ? 3 : 4;
    const row = smalls.slice(i, i + per);
    const h = Math.max(...row.map((w) => w.h));
    let x = 0;
    row.forEach((w, j) => {
      const wd = j === row.length - 1 ? 12 - x : Math.floor(12 / per);
      place(w, x, y, wd);
      w.h = h;
      x += wd;
    });
    y += h;
    i += per;
  }
  // charts: wide ones full width, bar/donut two per row
  const wide = charts.filter((w) => ['line', 'area', 'timeline', 'heatmap'].includes(w.type));
  const half = charts.filter((w) => !wide.includes(w));
  for (const w of wide) {
    place(w, 0, y, 12);
    y += w.h;
  }
  const pairs = <T,>(a: T[]) => Array.from({ length: Math.ceil(a.length / 2) }, (_, i) => a.slice(i * 2, i * 2 + 2));
  for (const [a, b] of pairs(half)) {
    const h = Math.max(a.h, b?.h ?? 0);
    place(a, 0, y, b ? 6 : 12);
    a.h = h;
    if (b) {
      place(b, 6, y, 6);
      b.h = h;
    }
    y += h;
  }
  // tables two per row; an odd last table shares its row with the first alarm list
  const alarmQueue = [...alarms];
  for (const [a, b0] of pairs(tables)) {
    const b = b0 ?? alarmQueue.shift();
    const h = Math.max(a.h, b?.h ?? 0, b?.type === 'alarms' ? 4 : 0);
    place(a, 0, y, b ? 6 : 12);
    a.h = h;
    if (b) {
      place(b, 6, y, 6);
      b.h = h;
    }
    y += h;
  }
  for (const w of alarmQueue) {
    place(w, 0, y, 12);
    w.h = Math.max(w.h, 4);
    y += w.h;
  }
  for (const [a, b] of pairs(rest)) {
    place(a, 0, y, b ? 6 : 12);
    if (b) place(b, 6, y, 6);
    y += Math.max(a.h, b?.h ?? 0);
  }
  ws.sort((a, b) => a.y - b.y || a.x - b.x);
  return ws;
}
