/**
 * render/kit.ts — the Dashboard Builder's adapter to the iMEX kit (D-043; App UI widgets/_shared/kit.css + kit.js,
 * its U-027 to U-031). The same exports as the Reports app's `widget/src/kit.ts`.
 *
 * WHAT IT IS
 * The iMEX app draws its progress bars, skeletons, busy buttons, value meters and toasts from one stylesheet, the
 * "kit". Its CSS comes in here as a generated copy (render/kit-css.ts, written by the App UI's scripts/export-kit.mjs;
 * never edit that file). ensureKitCss() injects it once per page as <style id="imx-kit-css" data-v="YYYYMMDD.HHmm">:
 * the copy with the newest version wins, whichever product injected it first, so an old Builder bundle can never
 * downgrade the app's look. Inside the app, window.imxKit (installed by the app's widgets) does the injecting; on a
 * page without it (the Builder's own stand-in app, the test harness) the same rule runs here.
 *
 * HOW THE BUILDER USES IT
 * - Colours follow the dashboard theme: `.dbb-root` maps the kit's bar colours to `--accent` / `--line`
 *   (KIT_BRIDGE_CSS), and the kit's own `.dbb-dark` rules cover the dark presets.
 * - progressBar / skeleton* return HTML; topProgress() puts a hairline on an element while something loads;
 *   withBusy() marks a button busy while its action runs; pageBusy() feeds the app's page bar (window event
 *   'imx-progress' {key, on}, which the kit listens to; nothing happens on a page without the kit).
 * - kitToast / kitConfirm hand a message or a question to the app's toast stack and confirm dialog
 *   (window.imxToast / window.imxKit) when they are on the page, and return false / null otherwise so the caller
 *   keeps its own (the Builder's toasts in builder/ui.ts, its modals).
 *
 * No ThingsBoard calls here. Everything is safe to call outside a browser (it does nothing).
 */
import { KIT_CSS, KIT_VERSION } from './kit-css';
import { ensureCss, esc } from './theme';

/** Dashboard theme -> kit colours. Injected with the kit CSS. */
export const KIT_BRIDGE_CSS = `
.dbb-root{--imx-prog-fill:var(--accent);--imx-prog-track:var(--line)}
.dbb-hair{--imx-prog-h:2px;z-index:7}
`;

const hasDom = () => typeof document !== 'undefined' && typeof window !== 'undefined';
/** Kit versions are 'YYYYMMDD.HHmm' (UTC), compared as strings; anything else counts as the oldest. */
const vkey = (v: unknown) => (/^\d{8}\.\d{4}$/.test(String(v ?? '')) ? String(v) : '0');

/**
 * Injects the kit CSS (once per page, newest version wins) and the Builder's colour bridge.
 * The same rule as the kit's own ensureStyle: an existing #imx-kit-css with an equal or newer data-v stays.
 */
export function ensureKitCss(): void {
  if (!hasDom()) return;
  const k = (window as any).imxKit;
  try {
    if (k && typeof k.ensureStyle === 'function') k.ensureStyle('imx-kit-css', KIT_VERSION, KIT_CSS);
    else {
      let el = document.getElementById('imx-kit-css');
      if (!(el && el.textContent && vkey(el.getAttribute('data-v')) >= vkey(KIT_VERSION))) {
        if (!el) {
          el = document.createElement('style');
          el.id = 'imx-kit-css';
          (document.head || document.documentElement).appendChild(el);
        }
        el.setAttribute('data-v', KIT_VERSION);
        el.textContent = KIT_CSS;
      }
    }
  } catch {
    /* a page without <head> access: the bars are just unstyled */
  }
  ensureCss('dbb-css-kit', KIT_BRIDGE_CSS);
}

const clamp = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0);

/**
 * A progress bar as HTML: determinate with a number (0-100), else indeterminate (a sliding segment).
 * @param o.label accessible name, also shown beside the bar; o.tone 'dark' (on dark surfaces), 'bad', 'paused';
 *   o.cls extra classes; o.bare the bar alone, without the label row.
 */
