// core/schema.ts — the saved dashboard JSON format (schemaVersion 1), as Zod schemas, plus limits,
// time ranges and semantic checks. Shared by the builder, the renderer, the store and chat
// validation. Changing a schema here changes what can be stored and loaded, so keep changes
// backward compatible: dashboards already saved in `dbb_d_<id>` attributes must still parse.
//
// Saved format (one attribute value `dbb_d_<id>` on the DashboardStore asset; see core/store.ts):
//   {
//     schemaVersion: 1,
//     id: 'd…',                         // newId('d'); also the attribute key suffix
//     name, ownerId, ownerName,         // owner = ThingsBoard user id / display name
//     kind: 'device' | 'standalone',    // 'device' when any widget uses a machine-relative binding
//     profile: string | null,           // machine type (device profile) a 'device' dashboard is for
//     timeRange: 'realtime'|'1h'|'2h'|'4h'|'8h'|'shift'|'prevshift',   // shift ranges: D-047
//     theme?: DashboardTheme,           // optional (D-019); absent in older saves
//     widgets: Widget[],                // see Widget below
//     version, updatedAt, updatedBy,    // optimistic concurrency (store.saveDashboard)
//     copiedFrom?: string | null,       // template id for per-machine copies
//   }
//   Widget = { id, type, title, x, y, w, h (12-column grid units), binding, keys: string[], settings }
//   Binding.mode: current | fixed(deviceIds) | siblings(profile) | nearest(profile)
//                 | nodeQuery(nodeId, profile) | none (content widgets)
//
// Limits (D-020): two layers.
//   - The Zod schema only enforces the LEGACY limits (40 widgets, 10 keys / 10 fixed machines) so
//     dashboards saved before 27 Sep 2026 still open.
//   - `checkDashboard()` enforces the current limits (MAX_WIDGETS, MAX_KEYS per type via
//     WIDGET_CAPS, MAX_DEVICES) plus property-kind compatibility, and is run on save and on chat
//     output. MAX_SERIES is enforced by the renderer (render/widgets.ts draws at most 8 lines
//     / devices and says how many were not drawn).
//
// Time ranges (D-020): stored ranges longer than 8 h (e.g. '24h', '7d') are read as '8h' by
// `normalizeRange` inside a Zod preprocess; nothing in the store is rewritten.
import { z } from 'zod';

/** Widgets per dashboard page (load on the demo server; user decision 27 Sep 2026, D-020). Enforced by checkDashboard. */
export const MAX_WIDGETS = 10;
/** Properties per widget. */
export const MAX_KEYS = 4;
/** Specific machines per widget. */
export const MAX_DEVICES = 4;
/**
 * D-074: uploaded (data:) images of one dashboard together, in characters. Each save also writes up to 10 earlier versions,
 * and a very large attribute write is refused (or never answered) by the platform, so a dashboard with many uploads
 * could become impossible to save. Enforced by checkDashboard (and on upload in the builder).
 */
export const MAX_IMAGE_CHARS = 1_000_000;
/** Series drawn in one chart (machines x properties). */
export const MAX_SERIES = 8;
/** Legacy limits, only so dashboards saved before 27 Sep 2026 still load (checkDashboard enforces the new ones on save). */
// used only in the Zod shapes below; do not lower them or old saves stop parsing
const LEGACY_MAX_WIDGETS = 40;
const LEGACY_MAX_KEYS = 10;
/** Columns of the layout grid; widget x/w are in grid columns. */
export const GRID_COLS = 12;

