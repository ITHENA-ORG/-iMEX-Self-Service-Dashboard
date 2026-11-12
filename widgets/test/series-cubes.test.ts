// D-083: core/api.ts series() reads the built part of a long window from the data summaries service (data cubes) and the
// rest from the platform as before; any trouble with the service = exactly the old read. The summaries here are made
// by a fake service from the same raw readings the fake platform aggregates, so "summaries + rest" must equal the
// platform's own aggregation of the whole window (count-weighted averages, sums, counts, min / max).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeTB } from './fake-tb';
import * as api from '../src/core/api';
import * as cube from '../src/core/cube';

const H = 3600e3;
const D = 86400e3;
const IST = 5.5 * H;
const DEV = 'd0000000-0000-4000-8000-0000000000aa';
// a time on the India hour grid (UTC :30): 12 Nov 2026 12:00 India time
const END = Date.UTC(2026, 10, 12, 6, 30);

let tb: FakeTB;
let cubeLog: string[];
let cubeAnswer: (u: URL) => { status: number; body?: any } | 'network' | Promise<{ status: number; body?: any } | 'network'>;
const mem = new Map<string, string>();

/** Raw readings: every 10 min (+7 s, off every grid), with gaps and a denser stretch so counts differ per bucket. */
function raw(from: number, to: number) {
  const pts: { ts: number; value: number }[] = [];
  let i = 0;
  for (let t = from + 7000; t < to; t += 600e3, i++) {
    if (i % 17 < 3) continue;
    pts.push({ ts: t, value: +(50 + 30 * Math.sin(i / 7) + (i % 13)).toFixed(2) });
    if (i % 29 < 6) pts.push({ ts: t + 120e3, value: +(20 + (i % 11) * 3).toFixed(2) });
  }
  return pts;
}

/** Fake summary service: buckets on the India grid built from the fake platform's raw readings. */
function fakeCubes(cov: { from: number; to: number } | null, opts: { skipped?: string[] } = {}) {
  return (u: URL) => {
    const level = u.searchParams.get('level') as '5m' | '1h' | '1d';
    const size = level === '5m' ? 300e3 : level === '1h' ? H : D;
    const off = level === '5m' ? 0 : level === '1h' ? H - (IST % H) : D - IST;
    const from = Number(u.searchParams.get('from'));
    const to = Number(u.searchParams.get('to'));
    const keys = u.searchParams.get('keys')!.split(',');
    const fields = (u.searchParams.get('fields') ?? 'avg,min,max,n').split(',');
    const skipped = keys.filter((k) => opts.skipped?.includes(k));
    const series: Record<string, any[]> = {};
    for (const k of keys.filter((x) => !skipped.includes(x))) {
      series[k] = [];
      if (!cov) continue;
      const lo = Math.max(from, cov.from);
      const hi = Math.min(to, cov.to);
      const b = new Map<number, number[]>();
      for (const p of tb.telemetry.get(DEV)?.[k] ?? []) {
        const s = Math.floor((p.ts - off) / size) * size + off;
        if (s < cov.from || s + size > cov.to) continue;
        b.set(s, [...(b.get(s) ?? []), Number(p.value)]);
      }
      for (const [s, v] of [...b.entries()].sort((x, y) => x[0] - y[0])) {
        if (s < lo || s >= hi) continue;
        const sum = v.reduce((a, c) => a + c, 0);
        const all: Record<string, number> = { n: v.length, sum, avg: sum / v.length, min: Math.min(...v), max: Math.max(...v) };
        const row: any = { ts: s };
        for (const f of fields) if (f in all) row[f] = all[f];
        series[k].push(row);
      }
    }
    return { status: 200, body: { v: 1, device: DEV, level, zone: 'Asia/Kolkata', coverage: cov, kinds: Object.fromEntries(Object.keys(series).map((k) => [k, 'measurement'])), series, skipped } };
  };
}

const platformReads = () => tb.urls.filter((x) => x.includes('/values/timeseries'));