export function progressBar(o: { value?: number | null; label?: string; tone?: 'dark' | 'bad' | 'paused'; cls?: string; bare?: boolean } = {}): string {
  const det = typeof o.value === 'number' && Number.isFinite(o.value);
  const p = det ? clamp(o.value as number) : 0;
  const bar =
    `<div class="imx-prog ${det ? 'det' : 'ind'}${o.tone ? ` ${o.tone}` : ''}${o.cls ? ` ${esc(o.cls)}` : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100"` +
    `${det ? ` aria-valuenow="${Math.round(p)}" style="--imx-prog-v:${p}%"` : ''}${o.label ? ` aria-label="${esc(o.label)}"` : ''}><i></i></div>`;
  if (o.bare || (!o.label && !det)) return bar;
  return `<div class="imx-prog-row">${bar}${o.label ? `<span>${esc(o.label)}</span>` : ''}${det ? `<b>${Math.round(p)}%</b>` : ''}</div>`;
}

/** Handle of topProgress(). Every method is safe to call more than once. */
export interface TopProgress {
  /** Switches to a determinate bar at `v` % (null = indeterminate again). */
  set(v: number | null, label?: string): TopProgress;
  /** Finishes: a determinate bar fills first; the bar stays at least `min` ms once shown. */
  done(): void;
  /** Finishes in the error colour. */
  fail(): void;
  /** Removes it at once. */
  stop(): void;
}

let seq = 0;

/**
 * A hairline along the top edge of `host` while something loads. Shown only after `delay` ms (a fast load shows
 * nothing) and then for at least `min` ms, so it never flickers. While shown it also counts for the app's page bar
 * when `o.page` is true (pageBusy).
 * @param host an element; it gets position:relative when it is static.
 * @param o.delay ms before it shows (default 150); o.min ms it stays once shown (default 350); o.height px
 *   (default 3; cards use 2); o.label accessible name; o.cls extra classes.
 */
export function topProgress(host: HTMLElement | null | undefined, o: { delay?: number; min?: number; height?: number; label?: string; cls?: string; page?: boolean } = {}): TopProgress {
  const delay = o.delay ?? 150;
  const min = o.min ?? 350;
  let state: 'wait' | 'on' | 'ending' | 'off' = 'wait';
  let shown = 0;
  let det: number | null = null;
  let bad = false;
  let oldPos: string | null = null;
  const key = `dbb-prog-${++seq}`;
  const h: TopProgress = { set: () => h, done: () => {}, fail: () => {}, stop: () => {} };
  if (!host || !hasDom()) return h;
  ensureKitCss();
  const bar = document.createElement('div');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-label', o.label ?? 'Loading');
  bar.innerHTML = '<i></i>';
  if (o.height) bar.style.setProperty('--imx-prog-h', `${o.height}px`);
  const paint = () => {
    bar.className = `imx-prog top ${det === null ? 'ind' : 'det'}${bad ? ' bad' : ''}${o.cls ? ` ${o.cls}` : ''}`;
    if (det === null) {
      bar.style.removeProperty('--imx-prog-v');
      bar.removeAttribute('aria-valuenow');
    } else {
      bar.style.setProperty('--imx-prog-v', `${det}%`);
      bar.setAttribute('aria-valuenow', String(Math.round(det)));
    }
  };
  const show = () => {
    if (state !== 'wait') return;
    if (!host.isConnected) {
      state = 'off';
      return;
    }
    state = 'on';
    shown = Date.now();
    if (getComputedStyle(host).position === 'static') {
      oldPos = host.style.position;
      host.style.position = 'relative';
    }
    paint();
    host.appendChild(bar);
    if (o.page) pageBusy(key, true);
  };
  const remove = () => {
    state = 'off';
    bar.remove();
    if (oldPos !== null) host.style.position = oldPos;
    oldPos = null;
    if (o.page) pageBusy(key, false);
  };
  const timer = delay > 0 ? setTimeout(show, delay) : null;
  if (!timer) show();
  const finish = (extra: number) => {
    if (timer) clearTimeout(timer);
    if (state === 'wait') state = 'off';
    if (state !== 'on') return;
    state = 'ending';
    setTimeout(remove, Math.max(min - (Date.now() - shown), extra));
  };
  h.set = (v, label) => {
    det = v === null ? null : clamp(v);
    if (label) bar.setAttribute('aria-label', label);
    if (state === 'on') paint();
    return h;
  };
  h.done = () => {
    if (det !== null && state === 'on') {
      det = 100;
      paint();
      finish(250);
    } else finish(0);
  };
  h.fail = () => {
    if (state === 'on') {
      bad = true;
      paint();
      finish(600);
    } else finish(0);
  };
  h.stop = () => {
    if (timer) clearTimeout(timer);
    if (state === 'wait') state = 'off';
    else if (state !== 'off') remove();
  };
  return h;
}

