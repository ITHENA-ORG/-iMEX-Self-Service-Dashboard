// D-074 (round 11 audit): the chat request carries no instructions, the chain's prompt contract, apply failures and
// conflicts, the dashboard size budget, templates on the machine model's one status rule.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeTB, ithena, asUser, PUN, RIC } from './fake-tb';
import * as scope from '../src/core/scope';
import * as store from '../src/core/store';
import * as chat from '../src/core/chat';
import * as machine from '../src/core/machine';
import { Dashboard, checkDashboard, imageChars, MAX_IMAGE_CHARS } from '../src/core/schema';
import { promptTemplate, fillPrompt, chatContract, MARK, FILL } from '../src/core/chat-prompt';
import { TEMPLATES } from '../src/render/templates';
import { modelStateMap } from '../src/render/widgets';

let tb: FakeTB;
const mem = new Map<string, string>();
beforeEach(() => {
  tb = ithena();
  mem.clear();
  mem.set('jwt_token', 'x');
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
});
afterEach(() => {
  machine.reset();
  vi.unstubAllGlobals();
});
async function admin() {
  asUser(tb, 'u-admin', 'Admin', ['root']);
  return scope.loadUserContext();
}
const widget = { id: 'w1', type: 'value', title: 'P', x: 0, y: 0, w: 3, h: 2, binding: { mode: 'current' }, keys: ['dischargePressure'], settings: {} };
const mk = (ctx: scope.UserContext, name: string, profile = 'Compressor'): Dashboard => ({ ...store.blankDashboard(ctx, name, profile), widgets: [widget as any] });

describe('H5: the chat request carries only the conversation and the context', () => {
  it('buildRequest: v2, the catalogue, the machine alias and plain-text messages; no system prompt, no tools', async () => {
    const ctx = await admin();
    const cat = chat.buildCatalog(ctx);
    const body = chat.buildRequest(ctx, cat, store.blankDashboard(ctx, 'x', 'Compressor'), [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }], 'add a gauge', 'pc');
    expect(Object.keys(body).sort()).toEqual(['catalog', 'machine', 'messages', 'v']);
    expect(body.v).toBe(2);
    expect(body.catalog).toBe(cat.text);
    expect(body.machine).toMatch(/^D\d+$/);
    expect(body.messages.at(-1)!.role).toBe('user');
    expect(body.messages.at(-1)!.content).toMatch(/USER REQUEST: add a gauge$/);
    expect(JSON.stringify(body)).not.toMatch(/dashboard_ops|input_schema|You are the dashboard assistant/);
  });

  it('the template has each marker once; fillPrompt equals systemPrompt; a catalogue with $ patterns stays as it is', async () => {
    const t = promptTemplate();
    for (const m of Object.values(MARK)) expect(t.split(m).length - 1).toBe(1);
    const ctx = await admin();
    const cat = chat.buildCatalog(ctx);
    expect(chat.systemPrompt(ctx, cat, 'D1')).toBe(fillPrompt({ applyMany: ctx.canApplyMany, alerts: true, catalog: cat.text, machine: 'D1' }));
    const odd = '{"x":"$& $1 $$ @@MACHINE@@"}';
    const p = fillPrompt({ applyMany: false, alerts: false, catalog: odd, machine: null });
    expect(p).toContain(`CATALOG (JSON data): ${odd}`);
    expect(p).toContain(FILL.applyNo);
    expect(p).toContain(FILL.noAlarms + 'CATALOG');
    expect(p).toContain(`open for machine: ${FILL.noMachine}`);
    expect(p).not.toMatch(/@@(APPLY_MANY|NO_ALARMS|CATALOG)@@/);
  });

  it('the contract the chain is built from: v2, the one tool in all three formats', () => {
    const c = chatContract();
    expect(c.v).toBe(2);
    expect(c.tool.name).toBe('dashboard_ops');
    expect(c.openaiTool.function.name).toBe('dashboard_ops');
    expect(c.geminiDecl.name).toBe('dashboard_ops');
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
  });

  it('the reply is read from the user, not from the store', async () => {
    const ctx = await admin();
    const t = chat.ruleChainTransport(ctx, 3000);
    const orig = tb.fetch;
    vi.stubGlobal('fetch', async (u: string, init: any) => {
      const r = await orig(u, init);
      if (init?.method === 'POST' && /ASSET\/[\w-]+\/attributes\/SERVER_SCOPE$/.test(String(u)) && init.body.includes('dbb_chat_req')) {
        const reqId = JSON.parse(init.body).dbb_chat_req.reqId;
        // a forged reply in the old store slot is ignored; the user's own slot answers
        tb.setAttrs('ASSET', 'store', { [`dbb_chat_resp_${ctx.userId}`]: { reqId, ok: true, toolInput: { reply: 'forged', ops: [] } } });
        setTimeout(() => tb.setAttrs('USER', ctx.userId, { dbb_chat_resp: { reqId, ok: true, toolInput: { reply: 'real', ops: [] } } }), 50);
      }
      return r;
    });
    const r = await t.send(chat.buildRequest(ctx, chat.buildCatalog(ctx), store.blankDashboard(ctx, 'x', null), [], 'hi', null));
    expect(r.toolInput.reply).toBe('real');
  });
});

