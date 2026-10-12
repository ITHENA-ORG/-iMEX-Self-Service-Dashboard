/**
 * The 12-column dashboard grid. Used read-only by the machine dashboard renderer
 * (`entries/renderer.ts`) and editable by the Dashboard Builder (`builder/builder.ts`): drag the
 * top bar to move, drag the bottom-right corner to resize, drop a widget type from the palette.
 * Runs in the browser inside a ThingsBoard widget.
 *
 * Layout model:
 * - Widgets store integer cells: `x` (0..11 column), `y` (row, unbounded downwards), `w`
 *   (1..12 columns) and `h` (rows, 1..20 when resized here). `GRID_COLS` comes from core/schema.
 * - Column width is fluid: (container width − 13 gaps) / 12, recomputed by a ResizeObserver.
 *   Rows are a fixed `ROW_H` px. `GAP` px separates cells and surrounds the grid.
 * - Every widget is an absolutely positioned box (`.dbb-gbox`) inside the host; the host's
 *   min-height is set from the lowest widget (plus 3 empty rows while editing, as drop space).
 *
 * Editing:
 * - During a drag the box follows the pointer snapped to whole cells, clamped to the grid; no
 *   other widget moves yet. On release, `resolveCollisions` pushes overlapped widgets down and
 *   compacts upward, and the new layout goes to `opts.onChange`. The grid does NOT keep the new
 *   positions itself: the owner (the builder) stores them and calls `render()` again.
 * - Palette drops use the HTML5 drag data type `text/dbb-widget` (set by the builder palette)
 *   and report the target cell through `opts.onDrop`; the builder creates the widget.
 *
 * Exports: `Grid` (the component), `resolveCollisions` and `firstFit` (pure layout helpers, also
 * used by the builder for new/duplicated widgets and by `core/chat.ts` to place chat-created widgets),
 * `ROW_H` / `GAP`, and `GRID_CSS` (injected once with `ensureCss('dbb-css-grid', GRID_CSS)` by
 * the builder and the renderer entry). Widget content is drawn by `renderWidget` (render/widgets.ts).
 */
import type { Widget } from '../core/schema';
import { GRID_COLS } from '../core/schema';
import { renderWidget, RenderEnv, WidgetHandle } from './widgets';

/** Row height in px (one grid row). */
export const ROW_H = 64;
/** Gap in px between cells and around the grid edge. */
export const GAP = 10;
/**
 * Read-only grids narrower than this column width (px) are shown on half the columns ("compact"):
 * every widget gets twice the share of the width, so 1-column tiles stay readable on small screens.
 */
export const COMPACT_COL_W = 58;
/**
 * D-054: read-only grids narrower than this (px) use the phone layout (`phoneLayout`): two columns, the host gets
 * the class `dbb-phone`. Never in the editor.
 */
export const PHONE_W = 600;
/** Columns of the phone layout. */
export const PHONE_COLS = 2;
/**
 * D-054: least rows a widget gets on a phone (its stored height is kept when larger). Charts, lists and tables need
 * room for axes and rows; value tiles two rows for title, value and the line under it. Types not listed keep their height.
 */
export const PHONE_MIN_H: Record<string, number> = {
  value: 2, kpi: 3, gauge: 2, progress: 2, multivalue: 2, summary: 2,
  line: 3, area: 3, bar: 3, donut: 3, timeline: 3, heatmap: 3, table: 3, alarms: 3,
};

/** Options for `Grid`. All callbacks are optional; a read-only grid needs none. */
export interface GridOptions {
  /** Adds drag/resize handles, quick-action buttons and palette drop support. Fixed at construction. */
  editable?: boolean;
  /** Widget id drawn with the selection outline. */
  selectedId?: string | null;
  /** Called with a widget id when a box is pressed, or null when the empty grid is pressed. */
  onSelect?(id: string | null): void;
  /** Called after a move/resize with the full new widget list (collisions already resolved). */
  onChange?(widgets: Widget[]): void;
  /** Called when a palette item is dropped: type and target cell. */
  onDrop?(type: string, x: number, y: number): void;
  /** Quick actions on the selected widget (builder). */
  onAction?(id: string, action: 'dup' | 'del'): void;
  /** Widget ids to highlight (e.g. widgets just changed by chat). */
  highlight?: Set<string>;
}

