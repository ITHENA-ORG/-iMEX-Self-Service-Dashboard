/**
 * entries/timepicker.ts — the "Time window" menu of the machine page and the Dashboard Overview bar (D-061, audit H3).
 *
 * Opened from the bar's Time window pill (renderer.ts). Items, in the app's preset order (core/viewwindow.ts):
 *   Dashboard default (the dashboard's own window, named) · Last hour · Last 4 hours · Last 8 hours · Last 24 hours ·
 *   Current shift · Previous shift (each with the shift it shows, from the machine's shift calendar; greyed out with the
 *   reason when there is none) · Custom… (a month calendar, start and end times, "Show this period").
 * The choice in effect has a tick (no filled selection). The look is the bar's "Edit dashboard" menu (.dbb-rmenu, appended
 * to <body>, anchored under the pill, kept in the window). Keyboard: Up / Down / Home / End move between the items,
 * Escape closes and gives the focus back to the pill; in the custom panel Tab moves between its fields and Enter in a
 * time field applies. A click outside closes it.
 * Times are the browser's wall-clock times, written in the app's format (core/datefmt.ts).
 */
import { esc } from '../render/theme';
import { UI_ICON } from '../render/icons';
import { VIEW_PRESETS, presetLabel, viewLabel, customProblem, viewWindow, MAX_BACK_MS } from '../core/viewwindow';
import type { ViewWindow } from '../core/viewwindow';
import type { ShiftSource } from '../core/schema';
import * as fmt from '../core/datefmt';
import * as regional from '../core/regional';
import { shiftWindowText } from '../core/shifts';

