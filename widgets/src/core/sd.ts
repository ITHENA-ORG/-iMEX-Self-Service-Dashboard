// core/sd.ts — D-092: the standard deviation ("Std. deviation") a Builder widget can show instead of an average.
//
// The platform cannot compute a standard deviation, so it is never asked for one (api.ts PLATFORM_AGGS refuses 'SD').
// It is the SAMPLE standard deviation of the readings, sqrt(m2 / (n - 1)) for n >= 2 (core/cube.ts cubeSd; App UI
// U-177 / U-178, Builder D-087):
//   - a window of 4 h or less: entirely from the raw readings (one platform read, agg NONE), bucketed by cubeRawBuckets;
//     no summary service needed;
//   - a longer window: the data summaries (fields n, avg, m2) for the whole level buckets they cover, the raw readings of
//     an uncovered head / tail of at most 4 h joined to them by Chan's merge (cubeCombine); an uncovered part longer than
//     4 h, a summary bucket without m2 (built before m2 was kept) or a raw read cut by its page limit has NO value: the
//     buckets it touches are left empty ("not available"), never a partial figure shown as the whole.
// Availability (sdWhy): the summaries not licensed (licence `dataCubes` false, or the service answered 403
// {error:'licence'} in the last 10 minutes) or the service off (no address) / paused (trouble < 60 s ago) -> "Needs data
// summaries"; good or not known yet -> offered (as the App UI Analyzer, U-178). The editor checks again as the list opens.
// Results are kept 55 s (a window ending now) or 5 min (a past window) per device, keys, step and window, so the
// redraws pushed values cause are not reads; nothing is appended live (the next read after that is exact again).
import * as api from './api';
import * as cube from './cube';
import { licHas } from './licence';

/** The stored aggregation code (WidgetSettings.agg). */
export const SD = 'SD' as const;
/** The editor's option text (the neighbouring options are lowercase: "avg", "min" ...). */
export const SD_OPTION = 'standard deviation';
/** The word in drawn output: card chip, legend, tooltip. */
export const SD_LABEL = 'Std. deviation';
/** Why the option is disabled. */
export const SD_NEEDS = 'Needs data summaries';
/** A widget showing the standard deviation while the summaries cannot be used. */
export const SD_NOTE_OFF = 'Standard deviation needs data summaries, which are not available right now.';
/** Part of the period has no standard deviation (a gap is left). */
export const SD_NOTE_PART = 'Standard deviation is not available for part of this period.';
/** None of the period has one although the summaries answered. */
export const SD_NOTE_NONE = 'Standard deviation is not available for this period.';
/** Widget types that offer the standard deviation (donut "share by machine" does not: a share of spreads means nothing). */
export const SD_TYPES: readonly string[] = ['line', 'area', 'bar', 'heatmap'];
/** The longest part read from raw readings. */
export const RAW_MAX_MS = 4 * 3600e3;
/** Page size of a raw read; a part with this many readings or more may be cut: no value then. */
export const RAW_LIMIT = 50000;
/** How long a licence refusal by the service counts (the licence changes rarely; a new licence is seen after it). */
const REFUSED_MS = 10 * 60e3;

type Pt = { ts: number; value: number };
export interface Range { from: number; to: number }
export type SdState = 'ok' | 'part' | 'none' | 'off';
export interface SdOut {
  /** key -> one point per bucket with a value (stamped in the bucket's middle), oldest first */
  points: Record<string, Pt[]>;
  /** key -> the buckets left empty because part of them has no standard deviation (merged ranges) */
  gaps: Record<string, Range[]>;
  /** ok: all of the window; part: some of it has none; none: nothing of it; off: the summaries are needed and cannot be used */
  state: SdState;
  /** the bucket length used (a window over 4 h: at least the summary level's bucket); with opts.auto a key's own may be longer */
  step: number;
}

const G = globalThis as unknown as { __imxSdRefused?: number };
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The service answered 403 {error: 'licence'}: the standard deviation is not available for a while (every widget copy). */
export function noteRefused(at = Date.now()) {
  try {
    G.__imxSdRefused = at;
  } catch {
    /* nothing kept */
  }
}
function refused(): boolean {
  const t = G.__imxSdRefused;
  return num(t) && Date.now() - t >= 0 && Date.now() - t < REFUSED_MS;
}
/** Tests: forget a refusal. */
export function sdReset() {
  try {
    delete G.__imxSdRefused;
  } catch {
    /* nothing kept */
  }
  cache.clear();
}

/** The data summaries are licensed: licence feature `dataCubes` (ON unless a licence says false) and no recent refusal. */
export function sdLicensed(): boolean {
  return licHas('dataCubes') && !refused();
}

