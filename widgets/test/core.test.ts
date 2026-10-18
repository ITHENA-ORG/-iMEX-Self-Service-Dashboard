import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeTB, ithena, asUser, ROOT, RIC, PUN } from './fake-tb';
import * as scope from '../src/core/scope';
import * as store from '../src/core/store';
import * as chat from '../src/core/chat';
import { Dashboard, checkDashboard } from '../src/core/schema';
import { resolveCollisions, firstFit, compactLayout } from '../src/render/grid';

let tb: FakeTB;
const mem = new Map<string, string>();
beforeEach(() => {
  tb = ithena();
  mem.clear();
  mem.set('jwt_token', 'x');
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
});

const widget = (over: any = {}) => ({ id: 'w1', type: 'value', title: 'P', x: 0, y: 0, w: 3, h: 2, binding: { mode: 'current' }, keys: ['dischargePressure'], settings: {}, ...over });

async function ctxFor(role: string, nodes: string[]) {
  asUser(tb, `u-${role}`, role, nodes);
  return scope.loadUserContext();
}

describe('legacy selectedNodes (production shape, read by the access core, D-050)', () => {
  it('a name-only entry is matched by name, then by label, among the customer assets', async () => {
    tb.me = { ...tb.me, id: { id: 'u-names' } };
    tb.setAttrs('USER', 'u-names', { Role: 'Viewer', selectedNodes: JSON.stringify([{ ID: 'ITHENA_Pune', categoryId: 'x', name: 'Pune' }, { name: 'Nowhere' }]) });
    const ctx = await scope.loadUserContext();
    expect(ctx.access.source).toBe('legacy');
    expect(scope.allDevices(ctx).map((d) => d.id).sort()).toEqual(['pc', 'pw']);
    expect(ctx.warnings.join()).toContain('"Nowhere" was not found');
  });
});

describe('user scope', () => {
  it('Pune viewer sees only the Pune subtree', async () => {
    const ctx = await ctxFor('Viewer', ['pun']);
    expect(ctx.isAdmin).toBe(false);
    expect(ctx.canBuild).toBe(false);
    expect(scope.allDevices(ctx).map((d) => d.name).sort()).toEqual(['PUN-COMP-01', 'PUN-WS-01']);
    expect(scope.isGrantedMachine(ctx, 'rc')).toBe(false);
    expect(scope.isGrantedMachine(ctx, 'pc')).toBe(true);
    expect(ctx.store?.id).toBe('store');
  });
  it('Admin role (production value "Admin") is admin; tree queries work', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    expect(ctx.isAdmin).toBe(true);
    expect(scope.devicesUnder(ctx, ROOT, 'Compressor').map((d) => d.id).sort()).toEqual(['pc', 'rc']);
    expect(scope.siblings(ctx, 'rc', 'Dryer').map((d) => d.id)).toEqual(['rd']);
    expect(scope.nearest(ctx, 'pc', 'Weather Station')?.id).toBe('pw');
    expect(scope.pathLabel(ctx, 'pc')).toBe('ITHENA › Pune › Pune Compressor 1');
  });
});