/**
 * Runs `work` with `btn` marked busy: disabled, aria-busy="true" and the kit's 2 px bar along its bottom edge,
 * optionally with `label` as its text ("Saving…"). Restored when the work settles, success or not. A second call
 * on the same button while it runs returns the running promise.
 */
export function withBusy<T>(btn: HTMLElement | null | undefined, work: Promise<T> | (() => Promise<T>), label?: string): Promise<T> {
  const el = btn as (HTMLElement & { __dbbBusy?: Promise<any> }) | null | undefined;
  if (el?.__dbbBusy) return el.__dbbBusy as Promise<T>;
  let oldDis: boolean | null = null;
  let oldTxt: string | null = null;
  if (el) {
    ensureKitCss();
    el.setAttribute('aria-busy', 'true');
    el.classList.add('imx-busy');
    if ('disabled' in el) {
      oldDis = (el as HTMLButtonElement).disabled;
      (el as HTMLButtonElement).disabled = true;
    }
    if (label && !el.children.length) {
      oldTxt = el.textContent;
      el.textContent = label;
    }
  }
  const restore = () => {
    if (!el) return;
    el.__dbbBusy = undefined;
    el.removeAttribute('aria-busy');
    el.classList.remove('imx-busy');
    if (oldDis !== null) (el as HTMLButtonElement).disabled = oldDis;
    if (oldTxt !== null) el.textContent = oldTxt;
  };
  let p: Promise<T>;
  try {
    p = Promise.resolve(typeof work === 'function' ? work() : work);
  } catch (e) {
    p = Promise.reject(e);
  }
  const out = p.then(
    (v) => {
      restore();
      return v;
    },
    (e) => {
      restore();
      throw e;
    },
  );
  if (el) el.__dbbBusy = out;
  return out;
}

/** Placeholder rows (a table or a list that is loading) as HTML. */
export function skeletonRows(rows: number, cols: number): string {
  let h = '';
  for (let i = 0; i < rows; i++) h += `<div class="imx-skel-row">${'<span class="imx-skel"></span>'.repeat(Math.max(1, cols))}</div>`;
  return `<div class="imx-skel-rows" aria-hidden="true">${h}</div>`;
}

const HEIGHTS = [55, 80, 40, 95, 65, 75, 50, 85];

/**
 * A card body placeholder in the shape of the widget type, as HTML (render/widgets.ts shows it until the first
 * draw). The outer element has the class `dbb-skel`, so the caller can tell it from drawn content.
 */
