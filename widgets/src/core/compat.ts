// core/compat.ts — which widget types can show which kind of property (DECISIONS D-020).
//
// Plain, deterministic rules (no model involved). Property kinds:
//   number   numeric telemetry                     -> gauge, KPI, level bar, min/avg/max, line, area, bar, heatmap
//   boolean  on/off                                -> status, state timeline
//   string   text states                           -> status, state timeline
//   coded    number with named states (meta.states) -> both groups (it is a number AND a state)
//   value, multi-value and table accept any kind; donut depends on `settings.donutMode`
//   ('state' = time in each state -> needs states, 'devices' = share by machine -> needs a number).
//   Content widgets (text, image, link, embed) and alarms take no properties and always pass.
//
// Used by:
//   - the builder, to grey out unsuitable properties / widget types / palette tiles (with the reason);
//   - core/chat.ts and core/store.ts via `checkDashboard(d, metaLookup(...))`, to reject chat output
//     and saves with a readable reason;
//   - the renderer, to show the reason instead of a broken chart for older mismatches.
//
// Import-cycle note: schema.ts cannot import this module, so this module registers `widgetProblem`
// into schema.ts through `setCompatCheck` at load time. Anything calling `checkDashboard` with a
// `metaOf` must make sure this module has been imported (store.ts and chat.ts do).
import type { KeyMeta } from './types';
import type { WidgetType } from './schema';
import { WIDGET_LABELS, CONTENT_TYPES, setCompatCheck } from './schema';
import type { Widget, MetaOf, Dashboard } from './schema';
import type { UserContext } from './scope';
import { valueType } from '../render/rules';

/** Kind of a property, as far as widget compatibility is concerned (see file header). */
export type PropKind = 'number' | 'boolean' | 'string' | 'coded';

/**
 * Kind of a property. 'coded' = a number whose values are named states (meta.states),
 * e.g. 0 = Idle, 1 = Run, 2 = Fault.
 * @param meta   catalogue entry; its `type` wins when set, otherwise the type is inferred from the
 *               key name and `sample` (render/rules.ts `valueType`).
 * @param sample optional current value to help the inference.
 */
export function propKind(meta: Partial<KeyMeta> | null | undefined, sample?: unknown): PropKind {
  // D-096: the computed properties (Current shift, On shift: <role>) are text
  if (meta?.key && /^@(?:shift|crew:)/.test(meta.key)) return 'string';
  const t = valueType(meta, sample);
  if (t === 'number' && meta?.states && Object.keys(meta.states).length) return 'coded';
  return t;
}

/** Human-readable kind, used in the "X needs a number; Y is on/off." reasons. */
export const KIND_LABEL: Record<PropKind, string> = {
  number: 'a number',
  boolean: 'on/off',
  string: 'text',
  coded: 'a coded state',
};

// kind groups; 'coded' is in both NUM and STATE
const NUM = ['number', 'coded'] as const;
const STATE = ['boolean', 'string', 'coded'] as const;
const ALL = ['number', 'boolean', 'string', 'coded'] as const;

/**
 * Property kinds each widget type accepts. Donut is listed as ALL but narrowed by `donutMode` in
 * `compatible()`. Types with an empty list take no properties. Keep in sync with NEEDS below and
 * with the kind rules in the chat system prompt (core/chat.ts).
 */
export const ACCEPTS: Record<WidgetType, readonly PropKind[]> = {
  value: ALL,
  kpi: NUM,
  gauge: NUM,
  progress: NUM,
  status: STATE,
  multivalue: ALL,
  summary: NUM,
  shiftinfo: [], // D-096: no property (the shift and the crew are worked out, not read)
  line: NUM,
  area: NUM,
  bar: NUM,
  donut: ALL, // narrowed by donutMode below
  timeline: STATE,
  heatmap: NUM,
  table: ALL,
  alarms: [],
  text: [],
  image: [],
  link: [],
  embed: [],
};

