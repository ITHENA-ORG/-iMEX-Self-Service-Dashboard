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
