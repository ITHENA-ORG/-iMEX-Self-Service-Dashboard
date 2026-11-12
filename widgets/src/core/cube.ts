// core/cube.ts — data summaries (internal name: data cubes): the shared rule and a small client of the summary service.
//
// The TypeScript copy of the App UI's window.imxCube (widgets/_shared/cube.js) and Reports' service/app/cube.py; the
// contract is the shared vectors widgets/test/cube-vectors.json (a byte-for-byte copy of the App UI's
// tests/cube-vectors.json). Spec: App UI docs/design/DATA_CUBES.md sections 3.3 and 4.
//
// Pure rule:
//   cubeLevel(from, to)        null (raw, exactly as today) when to - from <= 4 h (or the period is not valid); '5m' up
//                              to 2 days; '1h' up to 92 days; else '1d'. The bounds belong to the finer level.
//   cubeParts(from, to, level, coverage) -> [{ src: 'cube' | 'platform', from, to }] ordered, not overlapping, covering
//                              [from, to): the platform before the summaries start, the summaries, the platform after
//                              they end (the open tail); cut to [from, to); empty parts left out. coverage null / not
//                              valid / empty, or level null -> one platform part. from >= to -> [].
//   cubeInterval(level)        how a platform part is read "as today": { interval: 300000 | 3600000 | 86400000,
//                              intervalType: 'MILLISECONDS' } (null for raw). The platform (CE 4.3) has no DAY interval
//                              type; its buckets step from the part's start (a part starting at local midnight gives
//                              local days).
//   cubeCombine(pieces), cubeMerge(lists): the count-weighted merge (n and sum add, sum = avg * n for a piece without
//                              sum, avg = sum / n (else weighted by n, 1 without n), min / max, first of the earliest
//                              firstTs, last of the latest lastTs, inc adds, st adds per state; a field missing from
//                              one piece is missing from the result). cubeMerge: one list ordered by ts, the same ts
//                              combined in list order, n = 0 left out (a bucket without n is kept).
// Client (never rejects; null on any failure so the caller reads exactly as today):
//   cubeSeries(base, token, device, keys, from, to, level, fields, opts)       GET <base>/api/v1/series?...
//   cubeSeriesMany(base, token, devices, keys, from, to, level, fields, opts)  POST <base>/api/v1/series
//   base undefined = '/cubes-api' (same origin), '' / null = no service (no call). opts { timeoutMs (1500), fetch, now }.
//   After a timeout, a network error, a 404, a 5xx or an answer that is not a summary, calls to that base answer null at
//   once for 60 s; 400 / 401 / 403 do not pause.
// Shared state per base (D-084; App UI U-159): the last outcome { t, ok } is kept on the page (globalThis.__imxCubeState:
//   every widget type bundles its own copy of this module, and they all share it, with the App UI's window.imxCube too)
//   and in localStorage ('imxCube.state:' + base: every later page and tab; try/catch, the page alone without storage).
//   The newer of the two counts. cubeReset() forgets both (tests).
//   One call at a time while the state is not known (D-085; App UI U-160): a call to a base whose state is 'unknown' while
//   another call to it is in flight on the page (globalThis.__imxCubeFlight: every widget bundle's copy) waits for that
//   one's outcome: trouble -> null at once (the pause), a summary -> it is sent. A fresh dashboard of 6 charts with a
//   stopped service makes one failed call, not 6. Known good: calls go out together.
//   cubeState(base, opts) -> 'off' (no address) | 'paused' (trouble < 60 s ago) | 'good' (a summary < 5 min ago) | 'unknown'
//   cubeRace(base, askCube, readPlatform, opts) -> { src: 'cube' | 'platform', value }:
//     off / paused: readPlatform() alone; good: askCube() first, null -> readPlatform(); unknown: both at once, the
//     summaries win when they come before the platform's answer (or within opts.graceMs after it; GRACE_MS = 0: a stopped
//     service fails slowly, any grace would be paid by every such load), else the platform's (a later summary is dropped); askCube null / throwing -> the platform's; the platform failing -> the summaries when
//     they come, else its error. opts (tests): { now, storage (null = none), graceMs }.