/** Why the standard deviation cannot be chosen now ('' = it can): the pure rule. */
export function sdWhy(state: cube.CubeState, licensed: boolean): string {
  if (!licensed) return SD_NEEDS;
  return state === 'off' || state === 'paused' ? SD_NEEDS : '';
}

/** Why the standard deviation cannot be chosen now on this page ('' = it can), read fresh. */
export function sdAvailability(): string {
  return sdWhy(cube.cubeState(api.cubesAddress()), sdLicensed());
}

/** A widget's settings ask for the standard deviation (and its type offers it). */
export const isSd = (type: string, agg: unknown) => agg === SD && SD_TYPES.includes(type);

/**
 * The editor's Aggregation choices of a widget type: value, text, and for the standard deviation whether it is disabled
 * and why (`why` = sdAvailability()). Line / area: avg, min, max, standard deviation, Raw values; bar / heatmap: avg, min,
 * max, sum, standard deviation; donut "share by machine": avg, min, max, sum (no standard deviation).
 */
export function aggChoices(type: string, why: string): { v: string; l: string; disabled?: boolean; sub?: string }[] {
  const line = type === 'line' || type === 'area';
  const base = (line ? ['AVG', 'MIN', 'MAX'] : ['AVG', 'MIN', 'MAX', 'SUM']).map((a) => ({ v: a, l: a.toLowerCase() }));
  const out: { v: string; l: string; disabled?: boolean; sub?: string }[] = base;
  if (SD_TYPES.includes(type)) out.push(why ? { v: SD, l: SD_OPTION, disabled: true, sub: why } : { v: SD, l: SD_OPTION });
  if (line) out.push({ v: 'NONE', l: 'Raw values' });
  return out;
}

/**
 * Brings the standard deviation option of an Aggregation select up to date (the editor calls it as the list is about to
 * open: the summaries' state may have changed since the form was drawn, U-178's "fresh" rule). The kit's drop-down reads
 * `disabled` and `data-sub` (a muted second line) when it opens; `title` is the plain select's tooltip.
 */
export function sdFreshen(sel: { options: ArrayLike<{ value: string; disabled: boolean; title: string; setAttribute(k: string, v: string): void; removeAttribute(k: string): void }> } | null | undefined, why = sdAvailability()) {
  if (!sel) return;
  for (let i = 0; i < sel.options.length; i++) {
    const o = sel.options[i];
    if (o.value !== SD) continue;
    o.disabled = !!why;
    o.title = why;
    if (why) o.setAttribute('data-sub', why);
    else o.removeAttribute('data-sub');
  }
}

/** The bucket a line / area chart uses: about 120 points (each bucket then holds enough readings to say something). */
export function sdStep(startTs: number, endTs: number): number {
  return api.pickInterval(Math.max(1, endTs - startTs), 120);
}

// ---------------------------------------------------------------------------------------------- reads

const cache = new Map<string, { at: number; ttl: number; out: SdOut }>();
api.onClearCaches(() => cache.clear());