describe('dashboard store, apply and resolution precedence', () => {
  const mk = (ctx: scope.UserContext, name: string, profile = 'Compressor'): Dashboard => ({ ...store.blankDashboard(ctx, name, profile), widgets: [widget() as any] });

  it('saves with versioning and rejects stale saves', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const v1 = await store.saveDashboard(ctx, mk(ctx, 'A'));
    expect(v1.version).toBe(1);
    const v2 = await store.saveDashboard(ctx, { ...v1, name: 'A2' });
    expect(v2.version).toBe(2);
    await expect(store.saveDashboard(ctx, { ...v1, name: 'stale' })).rejects.toBeInstanceOf(store.ConflictError);
    const hist = await store.versions(ctx, v1.id);
    expect(hist[0].version).toBe(1);
    const restored = await store.restoreVersion(ctx, v1.id, 1);
    expect(restored.name).toBe('A');
    expect(restored.version).toBe(3);
  });

  it('customer-wide template applies to every compressor, including one added later', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const t = await store.saveDashboard(ctx, mk(ctx, 'Compressor template'));
    await store.apply(ctx, t, { type: 'customer', profile: 'Compressor' });
    for (const d of ['rc', 'pc']) {
      const r = await store.resolveForDevice(ctx, d, 'Compressor');
      expect(r.dashboard?.id).toBe(t.id);
      expect(r.level).toBe('customer');
    }
    tb.add({ id: 'cc', entityType: 'DEVICE', name: 'CHN-COMP-01', label: 'Chennai Compressor 1', type: 'Compressor' }, 'root');
    const r = await store.resolveForDevice(ctx, 'cc', 'Compressor');
    expect(r.dashboard?.id).toBe(t.id);
  });

  it('precedence: personal > device > nearest node > customer > default', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cw = await store.saveDashboard(ctx, mk(ctx, 'customer'));
    const site = await store.saveDashboard(ctx, mk(ctx, 'site'));
    const org = await store.saveDashboard(ctx, mk(ctx, 'org'));
    const dev = await store.saveDashboard(ctx, mk(ctx, 'device'));
    const mine = await store.saveDashboard(ctx, mk(ctx, 'mine'));
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).level).toBe('default');
    await store.apply(ctx, cw, { type: 'customer', profile: 'Compressor' });
    await store.apply(ctx, org, { type: 'node', nodeId: ROOT, profile: 'Compressor' });
    await store.apply(ctx, site, { type: 'node', nodeId: PUN, profile: 'Compressor' });
    let r = await store.resolveForDevice(ctx, 'pc', 'Compressor');
    expect(r.dashboard?.name).toBe('site'); // nearest ancestor wins
    expect(r.sourceLabel).toContain('Pune');
    expect(r.candidates.map((c) => c.dashboard.name)).toEqual(['site', 'org', 'customer']);
    await store.apply(ctx, dev, { type: 'devices', deviceIds: ['pc'], mode: 'linked' });
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).dashboard?.name).toBe('device');
    await store.apply(ctx, mine, { type: 'personal', deviceId: 'pc' });
    r = await store.resolveForDevice(ctx, 'pc', 'Compressor');
    expect(r.dashboard?.name).toBe('mine');
    expect(r.level).toBe('personal');
    // the Richmond compressor is unaffected by the Pune assignment
    expect((await store.resolveForDevice(ctx, 'rc', 'Compressor')).dashboard?.name).toBe('org');
  });

  it('customise stops following the template; reset falls back', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const t = await store.saveDashboard(ctx, mk(ctx, 'template'));
    await store.apply(ctx, t, { type: 'customer', profile: 'Compressor' });
    const copy = await store.customise(ctx, 'pc', t);
    await store.saveDashboard(ctx, { ...t, name: 'template v2' });
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).dashboard?.id).toBe(copy.id);
    expect((await store.resolveForDevice(ctx, 'rc', 'Compressor')).dashboard?.name).toBe('template v2');
    const u = await store.usage(ctx, { ...t, version: 2 });
    expect(u.customised).toEqual(['Pune Compressor 1']);
    await store.resetDevice(ctx, 'pc');
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).dashboard?.name).toBe('template v2');
    expect(await store.getDashboard(ctx, copy.id)).toBeNull();
  });

  it('copy mode gives each machine its own dashboard', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const t = await store.saveDashboard(ctx, mk(ctx, 'base'));
    await store.apply(ctx, t, { type: 'devices', deviceIds: ['pc', 'rc'], mode: 'copy' });
    const a = await store.resolveForDevice(ctx, 'pc', 'Compressor');
    const b = await store.resolveForDevice(ctx, 'rc', 'Compressor');
    expect(a.dashboard!.id).not.toBe(b.dashboard!.id);
    expect(a.dashboard!.copiedFrom).toBe(t.id);
  });

  it('a role without dashboards.applyMany can only apply to a single granted machine', async () => {
    const ctx = await ctxFor('Manager', ['ric']);
    const t = await store.saveDashboard(ctx, mk(ctx, 'mgr'));
    expect(store.canApply(ctx, { type: 'devices', deviceIds: ['rc'], mode: 'linked' })).toBeNull();
    expect(store.canApply(ctx, { type: 'devices', deviceIds: ['pc'], mode: 'linked' })).toMatch(/outside/);
    expect(store.canApply(ctx, { type: 'devices', deviceIds: ['rc', 'rd'], mode: 'linked' })).toMatch(/role/i);
    expect(store.canApply(ctx, { type: 'customer', profile: 'Compressor' })).toMatch(/role/i);
    await expect(store.apply(ctx, t, { type: 'node', nodeId: RIC, profile: 'Compressor' })).rejects.toThrow(/role/i);
  });

  it('admin scoped to one site cannot assign customer-wide', async () => {
    const ctx = await ctxFor('Admin', ['pun']);
    expect(store.canApply(ctx, { type: 'customer', profile: 'Compressor' })).toMatch(/whole organisation/);
    expect(store.canApply(ctx, { type: 'node', nodeId: PUN, profile: 'Compressor' })).toBeNull();
  });

  it('preview reports replacements, own dashboards, same-level replace and missing keys', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const a = await store.saveDashboard(ctx, { ...mk(ctx, 'A'), widgets: [widget({ keys: ['powerKw'] }) as any] });
    const b = await store.saveDashboard(ctx, mk(ctx, 'B'));
    await store.apply(ctx, b, { type: 'customer', profile: 'Compressor' });
    await store.apply(ctx, b, { type: 'devices', deviceIds: ['rc'], mode: 'linked' });
    const pv = await store.previewApply(ctx, a, { type: 'customer', profile: 'Compressor' });
    expect(pv.affected.length).toBe(2);
    expect(pv.replacesAssignment?.name).toBe('B');
    expect(pv.keepOwn.map((x) => x.id)).toEqual(['rc']);
    expect(pv.replaced.map((x) => x.id)).toEqual(['pc']);
    expect(pv.missingKeys).toEqual([{ key: 'powerKw', devices: ['Pune Compressor 1'] }]);
  });

  it('deleting a dashboard removes its assignments so machines fall back', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cw = await store.saveDashboard(ctx, mk(ctx, 'cw'));
    const site = await store.saveDashboard(ctx, mk(ctx, 'site'));
    await store.apply(ctx, cw, { type: 'customer', profile: 'Compressor' });
    await store.apply(ctx, site, { type: 'node', nodeId: PUN, profile: 'Compressor' });
    const affected = await store.deleteDashboard(ctx, site);
    expect(affected.join()).toContain('Pune');
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).dashboard?.name).toBe('cw');
  });

  it('private dashboards are hidden from other users', async () => {
    const admin = await ctxFor('Admin', ['root']);
    const d = await store.saveDashboard(admin, mk(admin, 'secret'), 'private');
    expect((await store.listDashboards(admin)).map((x) => x.id)).toContain(d.id);
    const viewer = await ctxFor('Viewer', ['pun']);
    expect((await store.listDashboards(viewer)).map((x) => x.id)).not.toContain(d.id);
  });
});