export type CubeLevel = '5m' | '1h' | '1d';
export interface Coverage { from: number; to: number }
export interface CubePart { src: 'cube' | 'platform'; from: number; to: number }
export interface CubeBucket {
  ts: number;
  n?: number;
  sum?: number;
  avg?: number;
  min?: number;
  max?: number;
  first?: unknown;
  firstTs?: number;
  last?: unknown;
  lastTs?: number;
  inc?: number;
  st?: Record<string, number>;
  [k: string]: unknown;
}
export interface CubeSeries {
  v?: 1;
  device?: string;
  level: CubeLevel;
  zone?: string;
  coverage: Coverage | null;
  kinds?: Record<string, string>;
  series: Record<string, CubeBucket[]>;
  skipped?: string[];
}
export interface CubeMany { v: 1; level: CubeLevel; results: Record<string, CubeSeries> }
export interface CubeOpts {
  timeoutMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<{ status: number; json(): Promise<unknown> }>;
  now?: () => number;
  /** the shared state's storage (tests): null = none; default localStorage */
  storage?: CubeStorage | null;
  /** cubeRace: how long a finished platform read waits for the summaries (default GRACE_MS) */
  graceMs?: number;
}
export interface CubeStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem?(k: string): void;
  key?(i: number): string | null;
  readonly length?: number;
}
export type CubeState = 'off' | 'paused' | 'good' | 'unknown';

const H = 3600000;
const D = 86400000;
const RAW_MAX = 4 * H;
const M5_MAX = 2 * D;
const H1_MAX = 92 * D;
export const LEVELS: readonly CubeLevel[] = ['5m', '1h', '1d'];
export const BUCKET_MS: Record<CubeLevel, number> = { '5m': 300000, '1h': H, '1d': D };
export const DEFAULT_BASE = '/cubes-api';
export const TIMEOUT_MS = 1500;
export const PAUSE_MS = 60000;
export const GOOD_MS = 300000;
export const GRACE_MS = 0;
const STORE = 'imxCube.state:';
export const FIELDS = ['n', 'sum', 'avg', 'min', 'max', 'first', 'firstTs', 'last', 'lastTs', 'inc', 'st'] as const;

const num = (x: unknown): x is number => typeof x === 'number' && isFinite(x);
const isLevel = (x: unknown): x is CubeLevel => typeof x === 'string' && (LEVELS as readonly string[]).includes(x);
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);

// ------------------------------------------------------------------------------------------------ the rule
export function cubeLevel(from: unknown, to: unknown): CubeLevel | null {
  if (!num(from) || !num(to) || to <= from) return null;
  const span = to - from;
  if (span <= RAW_MAX) return null;
  if (span <= M5_MAX) return '5m';
  if (span <= H1_MAX) return '1h';
  return '1d';
}

function validCoverage(c: unknown): c is Coverage {
  return isObj(c) && num(c.from) && num(c.to) && c.to > c.from;
}

export function cubeParts(from: number, to: number, level: unknown, coverage: unknown): CubePart[] {
  if (!num(from) || !num(to) || to <= from) return [];
  if (!isLevel(level) || !validCoverage(coverage)) return [{ src: 'platform', from, to }];
  const out: CubePart[] = [];
  const headTo = Math.min(to, coverage.from);
  if (headTo > from) out.push({ src: 'platform', from, to: headTo });
  const a = Math.max(from, coverage.from);
  const b = Math.min(to, coverage.to);
  if (b > a) out.push({ src: 'cube', from: a, to: b });
  const tailFrom = Math.max(from, coverage.to);
  if (to > tailFrom) out.push({ src: 'platform', from: tailFrom, to });
  return out;
}