/** Every widget type (D-019). Adding one means updating every Record<WidgetType, …> below and in core/compat.ts, plus a renderer. */
export const WIDGET_TYPES = [
  'value', 'kpi', 'gauge', 'progress', 'status', 'multivalue', 'summary',
  'line', 'area', 'bar', 'donut', 'timeline', 'heatmap',
  'table', 'alarms',
  'text', 'image', 'link', 'embed',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** User-facing name per widget type (palette, reasons, error messages). */
export const WIDGET_LABELS: Record<WidgetType, string> = {
  value: 'Value card',
  kpi: 'KPI + trend',
  gauge: 'Gauge',
  progress: 'Level / progress bar',
  status: 'Status indicator',
  multivalue: 'Multi-value card',
  summary: 'Min / avg / max',
  line: 'Line chart',
  area: 'Area chart',
  bar: 'Bar chart',
  donut: 'Donut / share',
  timeline: 'State timeline',
  heatmap: 'Heatmap (machines × time)',
  table: 'Table',
  alarms: 'Alarm list',
  text: 'Rich text',
  image: 'Image / logo',
  link: 'Button / link',
  embed: 'Embedded page',
};

/** Palette groups in the builder. */
export const WIDGET_GROUPS: { title: string; types: WidgetType[] }[] = [
  { title: 'Values', types: ['value', 'kpi', 'gauge', 'progress', 'status', 'multivalue', 'summary'] },
  { title: 'Charts', types: ['line', 'area', 'bar', 'donut', 'timeline', 'heatmap'] },
  { title: 'Lists', types: ['table', 'alarms'] },
  { title: 'Content', types: ['text', 'image', 'link', 'embed'] },
];

/**
 * Per widget type: allowed number of property keys [min, max], whether it may show several
 * machines (`multiDevice`), and whether it needs a data source (`needsData`; false for content).
 * `keys[1]` is checked by checkDashboard; chat trims extra keys to it.
 */
export const WIDGET_CAPS: Record<WidgetType, { keys: [number, number]; multiDevice: boolean; needsData: boolean }> = {
  value: { keys: [1, 1], multiDevice: false, needsData: true },
  kpi: { keys: [1, 1], multiDevice: false, needsData: true },
  gauge: { keys: [1, 1], multiDevice: false, needsData: true },
  progress: { keys: [1, 1], multiDevice: false, needsData: true },
  status: { keys: [1, 1], multiDevice: false, needsData: true },
  multivalue: { keys: [1, MAX_KEYS], multiDevice: false, needsData: true },
  summary: { keys: [1, 1], multiDevice: false, needsData: true },
  line: { keys: [1, MAX_KEYS], multiDevice: true, needsData: true },
  area: { keys: [1, MAX_KEYS], multiDevice: true, needsData: true },
  bar: { keys: [1, 1], multiDevice: true, needsData: true },
  donut: { keys: [1, 1], multiDevice: true, needsData: true },
  timeline: { keys: [1, 1], multiDevice: true, needsData: true },
  heatmap: { keys: [1, 1], multiDevice: true, needsData: true },
  table: { keys: [1, MAX_KEYS], multiDevice: true, needsData: true },
  alarms: { keys: [0, 0], multiDevice: true, needsData: true },
  text: { keys: [0, 0], multiDevice: false, needsData: false },
  image: { keys: [0, 0], multiDevice: false, needsData: false },
  link: { keys: [0, 0], multiDevice: false, needsData: false },
  embed: { keys: [0, 0], multiDevice: false, needsData: false },
};

/** Default size in grid units for a newly added widget (builder palette and chat autoPlace). */
export const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  value: { w: 3, h: 2 },
  kpi: { w: 3, h: 2 },
  gauge: { w: 3, h: 3 },
  progress: { w: 3, h: 2 },
  status: { w: 3, h: 2 },
  multivalue: { w: 4, h: 3 },
  summary: { w: 4, h: 2 },
  line: { w: 12, h: 4 },
  area: { w: 12, h: 4 },
  bar: { w: 6, h: 4 },
  donut: { w: 4, h: 4 },
  timeline: { w: 12, h: 3 },
  heatmap: { w: 8, h: 4 },
  table: { w: 6, h: 4 },
  alarms: { w: 6, h: 4 },
  text: { w: 12, h: 1 },
  image: { w: 3, h: 2 },
  link: { w: 3, h: 1 },
  embed: { w: 6, h: 5 },
};

/** Widget types that have no data source. */
export const CONTENT_TYPES = new Set<WidgetType>(['text', 'image', 'link', 'embed']);

