// D-092: the standard deviation a Builder widget can show (core/sd.ts). The summaries here are built by a fake service
// from the same raw readings the fake platform serves, so a standard deviation from summaries (m2, Chan's merge) plus
// raw head / tail parts must equal the sample standard deviation of the raw readings themselves.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeTB } from './fake-tb';
import * as api from '../src/core/api';
import * as cube from '../src/core/cube';
import * as sd from '../src/core/sd';
import { WidgetSettings, Dashboard } from '../src/core/schema';

const H = 3600e3;
const D = 86400e3;
const IST = 5.5 * H;
const DEV = 'd0000000-0000-4000-8000-0000000000aa';
// on the India hour grid (UTC :30): 12 Nov 2026 12:00 India time
const END = Date.UTC(2026, 10, 12, 6, 30);

let tb: FakeTB;
let cubeLog: string[];
let cubeAnswer: (u: URL) => { status: number; body?: any } | 'network';
const mem = new Map<string, string>();

/** Raw readings every 10 min (+7 s, off every grid) with gaps and a denser stretch (counts differ per bucket). */
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

/** The sample standard deviation of the readings of `key` in [a, b) (two passes, the plain definition). */
function sdOf(key: string, a: number, b: number): number | null {
  const v = (tb.telemetry.get(DEV)?.[key] ?? []).filter((p) => p.ts >= a && p.ts < b).map((p) => Number(p.value));
  if (v.length < 2) return null;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1));
}

/** Fake summary service: n, avg, m2 per bucket on the India grid, from the fake platform's readings. */
function fakeCubes(cov: { from: number; to: number } | null, opts: { noM2Before?: number } = {}) {
  return (u: URL) => {
    const level = u.searchParams.get('level') as '5m' | '1h' | '1d';
    const size = level === '5m' ? 300e3 : level === '1h' ? H : D;
    const off = level === '5m' ? 0 : level === '1h' ? H - (IST % H) : D - IST;
    const from = Number(u.searchParams.get('from'));
    const to = Number(u.searchParams.get('to'));
    const keys = u.searchParams.get('keys')!.split(',');
    const fields = (u.searchParams.get('fields') ?? 'avg,min,max,n').split(',');
    const series: Record<string, any[]> = {};
    for (const k of keys) {
      series[k] = [];
      if (!cov) continue;
      const b = new Map<number, number[]>();
      for (const p of tb.telemetry.get(DEV)?.[k] ?? []) {
        const s = Math.floor((p.ts - off) / size) * size + off;
        if (s < cov.from || s + size > cov.to || s < from || s >= to) continue;
        b.set(s, [...(b.get(s) ?? []), Number(p.value)]);
      }
      for (const [s, v] of [...b.entries()].sort((x, y) => x[0] - y[0])) {
        const n = v.length;
        const avg = v.reduce((a, c) => a + c, 0) / n;
        const m2 = v.reduce((a, c) => a + (c - avg) * (c - avg), 0);
        const all: Record<string, number | null> = { n, avg, m2: opts.noM2Before != null && s < opts.noM2Before ? null : m2 };
        const row: any = { ts: s };
        for (const f of fields) if (f in all) row[f] = all[f];
        series[k].push(row);
      }
    }
    return { status: 200, body: { v: 1, device: DEV, level, zone: 'Asia/Kolkata', coverage: cov, kinds: Object.fromEntries(keys.map((k) => [k, 'measurement'])), series, skipped: [] } };
  };
}