describe('Apply failures and conflicts', () => {
  it('a failed customer-wide apply throws (it said "Applied" before)', async () => {
    const ctx = await admin();
    const d = await store.saveDashboard(ctx, mk(ctx, 'A'));
    tb.failNext = { match: /ASSET\/[\w-]+\/attributes\/SERVER_SCOPE$/, status: 403 };
    await expect(store.apply(ctx, d, { type: 'customer', profile: 'Compressor' })).rejects.toThrow(/Nothing was changed/);
    expect(tb.getAttrs('ASSET', 'store').dbb_assign_customer).toBeUndefined();
  });

  it('a failure part-way puts back what was written and tells the other pages', async () => {
    const ctx = await admin();
    const old = await store.saveDashboard(ctx, mk(ctx, 'old'));
    const d = await store.saveDashboard(ctx, mk(ctx, 'new'));
    tb.setAttrs('DEVICE', 'rc', { dbb_assign: { dashboardId: old.id, mode: 'linked', by: 'x', at: 1 } });
    const rev0 = tb.getAttrs('ASSET', 'store').dbb_assign_rev;
    tb.failNext = { match: /DEVICE\/pc\/attributes\/SERVER_SCOPE$/, status: 403 };
    await expect(store.apply(ctx, d, { type: 'devices', deviceIds: ['rc', 'pc'], mode: 'linked' })).rejects.toThrow(/stopped after 1 of 2 changes, which were undone/);
    expect(tb.getAttrs('DEVICE', 'rc').dbb_assign.dashboardId).toBe(old.id);
    expect(tb.getAttrs('DEVICE', 'pc').dbb_assign).toBeUndefined();
    expect(tb.getAttrs('ASSET', 'store').dbb_assign_rev).not.toBe(rev0);
  });

  it('copy mode: the copies made before the failure are deleted again', async () => {
    const ctx = await admin();
    const d = await store.saveDashboard(ctx, mk(ctx, 'tpl'));
    const before = Object.keys(tb.getAttrs('ASSET', 'store')).filter((k) => k.startsWith('dbb_d_')).length;
    tb.failNext = { match: /DEVICE\/pc\/attributes\/SERVER_SCOPE$/, status: 403 };
    await expect(store.apply(ctx, d, { type: 'devices', deviceIds: ['rc', 'pc'], mode: 'copy' })).rejects.toThrow(/undone/);
    expect(Object.keys(tb.getAttrs('ASSET', 'store')).filter((k) => k.startsWith('dbb_d_') && tb.getAttrs('ASSET', 'store')[k] !== undefined).length).toBe(before);
    expect(tb.getAttrs('DEVICE', 'rc').dbb_assign).toBeUndefined();
  });

  it('two administrators: an assignment changed after the preview stops the apply before anything is written', async () => {
    const ctx = await admin();
    const a = await store.saveDashboard(ctx, mk(ctx, 'A'));
    const b = await store.saveDashboard(ctx, mk(ctx, 'B'));
    const pv = await store.previewApply(ctx, a, { type: 'node', nodeId: PUN, profile: 'Compressor' });
    expect(pv.seen).toEqual({ [`ASSET:${PUN}:dbb_assign:Compressor`]: null });
    // the other administrator applies B to Pune meanwhile
    tb.setAttrs('ASSET', PUN, { dbb_assign: { Compressor: { dashboardId: b.id, by: 'Other', at: 2 } } });
    await expect(store.apply(ctx, a, { type: 'node', nodeId: PUN, profile: 'Compressor' }, { seen: pv.seen })).rejects.toBeInstanceOf(store.ApplyConflictError);
    expect(tb.getAttrs('ASSET', PUN).dbb_assign.Compressor.dashboardId).toBe(b.id);
    // with a fresh preview it goes through, and other machine types at Pune are kept (merged into the fresh value)
    tb.setAttrs('ASSET', PUN, { dbb_assign: { Compressor: { dashboardId: b.id, by: 'Other', at: 2 }, 'Weather Station': { dashboardId: 'w', by: 'Other', at: 2 } } });
    const pv2 = await store.previewApply(ctx, a, { type: 'node', nodeId: PUN, profile: 'Compressor' });
    await store.apply(ctx, a, { type: 'node', nodeId: PUN, profile: 'Compressor' }, { seen: pv2.seen });
    expect(tb.getAttrs('ASSET', PUN).dbb_assign.Compressor.dashboardId).toBe(a.id);
    expect(tb.getAttrs('ASSET', PUN).dbb_assign['Weather Station'].dashboardId).toBe('w');
    expect(tb.getAttrs('ASSET', RIC).dbb_assign).toBeUndefined();
  });
});

