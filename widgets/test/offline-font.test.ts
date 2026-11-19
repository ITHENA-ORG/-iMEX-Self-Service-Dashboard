// D-097 (offline first): the Builder's fonts come only from the platform's resource library. No Google Fonts address
// anywhere in the source or the built widgets, and a widget that starts before the app's loader waits for it, then
// reads the platform copy itself.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadFont, FONT_LOADER_WAIT_MS } from '../src/render/theme';

function fakeDoc() {
  const head: any[] = [];
  const mk = (tag: string) => {
    const e: any = { tagName: tag.toUpperCase(), attrs: {} as Record<string, string>, textContent: '', id: '' };
    e.setAttribute = (k: string, v: string) => { e.attrs[k] = v; };
    return e;
  };
  return {
    head: { appendChild: (e: any) => head.push(e) },
    createElement: mk,
    getElementById: (id: string) => head.find((e) => e.id === id) ?? null,
    querySelector: (sel: string) => {
      const m = sel.match(/data-imx-lib="([^"]+)"/);
      return head.find((e) => e.tagName === 'STYLE' && m && e.attrs['data-imx-lib'] === m[1]) ?? null;
    },
    _head: head,
  };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('loadFont (D-097)', () => {
  it('uses the app loader when it is already on the page', async () => {
    const doc = fakeDoc();
    const calls: string[] = [];
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', { imxLibs: { table: { fonts: { inter: 'imex-lib-font-inter-v20.css' } }, font: (_c: unknown, id: string) => (calls.push(id), Promise.resolve()) } });
    vi.stubGlobal('fetch', vi.fn());
    loadFont('Inter');
    loadFont('Inter');   // once only
    await Promise.resolve();
    expect(calls).toEqual(['inter']);
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
  });

  it('waits for a late loader instead of going to the internet', async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const calls: string[] = [];
    const win: any = {};
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    vi.stubGlobal('localStorage', { getItem: () => 'tok' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    loadFont('Inter');
    await vi.advanceTimersByTimeAsync(500);
    win.imxLibs = { table: { fonts: { inter: 'k' } }, font: (_c: unknown, id: string) => (calls.push(id), Promise.resolve()) };
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toEqual(['inter']);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(doc._head.some((e: any) => e.tagName === 'LINK')).toBe(false);
  });

  it('without a loader reads the platform copy (tenant, then system) with the user token', async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => 'tok' });
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, o: any) => {
      urls.push(u);
      expect(o.headers['X-Authorization']).toBe('Bearer tok');
      return u.includes('/tenant/') ? { ok: false, text: async () => '' } : { ok: true, text: async () => '@font-face{font-family:Poppins}' };
    }));
    loadFont('Poppins');
    await vi.advanceTimersByTimeAsync(FONT_LOADER_WAIT_MS + 200);
    expect(urls).toEqual([
      '/api/resource/js_module/tenant/imex-lib-font-poppins-v24.css',
      '/api/resource/js_module/system/imex-lib-font-poppins-v24.css',
    ]);
    const st = doc._head.find((e: any) => e.tagName === 'STYLE');
    expect(st.textContent).toContain('Poppins');
    expect(doc._head.some((e: any) => e.tagName === 'LINK')).toBe(false);
  });

  it('no copy anywhere: nothing is added and nothing is thrown (system fonts)', async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => '' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => '' })));
    loadFont('Montserrat');
    await vi.advanceTimersByTimeAsync(FONT_LOADER_WAIT_MS + 200);
    expect(doc._head.filter((e: any) => e.tagName !== 'META')).toEqual([]);
  });

  it('no Google Fonts or public CDN address in the Builder source or the built widgets', () => {
    const bad = /fonts\.googleapis|fonts\.gstatic|cdnjs\.cloudflare|cdn\.jsdelivr|unpkg\.com/;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, n.name);
        if (n.isDirectory()) walk(p);
        else if (/\.(ts|js|json|css|html)$/.test(n.name)) files.push(p);
      }
    };
    walk(join(__dirname, '../src'));
    const dist = join(__dirname, '../dist');
    if (existsSync(dist)) walk(dist);
    const hits = files.filter((f) => bad.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
