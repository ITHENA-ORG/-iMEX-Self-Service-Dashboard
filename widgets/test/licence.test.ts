// D-059: the instance licence in the Builder (core/licence.ts): feature gates read from window.__imexLicence
// defensively, re-gating on 'imx-licence-changed', and the monthly LLM quota of DESIGN 10.4 (count, verdict, metering).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as lic from '../src/core/licence';

type Call = { method: string; url: string; body: any };
let calls: Call[] = [];
let countResp: any = {};

function setWindow(L: any, app: any = { asset: { id: 'cfg-1', name: 'System Configuration' } }) {
  const w: any = new EventTarget();
  w.__imexLicence = L;
  w.__imexApp = app;
  vi.stubGlobal('window', w);
  return w;
}

beforeEach(() => {
  calls = [];
  countResp = {};
  vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'jwt_token' ? 'jwt' : null), setItem() {}, removeItem() {} });
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body) : undefined });
    const body = url.includes('agg=COUNT') ? countResp : url.includes('entitiesQuery') ? { data: [{ entityId: { id: 'cfg-q' }, latest: { ENTITY_FIELD: { name: { value: 'System Configuration' } } } }] } : null;
    return new Response(body == null ? '' : JSON.stringify(body), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('feature gates', () => {
  it('everything is allowed without a licence API, without has(), or when has() throws', () => {
    vi.stubGlobal('window', new EventTarget());
    expect(lic.licHas('builder')).toBe(true);
    expect(lic.chatLicensed()).toBe(true);
    setWindow({ status: { mode: 'active' } });
    expect(lic.builderLicensed()).toBe(true);
    setWindow({
      has: () => {
        throw new Error('x');
      },
    });
    expect(lic.licHas('builder.ai')).toBe(true);
  });
  it('follows has(): builder gates building, builder.ai the chat (and needs builder)', () => {
    const off = new Set<string>();
    setWindow({ has: (k: string) => !off.has(k) });
    expect([lic.builderLicensed(), lic.chatLicensed()]).toEqual([true, true]);
    off.add('builder.ai');
    expect([lic.builderLicensed(), lic.chatLicensed()]).toEqual([true, false]);
    off.clear();
    off.add('builder');
    expect([lic.builderLicensed(), lic.chatLicensed()]).toEqual([false, false]);
  });
  it('mayBuild = the role AND the licence', () => {
    let on = true;
    setWindow({ has: () => on });
    expect(lic.mayBuild({ canBuild: true })).toBe(true);
    expect(lic.mayBuild({ canBuild: false })).toBe(false);
    expect(lic.mayBuild(null)).toBe(false);
    on = false;
    expect(lic.mayBuild({ canBuild: true })).toBe(false);
  });
  it('onLicenceChange calls back only when the probed value changed', () => {
    let on = true;
    const w = setWindow({ has: () => on });
    const seen: boolean[] = [];
    const stop = lic.onLicenceChange(lic.builderLicensed, (v) => seen.push(v));
    w.dispatchEvent(new Event(lic.LICENCE_EVENT));
    on = false;
    w.dispatchEvent(new Event(lic.LICENCE_EVENT));
    w.dispatchEvent(new Event(lic.LICENCE_EVENT));
    on = true;
    w.dispatchEvent(new Event(lic.LICENCE_EVENT));
    stop();
    on = false;
    w.dispatchEvent(new Event(lic.LICENCE_EVENT));
    expect(seen).toEqual([false, true]);
  });
});

describe('LLM quota maths', () => {
  it('limit from .limits, else status.payload.limits; missing / 0 / junk = no limit', () => {
    expect(lic.llmLimit(null)).toBeNull();
    expect(lic.llmLimit({ limits: { llmCallsPerMonth: 2000 } })).toBe(2000);
    expect(lic.llmLimit({ status: { payload: { limits: { llmCallsPerMonth: 500 } } } })).toBe(500);
    expect(lic.llmLimit({ limits: {}, status: { payload: { limits: { llmCallsPerMonth: 500 } } } })).toBeNull();
    expect(lic.llmLimit({ limits: { llmCallsPerMonth: 0 } })).toBeNull();
    expect(lic.llmLimit({ limits: { llmCallsPerMonth: 'many' } })).toBeNull();
    expect(lic.llmLimit({ limits: { llmCallsPerMonth: '300' } })).toBe(300);
  });
  it('month start is the 1st, 00:00 UTC', () => {
    expect(lic.monthStartUtc(Date.UTC(2026, 9, 16, 8, 30))).toBe(Date.UTC(2026, 9, 1));
    expect(lic.monthStartUtc(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe(Date.UTC(2026, 0, 1));
    expect(lic.monthStartUtc(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe(Date.UTC(2026, 11, 1));
  });
  it('verdict mirrors llm_verdict: warn from 80 %, block at 100 %, no limit = ok', () => {
    expect(lic.llmVerdict(1599, 2000).level).toBe('ok');
    expect(lic.llmVerdict(1600, 2000)).toEqual({ level: 'warn', message: '1600 of 2000 AI requests used this month' });
    expect(lic.llmVerdict(1999, 2000).level).toBe('warn');
    expect(lic.llmVerdict(2000, 2000)).toEqual({ level: 'block', message: 'Monthly AI limit reached (2000 of 2000) — contact your administrator' });
    expect(lic.llmVerdict(2400, 2000).message).toBe('Monthly AI limit reached (2400 of 2000) — contact your administrator');
    expect(lic.llmVerdict(99999, null).level).toBe('ok');
    expect(lic.llmVerdict(5, 0).level).toBe('ok');
    // a small limit rounds the 80 % mark exactly as the Python module (used >= 0.8 * limit)
    expect(lic.llmVerdict(3, 4).level).toBe('ok');
    expect(lic.llmVerdict(4, 5).level).toBe('warn');
  });
  it('the COUNT request covers the five keys in one bucket from the month start', () => {
    const now = Date.UTC(2026, 9, 16, 8, 0);
    const start = Date.UTC(2026, 9, 1);
    expect(lic.llmCountPath('A1', now)).toBe(
      `/api/plugins/telemetry/ASSET/A1/values/timeseries?keys=llm_aiml,llm_native,llm_reports,llm_builder,llm_aether&startTs=${start}&endTs=${now}&agg=COUNT&interval=${now - start + 1}&limit=1`,
    );
  });
  it('sums the counts of every key (strings or numbers, junk ignored)', () => {
    expect(lic.sumCounts({ llm_aiml: [{ ts: 1, value: '12' }], llm_builder: [{ ts: 1, value: 3 }], llm_reports: [], llm_native: [{ ts: 1, value: 'x' }] })).toBe(15);
    expect(lic.sumCounts({})).toBe(0);
    expect(lic.sumCounts(null)).toBe(0);
  });
  it('n calls = n points of value 1, 1 ms apart (COUNT counts points)', () => {
    expect(lic.llmPoints('llm_builder', 3, 1000)).toEqual([
      { ts: 1000, values: { llm_builder: 1 } },
      { ts: 1001, values: { llm_builder: 1 } },
      { ts: 1002, values: { llm_builder: 1 } },
    ]);
    expect(lic.llmPoints('llm_builder', 0, 1000)).toEqual([]);
  });
});

describe('quota check and metering against ThingsBoard', () => {
  it('no limit: nothing is asked', async () => {
    setWindow({ has: () => true, limits: {} });
    expect(await lic.llmCheck()).toEqual({ level: 'ok', message: '', used: null, limit: null });
    expect(calls).toEqual([]);
  });
  it('reads the month count on the side menu asset and judges it', async () => {
    setWindow({ has: () => true, limits: { llmCallsPerMonth: 100 } });
    countResp = { llm_aiml: [{ ts: 0, value: '50' }], llm_builder: [{ ts: 0, value: '35' }] };
    const q = await lic.llmCheck(Date.UTC(2026, 9, 16));
    expect(q).toEqual({ level: 'warn', message: '85 of 100 AI requests used this month', used: 85, limit: 100 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/plugins/telemetry/ASSET/cfg-1/values/timeseries?keys=llm_aiml,llm_native,llm_reports,llm_builder,llm_aether');
    countResp = { llm_reports: [{ ts: 0, value: '100' }] };
    expect((await lic.llmCheck()).level).toBe('block');
  });
  it('a failed count read allows the call', async () => {
    setWindow({ has: () => true, limits: { llmCallsPerMonth: 100 } });
    vi.stubGlobal('fetch', async () => new Response('denied', { status: 403 }));
    expect(await lic.llmCheck()).toEqual({ level: 'ok', message: '', used: null, limit: 100 });
  });
  it('records each call as one llm_builder point on System Configuration', async () => {
    setWindow({ has: () => true });
    expect(await lic.llmRecord('llm_builder', 2, 5000)).toBe(true);
    expect(calls).toEqual([
      {
        method: 'POST',
        url: '/api/plugins/telemetry/ASSET/cfg-1/timeseries/ANY',
        body: [
          { ts: 5000, values: { llm_builder: 1 } },
          { ts: 5001, values: { llm_builder: 1 } },
        ],
      },
    ]);
    expect(await lic.llmRecord('llm_builder', 0)).toBe(false);
    expect(calls).toHaveLength(1);
  });
  it('without the side menu the asset is looked up by name', async () => {
    setWindow({ has: () => true }, null);
    expect(await lic.systemConfigId()).toBe('cfg-q');
    expect(calls[0].url).toBe('/api/entitiesQuery/find');
  });
});

describe('countingTransport', () => {
  it('counts the requests that answered, not the failed ones', async () => {
    let n = 0;
    const t = lic.countingTransport({
      async send(_b: unknown) {
        if (++n === 2) throw new Error('overloaded');
        return { toolInput: {} };
      },
    });
    await t.send({});
    await expect(t.send({})).rejects.toThrow('overloaded');
    await t.send({});
    expect(t.calls).toBe(2);
  });
});