/** Raw readings of `keys` in [from, to): key -> { pts, full } (full false: the page limit may have cut the part). */
async function readRaw(deviceId: string, keys: string[], from: number, to: number): Promise<Record<string, { pts: cube.RawReading[]; full: boolean }>> {
  const r = await api.get<Record<string, { ts: number; value: unknown }[]>>(
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${encodeURIComponent(keys.join(','))}&startTs=${Math.floor(from)}&endTs=${Math.ceil(to)}&agg=NONE&orderBy=ASC&limit=${RAW_LIMIT}`,
  );
  const out: Record<string, { pts: cube.RawReading[]; full: boolean }> = {};
  for (const k of keys) {
    const a = Array.isArray(r?.[k]) ? r![k] : [];
    out[k] = { pts: a.filter((p) => p && num(p.ts) && p.ts >= from && p.ts < to), full: a.length < RAW_LIMIT };
  }
  return out;
}

/** The edges of [a, b) on the window's bucket grid start + i * step. */
function edgesIn(a: number, b: number, start: number, step: number): number[] {
  const e = [a];
  for (let t = start + (Math.floor((a - start) / step) + 1) * step; t < b; t += step) e.push(t);
  e.push(b);
  return e;
}

/** The fetch the summary call uses: notes a licence refusal (403 {error: 'licence'}); cube.ts reads no body but a 200's. */
async function watched(u: string, init: RequestInit): Promise<{ status: number; json(): Promise<unknown> }> {
  const r = await fetch(u, init);
  if (r && r.status === 403) {
    try {
      const b: any = await r.json();
      if (b && b.error === 'licence') noteRefused();
    } catch {
      /* not a licence answer */
    }
  }
  return r;
}

/**
 * The standard deviation of each key per bucket of `step` from `startTs` (see the file header).
 * @param opts.fixedStart the window grows from a fixed start (the current shift): cached by its start.
 * @param opts.auto each key gets the smallest ladder step (at least `step`) that holds about AUTO_READINGS of its readings
 *   (a line chart; sparse readings in short buckets would leave every bucket without a spread). Bars and heatmap cells
 *   keep the step they are given.
 */
export async function sdSeries(deviceId: string, keys: string[], startTs: number, endTs: number, step: number, opts: { fixedStart?: boolean; auto?: boolean } = {}): Promise<SdOut> {
  const span = endTs - startTs;
  const off = (): SdOut => ({ points: Object.fromEntries(keys.map((k) => [k, []])), gaps: Object.fromEntries(keys.map((k) => [k, [{ from: startTs, to: endTs }]])), state: 'off', step });
  if (!keys.length || !(span > 0)) return { points: {}, gaps: {}, state: 'ok', step };
  if (!sdLicensed()) return off();
  const now = Date.now();
  const offsetMin = Math.round((now - endTs) / 60e3);
  const at = (t: number) => Math.floor(t / 60e3);
  const win = offsetMin > 1 ? `${at(startTs)}-${at(endTs)}` : opts.fixedStart ? `@${at(startTs)}` : `${Math.round(span / 60e3)}|${offsetMin}`;
  const level = cube.cubeLevel(startTs, endTs);
  const ck = `${deviceId}|${keys.join(',')}|${step}${opts.auto ? 'a' : ''}|${win}|${level ? String(api.cubesAddress()) : ''}`;
  const hit = cache.get(ck);
  if (hit && now - hit.at < hit.ttl) return hit.out;
  const out = await read(deviceId, keys, startTs, endTs, step, level, !!opts.auto);
  if (out.state !== 'off') {
    cache.delete(ck);
    cache.set(ck, { at: now, ttl: offsetMin > 1 ? 5 * 60e3 : 55e3, out });
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  }
  return out;
}

/** The ladder api.pickInterval uses; an automatic bucket is one of its steps. */
const LADDER = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 7 * 86400e3];
/** About how many readings an automatic bucket holds. */
export const AUTO_READINGS = 8;
/** The smallest ladder step at least `base` that holds about AUTO_READINGS readings `every` ms apart. */
export function autoStep(base: number, every: number): number {
  const want = Math.max(base, AUTO_READINGS * every);
  return LADDER.find((s) => s >= want) ?? Math.max(want, LADDER[LADDER.length - 1]);
}

async function read(deviceId: string, keys: string[], startTs: number, endTs: number, step0: number, level: cube.CubeLevel | null, auto: boolean): Promise<SdOut> {
  const off = (): SdOut => ({ points: Object.fromEntries(keys.map((k) => [k, []])), gaps: Object.fromEntries(keys.map((k) => [k, [{ from: startTs, to: endTs }]])), state: 'off', step: step0 });
  // the parts: covered by the summaries [cA, cB), the rest raw (<= 4 h) or not available
  let step = Math.max(1, step0);
  let rows: Record<string, cube.CubeBucket[]> = {};
  let skipped = new Set<string>();
  let cA = startTs;
  let cB = startTs;
  if (level) {
    const L = cube.BUCKET_MS[level];
    step = Math.max(step, L);
    const base = api.cubesAddress();
    const st = cube.cubeState(base);
    const jwt = api.jwtOrNull();
    if (st === 'off' || st === 'paused' || !jwt) return off();
    const res = await cube.cubeSeries(base, jwt, deviceId, keys, startTs, endTs, level, ['n', 'avg', 'm2'], { fetch: watched });
    if (!res) return off();
    const cov = res.coverage;
    if (cov && num(cov.from) && num(cov.to) && cov.to > cov.from) {
      // the coverage lies on the level's grid (India hours are UTC :30); whole level buckets inside the window only
      const g = ((cov.from % L) + L) % L;
      const a = g + Math.ceil((Math.max(startTs, cov.from) - g) / L) * L;
      const b = g + Math.floor((Math.min(endTs, cov.to) - g) / L) * L;
      if (b > a) {
        cA = a;
        cB = b;
      }
    }
    skipped = new Set(Array.isArray(res.skipped) ? res.skipped : []);
    rows = res.series ?? {};
  }
  const parts: Range[] = cB > cA ? [{ from: startTs, to: cA }, { from: cB, to: endTs }].filter((p) => p.to > p.from) : [{ from: startTs, to: endTs }];
  const rawParts = parts.filter((p) => p.to - p.from <= RAW_MAX_MS);
  const naParts = parts.filter((p) => p.to - p.from > RAW_MAX_MS);
  const raws = await Promise.all(rawParts.map((p) => readRaw(deviceId, keys, p.from, p.to)));
  const out: SdOut = { points: {}, gaps: {}, state: 'ok', step };
  let anyNa = false;
  let allNa = true;
  for (const k of keys) {
    // auto: a bucket long enough to hold about AUTO_READINGS readings of this key (a spread of one reading is none)
    let step = out.step;
    if (auto && !skipped.has(k)) {
      let count = 0;
      for (const b of rows[k] ?? []) if (b && num(b.ts) && b.ts >= cA && b.ts < cB && num(b.n) && b.n > 0) count += b.n;
      rawParts.forEach((_, j) => (count += raws[j][k]?.pts.length ?? 0));
      if (count > 0) step = autoStep(out.step, (endTs - startTs) / count);
    }
    const n = Math.ceil((endTs - startTs) / step);
    const idx = (t: number) => Math.min(n - 1, Math.max(0, Math.floor((t - startTs) / step)));
    const groups = new Map<number, cube.CubeBucket[]>();
    const na = new Set<number>();
    // the true not-available parts of this key (the state), besides the empty buckets (the gaps)
    const naK: Range[] = skipped.has(k) ? [{ from: startTs, to: endTs }] : naParts.slice();
    const add = (i: number, b: cube.CubeBucket) => {
      const a = groups.get(i);
      if (a) a.push(b);
      else groups.set(i, [b]);
    };
    if (!skipped.has(k)) {
      for (const b of rows[k] ?? []) {
        if (!b || !num(b.ts) || b.ts < cA || b.ts >= cB || (num(b.n) && b.n <= 0)) continue;
        // a bucket built before the service kept m2: its readings have no spread to give
        if (!num(b.m2)) {
          na.add(idx(b.ts));
          naK.push({ from: b.ts, to: b.ts + (level ? cube.BUCKET_MS[level] : step) });
        }
        add(idx(b.ts), b);
      }
      rawParts.forEach((p, j) => {
        const r = raws[j][k];
        if (!r?.full) {
          naK.push(p);
          return;
        }
        for (const b of cube.cubeRawBuckets(r.pts, edgesIn(p.from, p.to, startTs, step))) add(idx(b.ts), b);
      });
    }
    for (const p of naK) for (let i = idx(p.from); i <= idx(p.to - 1); i++) na.add(i);
    const pts: Pt[] = [];
    for (const i of [...groups.keys()].sort((a, b) => a - b)) {
      if (na.has(i)) continue;
      const v = cube.cubeSd(cube.cubeCombine(groups.get(i)!));
      if (v !== null) pts.push({ ts: startTs + i * step + Math.floor(step / 2), value: v });
    }
    const gaps: Range[] = [];
    for (const i of [...na].sort((a, b) => a - b)) {
      const f = startTs + i * step;
      const t = Math.min(endTs, f + step);
      const last = gaps[gaps.length - 1];
      if (last && last.to >= f) last.to = Math.max(last.to, t);
      else gaps.push({ from: f, to: t });
    }
    out.points[k] = pts;
    out.gaps[k] = gaps;
    const covered = naK.length ? mergedLength(naK, startTs, endTs) : 0;
    if (covered > 0) anyNa = true;
    if (covered < endTs - startTs) allNa = false;
  }
  out.state = allNa ? 'none' : anyNa ? 'part' : 'ok';
  return out;
}

/** The length of the union of `rs` inside [a, b). */
function mergedLength(rs: Range[], a: number, b: number): number {
  const s = rs.map((r) => ({ from: Math.max(a, r.from), to: Math.min(b, r.to) })).filter((r) => r.to > r.from).sort((x, y) => x.from - y.from);
  let len = 0;
  let cur: Range | null = null;
  for (const r of s) {
    if (cur && r.from <= cur.to) cur.to = Math.max(cur.to, r.to);
    else {
      if (cur) len += cur.to - cur.from;
      cur = { ...r };
    }
  }
  if (cur) len += cur.to - cur.from;
  return len;
}

/**
 * The standard deviation of one key over the whole window (a bar per machine): a number only when ALL of the window
 * has one, else null with the state saying why ('part' / 'none' / 'off').
 */
export async function sdWindow(deviceId: string, key: string, startTs: number, endTs: number, opts: { fixedStart?: boolean } = {}): Promise<{ value: number | null; state: SdState }> {
  const r = await sdSeries(deviceId, [key], startTs, endTs, Math.max(1, endTs - startTs), opts);
  const p = r.points[key] ?? [];
  return { value: r.state === 'ok' && p.length ? p[0].value : null, state: r.state };
}

/** The note a widget shows under its drawing for the worst state of its reads ('' = none). */
export function sdNote(states: SdState[]): string {
  if (!states.length) return '';
  if (states.every((s) => s === 'off')) return SD_NOTE_OFF;
  if (states.every((s) => s === 'none')) return SD_NOTE_NONE;
  return states.some((s) => s !== 'ok') ? SD_NOTE_PART : '';
}
