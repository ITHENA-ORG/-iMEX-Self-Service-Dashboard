// core/chat.ts — chat-to-dashboard (DECISIONS D-014, D-020, D-021).
//
// Flow of one chat turn (`chatTurn`, called by the builder's Chat tab):
//   1. `buildCatalog` turns the user's scope into an aliased catalogue: assets N1.., machines D1..,
//      machine types with their property keys, names, units and kinds. Raw ThingsBoard ids never
//      reach the model; machines outside the user's scope that a draft still references are shown
//      as OUTSIDE_ACCESS and cannot be referenced back.
//   2. `buildRequest` makes the body (D-074: the catalogue, the open machine, the last 10 turns + the draft as
//      JSON + the request) with ONE forced tool, `dashboard_ops` (TOOL below), in Anthropic, OpenAI
//      and Gemini formats (PROVIDER_TOOLS, D-021).
//   3. `ruleChainTransport` relays it through ThingsBoard, because the browser must not hold the API
//      key and there is no backend: write `dbb_chat_req` on the store asset -> rule chain
//      "DBB Chat relay (POC)" reads the key from the tenant-owned asset DBB-LLM-CONFIG, picks Claude /
//      OpenAI / Gemini from the key format, adds model/max tokens, calls that provider -> writes
//      `dbb_chat_resp` on the user (D-074) = {reqId, ok, provider, toolInput | toolInputJson | error, usage}
//      -> the widget polls that attribute (every 1.2 s, up to 30 s). No ThingsBoard MCP server or
//      other service is involved; the model never calls ThingsBoard.
//   4. `normaliseToolInput` + Zod (`LlmOutput`) validate the tool input; `applyOps` maps aliases
//      back to ids and applies the ops to a COPY of the draft, then `checkDashboard` (limits and
//      property kinds). On any problem the request is retried ONCE with the problems appended
//      ("Your previous answer was invalid: ..."); a second failure throws and the draft is unchanged.
//   5. The builder shows the reply and the changes and offers undo.
//
// Invariants: new widgets are placed by autoPlace unless the user asked for a position (D-029: x/y/w/h on
// add/updateWidget, arrangeLayout); chat never saves or applies anything
// (setApplyTarget only proposes a target for the Save dialog); rich text from the model is sanitised.
// The 30-turns-per-hour limit is the builder's (browser-side); the chain has its own per-user limit (D-074).
//
// SECURITY (D-074, round 11 audit H5): the chain checks the writer's role in the role registry (Build dashboards), counts
// the user's requests per hour, and owns the system prompt and the tool (chat-prompt.ts); the browser sends only the
// conversation and the context. The catalogue only contains the user's scope, but scope itself is UI-enforced (D-012).
// The prompt treats catalogue and draft text as data to limit prompt injection through entity labels.

import { designPass, sizeWidget, layoutPass } from './design';
import { resolveCollisions } from '../render/grid';
import { z } from 'zod';
import * as api from './api';
import type { UserContext, Node } from './scope';
import * as scope from './scope';
import { Dashboard, Widget, WIDGET_TYPES, WIDGET_CAPS, DEFAULT_SIZE, TIME_RANGES, MAX_WIDGETS, MAX_KEYS, MAX_DEVICES, CONTENT_TYPES, WidgetSettings, DashboardTheme, THEME_PRESETS, ICONS, FONTS, checkDashboard, dashboardKind, newId } from './schema';
import { metaLookup, propKind } from './compat';
import { sanitizeHtml } from '../render/rich';
import { firstFit } from '../render/grid';
import { watchAttribute } from './tb-socket';
import { alertsLicensed, widgetLicensed } from './licence';

// ---------- catalog + aliases ----------

/** Aliased view of the user's scope sent to the model, plus the alias maps to translate back. */
export interface Catalog {
  devAlias: Map<string, string>; // alias -> deviceId
  nodeAlias: Map<string, string>; // alias -> assetId
  byId: Map<string, string>; // entity id -> alias
  /** Compact JSON of {nodes, machines, machineTypes} embedded in the system prompt. */
  text: string;
  /** Machine type -> catalogue keys (from `ctx.profileKeys`) with their property kind. */
  profiles: Record<string, { key: string; name: string; unit: string; kind?: string }[]>;
}

/**
 * Builds the aliased catalogue from `ctx.nodes` (assets N1.., devices D1.., in map order) and
 * `ctx.profileKeys` (only machine types that occur in scope; chatTurn merges the live keys in first). Aliases are stable only within one
 * call, so each turn rebuilds both the catalogue and the draft view. Pure.
 */
export function buildCatalog(ctx: UserContext): Catalog {
  const devAlias = new Map<string, string>();
  const nodeAlias = new Map<string, string>();
  const byId = new Map<string, string>();
  let d = 0;
  let n = 0;
  const nodes = [...ctx.nodes.values()];
  for (const x of nodes.filter((x) => x.entityType === 'ASSET')) {
    const a = `N${++n}`;
    nodeAlias.set(a, x.id);
    byId.set(x.id, a);
  }
  for (const x of nodes.filter((x) => x.entityType === 'DEVICE')) {
    const a = `D${++d}`;
    devAlias.set(a, x.id);
    byId.set(x.id, a);
  }
  const profiles: Catalog['profiles'] = {};
  for (const p of new Set(nodes.filter((x) => x.entityType === 'DEVICE').map((x) => x.profile)))
    profiles[p] = (ctx.profileKeys[p] ?? []).map((k) => ({ key: k.key, name: k.displayName, unit: k.unit, kind: propKind(k) }));
  const row = (x: Node) => ({
    alias: byId.get(x.id),
    label: x.label,
    type: x.profile,
    parent: x.parentId ? byId.get(x.parentId) ?? null : null,
  });
  // Keys present in more than one machine type: the only ones a single widget can show across types (D-024).
  const owners = new Map<string, string[]>();
  for (const [p, ks] of Object.entries(profiles)) for (const k of ks) owners.set(k.key, [...(owners.get(k.key) ?? []), p]);
  const sharedKeys = Object.fromEntries([...owners].filter(([, ps]) => ps.length > 1));
  const text = JSON.stringify(
    {
      nodes: nodes.filter((x) => x.entityType === 'ASSET').map(row),
      machines: nodes.filter((x) => x.entityType === 'DEVICE').map(row),
      machineTypes: profiles,
      sharedKeys,
    },
    null,
    0,
  );
  return { devAlias, nodeAlias, byId, text, profiles };
}

// ---------- operations (what the LLM may return) ----------
// These Zod schemas validate the tool input; the JSON schema given to the model is TOOL below
// (looser on purpose). Keep both in sync when adding an op.

/** Binding as the model writes it: catalogue aliases and machine type names instead of ids. */
const AliasBinding = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('current') }),
  z.object({ mode: z.literal('fixed'), machines: z.array(z.string()).min(1).max(10) }),
  z.object({ mode: z.literal('siblings'), machineType: z.string() }),
  z.object({ mode: z.literal('nearest'), machineType: z.string() }),
  z.object({ mode: z.literal('nodeQuery'), node: z.string(), machineType: z.string() }),
  z.object({ mode: z.literal('none') }),
]);

