/**
 * Visual tokens. Categorical order and status colours come from a validated reference palette
 * (light mode, because ThingsBoard runs a light UI; SERIES_DARK is the dark-surface column).
 *
 * WHERE IT RUNS / WHO CALLS IT
 * In the browser, inside the ThingsBoard widgets. Used by every part of the UI: render/* for
 * colours and formatting, entries/* and builder/* for the shared CSS (ensureCss(CSS)) and
 * applyTheme, the builder's editors for SWATCHES and PRESETS.
 *
 * KEY CONCEPTS
 * - Design tokens are CSS custom properties on the dashboard root (.dbb-root):
 *   --surface (card), --surface-2, --plane (page background), --line (borders), --grid (chart grid,
 *   empty tracks), --ink / --ink-2 / --ink-3 (text, strong to faint), --accent, --hover, --danger,
 *   --radius, --shadow, --pad, --font, --title-align. CSS below gives light defaults.
 * - Per-card overrides use --card-* variables (set by cardVars in widgets.ts) that fall back to the
 *   tokens, e.g. var(--card-bg, var(--surface)).
 * - Dashboard themes (D-019): PRESETS (light, ocean, sand, slate, dark) plus optional overrides in
 *   Dashboard.theme (accent, font, bg, bgImage, cardBg, radius, shadow, density, titleAlign).
 *   applyTheme() writes them as inline CSS variables on a container; charts and cards pick them up
 *   without any redraw logic of their own.
 * - Because each ThingsBoard widget type embeds its own copy of the library, ensureCss() is
 *   idempotent per style id so the shared CSS is injected into <head> only once per page.
 *
 * SECURITY
 * safeUrl() is the single gate for user or chat supplied addresses that end up in src/href/url():
 * https only, or an inline base64 data:image. Every string placed into HTML goes through esc();
 * miniMarkdown escapes before adding tags. Rich HTML is sanitised separately in render/rich.ts.
 *
 * EXPORTS
 * Colours: SERIES, SERIES_DARK, STATUS, SEVERITY_COLOR, RAMP_BLUE, RAMP_ORANGE, SWATCHES, PRESETS.
 * Theme: applyTheme, themeVars, isDark, loadFont, fontStack, CSS, ensureCss.
 * D-056 app dark mode: APP_DARK, appDarkMode, colorInfo, darkColor.
 * Helpers: safeUrl, esc, fmtNum, fmtTime, ago, el, bandColor, miniMarkdown.
 */

import type { DashboardTheme } from '../core/schema';

/** Categorical series colours (light surfaces), in assignment order. Charts cycle through them. */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
/** Same eight hues stepped for dark surfaces (reference palette, dark column). */
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
/** Status colours: good (running), warning, serious, critical, neutral (stopped / offline / no match). */
export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', neutral: '#8a8983' };
/** ThingsBoard alarm severity -> status colour (alarms widget). */
export const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: STATUS.critical,
  MAJOR: STATUS.serious,
  MINOR: STATUS.warning,
  WARNING: STATUS.warning,
  INDETERMINATE: STATUS.neutral,
};
/** Sequential ramps (light -> dark) for heatmaps. */
export const RAMP_BLUE = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
export const RAMP_ORANGE = ['#fde2d4', '#f9c1a4', '#f39b73', '#eb6834', '#c9501f', '#9c3c14', '#6e2a0d'];

/** Rule colour presets offered in the rule editor. */
export const SWATCHES = ['#0ca30c', '#fab219', '#ec835a', '#d03b3b', '#2a78d6', '#1baf7a', '#4a3aa7', '#e87ba4', '#8a8983', '#0b0b0b', '#ffffff'];