/** A widget's position and size in grid cells. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** True if two cell rectangles share at least one cell (touching edges do not overlap). */
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Removes overlaps after one widget was moved or resized. Pure: returns shallow copies and
 * leaves `items` untouched; order of the returned array matches the input.
 *
 * 1. The moved widget keeps the position the user chose.
 * 2. Every other widget, taken top-to-bottom then left-to-right, is pushed down one row at a
 *    time until it overlaps nothing placed so far.
 * 3. Compaction: every widget except the moved one slides up while the cell above is free,
 *    closing gaps left behind. A widget never jumps over another one.
 * Horizontal positions never change.
 * @param items All widgets of the page with their new positions.
 * @param movedId Id of the widget that was moved; if not found, all widgets are just packed.
 */
export function resolveCollisions<T extends Rect & { id: string }>(items: T[], movedId: string): T[] {
  const out = items.map((i) => ({ ...i }));
  const moved = out.find((i) => i.id === movedId);
  // `order` and `placed` hold the same objects as `out`, so bumping `it.y` updates `out`.
  const order = out.filter((i) => i.id !== movedId).sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: T[] = moved ? [moved] : [];
  for (const it of order) {
    while (placed.some((p) => overlaps(p, it))) it.y += 1;
    placed.push(it);
  }
  // compact upward (keep the moved one where the user put it)
  const sorted = [...out].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const it of sorted) {
    if (it.id === movedId) continue;
    while (it.y > 0) {
      const probe = { ...it, y: it.y - 1 };
      if (out.some((o) => o.id !== it.id && overlaps(o, probe))) break;
      it.y -= 1;
    }
  }
  return out;
}

/**
 * First free slot of size w x h, scanning rows top-down and columns left-to-right. Pure.
 * Used by the builder for widgets added by click (not dropped) and duplicates, and by chat.
 * @returns Top-left cell; if nothing fits in the first 500 rows, the first row below all widgets.
 */
export function firstFit(items: Rect[], w: number, h: number): { x: number; y: number } {
  for (let y = 0; y < 500; y++)
    for (let x = 0; x + w <= GRID_COLS; x++) {
      const r = { x, y, w, h };
      if (!items.some((i) => overlaps(i, r))) return { x, y };
    }
  return { x: 0, y: Math.max(0, ...items.map((i) => i.y + i.h)) };
}

/**
 * The layout shown on a compact (half-column) grid. Widths are halved (rounded up, so nothing gets
 * narrower than one column; heights stay), then the widgets are packed in reading order (top to
 * bottom, left to right): each goes into the first free slot at or below the row of the one before,
 * so the order is kept and no holes are left. Pure; the returned array keeps the input order.
 */
export function compactLayout<T extends Rect & { id: string }>(items: T[]): T[] {
  const cols = GRID_COLS / 2;
  const out = items.map((i) => ({ ...i, w: Math.min(cols, Math.max(1, Math.ceil(i.w / 2))) }));
  const placed: Rect[] = [];
  let row = 0;
  for (const it of [...out].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let spot: { x: number; y: number } | null = null;
    for (let y = row; !spot; y++)
      for (let x = 0; x + it.w <= cols && !spot; x++)
        if (!placed.some((p) => overlaps(p, { x, y, w: it.w, h: it.h }))) spot = { x, y };
    it.x = spot.x;
    it.y = spot.y;
    row = spot.y;
    placed.push(it);
  }
  return out;
}