describe('chat operations', () => {
  const out = (ops: any[], extra: any = {}) => chat.normaliseToolInput({ reply: 'ok', ops, ...extra });

  it('builds a 4-widget draft with auto layout from aliases', async () => {
    const ctx = await ctxFor('Manager', ['ric']);
    const cat = chat.buildCatalog(ctx);
    const rcA = cat.byId.get('rc')!;
    const rdA = cat.byId.get('rd')!;
    const d0 = store.blankDashboard(ctx, 'x', null);
    const res = chat.applyOps(
      ctx,
      d0,
      out([
        { op: 'addWidget', type: 'line', title: 'Trend', binding: { mode: 'fixed', machines: [rcA] }, keys: ['dischargePressure'] },
        { op: 'addWidget', type: 'value', title: 'P', binding: { mode: 'fixed', machines: [rcA] }, keys: ['dischargePressure'] },
        { op: 'addWidget', type: 'value', title: 'Dew', binding: { mode: 'fixed', machines: [rdA] }, keys: ['dewPoint'] },
        { op: 'addWidget', type: 'alarms', title: 'Alarms', binding: { mode: 'fixed', machines: [rcA, rdA] }, keys: [] },
      ]),
      cat,
    );
    expect(res.draft.widgets.length).toBe(4);
    const byT = Object.fromEntries(res.draft.widgets.map((w) => [w.type + w.title, w]));
    expect(byT.valueP.y).toBe(0); // cards on top
    expect(byT.lineTrend.y).toBeGreaterThanOrEqual(2); // chart below
    expect(byT.lineTrend.w).toBe(12);
    expect(res.draft.kind).toBe('standalone');
    expect(checkDashboard(res.draft)).toEqual([]);
  });

  it('rejects unknown keys and aliases (so the retry path triggers)', async () => {
    const ctx = await ctxFor('Viewer', ['pun']);
    const cat = chat.buildCatalog(ctx);
    const d0 = { ...store.blankDashboard(ctx, 'x', 'Compressor') };
    expect(() => chat.applyOps(ctx, d0, out([{ op: 'addWidget', type: 'gauge', title: 'Vib', binding: { mode: 'current' }, keys: ['vibration'] }]), cat)).toThrow(chat.OpsError);
    expect(() => chat.applyOps(ctx, d0, out([{ op: 'addWidget', type: 'value', title: 'x', binding: { mode: 'fixed', machines: ['D99'] }, keys: ['dischargePressure'] }]), cat)).toThrow(/unknown machine/);
  });

  it('Pune viewer catalog contains no Richmond entities', async () => {
    const ctx = await ctxFor('Viewer', ['pun']);
    const cat = chat.buildCatalog(ctx);
    expect(cat.text).not.toMatch(/Richmond|RIC-/);
    expect([...cat.devAlias.values()].sort()).toEqual(['pc', 'pw']);
  });

  it('out-of-scope ids in a shared draft are masked in the prompt', async () => {
    const ctx = await ctxFor('Viewer', ['pun']);
    const cat = chat.buildCatalog(ctx);
    const d = { ...store.blankDashboard(ctx, 'shared', null), widgets: [widget({ binding: { mode: 'fixed', deviceIds: ['rc'] } })] } as any;
    const p = JSON.stringify(chat.draftForPrompt(d, cat));
    expect(p).toContain('OUTSIDE_ACCESS');
    expect(p).not.toContain('rc"');
  });

  it('update / remove only touch the targeted widget', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cat = chat.buildCatalog(ctx);
    const d0 = { ...store.blankDashboard(ctx, 'x', 'Compressor'), widgets: [widget({ id: 'a' }), widget({ id: 'b', x: 3, keys: ['dischargeTemp'], title: 'T' })] } as any;
    const r = chat.applyOps(ctx, d0, out([{ op: 'addWidget', type: 'gauge', title: 'Dew', binding: { mode: 'nearest', machineType: 'Dryer' }, keys: ['dewPoint'] }]), cat);
    expect(r.draft.widgets.slice(0, 2)).toEqual(d0.widgets);
    const r2 = chat.applyOps(ctx, r.draft, out([{ op: 'removeWidget', widget: 'W2' }]), cat);
    expect(r2.draft.widgets.map((w) => w.id)).toEqual(['a', r.draft.widgets[2].id]);
  });

  it('a role without dashboards.applyMany asking to apply customer-wide gets a warning, no proposal', async () => {
    const ctx = await ctxFor('Manager', ['ric']);
    const cat = chat.buildCatalog(ctx);
    const r = chat.applyOps(ctx, store.blankDashboard(ctx, 'x', 'Compressor'), out([{ op: 'setApplyTarget', target: 'customer' }]), cat);
    expect(r.applyProposal).toBeNull();
    expect(r.warnings.join()).toMatch(/role/);
  });

  it('chatTurn retries once with the validation errors, then gives up without touching the draft', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const bad = { reply: 'x', ops: [{ op: 'addWidget', type: 'value', title: 'v', binding: { mode: 'current' }, keys: ['nope'] }] };
    const good = { reply: 'Added', ops: [{ op: 'addWidget', type: 'value', title: 'v', binding: { mode: 'current' }, keys: ['dischargeTemp'] }] };
    const sent: any[] = [];
    const t1: chat.Transport = { send: async (b) => (sent.push(b), { toolInput: sent.length === 1 ? bad : good }) };
    const d0 = store.blankDashboard(ctx, 'x', 'Compressor');
    const r = await chat.chatTurn(ctx, t1, d0, [], 'add temp', 'rc');
    expect(r.attempts).toBe(2);
    expect(JSON.stringify(sent[1].messages)).toContain('previous answer was invalid');
    expect(r.draft.widgets.length).toBe(1);
    const t2: chat.Transport = { send: async () => ({ toolInput: bad }) };
    await expect(chat.chatTurn(ctx, t2, d0, [], 'add', 'rc')).rejects.toThrow(/couldn't build/);
    expect(d0.widgets.length).toBe(0);
  });

  it('clarification returns buttons and leaves the draft unchanged', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const t: chat.Transport = { send: async () => ({ toolInput: { reply: '', ops: [], clarification: { question: 'Which compressor?', options: ['Richmond Compressor 1', 'Pune Compressor 1'] } } }) };
    const d0 = store.blankDashboard(ctx, 'x', null);
    const r = await chat.chatTurn(ctx, t, d0, [], 'show the compressor', null);
    expect(r.clarification?.options.length).toBe(2);
    expect(r.draft).toBe(d0);
  });
});