/** What the menu needs from the page. */
export interface WindowMenu {
  /** The dashboard's own range ('realtime', '1h', 'shift', ...). */
  dashRange: string;
  /** The viewer's choice in effect (null = the dashboard's window). */
  view: ViewWindow | null;
  /** The machine's shift calendar and its zone (null: no shifts set, or no machine). */
  cal: Promise<{ cal: ShiftSource | null; tz?: string } | null>;
  /** Called with the new choice (null = back to the dashboard's window). */
  onPick(v: ViewWindow | null): void;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = 86400e3;
const DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
/** The pill's chevron (renderer.ts). */
export const TW_CHEV = DOWN;

/** The menu's own styles (on top of the bar menu's .dbb-rmenu). */
export const TW_CSS = `
.dbb-rmenu.dbb-twmenu{width:316px}
.dbb-twmenu button .tw{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dbb-twmenu button .tw .t{flex:none}
.dbb-twmenu button .tw .s{font-size:12px;color:var(--imx-muted,#5B6B82);font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-twmenu button[aria-disabled="true"]{opacity:.5;cursor:default}
.dbb-twmenu button[aria-disabled="true"]:hover{background:transparent}
.dbb-twmenu.custom > button[data-v],.dbb-twmenu.custom > .dbb-rm-hr.p{display:none}
.dbb-twc{display:flex;flex-direction:column;gap:8px;padding:6px 8px 4px}
.dbb-twc[hidden]{display:none}
.dbb-twc-mh{display:flex;align-items:center;justify-content:space-between;gap:6px}
.dbb-twc-mh b{font-size:13px;font-weight:600}
.dbb-rmenu .dbb-twc-mh button{width:30px;min-height:30px;height:30px;padding:0;justify-content:center;border-radius:8px}
.dbb-rmenu .dbb-twc-mh button[data-m="-1"] svg{transform:rotate(180deg)}
.dbb-rmenu .dbb-twc-mh button[aria-disabled="true"]{opacity:.35;cursor:default}
.dbb-twc-g{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center}
.dbb-twc-g .wd{font-size:11px;font-weight:600;color:var(--imx-muted,#5B6B82);padding:2px 0}
.dbb-rmenu .dbb-twc-g button.d{justify-content:center;min-height:32px;height:32px;padding:0;font-size:13px;border-radius:999px;font-variant-numeric:tabular-nums}
.dbb-rmenu .dbb-twc-g button.d.out{color:var(--imx-muted,#5B6B82)}
.dbb-rmenu .dbb-twc-g button.d.today{box-shadow:inset 0 0 0 1px var(--imx-line,#CBD5E1)}
.dbb-rmenu .dbb-twc-g button.d.in{color:var(--imx-p2,#1D4ED8);font-weight:600}
.dbb-rmenu .dbb-twc-g button.d.end{background:var(--imx-p,#2563EB);color:#FFFFFF;font-weight:600}
.dbb-rmenu .dbb-twc-g button.d[aria-disabled="true"]{opacity:.35;cursor:default}
.dbb-rmenu .dbb-twc-g button.d[aria-disabled="true"]:hover{background:transparent}
.dbb-twc-f{display:grid;grid-template-columns:40px 1fr 104px;align-items:center;gap:8px;font-size:13px}
.dbb-twc-f .l{color:var(--imx-muted,#5B6B82);font-size:12px;font-weight:600}
.dbb-twc-f .d{font-weight:600;white-space:nowrap}
.dbb-rmenu .dbb-twc-f input{box-sizing:border-box;width:100%;height:32px;margin:0;padding:0 10px;border:1px solid var(--imx-line,#CBD5E1);border-radius:8px;background:var(--imx-surface,#FFFFFF);color:var(--imx-text,#0F172A);font:inherit;font-size:13px;text-align:center;outline:none}
.dbb-rmenu .dbb-twc-f input:focus{border-color:var(--imx-p,#2563EB);box-shadow:0 0 0 3px color-mix(in srgb,var(--imx-p,#2563EB) 22%,transparent)}
.dbb-rmenu .dbb-twc-f input.bad{border-color:var(--imx-bad,#DC2626)}
.dbb-twc-hint{font-size:12px;color:var(--imx-muted,#5B6B82);line-height:1.35}
.dbb-twc-err{font-size:12px;color:var(--imx-bad-tx,#B91C1C);line-height:1.35}
.dbb-twc-err:empty{display:none}
.dbb-twc-b{display:flex;justify-content:flex-end;gap:6px;padding-top:2px}
.dbb-rmenu .dbb-twc-b button{width:auto;min-height:34px;height:34px;padding:0 14px;justify-content:center;border-radius:9px;font-size:13px;font-weight:600;border:1px solid var(--imx-line,#CBD5E1)}
.dbb-rmenu .dbb-twc-b button.pri{background:var(--imx-p,#2563EB);border-color:var(--imx-p,#2563EB);color:#FFFFFF}
.dbb-rmenu .dbb-twc-b button.pri:hover{background:var(--imx-p2,#1D4ED8)}
html[data-imx-mode="dark"] .dbb-twmenu button .tw .s,html[data-imx-mode="dark"] .dbb-twc-g .wd,html[data-imx-mode="dark"] .dbb-twc-f .l,html[data-imx-mode="dark"] .dbb-twc-hint,html[data-imx-mode="dark"] .dbb-rmenu .dbb-twc-g button.d.out{color:var(--imx-muted,#97A6BC)}
html[data-imx-mode="dark"] .dbb-rmenu .dbb-twc-f input{background:var(--imx-surface2,#0E1524);color:var(--imx-text,#E6EBF3);border-color:rgba(148,163,184,.35)}
html[data-imx-mode="dark"] .dbb-rmenu .dbb-twc-g button.d.today{box-shadow:inset 0 0 0 1px rgba(148,163,184,.45)}
html[data-imx-mode="dark"] .dbb-rmenu .dbb-twc-g button.d.in{color:var(--imx-p2,#9EC5F4)}
html[data-imx-mode="dark"] .dbb-rmenu .dbb-twc-b button{border-color:rgba(148,163,184,.35)}
html[data-imx-mode="dark"] .dbb-twc-err{color:var(--imx-bad-tx,#FCA5A5)}
`;

/** Local midnight of the day of ts (the browser's calendar). */
const dayStart = (ts: number) => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
/** The instant of minute `min` of the local day starting at `day` (DST-safe: built from the wall clock). */
const at = (day: number, min: number) => {
  const d = new Date(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(min / 60), min % 60).getTime();
};
const minuteOf = (ts: number) => {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
};

/**
 * A typed time of day in minutes, or null: "6", "6:30", "06:30", "6.30", "630", "6 pm", "6:30pm", "18:30", "12 am".
 */
export function parseTime(s: string): number | null {
  const m = /^\s*(\d{1,2})(?:[:.]?(\d{2}))?\s*([ap])?\.?\s*m?\.?\s*$/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (mi > 59) return null;
  const ap = m[3]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === 'p' ? 12 : 0);
  } else if (h > 23) return null;
  return h * 60 + mi;
}
/** Minutes of the day written in the app's clock ("6:30 PM" / "18:30"). */
const timeText = (min: number) => fmt.time(at(dayStart(Date.now()), min));