/**
 * D-054: the layout shown on a phone (read-only grid narrower than PHONE_W), on PHONE_COLS (2) columns. Pure; the
 * returned array keeps the input order.
 * - Width: a widget of 7 or more of the 12 columns takes the full width (2), any other half (1).
 * - Height: the stored height, at least PHONE_MIN_H of its type. A multi-value card with more than 3 values gets 3 rows;
 *   at half width, where each name sits above its value (GRID_CSS), enough rows for every value (about 66 px each: a name on up to two lines and the value).
 * - Packing in reading order (y, then x): a full-width widget gets a row band of its own; two half widgets that follow
 *   each other share a band, side by side, both as tall as the taller one; a half widget without a partner (the next
 *   one is full width, or it is the last) is drawn full width instead of leaving a hole. So there are no overlaps and
 *   no holes, and the order on the phone is the order on the desktop.
 */
export function phoneLayout<T extends Rect & { id: string; type?: string; keys?: unknown[] }>(items: T[]): T[] {
  const minH = (it: T) => Math.max(PHONE_MIN_H[it.type ?? ''] ?? 1, it.type === 'multivalue' && (it.keys?.length ?? 0) > 3 ? 3 : 0);
  const out = items.map((i) => ({ ...i, w: i.w >= 7 ? PHONE_COLS : 1, h: Math.max(1, i.h, minH(i)) }));
  // half-width multi-value cards stack name over value: rows for the values plus the title (row = ROW_H + GAP = 74 px)
  for (const o of out) if (o.type === 'multivalue' && o.w === 1) o.h = Math.max(o.h, Math.ceil(((o.keys?.length ?? 0) * 66 + 56) / (ROW_H + GAP)));
  const order = [...out].sort((a, b) => a.y - b.y || a.x - b.x);
  let row = 0;
  for (let k = 0; k < order.length; k++) {
    const it = order[k];
    const next = order[k + 1];
    if (it.w === 1 && next && next.w === 1) {
      const h = Math.max(it.h, next.h);
      Object.assign(it, { x: 0, y: row, h });
      Object.assign(next, { x: 1, y: row, h });
      row += h;
      k++;
      continue;
    }
    Object.assign(it, { x: 0, y: row, w: PHONE_COLS });
    row += it.h;
  }
  return out;
}

/**
 * Grid component. Owns one absolutely positioned box per widget inside `host` and the
 * `WidgetHandle` returned by `renderWidget` for each (used to refresh and destroy them).
 *
 * Lifecycle: `new Grid(host, env, opts)` → `render(widgets)` whenever the widget list changes →
 * `refreshAll()` on the data refresh timer → `destroy()` when the ThingsBoard widget or the
 * builder closes. The caller keeps the source of truth for the widget list.
 */
export class Grid {
  /** Live widget renderers by widget id. */
  private handles = new Map<string, WidgetHandle>();
  /** Positioned `.dbb-gbox` elements by widget id. */
  private boxes = new Map<string, HTMLElement>();
  /** Copy of the last list passed to `render`. */
  private widgets: Widget[] = [];
  /** Current column width in px. */
  private colW = 0;
  /** Columns shown: GRID_COLS, half of them when a read-only grid is narrow (see COMPACT_COL_W), PHONE_COLS on a phone (D-054). */
  private cols = GRID_COLS;
  /** Positions and sizes as shown (differ from the stored ones only in compact and phone mode), by widget id. */
  private view = new Map<string, Rect>();
  /** D-053: the widgets' bindings when last drawn; a change redraws the text widgets. */
  private bindSig = '';
  private ro: ResizeObserver;

  /**
   * @param host Empty container; its position is set to relative. Its width drives the columns.
   * @param env Render environment passed to every widget (user context, device, time range, theme).
   * @param opts See `GridOptions`; `editable` must be set here to get drag, resize and drop.
   */
  constructor(private host: HTMLElement, private env: RenderEnv, private opts: GridOptions = {}) {
    host.style.position = 'relative';
    this.ro = new ResizeObserver(() => this.layout(true));
    this.ro.observe(host);
    if (opts.editable) this.wireDrop();
    host.addEventListener('mousedown', (e) => {
      if (e.target === host) this.opts.onSelect?.(null);
    });
  }

