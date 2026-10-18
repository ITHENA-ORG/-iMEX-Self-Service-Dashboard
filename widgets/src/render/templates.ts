/**
 * Starter dashboards for the builder's template gallery (DECISIONS D-019). Each template adapts
 * to the machine type's properties (status key, main numeric keys, power key) so the same
 * template works for compressors, dryers, weather stations...
 *
 * Runs in the browser (builder). Pure data + builder functions: no REST calls, no DOM.
 * Called by `builder/builder.ts`: the empty-canvas card shows the first 4 templates, the
 * "All templates…" dialog shows all. `useTemplate` calls `build()` for the selected machine,
 * then replaces the draft's widgets, theme and time range (undoable). An empty result is
 * reported to the user as "no suitable properties".
 *
 * How keys are picked (`pickKeys`), from the profile-key catalogue `ctx.profileKeys[profile]`
 * in catalogue order, using the property kinds from `core/compat.ts` (D-020):
 * - status: the first property that is not a plain number (on/off, text or coded state);
 * - nums: number/coded properties except the status key, preferring ones whose name is not a
 *   counter (hours / count / total); if only counters exist they are used anyway;
 * - power: the first number/coded property named like power / kW / energy / current.
 * Widgets that need a status or a number are simply left out when none exists.
 *
 * Limits respected (D-020, enforced on save by `checkDashboard` in core/schema.ts): at most 10 widgets per
 * page (largest template: 9), at most 4 keys per widget (tables are sliced to 3-4), time ranges
 * within 8 h, and property kinds that fit each widget type. "Same-type machines" widgets use the
 * `siblings` binding, so the 4-machine cap of a fixed machine list does not apply; charts still
 * stop at 8 lines at render time. Keep new templates inside these limits, or the user will get a
 * dashboard they cannot save.
 */
import type { UserContext } from '../core/scope';
import type { Widget, DashboardTheme, ColorRule, TimeRange } from '../core/schema';
import { newId } from '../core/schema';
import { STATUS } from './theme';
import { keyMeta } from './widgets';
import { propKind } from '../core/compat';

/** A gallery entry. */
export interface Template {
  /** Stable id used by the gallery buttons (`data-tpl`). */
  id: string;
  name: string;
  /** Shown on the gallery card and as its tooltip. */
  description: string;
  /** Dashboard theme applied with the template (replaces the draft's theme). */
  theme: DashboardTheme;
  /** Dashboard time range the template is designed for. */
  timeRange: TimeRange;
  /** Preview colours for the gallery card. */
  swatch: [string, string, string];
  /** Informational: the template compares same-type machines at a location (not read by the builder yet). */
  needsSiblings?: boolean;
  /** D-073: the licence feature the template is about (not offered without it, e.g. the alarm board needs `alerts`). */
  needs?: string;
  /**
   * Creates the widgets (fresh ids, positions on the 12-column grid).
   * @param ctx User context; only `profileKeys` is read.
   * @param profile Device profile (machine type) of the selected machine.
   * @param deviceId Selected machine; currently unused by the built-in templates.
   * @returns Widgets, or [] when the machine type has no property the template needs.
   */
  build(ctx: UserContext, profile: string, deviceId: string | null): Widget[];
}

/** Keys chosen for a machine type by `pickKeys`. */
interface Keys {
  status?: string;
  nums: string[];
  power?: string;
}

/** Chooses the status, numeric and power keys of a machine type (rules in the file header). */
function pickKeys(ctx: UserContext, profile: string): Keys {
  const all = ctx.profileKeys[profile] ?? [];
  // Only properties whose kind fits: states for status/timeline, numbers for KPIs, gauges and charts.
  const status = all.find((k) => propKind(k) !== 'number')?.key;
  const numeric = all.filter((k) => k.key !== status && (propKind(k) === 'number' || propKind(k) === 'coded'));
  const nums = numeric.filter((k) => !/hours|count|total/i.test(k.key)).map((k) => k.key);
  const power = numeric.find((k) => /power|kw|energy|current/i.test(k.key))?.key;
  return { status, nums: nums.length ? nums : numeric.map((k) => k.key), power };
}

/** Default binding: "This machine", i.e. whichever machine the dashboard is opened for. */
const cur = { mode: 'current' as const };
/**
 * Widget factory: new id, position (x, y, w, h in grid cells), keys, settings and binding.
 * Content widgets (text, link, image, embed) always get binding `none` since they need no data.
 */
const W = (type: Widget['type'], title: string, x: number, y: number, w: number, h: number, keys: string[], settings: Widget['settings'] = {}, binding: Widget['binding'] = cur): Widget => ({
  id: newId(),
  type,
  title,
  x,
  y,
  w,
  h,
  binding: type === 'text' || type === 'link' || type === 'image' || type === 'embed' ? { mode: 'none' } : binding,
  keys,
  settings,
});