/** The model may set any widget setting; html/description are sanitised on apply. */
const Settings = WidgetSettings;

/**
 * One dashboard operation. Widgets are referenced by draft aliases W1.. (index + 1 in the draft
 * as sent). The key/machine maxima here are the legacy ones; the current limits are enforced
 * afterwards by `checkDashboard`.
 */
/** D-029: grid position and size (12 columns; rows of 64 px + 10 px gap). */
const Pos = { x: z.number().int().min(0).max(11).optional(), y: z.number().int().min(0).max(200).optional(), w: z.number().int().min(1).max(12).optional(), h: z.number().int().min(1).max(12).optional() };

export const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addWidget'), type: z.enum(WIDGET_TYPES), title: z.string().max(120), binding: AliasBinding, keys: z.array(z.string()).max(10), settings: Settings.optional(), ...Pos }),
  z.object({
    op: z.literal('updateWidget'),
    widget: z.string(),
    title: z.string().max(120).optional(),
    type: z.enum(WIDGET_TYPES).optional(),
    binding: AliasBinding.optional(),
    keys: z.array(z.string()).max(10).optional(),
    settings: Settings.optional(),
    ...Pos,
  }),
  z.object({ op: z.literal('removeWidget'), widget: z.string() }),
  // D-029: tidy the whole page (rows without gaps, lists sized to their rows); see core/design.ts layoutPass.
  z.object({ op: z.literal('arrangeLayout') }),
  z.object({ op: z.literal('setTimeRange'), range: z.enum(TIME_RANGES) }),
  z.object({ op: z.literal('renameDashboard'), name: z.string().min(1).max(120) }),
  z.object({ op: z.literal('setMachineType'), machineType: z.string() }),
  z.object({ op: z.literal('setApplyTarget'), target: z.enum(['this', 'node', 'customer']), node: z.string().optional() }),
  z.object({ op: z.literal('setTheme'), theme: DashboardTheme }),
  // D-024: start a new, unsaved dashboard (must be the first op); the builder asks before dropping unsaved work.
  z.object({ op: z.literal('startNewDashboard'), name: z.string().min(1).max(120) }),
  // D-024: remove every widget of the draft ("replace this dashboard").
  z.object({ op: z.literal('clearWidgets') }),
]);
export type Op = z.infer<typeof Op>;

/** Validated tool input: a short reply, the ops, and optionally a clarification question (then no ops are applied). */
export const LlmOutput = z.object({
  /** D-024: build = ops applied; clarify = question asked; help = answer about the app, no ops; refuse = out of scope. */
  intent: z.enum(['build', 'clarify', 'help', 'refuse']).optional(),
  reply: z.string().max(2000),
  ops: z.array(Op).max(40),
  clarification: z.object({ question: z.string().max(300), options: z.array(z.string().max(80)).min(2).max(6) }).nullable().optional(),
});
export type LlmOutput = z.infer<typeof LlmOutput>;

/** The three answers to "Where should I build it?" for role / fleet requests (D-024). */
export const WHERE_OPTIONS = ['Start a new dashboard', 'Replace this dashboard', 'Add to this dashboard'] as const;

/** Apply target suggested by the model via setApplyTarget; the user confirms it in the Save dialog. */
export interface ApplyProposal {
  target: 'this' | 'node' | 'customer';
  nodeId?: string;
}

/** Outcome of a successful turn: the new draft plus what changed (added/updated widget ids, removed titles). */
export interface ChatResult {
  draft: Dashboard;
  reply: string;
  clarification?: { question: string; options: string[] } | null;
  applyProposal?: ApplyProposal | null;
  changed: { added: string[]; updated: string[]; removed: string[] };
  warnings: string[];
  /** D-024: the draft is a new dashboard (startNewDashboard); the builder confirms before dropping unsaved work. */
  newDashboard?: boolean;
  /** D-024: the model's answer, held back until the user says where to build it (see whereGuard). */
  pending?: LlmOutput | null;
  /** D-024: ops dropped by the lenient apply after a failed retry, in plain words. */
  skipped?: string[];
  intent?: LlmOutput['intent'];
  /** D-026: the answer built a fresh dashboard (new, replaced, or on an empty draft); the design pass runs on it. */
  fresh?: boolean;
  /** D-029: the answer re-arranged the whole page (arrangeLayout); the builder fits every widget to its content. */
  arranged?: boolean;
}

/** Draft as the LLM sees it: widget aliases W1.., bindings with catalog aliases, never raw ids. */
export function draftForPrompt(draft: Dashboard, cat: Catalog) {
  return {
    name: draft.name,
    machineType: draft.profile,
    timeRange: draft.timeRange,
    theme: draft.theme ?? null,
    widgets: draft.widgets.map((w, i) => ({
      widget: `W${i + 1}`,
      type: w.type,
      title: w.title,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      keys: w.keys,
      binding: bindingToAlias(w, cat),
      settings: w.settings,
    })),
  };
}

/** Binding with ids replaced by catalogue aliases; ids not in scope become 'OUTSIDE_ACCESS'. */
function bindingToAlias(w: Widget, cat: Catalog): any {
  const b = w.binding;
  switch (b.mode) {
    case 'fixed':
      return { mode: 'fixed', machines: b.deviceIds.map((id) => cat.byId.get(id) ?? 'OUTSIDE_ACCESS') };
    case 'siblings':
    case 'nearest':
      return { mode: b.mode, machineType: b.profile };
    case 'nodeQuery':
      return { mode: 'nodeQuery', node: cat.byId.get(b.nodeId) ?? 'OUTSIDE_ACCESS', machineType: b.profile };
    default:
      return { mode: b.mode };
  }
}

/**
 * Applies validated ops to a deep copy of the draft (the input draft is never modified).
 * Translates aliases back to ids, trims keys to the widget type's maximum (warning), stops adding
 * at MAX_WIDGETS (warning), sanitises html/description, recomputes `kind`, auto-places new widgets,
 * then runs the Zod schema and `checkDashboard` with property kinds.
 * A role without dashboards.applyMany asking for node/customer targets, or a location the user does not hold in full,
 * gets a warning instead of a proposal (UI-level rule, D-050).
 * @throws OpsError listing every problem (unknown aliases, keys, machine types, limit or kind
 *         violations); `chatTurn` sends these back to the model for the retry.
 */