/** Colour tokens of a theme preset; mapped to CSS variables by applyTheme (plane -> --plane and --surface-2, ink2 -> --ink-2...). */
interface Tokens {
  /** Dark preset: adds .dbb-dark and makes charts use SERIES_DARK. */
  dark: boolean;
  surface: string;
  plane: string;
  line: string;
  grid: string;
  ink: string;
  ink2: string;
  ink3: string;
  accent: string;
  hover: string;
}
/** Dashboard theme presets by id (schema THEME_PRESETS). `label` is shown in the builder's Dashboard tab. */
export const PRESETS: Record<string, Tokens & { label: string }> = {
  light: { label: 'Light', dark: false, surface: '#ffffff', plane: '#f4f5f7', line: '#e6e5e0', grid: '#efeeea', ink: '#0b0b0b', ink2: '#52514e', ink3: '#898781', accent: '#2a78d6', hover: '#f3f8fe' },
  ocean: { label: 'Ocean', dark: false, surface: '#ffffff', plane: '#eaf1fa', line: '#d6e3f3', grid: '#e8eef6', ink: '#0d1b2e', ink2: '#3d4f66', ink3: '#7a8aa0', accent: '#256abf', hover: '#eef4fc' },
  sand: { label: 'Sand', dark: false, surface: '#fffdf9', plane: '#f4efe6', line: '#e6ddcf', grid: '#efe8dc', ink: '#221c14', ink2: '#5c5245', ink3: '#908574', accent: '#c9501f', hover: '#fbf3ea' },
  slate: { label: 'Slate', dark: true, surface: '#1f2733', plane: '#141a23', line: '#2e3847', grid: '#29323f', ink: '#f3f5f8', ink2: '#b9c2cf', ink3: '#8391a3', accent: '#3987e5', hover: '#263041' },
  dark: { label: 'Dark', dark: true, surface: '#1a1a19', plane: '#0d0d0d', line: '#2c2c2a', grid: '#2c2c2a', ink: '#ffffff', ink2: '#c3c2b7', ink3: '#898781', accent: '#3987e5', hover: '#242423' },
};

/**
 * D-056: the app's dark mode (App UI U-051, `html[data-imx-mode="dark"]`). A dashboard saved with a light preset
 * takes these tokens instead of its preset's; the app's dark variables (`--imx-*`, set on <html> by the side menu)
 * win, the fallbacks are the same values. Dark presets (slate, dark) keep their own tokens.
 */
export const APP_DARK: Tokens = {
  dark: true,
  surface: 'var(--imx-surface,#121A2B)',
  plane: 'var(--imx-bg,#0B1220)',
  line: 'var(--imx-line,#26324A)',
  grid: 'color-mix(in srgb,var(--imx-line,#26324A) 72%,var(--imx-surface,#121A2B))',
  ink: 'var(--imx-text,#E6EBF3)',
  ink2: 'var(--imx-text2,#C9D3E1)',
  ink3: 'var(--imx-muted,#97A6BC)',
  accent: '#3987e5',
  hover: 'var(--imx-ph,#1B263C)',
};

/** D-056: whether the app runs in dark mode (the side menu's `data-imx-mode` on <html>). False outside a browser. */
export function appDarkMode(): boolean {
  return typeof document !== 'undefined' && document.documentElement?.getAttribute('data-imx-mode') === 'dark';
}

/** Hue-free facts of a #rgb / #rrggbb(aa) or rgb()/rgba() colour: WCAG luminance (0-1), chroma (max-min channel, 0-1) and alpha. Null for anything else. */
export function colorInfo(c?: string | null): { lum: number; chroma: number; alpha: number } | null {
  const s = String(c ?? '').trim();
  let ch: number[] | null = null;
  let alpha = 1;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.replace(/./g, (x) => x + x);
    ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    if (hex[2]) alpha = parseInt(hex[2], 16) / 255;
  } else {
    const m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d*(?:\.\d+)?%?))?\s*\)$/i.exec(s);
    if (m) {
      ch = [m[1], m[2], m[3]].map(Number);
      if (m[4]) alpha = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
  }
  if (!ch || ch.some((v) => !(v >= 0 && v <= 255))) return null;
  const n = ch.map((v) => v / 255);
  const [r, g, b] = n.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return { lum: 0.2126 * r + 0.7152 * g + 0.0722 * b, chroma: Math.max(...n) - Math.min(...n), alpha };
}

/**
 * D-056: a colour a user picked on a light dashboard, made fit for the app's dark surfaces.
 * - 'bg' (card or page background): a white / light grey one is dropped (null: the dark surface shows); a light
 *   tint (pastel) becomes the same hue at low strength over the dark surface; a saturated or dark colour (a red
 *   alert tile, a navy banner) is kept as it is.
 * - 'text' (title, value, icon, rich-text colour): a black / dark grey one is dropped (null: the dark theme's text
 *   colour applies); a dark saturated one is lightened; anything else is kept.
 * - 'border': a light grey one is dropped (null: the theme line); others kept.
 * Colours it cannot read (names, gradients, var()) and transparent ones are returned unchanged.
 */