/**
 * Where a widget's data comes from. Machine-relative modes ('current', 'siblings', 'nearest') make
 * the dashboard a 'device' dashboard (see RELATIVE_MODES / dashboardKind). Resolution against the
 * hierarchy happens in the renderer using core/scope.ts helpers.
 */
/** D-028: ids end up in HTML attributes and attribute keys: letters, digits, '_' and '-' only. */
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid id');
export const Binding = z.discriminatedUnion('mode', [
  /** The machine the dashboard is opened for. */
  z.object({ mode: z.literal('current') }),
  /** Specific machines. */
  z.object({ mode: z.literal('fixed'), deviceIds: z.array(Id).min(1).max(LEGACY_MAX_KEYS) }),
  /** Machines of a profile under the same parent as the current machine (includes current). */
  z.object({ mode: z.literal('siblings'), profile: z.string() }),
  /** Closest machine of a profile found walking up from the current machine. */
  z.object({ mode: z.literal('nearest'), profile: z.string() }),
  /** All machines of a profile under a node (future machines included). */
  z.object({ mode: z.literal('nodeQuery'), nodeId: Id, profile: z.string() }),
  /** Text widgets. */
  z.object({ mode: z.literal('none') }),
]);
export type Binding = z.infer<typeof Binding>;

// only #hex, rgb()/rgba() or 'transparent' -- keeps user/chat input out of CSS injection territory
export const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|transparent)$/;
const Color = z.string().max(40).regex(COLOR_RE, 'colour must be #hex or rgb()');
/** D-028: a colour from older documents; anything that is not a safe colour becomes neutral grey instead of failing the load. */
const LegacyColor = z.preprocess((v) => (typeof v === 'string' && v.length <= 40 && COLOR_RE.test(v) ? v : '#8a8983'), Color);
/** D-028: font family names end up in CSS: letters, digits and spaces only; anything else is dropped. */
const FontName = z.preprocess((v) => (typeof v === 'string' && /^[A-Za-z0-9 ]{1,40}$/.test(v) ? v : undefined), z.string().optional());

// legacy colour bands; render/rules.ts converts them to colour rules at draw time (D-019)
const Band = z.object({ upTo: z.number().nullable(), color: LegacyColor });

/** Colour-rule operators; the builder offers a subset depending on the property kind (D-019). */
export const RULE_OPS = ['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'neq', 'contains', 'isTrue', 'isFalse'] as const;
export type RuleOp = (typeof RULE_OPS)[number];
export const RULE_OP_LABELS: Record<RuleOp, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'between',
  eq: '=',
  neq: '≠',
  contains: 'contains',
  isTrue: 'is true',
  isFalse: 'is false',
};
/** Value-based colour rule. First matching rule wins. */
export const ColorRule = z.object({
  /** Only for this property (multi-key widgets); empty = every property. */
  key: z.string().optional(),
  op: z.enum(RULE_OPS),
  value: z.union([z.number(), z.string()]).optional(),
  value2: z.number().optional(),
  color: Color,
  /** Optional text shown instead of the value (e.g. "Too hot"), and in state charts. */
  label: z.string().max(40).optional(),
});
export type ColorRule = z.infer<typeof ColorRule>;

/** Built-in icon names for `CardStyle.icon` (drawn by the renderer). */
export const ICONS = [
  'gauge', 'bolt', 'thermometer', 'droplet', 'fan', 'wind', 'clock', 'alert', 'check', 'power',
  'factory', 'wrench', 'chart', 'speed', 'battery', 'flame', 'snow', 'info', 'star', 'pin', 'link', 'cpu', 'home', 'list',
] as const;