const platformReads = () => tb.urls.filter((x) => x.includes('/values/timeseries')).map((x) => x.replace(/^[A-Z]+ /, ''));
const close = (a: number | null | undefined, b: number | null | undefined) => {
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(Math.abs((a as number) - (b as number))).toBeLessThan(1e-9 * Math.max(1, Math.abs(b as number)));
};

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
      cubeLog.push(`${u.pathname}${u.search}`);
      const a = cubeAnswer(u);
      if (a === 'network') throw new TypeError('Failed to fetch');
      return { status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body) } as any;
    }
    return tb.fetch(url, init);
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(END);
  api.setCubesBase(undefined);
  api.clearCaches();
  cube.cubeReset();
  sd.sdReset();
  // the service answered a summary a moment ago (known good)
  (globalThis as any).__imxCubeState = { '/cubes-api': { t: Date.now(), ok: true } };
});
afterEach(() => {
  // the platform is never asked for a standard deviation
  expect(tb.urls.filter((x) => /[?&]agg=SD\b/.test(x))).toEqual([]);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('D-092 standard deviation: reads', () => {
  it('a window of 4 h or less is computed from the raw readings alone (no summary call)', async () => {
    const r = await sd.sdWindow(DEV, 'temp', END - 4 * H, END);
    expect(r.state).toBe('ok');
    close(r.value, sdOf('temp', END - 4 * H, END));
    expect(cubeLog).toEqual([]);
    expect(platformReads().every((x) => x.includes('agg=NONE'))).toBe(true);
    // per bucket (a line chart over 2 h)
    const s = await sd.sdSeries(DEV, ['temp', 'flow'], END - 2 * H, END, 30 * 60e3);
    expect(s.state).toBe('ok');
    expect(s.points.temp.length).toBe(4);
    s.points.temp.forEach((p, i) => close(p.value, sdOf('temp', END - 2 * H + i * 30 * 60e3, END - 2 * H + (i + 1) * 30 * 60e3)));
    s.points.flow.forEach((p, i) => close(p.value, sdOf('flow', END - 2 * H + i * 30 * 60e3, END - 2 * H + (i + 1) * 30 * 60e3)));
  });

  it('7 days: summaries (m2, Chan) + a raw tail of 1 h = the sample standard deviation of all readings', async () => {
    cubeAnswer = fakeCubes({ from: END - 30 * D, to: END - H });
    const r = await sd.sdWindow(DEV, 'temp', END - 7 * D, END);
    expect(r.state).toBe('ok');
    close(r.value, sdOf('temp', END - 7 * D, END));
    expect(cubeLog.length).toBe(1);
    expect(new URL('http://x' + cubeLog[0]).searchParams.get('fields')).toBe('n,avg,m2');
    expect(new URL('http://x' + cubeLog[0]).searchParams.get('level')).toBe('1h');
    // the tail read is raw and at most 4 h
    const tail = platformReads().map((x) => new URL('http://x' + x).searchParams);
    expect(tail.length).toBe(1);
    expect(tail[0].get('agg')).toBe('NONE');
    expect(Number(tail[0].get('endTs')) - Number(tail[0].get('startTs'))).toBeLessThanOrEqual(4 * H);
  });

  it('per bucket: every 6 h bucket equals the sample standard deviation of its readings', async () => {
    cubeAnswer = fakeCubes({ from: END - 30 * D, to: END - H });
    const start = END - 7 * D;
    const s = await sd.sdSeries(DEV, ['temp', 'flow'], start, END, 6 * H);
    expect(s.state).toBe('ok');
    expect(s.step).toBe(6 * H);
    expect(s.points.temp.length).toBe(28);
    for (const k of ['temp', 'flow'])
      s.points[k].forEach((p) => {
        const a = p.ts - 3 * H;
        close(p.value, sdOf(k, a, a + 6 * H));
      });
    expect(s.gaps.temp).toEqual([]);
  });

  it('a window not on the hour grid: the uncovered head (< 1 h) is joined from raw readings', async () => {
    cubeAnswer = fakeCubes({ from: END - 30 * D, to: END - H });
    const start = END - 7 * D + 17 * 60e3;
    const r = await sd.sdWindow(DEV, 'temp', start, END);
    expect(r.state).toBe('ok');
    close(r.value, sdOf('temp', start, END));
  });

  it('a head of 3 h before the summaries start is joined from raw readings', async () => {
    cubeAnswer = fakeCubes({ from: END - 7 * D + 3 * H, to: END - H });
    const r = await sd.sdWindow(DEV, 'temp', END - 7 * D, END);
    expect(r.state).toBe('ok');
    close(r.value, sdOf('temp', END - 7 * D, END));
  });

  it('a head of 10 h before the summaries start has no value: a gap, never a partial figure', async () => {
    cubeAnswer = fakeCubes({ from: END - 7 * D + 10 * H, to: END - H });
    const start = END - 7 * D;
    const w = await sd.sdWindow(DEV, 'temp', start, END);
    expect(w).toEqual({ value: null, state: 'part' });
    const s = await sd.sdSeries(DEV, ['temp'], start, END, 6 * H);
    expect(s.state).toBe('part');
    expect(s.gaps.temp).toEqual([{ from: start, to: start + 12 * H }]);
    expect(s.points.temp[0].ts).toBe(start + 12 * H + 3 * H);
    close(s.points.temp[0].value, sdOf('temp', start + 12 * H, start + 18 * H));
    // no raw read of the long head
    expect(platformReads().every((x) => Number(new URL('http://x' + x).searchParams.get('endTs')) - Number(new URL('http://x' + x).searchParams.get('startTs')) <= 4 * H)).toBe(true);
    expect(sd.sdNote([s.state])).toBe(sd.SD_NOTE_PART);
  });

  it('a summary bucket without m2 (built before m2 was kept) leaves its bucket empty', async () => {
    const start = END - 7 * D;
    cubeAnswer = fakeCubes({ from: END - 30 * D, to: END - H }, { noM2Before: start + 2 * H });
    const s = await sd.sdSeries(DEV, ['temp'], start, END, 6 * H);
    expect(s.state).toBe('part');
    expect(s.gaps.temp).toEqual([{ from: start, to: start + 6 * H }]);
    expect(s.points.temp.length).toBe(27);
  });

  it('summaries that cover nothing of a long window: none', async () => {
    cubeAnswer = fakeCubes(null);
    const s = await sd.sdSeries(DEV, ['temp'], END - 7 * D, END, 6 * H);
    expect(s.state).toBe('none');
    expect(s.points.temp).toEqual([]);
    expect(sd.sdNote([s.state])).toBe(sd.SD_NOTE_NONE);
  });

  it('the service down: off (the plain note), then no further call while paused; a short window still reads raw', async () => {
    (globalThis as any).__imxCubeState = {};
    cubeAnswer = () => 'network';
    const s = await sd.sdSeries(DEV, ['temp'], END - 7 * D, END, 6 * H);
    expect(s.state).toBe('off');
    expect(sd.sdNote([s.state])).toBe(sd.SD_NOTE_OFF);
    expect(cube.cubeState(undefined)).toBe('paused');
    const n = cubeLog.length;
    expect((await sd.sdSeries(DEV, ['temp'], END - 8 * H, END, H)).state).toBe('off');
    expect(cubeLog.length).toBe(n);
    // 4 h or less needs no service
    const r = await sd.sdWindow(DEV, 'temp', END - H, END);
    expect(r.state).toBe('ok');
    close(r.value, sdOf('temp', END - H, END));
  });

  it('no service address: off without a call', async () => {
    api.setCubesBase('');
    expect((await sd.sdSeries(DEV, ['temp'], END - 7 * D, END, 6 * H)).state).toBe('off');
    expect(cubeLog).toEqual([]);
  });

  it('licence dataCubes false: off for every window, no read at all', async () => {
    vi.stubGlobal('window', { __imexLicence: { has: (k: string) => k !== 'dataCubes' } });
    expect((await sd.sdSeries(DEV, ['temp'], END - H, END, 60e3)).state).toBe('off');
    expect((await sd.sdWindow(DEV, 'temp', END - 7 * D, END)).state).toBe('off');
    expect(tb.urls.length + cubeLog.length).toBe(0);
  });

  it('the service refusing for the licence (403 licence): off, and the choice is greyed afterwards', async () => {
    cubeAnswer = () => ({ status: 403, body: { error: 'licence' } });
    expect(sd.sdAvailability()).toBe('');
    expect((await sd.sdWindow(DEV, 'temp', END - 7 * D, END)).state).toBe('off');
    expect(sd.sdAvailability()).toBe(sd.SD_NEEDS);
    // another 403 (no licence word) does not grey it
    sd.sdReset();
    cubeAnswer = () => ({ status: 403, body: { error: 'forbidden' } });
    expect((await sd.sdWindow(DEV, 'temp', END - 7 * D, END)).state).toBe('off');
    expect(sd.sdAvailability()).toBe('');
  });

  it('kept for 55 s: a redraw makes no read', async () => {
    cubeAnswer = fakeCubes({ from: END - 30 * D, to: END - H });
    await sd.sdSeries(DEV, ['temp'], END - 7 * D, END, 6 * H);
    const n = tb.urls.length + cubeLog.length;
    await sd.sdSeries(DEV, ['temp'], END - 7 * D, END, 6 * H);
    expect(tb.urls.length + cubeLog.length).toBe(n);
    api.clearCaches();
    await sd.sdSeries(DEV, ['temp'], END - 7 * D, END, 6 * H);
    expect(tb.urls.length + cubeLog.length).toBeGreaterThan(n);
  });

  it('never reaches the platform as an aggregation: series / windowAgg refuse SD before sending', async () => {
    const n = tb.urls.length;
    await expect(api.series(DEV, ['temp'], END - H, END, 'SD' as any)).rejects.toThrow();
    await expect(api.windowAgg(DEV, 'temp', END - H, END, 'SD' as any)).rejects.toThrow();
    expect(tb.urls.length).toBe(n);
  });
});

describe('D-092 standard deviation: the choice in the editor', () => {
  it('sdWhy: off / paused / not licensed -> "Needs data summaries"; good / unknown -> offered', () => {
    expect(sd.sdWhy('off', true)).toBe('Needs data summaries');
    expect(sd.sdWhy('paused', true)).toBe('Needs data summaries');
    expect(sd.sdWhy('good', false)).toBe('Needs data summaries');
    expect(sd.sdWhy('unknown', false)).toBe('Needs data summaries');
    expect(sd.sdWhy('good', true)).toBe('');
    expect(sd.sdWhy('unknown', true)).toBe('');
  });

  it('sdAvailability reads the shared service state fresh', () => {
    expect(sd.sdAvailability()).toBe(''); // known good
    (globalThis as any).__imxCubeState = {};
    expect(sd.sdAvailability()).toBe(''); // not known yet
    (globalThis as any).__imxCubeState = { '/cubes-api': { t: Date.now(), ok: false } };
    expect(sd.sdAvailability()).toBe(sd.SD_NEEDS); // paused
    vi.setSystemTime(END + 61e3);
    expect(sd.sdAvailability()).toBe(''); // the pause is over: unknown again
    api.setCubesBase('');
    expect(sd.sdAvailability()).toBe(sd.SD_NEEDS); // off
    api.setCubesBase(undefined);
    vi.stubGlobal('window', { __imexLicence: { has: (k: string) => k !== 'dataCubes' } });
    expect(sd.sdAvailability()).toBe(sd.SD_NEEDS);
    vi.stubGlobal('window', { __imexLicence: { has: () => true } });
    expect(sd.sdAvailability()).toBe('');
  });

  it('the Aggregation choices: lowercase like their neighbours; line / area / bar / heatmap only', () => {
    expect(sd.aggChoices('line', '')).toEqual([
      { v: 'AVG', l: 'avg' }, { v: 'MIN', l: 'min' }, { v: 'MAX', l: 'max' }, { v: 'SD', l: 'standard deviation' }, { v: 'NONE', l: 'Raw values' },
    ]);
    expect(sd.aggChoices('area', '').map((o) => o.v)).toEqual(['AVG', 'MIN', 'MAX', 'SD', 'NONE']);
    expect(sd.aggChoices('bar', '').map((o) => o.v)).toEqual(['AVG', 'MIN', 'MAX', 'SUM', 'SD']);
    expect(sd.aggChoices('heatmap', '').map((o) => o.v)).toEqual(['AVG', 'MIN', 'MAX', 'SUM', 'SD']);
    expect(sd.aggChoices('donut', '').map((o) => o.v)).toEqual(['AVG', 'MIN', 'MAX', 'SUM']);
    expect(sd.aggChoices('bar', sd.SD_NEEDS).find((o) => o.v === 'SD')).toEqual({ v: 'SD', l: 'standard deviation', disabled: true, sub: 'Needs data summaries' });
  });

  it('sdFreshen greys or frees the option as the list opens', () => {
    const opt = (value: string) => {
      const attrs: Record<string, string> = {};
      return { value, disabled: false, title: '', attrs, setAttribute: (k: string, v: string) => (attrs[k] = v), removeAttribute: (k: string) => delete attrs[k] };
    };
    const options = [opt('AVG'), opt('SD')];
    sd.sdFreshen({ options }, sd.SD_NEEDS);
    expect(options[1].disabled).toBe(true);
    expect(options[1].attrs['data-sub']).toBe('Needs data summaries');
    expect(options[0].disabled).toBe(false);
    sd.sdFreshen({ options }, '');
    expect(options[1].disabled).toBe(false);
    expect(options[1].attrs['data-sub']).toBeUndefined();
  });
});

describe('D-092 standard deviation: words and stored dashboards', () => {
  it('the output word and the plain sentences name no platform or service internals', () => {
    expect(sd.SD_LABEL).toBe('Std. deviation');
    expect(sd.SD_OPTION).toBe('standard deviation');
    expect(sd.SD_NOTE_OFF).toBe('Standard deviation needs data summaries, which are not available right now.');
    expect(sd.SD_NOTE_PART).toBe('Standard deviation is not available for part of this period.');
    for (const t of [sd.SD_LABEL, sd.SD_NEEDS, sd.SD_NOTE_OFF, sd.SD_NOTE_PART, sd.SD_NOTE_NONE]) expect(t).not.toMatch(/thingsboard|cube|m2|service|platform/i);
    expect(sd.sdNote(['ok', 'ok'])).toBe('');
    expect(sd.sdNote(['ok', 'off'])).toBe(sd.SD_NOTE_PART);
    expect(sd.sdNote(['off', 'off'])).toBe(sd.SD_NOTE_OFF);
  });

  it('the schema accepts agg SD; stored dashboards without it parse as before; unknown codes are refused', () => {
    expect(WidgetSettings.safeParse({ agg: 'SD' }).success).toBe(true);
    for (const a of ['AVG', 'MIN', 'MAX', 'SUM', 'NONE', undefined]) expect(WidgetSettings.safeParse(a ? { agg: a } : {}).success).toBe(true);
    expect(WidgetSettings.safeParse({ agg: 'STDDEV' }).success).toBe(false);
    const doc = (agg?: string) => ({
      schemaVersion: 1, id: 'd1', name: 'Old', kind: 'standalone', profile: null, timeRange: '8h',
      widgets: [{ id: 'w1', type: 'line', title: 'T', x: 0, y: 0, w: 6, h: 4, binding: { mode: 'fixed', deviceIds: [DEV] }, keys: ['temp'], settings: agg ? { agg } : {} }],
      ownerId: 'u1', ownerName: 'A', version: 1, updatedAt: 1, updatedBy: 'A',
    });
    expect(Dashboard.safeParse(doc()).success).toBe(true);
    expect(Dashboard.safeParse(doc('AVG')).success).toBe(true);
    expect(Dashboard.safeParse(doc('NONE')).success).toBe(true);
    expect(Dashboard.safeParse(doc('SD')).success).toBe(true);
  });
});

describe('D-092 standard deviation: the line chart bucket', () => {
  it('auto: sparse readings get buckets long enough to hold a spread (about 8 readings each)', async () => {
    // readings about every 10 min: a 1-minute bucket holds one (no spread), the automatic one about 8
    const plain = await sd.sdSeries(DEV, ['temp'], END - 4 * H, END, 60e3);
    expect(plain.points.temp.length).toBeLessThan(5);
    const s = await sd.sdSeries(DEV, ['temp'], END - 4 * H, END, 60e3, { auto: true });
    expect(s.state).toBe('ok');
    expect(s.points.temp.length).toBeGreaterThanOrEqual(2);
    const step = 2 * (s.points.temp[0].ts - (END - 4 * H));
    expect([3600e3, 3 * 3600e3]).toContain(step);
    s.points.temp.forEach((p) => close(p.value, sdOf('temp', p.ts - step / 2, p.ts + step / 2)));
    expect(sd.autoStep(60e3, 10e3)).toBe(5 * 60e3);
    expect(sd.autoStep(15 * 60e3, 1e3)).toBe(15 * 60e3);
  });
});