export function cubeInterval(level: unknown): { interval: number; intervalType: 'MILLISECONDS' } | null {
  if (!isLevel(level)) return null;
  return { interval: BUCKET_MS[level], intervalType: 'MILLISECONDS' };
}

// ------------------------------------------------------------------------------------------------ the merge
function pieceSum(p: CubeBucket): number | null {
  if (num(p.sum)) return p.sum;
  if (num(p.avg) && num(p.n)) return p.avg * p.n;
  return null;
}

export function cubeCombine(pieces: readonly CubeBucket[] | null | undefined): CubeBucket | null {
  const ps = (pieces || []).filter((p) => isObj(p) && !(num(p.n) && p.n <= 0));
  if (!ps.length) return null;
  const out: CubeBucket = { ts: ps[0].ts };
  if (ps.every((p) => num(p.n))) {
    let n = 0;
    for (const p of ps) n += p.n as number;
    out.n = n;
  }
  const sums = ps.every((p) => pieceSum(p) !== null);
  if (sums) {
    let s = 0;
    for (const p of ps) s += pieceSum(p) as number;
    out.sum = s;
  }
  if (ps.every((p) => num(p.avg) || (num(p.sum) && num(p.n)))) {
    if (sums && num(out.n)) out.avg = (out.sum as number) / out.n;
    else {
      let w = 0;
      let acc = 0;
      for (const p of ps) {
        const wj = num(p.n) ? p.n : 1;
        const aj = num(p.avg) ? p.avg : (p.sum as number) / (p.n as number);
        w += wj;
        acc += aj * wj;
      }
      out.avg = acc / w;
    }
  }
  if (ps.every((p) => num(p.min))) {
    let m = ps[0].min as number;
    for (const p of ps) if ((p.min as number) < m) m = p.min as number;
    out.min = m;
  }
  if (ps.every((p) => num(p.max))) {
    let m = ps[0].max as number;
    for (const p of ps) if ((p.max as number) > m) m = p.max as number;
    out.max = m;
  }
  if (ps.every((p) => p.first !== undefined && p.first !== null && num(p.firstTs))) {
    let f = ps[0];
    for (const p of ps.slice(1)) if ((p.firstTs as number) < (f.firstTs as number)) f = p;
    out.first = f.first;
    out.firstTs = f.firstTs;
  }
  if (ps.every((p) => p.last !== undefined && p.last !== null && num(p.lastTs))) {
    let l = ps[0];
    for (const p of ps.slice(1)) if ((p.lastTs as number) >= (l.lastTs as number)) l = p;
    out.last = l.last;
    out.lastTs = l.lastTs;
  }
  if (ps.every((p) => num(p.inc))) {
    let inc = 0;
    for (const p of ps) inc += p.inc as number;
    out.inc = inc;
  }
  if (ps.every((p) => isObj(p.st))) {
    const st: Record<string, number> = {};
    for (const p of ps) {
      for (const [k, v] of Object.entries(p.st as Record<string, unknown>)) if (num(v)) st[k] = (st[k] || 0) + v;
    }
    out.st = st;
  }
  return out;
}

function copy(b: CubeBucket): CubeBucket {
  const o: CubeBucket = { ...b };
  if (isObj(b.st)) o.st = { ...b.st };
  return o;
}