/** Wording of the requirement per type, for the reason text. */
const NEEDS: Partial<Record<WidgetType, string>> = {
  kpi: 'a number',
  gauge: 'a number',
  progress: 'a number',
  summary: 'a number',
  line: 'a number',
  area: 'a number',
  bar: 'a number',
  heatmap: 'a number',
  status: 'on/off or text states',
  timeline: 'on/off or text states',
};

/** Result of a compatibility check; `reason` is a user-facing sentence when `ok` is false. */
export interface Compat {
  ok: boolean;
  reason?: string;
}

/**
 * Can widget `type` show this property?
 * @param type widget type.
 * @param meta catalogue entry of the property (null/undefined = unknown; kind is then inferred
 *             from the key name and sample, defaulting to 'number').
 * @param o.donutMode for donut: 'state' needs states, 'devices' needs a number (default 'state').
 * @param o.sample    optional current value, for kind inference.
 * @returns `{ok: true}` or `{ok: false, reason}` with a sentence naming the widget and property.
 */
export function compatible(type: WidgetType, meta: Partial<KeyMeta> | null | undefined, o: { donutMode?: 'state' | 'devices'; sample?: unknown } = {}): Compat {
  if (CONTENT_TYPES.has(type) || type === 'alarms' || type === 'shiftinfo') return { ok: true };
  const kind = propKind(meta, o.sample);
  const name = meta?.displayName ?? meta?.key ?? 'This property';
  let accepts = ACCEPTS[type];
  let needs = NEEDS[type];
  if (type === 'donut') {
    accepts = o.donutMode === 'devices' ? NUM : STATE;
    needs = o.donutMode === 'devices' ? 'a number' : 'on/off or text states';
  }
  if (accepts.includes(kind)) return { ok: true };
  return { ok: false, reason: `${WIDGET_LABELS[type]} needs ${needs}; ${name} is ${KIND_LABEL[kind]}.` };
}

/**
 * Whether widget `type` can show every one of these properties (first failure is returned).
 * Used by the builder to grey out widget types / palette tiles for the selected source.
 */
export function typeAllowed(type: WidgetType, metas: (Partial<KeyMeta> | null | undefined)[], o: { donutMode?: 'state' | 'devices' } = {}): Compat {
  for (const m of metas) {
    const c = compatible(type, m, o);
    if (!c.ok) return c;
  }
  return { ok: true };
}

/**
 * First kind mismatch among a widget's keys, or null. Keys whose metadata is unknown
 * (`metaOf` returns undefined) are not checked. Registered as schema.ts's compat hook below.
 */
export function widgetProblem(w: Widget, metaOf: MetaOf): string | null {
  for (const k of w.keys) {
    const m = metaOf(w, k);
    if (!m) continue;
    const c = compatible(w.type, m, { donutMode: w.settings.donutMode });
    if (!c.ok) return c.reason!;
  }
  return null;
}
// side effect on import: lets schema.checkDashboard run kind checks without importing this module
setCompatCheck(widgetProblem);

/**
 * Builds a `MetaOf` lookup: property metadata for a widget's keys from the profile catalogue
 * (`ctx.profileKeys`). The profile comes from the widget binding: 'current' -> the dashboard's
 * machine type, 'fixed' -> the first listed machine's profile (only if it is in the user's scope),
 * 'siblings'/'nearest'/'nodeQuery' -> the binding's profile, 'none' -> no metadata.
 * Returns undefined for unknown keys, so they are not type-checked.
 */
export function metaLookup(ctx: Pick<UserContext, 'profileKeys' | 'nodes'>, d: Pick<Dashboard, 'profile'>): MetaOf {
  return (w, key) => {
    const b = w.binding;
    const profile =
      b.mode === 'current' ? d.profile : b.mode === 'fixed' ? ctx.nodes.get(b.deviceIds[0])?.profile ?? null : b.mode === 'none' ? null : b.profile;
    if (!profile) return undefined;
    return ctx.profileKeys[profile]?.find((k) => k.key === key);
  };
}