/** Per-widget card style. All optional; the dashboard theme supplies defaults. */
export const CardStyle = z
  .object({
    bg: Color.optional(),
    gradient: z.boolean().optional(),
    border: z.enum(['none', 'thin', 'thick']).optional(),
    borderColor: Color.optional(),
    accentBar: Color.optional(),
    radius: z.number().int().min(0).max(28).optional(),
    shadow: z.enum(['none', 'soft', 'strong']).optional(),
    padding: z.enum(['compact', 'normal', 'roomy']).optional(),
    hideTitle: z.boolean().optional(),
    titleColor: Color.optional(),
    titleSize: z.number().int().min(10).max(28).optional(),
    titleWeight: z.enum(['400', '500', '600', '700']).optional(),
    titleAlign: z.enum(['left', 'center', 'right']).optional(),
    titleFont: FontName,
    icon: z.enum(ICONS).optional(),
    iconColor: Color.optional(),
    valueSize: z.number().int().min(12).max(72).optional(),
    valueColor: Color.optional(),
    valueFont: FontName,
    /** Horizontal alignment of values and labels. */
    align: z.enum(['left', 'center', 'right']).optional(),
    /** Vertical alignment of values and labels. */
    valign: z.enum(['top', 'middle', 'bottom']).optional(),
    /** Title above (default) or below the content. */
    titlePos: z.enum(['top', 'bottom']).optional(),
  })
  .strict();
export type CardStyle = z.infer<typeof CardStyle>;

/**
 * All widget settings in one strict object (unknown fields are rejected); each widget type uses a
 * subset. `html` and `description` must be sanitised (render/rich.ts `sanitizeHtml`) before saving;
 * chat output is sanitised in core/chat.ts. `url` allows data:image URIs up to 210k characters
 * (uploaded images, D-019), web addresses up to 2000; checkDashboard also requires https:// for
 * image/embed.
 */