export function cardSkeleton(type: string): string {
  const s = (style: string, cls = '') => `<span class="imx-skel${cls ? ` ${cls}` : ''}" style="${style}"></span>`;
  let inner: string;
  switch (type) {
    case 'value':
    case 'kpi':
    case 'status':
    case 'progress':
      inner = `<div class="dbb-skel-kpi">${s('width:46%;height:28px')}${s('width:72%;height:10px')}${type === 'progress' ? s('width:100%;height:10px;border-radius:999px') : ''}</div>`;
      break;
    case 'gauge':
    case 'donut':
      inner = `<div class="dbb-skel-round">${s('', 'dbb-skel-ring')}</div>`;
      break;
    case 'line':
    case 'area':
    case 'bar':
    case 'heatmap':
    case 'timeline':
      inner = `<div class="imx-skel-chart dbb-skel-chart">${HEIGHTS.map((h) => s(`height:${h}%`)).join('')}</div>`;
      break;
    case 'table':
    case 'alarms':
    case 'multivalue':
      inner = skeletonRows(4, type === 'multivalue' ? 2 : 3);
      break;
    case 'summary':
      inner = `<div class="dbb-skel-sum">${s('height:30px').repeat(4)}</div>`;
      break;
    default:
      inner = `<div class="dbb-skel-kpi">${s('width:60%;height:12px')}${s('width:80%;height:12px')}</div>`;
  }
  return `<div class="dbb-skel" aria-hidden="true">${inner}</div>`;
}

/**
 * Tells the app's page bar that something of the Builder is loading (`on`) or finished (window CustomEvent
 * 'imx-progress' {key, on}; the kit turns a key off by itself after 60 s). Nothing happens without the kit.
 */
export function pageBusy(key: string, on: boolean): void {
  if (!hasDom()) return;
  try {
    window.dispatchEvent(new CustomEvent('imx-progress', { detail: { key: `dbb:${key}`, on } }));
  } catch {
    /* very old browser */
  }
}

/**
 * Shows `msg` in the app's toast stack when the iMEX app is on the page (window.imxToast, else window.imxKit.toast).
 * @param kind the Builder's kinds: 'ok' | 'warn' | 'err' (and 'info').
 * @returns true when the app showed it; false = the caller shows its own.
 */
export function kitToast(msg: string, kind: 'ok' | 'warn' | 'err' | 'info' = 'ok'): boolean {
  if (!hasDom()) return false;
  const w = window as any;
  const fn = typeof w.imxToast === 'function' ? w.imxToast : typeof w.imxKit?.toast === 'function' ? w.imxKit.toast : null;
  if (!fn) return false;
  try {
    fn(String(msg ?? ''), { kind: kind === 'err' ? 'error' : kind });
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks with the app's confirm dialog when the iMEX app is on the page (window.imxKit.confirm).
 * @returns the answer, or null when the app's dialog is not there (the caller asks with its own modal).
 */
export function kitConfirm(o: { title: string; message: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> | null {
  if (!hasDom()) return null;
  const k = (window as any).imxKit;
  if (!k || typeof k.confirm !== 'function') return null;
  try {
    return Promise.resolve(k.confirm(o)).then((v: unknown) => v === true);
  } catch {
    return null;
  }
}

/** Handle of kitSelects(): the kit's own selects() handle (its methods reach the newest kit on the page). */
export interface KitSelects {
  /** Repaints the drop-downs under `scope` (default: the root); the kit's observer normally does this by itself. */
  refresh(scope?: Element): void;
  /** Closes an open list. */
  close(): void;
  /** Gives the native selects back. */
  destroy(): void;
}

/**
 * D-074 (UI audit H2): the app's drop-down (window.imxKit.selects, App UI R8 U-094) on every native <select> under
 * `root`. The select stays the source of truth: its value, options and change / input handlers stay as they are (the
 * kit sets the value and sends input + change), so the Builder's handlers need no change. The kit watches `root`
 * (MutationObserver), so a redraw or a dialog appended inside it is covered without another call; calling again for
 * the same root only updates the options and rescans.
 * @param o.sm true, or a function (select) -> boolean: the compact button (toolbars, rule rows).
 * @returns the handle, or null on a page without the kit (the native selects stay; nothing else changes).
 */
export function kitSelects(root: HTMLElement | null | undefined, o: { sm?: boolean | ((s: HTMLSelectElement) => boolean) } = {}): KitSelects | null {
  if (!root || !hasDom()) return null;
  const k = (window as any).imxKit;
  if (!k || typeof k.selects !== 'function') return null;
  try {
    return k.selects(root, o) ?? null;
  } catch {
    return null;
  }
}