export function cubeMerge(lists: readonly (readonly CubeBucket[] | null | undefined)[] | null | undefined): CubeBucket[] {
  const rows: { b: CubeBucket; i: number }[] = [];
  let seq = 0;
  for (const list of lists || []) {
    for (const b of list || []) {
      if (!isObj(b) || !num(b.ts)) continue;
      if (num(b.n) && b.n <= 0) continue;
      rows.push({ b, i: seq++ });
    }
  }
  rows.sort((x, y) => x.b.ts - y.b.ts || x.i - y.i);
  const out: CubeBucket[] = [];
  for (let r = 0; r < rows.length; ) {
    let s = r + 1;
    while (s < rows.length && rows[s].b.ts === rows[r].b.ts) s++;
    const group = rows.slice(r, s).map((x) => x.b);
    const c = group.length === 1 ? copy(group[0]) : cubeCombine(group);
    if (c) out.push(c);
    r = s;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the client
type Rec = { t: number; ok: boolean };
const G = globalThis as unknown as {
  __imxCubeState?: Record<string, Rec>;
  __imxCubeFlight?: Record<string, Promise<unknown>>;
  localStorage?: CubeStorage;
};

function pageMap(): Record<string, Rec> {
  let m = G.__imxCubeState;
  if (!m || typeof m !== 'object') {
    m = {};
    G.__imxCubeState = m;
  }
  return m;
}
function storeOf(opts?: CubeOpts): CubeStorage | null {
  if (opts && opts.storage !== undefined) return opts.storage;
  try {
    return G.localStorage || null;
  } catch {
    return null;
  }
}
const okRec = (r: unknown): r is Rec => isObj(r) && num(r.t) && typeof r.ok === 'boolean';
function recOf(b: string, opts?: CubeOpts): Rec | null {
  let a: unknown = null;
  let s: unknown = null;
  try { a = pageMap()[b]; } catch { a = null; }
  try {
    const st = storeOf(opts);
    const raw = st ? st.getItem(STORE + b) : null;
    s = raw ? JSON.parse(raw) : null;
  } catch { s = null; }
  const pa = okRec(a) ? a : null;
  const ps = okRec(s) ? s : null;
  if (pa && ps) return ps.t > pa.t ? ps : pa;
  return pa || ps;
}
function note(b: string, ok: boolean, opts?: CubeOpts): void {
  const r: Rec = { t: nowOf(opts), ok };
  try { pageMap()[b] = r; } catch { /* the page keeps nothing */ }
  try { storeOf(opts)?.setItem(STORE + b, JSON.stringify(r)); } catch { /* storage full or blocked */ }
}
function stateOf(b: string, opts?: CubeOpts): CubeState {
  if (!b) return 'off';
  const r = recOf(b, opts);
  if (!r) return 'unknown';
  const age = nowOf(opts) - r.t;
  if (age < 0) return 'unknown';
  if (!r.ok && age < PAUSE_MS) return 'paused';
  if (r.ok && age < GOOD_MS) return 'good';
  return 'unknown';
}

/** The shared state of the service at `base` (see the header). */
export function cubeState(base: string | null | undefined, opts?: CubeOpts): CubeState {
  return stateOf(baseOf(base), opts);
}

/** Forgets the shared state: the page's and the stored one (tests). */
export function cubeReset(opts?: CubeOpts): void {
  try {
    G.__imxCubeState = {};
    G.__imxCubeFlight = {};
  } catch { /* nothing kept */ }
  try {
    const st = storeOf(opts);
    if (st && num(st.length) && typeof st.key === 'function' && typeof st.removeItem === 'function') {
      const gone: string[] = [];
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (typeof k === 'string' && k.startsWith(STORE)) gone.push(k);
      }
      for (const k of gone) st.removeItem(k);
    }
  } catch { /* storage blocked */ }
}

/** One call to a base at a time while its state is not known (see the header); go() sends the call (never rejects). */
function gated<T>(b: string, opts: CubeOpts | undefined, go: () => Promise<T | null>): Promise<T | null> {
  if (stateOf(b, opts) !== 'unknown') return go();
  let m: Record<string, Promise<unknown>>;
  try {
    m = G.__imxCubeFlight && typeof G.__imxCubeFlight === 'object' ? G.__imxCubeFlight : (G.__imxCubeFlight = {});
  } catch {
    return go();
  }
  const cur = m[b];
  if (cur && typeof cur.then === 'function') {
    const again = (): Promise<T | null> | null => (isPaused(b, opts) ? null : gated(b, opts, go));
    return cur.then(again, again);
  }
  const done = (r: T | null): T | null => {
    if (m[b] === p) delete m[b];
    return r;
  };
  const p: Promise<T | null> = Promise.resolve().then(go).then(done, () => done(null));
  m[b] = p;
  return p;
}

/**
 * How a reader uses the service without ever waiting for a stopped one (see the header). `askCube` resolves the reader's
 * whole result from the summaries (null = none); `readPlatform` today's read.
 */
export function cubeRace<C, P>(base: string | null | undefined, askCube: () => Promise<C | null> | C | null,
  readPlatform: () => Promise<P> | P, opts?: CubeOpts): Promise<{ src: 'cube'; value: C } | { src: 'platform'; value: P }> {
  type Out = { src: 'cube'; value: C } | { src: 'platform'; value: P };
  const state = stateOf(baseOf(base), opts);
  const ask = (): Promise<C | null> => {
    try {
      return Promise.resolve(askCube()).then((v) => (v === undefined || v === null ? null : v), () => null);
    } catch {
      return Promise.resolve(null);
    }
  };
  const read = (): Promise<P> => {
    try {
      return Promise.resolve(readPlatform());
    } catch (e) {
      return Promise.reject(e);
    }
  };
  const platform = (v: P): Out => ({ src: 'platform', value: v });
  if (state === 'off' || state === 'paused') return read().then(platform);
  if (state === 'good') return ask().then((v) => (v !== null ? { src: 'cube' as const, value: v } : read().then(platform)));
  const grace = opts && num(opts.graceMs) && opts.graceMs >= 0 ? opts.graceMs : GRACE_MS;
  return new Promise<Out>((resolve, reject) => {
    let done = false;
    let cube: { v: C | null } | null = null;
    let pf: { ok: true; v: P } | { ok: false; e: unknown } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const end = (r: Out) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const fail = (e: unknown) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      reject(e);
    };
    const decide = () => {
      if (done) return;
      if (cube && cube.v !== null) return end({ src: 'cube', value: cube.v });
      if (!pf) return;
      if (!pf.ok) {
        if (cube) fail(pf.e); // the platform failed: wait for the summaries
        return;
      }
      const v = pf.v;
      if (cube || grace <= 0) return end(platform(v));
      if (!timer) timer = setTimeout(() => end(platform(v)), grace);
    };
    ask().then((v) => { cube = { v }; decide(); });
    read().then((v) => { pf = { ok: true, v }; decide(); }, (e) => { pf = { ok: false, e }; decide(); });
  });
}

