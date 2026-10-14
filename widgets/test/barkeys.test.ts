// Storyboard round (12 Oct 2026): the properties the machine page bar's Analyzer button opens the Analyzer with
// (entries/renderer.ts analyzerKeys): the keys the dashboard shows for this machine, unique, at most 15; without any,
// the machine type's first numeric properties (at most 6).
import { describe, it, expect } from 'vitest';
import { analyzerKeys } from '../src/entries/renderer';

const w = (keys: string[], binding: any) => ({ id: 'w' + keys.join(''), type: 'line', title: '', x: 0, y: 0, w: 4, h: 3, keys, settings: {}, binding }) as any;

describe('analyzerKeys', () => {
  it('takes the keys of widgets bound to this machine, its name or its type, once each, in order', () => {
    const ws = [
      w(['power', 'pressure'], { mode: 'current' }),
      w(['pressure', 'temp'], { mode: 'fixed', deviceIds: ['d1', 'd2'] }),
      w(['flow'], { mode: 'siblings', profile: 'Compressor' }),
      w(['other'], { mode: 'fixed', deviceIds: ['d9'] }),
      w(['dryer'], { mode: 'nearest', profile: 'Dryer' }),
      w([], { mode: 'none' }),
    ];
    expect(analyzerKeys(ws, 'd1', 'Compressor')).toEqual(['power', 'pressure', 'temp', 'flow']);
  });
  it('keeps at most 15', () => {
    const ws = [w(Array.from({ length: 10 }, (_, i) => 'a' + i), { mode: 'current' }), w(Array.from({ length: 10 }, (_, i) => 'b' + i), { mode: 'current' })];
    expect(analyzerKeys(ws, 'd1', 'P')).toHaveLength(15);
  });
  it('falls back to the first numeric properties of the machine type', () => {
    const cat = [{ key: 'runStatus', type: 'number', states: { 1: 'Running' } }, { key: 'mode', type: 'string' }, { key: 'on', type: 'boolean' }, ...Array.from({ length: 8 }, (_, i) => ({ key: 'k' + i, type: 'number' }))];
    expect(analyzerKeys([w(['x'], { mode: 'fixed', deviceIds: ['d9'] })], 'd1', 'P', cat)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
    expect(analyzerKeys([], 'd1', 'P')).toEqual([]);
  });
});

// D-057: setting analyzerState of the renderer (the phone dashboard sets 'trend')
import { analyzerTarget } from '../src/entries/renderer';
describe('analyzerTarget', () => {
  const node = { name: 'CMP-01', label: 'Compressor 1' };
  it('opens the Analyzer by default, without a top-level entityId', () => {
    for (const v of [undefined, '', '  ', 'analytics', 7]) {
      const t = analyzerTarget(v, 'd1', node, ['a', 'b']);
      expect(t.state).toBe('analytics');
      expect(t.params).toEqual({ selectedEquipment: { entityName: 'CMP-01', entityLabel: 'Compressor 1', entityId: { id: 'd1', entityType: 'DEVICE' } }, entityName: 'CMP-01', entityLabel: 'Compressor 1', key: ['a', 'b'] });
      expect('entityId' in t.params).toBe(false);
    }
  });
  it("opens the phone's Trend screen with the machine, the keys and the first key selected", () => {
    expect(analyzerTarget('trend', 'd1', node, ['a', 'b'])).toEqual({ state: 'trend', params: { entityId: { id: 'd1', entityType: 'DEVICE' }, entityName: 'CMP-01', entityLabel: 'Compressor 1', key: ['a', 'b'], selected: 'a' } });
    expect(analyzerTarget('trend', 'd1', { name: 'X' }, []).params).toMatchObject({ entityLabel: 'X', key: [], selected: null });
  });
  it('another state id gets the Analyzer parameters', () => {
    expect(analyzerTarget('my_analyzer', 'd1', node, ['a']).state).toBe('my_analyzer');
  });
});

import { dashHasState } from '../src/entries/renderer';
describe('dashHasState', () => {
  it('is true for a state of the dashboard, or when the state list cannot be read', () => {
    expect(dashHasState({ stateController: { states: { analytics: {}, machine: {} } } }, 'analytics')).toBe(true);
    expect(dashHasState({ stateController: { states: { machine: {}, trend: {} } } }, 'analytics')).toBe(false);
    expect(dashHasState({ stateController: { statesValue: { trend: {} } } }, 'trend')).toBe(true);
    expect(dashHasState({ stateController: {} }, 'analytics')).toBe(true);
    expect(dashHasState({}, 'analytics')).toBe(true);
    expect(dashHasState({ stateController: { states: {} } }, 'x')).toBe(true);
  });
});
