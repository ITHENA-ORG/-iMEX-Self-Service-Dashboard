/**
 * Small built-in icon set (24x24 viewBox, stroke = currentColor) for widget titles, buttons,
 * the builder palette and the stand-in app pages. Runs in the browser; returns SVG markup
 * strings only (no DOM access).
 *
 * Exports:
 * - `ICON_SVG`: icons a user can pick for a widget title (Style tab, DECISIONS D-019). Its keys
 *   must match the `ICONS` enum in `core/schema.ts`, which validates `style.icon` on save and
 *   in chat output. Used by `render/widgets.ts`, `builder/editors.ts` and `entries/listing.ts`.
 * - `WIDGET_ICON`: one icon per widget type (keys = `Widget['type']`), for the builder palette.
 * - `UI_ICON`: icons for page buttons that are not title icons (the machine page bar's Create ticket).
 * - `icon(name)`: safe lookup by name.
 *
 * Because they use currentColor, icons take the text colour of their container; size them with
 * CSS on the parent (`svg { width; height }`). The markup is trusted constant data: never build
 * icon markup from user input.
 */

/** Wraps SVG path data in the shared 24x24 stroke-icon `<svg>` element. */
const S = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

/** User-selectable title icons by name. Adding one here also needs the name in `ICONS` (core/schema.ts). */
export const ICON_SVG: Record<string, string> = {
  gauge: S('<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4-5"/><circle cx="12" cy="15" r="1.2"/>'),
  bolt: S('<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>'),
  thermometer: S('<path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0z"/><path d="M12 10v6"/>'),
  droplet: S('<path d="M12 3s6 7 6 11a6 6 0 1 1-12 0c0-4 6-11 6-11z"/>'),
  fan: S('<circle cx="12" cy="12" r="1.6"/><path d="M12 10.4C11 6 13 3 15.5 4.5S14.5 10 12 10.4zM13.6 12c4.4-1 7.4 1 5.9 3.5S14 14.5 13.6 12zM12 13.6c1 4.4-1 7.4-3.5 5.9S10 14 12 13.6zM10.4 12C6 13 3 11 4.5 8.5S10 9.5 10.4 12z"/>'),
  wind: S('<path d="M3 9h11a3 3 0 1 0-3-3"/><path d="M3 15h15a3 3 0 1 1-3 3"/>'),
  clock: S('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  alert: S('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.2v.1"/>'),
  check: S('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 10"/>'),
  power: S('<path d="M12 3v8"/><path d="M6.3 7a8 8 0 1 0 11.4 0"/>'),
  factory: S('<path d="M3 21V11l5 3v-3l5 3V7h3l1-4h2l1 4v14z"/><path d="M7 17h2M12 17h2"/>'),
  wrench: S('<path d="M14.7 6.3a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.7-7.7a4 4 0 0 0-2-2z"/>'),
  chart: S('<path d="M4 20V4M4 20h16"/><path d="M7 15l4-4 3 3 5-6"/>'),
  speed: S('<path d="M3.5 17a9 9 0 1 1 17 0"/><path d="M12 13l5-4"/><path d="M6 17h12"/>'),
  battery: S('<rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 11v2M6 10v4M9 10v4"/>'),
  flame: S('<path d="M12 21a6 6 0 0 0 6-6c0-4-3-6-4-10-2 2-3 4-3 6-1-1-1.5-2-1.5-3C7 10 6 12.5 6 15a6 6 0 0 0 6 6z"/>'),
  snow: S('<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.5 4.5L12 6l2.5-1.5M9.5 19.5L12 18l2.5 1.5"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.1"/>'),
  star: S('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>'),
  pin: S('<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  link: S('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  cpu: S('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>'),
  home: S('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'),
  list: S('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
};

/**
 * Icons for page buttons only (not selectable as widget title icons, so not in `ICON_SVG` / the schema's `ICONS`).
 * `ticket`: Create ticket (a document with a plus), the same glyph as the Create ticket button on the app's Active
 * alarms rows. `edit`, `chev`, `tick`: the bar's "Edit dashboard" button and its menu (D-058).
 */
export const UI_ICON: Record<string, string> = {
  ticket: S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 12v6M9 15h6"/>'),
  edit: S('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  chev: S('<path d="M9 6l6 6-6 6"/>'),
  tick: S('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  /** D-061: a write the role may not use (Create ticket for a view-only role). */
  lock: S('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
};

/** Tooltips of the title icons in the Style tab where the internal name is not the app's word (D-058: "alarm"). */
export const ICON_TITLE: Record<string, string> = { alert: 'alarm' };

/** Palette icon per widget type (keys are the widget type ids from core/schema.ts). */
export const WIDGET_ICON: Record<string, string> = {
  value: S('<rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M7 14h4M7 10h8"/>'),
  kpi: S('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M6 15l3-3 3 2 5-5"/><path d="M6 8h4"/>'),
  gauge: ICON_SVG.gauge,
  progress: S('<rect x="3" y="9" width="18" height="6" rx="3"/><path d="M6 12h7" stroke-width="3"/>'),
  status: S('<circle cx="8" cy="12" r="3.5" fill="currentColor"/><path d="M14 12h6"/>'),
  multivalue: S('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9h4M7 13h4M7 17h4M15 9h2M15 13h2M15 17h2"/>'),
  summary: S('<path d="M5 18V9M12 18V5M19 18v-6"/><path d="M3 18h18"/>'),
  line: S('<path d="M3 17l5-6 4 3 5-7 4 4"/>'),
  area: S('<path d="M3 18l5-7 4 3 5-7 4 4v7z" fill="currentColor" fill-opacity=".18"/><path d="M3 18l5-7 4 3 5-7 4 4"/>'),
  bar: S('<path d="M5 19V11M10 19V6M15 19v-5M20 19V9" stroke-width="2.6"/>'),
  donut: S('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 8 8h-4a4 4 0 0 0-4-4z" fill="currentColor"/><circle cx="12" cy="12" r="4"/>'),
  timeline: S('<rect x="3" y="9" width="6" height="6" rx="1" fill="currentColor"/><rect x="10" y="9" width="4" height="6" rx="1"/><rect x="15" y="9" width="6" height="6" rx="1" fill="currentColor" fill-opacity=".45"/>'),
  heatmap: S('<rect x="3" y="4" width="5" height="5" rx="1" fill="currentColor"/><rect x="9.5" y="4" width="5" height="5" rx="1" fill="currentColor" fill-opacity=".4"/><rect x="16" y="4" width="5" height="5" rx="1"/><rect x="3" y="10.5" width="5" height="5" rx="1" fill="currentColor" fill-opacity=".6"/><rect x="9.5" y="10.5" width="5" height="5" rx="1"/><rect x="16" y="10.5" width="5" height="5" rx="1" fill="currentColor"/><rect x="3" y="17" width="5" height="3" rx="1"/><rect x="9.5" y="17" width="5" height="3" rx="1" fill="currentColor" fill-opacity=".6"/><rect x="16" y="17" width="5" height="3" rx="1" fill="currentColor" fill-opacity=".3"/>'),
  table: S('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M9 10v9"/>'),
  alarms: S('<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20h4"/>'),
  text: S('<path d="M5 6h14M12 6v13M9 19h6"/>'),
  image: S('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>'),
  link: S('<rect x="3" y="7" width="18" height="10" rx="5"/><path d="M9 12h6M13 10l2 2-2 2"/>'),
  embed: S('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18"/><path d="M10 12l-2 2 2 2M14 12l2 2-2 2"/>'),
};

/**
 * SVG markup for a title icon.
 * @param name Key of `ICON_SVG`, e.g. from `settings.style.icon`.
 * @returns The SVG string, or '' when the name is empty or unknown (so callers can concatenate).
 */
export function icon(name?: string | null): string {
  return (name && ICON_SVG[name]) || '';
}