/**
 * Amber above ~75% and red above ~90% of the property's catalogue min..max range (defaults 0..100),
 * rounded to one decimal. Red comes first because the first matching rule wins (see rules.ts).
 */
function rangeRules(ctx: UserContext, profile: string, key: string): ColorRule[] {
  const m = keyMeta(ctx, profile, key);
  const span = m.max - m.min || 1;
  const r = (f: number) => Math.round((m.min + span * f) * 10) / 10;
  return [
    { op: 'gt', value: r(0.9), color: STATUS.critical, label: 'High' },
    { op: 'gt', value: r(0.75), color: STATUS.warning, label: 'Watch' },
  ];
}

/** Running = green, stopped = grey, for on/off status keys. */
const statusRules: ColorRule[] = [
  { op: 'isTrue', color: STATUS.good, label: 'Running' },
  { op: 'isFalse', color: STATUS.neutral, label: 'Stopped' },
];

/**
 * Full-width, frameless text widget used as a page heading. `html` may use the built-in
 * placeholders {{machine}} and {{location}}, filled at render time (see rich.ts).
 */
const header = (html: string, y = 0, h = 1): Widget => W('text', '', 0, y, 12, h, [], { html, style: { bg: 'transparent', border: 'none', shadow: 'none', padding: 'compact' } });

/**
 * The template gallery, in display order. The first four also appear on the empty canvas.
 * Layouts are hand-placed on the 12-column grid; when a key is missing, later rows keep their
 * y position (the grid does not auto-compact on load), so small gaps are possible.
 */
