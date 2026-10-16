// D-064: the machine model's TypeScript port (core/machine.ts) runs the App UI's vectors (tests/machine-vectors.json,
// copied byte for byte) plus the Builder-only parts (overlay of the catalogue, look).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as M from '../src/core/machine';

const V = JSON.parse(readFileSync(new URL('./machine-vectors.json', import.meta.url), 'utf8'));
const pick = (o: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

describe('machine model (vectors)', () => {
  it('kindOf', () => { for (const c of V.kindOf) expect(M.kindOf(c.profile, c.name), `${c.profile}/${c.name}`).toBe(c.expect); });
  it('splitLabel', () => { for (const c of V.splitLabel) expect(M.splitLabel(c.s)).toEqual(c.expect); });
  it('classify', () => {
    for (const c of V.classify) {
      const r = M.classify(c.cfg, c.raw);
      expect(r === null ? null : pick(r, ['state', 'label', 'tone']), c.name).toEqual(c.expect);
    }
  });
  it('status', () => {
    for (const c of V.status) {
      const r = M.status(c.model, c.type, c.latest, { now: V.now, ...(c.opts || {}) });
      expect(pick(r, Object.keys(c.expect)), c.name).toEqual(c.expect);
    }
  });
  it('value', () => {
    for (const c of V.value) expect(pick(M.value(c.model, c.type, c.key, c.fb), Object.keys(c.expect)), c.name).toEqual(c.expect);
  });
  it('offlineMs and statusKeys', () => {
    for (const c of V.offlineMs) expect(M.offlineMs(c.model, c.type)).toBe(c.expect);
    for (const c of V.statusKeys) expect(M.statusKeys(c.model, c.type)).toEqual(c.expect);
  });
});

describe('machine model (Builder)', () => {
  const model = { v: 1, types: { Press: { icon: 'gauge', values: [{ key: 'b', label: 'Bee', unit: 'kN', decimals: 0 }, { key: 'h', hidden: true }] } } };
  it('overlay: the model names, units and decimals win, hidden keys go, the model order first', () => {
    const list = [
      { key: 'a', displayName: 'A', unit: 'x', decimals: 1, min: 0, max: 100 },
      { key: 'h', displayName: 'H', unit: '', decimals: 1, min: 0, max: 100 },
      { key: 'b', displayName: 'B', unit: 'y', decimals: 2, min: 0, max: 100 },
    ];
    const out = M.overlay(model, 'Press', list as any);
    expect(out.map((k) => [k.key, k.displayName, k.unit, k.decimals])).toEqual([['b', 'Bee', 'kN', 0], ['a', 'A', 'x', 1]]);
    expect(M.overlay(model, 'Other', list as any)).toBe(list);
  });
  it('look: chosen icon, else the neutral machine icon', () => {
    expect(M.look(model, 'Press').icon).toBe('gauge');
    expect(M.look(model, 'Compressor')).toEqual({ icon: 'machine', accent: 'slate' });
  });
  it('load: one read, kept a minute; a failed read keeps the copy', async () => {
    M.reset();
    let n = 0;
    const read = async () => { n++; return { v: 1, rev: 3, types: {} }; };
    expect((await M.load(read)).rev).toBe(3);
    await M.load(read);
    expect(n).toBe(1);
    expect((await M.load(async () => { throw new Error('x'); }, true)).rev).toBe(3);
    M.reset();
  });
});
