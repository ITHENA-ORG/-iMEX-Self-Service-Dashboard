// D-056: the app's dark mode (App UI U-051) on dashboards. A light preset takes the app's dark tokens, a dark preset
// keeps its own; the cards' own colours: white / light grey dropped, pastel toned down, coloured tiles kept,
// near-black text dropped. Light mode (appDark false) gives exactly what it gave before.
import { describe, it, expect } from 'vitest';
import { themeVars, darkColor, colorInfo, PRESETS, APP_DARK } from '../src/render/theme';
import { cardVars, darkCardStyle } from '../src/render/widgets';

describe('colorInfo', () => {
  it('reads hex, short hex, hex with alpha and rgb()/rgba()', () => {
    expect(colorInfo('#ffffff')!.lum).toBeCloseTo(1, 5);
    expect(colorInfo('#000')!.lum).toBe(0);
    expect(colorInfo('#d03b3b')!.chroma).toBeGreaterThan(0.5);
    expect(colorInfo('#ffffff00')!.alpha).toBe(0);
    expect(colorInfo('rgb(208, 59, 59)')!.chroma).toBeCloseTo(colorInfo('#d03b3b')!.chroma, 5);
    expect(colorInfo('rgba(0, 0, 0, 0.5)')!.alpha).toBe(0.5);
  });
  it('gives null for what it cannot read', () => {
    for (const c of ['red', 'transparent', 'var(--accent)', 'linear-gradient(red, blue)', '', null, undefined]) expect(colorInfo(c as any)).toBeNull();
  });
});