export const TEMPLATES: Template[] = [
  {
    id: 'overview',
    name: 'Machine overview',
    description: 'Live status, KPI cards with trends, a gauge, an area chart and the run-state timeline.',
    theme: { preset: 'light', font: 'Inter', radius: 14 },
    timeRange: 'realtime',
    swatch: ['#f4f5f7', '#2a78d6', '#0ca30c'],
    build(ctx, profile) {
      const k = pickKeys(ctx, profile);
      const ws: Widget[] = [header('<h2>{{machine}} <span style="color: #898781; font-weight: 400">· {{location}}</span></h2>')];
      // Row 1: optional status pill, then up to 3 KPIs (3 columns each) shifted right if the pill exists.
      let x = 0;
      if (k.status) {
        ws.push(W('status', 'Status', 0, 1, 3, 2, [k.status], { colorRules: statusRules, style: { icon: 'power' } }));
        x = 3;
      }
      k.nums.slice(0, 3).forEach((key, i) => {
        const m = keyMeta(ctx, profile, key);
        ws.push(W('kpi', m.displayName, x + i * 3, 1, 3, 2, [key], { colorRules: rangeRules(ctx, profile, key), colorTarget: 'accent', style: { icon: /temp/i.test(key) ? 'thermometer' : /press/i.test(key) ? 'gauge' : /power|kw/i.test(key) ? 'bolt' : 'chart' } }));
      });
      const main = k.nums[0];
      if (main) {
        ws.push(W('gauge', keyMeta(ctx, profile, main).displayName, 0, 3, 4, 4, [main], { colorRules: rangeRules(ctx, profile, main) }));
        ws.push(W('area', `${keyMeta(ctx, profile, main).displayName} · trend`, 4, 3, 8, 4, [main], { smooth: true, colorRules: rangeRules(ctx, profile, main) }));
      }
      let y = 7;
      if (k.status) {
        ws.push(W('timeline', 'Run state', 0, y, 12, 2, [k.status], { colorRules: statusRules }));
        y += 2;
      }
      ws.push(W('alarms', 'Alarms', 0, y, 12, 3, [], { alarmStatus: 'ANY', maxRows: 10 }));
      return ws;
    },
  },
  {
    id: 'energy',
    name: 'Energy & performance',
    description: 'Power KPI, min/avg/max, hourly bars, a machines × time heatmap and running-time share over the last 8 h.',
    theme: { preset: 'ocean', font: 'Poppins', radius: 12 },
    timeRange: '8h',
    swatch: ['#eaf1fa', '#256abf', '#eb6834'],
    build(ctx, profile) {
      const k = pickKeys(ctx, profile);
      // Falls back to the main numeric key when the type has no power-like property.
      const key = k.power ?? k.nums[0];
      if (!key) return [];
      const m = keyMeta(ctx, profile, key);
      const ws: Widget[] = [
        W('kpi', m.displayName, 0, 0, 4, 2, [key], { style: { icon: 'bolt', iconColor: '#eb6834' }, upIsGood: false }),
        W('summary', `${m.displayName} · this period`, 4, 0, 8, 2, [key], {}),
        W('bar', `${m.displayName} per hour`, 0, 2, 6, 4, [key], { groupBy: 'hour', agg: 'AVG' }),
        W('heatmap', `${m.displayName} · same-type machines`, 6, 2, 6, 4, [key], { heatColor: 'orange' }, { mode: 'siblings', profile }),
      ];
      if (k.status) ws.push(W('donut', 'Running time share', 0, 6, 4, 4, [k.status], { donutMode: 'state', colorRules: statusRules }));
      ws.push(W('line', `${m.displayName} · trend`, k.status ? 4 : 0, 6, k.status ? 8 : 12, 4, [key], { smooth: true }));
      return ws;
    },
  },
  {
    id: 'alarms',
    name: 'Alarm & health board',
    description: 'Dark control-room look: status, colour-coded table of same-type machines, state timelines and the alarm list.',
    theme: { preset: 'slate', font: 'Inter', radius: 10, shadow: 'none' },
    timeRange: 'realtime',
    swatch: ['#141a23', '#3987e5', '#d03b3b'],
    needsSiblings: true,
    needs: 'alerts',
    build(ctx, profile) {
      const k = pickKeys(ctx, profile);
      const ws: Widget[] = [header('<h2><span style="color: #3987e5">●</span> {{machine}} health</h2>')];
      const sib = { mode: 'siblings' as const, profile };
      if (k.status) ws.push(W('status', 'Status', 0, 1, 3, 2, [k.status], { colorRules: statusRules, colorTarget: 'accent' }));
      const cols = k.nums.slice(0, 3);
      if (cols.length) {
        // One rule set per column, scoped with `key` so each cell is judged against its own range.
        const rules: ColorRule[] = cols.flatMap((c) => rangeRules(ctx, profile, c).map((r) => ({ ...r, key: c })));
        ws.push(W('table', `All ${profile} machines here`, k.status ? 3 : 0, 1, k.status ? 9 : 12, 3, cols, { colorRules: rules }, sib));
      }
      if (k.status) ws.push(W('timeline', 'Run state · same-type machines', 0, 4, 12, 3, [k.status], { colorRules: statusRules }, sib));
      ws.push(W('alarms', 'Alarms', 0, 7, 12, 4, [], { alarmStatus: 'ANY', maxRows: 20 }, sib));
      return ws;
    },
  },
  {
    id: 'compare',
    name: 'Compare machines',
    description: 'Side-by-side of every same-type machine at the location: bars, share donut and trend lines.',
    theme: { preset: 'sand', font: 'Montserrat', radius: 16 },
    timeRange: '4h',
    swatch: ['#f4efe6', '#c9501f', '#1baf7a'],
    needsSiblings: true,
    build(ctx, profile) {
      const k = pickKeys(ctx, profile);
      const key = k.power ?? k.nums[0];
      if (!key) return [];
      const m = keyMeta(ctx, profile, key);
      const sib = { mode: 'siblings' as const, profile };
      return [
        W('bar', `Average ${m.displayName} per machine`, 0, 0, 6, 4, [key], { groupBy: 'device', agg: 'AVG' }, sib),
        W('donut', `${m.displayName} share`, 6, 0, 6, 4, [key], { donutMode: 'devices', agg: 'AVG' }, sib),
        W('line', `${m.displayName} · all machines`, 0, 4, 12, 4, [key], { smooth: true }, sib),
        W('table', 'Latest values', 0, 8, 12, 3, k.nums.slice(0, 4), {}, sib),
      ];
    },
  },
  {
    id: 'executive',
    name: 'Executive summary',
    description: 'Big numbers on coloured cards, a level bar, one trend and a notes panel — made for a wall screen.',
    theme: { preset: 'dark', font: 'Montserrat', radius: 18, density: 'roomy' },
    timeRange: 'realtime',
    swatch: ['#0d0d0d', '#3987e5', '#1baf7a'],
    build(ctx, profile) {
      const k = pickKeys(ctx, profile);
      const colors = ['#184f95', '#0f6e4f', '#6b3fa0'];
      const ws: Widget[] = [header('<h1 style="text-align: center">{{machine}}</h1>', 0, 1)];
      k.nums.slice(0, 3).forEach((key, i) =>
        ws.push(W('value', keyMeta(ctx, profile, key).displayName, i * 4, 1, 4, 2, [key], { style: { bg: colors[i], gradient: true, valueSize: 40, align: 'center', titleAlign: 'center', icon: 'star', iconColor: '#ffffff', border: 'none' } })),
      );
      const main = k.nums[0];
      if (main) {
        ws.push(W('progress', `${keyMeta(ctx, profile, main).displayName} vs range`, 0, 3, 4, 2, [main], { colorRules: rangeRules(ctx, profile, main), colorTarget: 'value' }));
        ws.push(W('area', 'Trend', 4, 3, 8, 4, [main], { smooth: true, showLegend: false }));
      }
      ws.push(W('text', 'Notes', 0, 5, 4, 2, [], { html: '<p><b>Shift notes</b></p><ul><li>Last updated {{time}}</li><li>Edit this text in the builder</li></ul>' }));
      return ws;
    },
  },
];
