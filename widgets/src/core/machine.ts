/**
 * D-064: the machine model (App UI decision U-070, spec "iMEX App UI" docs/design/MACHINE_MODEL_SPEC.md): machine
 * types, their values (display name, unit, decimals, shown, order) and ONE machine-status rule, the same on every page
 * of the app and on the Builder's machine page and Map / Listing cards.
 *
 * Stored by the app's Settings > Sites & machines as the SERVER_SCOPE attribute `imexMachineModel` on the customer's
 * "System Configuration" asset (no deploy step writes it: DBB_DEPLOY writes `dbb_profile_keys` only).
 *
 * A TypeScript port of the App UI's widgets/_shared/machine.js (pure part). Contract: widgets/test/machine-vectors.json,
 * a byte-for-byte copy of the App UI's tests/machine-vectors.json (widgets/test/machine.test.ts runs it).
 */
import type { KeyMeta } from './types';

export const KEY = 'imexMachineModel';
export const DEFAULT_OFFLINE_MIN = 15;
export const RUN_KEYS = ['Run_Status', 'runStatus', 'status', 'Status'];
export type State = 'running' | 'idle' | 'stopped' | 'fault' | 'unknown';
export type Tone = 'ok' | 'warn' | 'bad' | 'off' | 'info';
export const STATES: State[] = ['running', 'idle', 'stopped', 'fault', 'unknown'];
export const TONES: Tone[] = ['ok', 'warn', 'bad', 'off', 'info'];
const LABEL: Record<string, string> = { running: 'Running', idle: 'Idle', stopped: 'Stopped', fault: 'Fault', unknown: 'Unknown', offline: 'No data' };
const TONE: Record<string, Tone> = { running: 'ok', idle: 'warn', stopped: 'off', fault: 'bad', unknown: 'off', offline: 'warn' };
const MODES = ['auto', 'numeric', 'text'] as const;
type Mode = (typeof MODES)[number];
const DERIVED = /^aiml_|_(2min|5min|30min|2hrs|6hrs|1day)$/;
const NOT_LIFE = /^(home_page_kpi|telemetryKeys|authToken|lastActivityTime|active)$/i;

/** The built-in, industry-neutral words of the automatic mode: [words, state, label ('*' = as sent), tone]. */
export const AUTO_WORDS: [string[], State, string, Tone | ''][] = [
  [['running', 'run', 'on', 'true', 'active', 'started', 'producing', 'online'], 'running', '', ''],
  [['idle', 'standby', 'stand by', 'waiting', 'ready', 'paused'], 'idle', '', ''],
  [['stopped', 'stop', 'off', 'false', 'inactive', 'shutdown', 'shut down'], 'stopped', '', ''],
  [['fault', 'down', 'error', 'alarm', 'failed', 'failure', 'tripped', 'emergency stop'], 'fault', '', ''],
  [['no production', 'n/a'], 'stopped', 'No production', 'info'],
  [['setup', 'set up', 'changeover', 'maintenance'], 'idle', '*', 'info'],
];
const AUTO = new Map<string, (typeof AUTO_WORDS)[number]>();
for (const g of AUTO_WORDS) for (const w of g[0]) AUTO.set(w, g);

export interface Outcome { state: State; label: string; tone: Tone | '' }
export interface Rule extends Outcome { from?: number | null; to?: number | null; text?: string }
export interface StatusCfg { key: string; mode: Mode; rules: Rule[]; otherwise: Outcome; noStatus: Outcome; fallback: { key: string; above: number } | null }
export interface ValueCfg { key: string; label: string; unit: string; decimals: number | null; hidden: boolean }
export interface TypeCfg { offlineMinutes: number | null; status: StatusCfg; values: ValueCfg[]; icon?: string; accent?: string }
/** The neutral icons and accent colours a type can have (chosen on the app's editor; the Builder maps them to its own set). */
export const ICON_IDS = ['machine', 'gauge', 'drop', 'wind', 'cloud', 'bolt', 'box', 'cog'];
export const ACCENTS = ['slate', 'blue', 'violet', 'teal', 'indigo', 'amber'];
export interface Model { v: 1; rev: number; by?: string; at?: number; offlineMinutes: number; types: Record<string, TypeCfg> }
export interface Result { state: State | 'offline'; label: string; tone: Tone; raw: unknown; key: string; ts: number; source: 'status' | 'fallback' | 'nostatus' | 'offline'; newest: number }
export type Latest = Record<string, { ts: number; value: unknown } | [number, unknown][] | { ts: number; value: unknown }[] | unknown>;

