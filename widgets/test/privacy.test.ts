// AI privacy (AI Insights A-070): core/privacy.ts runs the App UI's shared vectors (privacy-vectors.json, copied byte
// for byte), and the chat turn sends aliases and puts the real names back (a fake transport captures the request body
// the relay chain would forward to the provider: nothing is sent anywhere).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as P from '../src/core/privacy';
import { buildCatalog, chatTurn, privacyEntities, type Transport } from '../src/core/chat';
import { blankDashboard } from '../src/core/store';

const V = JSON.parse(readFileSync(new URL('./privacy-vectors.json', import.meta.url), 'utf8'));
const raw = (r: unknown) => (r === 'UNREADABLE' ? P.UNREADABLE : r);

describe('privacy rule (shared vectors)', () => {
  for (const v of V.settings) it(`settings: ${v.case}`, () => expect(P.settings(raw(v.raw), v.legacy)).toEqual(v.expect));
  for (const v of V.aliases) it(`aliases: ${v.case}`, () => expect(P.make(v.entities).aliases).toEqual(v.expect));
  for (const v of V.texts)
    it(`texts: ${v.case}`, () => {
      const p = P.make(v.entities, v.settings);
      expect(p.out(v.out)).toBe(v.expectOut);
      expect(p.back(v.back)).toBe(v.expectBack);
    });
  for (const v of V.objects)
    it(`objects: ${v.case}`, () => {
      const before = JSON.stringify(v.payload);
      expect(P.make(v.entities, v.settings).out(v.payload, v.valueKeys)).toEqual(v.expect);
      expect(JSON.stringify(v.payload)).toBe(before);
    });
  for (const v of V.answers) it(`answers: ${v.case}`, () => expect(P.make(v.entities, v.settings).back(v.answer)).toEqual(v.expect));
});

// ---- the chat: a user scope with a customer, a site and two machines
function ctx(): any {
  const nodes = new Map<string, any>([
    ['a-site', { id: 'a-site', entityType: 'ASSET', label: 'Pune North', name: 'Pune North', profile: 'Site', parentId: null }],
    ['a-line', { id: 'a-line', entityType: 'ASSET', label: 'Hall 3', name: 'Hall 3', profile: 'Line', parentId: 'a-site' }],
    ['d-1', { id: 'd-1', entityType: 'DEVICE', label: 'Press 7', name: 'PRS-0007', profile: 'Forging Press', parentId: 'a-line' }],
    ['d-2', { id: 'd-2', entityType: 'DEVICE', label: 'Press 8', name: 'PRS-0008', profile: 'Forging Press', parentId: 'a-line' }],
  ]);
  return {
    userId: 'u-1', displayName: 'Test', nodes, canApplyMany: true, perms: { has: () => true },
    profileKeys: { 'Forging Press': [{ key: 'Press_Force', displayName: 'Press force', unit: 'kN' }] },
    liveLoads: new Map([['Forging Press', Promise.resolve()]]), store: { id: 'store', entityType: 'ASSET' }, warnings: [],
  };
}

function capture(answer: any): Transport & { bodies: any[] } {
  const t = {
    bodies: [] as any[],
    async send(body: unknown) {
      t.bodies.push(JSON.parse(JSON.stringify(body)));
      return { toolInput: answer };
    },
  };
  return t;
}

const REAL = ['Press 7', 'Press 8', 'PRS-0007', 'PRS-0008', 'Pune North', 'Hall 3'];
const leaks = (s: string) => REAL.filter((n) => new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])').test(s));

describe('chat turn with AI privacy', () => {
  it('names leave as aliases, the answer comes back with the real names', async () => {
    const c = ctx();
    const draft = blankDashboard(ctx(), 'Press 7 overview', null);
    const t = capture({ intent: 'help', reply: 'Machine A and Machine B are in Location A at Site A.', ops: [] });
    const res = await chatTurn(c, t, draft, [{ role: 'user', content: 'what about Press 8?' }, { role: 'assistant', content: 'Press 8 is a Forging Press.' }], 'Compare Press 7 and press 8 in Pune North', 'd-1', { privacy: { v: 1, enabled: false, privacy: { anonymise: true, send_values: true } } });
    const body = JSON.stringify(t.bodies[0]);
    expect(leaks(body)).toEqual([]);
    expect(t.bodies[0].messages.at(-1).content).toContain('USER REQUEST: Compare Machine A and Machine B in Site A');
    expect(t.bodies[0].messages[0].content).toBe('what about Machine B?');
    expect(JSON.parse(t.bodies[0].catalog).machines.map((m: any) => m.label)).toEqual(['Machine A', 'Machine B']);
    expect(t.bodies[0].machine).toBe('D1');   // the catalogue aliases (D1..) are unchanged
    expect(res.reply).toBe('Press 7 and Press 8 are in Hall 3 at Pune North.');
  });

  it('titles and names the assistant writes come back with the real names', async () => {
    const c = ctx();
    const draft = blankDashboard(ctx(), 'Overview', 'Forging Press');
    const t = capture({ intent: 'build', reply: 'Added a chart for Machine A.', ops: [{ op: 'addWidget', type: 'line', title: 'Machine A press force', binding: { mode: 'fixed', machines: ['D1'] }, keys: ['Press_Force'] }, { op: 'renameDashboard', name: 'Machine A at Site A' }] });
    const res = await chatTurn(c, t, draft, [], 'Chart Press 7 force', null, { privacy: null });
    expect(leaks(JSON.stringify(t.bodies[0]))).toEqual([]);
    expect(res.reply).toBe('Added a chart for Press 7.');
    expect(res.draft.widgets[0].title).toBe('Press 7 press force');
    expect(res.draft.name).toBe('Press 7 at Pune North');
  });

  it('anonymise off: the names leave as they are', async () => {
    const t = capture({ intent: 'help', reply: 'ok', ops: [] });
    await chatTurn(ctx(), t, blankDashboard(ctx(), 'x', null), [], 'Press 7?', null, { privacy: { privacy: { anonymise: false } } });
    expect(t.bodies[0].messages.at(-1).content).toContain('USER REQUEST: Press 7?');
    expect(JSON.parse(t.bodies[0].catalog).machines[0].label).toBe('Press 7');
  });

  it('unreadable switches: names replaced', async () => {
    const t = capture({ intent: 'help', reply: 'ok', ops: [] });
    await chatTurn(ctx(), t, blankDashboard(ctx(), 'x', null), [], 'Press 7?', null, { privacy: P.UNREADABLE });
    expect(t.bodies[0].messages.at(-1).content).toContain('USER REQUEST: Machine A?');
  });

  it('the entities: machines in catalogue order (label shown, name replaced too), then the locations', () => {
    const c = ctx();
    expect(privacyEntities(c, buildCatalog(c))).toEqual([
      { kind: 'machine', name: 'PRS-0007', label: 'Press 7' }, { kind: 'machine', name: 'PRS-0008', label: 'Press 8' },
      { kind: 'site', name: 'Pune North', label: 'Pune North' }, { kind: 'location', name: 'Hall 3', label: 'Hall 3' },
    ]);
  });
});