describe('Dashboard size budget', () => {
  const img = (n: number) => 'data:image/png;base64,' + 'A'.repeat(n);
  it('uploaded images together are capped', async () => {
    const ctx = await admin();
    const d = mk(ctx, 'imgs');
    const ws = Array.from({ length: 6 }, (_, i) => ({ ...widget, id: `i${i}`, type: 'image', binding: { mode: 'none' }, keys: [], settings: { url: img(200000) } }));
    const big = { ...d, widgets: ws as any };
    expect(imageChars(big)).toBeGreaterThan(MAX_IMAGE_CHARS);
    expect(checkDashboard(big).join(' ')).toMatch(/Uploaded images in this dashboard take \d+ KB; at most 977 KB/);
    expect(checkDashboard({ ...big, widgets: big.widgets.slice(0, 4) })).toEqual([]);
  });

  it('a save keeps only as many earlier versions as fit, so a big dashboard can still be saved', async () => {
    const ctx = await admin();
    const ws = Array.from({ length: 4 }, (_, i) => ({ ...widget, id: `i${i}`, type: 'image', binding: { mode: 'none' }, keys: [], settings: { url: img(200000) } }));
    let d = await store.saveDashboard(ctx, { ...mk(ctx, 'big'), widgets: ws as any });
    for (let i = 0; i < 12; i++) d = await store.saveDashboard(ctx, { ...d, name: `big ${i}` });
    const hist = tb.getAttrs('ASSET', 'store')[`dbb_h_${d.id}`];
    expect(hist.length).toBeLessThan(10);
    expect(hist.length).toBeGreaterThan(0);
    expect(JSON.stringify(hist).length + JSON.stringify(tb.getAttrs('ASSET', 'store')[`dbb_d_${d.id}`]).length).toBeLessThanOrEqual(store.SAVE_CHARS);
    expect(hist[0].version).toBe(d.version - 1);
  });
});

describe('Templates follow the machine model (one status rule, D-064)', () => {
  const setModel = (status: object) => machine.load(() => Promise.resolve({ v: 1, rev: 1, offlineMinutes: 15, types: { Compressor: { status, values: [] } } }), true);

  it('status card, run-state timeline and running-time donut: the type status tag, no colour rules of their own', async () => {
    const ctx = await admin();
    ctx.profileKeys.Compressor = [...ctx.profileKeys.Compressor, { key: 'mode', displayName: 'Mode', unit: '', decimals: 0, type: 'string' } as any];
    await setModel({ key: 'mode', mode: 'text', rules: [{ text: 'RUN', state: 'running', label: 'Producing', tone: 'ok' }], otherwise: { state: 'stopped', label: '', tone: '' } });
    for (const id of ['overview', 'energy', 'alarms']) {
      const ws = TEMPLATES.find((t) => t.id === id)!.build(ctx, 'Compressor', null);
      const st = ws.filter((w) => w.type === 'status' || w.type === 'timeline' || (w.type === 'donut' && w.settings.donutMode === 'state'));
      expect(st.length).toBeGreaterThan(0);
      for (const w of st) {
        expect(w.keys).toEqual(['mode']);
        expect(w.settings.colorRules).toBeUndefined();
      }
    }
    // the timeline / donut then use the model's words and colours
    const map = modelStateMap({}, [], 'Compressor', 'Pune Compressor 1', 'mode')!;
    expect(map('RUN')).toEqual({ label: 'Producing', color: machine.TONE_COLOR.ok });
    expect(map('X')!.label).toBe('Stopped');
    // a widget with its own rules keeps them
    expect(modelStateMap({ colorRules: [{ op: 'eq', value: 'RUN', color: '#000000' }] } as any, [{ op: 'eq', value: 'RUN', color: '#000000' }] as any, 'Compressor', 'x', 'mode')).toBeNull();
  });

  it('no status tag set: an automatic run key the type sends', async () => {
    const ctx = await admin();
    await setModel({ key: '', mode: 'auto' });
    const ws = TEMPLATES.find((t) => t.id === 'overview')!.build(ctx, 'Compressor', null);
    expect(ws.find((w) => w.type === 'status')!.keys).toEqual(['runStatus']);
  });
});