export function darkColor(c: string, role: 'bg' | 'text' | 'border'): string | null {
  const i = colorInfo(c);
  if (!i || i.alpha < 0.05) return c;
  if (role === 'text') {
    if (i.lum >= 0.1) return c;
    return i.chroma < 0.16 ? null : `color-mix(in srgb, ${c} 45%, #ffffff)`;
  }
  if (i.lum <= 0.55) return c;
  if (i.chroma < 0.12) return null;
  return role === 'bg' ? `color-mix(in srgb, ${c} 22%, var(--imx-surface,#121A2B))` : null;
}

/**
 * The CSS variables of a dashboard theme and whether it is dark (pure; applyTheme writes them).
 * D-056: with `appDark` (the app in dark mode) a light preset takes APP_DARK, and a light page or card background
 * of the theme is dropped or toned down (darkColor); the accent stays.
 */
export function themeVars(t: DashboardTheme | null | undefined, appDark = false): { vars: Record<string, string>; dark: boolean; appDark: boolean } {
  const p0 = PRESETS[t?.preset ?? 'light'] ?? PRESETS.light;
  const conv = appDark && !p0.dark;
  const p: Tokens = conv ? APP_DARK : p0;
  const bg = t?.bg && conv ? darkColor(t.bg, 'bg') : t?.bg;
  const cardBg = t?.cardBg && conv ? darkColor(t.cardBg, 'bg') : t?.cardBg;
  const vars: Record<string, string> = {
    '--surface': cardBg ?? p.surface,
    '--surface-2': p.plane,
    '--plane': bg ?? p.plane,
    '--line': p.line,
    '--grid': p.grid,
    '--ink': p.ink,
    '--ink-2': p.ink2,
    '--ink-3': p.ink3,
    '--accent': t?.accent ?? p0.accent,
    '--hover': p.hover,
    '--radius': `${t?.radius ?? 12}px`,
    '--shadow': SHADOWS[t?.shadow ?? 'soft'],
    '--pad': PADS[t?.density ?? 'normal'],
    '--font': fontStack(t?.font),
    '--title-align': t?.titleAlign ?? 'left',
  };
  return { vars, dark: p.dark, appDark: conv };
}

const SHADOWS: Record<string, string> = {
  none: 'none',
  soft: '0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.08)',
  strong: '0 4px 10px rgba(16,24,40,.08), 0 12px 28px rgba(16,24,40,.12)',
};
const PADS: Record<string, string> = { compact: '6px', normal: '10px', roomy: '16px' };

// Font name -> Google Fonts css2 `family` parameter. Only these are loaded (schema FONTS minus Roboto, which ships with ThingsBoard).
const GOOGLE_FONTS: Record<string, string> = {
  Inter: 'Inter:wght@400;500;600;700',
  Poppins: 'Poppins:wght@400;500;600;700',
  Montserrat: 'Montserrat:wght@400;500;600;700',
  'Source Serif 4': 'Source+Serif+4:wght@400;600;700',
  'JetBrains Mono': 'JetBrains+Mono:wght@400;600',
};

/**
 * Loads a Google font once (Roboto ships with ThingsBoard).
 * Side effect: appends <link rel="stylesheet" href="https://fonts.googleapis.com/css2?..."> to <head>,
 * keyed by an element id so repeated calls do nothing. Unknown names and non-browser runs are ignored.
 */
export function loadFont(name?: string | null) {
  if (!name || !GOOGLE_FONTS[name] || typeof document === 'undefined') return;
  const id = `dbb-font-${name.replace(/\W/g, '')}`;
  if (document.getElementById(id)) return;
  const l = document.createElement('link');
  l.id = id;
  l.rel = 'stylesheet';
  l.href = `https://fonts.googleapis.com/css2?family=${GOOGLE_FONTS[name]}&display=swap`;
  document.head.appendChild(l);
}

/** Default font of the app (user decision 28 Sep 2026: Inter, the standard on the other iMEX pages). */
export const INTER_STACK = '"DM Sans",Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';