const isArr = Array.isArray;
const isObj = (o: unknown): o is Record<string, any> => o !== null && typeof o === 'object' && !Array.isArray(o);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
function num(v: unknown): number | null {
  if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const minutes = (v: unknown) => { const n = num(v); return n !== null && n >= 1 && n <= 10080 ? Math.round(n) : null; };
const isState = (s: unknown): s is State => STATES.includes(s as State);
export const stateLabel = (id: string) => LABEL[id] ?? 'Unknown';
export const toneOf = (id: string): Tone => TONE[id] ?? 'off';
export const counts = (state: string) => (state === 'running' ? 'running' : state === 'offline' ? 'nodata' : 'stopped');
export const isDerived = (key: string) => DERIVED.test(String(key ?? ''));

/** The machine type: the device profile; "default" / none -> the name without its trailing number. */
export function kindOf(profile: unknown, name: unknown): string {
  const p = String(profile ?? '').trim();
  if (p && p.toLowerCase() !== 'default') return p;
  const n = String(name ?? '').trim().replace(/[\s_-]*\d+$/, '');
  return n || p || 'Machine';
}
export function readable(key: unknown): string {
  const s = String(key ?? '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}
export function splitLabel(s: unknown): { label: string; unit: string } {
  const t = String(s ?? '').trim();
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(t);
  return m && m[1] ? { label: m[1], unit: m[2].trim() } : { label: t, unit: '' };
}

// ------------------------------------------------------------------------------------------------ parse
function cleanOutcome(o: unknown, def: Outcome): Outcome {
  if (!isObj(o)) return { ...def };
  return { state: isState(o.state) ? o.state : def.state, label: str(o.label).trim().slice(0, 40), tone: TONES.includes(o.tone) ? o.tone : '' };
}
function cleanRule(r: unknown, mode: Mode): Rule | null {
  if (!isObj(r)) return null;
  const out: Rule = cleanOutcome(r, { state: 'unknown', label: '', tone: '' });
  if (mode === 'numeric') {
    let a = num(r.from), b = num(r.to);
    if (a === null && b === null && 'value' in r) a = b = num(r.value);
    if (a !== null && b !== null && a > b) [a, b] = [b, a];
    out.from = a;
    out.to = b;
  } else {
    const tx = r.text != null ? r.text : r.value;
    if (tx === null || tx === undefined || typeof tx === 'object') return null;
    out.text = String(tx).trim().slice(0, 80);
    if (!out.text) return null;
  }
  return out;
}
export function cleanStatus(s: unknown): StatusCfg {
  const out: StatusCfg = { key: '', mode: 'auto', rules: [], otherwise: { state: 'unknown', label: '', tone: '' }, noStatus: { state: 'running', label: '', tone: '' }, fallback: null };
  if (!isObj(s)) return out;
  out.key = str(s.key).trim().slice(0, 120);
  out.mode = MODES.includes(s.mode) ? s.mode : 'auto';
  if (out.mode !== 'auto' && isArr(s.rules)) for (const r of s.rules.slice(0, 64)) { const c = cleanRule(r, out.mode); if (c) out.rules.push(c); }
  out.otherwise = cleanOutcome(s.otherwise, out.otherwise);
  out.noStatus = cleanOutcome(s.noStatus, out.noStatus);
  if (isObj(s.fallback) && str(s.fallback.key).trim() && num(s.fallback.above) !== null) out.fallback = { key: str(s.fallback.key).trim().slice(0, 120), above: num(s.fallback.above)! };
  return out;
}
function cleanValues(list: unknown): ValueCfg[] {
  const out: ValueCfg[] = [];
  const seen = new Set<string>();
  if (!isArr(list)) return out;
  for (let v of list.slice(0, 500) as any[]) {
    if (typeof v === 'string') v = { key: v };
    if (!isObj(v)) continue;
    const k = str(v.key).trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const d = num(v.decimals);
    out.push({ key: k.slice(0, 120), label: str(v.label).trim().slice(0, 80), unit: str(v.unit).trim().slice(0, 20), decimals: d === null ? null : Math.max(0, Math.min(6, Math.round(d))), hidden: v.hidden === true });
  }
  return out;
}
export function cleanType(t: unknown): TypeCfg {
  const o = isObj(t) ? t : {};
  const out: TypeCfg = { offlineMinutes: minutes(o.offlineMinutes), status: cleanStatus(o.status), values: cleanValues(o.values) };
  if (ICON_IDS.includes(o.icon)) out.icon = o.icon;
  if (ACCENTS.includes(o.accent)) out.accent = o.accent;
  return out;
}
export const empty = (): Model => ({ v: 1, rev: 0, offlineMinutes: DEFAULT_OFFLINE_MIN, types: {} });
const CLEAN = new WeakSet<object>();
/** A clean model from the stored value (JSON text or object); anything else is the empty model. */
export function parse(raw: unknown): Model {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  const out = empty();
  CLEAN.add(out);
  if (!isObj(v)) return out;
  out.rev = num(v.rev) || 0;
  if (typeof v.by === 'string') out.by = v.by;
  if (num(v.at) !== null) out.at = num(v.at)!;
  out.offlineMinutes = minutes(v.offlineMinutes) || DEFAULT_OFFLINE_MIN;
  if (isObj(v.types)) for (const k of Object.keys(v.types)) { const name = k.trim(); if (name) out.types[name] = cleanType(v.types[k]); }
  return out;
}
const modelOf = (m: unknown): Model => (isObj(m) && CLEAN.has(m) ? (m as Model) : parse(m));
export function typeOf(model: unknown, type: string): TypeCfg & { saved: boolean; offlineMinutes: number } {
  const m = modelOf(model);
  const t = Object.prototype.hasOwnProperty.call(m.types, type) ? m.types[type] : null;
  const c = t ? (JSON.parse(JSON.stringify(t)) as TypeCfg) : cleanType(null);
  return { ...c, saved: !!t, offlineMinutes: c.offlineMinutes || m.offlineMinutes || DEFAULT_OFFLINE_MIN };
}
/** The type's look: its icon and accent, else the neutral machine icon (nothing is guessed from the name). */
export function look(model: unknown, type: string): { icon: string; accent: string } {
  const t = typeOf(model, type);
  return { icon: t.icon || 'machine', accent: t.accent || 'slate' };
}
export const offlineMs = (model: unknown, type: string) => typeOf(model, type).offlineMinutes * 60000;
/** The keys a page reads for the status: the type's tag or the automatic candidates, and the fallback key. */
export function statusKeys(model: unknown, type: string): string[] {
  const s = typeOf(model, type).status;
  const keys = s.key ? [s.key] : RUN_KEYS.slice();
  if (s.fallback && !keys.includes(s.fallback.key)) keys.push(s.fallback.key);
  return keys;
}

// ------------------------------------------------------------------------------------------------ status
function outcome(o: Outcome, raw: unknown) {
  const label = o.label || (o.state === 'unknown' && raw !== null && raw !== undefined && String(raw).trim() ? String(raw).trim() : stateLabel(o.state));
  return { state: o.state, label, tone: (o.tone || toneOf(o.state)) as Tone };
}
function asNumber(raw: unknown): number | null {
  if (raw === true) return 1;
  if (raw === false) return 0;
  const t = String(raw).trim().toLowerCase();
  if (t === 'true') return 1;
  if (t === 'false') return 0;
  return t === '' ? null : num(t);
}
function autoClass(raw: unknown) {
  const n = asNumber(raw);
  if (n !== null) return outcome({ state: n > 0 ? 'running' : 'stopped', label: '', tone: '' }, raw);
  const t = String(raw).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const g = AUTO.get(t);
  if (g) {
    const r = String(raw).trim();
    const label = g[2] === '*' ? r.charAt(0).toUpperCase() + r.slice(1).toLowerCase().replace(/_/g, ' ') : g[2];
    return outcome({ state: g[1], label, tone: g[3] }, raw);
  }
  return outcome({ state: 'unknown', label: '', tone: '' }, raw);
}
/** The mapping alone (the editor's preview): { state, label, tone }, or null for no value. */
export function classify(cfg: unknown, raw: unknown): { state: State; label: string; tone: Tone } | null {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
  const s = isObj(cfg) && MODES.includes(cfg.mode) && isArr(cfg.rules) && isObj(cfg.otherwise) ? (cfg as StatusCfg) : cleanStatus(cfg);
  if (s.mode === 'auto') return autoClass(raw);
  if (s.mode === 'numeric') {
    const n = asNumber(raw);
    if (n !== null) for (const r of s.rules) if ((r.from === null || r.from === undefined || n >= r.from) && (r.to === null || r.to === undefined || n <= r.to)) return outcome(r, raw);
    return outcome(s.otherwise, raw);
  }
  const t = String(raw).trim().toLowerCase();
  for (const r of s.rules) if (String(r.text).trim().toLowerCase() === t) return outcome(r, raw);
  return outcome(s.otherwise, raw);
}
function point(x: unknown): { ts: number; value: unknown } | null {
  if (x === null || x === undefined) return null;
  if (isArr(x)) {
    const p = x[0];
    if (isArr(p)) return { ts: Number(p[0]) || 0, value: p[1] };
    if (isObj(p)) return { ts: Number(p.ts) || 0, value: p.value };
    return null;
  }
  if (isObj(x)) return { ts: Number(x.ts) || 0, value: x.value };
  return { ts: 0, value: x };
}
const present = (p: { value: unknown } | null) => !!p && p.value !== '' && p.value !== null && p.value !== undefined;
/** ONE machine status: No data, else the type's status tag through its map, else the fallback, else "no status". */
export function status(model: unknown, type: string, latest: Latest | null | undefined, o: { now?: number; activity?: { last?: number; active?: boolean | string }; newest?: number; key?: string } = {}): Result {
  const lt: Record<string, unknown> = isObj(latest) ? latest : {};
  const t = typeOf(model, type);
  const s = t.status;
  const now = num(o.now) || Date.now();
  const act = isObj(o.activity) ? o.activity : {};
  let newest = Math.max(num(o.newest) || 0, num(act.last) || 0);
  for (const k of Object.keys(lt)) {
    if (DERIVED.test(k) || NOT_LIFE.test(k)) continue;
    const p = point(lt[k]);
    if (present(p) && p!.ts > newest) newest = p!.ts;
  }
  if (!(act.active === true || String(act.active) === 'true') && (!newest || now - newest > t.offlineMinutes * 60000)) {
    return { state: 'offline', label: stateLabel('offline'), tone: toneOf('offline'), raw: null, key: '', ts: 0, source: 'offline', newest };
  }
  const keys = o.key ? [o.key] : s.key ? [s.key] : RUN_KEYS;
  for (const k of keys) {
    const p = point(lt[k]);
    if (!present(p)) continue;
    const c = o.key && o.key !== s.key ? autoClass(p!.value) : classify(s, p!.value);
    if (c) return { ...c, raw: p!.value, key: k, ts: p!.ts, source: 'status', newest };
  }
  if (s.fallback && !o.key) {
    const f = point(lt[s.fallback.key]);
    const fv = present(f) ? asNumber(f!.value) : null;
    if (fv !== null) {
      const st: State = fv > s.fallback.above ? 'running' : 'stopped';
      return { state: st, label: stateLabel(st), tone: toneOf(st), raw: f!.value, key: s.fallback.key, ts: f!.ts, source: 'fallback', newest };
    }
  }
  const ns = outcome(s.noStatus, null);
  return { ...ns, raw: null, key: '', ts: 0, source: 'nostatus', newest };
}

// ------------------------------------------------------------------------------------------------ values
export function values(model: unknown, type: string): (ValueCfg & { order: number })[] {
  return typeOf(model, type).values.map((v, i) => ({ ...v, order: i }));
}
/** A value's name, unit and decimals: the model's for the type, field by field, else the caller's own (fb). */
export function value(model: unknown, type: string, key: string, fb?: { label?: string; displayName?: string; unit?: string; units?: string; decimals?: number | null } | string | null) {
  const k = String(key ?? '');
  const t = typeOf(model, type);
  const order = t.values.findIndex((v) => v.key === k);
  const own = order >= 0 ? t.values[order] : null;
  const f = typeof fb === 'string' ? splitLabel(fb) : isObj(fb) ? fb : {};
  const fbLabel = str((f as any).label || (f as any).displayName).trim();
  const fbUnit = str((f as any).unit != null ? (f as any).unit : (f as any).units).trim();
  const fbDec = num((f as any).decimals);
  return {
    key: k,
    label: own?.label || fbLabel || readable(k),
    unit: own?.unit || fbUnit,
    decimals: own && own.decimals !== null && own.decimals !== undefined ? own.decimals : fbDec === null ? null : Math.max(0, Math.min(6, Math.round(fbDec))),
    hidden: !!own?.hidden,
    order,
    source: own && (own.label || own.unit || own.decimals !== null || own.hidden) ? 'model' : fbLabel || fbUnit || fbDec !== null ? 'page' : 'key',
  };
}
/**
 * The catalogue of one machine type with the model laid over it (Pure): the model's display name, unit and decimals
 * win field by field, hidden keys are left out, and the model's order comes first.
 */
export function overlay(model: unknown, type: string, list: KeyMeta[]): KeyMeta[] {
  const t = typeOf(model, type);
  if (!t.values.length) return list;
  const rank = new Map(t.values.map((v, i) => [v.key, i]));
  const out = list
    .filter((k) => !value(model, type, k.key).hidden)
    .map((k) => {
      const v = value(model, type, k.key, { label: k.displayName, unit: k.unit, decimals: k.decimals });
      return { ...k, displayName: v.label, unit: v.unit, decimals: v.decimals ?? k.decimals };
    });
  return out.sort((a, b) => (rank.has(a.key) ? rank.get(a.key)! : 1e6) - (rank.has(b.key) ? rank.get(b.key)! : 1e6));
}

/** The Builder's colour of a status tone (render/theme.ts STATUS; blue for a custom "info" state). */
export const TONE_COLOR: Record<string, string> = { ok: '#0ca30c', warn: '#fab219', bad: '#d03b3b', off: '#8a8983', info: '#2563eb' };

// ------------------------------------------------------------------------------------------------ the page's copy
let current: Model = empty();
let at = 0;
let loading: Promise<Model> | null = null;
const CACHE = 'imx-machine-model';
const TTL = 60_000;
/** The model this page has: the app's page copy (window.imxMachine), else the last one read, else the browser cache. */
export function model(): Model {
  const w = typeof window !== 'undefined' ? (window as any) : null;
  if (w?.imxMachine?.current) { try { return parse(w.imxMachine.current()); } catch { /* the app's copy failed: ours */ } }
  if (!at && w) { try { const c = w.localStorage?.getItem(CACHE); if (c) current = parse(c); } catch { /* storage blocked */ } }
  return current;
}
/** Reads the stored model (at most once a minute; concurrent callers share the read). Never rejects. */
export function load(read: () => Promise<unknown>, force = false): Promise<Model> {
  if (!force && at && Date.now() - at < TTL) return Promise.resolve(model());
  if (loading) return loading;
  loading = read()
    .then((raw) => {
      current = parse(raw);
      at = Date.now();
      try { if (typeof window !== 'undefined') window.localStorage?.setItem(CACHE, JSON.stringify(current)); } catch { /* storage full */ }
      return current;
    })
    .catch(() => model())
    .finally(() => { loading = null; });
  return loading;
}
/** For tests: forget the page's copy. */
export function reset() { current = empty(); at = 0; loading = null; }