function baseOf(base: string | null | undefined): string {
  if (base === undefined) base = DEFAULT_BASE;
  if (base === null) return '';
  return String(base).trim().replace(/\/+$/, '');
}

function list(xs: unknown): string[] {
  const src: unknown[] = typeof xs === 'string' ? xs.split(',') : Array.isArray(xs) ? xs : [];
  const out: string[] = [];
  for (const x of src) {
    const k = x === null || x === undefined ? '' : String(x).trim();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

function fieldList(fields: unknown): string[] {
  return list(fields).filter((f) => (FIELDS as readonly string[]).includes(f));
}

export function cubeUrl(base: string | null | undefined, device: string, keys: string[] | string, from: number, to: number, level: CubeLevel, fields?: string[] | string | null): string {
  const b = baseOf(base);
  let q = `device=${encodeURIComponent(String(device))}&keys=${list(keys).map((k) => encodeURIComponent(k)).join(',')}` +
    `&from=${Math.floor(from)}&to=${Math.floor(to)}&level=${level}`;
  const fs = fieldList(fields);
  if (fs.length) q += `&fields=${fs.join(',')}`;
  return `${b}/api/v1/series?${q}`;
}

const nowOf = (opts?: CubeOpts) => (opts && typeof opts.now === 'function' ? opts.now() : Date.now());
const isPaused = (b: string, opts?: CubeOpts) => stateOf(b, opts) === 'paused';
const pause = (b: string, opts?: CubeOpts) => note(b, false, opts);

function okOne(body: unknown, level: CubeLevel): boolean {
  if (!isObj(body)) return false;
  const cov = body.coverage === undefined ? null : body.coverage;
  if (cov !== null && !validCoverage(cov)) return false;
  return body.level === level && isObj(body.series);
}

type Sent = { status?: number; body?: unknown; fail?: 'timeout' | 'network' | 'json' };

function send(url: string, init: RequestInit, opts?: CubeOpts): Promise<Sent> {
  const f = (opts && opts.fetch) || (typeof fetch === 'function' ? (u: string, i: RequestInit) => fetch(u, i) : null);
  const ms = opts && num(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : TIMEOUT_MS;
  if (!f) return Promise.resolve({ fail: 'network' });
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  if (ctl) init.signal = ctl.signal;
  return new Promise<Sent>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { ctl?.abort(); } catch { /* nothing to stop */ }
      resolve({ fail: 'timeout' });
    }, ms);
    const finish = (r: Sent) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let p: Promise<{ status: number; json(): Promise<unknown> }>;
    try { p = Promise.resolve(f(url, init)); } catch { finish({ fail: 'network' }); return; }
    p.then((res) => {
      if (done) return;
      const status = res && res.status;
      if (status !== 200) { finish({ status }); return; }
      Promise.resolve().then(() => res.json()).then(
        (body) => finish({ status, body }),
        () => finish({ fail: 'json' }));
    }, () => finish({ fail: 'network' }));
  });
}

