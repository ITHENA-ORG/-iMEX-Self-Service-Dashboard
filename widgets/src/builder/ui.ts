/**
 * Minimal in-page modals and toasts for the Dashboard Builder, used instead of the browser's
 * native alert/confirm/prompt (which block the ThingsBoard page and cannot be styled).
 *
 * Runs in the browser inside a ThingsBoard widget. Elements are appended to a `root` element
 * that the caller passes in (normally the builder overlay), so they pick up its theme CSS
 * variables. Styling lives in `builder/styles.ts` (`.dbb-modal*`, `.dbb-toast*`).
 *
 * Exports:
 * - `modal`: generic dialog with custom HTML body and buttons; returns a handle.
 * - `confirmModal`: yes/no wrapper around `modal`.
 * - `toast`: short, auto-dismissing status message (D-045: the iMEX app's toast when the app is on the page).
 * Used by `builder/builder.ts` (save/apply flow, templates, history, warnings) and by
 * `entries/renderer.ts` for the machine page's edit-menu dialogs (Customise, Reset, thresholds).
 */
import { esc } from '../render/theme';
import { kitToast } from '../render/kit';
import * as dfmt from '../core/datefmt';

/** Handle returned by `modal()`. */
export interface ModalHandle {
  /** The dialog body element, for reading inputs or wiring extra events. */
  body: HTMLElement;
  /** Resolves with the key of the button clicked, or 'cancel' (Escape / backdrop click). */
  result: Promise<string>;
  /** Closes the dialog programmatically and resolves `result` with `v`. */
  close(v: string): void;
  /** The footer button with this key, e.g. to disable it until a form is valid. */
  button(key: string): HTMLButtonElement;
}

/**
 * Opens a modal dialog.
 * @param root Element to mount in (the dialog covers it).
 * @param title Header text; escaped.
 * @param html Body markup, inserted as-is: the CALLER must escape any user or telemetry data.
 * @param buttons Footer buttons as `[key, label, extraClass?]`, e.g. `['ok', 'Save', 'primary']`.
 *   Labels are escaped; the key is what `result` resolves with.
 * @param boxClass Extra class on the dialog box, e.g. 'wide' (D-027).
 * @returns A handle; the dialog stays open until a button, Escape, a backdrop click or `close()`.
 * Side effects: adds a capture-phase keydown listener on `document`, removed on close.
 */
export function modal(root: HTMLElement, title: string, html: string, buttons: [string, string, string?][], boxClass = ''): ModalHandle {
  const wrap = document.createElement('div');
  wrap.className = 'dbb-modal';
  wrap.innerHTML = `<div class="dbb-modal-box ${boxClass}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="dbb-modal-h">${esc(title)}</div><div class="dbb-modal-b">${html}</div>
    <div class="dbb-modal-f">${buttons.map(([k, l, c]) => `<button class="dbb-btn ${c ?? ''}" data-mb="${k}">${esc(l)}</button>`).join('')}</div></div>`;
  root.appendChild(wrap);
  let resolve!: (v: string) => void;
  const result = new Promise<string>((r) => (resolve = r));
  const close = (v: string) => {
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
    resolve(v);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Capture phase + stopPropagation: Escape closes only this dialog, not the builder
      // overlay or ThingsBoard's own dialogs listening further down.
      e.stopPropagation();
      close('cancel');
    }
  };
  document.addEventListener('keydown', onKey, true);
  wrap.querySelectorAll<HTMLButtonElement>('[data-mb]').forEach((b) => (b.onclick = () => close(b.dataset.mb!)));
  // Only a press on the dimmed backdrop itself cancels, not one inside the dialog box.
  wrap.addEventListener('mousedown', (e) => e.target === wrap && close('cancel'));
  return { body: wrap.querySelector('.dbb-modal-b') as HTMLElement, result, close, button: (k) => wrap.querySelector(`[data-mb="${k}"]`) as HTMLButtonElement };
}

/**
 * Asks a yes/no question.
 * @param text Plain text (escaped).
 * @param okLabel Label of the confirming button.
 * @param danger Styles the confirm button red, for destructive actions.
 * @returns true only if the confirm button was clicked; Cancel, Escape and backdrop give false.
 */
export async function confirmModal(root: HTMLElement, title: string, text: string, okLabel: string, danger = false): Promise<boolean> {
  const m = modal(root, title, `<div>${esc(text)}</div>`, [
    ['cancel', 'Cancel'],
    ['ok', okLabel, danger ? 'primary danger-fill' : 'primary'],
  ]);
  return (await m.result) === 'ok';
}

/**
 * Shows a short message. D-045: inside the iMEX app it goes to the app's one toast stack (bottom right, themed,
 * window.imxToast; kinds ok / warn / error), so the Builder never shows a second kind of toast there. Without the
 * app (the stand-in app, the test harness) it uses its own stack inside `root` (created on first use, with
 * `role="status"` so screen readers announce it). Errors stay 8 s, others 4 s.
 * @param text Plain text (set via textContent, so no escaping needed).
 * @param kind 'ok' (dark), 'warn' (amber) or 'err' (red).
 */
export function toast(root: HTMLElement, text: string, kind: 'ok' | 'warn' | 'err' = 'ok') {
  if (kitToast(text, kind)) return;
  let host = root.querySelector('.dbb-toasts') as HTMLElement | null;
  if (!host) {
    host = document.createElement('div');
    host.className = 'dbb-toasts';
    host.setAttribute('role', 'status');
    root.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `dbb-toast ${kind}`;
  t.textContent = text;
  host.appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 8000 : 4000);
}

// ---------- D-032 start screen helpers ----------

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else the date. */
export function relTime(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return dfmt.date(ts); // D-061 (M2): "16 Oct 2026", never a numeric date
}

/** Up to two initials of a name ("Blower Overview" -> "BO"). */
export const initials = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

const AV = ['linear-gradient(135deg,#2a78d6,#5b9cf0)', 'linear-gradient(135deg,#6d4ce0,#9b7cf5)', 'linear-gradient(135deg,#0f9d8f,#35c2b2)', 'linear-gradient(135deg,#e8590c,#f59f4c)', 'linear-gradient(135deg,#c2185b,#e5578e)', 'linear-gradient(135deg,#3f51b5,#7986cb)'];
/** Stable avatar gradient for a name. */
export const avatarColor = (s: string) => AV[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AV.length];

const sv = (p: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
/** Icons of the start screen. */
export const ST_ICON = {
  plus: sv('<path d="M12 5v14M5 12h14"/>'),
  folder: sv('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  chat: sv('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/>'),
  chev: sv('<path d="M9 18l6-6-6-6"/>'),
};