  /**
   * Replaces the render environment and redraws every widget.
   * D-043: for the same machine and user context (a new time range or theme) every card keeps what it shows and
   * redraws in place with a hairline (WidgetHandle.update); for another machine or context the cards are made again
   * and show their loading placeholders, so no card shows the previous machine's values under the new header.
   */
  setEnv(env: RenderEnv) {
    const prev = this.env;
    this.env = env;
    // D-056: light / dark changed: every card is made again (its own colours depend on it)
    if (prev && (!!prev.dark !== !!env.dark || !!prev.appDark !== !!env.appDark)) this.render(this.widgets, true);
    else if (prev && prev.deviceId === env.deviceId && prev.ctx === env.ctx) {
      for (const h of this.handles.values()) void h.update(this.envOf());
      this.render(this.widgets);
    } else this.render(this.widgets, true);
  }

  /** The environment a widget is drawn with: the grid's, plus the dashboard's widgets (D-053 fleet counts). */
  private envOf(): RenderEnv {
    return { ...this.env, widgets: this.widgets };
  }

  /** Merges options (selection, highlight, callbacks) and repaints selection; does not redraw widgets. */
  setOptions(o: Partial<GridOptions>) {
    Object.assign(this.opts, o);
    this.paintSelection();
  }

  /**
   * Syncs the grid to `widgets`: removes boxes of deleted widgets, creates boxes for new ones,
   * repositions all, and redraws a widget's content only when needed (new widget, config
   * changed, size changed, or `force`). A pure move keeps the existing content, so charts do
   * not flicker or re-fetch data while dragging things around.
   * @param widgets The full widget list (copied; the grid never mutates the caller's objects).
   * @param force Redraw every widget (used after an environment change).
   */
  render(widgets: Widget[], force = false) {
    // Config signature with the position zeroed out, so moves alone don't count as a change.
    const prev = new Map(this.widgets.map((w) => [w.id, JSON.stringify({ ...w, x: 0, y: 0, w: 0, h: 0 })]));
    this.widgets = widgets.map((w) => ({ ...w }));
    const ids = new Set(widgets.map((w) => w.id));
    for (const [id, h] of this.handles)
      if (!ids.has(id)) {
        h.destroy();
        this.handles.delete(id);
        this.boxes.get(id)?.remove();
        this.boxes.delete(id);
      }
    this.layout(false);
    this.computeView();
    // D-053: text widgets count the dashboard's machines ({{machines}}, {{locations}}): redraw them when a binding changes
    const bindSig = JSON.stringify(this.widgets.map((w) => w.binding));
    const fleetChanged = bindSig !== this.bindSig;
    this.bindSig = bindSig;
    const env = this.envOf();
    for (const w of this.widgets) {
      let box = this.boxes.get(w.id);
      const sig = JSON.stringify({ ...w, x: 0, y: 0, w: 0, h: 0 });
      // Size is tracked separately (on the box's data attributes) because charts must redraw at the new size.
      const sizeChanged = box && (box.dataset.w !== String(this.rect(w).w) || box.dataset.h !== String(this.rect(w).h));
      if (!box) {
        box = this.makeBox(w);
        this.boxes.set(w.id, box);
        this.host.appendChild(box);
      }
      this.place(box, w);
      if (force || !this.handles.has(w.id) || prev.get(w.id) !== sig || sizeChanged || (fleetChanged && w.type === 'text')) {
        this.handles.get(w.id)?.destroy();
        const inner = box.querySelector('.dbb-gi') as HTMLElement;
        this.handles.set(w.id, renderWidget(inner, w, env));
      }
      box.dataset.w = String(this.rect(w).w);
      box.dataset.h = String(this.rect(w).h);
    }
    this.setHeight();
    this.paintSelection();
  }

  /** Host min-height from the lowest widget as shown: at least 4 rows; in edit mode 3 extra empty rows give room to drop below the last widget. */
  private setHeight() {
    const rows = Math.max(4, ...this.widgets.map((w) => this.rect(w).y + this.rect(w).h)) + (this.opts.editable ? 3 : 0);
    this.host.style.minHeight = `${rows * (ROW_H + GAP)}px`;
  }

