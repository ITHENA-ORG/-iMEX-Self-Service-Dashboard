// D-074 (UI audit H2): the Builder's selects become the app's drop-down through window.imxKit.selects when the kit is
// on the page; without it (or with an older kit that has no selects) nothing happens and the native selects stay.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { kitSelects } from '../src/render/kit';
import { BUILDER_CSS } from '../src/builder/styles';

afterEach(() => vi.unstubAllGlobals());

describe('kitSelects (D-074)', () => {
  it('hands the root and options to the kit and returns its handle', () => {
    const calls: any[] = [];
    const handle = { refresh() {}, close() {}, destroy() {} };
    vi.stubGlobal('document', {});
    vi.stubGlobal('window', { imxKit: { selects: (r: unknown, o: unknown) => (calls.push([r, o]), handle) } });
    const root = {} as HTMLElement;
    const sm = () => true;
    expect(kitSelects(root, { sm })).toBe(handle);
    expect(calls).toEqual([[root, { sm }]]);
  });

  it('returns null without the kit, with a kit that has no selects, without a root, or when the kit throws', () => {
    vi.stubGlobal('document', {});
    vi.stubGlobal('window', {});
    expect(kitSelects({} as HTMLElement)).toBeNull();
    vi.stubGlobal('window', { imxKit: { toast() {} } });
    expect(kitSelects({} as HTMLElement)).toBeNull();
    vi.stubGlobal('window', { imxKit: { selects: () => { throw new Error('x'); } } });
    expect(kitSelects({} as HTMLElement)).toBeNull();
    expect(kitSelects(null)).toBeNull();
  });

  it('no filled selection in the New dashboard cards (UI audit M8)', () => {
    const on = BUILDER_CSS.match(/\.dbb-nd-opt\.on\{[^}]*\}/g) ?? [];
    expect(on.length).toBe(2);
    for (const r of on) expect(r).not.toMatch(/background/);
  });
});