beforeEach(() => {
  tb = new FakeTB();
  tb.telemetry.set(DEV, { temp: raw(END - 40 * D, END), flow: raw(END - 40 * D, END).map((p) => ({ ts: p.ts, value: p.value * 2 - 7 })) });
  mem.clear();
  mem.set('jwt_token', 'x');
  cubeLog = [];
  cubeAnswer = fakeCubes(null);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
  vi.stubGlobal('fetch', async (url: string, init: any = {}) => {
    const u = new URL(url, 'http://tb');
    if (u.pathname.endsWith('/api/v1/series')) {
      cubeLog.push(`${u.origin === 'http://tb' ? '' : u.origin}${u.pathname}${u.search}`);
      expect(init.headers?.['X-Authorization']).toBe('Bearer x');
      const a = await cubeAnswer(u);
      if (a === 'network') throw new TypeError('Failed to fetch');
      return { status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body) } as any;
    }
    return tb.fetch(url, init);
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(END);
  api.setCubesBase(undefined);
  api.clearCaches();
  // D-084: the D-083 flow (summaries first) is the one for a service known good; the race when it is not known is
  // checked on its own below
  cube.cubeReset();
  known('/cubes-api');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The service at `base` answered a summary just now (on this page or an earlier one): known good. */
function known(base: string) {
  (globalThis as any).__imxCubeState = { ...((globalThis as any).__imxCubeState ?? {}), [base]: { t: Date.now(), ok: true } };
}

/** The old read of the same window: no service address. */
async function oldRead(keys: string[], from: number, to: number, agg: api.Agg, maxPoints: number) {
  api.setCubesBase(null);
  api.clearCaches();
  const before = tb.urls.length;
  const r = await api.series(DEV, keys, from, to, agg, maxPoints);
  api.setCubesBase(undefined);
  api.clearCaches();
  return { r, urls: tb.urls.slice(before) };
}

describe('series() and data summaries: which source', () => {
  it('a window of 4 h or less never asks the service and reads exactly as before', async () => {
    cubeAnswer = fakeCubes({ from: END - 10 * D, to: END - H });
    const r = await api.series(DEV, ['temp'], END - 4 * H, END, 'AVG', 500);
    expect(cubeLog).toEqual([]);
    const old = await oldRead(['temp'], END - 4 * H, END, 'AVG', 500);
    expect(platformReads()[0]).toBe(old.urls[0]);
    expect(r).toEqual(old.r);
  });

  it('raw values (agg NONE over a short window) never ask the service', async () => {
    cubeAnswer = fakeCubes({ from: END - 10 * D, to: END - H });
    await api.series(DEV, ['temp'], END - 5 * H, END, 'NONE', 5000);
    expect(cubeLog).toEqual([]);
    expect(platformReads()[0]).toContain('agg=NONE');
  });

  it('7 days, all built but the open tail: the service plus one small platform read of the tail', async () => {
    const cov = { from: END - 20 * D, to: END - H };
    cubeAnswer = fakeCubes(cov);
    const r = await api.series(DEV, ['temp', 'flow'], END - 7 * D, END, 'AVG', 500);
    expect(cubeLog.length).toBe(1);
    expect(cubeLog[0]).toMatch(/^\/cubes-api\/api\/v1\/series\?device=.*&keys=temp,flow&from=\d+&to=\d+&level=1h&fields=avg,n$/);
    const reads = platformReads();
    expect(reads.length).toBe(1);
    expect(reads[0]).toContain(`startTs=${cov.to}&endTs=${END}`);
    expect(reads[0]).toContain('interval=3600000');
    // hour buckets: 7 x 24 points, stamped at the middle of each hour
    expect(r.temp.length).toBe(168);
    expect(r.temp[0].ts).toBe(END - 7 * D + H / 2);
    // equal to the platform's own hourly averages
    api.setCubesBase(null);
    api.clearCaches();
    const q = await tb.fetch(`/api/plugins/telemetry/DEVICE/${DEV}/values/timeseries?keys=temp&startTs=${END - 7 * D}&endTs=${END}&agg=AVG&interval=${H}&limit=2000&orderBy=ASC`);
    const want = (JSON.parse(await (q as any).text()).temp as { ts: number; value: string }[]).map((p) => ({ ts: p.ts, value: Number(p.value) }));
    expect(r.temp.map((p) => p.ts)).toEqual(want.map((p) => p.ts));
    r.temp.forEach((p, i) => expect(p.value).toBeCloseTo(want[i].value, 3));
  });

  for (const agg of ['AVG', 'MIN', 'MAX', 'SUM', 'COUNT'] as const) {
    it(`30 days, ${agg}: summaries + the platform's head and tail equal the platform's aggregation of the whole window`, async () => {
      // built from 5 days 3 h after the start (not on a 6 h window bucket) to 2 h before the end: the head runs to the
      // next 6 h boundary, the tail from the 6 h boundary before the summaries end, both in today's 6 h buckets
      const from = END - 30 * D;
      cubeAnswer = fakeCubes({ from: from + 5 * D + 3 * H, to: END - 2 * H });
      const got = await api.series(DEV, ['temp', 'flow'], from, END, agg, 120);
      expect(cubeLog.length).toBe(1);
      const reads = platformReads();
      expect(reads.length).toBe(2);
      expect(reads.some((x) => x.includes(`startTs=${from}&endTs=${from + 5 * D + 6 * H}`) && x.includes(`agg=${agg}&interval=${6 * H}`))).toBe(true);
      expect(reads.some((x) => x.includes(`startTs=${END - 6 * H}&endTs=${END}`) && x.includes(`agg=${agg}&interval=${6 * H}`))).toBe(true);
      expect(reads.some((x) => x.includes(`startTs=${from}&endTs=${END}`))).toBe(false);
      const old = await oldRead(['temp', 'flow'], from, END, agg, 120);
      for (const k of ['temp', 'flow']) {
        expect(got[k].map((p) => p.ts)).toEqual(old.r[k].map((p) => p.ts));
        got[k].forEach((p, i) => expect(p.value).toBeCloseTo(old.r[k][i].value, 2));
      }
    });
  }

  it('a window that does not start on the hour grid: no more points than asked, all inside the window', async () => {
    const from = END - 30 * D + 17 * 60e3 + 4000;
    cubeAnswer = fakeCubes({ from: END - 25 * D, to: END - H });
    const r = await api.series(DEV, ['temp'], from, END, 'AVG', 120);
    expect(r.temp.length).toBeGreaterThan(100);
    expect(r.temp.length).toBeLessThanOrEqual(120);
    expect(r.temp.every((p) => p.ts >= from && p.ts < END)).toBe(true);
    const old = await oldRead(['temp'], from, END, 'AVG', 120);
    // within a few units of the old read (an hour bucket lands in the 6 h bucket where it starts)
    const byTs = new Map(old.r.temp.map((p) => [p.ts, p.value]));
    const diffs = r.temp.filter((p) => byTs.has(p.ts)).map((p) => Math.abs(p.value - byTs.get(p.ts)!));
    expect(diffs.length).toBeGreaterThan(100);
    expect(diffs.reduce((a, b) => a + b, 0) / diffs.length).toBeLessThan(3);
  });

  it('keys the service does not summarise are read as before, next to the summaries', async () => {
    cubeAnswer = fakeCubes({ from: END - 20 * D, to: END - H }, { skipped: ['flow'] });
    const r = await api.series(DEV, ['temp', 'flow'], END - 7 * D, END, 'AVG', 500);
    const reads = platformReads();
    expect(reads.some((x) => x.includes('keys=flow&') && x.includes(`startTs=${END - 7 * D}&endTs=${END}`) && x.includes(`interval=${30 * 60e3}`))).toBe(true);
    const old = await oldRead(['flow'], END - 7 * D, END, 'AVG', 500);
    expect(r.flow).toEqual(old.r.flow);
    expect(r.temp.length).toBe(168);
  });
});

describe('series() and data summaries: any trouble = the old read', () => {
  const cases: [string, () => typeof cubeAnswer][] = [
    ['service not there (404)', () => () => ({ status: 404, body: { detail: 'Not Found' } })],
    ['service failing (500)', () => () => ({ status: 500, body: {} })],
    ['network error', () => () => 'network'],
    ['an answer that is not a summary (the app page)', () => () => ({ status: 200, body: '<html>' })],
    ['no rights (403)', () => () => ({ status: 403, body: { error: 'access' } })],
    ['too many buckets (400)', () => () => ({ status: 400, body: { error: 'too_many' } })],
    ['nothing built yet (coverage null)', () => fakeCubes(null)],
    ['built only outside the window', () => fakeCubes({ from: END - 60 * D, to: END - 40 * D })],
    ['built for less than one whole window bucket', () => fakeCubes({ from: END - 3 * D - 20 * 60e3, to: END - 3 * D + 50 * 60e3 })],
  ];
  for (const [name, make] of cases) {
    it(name, async () => {
      cubeAnswer = make();
      const r = await api.series(DEV, ['temp'], END - 7 * D, END, 'AVG', 500);
      expect(cubeLog.length).toBe(1);
      const reads = platformReads();
      const old = await oldRead(['temp'], END - 7 * D, END, 'AVG', 500);
      expect(reads).toEqual(old.urls);
      expect(r).toEqual(old.r);
    });
  }

  it('after the service failed, the next charts do not ask it again for 60 s', async () => {
    cubeAnswer = () => ({ status: 503, body: {} });
    await api.series(DEV, ['temp'], END - 7 * D, END, 'AVG', 500);
    await api.series(DEV, ['flow'], END - 7 * D, END, 'AVG', 500);
    await api.series(DEV, ['temp'], END - 2 * D, END, 'MAX', 500);
    expect(cubeLog.length).toBe(1);
    vi.setSystemTime(END + 61e3);
    cubeAnswer = fakeCubes({ from: END - 20 * D, to: END - H });
    await api.series(DEV, ['temp'], END - 7 * D + 61e3, END + 61e3, 'AVG', 500);
    expect(cubeLog.length).toBe(2);
  });

  it('a platform read of the rest that fails falls back to the old read', async () => {
    cubeAnswer = fakeCubes({ from: END - 20 * D, to: END - H });
    tb.failNext = { match: /values\/timeseries$/, status: 400 };
    const r = await api.series(DEV, ['temp'], END - 7 * D, END, 'AVG', 500);
    const old = await oldRead(['temp'], END - 7 * D, END, 'AVG', 500);
    expect(r).toEqual(old.r);
  });

  it('no service address (setting blank) = no call; the setting comes from the widget settings', async () => {
    cubeAnswer = fakeCubes({ from: END - 20 * D, to: END - H });
    api.bindWidgetContext({ settings: { cubesServiceUrl: '' } });
    await api.series(DEV, ['temp'], END - 7 * D, END, 'AVG', 500);
    expect(cubeLog).toEqual([]);
    api.bindWidgetContext({ settings: { cubesServiceUrl: 'http://localhost:8092/' } });
    await api.series(DEV, ['flow'], END - 7 * D, END, 'AVG', 500);
    expect(cubeLog[0]).toMatch(/^http:\/\/localhost:8092\/api\/v1\/series\?/);
    // a widget whose settings do not name it leaves the address alone
    api.bindWidgetContext({ settings: { refreshSeconds: 10 } });
    await api.series(DEV, ['temp'], END - 2 * D, END, 'MIN', 500);
    expect(cubeLog[1]).toMatch(/^http:\/\/localhost:8092\//);
  });
});

describe('series() and data summaries: cache + live append (D-021) unchanged', () => {
  it('a window ending now is read once, then extended with pushed points without another read', async () => {
    cubeAnswer = fakeCubes({ from: END - 20 * D, to: END - H });
    const pushed = [{ ts: END + 5e3, value: 71 }, { ts: END + 15e3, value: 72 }];
    const hub = {
      want() {},
      isLive: () => true,
      liveSince: () => END - 60e3,
      since: (_d: string, _k: string, after: number) => pushed.filter((p) => p.ts > after),
    };
    vi.stubGlobal('window', { WebSocket: function () {}, __imexDbbLive1: hub });
    const a = await api.series(DEV, ['temp'], END - 7 * D, END, 'AVG', 500);
    const calls = cubeLog.length + platformReads().length;
    vi.setSystemTime(END + 20e3);
    const b = await api.series(DEV, ['temp'], END - 7 * D + 20e3, END + 20e3, 'AVG', 500);
    expect(cubeLog.length + platformReads().length).toBe(calls);
    expect(b.temp.slice(0, a.temp.length)).toEqual(a.temp);
    expect(b.temp.slice(a.temp.length)).toEqual(pushed);
  });
});

describe('series() and data summaries: a stopped or missing service costs nothing (D-084)', () => {
  /** A service that has not answered yet: its answer is given with release(). */
  function held() {
    let release!: (a: { status: number; body?: any } | 'network') => void;
    const p = new Promise<{ status: number; body?: any } | 'network'>((r) => { release = r; });
    return { answer: () => p, release };
  }

  it('not known yet, the service silent: the chart is drawn from the old read without waiting for it', async () => {
    cube.cubeReset();
    const h = held();
    cubeAnswer = h.answer;
    const r = await api.series(DEV, ['temp'], END - 7 * D, END, 'AVG', 500);
    expect(cubeLog.length).toBe(1);
    const old = await oldRead(['temp'], END - 7 * D, END, 'AVG', 500);
    expect(r).toEqual(old.r);
    expect(platformReads()).toEqual([...old.urls, ...old.urls]);
    h.release('network');
    await new Promise((res) => setTimeout(res, 0));
    expect(cube.cubeState(undefined)).toBe('paused');
  });

  it('after one failure no widget copy and no later page asks the service for 60 s; the old read alone', async () => {
    cube.cubeReset();
    cubeAnswer = () => 'network';
    await api.series(DEV, ['temp'], END - 7 * D, END, 'AVG', 500);
    expect(cubeLog.length).toBe(1);
    // another widget on the page: its own copy of the library (each widget type bundles one)
    vi.resetModules();
    const api2 = (await import('../src/core/api')) as typeof api;
    const before = platformReads().length;
    await api2.series(DEV, ['flow'], END - 7 * D, END, 'AVG', 500);
    expect(cubeLog.length).toBe(1);
    expect(platformReads().length).toBe(before + 1);
    // a later page (reload): the page's map is gone, the browser's storage keeps the pause
    (globalThis as any).__imxCubeState = {};
    vi.resetModules();
    const api3 = (await import('../src/core/api')) as typeof api;
    await api3.series(DEV, ['temp'], END - 2 * D, END, 'MAX', 500);
    expect(cubeLog.length).toBe(1);
    expect([...mem.keys()].some((k) => k.startsWith('imxCube.state:'))).toBe(true);
    // 60 s later the service is asked again (both at once, it is not known)
    vi.setSystemTime(END + 61e3);
    cubeAnswer = fakeCubes({ from: END - 20 * D, to: END - H });
    await api3.series(DEV, ['temp'], END - 7 * D + 61e3, END + 61e3, 'AVG', 500);
    expect(cubeLog.length).toBe(2);
    expect(cube.cubeState(undefined)).toBe('good');
  });

  it('not known yet, the service answers first: the summaries are drawn (the old read was started too)', async () => {
    cube.cubeReset();
    const cov = { from: END - 20 * D, to: END - H };
    cubeAnswer = fakeCubes(cov);
    // the old read of the whole window is the slow one here (the summaries + the small tail read come first)
    const plain = tb.fetch;
    tb.fetch = async (u: string, i?: any) => {
      if (u.includes(`startTs=${END - 7 * D}&`)) await new Promise((res) => setTimeout(res, 40));
      return plain(u, i);
    };
    const r = await api.series(DEV, ['temp'], END - 7 * D, END, 'AVG', 500);
    expect(r.temp.length).toBe(168);
    expect(r.temp[0].ts).toBe(END - 7 * D + H / 2);
    expect(cube.cubeState(undefined)).toBe('good');
    // known good now: the next chart reads as D-083 (the service, then only the open tail from the platform)
    const before = platformReads().length;
    await api.series(DEV, ['flow'], END - 7 * D, END, 'AVG', 500);
    expect(platformReads().length).toBe(before + 1);
    expect(platformReads()[before]).toContain(`startTs=${cov.to}&endTs=${END}`);
  });

  it('a value with no summary in the built part (the service does not know it yet) is read as before', async () => {
    const make = fakeCubes({ from: END - 20 * D, to: END - H });
    cubeAnswer = (u) => {
      const a: any = make(u);
      a.body.series.flow = [];
      a.body.kinds.flow = 'measurement';
      return a;
    };
    const r = await api.series(DEV, ['temp', 'flow'], END - 7 * D, END, 'AVG', 500);
    const old = await oldRead(['flow'], END - 7 * D, END, 'AVG', 500);
    expect(r.flow).toEqual(old.r.flow);
    expect(r.flow.length).toBeGreaterThan(0);
    expect(r.temp.length).toBe(168);
  });

  it('no value has a summary: the whole window is read as before', async () => {
    const make = fakeCubes({ from: END - 20 * D, to: END - H });
    cubeAnswer = (u) => {
      const a: any = make(u);
      a.body.series = { temp: [] };
      return a;
    };
    const before = platformReads().length;
    const r = await api.series(DEV, ['temp'], END - 7 * D, END, 'AVG', 500);
    const old = await oldRead(['temp'], END - 7 * D, END, 'AVG', 500);
    expect(platformReads().slice(before, before + old.urls.length)).toEqual(old.urls);
    expect(r).toEqual(old.r);
  });
});