  /** Fills `view` with the positions to show (the compact layout on a narrow read-only grid, the phone layout on a phone). */
  private computeView() {
    const phone = this.cols === PHONE_COLS;
    const shown = phone ? phoneLayout(this.widgets) : this.cols < GRID_COLS ? compactLayout(this.widgets) : this.widgets;
    this.view = new Map(shown.map((w) => [w.id, { x: w.x, y: w.y, w: w.w, h: w.h }]));
    // D-054: tile styles for the phone (Summary as 2×2, values that shrink to their box, titles on two lines): GRID_CSS
    this.host.classList.toggle('dbb-phone', phone);
  }

  /** A widget's position as shown. */
  private rect(w: Widget): Rect {
    return this.view.get(w.id) || w;
  }

  /** Asks every widget to re-fetch and redraw (fire-and-forget; each widget shows its own errors). Called by the renderer's refresh timer. */
  refreshAll() {
    for (const h of this.handles.values()) void h.refresh();
  }

  /** Stops observing size, destroys all widget renderers and empties the host. */
  destroy() {
    this.ro.disconnect();
    for (const h of this.handles.values()) h.destroy();
    this.host.innerHTML = '';
  }

  /**
   * Recomputes the column width from the host width. With `reflow` (ResizeObserver path) and a
   * real width change, repositions every box and refreshes widgets so charts redraw at the new size.
   * Read-only only: narrower than PHONE_W the phone layout (D-054), else a column narrower than COMPACT_COL_W
   * the compact one (D-040). The editor always shows the 12 columns.
   */
  private layout(reflow: boolean) {
    const W = this.host.clientWidth;
    const full = (W - GAP * (GRID_COLS + 1)) / GRID_COLS;
    const ro = !this.opts.editable && W > 0;
    const cols = ro && W < PHONE_W ? PHONE_COLS : ro && full < COMPACT_COL_W ? GRID_COLS / 2 : GRID_COLS;
    const colW = (W - GAP * (cols + 1)) / cols;
    const modeChanged = cols !== this.cols;
    // Ignore sub-pixel jitter (e.g. a scrollbar flickering) to avoid redraw loops.
    const changed = Math.abs(colW - this.colW) > 1 || modeChanged;
    this.colW = colW;
    this.cols = cols;
    if (reflow && changed) {
      if (modeChanged) this.computeView();
      for (const w of this.widgets) {
        const b = this.boxes.get(w.id);
        if (!b) continue;
        this.place(b, w);
        b.dataset.w = String(this.rect(w).w);
        b.dataset.h = String(this.rect(w).h);
      }
      if (modeChanged) this.setHeight();
      for (const h of this.handles.values()) void h.refresh();
    }
  }

  /** Converts cell coordinates to pixel left/top/width/height inside the host. */
  private px(w: { x: number; y: number; w: number; h: number }) {
    return {
      left: GAP + w.x * (this.colW + GAP),
      top: GAP + w.y * (ROW_H + GAP),
      width: w.w * this.colW + (w.w - 1) * GAP,
      height: w.h * ROW_H + (w.h - 1) * GAP,
    };
  }