function settle<T>(r: Sent, b: string, opts: CubeOpts | undefined, ok: (x: unknown) => boolean): T | null {
  if (r.fail || !num(r.status) || r.status === 404 || r.status >= 500) { pause(b, opts); return null; }
  if (r.status !== 200) return null;
  if (!ok(r.body)) { pause(b, opts); return null; }
  note(b, true, opts);
  return r.body as T;
}

function headers(token: string | null | undefined): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (token) h['X-Authorization'] = `Bearer ${token}`;
  return h;
}

export async function cubeSeries(base: string | null | undefined, token: string | null | undefined, device: string,
  keys: string[] | string, from: number, to: number, level: CubeLevel | null, fields?: string[] | string | null,
  opts?: CubeOpts): Promise<CubeSeries | null> {
  try {
    const b = baseOf(base);
    if (!b || !isLevel(level) || !device || !list(keys).length || !num(from) || !num(to) || to <= from) return null;
    if (isPaused(b, opts)) return null;
    const url = cubeUrl(b, device, keys, from, to, level, fields);
    return await gated(b, opts, async () => {
      const r = await send(url, { method: 'GET', headers: headers(token) }, opts);
      return settle<CubeSeries>(r, b, opts, (x) => isObj(x) && x.v === 1 && okOne(x, level));
    });
  } catch {
    return null;
  }
}

export async function cubeSeriesMany(base: string | null | undefined, token: string | null | undefined, devices: string[],
  keys: string[] | string, from: number, to: number, level: CubeLevel | null, fields?: string[] | string | null,
  opts?: CubeOpts): Promise<CubeMany | null> {
  try {
    const b = baseOf(base);
    const ds = list(devices);
    const ks = list(keys);
    if (!b || !isLevel(level) || !ds.length || !ks.length || !num(from) || !num(to) || to <= from) return null;
    if (isPaused(b, opts)) return null;
    const body: Record<string, unknown> = { devices: ds, keys: ks, from: Math.floor(from), to: Math.floor(to), level };
    const fs = fieldList(fields);
    if (fs.length) body.fields = fs;
    const h = headers(token);
    h['Content-Type'] = 'application/json';
    return await gated(b, opts, async () => {
      const r = await send(`${b}/api/v1/series`, { method: 'POST', headers: h, body: JSON.stringify(body) }, opts);
      return settle<CubeMany>(r, b, opts, (x) => isObj(x) && x.v === 1 && x.level === level && isObj(x.results) &&
        Object.values(x.results).every((v) => okOne(v, level)));
    });
  } catch {
    return null;
  }
}