describe('chat D-024: role requests, guard rails, mixed equipment, lenient apply', () => {
  const T = (answers: any[]): chat.Transport & { sent: any[] } => {
    const sent: any[] = [];
    return { sent, send: async (b) => (sent.push(b), { toolInput: answers[Math.min(sent.length - 1, answers.length - 1)] }) };
  };

  it('an empty clarification object ({} or empty question) is not an error', () => {
    const o1 = chat.normaliseToolInput({ reply: 'ok', ops: [], clarification: {} });
    const o2 = chat.normaliseToolInput({ reply: 'ok', ops: [], clarification: { question: '', options: [] } });
    expect(o1.clarification).toBeNull();
    expect(o2.clarification).toBeNull();
  });

  it('a "where should I build it" question without a clarification object still gets the three buttons', () => {
    const o = chat.normaliseToolInput({ intent: 'clarify', reply: 'Where should I build your new fleet overview dashboard?', ops: [] });
    expect(o.clarification?.options).toEqual(['Start a new dashboard', 'Replace this dashboard', 'Add to this dashboard']);
  });

  it('small-model slips are tolerated: add then refine by the new W alias, updateWidget without widget, name/title swaps', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cat = chat.buildCatalog(ctx);
    const rc = cat.byId.get('rc')!;
    const d0 = store.blankDashboard(ctx, 'x', null);
    const r = chat.applyOps(
      ctx,
      d0,
      chat.normaliseToolInput({
        reply: '',
        ops: [
          { op: 'startNewDashboard', title: 'Ops board' },
          { op: 'addWidget', type: 'line' },
          { op: 'updateWidget', widget: 'W1', keys: ['dischargePressure'], binding: { mode: 'fixed', machines: [rc] } },
          { op: 'addWidget', type: 'gauge', widget: 'W2' },
          { op: 'updateWidget', name: 'Temp', keys: ['dischargeTemp'], binding: { mode: 'fixed', machines: [rc] } },
        ],
      }),
      cat,
    );
    expect(r.draft.name).toBe('Ops board');
    expect(r.draft.widgets.map((w) => [w.type, w.title, w.keys[0]])).toEqual(
      expect.arrayContaining([
        ['line', '', 'dischargePressure'],
        ['gauge', 'Temp', 'dischargeTemp'],
      ]),
    );
  });

  it('rewriting one widget to several data sources in one answer is rejected (would silently keep only the last)', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cat = chat.buildCatalog(ctx);
    const [rc, rd] = [cat.byId.get('rc')!, cat.byId.get('rd')!];
    const ops = [
      { op: 'addWidget', type: 'line', title: 'Mix' },
      { op: 'updateWidget', widget: 'W1', keys: ['dischargePressure'], binding: { mode: 'fixed', machines: [rc] } },
      { op: 'updateWidget', widget: 'W1', keys: ['dewPoint'], binding: { mode: 'fixed', machines: [rd] } },
    ];
    expect(() => chat.applyOps(ctx, store.blankDashboard(ctx, 'x', null), chat.normaliseToolInput({ reply: '', ops }), cat)).toThrow(/several different data sources/);
  });

  it('a help answer never changes the draft, even with ops attached', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const d0 = store.blankDashboard(ctx, 'x', 'Compressor');
    const r = await chat.chatTurn(ctx, T([{ intent: 'help', reply: 'Use Apply to…', ops: [{ op: 'setApplyTarget', target: 'node' }] }]), d0, [], 'how do I apply?', 'rc');
    expect([r.intent, r.draft, r.attempts]).toEqual(['help', d0, 1]);
  });

  it('where-guard: a machine dashboard with widgets is not cleared or replaced before the user chooses', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cat = chat.buildCatalog(ctx);
    const root = cat.byId.get(ROOT)!;
    const d0 = { ...store.blankDashboard(ctx, 'Compressor V1', 'Compressor'), version: 2, widgets: [widget({ id: 'a' })] } as any;
    const ans = {
      intent: 'build',
      reply: 'Overview built.',
      ops: [
        { op: 'clearWidgets' },
        { op: 'addWidget', type: 'table', title: 'Compressors', binding: { mode: 'nodeQuery', node: root, machineType: 'Compressor' }, keys: ['runStatus'] },
        { op: 'addWidget', type: 'alarms', title: 'Alarms', binding: { mode: 'nodeQuery', node: root, machineType: 'ALL' }, keys: [] },
      ],
    };
    const r = await chat.chatTurn(ctx, T([ans]), d0, [], 'I am the CEO, overview of everything', 'rc');
    expect(r.clarification?.options).toEqual([...chat.WHERE_OPTIONS]);
    expect(r.draft).toBe(d0);
    const nw = chat.applyWhere(ctx, d0, r.pending!, 'Start a new dashboard');
    expect([nw.newDashboard, nw.draft.version, nw.draft.widgets.filter((w) => ['Compressors', 'Alarms'].includes(w.title)).length]).toEqual([true, 0, 2]);
    const rp = chat.applyWhere(ctx, d0, r.pending!, 'Replace this dashboard');
    expect([rp.draft.id, rp.draft.widgets.filter((w) => ['Compressors', 'Alarms'].includes(w.title)).length, rp.draft.widgets.some((w) => w.id === 'a')]).toEqual([d0.id, 2, false]);
    const ad = chat.applyWhere(ctx, d0, r.pending!, 'Add to this dashboard');
    expect(ad.draft.widgets.map((w) => w.id)).toContain('a');
    expect(ad.draft.widgets.length).toBe(3);
    // said where already -> no question
    const r2 = await chat.chatTurn(ctx, T([ans]), d0, [], 'Replace this dashboard with a CEO overview', 'rc');
    expect(r2.clarification ?? null).toBeNull();
    expect(r2.draft.widgets.filter((w) => ['Compressors', 'Alarms'].includes(w.title)).length).toBe(2);
  });

  it('help answers that offer to add a widget get yes/no buttons; title inside settings is moved out', () => {
    const o = chat.normaliseToolInput({ intent: 'help', reply: 'I cannot see live data. Would you like me to add a value card?', ops: [] });
    expect(o.clarification?.options).toEqual(['Yes, add it', 'No thanks']);
    const o2 = chat.normaliseToolInput({ reply: '', ops: [{ op: 'addWidget', type: 'line', settings: '{"title":"Trend","timeRange":"1h"}' }] });
    expect((o2.ops[0] as any).title).toBe('Trend');
    expect((o2.ops[0] as any).settings.title).toBeUndefined();
    const o3 = chat.normaliseToolInput({ reply: '', ops: [{ op: 'addWidget', type: 'table', title: 't', machineType: 'Dryer', binding: { mode: 'nodeQuery', node: 'N1' }, keys: ['dewPoint'] }] });
    expect((o3.ops[0] as any).binding).toEqual({ mode: 'nodeQuery', node: 'N1', machineType: 'Dryer' });
  });

  it('startNewDashboard gives a new unsaved standalone draft; the old one is untouched', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cat = chat.buildCatalog(ctx);
    const d0 = { ...store.blankDashboard(ctx, 'Dryer dashboard (V1)', 'Dryer'), version: 3, widgets: [widget({ id: 'a', keys: ['dewPoint'], binding: { mode: 'current' } })] } as any;
    const root = cat.byId.get(ROOT)!;
    const r = chat.applyOps(
      ctx,
      d0,
      chat.normaliseToolInput({
        intent: 'build',
        reply: 'Built a fleet overview.',
        ops: [
          { op: 'startNewDashboard', name: 'Fleet overview' },
          { op: 'addWidget', type: 'table', title: 'Compressors', binding: { mode: 'nodeQuery', node: root, machineType: 'Compressor' }, keys: ['runStatus', 'dischargePressure'] },
          { op: 'addWidget', type: 'alarms', title: 'All alarms', binding: { mode: 'nodeQuery', node: root, machineType: 'ALL' }, keys: [] },
        ],
      }),
      cat,
    );
    expect(r.newDashboard).toBe(true);
    expect(r.draft.id).not.toBe(d0.id);
    expect([r.draft.version, r.draft.name, r.draft.kind, r.draft.profile]).toEqual([0, 'Fleet overview', 'standalone', null]);
    expect(r.draft.widgets.map((w) => w.type)).toEqual(expect.arrayContaining(['table', 'alarms']));
    expect(r.draft.widgets.find((w) => w.type === 'alarms')!.binding).toEqual({ mode: 'nodeQuery', nodeId: ROOT, profile: '' });
    expect(d0.widgets.length).toBe(1);
  });

  it('startNewDashboard must come first; ALL machine types only for alarm lists', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cat = chat.buildCatalog(ctx);
    const d0 = store.blankDashboard(ctx, 'x', null);
    const root = cat.byId.get(ROOT)!;
    expect(() => chat.applyOps(ctx, d0, chat.normaliseToolInput({ reply: '', ops: [{ op: 'setTimeRange', range: '8h' }, { op: 'startNewDashboard', name: 'n' }] }), cat)).toThrow(/first op/);
    expect(() => chat.applyOps(ctx, d0, chat.normaliseToolInput({ reply: '', ops: [{ op: 'addWidget', type: 'table', title: 't', binding: { mode: 'nodeQuery', node: root, machineType: 'ALL' }, keys: ['runStatus'] }] }), cat)).toThrow(/only works for an alarm list/);
  });

  it('clearWidgets replaces this dashboard (same id, new widgets)', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cat = chat.buildCatalog(ctx);
    const d0 = { ...store.blankDashboard(ctx, 'd', 'Compressor'), widgets: [widget({ id: 'a' }), widget({ id: 'b', x: 3 })] } as any;
    const r = chat.applyOps(ctx, d0, chat.normaliseToolInput({ reply: '', ops: [{ op: 'clearWidgets' }, { op: 'addWidget', type: 'gauge', title: 'T', binding: { mode: 'current' }, keys: ['dischargeTemp'] }] }), cat);
    expect(r.draft.id).toBe(d0.id);
    expect(r.draft.widgets.map((w) => w.title)).toEqual(['T']);
    expect(r.changed.removed.length).toBe(2);
    expect(r.newDashboard).toBe(false);
  });

  it('a widget cannot mix keys of different machine types; the catalogue lists shared keys', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cat = chat.buildCatalog(ctx);
    expect(Object.keys(JSON.parse(cat.text).sharedKeys)).not.toContain('dischargePressure');
    const [rc, rd] = [cat.byId.get('rc')!, cat.byId.get('rd')!];
    const d0 = store.blankDashboard(ctx, 'x', null);
    expect(() => chat.applyOps(ctx, d0, chat.normaliseToolInput({ reply: '', ops: [{ op: 'addWidget', type: 'line', title: 'Mix', binding: { mode: 'fixed', machines: [rc, rd] }, keys: ['dischargePressure', 'dewPoint'] }] }), cat)).toThrow(/Dryer has no propert/);
  });

  it('help / refuse answers with no ops leave the draft unchanged and keep the intent', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const d0 = store.blankDashboard(ctx, 'x', 'Compressor');
    const r = await chat.chatTurn(ctx, T([{ intent: 'refuse', reply: 'I can only help with dashboards in this builder.', ops: [] }]), d0, [], 'Write me a poem', 'rc');
    expect([r.intent, r.draft, r.attempts]).toEqual(['refuse', d0, 1]);
  });

  it('after a failed retry the valid ops are applied and the invalid ones reported (lenient)', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const bad = {
      intent: 'build',
      reply: 'Overview built.',
      ops: [
        { op: 'addWidget', type: 'value', title: 'Temp', binding: { mode: 'current' }, keys: ['dischargeTemp'] },
        { op: 'addWidget', type: 'gauge', title: 'Vibration', binding: { mode: 'current' }, keys: ['vibration'] },
        { op: 'addWidget', type: 'nonsense', title: 'X' },
      ],
    };
    const t = T([bad, bad]);
    const d0 = store.blankDashboard(ctx, 'x', 'Compressor');
    const r = await chat.chatTurn(ctx, t, d0, [], 'overview', 'rc');
    expect(r.attempts).toBe(2);
    expect(r.draft.widgets.map((w) => w.title)).toEqual(['Temp']);
    expect(r.skipped!.join(' ')).toMatch(/Vibration.*no property vibration/);
    expect(r.skipped!.join(' ')).toMatch(/unreadable/);
  });

  it('when nothing is valid the error names the reason', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const bad = { reply: 'x', ops: [{ op: 'addWidget', type: 'gauge', title: 'Vibration', binding: { mode: 'current' }, keys: ['vibration'] }] };
    await expect(chat.chatTurn(ctx, T([bad]), store.blankDashboard(ctx, 'x', 'Compressor'), [], 'x', 'rc')).rejects.toThrow(/couldn't build that: Compressor has no property vibration/);
  });

  it('problems the draft already had do not block the model', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    // a stored widget with a property the catalogue no longer has
    const d0 = { ...store.blankDashboard(ctx, 'x', 'Compressor'), widgets: [widget({ id: 'old', type: 'gauge', keys: ['runStatus'] })] } as any;
    const good = { reply: 'ok', ops: [{ op: 'addWidget', type: 'value', title: 'T', binding: { mode: 'current' }, keys: ['dischargeTemp'] }] };
    const r = await chat.chatTurn(ctx, T([good]), d0, [], 'add temp', 'rc');
    expect(r.attempts).toBe(1);
    expect(r.draft.widgets.length).toBe(2);
  });

  it('the prompt carries the guard rails, role presets and the where-to-build question', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cat = chat.buildCatalog(ctx);
    const p = chat.systemPrompt(ctx, cat, null);
    expect(p).toMatch(/Everything else is out of scope/);
    expect(p).toMatch(/Start a new dashboard", "Replace this dashboard", "Add to this dashboard"/);
    expect(p).toMatch(/Executive \/ CEO/);
    expect(p).toMatch(/you cannot see values/);
    expect((chat.TOOL.input_schema as any).required).toContain('intent');
  });
});