  private place(box: HTMLElement, w: Widget) {
    const p = this.px(this.rect(w));
    Object.assign(box.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` });
  }

  /**
   * Creates the positioned box for a widget: `.dbb-gi` is where the widget draws itself. In edit
   * mode it also adds the move bar (`.dbb-gdrag`, top strip), the resize corner (`.dbb-gresize`)
   * and the duplicate/delete buttons (`.dbb-gtools`, visible when selected).
   */
  private makeBox(w: Widget): HTMLElement {
    const box = document.createElement('div');
    box.className = 'dbb-gbox';
    box.dataset.id = w.id;
    box.style.position = 'absolute';
    box.innerHTML = `<div class="dbb-gi" style="height:100%"></div>`;
    if (this.opts.editable) {
      const bar = document.createElement('div');
      bar.className = 'dbb-gdrag';
      bar.title = 'Drag to move';
      const rz = document.createElement('div');
      rz.className = 'dbb-gresize';
      rz.title = 'Drag to resize';
      box.appendChild(bar);
      box.appendChild(rz);
      const tools = document.createElement('div');
      tools.className = 'dbb-gtools';
      tools.innerHTML = `<button data-q="dup" title="Duplicate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button><button data-q="del" title="Remove (Delete)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>`;
      tools.querySelectorAll<HTMLElement>('[data-q]').forEach((b) =>
        b.addEventListener('mousedown', (e) => {
          // Stop the box's own mousedown (select) and focus change; the action handles selection.
          e.stopPropagation();
          e.preventDefault();
          this.opts.onAction?.(box.dataset.id!, b.dataset.q as 'dup' | 'del');
        }),
      );
      box.appendChild(tools);
      box.addEventListener('mousedown', () => this.opts.onSelect?.(box.dataset.id!));
      this.wireDrag(box, bar, 'move');
      this.wireDrag(box, rz, 'resize');
    }
    return box;
  }

  /** Applies the `sel` / `hl` classes from `opts.selectedId` and `opts.highlight`. */
  private paintSelection() {
    for (const [id, b] of this.boxes) {
      b.classList.toggle('sel', id === this.opts.selectedId);
      b.classList.toggle('hl', !!this.opts.highlight?.has(id));
    }
  }

  /**
   * Pointer-based move or resize of one box. The pointer delta is rounded to whole cells.
   * Move clamps x so the widget stays inside the 12 columns (y ≥ 0); resize keeps the top-left
   * corner and clamps w to the columns left and h to 1..20 rows. Only the box is moved while
   * dragging; on release, if anything changed, collisions are resolved and `onChange` is called.
   * Pointer capture keeps events coming even when the pointer leaves the handle.
   */
  private wireDrag(box: HTMLElement, handle: HTMLElement, kind: 'move' | 'resize') {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = box.dataset.id!;
      this.opts.onSelect?.(id);
      const w0 = this.widgets.find((w) => w.id === id)!;
      const start = { x: e.clientX, y: e.clientY };
      const cellW = this.colW + GAP;
      const cellH = ROW_H + GAP;
      let cur = { ...w0 };
      handle.setPointerCapture(e.pointerId);
      box.classList.add('dragging');
      const move = (ev: PointerEvent) => {
        const dx = Math.round((ev.clientX - start.x) / cellW);
        const dy = Math.round((ev.clientY - start.y) / cellH);
        if (kind === 'move') {
          cur = { ...w0, x: Math.min(GRID_COLS - w0.w, Math.max(0, w0.x + dx)), y: Math.max(0, w0.y + dy) };
        } else {
          cur = { ...w0, w: Math.min(GRID_COLS - w0.x, Math.max(1, w0.w + dx)), h: Math.min(20, Math.max(1, w0.h + dy)) };
        }
        this.place(box, cur);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        box.classList.remove('dragging');
        // A click without movement is just a selection; no layout change.
        if (cur.x === w0.x && cur.y === w0.y && cur.w === w0.w && cur.h === w0.h) return;
        const next = resolveCollisions(
          this.widgets.map((w) => (w.id === id ? cur : w)),
          id,
        );
        this.opts.onChange?.(next);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  /**
   * HTML5 drop target for palette tiles. Shows a dashed ghost at the hovered cell and, on drop,
   * calls `onDrop(type, x, y)`. Drags that do not carry `text/dbb-widget` (files, text) are ignored.
   */
  private wireDrop() {
    const ghost = document.createElement('div');
    ghost.className = 'dbb-ghost';
    ghost.style.display = 'none';
    this.host.appendChild(ghost);
    const cell = (e: DragEvent) => {
      const r = this.host.getBoundingClientRect();
      const x = Math.max(0, Math.min(GRID_COLS - 1, Math.floor((e.clientX - r.left - GAP) / (this.colW + GAP))));
      const y = Math.max(0, Math.floor((e.clientY - r.top - GAP) / (ROW_H + GAP)));
      return { x, y };
    };
    this.host.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('text/dbb-widget')) return;
      e.preventDefault();
      const c = cell(e);
      // The ghost is a nominal 3x2 preview; the real size is chosen by the builder per widget type.
      const p = this.px({ x: c.x, y: c.y, w: 3, h: 2 });
      Object.assign(ghost.style, { display: 'block', left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` });
    });
    this.host.addEventListener('dragleave', () => (ghost.style.display = 'none'));
    this.host.addEventListener('drop', (e) => {
      ghost.style.display = 'none';
      const t = e.dataTransfer?.getData('text/dbb-widget');
      if (!t) return;
      e.preventDefault();
      const c = cell(e);
      this.opts.onDrop?.(t, c.x, c.y);
    });
  }
}

