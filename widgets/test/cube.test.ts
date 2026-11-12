// Data summaries rule and client (core/cube.ts): runs every section of cube-vectors.json (byte-identical copy of the
// App UI's tests/cube-vectors.json, the contract shared with the JavaScript and Python copies), plus a few unit checks.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as X from '../src/core/cube';

const V: any = JSON.parse(readFileSync(new URL('./cube-vectors.json', import.meta.url), 'utf8'));
const plain = (x: any) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

type Log = { method?: string; url: string; auth?: string; body?: any; signal?: AbortSignal | null }[];
function fakeFetch(answer: any, log: Log) {
  return (url: string, init: RequestInit) => {
    const h = (init.headers || {}) as Record<string, string>;
    log.push({ method: init.method, url, auth: h['X-Authorization'], body: init.body === undefined ? undefined : JSON.parse(String(init.body)), signal: init.signal });
    if (answer.fail === 'timeout') return new Promise<never>(() => {});
    if (answer.fail === 'network') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({
      status: answer.status,
      json: () => ('text' in answer ? Promise.reject(new SyntaxError('Unexpected token')) : Promise.resolve(answer.body === undefined ? null : plain(answer.body)))
    });
  };
}
function call(c: any, a: any, opts: X.CubeOpts) {
  return c.call === 'many'
    ? X.cubeSeriesMany(a.base, a.token, a.devices, a.keys, a.from, a.to, a.level, a.fields, opts)
    : X.cubeSeries(a.base, a.token, a.device, a.keys, a.from, a.to, a.level, a.fields, opts);
}

describe('cube vectors (every runtime)', () => {
  beforeEach(() => X.cubeReset());
  it('cubeLevel', () => {
    for (const c of V.level) expect(X.cubeLevel(c.from, c.to), c.name).toBe(c.expect);
  });
  it('cubeParts', () => {
    for (const c of V.parts) expect(plain(X.cubeParts(c.from, c.to, c.level, c.coverage)), c.name).toEqual(c.expect);
  });
  it('cubeInterval', () => {
    for (const c of V.interval) expect(plain(X.cubeInterval(c.level)), String(c.level)).toEqual(c.expect);
  });
  it('cubeCombine', () => {
    for (const c of V.combine) expect(plain(X.cubeCombine(c.pieces)), c.name).toEqual(c.expect);
  });
  it('cubeMerge', () => {
    for (const c of V.merge) expect(plain(X.cubeMerge(c.lists)), c.name).toEqual(c.expect);
  });
  it('cubeUrl', () => {
    for (const c of V.url) expect(X.cubeUrl(c.base, c.device, c.keys, c.from, c.to, c.level, c.fields), c.name).toBe(c.expect);
  });
  it('the client', async () => {
    for (const c of V.client) {
      X.cubeReset();
      const log: Log = [];
      const a = { ...V.clientArgs, ...c.args };
      const r = await call(c, a, { fetch: fakeFetch(c.answer, log) as any, timeoutMs: 30 });
      expect(plain(r), c.name).toEqual(c.expect.result);
      if (!c.expect.sent) expect(log.length, `${c.name}: no request`).toBe(0);
      else {
        expect(log.length, `${c.name}: one request`).toBe(1);
        const s: any = { method: log[0].method, url: log[0].url, auth: log[0].auth };
        if (c.expect.sent.body) s.body = log[0].body;
        expect(s, `${c.name}: the request`).toEqual(c.expect.sent);
      }
    }
  });
  it('the pause after trouble', async () => {
    for (const seq of V.pause) {
      X.cubeReset();
      for (const [i, st] of (seq.steps as any[]).entries()) {
        const log: Log = [];
        const a = { ...V.clientArgs, ...(st.base ? { base: st.base } : {}) };
        const r = await X.cubeSeries(a.base, a.token, a.device, a.keys, a.from, a.to, a.level, a.fields, { fetch: fakeFetch(st.answer, log) as any, timeoutMs: 30, now: () => st.at });
        expect(log.length > 0, `${seq.name}, step ${i + 1}: sent`).toBe(st.expect.sent);
        expect(plain(r), `${seq.name}, step ${i + 1}: result`).toEqual(st.expect.result);
      }
    }
  });
});

describe('cube client (TypeScript only)', () => {
  beforeEach(() => X.cubeReset());
  it('the default address is the same-origin /cubes-api; null means no service', async () => {
    const log: Log = [];
    const a = V.clientArgs;
    const body = { v: 1, level: a.level, coverage: null, series: {} };
    const r = await X.cubeSeries(undefined, a.token, a.device, a.keys, a.from, a.to, a.level, null, { fetch: fakeFetch({ status: 200, body }, log) as any });
    expect(plain(r)).toEqual(body);
    expect(log[0].url.startsWith('/cubes-api/api/v1/series?')).toBe(true);
    expect(await X.cubeSeries(null, a.token, a.device, a.keys, a.from, a.to, a.level, null, { fetch: fakeFetch({ status: 200, body }, log) as any })).toBe(null);
    expect(log.length).toBe(1);
  });
  it('a timeout aborts the request and answers null near the limit', async () => {
    const log: Log = [];
    const a = V.clientArgs;
    const t0 = Date.now();
    const r = await X.cubeSeries(a.base, a.token, a.device, a.keys, a.from, a.to, a.level, null, { fetch: fakeFetch({ fail: 'timeout' }, log) as any, timeoutMs: 40 });
    const took = Date.now() - t0;
    expect(r).toBe(null);
    expect(log[0].signal?.aborted).toBe(true);
    expect(took).toBeGreaterThanOrEqual(35);
    expect(took).toBeLessThan(1000);
  });
  it('a fetch that throws at once answers null', async () => {
    const a = V.clientArgs;
    const boom = () => { throw new Error('boom'); };
    expect(await X.cubeSeries(a.base, a.token, a.device, a.keys, a.from, a.to, a.level, null, { fetch: boom as any })).toBe(null);
  });
  it('defaults: 1.5 s, a 60-s pause, three levels', () => {
    expect(X.TIMEOUT_MS).toBe(1500);
    expect(X.PAUSE_MS).toBe(60000);
    expect(X.DEFAULT_BASE).toBe('/cubes-api');
    expect([...X.LEVELS]).toEqual(['5m', '1h', '1d']);
  });
  it('the merge does not change its input', () => {
    const lists = [[{ ts: 1, n: 2, avg: 1, st: { 0: 5 } }], [{ ts: 1, n: 2, avg: 3, st: { 0: 5 } }], [{ ts: 2, n: 1, avg: 1, st: { 1: 1 } }]];
    const before = JSON.stringify(lists);
    const out = X.cubeMerge(lists);
    out[1].st![1] = 99;
    expect(JSON.stringify(lists)).toBe(before);
  });
});
