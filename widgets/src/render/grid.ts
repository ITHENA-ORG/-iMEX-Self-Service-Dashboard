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
 * - D-069: during a drag the card follows the pointer (clamped to the grid), the cells it lands on
 *   are outlined, a resize shows "w × h", and the other cards move to where `resolveCollisions`
 *   will put them (push down, compact upward); Esc cancels. On release the new layout goes to
 *   `opts.onChange`. The grid does NOT keep the new positions itself: the owner (the builder)
 *   stores them and calls `render()` again.
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
  /** D-061: a tile's value fit changed ('' = fits, 'tight' = only much smaller, 'cut'). */
  onFit?(id: string, state: string): void;
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

/** D-069: most rows a widget gets when resized with the pointer. */
export const MAX_DRAG_H = 20;

/** D-069: one frame of a pointer move or resize: where the card is drawn (px, follows the pointer) and the cells it lands on. */
export interface DragFrame {
  /** The cells the card lands on when released here (snapped, clamped to the grid). */
  snap: Rect;
  /** Left / top / width / height in px inside the grid host, following the pointer (not snapped). */
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * D-069: the card's place while the pointer is held. Pure.
 * - Move: the card follows the pointer, kept inside the 12 columns and below the top edge; it lands on the nearest
 *   cells (the pointer travel rounded to whole cells, as before D-069).
 * - Resize: the top-left corner stays, the size follows the pointer, at least one cell, at most to the right edge and
 *   MAX_DRAG_H rows; the size it lands on is the travel rounded to whole cells.
 * @param r The widget's cells when the drag started.
 * @param dx Pointer travel in px since the drag started (scrolling of the canvas included).
 * @param dy See dx.
 * @param colW Column width in px (rows are ROW_H, gaps GAP).
 */
export function dragFrame(kind: 'move' | 'resize', r: Rect, dx: number, dy: number, colW: number): DragFrame {
  const cellW = colW + GAP;
  const cellH = ROW_H + GAP;
  const left0 = GAP + r.x * cellW;
  const top0 = GAP + r.y * cellH;
  const width0 = r.w * colW + (r.w - 1) * GAP;
  const height0 = r.h * ROW_H + (r.h - 1) * GAP;
  const cdx = Math.round(dx / cellW);
  const cdy = Math.round(dy / cellH);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  if (kind === 'move') {
    const snap = { x: clamp(r.x + cdx, 0, GRID_COLS - r.w), y: Math.max(0, r.y + cdy), w: r.w, h: r.h };
    const maxLeft = GAP + (GRID_COLS - r.w) * cellW;
    return { snap, left: clamp(left0 + dx, GAP, maxLeft), top: Math.max(GAP, top0 + dy), width: width0, height: height0 };
  }
  const snap = { x: r.x, y: r.y, w: clamp(r.w + cdx, 1, GRID_COLS - r.x), h: clamp(r.h + cdy, 1, MAX_DRAG_H) };
  const maxW = (GRID_COLS - r.x) * colW + (GRID_COLS - r.x - 1) * GAP;
  const maxH = MAX_DRAG_H * ROW_H + (MAX_DRAG_H - 1) * GAP;
  return { snap, left: left0, top: top0, width: clamp(width0 + dx, colW, maxW), height: clamp(height0 + dy, ROW_H, maxH) };
}

/** D-069: the size readout shown while resizing ("4 × 2") and its spoken form. */
export function sizeLabel(r: { w: number; h: number }): { text: string; aria: string } {
  return {
    text: `${r.w} × ${r.h}`,
    aria: `${r.w} ${r.w === 1 ? 'column' : 'columns'} wide, ${r.h} ${r.h === 1 ? 'row' : 'rows'} high`,
  };
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

/** True if two cell rectangles are the same cells. */
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** D-069: the nearest ancestor that scrolls vertically (the Builder's canvas pane), or null. Read once per drag. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p).overflowY;
    if (s === 'auto' || s === 'scroll') return p;
  }
  return null;
}

/** D-069: a pointer move or resize in progress (Grid.drag). */
interface DragState {
  id: string;
  kind: 'move' | 'resize';
  box: HTMLElement;
  handle: HTMLElement;
  pointerId: number;
  /** The widget's cells when the drag started. */
  w0: Rect;
  /** Pointer at the start and now (client px). */
  x0: number;
  y0: number;
  x: number;
  y: number;
  /** The pointer moved more than a few px (edge scrolling starts only then). */
  travelled: boolean;
  scroller: HTMLElement | null;
  /** The scroll container's top and bottom (client px) at the start. */
  edge: { top: number; bottom: number } | null;
  scroll0: number;
  /** The cells it lands on, as last drawn. */
  snap: Rect;
  /** Pending requestAnimationFrame id (0 = none). */
  raf: number;
  /** Draw the drop outline and the pushed cards again on the next frame. */
  dirty: boolean;
  /** The "w × h" readout (resize only). */
  size: HTMLElement | null;
  /** Removes the drag's listeners. */
  off(): void;
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
  /** D-069: the pointer move / resize in progress, or null. */
  private drag: DragState | null = null;
  /** D-069: the outline of the cells a dragged card lands on (made on the first drag). */
  private dropGhost: HTMLElement | null = null;

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
    // D-069: a redraw while a card is held (live data, a fit warning) put every box back on its stored cells
    if (this.drag) {
      if (this.boxes.get(this.drag.id) !== this.drag.box) this.endDrag(false);
      else this.redrawDrag();
    }
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
    if (this.drag) this.endDrag(false);
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
      if (this.drag) this.redrawDrag();
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
      // D-061 (audit M10): a tile whose value only fits much smaller, or is cut, gets a warning badge (renderWidget's
      // fit check sends dbb-fit); the Builder's settings panel says the same for the selected widget
      const warn = document.createElement('span');
      warn.className = 'dbb-gwarn';
      warn.setAttribute('role', 'img');
      warn.innerHTML = FIT_ICON;
      box.appendChild(warn);
      box.addEventListener('dbb-fit', (e) => {
        const state = (e as CustomEvent).detail?.state ?? '';
        box.classList.toggle('fitwarn', !!state);
        box.dataset.fit = state;
        const tip = state ? fitWarning(state) : '';
        warn.title = tip;
        warn.setAttribute('aria-label', tip);
        this.opts.onFit?.(box.dataset.id!, state);
      });
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
   * D-069: pointer move or resize of one box (mouse, pen or touch), with live feedback while the pointer is held:
   * - the card follows the pointer, lifted with a shadow (move: a translate3d on the box; resize: its width and height);
   * - the cells it lands on are tinted and outlined (`.dbb-gdrop`, one tile per cell), and the cards it would push move
   *   to where they will end up (the same resolveCollisions as on release: what is shown is what you get);
   * - resizing shows the size it lands on, "4 × 2" (columns × rows), next to the corner handle (`.dbb-gsize`);
   * - pointer events only record the position; one requestAnimationFrame writes the styles (no layout reads during the
   *   drag apart from the scroll position at the start of a frame, before any write);
   * - near the top or bottom edge of the scrolling canvas it scrolls, and the scroll counts as pointer travel;
   * - Esc (also the browser cancelling the pointer, or the handle losing it) puts everything back; nothing changes.
   * On release, if the cells changed, collisions are resolved and `onChange` is called, as before D-069. Pointer capture
   * keeps events coming when the pointer leaves the handle. Before D-069 the box was placed through `place()`, which
   * draws the stored cells (the view map, D-040), so nothing moved until release.
   */
  private wireDrag(box: HTMLElement, handle: HTMLElement, kind: 'move' | 'resize') {
    handle.addEventListener('pointerdown', (e) => {
      if (this.drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();
      const id = box.dataset.id!;
      this.opts.onSelect?.(id);
      const w0 = this.widgets.find((w) => w.id === id);
      if (!w0) return;
      const scroller = scrollParent(this.host);
      const sr = scroller?.getBoundingClientRect();
      const start = { x: w0.x, y: w0.y, w: w0.w, h: w0.h };
      const d: DragState = {
        id,
        kind,
        box,
        handle,
        pointerId: e.pointerId,
        w0: start,
        x0: e.clientX,
        y0: e.clientY,
        x: e.clientX,
        y: e.clientY,
        travelled: false,
        scroller,
        edge: sr ? { top: sr.top, bottom: sr.bottom } : null,
        scroll0: scroller?.scrollTop ?? 0,
        snap: start,
        raf: 0,
        dirty: true,
        size: null,
        off: () => {},
      };
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* a synthetic event without an active pointer: the listeners below still get it */
      }
      box.classList.add('dragging', kind === 'move' ? 'moving' : 'sizing');
      this.host.classList.add('dbb-gdragging');
      if (kind === 'resize') {
        const s = document.createElement('span');
        s.className = 'dbb-gsize';
        s.setAttribute('role', 'status');
        box.appendChild(s);
        d.size = s;
      }
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== d.pointerId) return;
        d.x = ev.clientX;
        d.y = ev.clientY;
        this.queueDrag();
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== d.pointerId) return;
        d.x = ev.clientX;
        d.y = ev.clientY;
        this.endDrag(true);
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId === d.pointerId) this.endDrag(false);
      };
      const onKey = (ev: KeyboardEvent) => {
        // Capture phase on window: runs before the builder's keys (Esc closes the builder, Delete removes, Ctrl+Z undoes).
        if (ev.key === 'Escape') this.endDrag(false);
        else if (!(ev.key === 'Delete' || ev.key === 'Backspace' || ((ev.ctrlKey || ev.metaKey) && /^[zy]$/i.test(ev.key)))) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
      };
      const blockMenu = (ev: Event) => ev.preventDefault();
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onCancel);
      handle.addEventListener('lostpointercapture', onCancel);
      handle.addEventListener('contextmenu', blockMenu);
      window.addEventListener('keydown', onKey, true);
      d.off = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onCancel);
        handle.removeEventListener('lostpointercapture', onCancel);
        handle.removeEventListener('contextmenu', blockMenu);
        window.removeEventListener('keydown', onKey, true);
      };
      this.drag = d;
      this.queueDrag();
    });
  }

  /** D-069: asks for one drag frame (at most one per animation frame). */
  private queueDrag() {
    const d = this.drag;
    if (d && !d.raf) d.raf = requestAnimationFrame(() => this.dragTick());
  }

  /** D-069: a redraw (render, reflow) put the boxes back on their stored cells: draw the drag again on the next frame. */
  private redrawDrag() {
    if (!this.drag) return;
    this.drag.dirty = true;
    this.queueDrag();
  }

  /** D-069: the frame for the pointer's last position; `scrollY` is the scroll container's position now. */
  private frameOf(d: DragState, scrollY: number): DragFrame {
    return dragFrame(d.kind, d.w0, d.x - d.x0, d.y - d.y0 + (scrollY - d.scroll0), this.colW);
  }

  /** D-069: one animation frame of a drag: edge scroll, the card at the pointer, and (when the cells change) the drop outline and the pushed cards. */
  private dragTick() {
    const d = this.drag;
    if (!d) return;
    d.raf = 0;
    // the only layout read of the frame, before any write
    const scrollY = d.scroller ? d.scroller.scrollTop : 0;
    if (!d.travelled && Math.abs(d.x - d.x0) + Math.abs(d.y - d.y0) > 4) d.travelled = true;
    let auto = 0;
    if (d.scroller && d.edge && d.travelled) {
      const zone = 48;
      if (d.y > d.edge.bottom - zone) auto = Math.min(18, Math.ceil((d.y - (d.edge.bottom - zone)) / 3));
      else if (d.y < d.edge.top + zone && scrollY > 0) auto = -Math.min(18, Math.ceil((d.edge.top + zone - d.y) / 3));
    }
    const f = this.frameOf(d, scrollY);
    const o = this.px(d.w0);
    if (d.kind === 'move') d.box.style.transform = `translate3d(${f.left - o.left}px,${f.top - o.top}px,0)`;
    else {
      d.box.style.width = `${f.width}px`;
      d.box.style.height = `${f.height}px`;
    }
    if (d.dirty || !sameRect(f.snap, d.snap)) {
      d.snap = f.snap;
      d.dirty = false;
      this.paintDrop(d);
    }
    if (auto && d.scroller) {
      d.scroller.scrollTop = scrollY + auto;
      this.queueDrag();
    }
  }

  /** D-069: the drop outline on the cells `d.snap`, the size readout, and every other card where it will end up. Writes only. */
  private paintDrop(d: DragState) {
    let g = this.dropGhost;
    if (!g || g.parentElement !== this.host) {
      g = document.createElement('div');
      g.className = 'dbb-gdrop';
      g.setAttribute('aria-hidden', 'true');
      this.host.appendChild(g);
      this.dropGhost = g;
    }
    const p = this.px(d.snap);
    Object.assign(g.style, {
      display: 'grid',
      left: `${p.left}px`,
      top: `${p.top}px`,
      width: `${p.width}px`,
      height: `${p.height}px`,
      gridTemplateColumns: `repeat(${d.snap.w},minmax(0,1fr))`,
      gridTemplateRows: `repeat(${d.snap.h},minmax(0,1fr))`,
      gap: `${GAP}px`,
    });
    const n = d.snap.w * d.snap.h;
    if (g.childElementCount !== n) g.innerHTML = '<i></i>'.repeat(n);
    if (d.size) {
      const l = sizeLabel(d.snap);
      d.size.textContent = l.text;
      d.size.setAttribute('aria-label', l.aria);
    }
    const next = resolveCollisions(this.widgets.map((w) => (w.id === d.id ? { ...w, ...d.snap } : w)), d.id);
    let bottom = 0;
    for (const w of next) {
      bottom = Math.max(bottom, w.y + w.h);
      const b = w.id === d.id ? null : this.boxes.get(w.id);
      if (b) this.setBox(b, w);
    }
    // room below the lowest card, so a card can be dragged further down
    this.host.style.minHeight = `${(Math.max(4, bottom) + 3) * (ROW_H + GAP)}px`;
  }

  /**
   * D-069: ends the drag. `commit` (pointer released): if the cells changed, the new layout goes to onChange; else (and
   * on cancel) every card goes back. The held card glides from where it is drawn to its cells: in one style change its
   * left / top jump to the cells and its transform drops to none, and with .dragging gone both transition together, so
   * left + transform runs straight from the pointer's place to the cells (no layout read).
   */
  private endDrag(commit: boolean) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    d.off();
    try {
      if (d.handle.hasPointerCapture?.(d.pointerId)) d.handle.releasePointerCapture(d.pointerId);
    } catch {
      /* already released */
    }
    const snap = commit ? this.frameOf(d, d.scroller ? d.scroller.scrollTop : 0).snap : d.w0;
    const changed = commit && !sameRect(snap, d.w0);
    d.box.classList.remove('dragging', 'moving', 'sizing');
    this.setBox(d.box, snap);
    d.box.style.transform = '';
    d.size?.remove();
    if (this.dropGhost) this.dropGhost.style.display = 'none';
    this.host.classList.remove('dbb-gdragging');
    if (changed) {
      this.opts.onChange?.(resolveCollisions(this.widgets.map((w) => (w.id === d.id ? { ...w, ...snap } : w)), d.id));
      return;
    }
    // a press without movement is just a selection; a cancel puts the other cards back
    for (const w of this.widgets) {
      const b = this.boxes.get(w.id);
      if (b && w.id !== d.id) this.place(b, w);
    }
    this.setHeight();
  }

  /** D-069: writes a box's px position and size for the given cells (the editor shows the stored 12 columns). */
  private setBox(box: HTMLElement, r: Rect) {
    const p = this.px(r);
    Object.assign(box.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` });
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
/** D-061: the warning badge of a tile whose value does not fit (a triangle with an exclamation mark). */
const FIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
/** D-061: what the badge and the settings panel say about a tile's value fit. */
export function fitWarning(state: string): string {
  return state === 'cut'
    ? 'This tile is too narrow for its value: the value is cut (the full value shows on hover). Make the tile wider.'
    : 'This tile is narrow for its value: the value is drawn much smaller. Make the tile wider.';
}
export const GRID_CSS = `
.dbb-gwarn{position:absolute;left:6px;bottom:6px;z-index:3;display:none;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#FEF3C7;color:#B45309;box-shadow:0 1px 3px rgba(0,0,0,.18);cursor:help}
.dbb-gwarn svg{width:14px;height:14px}
.dbb-gbox.fitwarn .dbb-gwarn{display:inline-flex}
.dbb-dark .dbb-gwarn{background:#4A3410;color:#FCD34D}
.dbb-gbox{transition:left .15s,top .15s,width .15s,height .15s,transform .15s}
.dbb-gbox.dragging{transition:none;z-index:10;opacity:.9;will-change:transform}
.dbb-gbox.dragging .dbb-card{box-shadow:0 14px 34px rgba(16,24,40,.26),0 0 0 1px color-mix(in srgb,var(--accent) 55%,transparent)}
.dbb-dark .dbb-gbox.dragging .dbb-card{box-shadow:0 14px 34px rgba(0,0,0,.6),0 0 0 1px color-mix(in srgb,var(--accent) 70%,transparent)}
.dbb-gbox.moving .dbb-gdrag{cursor:grabbing}
.dbb-gbox.sizing .dbb-gresize{opacity:1}
.dbb-gdragging{user-select:none;-webkit-user-select:none}
.dbb-gdrop{position:absolute;z-index:5;display:none;pointer-events:none}
.dbb-gdrop i{display:block;min-width:0;min-height:0;border-radius:8px;background:color-mix(in srgb,var(--accent) 14%,transparent);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--accent) 55%,transparent)}
.dbb-dark .dbb-gdrop i{background:color-mix(in srgb,var(--accent) 22%,transparent);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--accent) 75%,transparent)}
.dbb-gsize{position:absolute;right:22px;bottom:6px;z-index:4;padding:1px 8px;border-radius:999px;background:var(--accent);color:#fff;font-size:12px;font-weight:600;line-height:20px;font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,.22)}
.dbb-gdrag,.dbb-gresize{touch-action:none}
@media (pointer:coarse){.dbb-gresize{right:0;bottom:0;width:28px;height:28px}.dbb-gsize{right:32px}}
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