/** CSS font-family value for a font name with a generic fallback (monospace / serif / sans-serif). Empty = Inter (INTER_STACK). Quotes in the name are stripped. */
export function fontStack(name?: string | null): string {
  // D-039: no font chosen = the app's font (CSS variable --imx-font of the iMEX app shell), Inter without the shell
  if (!name) return `var(--imx-font,${INTER_STACK})`;
  const generic = /mono/i.test(name) ? 'monospace' : /serif/i.test(name) && !/sans/i.test(name) ? 'serif' : 'sans-serif';
  // D-028: only letters, digits and spaces reach CSS (a quote or newline could end the declaration)
  const safe = name.replace(/[^A-Za-z0-9 ]/g, '').trim();
  return safe ? `"${safe}",${generic}` : `var(--imx-font,${INTER_STACK})`;
}

/**
 * Validates an address before it is used in src, href or CSS url(). Security-relevant: all image,
 * embed, link and background-image addresses (typed by users or produced by chat) pass through here.
 * Allowed: https:// with no whitespace, quotes, parentheses or angle brackets (so it can't break out
 * of an attribute or url("...")), or a base64 data:image (png, jpeg, gif, webp, svg+xml) for uploads (D-019).
 * Everything else (http, javascript:, other data: types) returns null.
 * The result still has to be escaped with esc() when put into HTML.
 */