export function applyOps(
  ctx: UserContext,
  draft: Dashboard,
  out: LlmOutput,
  cat: Catalog,
  opts: { aliasFrom?: Dashboard; ignore?: Set<string>; aliases?: Map<string, string> } = {},
): ChatResult {
  const errs: string[] = [];
  const warnings: string[] = [];
  let d: Dashboard = JSON.parse(JSON.stringify(draft));
  // W aliases always refer to the draft as it was sent to the model (opts.aliasFrom in the lenient apply).
  // opts.aliases (lenient apply) is shared across calls and updated in place.
  const aliasToWidget = opts.aliases ?? new Map((opts.aliasFrom ?? draft).widgets.map((w, i) => [`W${i + 1}`, w.id]));
  let newDashboard = false;
  // D-029: widgets the model placed or sized itself; arrangeLayout asked
  const placedByModel = new Set<string>();
  const sizedByModel = new Set<string>();
  const resized = new Set<string>();
  let arrange = false;
  const bindingSets = new Map<string, number>();
  const changed = { added: [] as string[], updated: [] as string[], removed: [] as string[] };
  let applyProposal: ApplyProposal | null = null;

  const toBinding = (b: z.infer<typeof AliasBinding>, where: string): Widget['binding'] | null => {
    const prof = (t: string) => {
      if (!cat.profiles[t]) errs.push(`${where}: unknown machine type "${t}". Known: ${Object.keys(cat.profiles).join(', ')}.`);
      return t;
    };
    switch (b.mode) {
      case 'current':
      case 'none':
        return { mode: b.mode };
      case 'fixed': {
        const ids = b.machines.map((a) => cat.devAlias.get(a));
        if (ids.some((x) => !x)) {
          errs.push(`${where}: unknown machine alias in ${b.machines.join(', ')}.`);
          return null;
        }
        return { mode: 'fixed', deviceIds: ids as string[] };
      }
      case 'siblings':
      case 'nearest':
        return { mode: b.mode, profile: prof(b.machineType) };
      case 'nodeQuery': {
        const id = cat.nodeAlias.get(b.node);
        if (!id) {
          errs.push(`${where}: unknown node alias ${b.node}.`);
          return null;
        }
        // "ALL" = every machine type under the node; only for widgets without properties (alarm list, D-024).
        if (/^(all|\*)$/i.test(b.machineType)) return { mode: 'nodeQuery', nodeId: id, profile: '' };
        return { mode: 'nodeQuery', nodeId: id, profile: prof(b.machineType) };
      }
    }
  };

  // machine types whose catalogue a widget's keys must come from
  const profilesOf = (w: Widget): string[] => {
    const env = { ctx, deviceId: null, timeRange: d.timeRange };
    const b = w.binding;
    if (b.mode === 'current') return d.profile ? [d.profile] : [];
    if (b.mode === 'fixed') return b.deviceIds.map((id) => ctx.nodes.get(id)?.profile).filter(Boolean) as string[];
    if (b.mode === 'none') return [];
    void env;
    if (b.mode === 'nodeQuery' && !b.profile) return [...new Set(scope.devicesUnder(ctx, b.nodeId).map((x) => x.profile))];
    return [b.profile];
  };

  const checkKeys = (w: Widget, where: string) => {
    const cap = WIDGET_CAPS[w.type];
    if (cap.keys[1] === 0) {
      w.keys = [];
      return;
    }
    if (w.keys.length > cap.keys[1]) {
      warnings.push(`${where}: kept the first ${cap.keys[1]} propert${cap.keys[1] === 1 ? 'y' : 'ies'}.`);
      w.keys = w.keys.slice(0, cap.keys[1]);
    }
    if (w.binding.mode === 'nodeQuery' && !w.binding.profile && w.keys.length) {
      errs.push(`${where}: machineType "ALL" only works for an alarm list; for properties use one widget per machine type.`);
      return;
    }
    for (const p of profilesOf(w)) {
      const known = new Set((cat.profiles[p] ?? []).map((k) => k.key));
      const bad = w.keys.filter((k) => !known.has(k));
      if (bad.length) errs.push(`${where}: ${p} has no propert${bad.length > 1 ? 'ies' : 'y'} ${bad.join(', ')}. Available: ${[...known].join(', ')}.`);
    }
  };

  for (const [i, op] of out.ops.entries()) {
    const where = `op ${i + 1} (${op.op})`;
    if (op.op === 'startNewDashboard') {
      if (i !== 0) {
        errs.push(`${where}: startNewDashboard must be the first op.`);
        continue;
      }
      const now = Date.now();
      d = { schemaVersion: 1, id: newId('d'), name: op.name, kind: 'standalone', profile: null, timeRange: 'realtime', widgets: [], ownerId: ctx.userId, ownerName: ctx.displayName, version: 0, updatedAt: now, updatedBy: ctx.displayName, copiedFrom: null };
      aliasToWidget.clear();
      newDashboard = true;
      changed.added.length = changed.updated.length = 0;
      continue;
    }
    if (op.op === 'clearWidgets') {
      for (const w of d.widgets) changed.removed.push(w.title || w.type);
      d.widgets = [];
      aliasToWidget.clear();
      continue;
    }
    if (op.op === 'addWidget') {
      // D-073: a widget whose module is not licensed (the alarm list without Alarms) is left out
      if (!widgetLicensed(op.type)) {
        warnings.push('An alarm list cannot be added here, so it was left out.');
        continue;
      }
      if (d.widgets.length >= MAX_WIDGETS) {
        warnings.push(`Stopped at the ${MAX_WIDGETS}-widget limit.`);
        continue;
      }
      const binding = CONTENT_TYPES.has(op.type) ? { mode: 'none' as const } : toBinding(op.binding, where);
      if (!binding) continue;
      const size = DEFAULT_SIZE[op.type];
      const w: Widget = { id: newId(), type: op.type, title: op.title, x: 0, y: 0, w: size.w, h: size.h, binding, keys: op.keys, settings: cleanSettings({ ...(op.settings ?? {}) }) };
      // A text widget without content would be an empty card: use its title as the heading.
      if (op.type === 'text' && !w.settings.html && op.title) w.settings.html = sanitizeHtml(`<h2>${op.title.replace(/[<>&]/g, '')}</h2>`);
      checkKeys(w, where);
      if (op.w !== undefined) w.w = op.w;
      if (op.h !== undefined) {
        w.h = op.h;
        sizedByModel.add(w.id);
      }
      if (op.x !== undefined || op.y !== undefined) {
        w.x = op.x ?? 0;
        w.y = op.y ?? 0;
        placedByModel.add(w.id);
      }
      d.widgets.push(w);
      changed.added.push(w.id);
      // Widgets added in this answer continue the W numbering, so a later op can refine them (small models
      // add first and set binding/keys with updateWidget W<n> afterwards, D-024).
      let top = 0;
      for (const a of aliasToWidget.keys()) top = Math.max(top, Number(a.slice(1)) || 0);
      aliasToWidget.set(`W${top + 1}`, w.id);
    } else if (op.op === 'updateWidget') {
      // No widget named: the widget added just before in this answer.
      const id = op.widget ? aliasToWidget.get(op.widget) : changed.added[changed.added.length - 1];
      const w = d.widgets.find((x) => x.id === id);
      if (!w) {
        errs.push(`${where}: no widget ${op.widget}.`);
        continue;
      }
      if (op.type && !widgetLicensed(op.type)) {
        warnings.push('An alarm list cannot be added here, so that change was left out.'); // D-073
        continue;
      }
      if (op.title !== undefined) w.title = op.title;
      if (op.type) {
        w.type = op.type;
        const s = DEFAULT_SIZE[op.type];
        if (s.w === 12 || w.w < s.w) w.w = Math.max(w.w, s.w);
        if (w.x + w.w > 12) w.x = 12 - w.w;
      }
      if (op.binding) {
        // Several data sources for one widget in one answer = the model tried to mix machine types on one
        // widget and would silently keep only the last one (seen with flash-lite, D-024): reject so it retries.
        const n = (bindingSets.get(w.id) ?? 0) + 1;
        bindingSets.set(w.id, n);
        if (n === 2) errs.push(`${where}: ${op.widget || 'the widget'} got several different data sources in one answer. A widget shows the same properties for all its machines; add one widget per machine type instead.`);
        const b = toBinding(op.binding, where);
        if (b) w.binding = b;
      }
      if (op.type || op.keys || op.binding) resized.add(w.id);
      if (op.keys) w.keys = op.keys;
      if (op.settings) w.settings = cleanSettings({ ...w.settings, ...op.settings });
      if (op.x !== undefined || op.y !== undefined || op.w !== undefined || op.h !== undefined) {
        if (op.w !== undefined) w.w = op.w;
        if (op.h !== undefined) {
          w.h = op.h;
          sizedByModel.add(w.id);
        }
        if (op.x !== undefined) w.x = op.x;
        if (op.y !== undefined) w.y = op.y;
        placedByModel.add(w.id);
      }
      if (op.type && CONTENT_TYPES.has(op.type)) w.binding = { mode: 'none' };
      checkKeys(w, where);
      changed.updated.push(w.id);
    } else if (op.op === 'removeWidget') {
      const id = aliasToWidget.get(op.widget);
      const idx = d.widgets.findIndex((x) => x.id === id);
      if (idx < 0) errs.push(`${where}: no widget ${op.widget}.`);
      else {
        changed.removed.push(d.widgets[idx].title);
        d.widgets.splice(idx, 1);
      }
    } else if (op.op === 'arrangeLayout') {
      arrange = true;
    } else if (op.op === 'setTheme') d.theme = { ...(d.theme ?? {}), ...op.theme };
    else if (op.op === 'setTimeRange') d.timeRange = op.range;
    else if (op.op === 'renameDashboard') d.name = op.name;
    else if (op.op === 'setMachineType') {
      if (!cat.profiles[op.machineType]) errs.push(`${where}: unknown machine type ${op.machineType}.`);
      else d.profile = op.machineType;
    } else if (op.op === 'setApplyTarget') {
      // D-050: the role's dashboards.applyMany; a location needs to be held in full (not only the path to a grant)
      if (op.target === 'customer' && !ctx.canApplyMany) warnings.push("Your role can't apply a dashboard to all machines; you can apply it to this machine only.");
      else if (op.target === 'node') {
        const id = op.node ? cat.nodeAlias.get(op.node) : undefined;
        if (!id) errs.push(`${where}: node alias required for target "node".`);
        else if (!ctx.canApplyMany) warnings.push("Your role can't apply a dashboard to a group of machines.");
        else if (!scope.holdsAll(ctx, id)) warnings.push('That location is outside your access (you need all of it); you can apply to this machine only.');
        else applyProposal = { target: 'node', nodeId: id };
      } else applyProposal = { target: op.target };
    }
  }

  d.kind = dashboardKind(d.widgets);
  if (d.kind === 'device' && !d.profile) {
    // chatTurn already pre-fills the profile when the builder is open for a machine; otherwise
    // the model must call setMachineType (this error is sent back to it on the retry)
    errs.push('The dashboard uses "this machine" bindings but has no machine type; call setMachineType.');
  }
  // New widgets the model did not place go to the first free slot; widgets the model moved or resized keep
  // their spot and the others move down to make room (D-029); arrangeLayout tidies everything at the end.
  for (const w of d.widgets) {
    w.w = Math.min(12, Math.max(1, w.w));
    if (w.x + w.w > 12) w.x = 12 - w.w;
  }
  // content-aware sizes (D-026/D-029) for new widgets and for widgets whose content changed
  for (const w of d.widgets) {
    if (sizedByModel.has(w.id)) continue;
    if (changed.added.includes(w.id)) sizeWidget(ctx, w);
    else if (resized.has(w.id)) {
      const h0 = w.h;
      sizeWidget(ctx, w);
      if (w.h !== h0) placedByModel.add(w.id);
    }
  }
  autoPlace(d, new Set(changed.added.filter((id) => !placedByModel.has(id))));
  for (const id of placedByModel) if (d.widgets.some((w) => w.id === id)) d.widgets = resolveCollisions(d.widgets, id);
  if (arrange) {
    for (const w of d.widgets) sizeWidget(ctx, w);
    layoutPass(d.widgets);
  }
  const parsed = Dashboard.safeParse(d);
  if (!parsed.success) errs.push(...parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`));
  else errs.push(...checkDashboard(parsed.data, metaLookup(ctx, parsed.data)));
  // Problems the draft already had before this turn don't block the model's changes.
  const fresh = opts.ignore ? errs.filter((e) => !opts.ignore!.has(e)) : errs;
  if (fresh.length) throw new OpsError(fresh);
  const isFresh = newDashboard || out.ops.some((o) => o.op === 'clearWidgets') || (draft.widgets.length === 0 && changed.added.length > 0);
  return { draft: parsed.success ? parsed.data : d, reply: out.reply, clarification: out.clarification ?? null, applyProposal, changed, warnings, newDashboard, intent: out.intent, fresh: isFresh, arranged: arrange };
}

/** Problems a draft already has (checkDashboard with property kinds); ignored when judging the model's ops. */
export function existingProblems(ctx: UserContext, d: Dashboard): Set<string> {
  const p = Dashboard.safeParse(d);
  if (!p.success) return new Set();
  const out = checkDashboard(p.data, metaLookup(ctx, p.data));
  if (p.data.kind === 'device' && !p.data.profile) out.push('The dashboard uses "this machine" bindings but has no machine type; call setMachineType.');
  return new Set(out);
}

/**
 * Lenient apply (D-024), used when the model's corrected answer is still invalid: applies the ops one at a
 * time and keeps each op that does not add a problem. Draft-level ops (startNewDashboard first, then
 * setMachineType / rename / time range / theme) go first so widget ops can rely on them.
 * @returns the result with `skipped` = one plain sentence per dropped op; throws OpsError when nothing applies.
 */
export function applyOpsLenient(ctx: UserContext, draft: Dashboard, out: LlmOutput, cat: Catalog): ChatResult {
  const rank = (o: Op) => (o.op === 'startNewDashboard' ? 0 : ['setMachineType', 'renameDashboard', 'setTimeRange', 'setTheme', 'clearWidgets'].includes(o.op) ? 1 : o.op === 'arrangeLayout' ? 3 : 2);
  const ops = out.ops.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i);
  const ignore = existingProblems(ctx, draft);
  let cur = draft;
  const aliases = new Map(draft.widgets.map((w, i) => [`W${i + 1}`, w.id]));
  const acc: ChatResult = { draft, reply: out.reply, clarification: null, applyProposal: null, changed: { added: [], updated: [], removed: [] }, warnings: [], skipped: [], newDashboard: false, intent: out.intent };
  // Units: an addWidget together with the later updateWidget ops that refine it through its new W alias
  // (W<n+k> for the k-th added widget), so "add, then set binding/keys" is judged as one step.
  const units: Op[][] = [];
  let base = draft.widgets.length;
  let adds = 0;
  const unitOfAlias = new Map<string, Op[]>();
  for (const { o } of ops) {
    if (o.op === 'startNewDashboard' || o.op === 'clearWidgets') {
      base = 0;
      adds = 0;
      unitOfAlias.clear();
    }
    if (o.op === 'updateWidget' && unitOfAlias.has(o.widget)) {
      unitOfAlias.get(o.widget)!.push(o);
      continue;
    }
    if (o.op === 'updateWidget' && !o.widget && units.length && units[units.length - 1][0].op === 'addWidget') {
      units[units.length - 1].push(o);
      continue;
    }
    const u = [o];
    units.push(u);
    if (o.op === 'addWidget') unitOfAlias.set(`W${base + ++adds}`, u);
  }
  for (const unit of units) {
    const o = unit[0];
    try {
      // A failed op must not leave aliases behind: work on a copy, keep it only on success.
      const trial = new Map(aliases);
      const r = applyOps(ctx, cur, { reply: '', ops: unit, clarification: null }, cat, { ignore, aliases: trial });
      aliases.clear();
      for (const [k, v] of trial) aliases.set(k, v);
      cur = r.draft;
      if (r.newDashboard) {
        acc.newDashboard = true;
        acc.changed = { added: [], updated: [], removed: [] };
      }
      acc.changed.added.push(...r.changed.added);
      acc.changed.updated.push(...r.changed.updated);
      acc.changed.removed.push(...r.changed.removed);
      acc.warnings.push(...r.warnings);
      if (r.applyProposal) acc.applyProposal = r.applyProposal;
      if (r.fresh || r.newDashboard) acc.fresh = true;
      if (r.arranged) acc.arranged = true;
    } catch (e: any) {
      const why = e instanceof OpsError ? e.problems.map(plainProblem).join(' ') : String(e?.message ?? e);
      const what = o.op === 'addWidget' ? `“${o.title || o.type}”` : o.op === 'updateWidget' ? `the change to ${o.widget}` : o.op;
      acc.skipped!.push(`Skipped ${what}: ${why}`);
    }
  }
  const any = acc.changed.added.length + acc.changed.updated.length + acc.changed.removed.length > 0 || acc.newDashboard || JSON.stringify(cur) !== JSON.stringify(draft);
  if (!any) throw new OpsError(acc.skipped!);
  acc.draft = cur;
  if (draft.widgets.length === 0 && acc.changed.added.length) acc.fresh = true;
  return acc;
}

/** Validation problem without the internal "op 3 (addWidget): " prefix, for the user. */
export function plainProblem(p: string): string {
  return p.replace(/^op \d+ \(\w+\): /, '').replace(/^Skipped [^:]+: /, '');
}

/** Sanitises model-written rich text (`html`, `description`); `html` replaces legacy `markdown`. Mutates and returns `s`. */
function cleanSettings(s: Widget['settings']): Widget['settings'] {
  if (s.html !== undefined) s.html = sanitizeHtml(s.html);
  if (s.description !== undefined) s.description = sanitizeHtml(s.description);
  if (s.html !== undefined) delete s.markdown;
  return s;
}

/** Validation failure of model output; `problems` are fed back to the model on retry. */
export class OpsError extends Error {
  constructor(public problems: string[]) {
    super(problems.join('\n'));
  }
}

/**
 * Places newly added widgets (ids in `added`) around the existing ones, mutating `d.widgets`:
 * text first, small cards in the first free slot from the top, line/area/timeline full width at the
 * bottom, other charts and tables/alarms below existing content. Existing widgets never move.
 */
export function autoPlace(d: Dashboard, added: Set<string>) {
  const fixed = d.widgets.filter((w) => !added.has(w.id));
  // -1 text, 0 small cards, 1 charts, 2 tables/alarms/embed
  const rank = (t: string) => (['value', 'kpi', 'gauge', 'progress', 'status', 'summary', 'link', 'image'].includes(t) ? 0 : t === 'text' ? -1 : ['line', 'area', 'bar', 'timeline', 'heatmap', 'donut', 'multivalue'].includes(t) ? 1 : 2);
  const news = d.widgets.filter((w) => added.has(w.id)).sort((a, b) => rank(a.type) - rank(b.type));
  const placed = [...fixed];
  for (const w of news) {
    const r = rank(w.type);
    if (r <= 0) {
      const p = firstFit(placed, w.w, w.h);
      w.x = p.x;
      w.y = p.y;
    } else {
      const bottom = Math.max(0, ...placed.map((p) => p.y + p.h));
      if (r === 1 && (w.type === 'line' || w.type === 'area' || w.type === 'timeline')) {
        w.x = 0;
        w.w = 12;
        w.y = bottom;
      } else {
        const p = firstFit(placed.filter((x) => x.y + x.h > bottom - 4), w.w, w.h);
        w.x = p.x;
        w.y = Math.max(p.y, placed.length ? Math.min(bottom, p.y) : 0);
        if (placed.some((x) => x.x < w.x + w.w && w.x < x.x + x.w && x.y < w.y + w.h && w.y < x.y + x.h)) {
          w.x = 0;
          w.y = bottom;
        }
      }
    }
    placed.push(w);
  }
}

// ---------- prompt ----------

export { promptTemplate, fillPrompt, chatContract, TOOL, geminiSchema, PROVIDER_TOOLS, MARK as PROMPT_MARK } from './chat-prompt';
import { fillPrompt } from './chat-prompt';

/**
 * System prompt as the rule chain builds it (D-074: the chain holds the template; this copy is for the tests and the
 * e2e fake relay): the template with the role's apply rule, the licence's alarm list, the catalogue and the machine.
 */
export function systemPrompt(ctx: UserContext, cat: Catalog, currentMachineAlias: string | null): string {
  return fillPrompt({ applyMany: !!ctx.canApplyMany, alerts: alertsLicensed(), catalog: cat.text, machine: currentMachineAlias });
}

/** One earlier chat message (plain text) kept by the builder for context. */
export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/** The request body the builder writes (D-074, version 2). */
export interface ChatRequestBody {
  v: 2;
  /** The aliased catalogue JSON (`Catalog.text`): data the chain puts into its own system prompt. */
  catalog: string;
  /** The open machine's alias (D1..), or null for a standalone dashboard. */
  machine: string | null;
  /** The last 10 turns, then the aliased draft and the request (plain text only). */
  messages: Turn[];
}

/**
 * Request body for the relay (D-074): only the conversation and the dashboard context. The rule chain holds the system
 * prompt and the tool (`chat-prompt.ts`, deployed with the chain), fills in the role's apply rule and the licence's
 * alarm list itself, adds model / max tokens and reshapes it per provider (D-021). Sends the last 10 turns, then the
 * aliased draft and the user's message; `correction` appends the validation problems of the previous attempt.
 * @param currentDeviceId machine the builder is open for (sent as its alias), or null.
 */
export function buildRequest(ctx: UserContext, cat: Catalog, draft: Dashboard, history: Turn[], message: string, currentDeviceId: string | null, correction?: string): ChatRequestBody {
  const alias = currentDeviceId ? cat.byId.get(currentDeviceId) ?? null : null;
  const msgs: Turn[] = history.slice(-10).map((t) => ({ role: t.role, content: String(t.content) }));
  let user = `DRAFT (JSON data): ${JSON.stringify(draftForPrompt(draft, cat))}\n\nUSER REQUEST: ${message}`;
  if (correction) user += `\n\nYour previous answer was invalid:\n${correction}\nReturn a corrected answer.`;
  msgs.push({ role: 'user', content: user });
  return { v: 2, catalog: cat.text, machine: alias, messages: msgs };
}

/**
 * Normalises the loose tool input into the strict LlmOutput shape: keeps only the fields each op
 * type uses, defaults an addWidget binding ('none' for content widgets, else 'current'), keys and
 * title. Unknown op types pass through and fail validation.
 * @throws ZodError when the result does not match LlmOutput.
 */
export function normaliseToolInput(input: any): LlmOutput {
  // Gemini returns settings/theme as JSON strings (see geminiSchema); turn them back into objects.
  const obj = (v: any) => {
    if (typeof v !== 'string') return v;
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' ? p : undefined;
    } catch {
      return undefined;
    }
  };
  const ops = (Array.isArray(input?.ops) ? input.ops : []).map((o: any) => (o && typeof o === 'object' ? { ...o, ...(o.settings !== undefined ? { settings: obj(o.settings) } : {}), ...(o.theme !== undefined ? { theme: obj(o.theme) } : {}) } : o));
  const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  const bind = (b: any) => (b && typeof b === 'object' ? pick(b, ['mode', 'machines', 'node', 'machineType']) : b);
  const norm = ops.map((o0: any) => {
    // Tolerate common slips of small models (seen with Gemini flash-lite, D-024): "name" for a widget's title,
    // "title" for a new dashboard's name, updateWidget without "widget" (= the widget added just before).
    const o = o0 && typeof o0 === 'object' ? { ...o0 } : o0;
    if (o && (o.op === 'addWidget' || o.op === 'updateWidget') && o.title === undefined && typeof o.name === 'string') o.title = o.name;
    // ...a binding's machineType written next to the binding instead of inside it...
    if (o && (o.op === 'addWidget' || o.op === 'updateWidget') && o.binding && typeof o.binding === 'object' && !o.binding.machineType && typeof o.machineType === 'string' && ['nodeQuery', 'siblings', 'nearest'].includes(o.binding.mode))
      o.binding = { ...o.binding, machineType: o.machineType };
    // ...and a title, keys or binding put inside "settings".
    if (o && (o.op === 'addWidget' || o.op === 'updateWidget')) {
      const st = obj(o.settings);
      if (st && typeof st === 'object') {
        for (const k of ['title', 'keys', 'binding'] as const) if (o[k] === undefined && st[k] !== undefined) o[k] = st[k];
        for (const k of ['title', 'keys', 'binding']) delete st[k];
        o.settings = st;
      }
    }
    if (o && o.op === 'updateWidget' && (o.widget === undefined || o.widget === null)) o.widget = '';
    // D-029: positions as numbers; null or junk is dropped (models send "6" or null)
    if (o && (o.op === 'addWidget' || o.op === 'updateWidget'))
      for (const k of ['x', 'y', 'w', 'h']) {
        const n = typeof o[k] === 'string' && o[k].trim() !== '' ? Number(o[k]) : o[k];
        const [lo, hi] = k === 'x' ? [0, 11] : k === 'y' ? [0, 200] : [1, 12];
        if (typeof n === 'number' && Number.isFinite(n)) o[k] = Math.min(hi, Math.max(lo, Math.round(n)));
        else delete o[k];
      }
    switch (o?.op) {
      case 'addWidget':
        return { ...pick(o, ['op', 'type', 'title', 'keys', 'settings', 'x', 'y', 'w', 'h']), binding: bind(o.binding ?? { mode: CONTENT_TYPES.has(o.type) ? 'none' : 'current' }), keys: o.keys ?? [], title: o.title ?? '' };
      case 'updateWidget':
        return { ...pick(o, ['op', 'widget', 'title', 'type', 'keys', 'settings', 'x', 'y', 'w', 'h']), ...(o.binding ? { binding: bind(o.binding) } : {}) };
      case 'removeWidget':
        return pick(o, ['op', 'widget']);
      case 'setTimeRange':
        return pick(o, ['op', 'range']);
      case 'renameDashboard':
        return pick(o, ['op', 'name']);
      case 'setMachineType':
        return pick(o, ['op', 'machineType']);
      case 'setApplyTarget':
        return pick(o, ['op', 'target', 'node']);
      case 'setTheme':
        return pick(o, ['op', 'theme']);
      case 'startNewDashboard':
        return { op: o.op, name: o.name || o.title || 'New dashboard' };
      case 'clearWidgets':
      case 'arrangeLayout':
        return { op: o.op };
      default:
        return o;
    }
  });
  const intent = ['build', 'clarify', 'help', 'refuse'].includes(input?.intent) ? input.intent : undefined;
  // An empty clarification object (some models send {} or {question:""}) means "no clarification".
  let cl = input?.clarification && Array.isArray(input.clarification.options) && input.clarification.options.length >= 2 ? { question: String(input.clarification.question || input?.reply || ''), options: input.clarification.options.slice(0, 6) } : null;
  // A help answer that offers to add a widget ("Would you like me to add one?") gets yes/no buttons.
  if (!cl && intent === 'help' && /(would you like|do you want|shall i|should i)[^?]*\badd\b[^?]*\?/i.test(String(input?.reply ?? ''))) cl = { question: String(input.reply), options: ['Yes, add it', 'No thanks'] };
  // Small models (seen with Gemini flash-lite) ask "Where should I build it?" in the reply but leave out the
  // clarification object: give the user the standard buttons anyway (D-024).
  if (!cl && (!Array.isArray(input?.ops) || !input.ops.length) && /where (should|shall|do you want me to|would you like me to) (i )?build/i.test(String(input?.reply ?? '')))
    cl = { question: String(input.reply), options: [...WHERE_OPTIONS] };
  return LlmOutput.parse({ intent, reply: String(input?.reply ?? '').slice(0, 2000), ops: norm, clarification: cl });
}

/**
 * Like normaliseToolInput, but drops ops that don't match the Op schema instead of failing the whole
 * answer (used for the lenient apply after a failed retry, D-024). `dropped` holds a plain reason per op.
 */
export function normaliseLenient(input: any): { out: LlmOutput; dropped: string[] } {
  const dropped: string[] = [];
  const ops = Array.isArray(input?.ops) ? input.ops : [];
  const keep: any[] = [];
  for (const o of ops) {
    try {
      keep.push(normaliseToolInput({ reply: '', ops: [o] }).ops[0]);
    } catch {
      dropped.push(`Skipped an unreadable ${o?.op ?? 'operation'}${o?.title ? ` (“${String(o.title).slice(0, 60)}”)` : ''}.`);
    }
  }
  const base = normaliseToolInput({ ...input, ops: [] });
  return { out: { ...base, ops: keep }, dropped };
}

// ---------- transport via ThingsBoard rule chain ----------

/** D-074: the reply attribute on the requesting user (SERVER_SCOPE), written by the rule chain. */
export const RESP_KEY = 'dbb_chat_resp';

/** Sends a request body and returns the tool input; swappable for tests (fake transport). */
export interface Transport {
  send(body: unknown): Promise<{ toolInput: any; usage?: any }>;
}

/**
 * Writes `{reqId, userId, body}` to the store asset's SERVER attribute `dbb_chat_req`. The rule chain
 * "DBB Chat relay (POC)" (default chain of the DashboardStore profile, D-014, D-016, D-021) reads the API key
 * from the tenant-owned asset DBB-LLM-CONFIG, picks Claude / OpenAI / Gemini from the key format, calls it
 * and writes the reply `dbb_chat_resp` = {reqId, ok, provider, toolInput | toolInputJson | error, usage} on the
 * requesting USER (D-074: the user ThingsBoard says wrote the request; other customer users cannot write a user's
 * attributes, so nobody can plant a forged reply, which they could in the old store slot `dbb_chat_resp_<userId>`).
 * The key never reaches the browser.
 * D-046: the reply is pushed over ThingsBoard's WebSocket (an attribute subscription through the page's widget,
 * core/tb-socket.ts watchAttribute), with a REST read every 10 s as a safety net. Without a ThingsBoard widget context
 * (or when the subscription does not answer within 1.2 s) the attribute is polled every 1.2 s as before, until the
 * reqId matches or `timeoutMs` passes.
 * Concurrent requests from different users share `dbb_chat_req` but get their replies on their own user;
 * an older response with another reqId is ignored. The timeout message always says 30 seconds.
 * @throws when the store is missing, the relay reports an error (e.g. missing API key), or on timeout.
 */
export function ruleChainTransport(ctx: UserContext, timeoutMs = 30000): Transport {
  const once = oneRelayCall(ctx, timeoutMs);
  return {
    // D-024: one automatic retry after 4 s when the provider is overloaded or unreachable (transient).
    async send(body) {
      try {
        return await once(body);
      } catch (e: any) {
        if (!/overloaded|Could not reach/i.test(String(e?.message))) throw e;
        await new Promise((r) => setTimeout(r, 4000));
        return once(body);
      }
    },
  };
}

/** One request through the relay (see ruleChainTransport). */
function oneRelayCall(ctx: UserContext, timeoutMs: number): (body: unknown) => Promise<{ toolInput: any; usage?: any }> {
  return async (body) => {
    if (!ctx.store) throw new Error('Dashboard store is missing.');
    const reqId = newId('r');
    // D-074: the reply comes on the user's own entity (only the rule engine and the user can write it)
    const me: api.EntityRef = { id: ctx.userId, entityType: 'USER' };
    const respKey = RESP_KEY;
    // subscribed before the request is written, so the reply can't be missed
    let pushed: any = null;
    let heard = false;
    let failed = false;
    let wake: (() => void) | null = null;
    const watch = watchAttribute(
      me,
      respKey,
      (raw) => {
        heard = true;
        const v = api.parseMaybeJson(raw);
        if (v?.reqId === reqId) pushed = v;
        wake?.();
      },
      () => {
        failed = true;
        wake?.();
      },
    );
    const pause = (ms: number) =>
      new Promise<void>((res) => {
        const t = setTimeout(() => res(), Math.max(0, ms));
        wake = () => {
          clearTimeout(t);
          res();
        };
      });
    try {
      await api.saveAttrs(ctx.store, { dbb_chat_req: { reqId, userId: ctx.userId, body } });
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (!pushed) await pause(Math.min(until - Date.now(), watch && heard && !failed ? 10000 : 1200));
        wake = null;
        const r = pushed ?? (await api.getAttrs(me, [respKey]))[respKey];
        if (r?.reqId === reqId) {
          if (!r.ok) throw new Error(r.error || `LLM call failed (${r.status ?? 'error'})`);
          // OpenAI returns the tool arguments as a JSON string (toolInputJson); Claude and Gemini as an object.
          let toolInput = r.toolInput;
          if (toolInput == null && r.toolInputJson) {
            try {
              toolInput = JSON.parse(r.toolInputJson);
            } catch {
              throw new Error('The assistant returned an unreadable answer. Try again.');
            }
          }
          return { toolInput, usage: r.usage };
        }
      }
      throw new Error('The assistant did not answer within 30 seconds. Your draft is unchanged.');
    } finally {
      watch?.stop();
    }
  };
}

/**
 * Full turn: request -> validate -> one corrective retry -> result.
 * If the draft has no machine type but the builder is open for a machine, that machine's profile is
 * used as the draft's type. A clarification or a help/refuse answer returns the draft unchanged.
 * D-024: if the corrected answer is still invalid, the valid ops of that answer are applied anyway
 * (`applyOpsLenient`) and the dropped ones are listed in `skipped`; problems the draft already had don't
 * count against the model.
 * @returns the ChatResult plus the attempt count (1 or 2) and the token usage reported by the relay.
 * @throws transport errors as they come; "I couldn't build that: <reason>" when nothing could be applied.
 */
export async function chatTurn(
  ctx: UserContext,
  transport: Transport,
  draft: Dashboard,
  history: Turn[],
  message: string,
  currentDeviceId: string | null,
): Promise<ChatResult & { attempts: number; usage?: any }> {
  // the model sees every key the machines send, not only the catalogued ones (9 Oct 2026); cached after the first turn
  await scope.liveKeys(ctx);
  const cat = buildCatalog(ctx);
  // a device dashboard opened for a machine: give the model the machine type up front
  const base = !draft.profile && currentDeviceId ? { ...draft, profile: ctx.nodes.get(currentDeviceId)?.profile ?? null } : draft;
  const ignore = existingProblems(ctx, base);
  const none = { added: [], updated: [], removed: [] };
  let correction: string | undefined;
  let lastProblems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { toolInput, usage } = await transport.send(buildRequest(ctx, cat, base, history, message, currentDeviceId, correction));
    try {
      const out = normaliseToolInput(toolInput);
      if (out.clarification) return { draft, reply: out.reply, clarification: out.clarification, changed: none, warnings: [], attempts: attempt, usage, intent: 'clarify' };
      // An answer (help) or a refusal never changes the draft, even if the model also sent ops.
      if (!out.ops.length || out.intent === 'help' || out.intent === 'refuse') return { draft, reply: out.reply, clarification: null, changed: none, warnings: [], attempts: attempt, usage, intent: out.intent ?? 'help' };
      if (needsWhere(base, out, message)) return { draft, reply: 'Where should I build it?', clarification: { question: 'Where should I build it?', options: [...WHERE_OPTIONS] }, changed: none, warnings: [], attempts: attempt, usage, intent: 'clarify', pending: out };
      const res = polish(ctx, applyOps(ctx, base, out, cat, { ignore }));
      return { ...res, attempts: attempt, usage };
    } catch (e: any) {
      lastProblems = e instanceof OpsError ? e.problems : e?.issues ? e.issues.slice(0, 6).map((i: any) => `${i.path?.join('.')}: ${i.message}`) : [String(e?.message ?? e)];
      correction = lastProblems.join('\n').slice(0, 1500);
      if (attempt === 2) {
        // Still invalid after the correction: keep what is valid instead of failing the whole request.
        try {
          const { out, dropped } = normaliseLenient(toolInput);
          if (out.clarification) return { draft, reply: out.reply, clarification: out.clarification, changed: none, warnings: [], attempts: 2, usage, intent: 'clarify' };
          if (needsWhere(base, out, message)) return { draft, reply: 'Where should I build it?', clarification: { question: 'Where should I build it?', options: [...WHERE_OPTIONS] }, changed: none, warnings: [], attempts: 2, usage, intent: 'clarify', pending: out };
          const res = polish(ctx, applyOpsLenient(ctx, base, out, cat));
          return { ...res, skipped: [...dropped, ...(res.skipped ?? [])], attempts: 2, usage };
        } catch (e2: any) {
          if (e2 instanceof OpsError) lastProblems = e2.problems;
        }
      }
    }
  }
  throw new Error(`I couldn't build that: ${plainProblem(lastProblems[0] ?? 'the answer was not valid')}${lastProblems.length > 1 ? ` (and ${lastProblems.length - 1} more problem${lastProblems.length > 2 ? 's' : ''})` : ''}. Try asking for fewer things at once, or name the machines or properties.`);
}

/**
 * Whether to ask "Where should I build it?" before applying an answer (D-024, user decision 29 Sep 2026: ask each
 * time). True when the open draft is a machine dashboard with widgets, the user has not said where, and the
 * answer would clear it, start a new one, or add two or more fleet widgets (bindings other than "this machine").
 * Models don't always ask themselves, so the builder enforces it.
 */
export function needsWhere(draft: Dashboard, out: LlmOutput, message: string): boolean {
  if (!draft.widgets.length || !draft.profile) return false;
  if (explicitWhere(message)) return false;
  if (out.ops.some((o) => o.op === 'clearWidgets' || o.op === 'startNewDashboard')) return true;
  const fleet = out.ops.filter((o) => o.op === 'addWidget' && o.binding && o.binding.mode !== 'current' && o.binding.mode !== 'none');
  return fleet.length >= 2;
}

/** The user's message already says where: one of the WHERE_OPTIONS or words like "new dashboard", "replace", "add to this". */
export function explicitWhere(message: string): 'new' | 'replace' | 'add' | null {
  const m = message.trim().toLowerCase();
  if (m === WHERE_OPTIONS[0].toLowerCase() || /\b(new dashboard|start (a )?new|from scratch|separate dashboard)\b/.test(m)) return 'new';
  if (m === WHERE_OPTIONS[1].toLowerCase() || /\b(replace|clear (the |this )?(dashboard|page)|start over)\b/.test(m)) return 'replace';
  if (m === WHERE_OPTIONS[2].toLowerCase() || /\badd (it |them )?to (this|the current)\b/.test(m)) return 'add';
  return null;
}

/**
 * Applies an answer held back by needsWhere, per the user's choice, without another LLM call:
 * new = startNewDashboard + the widget ops, replace = clearWidgets + the widget ops, add = the widget ops only.
 * Uses the lenient apply, so widgets that don't fit (e.g. "this machine" widgets on a new standalone
 * dashboard, or beyond the widget limit) are skipped with a reason.
 */
export function applyWhere(ctx: UserContext, draft: Dashboard, pending: LlmOutput, choice: string): ChatResult {
  const where = explicitWhere(choice) ?? 'add';
  const cat = buildCatalog(ctx);
  const body = pending.ops.filter((o) => o.op !== 'clearWidgets' && o.op !== 'startNewDashboard');
  const named = pending.ops.find((o) => o.op === 'startNewDashboard') as { name: string } | undefined;
  const rename = pending.ops.find((o) => o.op === 'renameDashboard') as { name: string } | undefined;
  const head: Op[] = where === 'new' ? [{ op: 'startNewDashboard', name: named?.name ?? rename?.name ?? 'Overview' }] : where === 'replace' ? [{ op: 'clearWidgets' }] : [];
  // Keep the open dashboard's name unless the user asked for a new one.
  const ops = where === 'new' ? [...head, ...body] : [...head, ...body.filter((o) => o.op !== 'renameDashboard')];
  const out: LlmOutput = { ...pending, ops, clarification: null };
  try {
    return polish(ctx, applyOps(ctx, draft, out, cat, { ignore: existingProblems(ctx, draft) }));
  } catch {
    return polish(ctx, applyOpsLenient(ctx, draft, out, cat));
  }
}

/** D-026: runs the design pass on a fresh dashboard (see core/design.ts); other drafts are returned as they are. */
export function polish<T extends ChatResult>(ctx: UserContext, res: T): T {
  if (res.fresh) res.draft = designPass(ctx, res.draft);
  return res;
}

/** Up to 4 example requests for an empty chat, based on the current machine and the first 'Site' asset in scope. */
export function suggestedPrompts(ctx: UserContext, deviceId: string | null): string[] {
  const out: string[] = [];
  const cur = deviceId ? ctx.nodes.get(deviceId) : null;
  if (cur) {
    out.push(`Key values and an 8-hour trend for ${cur.label}`);
    const sib = scope.allDevices(ctx, cur.profile);
    if (sib.length > 1) out.push(`Compare all ${cur.profile} machines over the last 8 hours`);
  }
  const sites = [...ctx.nodes.values()].filter((n) => n.entityType === 'ASSET' && n.profile === 'Site');
  if (sites[0]) out.push(`Overview of ${sites[0].label}`);
  if (alertsLicensed()) out.push('Alarm list for everything I can see'); // D-073
  return out.slice(0, 4);
}