describe('grid', () => {
  it('pushes overlapping widgets down and compacts', () => {
    const items = [
      { id: 'a', x: 0, y: 0, w: 6, h: 2 },
      { id: 'b', x: 6, y: 0, w: 6, h: 2 },
      { id: 'c', x: 0, y: 2, w: 12, h: 2 },
    ];
    const moved = resolveCollisions(items.map((i) => (i.id === 'c' ? { ...i, y: 0 } : i)), 'c');
    const c = moved.find((i) => i.id === 'c')!;
    expect(c.y).toBe(0);
    for (const o of moved.filter((i) => i.id !== 'c')) expect(o.y).toBeGreaterThanOrEqual(2);
  });
  it('first fit fills gaps', () => {
    expect(firstFit([{ x: 0, y: 0, w: 3, h: 2 }], 3, 2)).toEqual({ x: 3, y: 0 });
    expect(firstFit([{ x: 0, y: 0, w: 12, h: 2 }], 3, 2)).toEqual({ x: 0, y: 2 });
  });
  it('compact layout halves the columns without overlaps or zero widths', () => {
    const items = [
      { id: 'a', x: 0, y: 0, w: 1, h: 2 },
      { id: 'b', x: 1, y: 0, w: 3, h: 2 },
      { id: 'c', x: 4, y: 0, w: 8, h: 2 },
      { id: 'd', x: 11, y: 2, w: 1, h: 3 },
      { id: 'e', x: 0, y: 2, w: 12, h: 2 },
    ];
    const out = compactLayout(items);
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const i of out) {
      expect(i.w).toBeGreaterThanOrEqual(1);
      expect(i.x + i.w).toBeLessThanOrEqual(6);
      expect(i.h).toBe(items.find((o) => o.id === i.id)!.h);
    }
    expect(out.some((a, i) => out.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h))).toBe(false);
    expect(out.find((i) => i.id === 'e')!.w).toBe(6);
  });
});

