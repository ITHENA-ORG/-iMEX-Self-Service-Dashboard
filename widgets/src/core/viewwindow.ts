/**
 * core/viewwindow.ts — the viewer's time window on the machine page and the Dashboard Overview (D-061, audit H3).
 *
 * A dashboard stores a time range (schema TIME_RANGES) and a widget may have its own (settings.timeRange). The page's
 * "Time window" control lets the viewer show the whole page for another period without editing the dashboard:
 *   Last hour · Last 4 hours · Last 8 hours · Last 24 hours · Current shift · Previous shift · Custom (from – to)
 * The labels and their order are the app's preset list (imxShell.rangePresets, round 3 M3) plus 8 hours, the Builder's
 * longest stored range. The shift windows come from the same shift calendar the dashboard's shift ranges use
 * (core/shifts.ts calendarFor: imexShifts on the machine, its site, the organisation, System Configuration).
 *
 * While a choice is in effect, EVERY card follows it, also one with its own stored range; with no choice the dashboard
 * defines the window (and a card with its own range says so on the card). Cards that show values (value, gauge, status,
 * progress, KPI, multi-value, table, summary's "Now") show the value at the window's end when the window has ended.
 *
 * The choice is kept per user and per page (machine, or standalone dashboard) in localStorage (`dbb-tw:<user>:<page>`);
 * a value that cannot be read is ignored (the dashboard's own window then applies).
 */
import { rangeWindow, isShiftRange, normalizeRange } from './schema';
import type { RangeWindow, ShiftSource } from './schema';
import * as fmt from './datefmt';

/** The presets of the picker, in order. */
export const VIEW_PRESETS = ['1h', '4h', '8h', '24h', 'shift', 'prevshift'] as const;
export type ViewPreset = (typeof VIEW_PRESETS)[number];
/** A viewer's choice: a preset, or a custom period (`from` / `to` in ms). */
export interface ViewWindow {
  range: ViewPreset | 'custom';
  from?: number;
  to?: number;
}
/** The longest custom period (load time: a week of raw points per property is the most a card reads). */
export const MAX_CUSTOM_MS = 7 * 86400e3;
/** The shortest custom period. */
export const MIN_CUSTOM_MS = 5 * 60e3;
/** How far back a custom period may start. */
export const MAX_BACK_MS = 366 * 86400e3;
/** A window that ended more than this before now counts as ended (its values are those at its end, not live). */
export const ENDED_SLACK_MS = 90e3;

const HOURS: Record<string, number> = { '1h': 1, '4h': 4, '8h': 8, '24h': 24 };

/** The label of a preset or of a stored range: "Last hour", "Last 4 hours", "Current shift", "Previous shift". */
export function presetLabel(r: string): string {
  if (r === 'shift') return 'Current shift';
  if (r === 'prevshift') return 'Previous shift';
  if (r === 'realtime') return 'Live · last hour';
  const h = HOURS[r] ?? parseInt(r, 10);
  return h === 1 ? 'Last hour' : `Last ${h} hours`;
}

/** The label of a choice: the preset's, or the custom period ("15 Oct, 9:00 PM – 16 Oct, 4:57 AM"). */
export function viewLabel(v: ViewWindow): string {
  if (v.range === 'custom') return fmt.range(v.from, v.to, { short: true });
  return presetLabel(v.range);
}

/** A short label for a card's own range chip: "4 h", "Shift", "Prev. shift", "Live". */
export function chipLabel(r: string): string {
  const n = normalizeRange(r);
  if (n === 'shift') return 'Shift';
  if (n === 'prevshift') return 'Prev. shift';
  if (n === 'realtime') return 'Live';
  return n.replace('h', ' h');
}

/** True when `v` is a well-formed choice (a stored value from another build or a hand edit may not be). */
export function isView(v: unknown): v is ViewWindow {
  if (!v || typeof v !== 'object') return false;
  const r = (v as any).range;
  if ((VIEW_PRESETS as readonly string[]).includes(r)) return true;
  if (r !== 'custom') return false;
  const { from, to } = v as any;
  return Number.isFinite(from) && Number.isFinite(to) && to > from;
}

/**
 * Why a custom period cannot be shown, or null when it can. `to` may be later than now (the window then grows until
 * `to`); `from` must be before now.
 */
export function customProblem(from: number, to: number, now = Date.now()): string | null {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 'Enter a start and an end.';
  if (to <= from) return 'The end must be after the start.';
  if (from >= now) return 'The start must be in the past.';
  if (to - from < MIN_CUSTOM_MS) return 'Choose at least 5 minutes.';
  if (to - from > MAX_CUSTOM_MS) return 'Choose at most 7 days.';
  if (now - from > MAX_BACK_MS) return 'Choose a start within the last year.';
  return null;
}

/**
 * The window a choice shows at `now`: hours end now; shifts as rangeWindow (null without a calendar or such a shift);
 * a custom period from `from` to `to` (to now while `to` is still ahead).
 */
export function viewWindow(v: ViewWindow, cal: ShiftSource | null, now = Date.now()): RangeWindow | null {
  if (v.range === 'custom') {
    if (!isView(v)) return null;
    return { startTs: v.from!, endTs: Math.min(v.to!, now) };
  }
  if (isShiftRange(v.range)) return rangeWindow(v.range, cal, now);
  return { startTs: now - (HOURS[v.range] ?? 1) * 3600e3, endTs: now };
}

/** True when a window ended before now (more than ENDED_SLACK_MS ago): its values are the ones at its end. */
export const hasEnded = (w: { endTs: number } | null | undefined, now = Date.now()) => !!w && w.endTs < now - ENDED_SLACK_MS;

/** The localStorage key of a page's choice. `page` = the machine id, or `d:<dashboard id>` for a standalone dashboard. */
export const viewKey = (userId: string, page: string) => `dbb-tw:${userId || 'anon'}:${page}`;

/** The stored choice of a page, or null (none, unreadable, or storage blocked). */
export function loadView(userId: string, page: string): ViewWindow | null {
  try {
    const raw = localStorage.getItem(viewKey(userId, page));
    if (!raw) return null;
    const v = JSON.parse(raw);
    return isView(v) ? (v.range === 'custom' ? { range: 'custom', from: v.from, to: v.to } : { range: v.range }) : null;
  } catch {
    return null;
  }
}

/** Stores (or with null forgets) a page's choice. Never throws. */
export function saveView(userId: string, page: string, v: ViewWindow | null) {
  try {
    if (v) localStorage.setItem(viewKey(userId, page), JSON.stringify(v));
    else localStorage.removeItem(viewKey(userId, page));
  } catch {
    /* storage blocked: the choice lasts for this page view */
  }
}