/** Grid-only styles (boxes, drag/resize handles, quick tools, drop ghost). Inject with ensureCss. */
export const GRID_CSS = `
.dbb-gbox{transition:left .15s,top .15s,width .15s,height .15s}
.dbb-gbox.dragging{transition:none;z-index:10;opacity:.92}
.dbb-gbox.dragging .dbb-card{box-shadow:0 12px 32px rgba(16,24,40,.22)}
.dbb-gbox.sel .dbb-card{outline:2px solid var(--accent);outline-offset:2px}
.dbb-gbox.hl .dbb-card{box-shadow:0 0 0 3px #86b6ef}
.dbb-gdrag{position:absolute;left:0;right:28px;top:0;height:30px;cursor:move;z-index:2}
.dbb-gresize{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;z-index:2;opacity:0;transition:opacity .15s;background:linear-gradient(135deg,transparent 50%,var(--ink-3) 50%,var(--ink-3) 60%,transparent 60%,transparent 70%,var(--ink-3) 70%,var(--ink-3) 80%,transparent 80%);border-bottom-right-radius:8px}
.dbb-gbox:hover .dbb-gresize,.dbb-gbox.sel .dbb-gresize{opacity:1}
.dbb-gtools{position:absolute;top:6px;right:6px;display:none;gap:4px;z-index:3}
.dbb-gbox.sel .dbb-gtools{display:flex}
.dbb-gtools button{width:24px;height:24px;border-radius:6px;border:1px solid var(--line);background:var(--surface);color:var(--ink-2);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.dbb-gtools button:hover{color:var(--accent);border-color:var(--accent)}
.dbb-gtools svg{width:14px;height:14px}
.dbb-ghost{position:absolute;border:2px dashed var(--accent);border-radius:var(--radius);background:color-mix(in srgb,var(--accent) 7%,transparent);pointer-events:none}
.dbb-phone .dbb-gi{container-type:inline-size}
.dbb-phone .dbb-card-t{white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-height:1.25;overflow-wrap:anywhere}
.dbb-phone .dbb-value{max-width:100%}
.dbb-phone .dbb-value .v{font-size:min(var(--card-value-size,30px),15cqi);max-width:100%}
.dbb-phone .dbb-value .v,.dbb-phone .dbb-value .u{display:inline-block}
.dbb-phone .dbb-value .s{max-width:100%}
.dbb-phone .dbb-sum{grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;align-content:center}
.dbb-phone .dbb-sum .v{font-size:min(18px,8.5cqi);max-width:100%}
.dbb-phone .dbb-sum .v .dbb-muted{font-size:.78em}
.dbb-phone .dbb-mv-row .v{flex:none}
@container (max-width:220px){.dbb-phone .dbb-mv-row{flex-wrap:wrap;row-gap:1px}.dbb-phone .dbb-mv-row .k{flex:1 1 calc(100% - 30px);min-width:0;white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-height:1.25}.dbb-phone .dbb-mv-row .v{margin-left:16px}}
`;