export function safeUrl(u?: string | null): string | null {
  if (!u) return null;
  const v = u.trim();
  if (/^https:\/\/[^\s"'()<>]+$/i.test(v)) return v;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(v)) return v;
  return null;
}

/**
 * Applies a dashboard theme to a container as CSS variables. Returns whether it is dark, and (D-056) whether it
 * is a light theme drawn dark because the app is in dark mode (appDark; the container also gets .dbb-appdark).
 * @param el Dashboard root (machine page root or builder canvas). Gets inline CSS variables, the
 *   .dbb-dark class and a background (colour, or a cover / contain / tiled image from bgImage via safeUrl).
 * @param t Dashboard.theme; missing or unknown preset falls back to light, missing fields to preset values.
 * Side effect: loads the theme font (loadFont). Safe to call again with another theme: every
 * variable and background property is overwritten.
 */
export function applyTheme(el: HTMLElement, t?: DashboardTheme | null): { dark: boolean; appDark: boolean } {
  // D-056: in the app's dark mode a light preset is drawn with the app's dark tokens (.dbb-dark + .dbb-appdark)
  const { vars: v, dark, appDark } = themeVars(t, appDarkMode());
  for (const [k, val] of Object.entries(v)) el.style.setProperty(k, val);
  // D-039: a dashboard with its own font is marked, so an app-wide font does not replace it
  el.toggleAttribute('data-dbb-font', !!t?.font);
  loadFont(t?.font || 'Inter');
  el.classList.toggle('dbb-dark', dark);
  el.classList.toggle('dbb-appdark', appDark);
  const img = safeUrl(t?.bgImage);
  const fit = t?.bgFit ?? 'cover';
  el.style.backgroundColor = 'var(--plane)';
  el.style.backgroundImage = img ? `url("${img}")` : '';
  // D-033: no longer background-attachment:fixed, which sized the image to the browser window and
  // showed only a slice of it inside a ThingsBoard widget (and is ignored under transformed parents).
  el.style.backgroundSize = img ? (fit === 'tile' ? 'auto' : fit) : '';
  el.style.backgroundRepeat = img ? (fit === 'tile' ? 'repeat' : 'no-repeat') : '';
  el.style.backgroundPosition = img ? 'center' : '';
  el.style.backgroundAttachment = '';
  return { dark, appDark };
}

/** Whether a theme's preset is dark, without touching the DOM. */
export function isDark(t?: DashboardTheme | null): boolean {
  return !!PRESETS[t?.preset ?? 'light']?.dark;
}

/**
 * Core stylesheet: token defaults on .dbb-root, the card (.dbb-card*) and every widget body class
 * used by widgets.ts and charts.ts, plus shared buttons and banners. Injected with
 * ensureCss('dbb-css-core', CSS) by each entry point.
 */
export const CSS = `
.dbb-root{--surface:#ffffff;--surface-2:#f4f5f7;--plane:#f4f5f7;--line:#e6e5e0;--grid:#efeeea;--ink:#0b0b0b;--ink-2:#52514e;--ink-3:#898781;--accent:#2a78d6;--danger:#d03b3b;--hover:#f3f8fe;
  --radius:12px;--shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.08);--pad:10px;--font:Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--title-align:left;
  font-family:var(--font);color:var(--ink);font-size:13px;box-sizing:border-box;-webkit-font-smoothing:antialiased}
/* D-056: in the app's dark mode a page without a theme yet (loading, placeholder, no access) is dark too; applyTheme's inline values win */
html[data-imx-mode="dark"] .dbb-root{--surface:${APP_DARK.surface};--surface-2:${APP_DARK.plane};--plane:${APP_DARK.plane};--line:${APP_DARK.line};--grid:${APP_DARK.grid};--ink:${APP_DARK.ink};--ink-2:${APP_DARK.ink2};--ink-3:${APP_DARK.ink3};--hover:${APP_DARK.hover}}
.dbb-root *{box-sizing:border-box}
.dbb-root :is(button,input,select,textarea,option){font-family:inherit}
.dbb-card{background:var(--card-bg,var(--surface));border:var(--card-border,1px solid var(--line));border-radius:var(--card-radius,var(--radius));box-shadow:var(--card-shadow,var(--shadow));height:100%;display:flex;flex-direction:column;overflow:hidden;position:relative;transition:box-shadow .15s,transform .15s;color:var(--ink)}
.dbb-card.accent::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--card-accent)}
.dbb-card.plain{background:transparent;border:0;box-shadow:none}
.dbb-card-h{display:flex;align-items:center;gap:7px;padding:calc(var(--card-pad,var(--pad)) - 1px) var(--card-pad,var(--pad)) 0;min-height:30px;justify-content:var(--card-title-justify,flex-start)}
.dbb-card-t{font-size:var(--card-title-size,13px);font-weight:var(--card-title-weight,600);color:var(--card-title-color,var(--ink-2));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--card-title-font,inherit);letter-spacing:.005em}
.dbb-card-h .grow{flex:1}
.dbb-card-i{width:26px;height:26px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;flex:none;background:color-mix(in srgb,var(--card-icon,var(--accent)) 14%,transparent);color:var(--card-icon,var(--accent))}
.dbb-card-i svg{width:16px;height:16px}
.dbb-info{position:relative;display:inline-flex;color:var(--ink-3);cursor:help;flex:none}
.dbb-info svg{width:15px;height:15px}
.dbb-info .dbb-info-pop{display:none;position:absolute;top:20px;right:-6px;z-index:30;width:max-content;max-width:260px;background:#1a1a19;color:#fff;border-radius:8px;padding:8px 10px;font-size:12px;font-weight:400;line-height:1.45;box-shadow:0 6px 20px rgba(0,0,0,.25);white-space:normal}
.dbb-info:hover .dbb-info-pop,.dbb-info:focus .dbb-info-pop{display:block}
.dbb-info-pop a{color:#9ec5f4}
.dbb-card-b{flex:1;min-height:0;padding:4px var(--card-pad,var(--pad)) var(--card-pad,var(--pad));position:relative}
.dbb-card-f{font-size:11px;color:var(--ink-3);padding:0 var(--card-pad,var(--pad)) 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-ph{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--ink-3);font-size:12px;padding:6px}
.dbb-value{display:flex;flex-direction:column;justify-content:var(--card-justify,center);height:100%;text-align:var(--card-align,left);align-items:var(--card-align-items,flex-start)}
.dbb-value .v{font-size:var(--card-value-size,30px);font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums;color:var(--card-value-color,var(--ink));font-family:var(--card-value-font,inherit);letter-spacing:-.01em}
.dbb-value .u{font-size:14px;color:var(--ink-2);margin-left:4px;font-weight:400}
.dbb-value .s{font-size:11px;color:var(--ink-3);margin-top:4px}
.dbb-value .lbl{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:2px 9px;margin-top:6px;color:#fff}
.dbb-kpi{display:flex;flex-direction:column;height:100%;justify-content:var(--card-justify,space-between);gap:6px}
.dbb-kpi .dbb-value{flex:0 0 auto}
.dbb-kpi .row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;justify-content:var(--card-align-items,flex-start)}
.dbb-delta{font-size:12px;font-weight:600;border-radius:999px;padding:1px 7px;white-space:nowrap}
.dbb-delta.up{color:#006300;background:color-mix(in srgb,#0ca30c 14%,transparent)}
.dbb-delta.down{color:#9c2323;background:color-mix(in srgb,#d03b3b 14%,transparent)}
.dbb-delta.flat{color:var(--ink-3);background:var(--grid)}
.dbb-dark .dbb-delta.up{color:#57d157}.dbb-dark .dbb-delta.down{color:#f08a8a}
.dbb-spark{flex:1;min-height:24px;margin-top:4px}
.dbb-prog{display:flex;flex-direction:column;justify-content:var(--card-justify,center);height:100%;gap:8px}
.dbb-prog-track{position:relative;background:color-mix(in srgb,var(--accent) 12%,var(--grid));border-radius:999px;overflow:hidden}
.dbb-prog-fill{position:absolute;left:0;bottom:0;border-radius:999px;transition:width .5s ease,height .5s ease}
.dbb-prog-tick{position:absolute;background:var(--ink-3);opacity:.7}
.dbb-prog.vert{flex-direction:row;align-items:stretch;justify-content:center;gap:14px}
.dbb-root .dbb-card .dbb-meter{--imx-meter-h:12px}
.dbb-root .dbb-card .dbb-meter>.tr{position:relative;background:color-mix(in srgb,var(--accent) 12%,var(--grid))}
.dbb-dark .dbb-card .dbb-meter>.tr{background:rgba(255,255,255,.12)}
.dbb-mv{display:flex;flex-direction:column;gap:2px;height:100%;overflow:auto;justify-content:var(--card-justify,flex-start)}
.dbb-card.al-center .dbb-mv-row .k{flex:0 1 auto}.dbb-card.al-center .dbb-mv-row{justify-content:center}.dbb-card.al-right .dbb-mv-row .k{text-align:right}
.dbb-mv-row{display:flex;align-items:center;gap:8px;padding:6px 2px;border-bottom:1px solid var(--grid)}
.dbb-mv-row:last-child{border-bottom:0}
.dbb-mv-row .k{flex:1;color:var(--ink-2);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-mv-row .v{font-weight:600;font-variant-numeric:tabular-nums;font-size:14px}
.dbb-mv-row .u{color:var(--ink-3);font-size:11px;margin-left:3px;font-weight:400}
.dbb-sum{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;height:100%;align-items:var(--card-valign,center);text-align:var(--card-align,left)}
.dbb-sum div{display:flex;flex-direction:column;gap:2px;min-width:0;align-items:var(--card-align-items,flex-start)}
.dbb-card.title-bottom .dbb-card-h{order:2;padding:0 var(--card-pad,var(--pad)) calc(var(--card-pad,var(--pad)) - 1px)}
.dbb-card.title-bottom .dbb-card-b{order:1;padding-top:var(--card-pad,var(--pad))}
.dbb-card.title-bottom .dbb-card-f{order:3}
.dbb-sum .k{font-size:11px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em}
.dbb-sum .v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-2)}
.dbb-dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex:none}
.dbb-pill{display:inline-flex;align-items:center;gap:8px;font-size:18px;font-weight:600;padding:6px 14px 6px 10px;border-radius:999px;background:color-mix(in srgb,var(--pill) 14%,transparent);color:var(--ink)}
.dbb-pill .dbb-dot{width:12px;height:12px;background:var(--pill);box-shadow:0 0 0 4px color-mix(in srgb,var(--pill) 25%,transparent)}
.dbb-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--ink-2);padding-bottom:4px}
.dbb-legend span{display:inline-flex;align-items:center;gap:5px}
.dbb-legend i{width:12px;height:3px;border-radius:2px;display:inline-block}
.dbb-legend i.sq{width:10px;height:10px;border-radius:3px}
.dbb-tip{position:absolute;pointer-events:none;background:#1a1a19;color:#fff;font-size:11px;padding:6px 8px;border-radius:8px;white-space:nowrap;z-index:5;box-shadow:0 4px 14px rgba(0,0,0,.22)}
.dbb-tip b{font-weight:600}
.dbb-table{width:100%;border-collapse:collapse;font-size:12px}
.dbb-table th{text-align:center;vertical-align:middle;color:var(--ink-3);font-weight:500;padding:6px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card-bg,var(--surface));font-size:11px;text-transform:uppercase;letter-spacing:.03em}
.dbb-table td{padding:6px;border-bottom:1px solid var(--grid);font-variant-numeric:tabular-nums;text-align:center;vertical-align:middle;font-size:12px;line-height:1.4;font-family:inherit;color:inherit}
.dbb-table tbody tr:hover td{background:var(--hover)}
.dbb-table td .cell{display:inline-block;border-radius:6px;padding:1px 7px}
.dbb-scroll{height:100%;overflow:auto}
.dbb-md{height:100%;overflow:auto;line-height:1.45;word-wrap:break-word}
[style*="--card-justify"] .dbb-md{display:flex;flex-direction:column;justify-content:var(--card-justify)}
.dbb-md h1,.dbb-md h2,.dbb-md h3,.dbb-md h4{margin:0 0 4px;font-weight:600;line-height:1.2}
.dbb-md h1{font-size:24px}.dbb-md h2{font-size:18px}.dbb-md h3{font-size:15px}.dbb-md h4{font-size:13px}
.dbb-md p,.dbb-md div{margin:0 0 4px}.dbb-md ul,.dbb-md ol{margin:0 0 6px;padding-left:20px}
.dbb-md blockquote{margin:0 0 6px;padding:4px 10px;border-left:3px solid var(--accent);color:var(--ink-2)}
.dbb-md a{color:var(--accent)}
.dbb-md code{font-family:"JetBrains Mono",monospace;background:var(--grid);padding:0 4px;border-radius:4px}
.dbb-md mark{background:#fde68a;color:inherit;border-radius:3px;padding:0 2px}
.dbb-ph-v{font-variant-numeric:tabular-nums}
.dbb-sev{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600}
.dbb-img{width:100%;height:100%;display:block;border-radius:calc(var(--card-radius,var(--radius)) - 4px)}
.dbb-linkw{display:flex;align-items:center;justify-content:center;height:100%}
.dbb-go{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;height:100%;min-height:34px;border-radius:calc(var(--card-radius,var(--radius)) - 2px);font:inherit;font-weight:600;font-size:14px;cursor:pointer;border:1.5px solid var(--go);text-decoration:none;transition:filter .15s,transform .1s}
.dbb-go.filled{background:var(--go);color:#fff}
.dbb-go.outline{background:transparent;color:var(--go)}
.dbb-go.card{background:color-mix(in srgb,var(--go) 10%,var(--surface));color:var(--ink);border-color:transparent;justify-content:flex-start;padding:0 14px}
.dbb-go:hover{filter:brightness(.95)}
.dbb-go:active{transform:scale(.98)}
.dbb-go svg{width:18px;height:18px}
.dbb-go.card .ic{color:var(--go)}
.dbb-go[aria-disabled="true"]{opacity:.55;cursor:default}
.dbb-frame{width:100%;height:100%;border:0;border-radius:8px;background:var(--surface)}
.dbb-btn{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;transition:background .12s,border-color .12s,box-shadow .12s}
.dbb-btn:hover{background:var(--hover);border-color:color-mix(in srgb,var(--accent) 35%,var(--line))}
.dbb-btn svg{width:15px;height:15px}
.dbb-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;box-shadow:0 1px 2px rgba(16,24,40,.12)}
.dbb-btn.primary:hover{filter:brightness(.95);background:var(--accent)}
.dbb-btn.danger{color:var(--danger)}
.dbb-btn:disabled{opacity:.5;cursor:default}
.dbb-banner{font-size:12px;padding:7px 12px;border-radius:8px;background:#eef4fc;color:#184f95}
.dbb-banner.warn{background:#fff5e0;color:#7a5200}
.dbb-banner.err{background:#fdecec;color:#8e2222}
.dbb-dark .dbb-banner{background:#1c2c44;color:#b7d3f6}
.dbb-skel{height:100%;display:flex;flex-direction:column;justify-content:center;gap:8px;overflow:hidden}
.dbb-skel-kpi{display:flex;flex-direction:column;gap:9px;align-items:var(--card-align-items,flex-start)}
.dbb-skel-round{display:flex;align-items:center;justify-content:center;height:100%}
.dbb-skel-ring{width:min(96px,70%);aspect-ratio:1;border-radius:50%!important}
.dbb-skel-chart{flex:1;height:auto!important;min-height:40px;padding:4px 4px 0!important;border-bottom-color:var(--line)!important}
.dbb-skel-sum{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.dbb-skel .imx-skel-row{height:30px;padding:0 4px;gap:10px}
.dbb-dark .dbb-skel .imx-skel,.dbb-dark .dbb-st-skel .imx-skel{--imx-skel1:rgba(255,255,255,.07);--imx-skel2:rgba(255,255,255,.13)}
.dbb-dark .dbb-skel .imx-skel-row{border-top-color:rgba(255,255,255,.07)}
@keyframes dbbfade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.dbb-card-b.dbb-first>*{animation:dbbfade .25s ease-out}
/* D-056: the app's dark mode. Tooltips stand off the dark cards, status banners keep their meaning, highlights stay readable. */
html[data-imx-mode="dark"] .dbb-dark :is(.dbb-tip,.dbb-info .dbb-info-pop){background:#1E2A40;color:#E6EBF3;border:1px solid #33415C;box-shadow:0 8px 24px rgba(0,0,0,.45)}
html[data-imx-mode="dark"] .dbb-dark .dbb-info-pop a{color:#9ec5f4}
html[data-imx-mode="dark"] .dbb-dark .dbb-banner.warn{background:rgba(245,158,11,.16);color:#FCD34D}
html[data-imx-mode="dark"] .dbb-dark .dbb-banner.err{background:rgba(239,68,68,.16);color:#FCA5A5}
html[data-imx-mode="dark"] .dbb-dark .dbb-md mark{background:rgba(250,204,21,.3)}
html[data-imx-mode="dark"] .dbb-appdark .dbb-skel .imx-skel,html[data-imx-mode="dark"] .dbb-appdark .dbb-st-skel .imx-skel{--imx-skel1:#1C2639;--imx-skel2:#25314A}
`;

/** Adds a <style id=...> to <head> unless one with that id exists. Changing the CSS needs a page reload to apply. */
export function ensureCss(id: string, css: string) {
  // D-031: a style element left by an older build on the same page (widgets re-imported without a full reload,
  // or another widget type still on an older build) is updated, not kept
  const cur = document.getElementById(id);
  if (cur) {
    if (cur.textContent !== css) cur.textContent = css;
    return;
  }
  const s = document.createElement('style');
  s.id = id;
  s.textContent = css;
  document.head.appendChild(s);
}

/** HTML-escapes any value (& < > " ') for text and quoted attributes. null/undefined become ''. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Locale number with exactly `decimals` decimals. Non-numbers are returned as String(v) ('—' for null) and are NOT escaped. */
export function fmtNum(v: unknown, decimals = 1): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v == null ? '—' : String(v);
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Axis label for a timestamp: time of day for spans up to 36 h, else date (+ hour up to 8 days). */
export function fmtTime(ts: number, spanMs: number): string {
  const d = new Date(ts);
  if (spanMs <= 36 * 3600e3) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + (spanMs <= 8 * 86400e3 ? ` ${d.toLocaleTimeString(undefined, { hour: '2-digit' })}` : '');
}

/** Relative age of a timestamp: "12s ago", "5 min ago", "3 h ago", "2 d ago". */
export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/**
 * Creates an element. attrs: 'class' and 'style' are set directly, on* functions become handlers,
 * other values become attributes (undefined / null / false are skipped).
 * `html` is assigned as innerHTML unescaped: escape any user text first.
 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') (e as any)[k] = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  }
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** Colour from bands: first band whose upTo >= value (null = infinity). Legacy format; new widgets use colour rules (render/rules.ts). Returns null without bands or for non-finite values. */
export function bandColor(v: number, bands?: { upTo: number | null; color: string }[]): string | null {
  if (!bands?.length || !Number.isFinite(v)) return null;
  for (const b of bands) if (b.upTo === null || v <= b.upTo) return b.color;
  return bands[bands.length - 1].color;
}

/** Tiny safe markdown: headings, bold, italics, bullets, paragraphs. Escapes HTML first. Used for text widgets saved before rich text (settings.markdown). */
export function miniMarkdown(src: string): string {
  const lines = esc(src).split(/\r?\n/);
  const out: string[] = [];
  let list = false;
  const inline = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
  for (const l of lines) {
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    const li = /^\s*[-*]\s+(.*)$/.exec(l);
    if (li) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (list) {
      out.push('</ul>');
      list = false;
    }
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

/** D-033 header wording: "just now", "2 seconds ago", "5 minutes ago", "3 hours ago", "2 days ago". */
export function agoWords(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'} ago`;
  if (s < 2) return 'just now';
  if (s < 60) return unit(s, 'second');
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86400), 'day');
}