describe('design pass for chat-built dashboards (D-026)', () => {
  const overlaps = (ws: any[]) => ws.some((a, i) => ws.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
  // every row band is fully used: for each widget, the widgets sharing its top edge fill 12 columns
  const fullRows = (ws: any[]) => [...new Set(ws.map((w) => w.y))].every((y) => ws.filter((w) => w.y === y).reduce((s, w) => s + w.w, 0) === 12);

  async function ceo() {
    const ctx = await ctxFor('Admin', ['root']);
    const root = chat.buildCatalog(ctx).byId.get(ROOT)!;
    const ans = {
      intent: 'build',
      reply: 'Built.',
      ops: [
        { op: 'startNewDashboard', name: 'CEO overview' },
        { op: 'addWidget', type: 'text', title: 'Header', binding: { mode: 'none' }, keys: [], settings: { html: '<p>ITHENA fleet</p>' } },
        { op: 'addWidget', type: 'table', title: 'Compressors', binding: { mode: 'nodeQuery', node: root, machineType: 'Compressor' }, keys: ['runStatus', 'dischargePressure'] },
        { op: 'addWidget', type: 'table', title: 'Dryers', binding: { mode: 'nodeQuery', node: root, machineType: 'Dryer' }, keys: [] },
        { op: 'addWidget', type: 'alarms', title: 'Alarms', binding: { mode: 'nodeQuery', node: root, machineType: 'ALL' }, keys: [] },
      ],
    };
    return { ctx, ans };
  }
  const T = (answers: any[]): chat.Transport => ({ send: async () => ({ toolInput: answers.shift() }) });

  it('sizes tables to their rows, adds a banner, colours types and leaves no gaps or overlaps', async () => {
    const { ctx, ans } = await ceo();
    const d0 = store.blankDashboard(ctx, 'x', null as any);
    const cat = chat.buildCatalog(ctx);
    const dry = cat.profiles['Dryer']?.[0]?.key;
    (ans.ops[3] as any).keys = dry ? [dry] : ['runStatus'];
    const r = await chat.chatTurn(ctx, T([ans]), d0, [], 'I am the CEO, overview of everything', null);
    expect(r.fresh).toBe(true);
    const ws = r.draft.widgets;
    const banner = ws.find((w) => w.type === 'text')!;
    expect(banner.settings.style?.gradient).toBe(true);
    expect(banner.settings.html).toMatch(/ITHENA fleet/);
    // D-053: the counts are placeholders, filled per viewer (the CEO here sees all 4)
    expect(banner.settings.html).toMatch(/\{\{machines\}\} · \{\{locations\}\} · live/);
    expect((await import('../src/render/widgets')).fleetCounts({ ctx, deviceId: null, timeRange: '1h' }, ws).machines).toBe(4);
    expect([banner.x, banner.y, banner.w, banner.h]).toEqual([0, 0, 12, 2]);
    const comp = ws.find((w) => w.title === 'Compressors')!;
    expect(comp.h).toBeLessThanOrEqual(3); // 2 machines: header + 2 lines
    expect(comp.settings.colorRules?.[0]).toMatchObject({ op: 'isTrue', key: 'runStatus', label: 'Running' });
    expect(comp.settings.style?.accentBar).toBeTruthy();
    expect(ws.find((w) => w.title === 'Dryers')!.settings.style?.accentBar).not.toBe(comp.settings.style?.accentBar);
    expect(r.draft.theme?.preset).toBe('ocean');
    expect(overlaps(ws)).toBe(false);
    expect(fullRows(ws)).toBe(true);
    expect(ws.length).toBeLessThanOrEqual(10);
    expect(checkDashboard(r.draft)).toEqual([]);
  });

  it('adds Running/Stopped status cards for a fleet without cards, and nothing the model styled is overwritten', async () => {
    const { ctx, ans } = await ceo();
    (ans.ops[2] as any).settings = { style: { accentBar: '#123456' } };
    ans.ops.splice(3, 1);
    const r = await chat.chatTurn(ctx, T([ans]), store.blankDashboard(ctx, 'x', null as any), [], 'overview', null);
    const status = r.draft.widgets.filter((w) => w.type === 'status');
    expect(status.length).toBeGreaterThan(0);
    expect(status[0].settings.colorRules?.map((c) => c.label)).toEqual(['Running', 'Stopped']);
    expect(r.draft.widgets.find((w) => w.title === 'Compressors')!.settings.style).toEqual({ accentBar: '#123456' });
    expect(overlaps(r.draft.widgets)).toBe(false);
  });

  it('does not touch a dashboard the user adds to', async () => {
    const { ctx, ans } = await ceo();
    const d0 = { ...store.blankDashboard(ctx, 'Mine', null as any), widgets: [widget({ id: 'a', binding: { mode: 'fixed', deviceIds: ['rc'] } })] } as any;
    ans.ops.shift();
    const r = await chat.chatTurn(ctx, T([ans]), d0, [], 'add a fleet table', null);
    expect(r.fresh).toBe(false);
    expect(r.draft.theme ?? null).toBeNull();
    expect(r.draft.widgets.find((w) => w.id === 'a')).toMatchObject({ x: 0, y: 0, w: 3, h: 2 });
  });
});

describe('chat layout ops (D-029)', () => {
  const noOverlap = (ws: any[]) => !ws.some((a, i) => ws.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
  async function setup() {
    const ctx = await ctxFor('Admin', ['root']);
    const cat = chat.buildCatalog(ctx);
    const d0 = {
      ...store.blankDashboard(ctx, 'x', 'Compressor'),
      widgets: [
        widget({ id: 'a', x: 0, y: 0, w: 3, h: 2 }),
        widget({ id: 'b', x: 3, y: 0, w: 3, h: 2 }),
        widget({ id: 'c', type: 'line', x: 0, y: 2, w: 12, h: 4 }),
      ],
    } as any;
    return { ctx, cat, d0 };
  }
  it('moves and resizes with x/y/w/h; others make room; strings and out-of-range values are coerced', async () => {
    const { ctx, cat, d0 } = await setup();
    const out = chat.normaliseToolInput({ reply: '', ops: [{ op: 'updateWidget', widget: 'W3', x: '0', y: 0, w: 6 }, { op: 'updateWidget', widget: 'W1', w: 40, x: -3 }] });
    expect(out.ops[1]).toMatchObject({ w: 12, x: 0 });
    const r = chat.applyOps(ctx, d0, out, cat);
    const c = r.draft.widgets.find((w) => w.id === 'c')!;
    expect([c.x, c.y, c.w]).toEqual([0, 0, 6]);
    expect(r.draft.widgets.find((w) => w.id === 'a')!.w).toBe(12);
    expect(noOverlap(r.draft.widgets)).toBe(true);
  });
  it('arrangeLayout tidies the page into full rows', async () => {
    const { ctx, cat, d0 } = await setup();
    d0.widgets[1].y = 9;
    const r = chat.applyOps(ctx, d0, { reply: '', ops: [{ op: 'arrangeLayout' }] }, cat);
    expect(r.arranged).toBe(true);
    for (const y of new Set(r.draft.widgets.map((w) => w.y))) expect(r.draft.widgets.filter((w) => w.y === y).reduce((s, w) => s + w.w, 0)).toBe(12);
    expect(noOverlap(r.draft.widgets)).toBe(true);
  });
  it('new widgets are sized to their content: multi-value by its properties, table by its machines', async () => {
    const { ctx, cat, d0 } = await setup();
    const out = chat.normaliseToolInput({ reply: '', ops: [{ op: 'addWidget', type: 'multivalue', title: 'mv', binding: { mode: 'current' }, keys: ['dischargePressure', 'dischargeTemp', 'powerKw', 'runStatus'] }] });
    const r = chat.applyOps(ctx, d0, out, cat);
    expect(r.draft.widgets.find((w) => w.title === 'mv')!.h).toBeGreaterThanOrEqual(3);
  });
});

// ------------------------------------------------------------------ D-033

describe('D-033 state URL, data clock, wording', () => {
  it('decodes the state parameter, also when it is percent-encoded twice or lacks padding', async () => {
    const { decodeStateParam } = await import('../src/entries/common');
    const stack = [{ id: 'machine', params: { entityId: { id: 'pc', entityType: 'DEVICE' }, entityName: 'Pünë 1' } }];
    const b64 = Buffer.from(JSON.stringify(stack), 'utf8').toString('base64');
    const urlSafe = b64.replace(/\+/g, '-').replace(/\//g, '_');
    expect(decodeStateParam(urlSafe)).toEqual(stack);
    expect(decodeStateParam(urlSafe.replace(/=+$/, ''))).toEqual(stack);
    expect(decodeStateParam(encodeURIComponent(b64))).toEqual(stack);
    expect(decodeStateParam(encodeURIComponent(encodeURIComponent(b64)))).toEqual(stack);
    expect(decodeStateParam(b64.replace(/\+/g, ' '))).toEqual(stack);
    expect(decodeStateParam('not-a-state')).toBeNull();
  });

  it('data clock keeps the newest timestamp, caps future ones at now, resets', async () => {
    const api = await import('../src/core/api');
    api.resetDataClock();
    expect(api.lastDataTs()).toBe(0);
    api.noteData(1000, 5000, 3000);
    expect(api.lastDataTs()).toBe(5000);
    api.noteData(Date.now() + 3_600_000);
    expect(api.lastDataTs()).toBeLessThanOrEqual(Date.now());
    api.resetDataClock();
    expect(api.lastDataTs()).toBe(0);
  });

  it('latest() moves the data clock unless quiet', async () => {
    const api = await import('../src/core/api');
    api.resetDataClock();
    await api.latest('pc', ['dischargePressure'], true);
    expect(api.lastDataTs()).toBe(0);
    const l = await api.latest('pc', ['dischargePressure']);
    expect(api.lastDataTs()).toBe(l.dischargePressure!.ts);
  });

  it('agoWords', async () => {
    const { agoWords } = await import('../src/render/theme');
    const now = 10_000_000_000;
    expect(agoWords(now - 500, now)).toBe('just now');
    expect(agoWords(now - 2000, now)).toBe('2 seconds ago');
    expect(agoWords(now - 60_000, now)).toBe('1 minute ago');
    expect(agoWords(now - 3 * 3600e3, now)).toBe('3 hours ago');
    expect(agoWords(now - 2 * 86400e3, now)).toBe('2 days ago');
  });

  it('theme accepts an uploaded background image and a fit; rejects long web addresses', () => {
    const d = (theme: any) => Dashboard.safeParse({ schemaVersion: 1, id: 'd1', name: 'x', kind: 'standalone', profile: null, timeRange: 'realtime', widgets: [], ownerId: 'u', ownerName: 'u', version: 1, updatedAt: 1, updatedBy: 'u', copiedFrom: null, theme }).success;
    expect(d({ bgImage: 'data:image/png;base64,' + 'A'.repeat(50000), bgFit: 'tile' })).toBe(true);
    expect(d({ bgImage: 'https://x.test/' + 'a'.repeat(3000) })).toBe(false);
    expect(d({ bgFit: 'stretch' })).toBe(false);
  });
});

// D-073 (App UI U-102): a module the licence drops is gone from the Builder: the Alarm list without `alerts`
describe('module gates (D-073)', () => {
  const out = (ops: any[]) => chat.normaliseToolInput({ reply: 'ok', ops });
  const withLicence = (off: string[]) => {
    const w: any = new EventTarget();
    w.__imexLicence = { has: (k: string) => !off.includes(k) };
    vi.stubGlobal('window', w);
  };

  it('the chat leaves an alarm list out without alerts, and says nothing of alarms', async () => {
    const ctx = await ctxFor('Manager', ['ric']);
    const cat = chat.buildCatalog(ctx);
    const rcA = cat.byId.get('rc')!;
    const ops = [
      { op: 'addWidget', type: 'value', title: 'P', binding: { mode: 'fixed', machines: [rcA] }, keys: ['dischargePressure'] },
      { op: 'addWidget', type: 'alarms', title: 'Alarms', binding: { mode: 'fixed', machines: [rcA] }, keys: [] },
    ];
    withLicence(['alerts']);
    const res = chat.applyOps(ctx, store.blankDashboard(ctx, 'x', null), out(ops), cat);
    expect(res.draft.widgets.map((w) => w.type)).toEqual(['value']);
    expect(res.warnings.join(' ')).toMatch(/alarm list cannot be added/);
    expect(chat.systemPrompt(ctx, cat, null)).toMatch(/This app has no alarm list/);
    expect(chat.suggestedPrompts(ctx, null).join(' ')).not.toMatch(/Alarm/);
    // a type change to an alarm list is left out too
    const d1 = { ...store.blankDashboard(ctx, 'x', 'Compressor'), widgets: [widget()] } as any;
    const r2 = chat.applyOps(ctx, d1, out([{ op: 'updateWidget', widget: 'W1', type: 'alarms' }]), cat);
    expect(r2.draft.widgets[0].type).toBe('value');
    withLicence([]);
    const all = chat.applyOps(ctx, store.blankDashboard(ctx, 'x', null), out(ops), cat);
    expect(all.draft.widgets.map((w) => w.type).sort()).toEqual(['alarms', 'value']);
    expect(chat.systemPrompt(ctx, cat, null)).not.toMatch(/This app has no alarm list/);
    vi.unstubAllGlobals();
  });

  it('the default machine dashboard has no alarm list without alerts; templates follow', async () => {
    const { defaultWidgets } = await import('../src/render/widgets');
    const { TEMPLATES } = await import('../src/render/templates');
    const ctx = await ctxFor('Admin', ['root']);
    withLicence(['alerts']);
    expect(defaultWidgets(ctx, 'Compressor').some((w) => w.type === 'alarms')).toBe(false);
    withLicence([]);
    expect(defaultWidgets(ctx, 'Compressor').some((w) => w.type === 'alarms')).toBe(true);
    expect(TEMPLATES.filter((t) => t.needs === 'alerts').map((t) => t.id)).toEqual(['alarms']);
    vi.unstubAllGlobals();
  });
});