export const WidgetSettings = z
  .object({
    unit: z.string().optional(),
    decimals: z.number().int().min(0).max(6).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** Colour bands, ascending; last band has upTo = null. */
    bands: z.array(Band).max(6).optional(),
    /** Status mapping value -> label/colour. */
    statusMap: z.array(z.object({ value: z.union([z.number(), z.string()]), label: z.string().max(60), color: LegacyColor })).max(8).optional(),
    agg: z.enum(['NONE', 'AVG', 'MIN', 'MAX', 'SUM']).optional(),
    /** 'day' is legacy (drawn per hour). */
    groupBy: z.enum(['15m', 'hour', 'day', 'device']).optional(),
    /** Per-widget override of the dashboard time range ('realtime' | '1h' | '2h' | '4h' | '8h' | 'shift' | 'prevshift'). */
    timeRange: z.string().optional(),
    showLegend: z.boolean().optional(),
    severities: z.array(z.enum(['CRITICAL', 'MAJOR', 'MINOR', 'WARNING', 'INDETERMINATE'])).optional(),
    alarmStatus: z.enum(['ACTIVE', 'CLEARED', 'ANY']).optional(),
    maxRows: z.number().int().min(1).max(100).optional(),
    markdown: z.string().max(4000).optional(),
    /** Sanitised rich text (text widget). Supports {{key}} placeholders for live values. */
    html: z.string().max(12000).optional(),
    /** Value-based colours; replaces bands for new widgets. */
    colorRules: z.array(ColorRule).max(12).optional(),
    /** What a matching rule colours on cards. */
    colorTarget: z.enum(['value', 'background', 'accent', 'icon']).optional(),
    /** Draw numeric rules as dashed lines on line/area charts. */
    showThresholds: z.boolean().optional(),
    style: CardStyle.optional(),
    /** Rich text shown in an (i) tooltip next to the title. */
    description: z.string().max(4000).optional(),
    footer: z.string().max(200).optional(),
    // kpi
    sparkline: z.boolean().optional(),
    compare: z.enum(['start', 'none']).optional(),
    upIsGood: z.boolean().optional(),
    // progress
    orientation: z.enum(['horizontal', 'vertical']).optional(),
    // area / line
    stacked: z.boolean().optional(),
    smooth: z.boolean().optional(),
    // donut
    donutMode: z.enum(['state', 'devices']).optional(),
    // heatmap
    heatColor: z.enum(['blue', 'orange', 'rules']).optional(),
    // image / link / embed
    url: z
      .string()
      .max(210000)
      .refine((u) => u.length <= 2000 || /^data:image\//i.test(u), 'Web addresses are limited to 2000 characters')
      .optional(),
    fit: z.enum(['contain', 'cover']).optional(),
    linkKind: z.enum(['url', 'state']).optional(),
    linkState: z.string().max(60).optional(),
    linkDevice: z.string().max(60).optional(),
    buttonStyle: z.enum(['filled', 'outline', 'card']).optional(),
    buttonColor: Color.optional(),
  })
  .strict();
export type WidgetSettings = z.infer<typeof WidgetSettings>;

/** One widget on the grid. `keys` are telemetry keys of the bound machines. */
export const Widget = z.object({
  id: Id,
  type: z.enum(WIDGET_TYPES),
  title: z.string().max(120),
  x: z.number().int().min(0).max(GRID_COLS - 1),
  y: z.number().int().min(0).max(500),
  w: z.number().int().min(1).max(GRID_COLS),
  h: z.number().int().min(1).max(20),
  binding: Binding,
  keys: z.array(z.string()).max(LEGACY_MAX_KEYS),
  settings: WidgetSettings,
});
export type Widget = z.infer<typeof Widget>;

/**
 * Allowed time ranges (D-020). 'realtime' = latest values, refreshed every 10 s; charts show a
 * rolling last hour. '1h' to '8h' are historic windows ending now, refreshed every 60 s.
 * D-047: 'shift' = the current shift so far, 'prevshift' = the last shift that has ended, both from the shift
 * calendar of the dashboard's machine (or the widget's first machine) and its site (rangeWindow, core/shifts.ts).
 * Older builds read the shift ranges as 'realtime' (normalizeRange), so a saved dashboard still opens there.
 */
export const TIME_RANGES = ['realtime', '1h', '2h', '4h', '8h', 'shift', 'prevshift'] as const;
export type TimeRange = (typeof TIME_RANGES)[number];
/** Fixed windows ending now (for pickers). */
export const HISTORIC_RANGES = ['1h', '2h', '4h', '8h'] as const;
/** D-047: windows from the shift calendar (for pickers). */
export const SHIFT_RANGES = ['shift', 'prevshift'] as const;
/** True for 'shift' and 'prevshift'. */
export const isShiftRange = (r: unknown): r is (typeof SHIFT_RANGES)[number] => r === 'shift' || r === 'prevshift';
/**
 * Maps any stored/legacy range to an allowed one: allowed values pass through, 'live' -> 'realtime',
 * any other '<n>h' / '<n>d' (e.g. '24h', '7d') -> '8h', anything else -> 'realtime'.
 * Ranges longer than 8 h were removed (load time); older saves are read as 8 h.
 * Note that '3h' also becomes '8h' (not rounded).
 */
export function normalizeRange(r: unknown): TimeRange {
  if (typeof r !== 'string') return 'realtime';
  if ((TIME_RANGES as readonly string[]).includes(r)) return r as TimeRange;
  if (r === 'live') return 'realtime';
  return /^\d+[hd]$/.test(r) ? '8h' : 'realtime';
}
/** Display label: 'Realtime', 'Last 8 h', 'Current shift' or 'Previous shift'. */
export function rangeLabel(r: string): string {
  const n = normalizeRange(r);
  if (n === 'shift') return 'Current shift';
  if (n === 'prevshift') return 'Previous shift';
  return n === 'realtime' ? 'Realtime' : `Last ${n.replace('h', ' h')}`;
}

/** Dashboard theme presets and selectable fonts (D-019). */
export const THEME_PRESETS = ['light', 'dark', 'slate', 'ocean', 'sand'] as const;
export const FONTS = ['Roboto', 'Inter', 'Poppins', 'Montserrat', 'Source Serif 4', 'JetBrains Mono'] as const;
/** Dashboard-level look (D-019). Optional in Dashboard so dashboards saved before themes still load. */
export const DashboardTheme = z
  .object({
    preset: z.enum(THEME_PRESETS).optional(),
    accent: Color.optional(),
    font: FontName,
    bg: Color.optional(),
    // https address (max 2000 chars) or an uploaded data:image up to 150 KB (D-033).
    bgImage: z
      .string()
      .max(210000)
      .refine((u) => u.length <= 2000 || /^data:image\//i.test(u), 'Web addresses are limited to 2000 characters')
      .optional(),
    bgFit: z.enum(['cover', 'contain', 'tile']).optional(),
    cardBg: Color.optional(),
    radius: z.number().int().min(0).max(28).optional(),
    shadow: z.enum(['none', 'soft', 'strong']).optional(),
    density: z.enum(['compact', 'normal', 'roomy']).optional(),
    titleAlign: z.enum(['left', 'center']).optional(),
  })
  .strict();
export type DashboardTheme = z.infer<typeof DashboardTheme>;

/**
 * The saved dashboard document (see the file header for the full format). Parse stored values with
 * `Dashboard.safeParse` and skip failures; they may be hand-edited or from a newer build.
 * The widget count is only checked against the legacy limit here; use checkDashboard for the
 * current limits.
 */
export const Dashboard = z.object({
  schemaVersion: z.literal(1),
  id: Id,
  name: z.string().min(1).max(120),
  /** 'device' when any widget uses a current-device-relative binding; needs a target profile. */
  kind: z.enum(['device', 'standalone']),
  profile: z.string().nullable(),
  timeRange: z.preprocess(normalizeRange, z.enum(TIME_RANGES)),
  widgets: z.array(Widget).max(LEGACY_MAX_WIDGETS),
  theme: DashboardTheme.optional(),
  ownerId: z.string(),
  ownerName: z.string(),
  version: z.number().int().min(0),
  updatedAt: z.number(),
  updatedBy: z.string(),
  /** Set on per-machine copies made by "Customise for this machine" or copy-mode apply. */
  copiedFrom: z.string().nullable().optional(),
});
export type Dashboard = z.infer<typeof Dashboard>;

/** Binding modes that depend on the machine the dashboard is opened for. */
export const RELATIVE_MODES = new Set(['current', 'siblings', 'nearest']);

/** 'device' when any widget uses a machine-relative binding (then a profile is required), else 'standalone'. */
export function dashboardKind(widgets: Widget[]): 'device' | 'standalone' {
  return widgets.some((w) => RELATIVE_MODES.has(w.binding.mode)) ? 'device' : 'standalone';
}

/**
 * Window length of a fixed range in ms. Realtime charts use a rolling hour. The shift ranges have no fixed length:
 * this gives 8 h for them (use rangeWindow for the real window).
 */
export function rangeMs(r: string): number {
  const n = normalizeRange(r);
  if (isShiftRange(n)) return 8 * 3600e3;
  return n === 'realtime' ? 3600e3 : Number(n.replace('h', '')) * 3600e3;
}

/** The part of a shift calendar (core/shiftcal.ts ShiftCalendar) that rangeWindow needs. */
export interface ShiftSource {
  current(now: number): { start: number; end: number; name: string } | null;
  previous(now: number): { start: number; end: number; name: string } | null;
}

/** A resolved time window. `shift` is the shift it shows (shift ranges only). */
export interface RangeWindow {
  startTs: number;
  endTs: number;
  shift?: { name: string; start: number; end: number; ended: boolean };
  /** 'shift' between two shifts: the previous one is shown instead. */
  between?: boolean;
}

/**
 * D-047: the window of a range at `now`. Fixed ranges end now. 'shift' runs from the current shift's start to now
 * (between shifts: the previous shift, marked `between`); 'prevshift' is the last shift that has ended.
 * @returns null for a shift range when `cal` is null (no shifts set up for the machine) or has no such shift.
 */
export function rangeWindow(r: string, cal: ShiftSource | null, now = Date.now()): RangeWindow | null {
  const n = normalizeRange(r);
  if (!isShiftRange(n)) return { startTs: now - rangeMs(n), endTs: now };
  if (!cal) return null;
  if (n === 'shift') {
    const cur = cal.current(now);
    if (cur) return { startTs: cur.start, endTs: now, shift: { name: cur.name, start: cur.start, end: cur.end, ended: false } };
  }
  const prev = cal.previous(now);
  if (!prev) return null;
  return { startTs: prev.start, endTs: Math.min(prev.end, now), shift: { name: prev.name, start: prev.start, end: prev.end, ended: true }, between: n === 'shift' };
}

/** Metadata lookup for a widget's property (for type checks). Undefined = unknown, not checked. */
export type MetaOf = (w: Widget, key: string) => import('./types').KeyMeta | undefined;
/** Type check hook, set by core/compat (kept out of this module to avoid an import cycle). */
let compatCheck: ((w: Widget, metaOf: MetaOf) => string | null) | null = null;
export function setCompatCheck(fn: typeof compatCheck) {
  compatCheck = fn;
}

/**
 * Semantic checks beyond the Zod shape, run on save (core/store.ts) and on chat output
 * (core/chat.ts). Enforces the current limits (D-020): widgets per page, keys per widget type,
 * grid width, single-machine types, machines per 'fixed' binding, a data source for data widgets,
 * https:// (or data:image) for image/embed, and a profile for 'device' dashboards.
 * @param d      parsed dashboard.
 * @param metaOf optional property metadata lookup (core/compat.ts `metaLookup`); when given and the
 *               compat hook is registered, property-kind mismatches are reported too.
 * @returns human-readable problems; empty = OK. Older dashboards may fail here but still render.
 */
export function checkDashboard(d: Dashboard, metaOf?: MetaOf): string[] {
  const errs: string[] = [];
  if (d.widgets.length > MAX_WIDGETS) errs.push(`At most ${MAX_WIDGETS} widgets per page (this one has ${d.widgets.length}).`);
  const ids = new Set<string>();
  for (const w of d.widgets) {
    if (ids.has(w.id)) errs.push(`Duplicate widget id ${w.id}.`);
    ids.add(w.id);
    const cap = WIDGET_CAPS[w.type];
    if (w.keys.length > cap.keys[1]) errs.push(`"${w.title}": ${WIDGET_LABELS[w.type]} takes at most ${cap.keys[1]} propert${cap.keys[1] === 1 ? 'y' : 'ies'}.`);
    if (w.x + w.w > 12) errs.push(`"${w.title}" is wider than the grid.`);
    if (!cap.multiDevice && w.binding.mode === 'fixed' && w.binding.deviceIds.length > 1)
      errs.push(`"${w.title}": ${WIDGET_LABELS[w.type]} shows one machine only.`);
    if (w.binding.mode === 'fixed' && w.binding.deviceIds.length > MAX_DEVICES) errs.push(`"${w.title}": at most ${MAX_DEVICES} specific machines per widget.`);
    if (metaOf && compatCheck) {
      const why = compatCheck(w, metaOf);
      if (why) errs.push(`"${w.title || WIDGET_LABELS[w.type]}": ${why}`);
    }
    if (!CONTENT_TYPES.has(w.type) && w.binding.mode === 'none') errs.push(`"${w.title}" has no data source.`);
    if ((w.type === 'image' || w.type === 'embed') && w.settings.url && !/^https:\/\//i.test(w.settings.url) && !/^data:image\//i.test(w.settings.url))
      errs.push(`"${w.title}": the address must start with https://.`);
  }
  if (d.kind === 'device' && !d.profile) errs.push('A machine dashboard needs a machine type (profile).');
  // D-074: the uploaded images together (they are stored inside the dashboard and in each saved version)
  const img = imageChars(d);
  if (img > MAX_IMAGE_CHARS) errs.push(`Uploaded images in this dashboard take ${Math.round(img / 1024)} KB; at most ${Math.round(MAX_IMAGE_CHARS / 1024)} KB. Remove some or use https:// image addresses.`);
  return errs;
}

/** D-074: characters of the uploaded (data:) images of a dashboard: image / embed widgets and the background image. */
export function imageChars(d: Pick<Dashboard, 'widgets' | 'theme'>): number {
  const n = (u: unknown) => (typeof u === 'string' && /^data:/i.test(u) ? u.length : 0);
  return d.widgets.reduce((t, w) => t + n(w.settings?.url), 0) + n(d.theme?.bgImage);
}

/** Short unique-enough id: prefix + base-36 time + 5 random chars ('w' widgets, 'd' dashboards, 'r' chat requests). */
export function newId(prefix = 'w'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