describe('themeVars', () => {
  it('light mode: the preset and the overrides as before', () => {
    const r = themeVars({ preset: 'ocean', accent: '#c9501f', bg: '#eeeeee', cardBg: '#fafafa' }, false);
    expect(r.dark).toBe(false);
    expect(r.appDark).toBe(false);
    expect(r.vars['--surface']).toBe('#fafafa');
    expect(r.vars['--plane']).toBe('#eeeeee');
    expect(r.vars['--ink']).toBe(PRESETS.ocean.ink);
    expect(r.vars['--accent']).toBe('#c9501f');
    expect(themeVars(null).vars['--surface']).toBe(PRESETS.light.surface);
  });
  it('app dark mode: a light preset takes the app dark tokens, keeps its accent, drops light page / card colours', () => {
    for (const preset of ['light', 'ocean', 'sand'] as const) {
      const r = themeVars({ preset, bg: '#f4f5f7', cardBg: '#ffffff' }, true);
      expect(r.dark).toBe(true);
      expect(r.appDark).toBe(true);
      expect(r.vars['--surface']).toBe(APP_DARK.surface);
      expect(r.vars['--plane']).toBe(APP_DARK.plane);
      expect(r.vars['--ink']).toBe(APP_DARK.ink);
      expect(r.vars['--grid']).toBe(APP_DARK.grid);
      expect(r.vars['--accent']).toBe(PRESETS[preset].accent);
    }
    expect(themeVars(undefined, true).vars['--surface']).toBe(APP_DARK.surface);
  });
  it('app dark mode: a dark page colour is kept, a pastel one toned down', () => {
    expect(themeVars({ bg: '#0a174d' }, true).vars['--plane']).toBe('#0a174d');
    expect(themeVars({ bg: '#fde2d4' }, true).vars['--plane']).toMatch(/^color-mix\(in srgb, #fde2d4 22%/);
  });
  it('app dark mode: a dark preset stays as saved', () => {
    for (const preset of ['dark', 'slate'] as const) {
      const a = themeVars({ preset, cardBg: '#ffffff' }, true);
      const b = themeVars({ preset, cardBg: '#ffffff' }, false);
      expect(a).toEqual({ ...b, appDark: false });
      expect(a.vars['--surface']).toBe('#ffffff');
      expect(a.vars['--ink']).toBe(PRESETS[preset].ink);
    }
  });
});

describe('darkColor', () => {
  it('backgrounds: white / light grey dropped, pastel toned down, coloured and dark kept', () => {
    expect(darkColor('#ffffff', 'bg')).toBeNull();
    expect(darkColor('#f4f5f7', 'bg')).toBeNull();
    expect(darkColor('#fde2d4', 'bg')).toMatch(/^color-mix/);
    for (const c of ['#d03b3b', '#c03939', '#ac1111', '#0b3a7e', '#0f6e4f', '#fab219', '#0ca30c', '#121A2B']) expect(darkColor(c, 'bg')).toBe(c);
  });
  it('text: black / dark grey dropped, dark saturated lightened, light and mid kept', () => {
    expect(darkColor('#0b0b0b', 'text')).toBeNull();
    expect(darkColor('#52514e', 'text')).toBeNull();
    expect(darkColor('rgb(0, 0, 0)', 'text')).toBeNull();
    expect(darkColor('#0d366b', 'text')).toMatch(/^color-mix\(in srgb, #0d366b 45%, #ffffff\)$/);
    for (const c of ['#ffffff', '#d03b3b', '#2a78d6', '#898781']) expect(darkColor(c, 'text')).toBe(c);
  });
  it('borders: light grey dropped, others kept; unreadable and transparent colours unchanged', () => {
    expect(darkColor('#e6e5e0', 'border')).toBeNull();
    expect(darkColor('#2a78d6', 'border')).toBe('#2a78d6');
    expect(darkColor('transparent', 'bg')).toBe('transparent');
    expect(darkColor('#ffffff00', 'bg')).toBe('#ffffff00');
    expect(darkColor('var(--x)', 'text')).toBe('var(--x)');
  });
});

describe('card colours in the app dark mode', () => {
  it('light mode is unchanged', () => {
    const st = { bg: '#ffffff', titleColor: '#0b0b0b', valueColor: '#0b0b0b', borderColor: '#e6e5e0', border: 'thin' as const };
    expect(cardVars(st as any, false)).toBe(cardVars(st as any));
    expect(cardVars(st as any)).toContain('--card-bg:#ffffff');
  });
  it('a white card with black text becomes the dark surface with the theme text', () => {
    const v = cardVars({ bg: '#ffffff', titleColor: '#0b0b0b', valueColor: '#111111', iconColor: '#000000', borderColor: '#e6e5e0' } as any, true);
    expect(v).not.toContain('--card-bg');
    expect(v).not.toContain('--card-title-color');
    expect(v).not.toContain('--card-value-color');
    expect(v).not.toContain('--card-icon');
    expect(v).not.toContain('--ink:#0b0b0b');
    expect(v).not.toContain('--card-border');
  });
  it('a coloured tile keeps its colour, its white text and its text colours', () => {
    const st = { bg: '#c03939', gradient: true, valueColor: '#111111', iconColor: '#ffffff' };
    expect(cardVars(st as any, true)).toBe(cardVars(st as any, false));
    expect(cardVars({ bg: '#0f6e4f', iconColor: '#ffffff' } as any, true)).toContain('--ink:#ffffff');
  });
  it('a pastel card is toned down and keeps the dark theme text (no dark ink override)', () => {
    const s = darkCardStyle({ bg: '#fde2d4', valueColor: '#0b0b0b' } as any);
    expect(s.bg).toMatch(/^color-mix/);
    expect(s.valueColor).toBeUndefined();
    expect(cardVars({ bg: '#fde2d4' } as any, true)).not.toContain('--ink:#0b0b0b');
  });
  it('accent bar and a saturated title colour stay', () => {
    const v = cardVars({ accentBar: '#d03b3b', titleColor: '#2a78d6', iconColor: '#2a78d6' } as any, true);
    expect(v).toContain('--card-accent:#d03b3b');
    expect(v).toContain('--card-title-color:#2a78d6');
  });
});