let twMenu: { el: HTMLElement; btn: HTMLElement; close(focus?: boolean): void } | null = null;
/** Closes the Time window menu (if `within` is given: only when its pill is inside that element). */
export function closeWindowMenu(within?: HTMLElement) {
  if (twMenu && (!within || within.contains(twMenu.btn))) twMenu.close(false);
}

/** Opens the Time window menu under `btn` (a second click on the pill closes it). */
export function openWindowMenu(btn: HTMLButtonElement, m: WindowMenu) {
  if (twMenu?.btn === btn) return twMenu.close(true);
  closeWindowMenu();
  const cur = m.view;
  const isOn = (r: string) => (r === 'default' ? !cur : cur?.range === r);
  const tick = (on: boolean) => (on ? UI_ICON.tick : '');
  const item = (r: string, label: string, sub = '', tip = '') =>
    `<button type="button" role="menuitemradio" aria-checked="${isOn(r)}" class="${isOn(r) ? 'on' : ''}" data-v="${r}"${tip ? ` title="${esc(tip)}"` : ''}><span class="tw"><span class="t">${esc(label)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</span>${tick(isOn(r))}</button>`;
  const el = document.createElement('div');
  el.className = 'dbb-rmenu dbb-twmenu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', 'Time window');
  const hours = VIEW_PRESETS.filter((r) => r.endsWith('h'));
  el.innerHTML = `<div class="dbb-rm-h"><b>Time window</b><span>The period every card on this page shows</span></div><div class="dbb-rm-hr" role="separator"></div>
    ${item('default', 'Dashboard default', presetLabel(m.dashRange), 'The window the dashboard was saved with')}
    <div class="dbb-rm-hr p" role="separator"></div>
    ${hours.map((r) => item(r, presetLabel(r))).join('')}
    <div class="dbb-rm-hr p" role="separator"></div>
    ${item('shift', 'Current shift', 'Looking up the shifts…')}
    ${item('prevshift', 'Previous shift', 'Looking up the shifts…')}
    <div class="dbb-rm-hr p" role="separator"></div>
    <button type="button" role="menuitemradio" aria-checked="${isOn('custom')}" class="${isOn('custom') ? 'on' : ''}" data-custom aria-expanded="false" title="Pick a start and an end (up to 7 days)"><span class="tw"><span class="t">Custom…</span>${cur?.range === 'custom' ? `<span class="s">${esc(viewLabel(cur))}</span>` : ''}</span>${tick(isOn('custom'))}</button>
    <div class="dbb-twc" hidden></div>`;
  document.body.appendChild(el);
  const panel = el.querySelector('.dbb-twc') as HTMLElement;
  const customBtn = el.querySelector('[data-custom]') as HTMLButtonElement;

  // the shift rows: the shift each shows, or why they can't be picked
  void m.cal
    .catch(() => null)
    .then((c) => {
      for (const r of ['shift', 'prevshift'] as const) {
        const b = el.querySelector(`[data-v="${r}"]`) as HTMLButtonElement | null;
        const s = b?.querySelector('.s');
        if (!b || !s) continue;
        const w = c?.cal ? viewWindow({ range: r }, c.cal) : null;
        if (w?.shift) {
          s.textContent = shiftWindowText(w, c?.tz);
          b.title = r === 'shift' ? (w.between ? 'Between shifts: the shift that ended last' : 'The current shift so far') : 'The last shift that has ended';
        } else {
          b.setAttribute('aria-disabled', 'true');
          s.textContent = c?.cal ? (r === 'shift' ? 'No shift now' : 'No shift has ended recently') : 'No shifts set up';
          b.title = c?.cal ? 'No such shift in the last 14 days' : "No shifts are set up for this machine's site. An admin sets them in Configuration › Shifts.";
        }
      }
      place();
    });

  // ---- the custom panel ----
  const now = Date.now();
  const win0 = cur?.range === 'custom' ? { startTs: cur.from!, endTs: cur.to! } : { startTs: now - 3600e3, endTs: now };
  const round5 = (min: number) => Math.floor(min / 5) * 5;
  const c = {
    fromDay: dayStart(win0.startTs),
    toDay: dayStart(win0.endTs),
    fromMin: cur?.range === 'custom' ? minuteOf(win0.startTs) : round5(minuteOf(win0.startTs)),
    toMin: cur?.range === 'custom' ? minuteOf(win0.endTs) : round5(minuteOf(win0.endTs)),
    stage: 'from' as 'from' | 'to',
    month: new Date(dayStart(win0.endTs)).setDate(1),
  };
  const today = dayStart(now);
  const oldest = dayStart(now - MAX_BACK_MS);
  const drawPanel = () => {
    const first = new Date(c.month);
    const y = first.getFullYear();
    const mo = first.getMonth();
    // D-067 (U-073): the week starts on the app's first day (imexAppConfig.formats.weekStart; Monday by default)
    const ws = regional.weekStart();
    const lead = regional.leadDays(first.getDay(), ws);
    const start = new Date(y, mo, 1 - lead).getTime();
    const prevOk = new Date(y, mo, 0).getTime() >= oldest;
    const nextOk = new Date(y, mo + 1, 1).getTime() <= today;
    let days = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(y, mo, 1 - lead + i).getTime();
      const dd = new Date(d);
      const off = d > today || d < oldest;
      const cls = ['d', dd.getMonth() !== mo ? 'out' : '', d === today ? 'today' : '', d === c.fromDay || d === c.toDay ? 'end' : d > c.fromDay && d < c.toDay ? 'in' : ''].filter(Boolean).join(' ');
      days += `<button type="button" class="${cls}" data-day="${d}" aria-label="${esc(fmt.date(d))}"${off ? ' aria-disabled="true"' : ''}>${dd.getDate()}</button>`;
    }
    void start;
    panel.innerHTML = `<div class="dbb-twc-mh"><button type="button" data-m="-1" aria-label="Previous month" title="Previous month"${prevOk ? '' : ' aria-disabled="true"'}>${UI_ICON.chev}</button><b>${MONTHS[mo]} ${y}</b><button type="button" data-m="1" aria-label="Next month" title="Next month"${nextOk ? '' : ' aria-disabled="true"'}>${UI_ICON.chev}</button></div>
      <div class="dbb-twc-g" role="group" aria-label="${MONTHS[mo]} ${y}">${regional.weekdayHeaders(ws).map((x) => `<span class="wd">${x}</span>`).join('')}${days}</div>
      <div class="dbb-twc-f"><span class="l">From</span><span class="d">${esc(fmt.date(c.fromDay))}</span><input type="text" data-t="from" value="${esc(timeText(c.fromMin))}" aria-label="Start time" autocomplete="off" spellcheck="false"/></div>
      <div class="dbb-twc-f"><span class="l">To</span><span class="d">${esc(fmt.date(c.toDay))}</span><input type="text" data-t="to" value="${esc(timeText(c.toMin))}" aria-label="End time" autocomplete="off" spellcheck="false"/></div>
      <div class="dbb-twc-hint">${c.stage === 'to' ? 'Now click the last day (or the same day again).' : 'Click the first day, then the last day. Up to 7 days.'}</div>
      <div class="dbb-twc-err" role="alert"></div>
      <div class="dbb-twc-b"><button type="button" data-cancel>Cancel</button><button type="button" class="pri" data-apply>Show this period</button></div>`;
    place();
  };
  const readTimes = (): boolean => {
    let ok = true;
    for (const which of ['from', 'to'] as const) {
      const inp = panel.querySelector(`[data-t="${which}"]`) as HTMLInputElement | null;
      if (!inp) continue;
      const v = parseTime(inp.value);
      inp.classList.toggle('bad', v == null);
      if (v == null) ok = false;
      else if (which === 'from') c.fromMin = v;
      else c.toMin = v;
    }
    return ok;
  };
  const err = (t: string) => {
    const e = panel.querySelector('.dbb-twc-err');
    if (e) e.textContent = t;
  };
  const apply = () => {
    if (!readTimes()) return err('Write the times like 6:30 AM or 18:30.');
    const from = at(c.fromDay, c.fromMin);
    const to = at(c.toDay, c.toMin);
    const p = customProblem(from, to);
    if (p) return err(p);
    close(false);
    m.onPick({ range: 'custom', from, to });
  };
  const setCustom = (open: boolean) => {
    panel.hidden = !open;
    // the presets make way for the calendar (the menu then fits a 768 px high window); Custom… again brings them back
    el.classList.toggle('custom', open);
    customBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      drawPanel();
      (panel.querySelector('.d.end') as HTMLElement | null)?.focus();
    } else place();
  };

  const place = () => {
    if (!btn.isConnected) return close(false);
    const r = btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    el.style.maxHeight = '';
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let top = r.bottom + 6;
    if (top + h > vh - 8 && r.top - 6 - h >= 8) top = r.top - 6 - h;
    top = Math.max(8, top);
    el.style.top = `${Math.round(top)}px`;
    // under the pill, its left edge aligned (kept in the window)
    el.style.left = `${Math.round(Math.max(8, Math.min(vw - w - 8, r.left)))}px`;
    el.style.maxHeight = `${Math.max(160, vh - top - 8)}px`;
  };
  const items = () => [...el.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.closest('[hidden]') && b.getAttribute('aria-disabled') !== 'true');
  const onKey = (e: KeyboardEvent) => {
    const inInput = (e.target as HTMLElement)?.tagName === 'INPUT';
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return close(true);
    }
    if (inInput) {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply();
      }
      return;
    }
    if (e.key === 'Tab') {
      if (!panel.hidden && panel.contains(document.activeElement)) return; // between the panel's fields
      e.preventDefault();
      return close(true);
    }
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
  };
  const onOutKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !el.contains(document.activeElement)) close(document.activeElement === btn);
  };
  const onDown = (e: Event) => {
    const t = e.target as Node;
    if (!el.contains(t) && !btn.contains(t)) close(false);
  };
  const onMove = () => place();
  function close(focus = false) {
    if (twMenu?.el !== el) return;
    twMenu = null;
    el.remove();
    btn.setAttribute('aria-expanded', 'false');
    if (pillTip) btn.setAttribute('title', pillTip);
    el.removeEventListener('keydown', onKey);
    window.removeEventListener('keydown', onOutKey, true);
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('touchstart', onDown, true);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('scroll', onMove, true);
    if (focus && btn.isConnected) btn.focus();
  }
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    if (b === customBtn) return setCustom(panel.hidden);
    if (b.dataset.m) {
      readTimes();
      const d = new Date(c.month);
      c.month = new Date(d.getFullYear(), d.getMonth() + Number(b.dataset.m), 1).getTime();
      drawPanel();
      (panel.querySelector(`[data-m="${b.dataset.m}"]`) as HTMLElement | null)?.focus();
      return;
    }
    if (b.dataset.day) {
      readTimes();
      const d = Number(b.dataset.day);
      if (c.stage === 'from') {
        c.fromDay = d;
        c.toDay = d;
        c.stage = 'to';
      } else {
        if (d < c.fromDay) {
          c.toDay = c.fromDay;
          c.fromDay = d;
        } else c.toDay = d;
        c.stage = 'from';
      }
      drawPanel();
      (panel.querySelector(`[data-day="${d}"]`) as HTMLElement | null)?.focus();
      return;
    }
    if (b.hasAttribute('data-cancel')) return setCustom(false);
    if (b.hasAttribute('data-apply')) return apply();
    const v = b.dataset.v;
    if (!v) return;
    close(false);
    m.onPick(v === 'default' ? null : { range: v as ViewWindow['range'] });
  });
  // a time typed and left: shown back in the app's clock
  el.addEventListener('focusout', (e) => {
    const t = e.target as HTMLInputElement;
    if (t?.dataset?.t) {
      const v = parseTime(t.value);
      if (v != null) t.value = timeText(v);
    }
  });
  twMenu = { el, btn, close };
  btn.setAttribute('aria-expanded', 'true');
  // the pill's tooltip (the app kit's, or the title) would cover the menu's top while it is open: put away until it closes
  const pillTip = btn.getAttribute('data-imx-tip') || btn.getAttribute('title') || '';
  btn.removeAttribute('data-imx-tip');
  btn.removeAttribute('title');
  document.getElementById('imx-tip')?.classList.remove('on');
  el.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onOutKey, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('touchstart', onDown, true);
  window.addEventListener('resize', onMove);
  window.addEventListener('scroll', onMove, true);
  place();
  (el.querySelector('button.on') as HTMLElement | null)?.focus() ?? items()[0]?.focus();
  // a custom period in effect: its row shows it (ticked); the calendar opens with a click, so the presets stay one click away
  void DAY;
}
