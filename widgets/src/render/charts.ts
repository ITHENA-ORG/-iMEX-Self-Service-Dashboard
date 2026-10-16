/**
 * Dependency-free SVG charts: line/area (crosshair tooltip, thresholds, stacking), bar (per-bar tooltip),
 * gauge (rule zones), sparkline, donut, state timeline and heatmap. Chrome colours come from CSS variables
 * so dashboard themes (light/dark) apply without redrawing logic.
 *
 * WHERE IT RUNS / WHO CALLS IT
 * In the browser, inside the ThingsBoard widgets. Only render/widgets.ts (draw()) calls these
 * functions, after it has fetched the data. No chart function makes REST calls.
 *
 * KEY CONCEPTS
 * - SVG only (no canvas, no chart library, D-010). Each function empties `host` and redraws it
 *   completely, so it is safe to call again on every refresh.
 * - Sizing: the chart takes the host's content-box size (inner(), which subtracts padding) at draw
 *   time, with minimums so tiny cells still draw. There is no resize observer here: render/grid.ts
 *   calls refresh() again when the column width changes.
 * - Colours: axis text, grid lines, dot outlines and "no data" cells use CSS variables (--ink-3,
 *   --grid, --card-bg / --surface, --accent) set by theme.ts applyTheme and per-card cardVars.
 *   Data colours (series, slices, bars, rule colours) are passed in by the caller.
 * - Tooltips: one absolutely positioned .dbb-tip div per host (tipAt), placed by placeTip.
 * - Empty data draws the placeholder "No data in this time range".
 * - All labels are escaped with esc(); colours are interpolated as given (they come from the
 *   palette, validated rule colours or theme tokens).
 *
 * EXPORTS
 * lineChart(host, series, LineOpts)      time-series lines / areas, optional stacking, smoothing, thresholds.
 * barChart(host, bars, {unit, decimals, thresholds})  one bar per Bar, rounded top.
 * gauge(host, value, {min, max, rules, ...})           half-circle gauge with rule zones.
 * sparkline(host, pts, color)            small trend for the KPI widget.
 * donut(host, slices, {unit, decimals, centerLabel, percent})  donut with legend.
 * stateTimeline(host, rows, {startTs, endTs, legend})  coloured state strips, one row per machine.
 * heatmap(host, rows, cols, {bucketMs, colorOf, ...})  machines x time-bucket grid.
 */
import { esc, fmtNum, fmtTime } from './theme';
import * as fmt from '../core/datefmt';
import type { ColorRule } from '../core/schema';
import { matchRule } from './rules';

/** One line of a line/area chart. */
export interface Series {
  /** Legend and tooltip name. */
  name: string;
  /** Line colour (any CSS colour). */
  color: string;
  unit?: string;
  /** Tooltip decimals (default 1). */
  decimals?: number;
  /** Numeric points, oldest first. */
  points: { ts: number; value: number }[];
}

const NS = 'http://www.w3.org/2000/svg';
// Theme-aware attribute snippets for axis labels and grid lines.
const AX = 'style="fill:var(--ink-3)"';
const GRIDL = 'style="stroke:var(--grid)"';

/**
 * About `count` evenly spaced "round" axis ticks (steps of 1, 2, 2.5, 5 x 10^n) covering min..max.
 * A flat range is widened by 1 either side; non-finite input returns [0, 1].
 */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Decimals needed so adjacent tick labels differ. */
function tickDecimals(ticks: number[]): number {
  if (ticks.length < 2) return 1;
  const step = Math.abs(ticks[1] - ticks[0]) || 1;
  for (let d = 0; d <= 4; d++) if (ticks.every((t) => Math.abs(Math.round(t * 10 ** d) - t * 10 ** d) < 1e-6)) return d;
  return Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
}

/** Content-box size (clientWidth/Height include padding). */
function inner(host: HTMLElement): { w: number; h: number } {
  const cs = getComputedStyle(host);
  return {
    w: host.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0'),
    h: host.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0'),
  };
}

/** Returns the host's tooltip div, creating it (hidden) on first use. */
function tipAt(host: HTMLElement): HTMLDivElement {
  let t = host.querySelector(':scope > .dbb-tip') as HTMLDivElement | null;
  if (!t) {
    t = document.createElement('div');
    t.className = 'dbb-tip';
    t.style.display = 'none';
    host.appendChild(t);
  }
  return t;
}

/** Shows the tooltip right of (x, y) in host coordinates, flipping left when it would overflow the host. */
function placeTip(host: HTMLElement, tip: HTMLElement, x: number, y: number) {
  tip.style.display = 'block';
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = x + 12;
  if (left + w > host.clientWidth) left = x - w - 12;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, Math.min(y - h / 2, host.clientHeight - h))}px`;
}

/** Human duration for tooltips: "12 min", "3 h 5 min", "2 d". */
const dur = (ms: number) => {
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60 ? `${m % 60} min` : ''}`.trim();
  return `${Math.round(h / 24)} d`;
};

/** Monotone cubic path (Fritsch–Carlson): smooth without overshooting the data. */
function monotonePath(pts: [number, number][]): string {
  const n = pts.length;
  if (n < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0] || 1e-6);
    m.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]));
  t.push(m[n - 2]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + h * t[i]).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - h * t[i + 1]).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

/** Options for lineChart. */
export interface LineOpts {
  /** X axis range (ms); the chart always spans the full window, even where there is no data. */
  startTs: number;
  endTs: number;
  /** Legend is shown for 2+ series unless this is false. */
  showLegend?: boolean;
  /** Fill under each line (the y axis then includes 0). */
  area?: boolean;
  /** Stack series on top of each other (area widgets). */
  stacked?: boolean;
  /** Monotone curves instead of straight segments. */
  smooth?: boolean;
  /** Dashed horizontal lines (from colour rules). Ones far outside the data range are dropped. */
  thresholds?: { value: number; color: string; label?: string }[];
}

/**
 * Line / area chart with y grid, time axis, optional legend, threshold lines and a hover crosshair
 * showing the nearest point of every series.
 * @param host Element to draw into (emptied first; set to position:relative). Expected to be a flex
 *   column so the legend and plot stack (widgets.ts sets that).
 * @param series Lines to draw; series without points are skipped (all empty = placeholder).
 * @param opts See LineOpts.
 * Lines break at gaps longer than max(3x median step, 15 min) so offline periods are visible (D-019);
 * stacked charts don't break.
 */
export function lineChart(host: HTMLElement, series: Series[], opts: LineOpts) {
  host.innerHTML = '';
  host.style.position = 'relative';
  let withData = series.filter((s) => s.points.length);
  if (!withData.length) {
    host.innerHTML = '<div class="dbb-ph">No data in this time range</div>';
    return;
  }
  // stacking: resample every series on the union of timestamps (step hold), then accumulate.
  // base[i] holds the running total below series i (the floor of its area; subtracted again in the tooltip).
  let base: Map<number, number>[] | null = null;
  if (opts.stacked && withData.length > 1) {
    const tsAll = [...new Set(withData.flatMap((s) => s.points.map((p) => p.ts)))].sort((a, b) => a - b);
    const acc = new Map<number, number>(tsAll.map((t) => [t, 0]));
    base = [];
    withData = withData.map((s) => {
      const b = new Map(acc);
      base!.push(b);
      let j = 0;
      let last = s.points[0].value;
      const pts = tsAll.map((t) => {
        while (j < s.points.length && s.points[j].ts <= t) last = s.points[j++].value;
        const v = acc.get(t)! + last;
        acc.set(t, v);
        return { ts: t, value: v };
      });
      return { ...s, points: pts, raw: s.points } as Series;
    });
  }
  if (series.length > 1 && opts.showLegend !== false) {
    const lg = document.createElement('div');
    lg.className = 'dbb-legend';
    lg.innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
    host.appendChild(lg);
  }
  // Plot box takes the height left after the legend.
  const box = document.createElement('div');
  box.style.cssText = 'position:relative;flex:1;height:calc(100% - ' + (host.firstChild ? (host.firstChild as HTMLElement).offsetHeight : 0) + 'px)';
  host.appendChild(box);
  const W = Math.max(120, box.clientWidth || inner(host).w);
  const H = Math.max(80, box.clientHeight || inner(host).h - 20);
  const all = withData.flatMap((s) => s.points.map((p) => p.value));
  let lo = Math.min(...all, ...(opts.area ? [0] : []));
  let hi = Math.max(...all);
  const span0 = hi - lo || 1;
  // Keep thresholds within 60% of the data span beyond it, and stretch the axis to show them.
  const thr = (opts.thresholds ?? []).filter((t) => t.value >= lo - span0 * 0.6 && t.value <= hi + span0 * 0.6);
  for (const t of thr) {
    lo = Math.min(lo, t.value);
    hi = Math.max(hi, t.value);
  }
  const ticks = niceTicks(lo, hi);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const tdec = tickDecimals(ticks);
  // Left margin sized to the longest tick label (~6.5 px per character at 10 px font).
  const labelW = Math.max(...ticks.map((t) => fmtNum(t, tdec).length)) * 6.5 + 8;
  const m = { l: labelW, r: 8, t: 6, b: 18 };
  const x = (ts: number) => m.l + ((ts - opts.startTs) / (opts.endTs - opts.startTs)) * (W - m.l - m.r);
  const y = (v: number) => m.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - m.t - m.b);
  const span = opts.endTs - opts.startTs;
  // Unique gradient ids: several charts share one document.
  const uid = Math.random().toString(36).slice(2, 8);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.style.display = 'block';
  let g = '<defs>';
  withData.forEach((s, i) => (g += `<linearGradient id="g${uid}${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity="${opts.stacked ? 0.55 : 0.28}"/><stop offset="1" stop-color="${s.color}" stop-opacity="${opts.stacked ? 0.35 : 0.02}"/></linearGradient>`));
  g += '</defs>';
  for (const t of ticks) {
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" ${GRIDL}/>`;
    g += `<text x="${m.l - 6}" y="${y(t) + 3.5}" text-anchor="end" font-size="10" ${AX}>${fmtNum(t, tdec)}</text>`;
  }
  const xt = Math.max(2, Math.min(6, Math.floor(W / 140)));
  for (let i = 0; i <= xt; i++) {
    const ts = opts.startTs + (span * i) / xt;
    g += `<text x="${x(ts)}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : i === xt ? 'end' : 'middle'}" font-size="10" ${AX}>${esc(fmtTime(ts, span))}</text>`;
  }
  // stacked areas are drawn top series first so lower ones stay visible
  const order = withData.map((_, i) => i);
  if (base) order.reverse();
  for (const i of order) {
    const s = withData[i];
    const pts = s.points;
    const steps = pts.slice(1).map((p, k) => p.ts - pts[k].ts).sort((a, b) => a - b);
    const med = steps[Math.floor(steps.length / 2)] || 0;
    // split on gaps > max(3x median step, 15 min) so offline periods are visible
    const runs: { ts: number; value: number }[][] = [];
    pts.forEach((p, k) => {
      const gap = k > 0 && med > 0 && !base && p.ts - pts[k - 1].ts > Math.max(med * 3, 15 * 60e3);
      if (!runs.length || gap) runs.push([]);
      runs[runs.length - 1].push(p);
    });
    for (const run of runs) {
      const xy = run.map((p) => [x(p.ts), y(p.value)] as [number, number]);
      const d = opts.smooth ? monotonePath(xy) : xy.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      if (opts.area || base) {
        const floor = base
          ? run
              .slice()
              .reverse()
              .map((p) => `L${x(p.ts).toFixed(1)},${y(base![i].get(p.ts) ?? 0).toFixed(1)}`)
              .join('')
          : `L${xy[xy.length - 1][0].toFixed(1)},${y(Math.max(yMin, 0)).toFixed(1)}L${xy[0][0].toFixed(1)},${y(Math.max(yMin, 0)).toFixed(1)}`;
        g += `<path d="${d}${floor}Z" fill="url(#g${uid}${i})" stroke="none"/>`;
      }
      g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
  }
  for (const t of thr) {
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t.value)}" y2="${y(t.value)}" stroke="${t.color}" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    g += `<text x="${W - m.r - 2}" y="${y(t.value) - 4}" text-anchor="end" font-size="10" font-weight="600" fill="${t.color}">${esc(t.label ?? fmtNum(t.value, tdec))}</text>`;
  }
  g += `<line class="xh" y1="${m.t}" y2="${H - m.b}" style="stroke:var(--ink-3);display:none" stroke-dasharray="3 3"/>`;
  svg.innerHTML = g;
  box.appendChild(svg);

  const tip = tipAt(box);
  const xh = svg.querySelector('.xh') as SVGLineElement;
  const dots = withData.map((s) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('r', '4');
    c.setAttribute('fill', s.color);
    c.setAttribute('style', 'stroke:var(--card-bg,var(--surface));display:none');
    c.setAttribute('stroke-width', '2');
    svg.appendChild(c);
    return c;
  });
  // Crosshair: for each series snap to the point nearest the mouse time (linear scan).
  svg.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const ts = opts.startTs + ((px - m.l) / (W - m.l - m.r)) * span;
    let rows = '';
    let anyTs = 0;
    withData.forEach((s, i) => {
      let bi = 0;
      for (let k = 0; k < s.points.length; k++) if (Math.abs(s.points[k].ts - ts) < Math.abs(s.points[bi].ts - ts)) bi = k;
      const best = s.points[bi];
      anyTs = best.ts;
      dots[i].setAttribute('cx', String(x(best.ts)));
      dots[i].setAttribute('cy', String(y(best.value)));
      dots[i].style.display = '';
      const shown = base ? best.value - (base[i].get(best.ts) ?? 0) : best.value;
      rows += `<div><span class="dbb-dot" style="background:${s.color};width:8px;height:8px"></span> ${esc(s.name)}: <b>${fmtNum(shown, s.decimals ?? 1)}</b> ${esc(s.unit ?? '')}</div>`;
    });
    xh.setAttribute('x1', String(x(anyTs)));
    xh.setAttribute('x2', String(x(anyTs)));
    xh.style.display = '';
    tip.innerHTML = `<div style="opacity:.7;margin-bottom:3px">${esc(fmt.dateTime(anyTs, { short: true }))}</div>${rows}`;
    placeTip(box, tip, px, ev.clientY - r.top);
  });
  svg.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    xh.style.display = 'none';
    dots.forEach((d) => (d.style.display = 'none'));
  });
}

/** One bar of a bar chart. */
export interface Bar {
  /** X axis label (cut to 12 characters). */
  label: string;
  /** null = no data: slot kept, no bar drawn. */
  value: number | null;
  color: string;
  /** Tooltip heading (defaults to label). */
  detail?: string;
}

/**
 * Bar chart: one bar per entry, rounded at the data end, baseline at 0 (negative values go down).
 * @param host Element to draw into (emptied first).
 * @param bars Bars in display order; all-null = placeholder.
 * @param opts.unit / opts.decimals Tooltip formatting. opts.thresholds: dashed lines; ones above
 *   1.6x the largest bar don't stretch the axis; lines outside the axis are not drawn.
 * X labels are thinned to about one per 60 px.
 */
export function barChart(host: HTMLElement, bars: Bar[], opts: { unit?: string; decimals?: number; thresholds?: { value: number; color: string; label?: string }[] }) {
  host.innerHTML = '';
  host.style.position = 'relative';
  const vals = bars.map((b) => b.value).filter((v): v is number => v != null && Number.isFinite(v));
  if (!vals.length) {
    host.innerHTML = '<div class="dbb-ph">No data in this time range</div>';
    return;
  }
  const W = Math.max(120, inner(host).w);
  const H = Math.max(80, inner(host).h);
  const thr = opts.thresholds ?? [];
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals, ...thr.map((t) => t.value).filter((v) => v <= Math.max(...vals) * 1.6)));
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const dec = opts.decimals ?? 1;
  const tdec = tickDecimals(ticks);
  const labelW = Math.max(...ticks.map((t) => fmtNum(t, tdec).length)) * 6.5 + 8;
  const m = { l: labelW, r: 6, t: 6, b: 18 };
  const y = (v: number) => m.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - m.t - m.b);
  const slot = (W - m.l - m.r) / bars.length;
  const bw = Math.max(2, Math.min(40, slot - 2));
  let g = '';
  for (const t of ticks) {
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" ${GRIDL}/>`;
    g += `<text x="${m.l - 6}" y="${y(t) + 3.5}" text-anchor="end" font-size="10" ${AX}>${fmtNum(t, tdec)}</text>`;
  }
  const every = Math.ceil(bars.length / Math.max(1, Math.floor((W - m.l) / 60)));
  bars.forEach((b, i) => {
    const cx = m.l + slot * i + slot / 2;
    if (b.value != null && Number.isFinite(b.value)) {
      const y0 = y(Math.max(0, yMin));
      const y1 = y(b.value);
      const top = Math.min(y0, y1);
      const h = Math.max(1, Math.abs(y0 - y1));
      const r = Math.min(4, bw / 2, h);
      // rounded data-end, square baseline
      g += `<path data-i="${i}" d="M${cx - bw / 2},${top + h} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${top + h} Z" fill="${b.color}"/>`;
    }
    if (i % every === 0) g += `<text x="${cx}" y="${H - 4}" text-anchor="middle" font-size="10" ${AX}>${esc(b.label.length > 12 ? b.label.slice(0, 11) + '…' : b.label)}</text>`;
  });
  for (const t of thr)
    if (t.value >= yMin && t.value <= yMax) {
      g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t.value)}" y2="${y(t.value)}" stroke="${t.color}" stroke-width="1.5" stroke-dasharray="5 4"/>`;
      g += `<text x="${W - m.r - 2}" y="${y(t.value) - 4}" text-anchor="end" font-size="10" font-weight="600" fill="${t.color}">${esc(t.label ?? fmtNum(t.value, tdec))}</text>`;
    }
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.style.display = 'block';
  svg.innerHTML = g;
  host.appendChild(svg);
  const tip = tipAt(host);
  svg.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const i = Math.floor((ev.clientX - r.left - m.l) / slot);
    const b = bars[i];
    if (!b || b.value == null) {
      tip.style.display = 'none';
      return;
    }
    tip.innerHTML = `<div style="opacity:.7">${esc(b.detail ?? b.label)}</div><b>${fmtNum(b.value, dec)}</b> ${esc(opts.unit ?? '')}`;
    placeTip(host, tip, ev.clientX - r.left, ev.clientY - r.top);
  });
  svg.addEventListener('mouseleave', () => (tip.style.display = 'none'));
}

/**
 * Half-circle gauge from min (left) to max (right) with the value in the middle.
 * @param host Element to draw into (its content is replaced).
 * @param value Current value; null or non-finite draws an empty track and "—". Clamped to min..max on the arc.
 * @param o.min / o.max Scale. o.rules + o.key: rule colours drawn as a thin outer ring and used
 *   for the value arc (else --accent). o.label: text under the value (default unit). o.sub: line under
 *   the gauge. o.valueColor: overrides the value text colour.
 */
export function gauge(
  host: HTMLElement,
  value: number | null,
  o: { min: number; max: number; unit?: string; decimals?: number; rules?: ColorRule[]; key?: string; sub?: string; label?: string; valueColor?: string },
) {
  const W = Math.max(100, inner(host).w);
  const H = Math.max(70, inner(host).h);
  // Track width and radius scale with the cell; H - 44 leaves room for the value text and min/max labels.
  const tw0 = Math.max(8, Math.min(16, Math.min(W, H * 2) / 22));
  const r = Math.max(20, Math.min(W / 2 - tw0 - 14, H - 44));
  const cx = W / 2;
  const cy = r + tw0 / 2 + 10;
  // Value -> angle: min = PI (left), max = 0 (right).
  const a = (v: number) => Math.PI * (1 - Math.min(1, Math.max(0, (v - o.min) / (o.max - o.min || 1))));
  const pt = (ang: number, rr: number) => `${(cx + rr * Math.cos(ang)).toFixed(1)},${(cy - rr * Math.sin(ang)).toFixed(1)}`;
  const arc = (v0: number, v1: number, stroke: string, wdt: number, rr = r) =>
    `<path d="M${pt(a(v0), rr)} A${rr},${rr} 0 0 1 ${pt(a(v1), rr)}" fill="none" ${stroke} stroke-width="${wdt}" stroke-linecap="butt"/>`;
  const tw = tw0;
  let g = arc(o.min, o.max, 'style="stroke:var(--grid)"', tw);
  // rule zones: sample the range and draw a thin outer ring in the matching rule colour
  if (o.rules?.length) {
    const N = 90;
    let segStart = o.min;
    let cur: string | null = null;
    for (let i = 0; i <= N; i++) {
      const v = o.min + ((o.max - o.min) * i) / N;
      const c = i === N ? '__end' : matchRule(o.rules, v, o.key)?.color ?? null;
      if (c !== cur) {
        if (cur && cur !== '__end') g += arc(segStart, v, `stroke="${cur}"`, 3.5, r + tw / 2 + 4);
        segStart = v;
        cur = c;
      }
    }
  }
  const ok = value != null && Number.isFinite(value);
  const col = (ok && matchRule(o.rules, value, o.key)?.color) || 'var(--accent)';
  if (ok) g += arc(o.min, Math.min(o.max, Math.max(o.min, value!)), `style="stroke:${col}"`, tw);
  if (ok) {
    const ang = a(Math.min(o.max, Math.max(o.min, value!)));
    g += `<circle cx="${pt(ang, r).split(',')[0]}" cy="${pt(ang, r).split(',')[1]}" r="${tw / 2 + 2}" style="fill:var(--card-bg,var(--surface));stroke:${col}" stroke-width="3"/>`;
  }
  const fs = Math.max(15, Math.min(40, r / 2.6));
  g += `<text x="${cx}" y="${cy - 6}" text-anchor="middle" font-size="${fs}" font-weight="600" style="fill:${o.valueColor ?? 'var(--card-value-color,var(--ink))'}">${ok ? fmtNum(value, o.decimals ?? 1) : '—'}</text>`;
  g += `<text x="${cx}" y="${cy + 10}" text-anchor="middle" font-size="11" style="fill:var(--ink-2)">${esc(o.label ?? o.unit ?? '')}</text>`;
  g += `<text x="${cx - r}" y="${cy + 16}" text-anchor="middle" font-size="10" ${AX}>${fmtNum(o.min, 0)}</text>`;
  g += `<text x="${cx + r}" y="${cy + 16}" text-anchor="middle" font-size="10" ${AX}>${fmtNum(o.max, 0)}</text>`;
  host.innerHTML = `<svg width="${W}" height="${Math.min(H, cy + 22)}" style="display:block;margin:0 auto">${g}</svg>${o.sub ? `<div style="text-align:center;font-size:11px;color:var(--ink-3);margin-top:2px">${esc(o.sub)}</div>` : ''}`;
}

/**
 * Compact trend line with a soft area and an end dot. No axes, no tooltip.
 * Uses host.clientWidth/Height directly (the KPI widget calls it in requestAnimationFrame so the size is known).
 * Fewer than 2 points draws nothing.
 */
export function sparkline(host: HTMLElement, pts: { ts: number; value: number }[], color: string) {
  host.innerHTML = '';
  if (pts.length < 2) return;
  const W = Math.max(60, host.clientWidth);
  const H = Math.max(20, host.clientHeight);
  const vs = pts.map((p) => p.value);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const t0 = pts[0].ts;
  const t1 = pts[pts.length - 1].ts;
  const x = (t: number) => 2 + ((t - t0) / (t1 - t0 || 1)) * (W - 6);
  const y = (v: number) => 3 + (1 - (v - lo) / (hi - lo || 1)) * (H - 6);
  const xy = pts.map((p) => [x(p.ts), y(p.value)] as [number, number]);
  const d = monotonePath(xy);
  const uid = Math.random().toString(36).slice(2, 8);
  const last = xy[xy.length - 1];
  host.innerHTML = `<svg width="${W}" height="${H}" style="display:block"><defs><linearGradient id="s${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".25"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${d}L${last[0].toFixed(1)},${H}L${xy[0][0].toFixed(1)},${H}Z" fill="url(#s${uid})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3.2" fill="${color}" style="stroke:var(--card-bg,var(--surface))" stroke-width="2"/></svg>`;
}

/** One slice of a donut. */
export interface Slice {
  label: string;
  /** Slices with value <= 0 are left out. */
  value: number;
  color: string;
  /** Tooltip heading (defaults to label). */
  detail?: string;
}

/**
 * Donut with a legend (beside it in wide cells, below it otherwise). The centre shows the largest
 * slice's percentage and label unless o.centerLabel is given.
 * @param o.percent false = tooltip shows the raw value instead of the percentage (default: both).
 * @param o.unit / o.decimals Raw value formatting.
 */
export function donut(host: HTMLElement, slices: Slice[], o: { unit?: string; decimals?: number; centerLabel?: string; percent?: boolean }) {
  host.innerHTML = '';
  host.style.position = 'relative';
  const data = slices.filter((s) => s.value > 0);
  const total = data.reduce((a, s) => a + s.value, 0);
  if (!data.length || !total) {
    host.innerHTML = '<div class="dbb-ph">No data in this time range</div>';
    return;
  }
  const W = Math.max(120, inner(host).w);
  const H = Math.max(90, inner(host).h);
  const side = W > H * 1.6;
  const size = Math.max(70, Math.min(side ? H - 4 : H - 22 - Math.ceil(data.length / 3) * 16, side ? W * 0.5 : W - 8));
  const R = size / 2;
  const rIn = R * 0.62;
  let ang = -Math.PI / 2;
  let paths = '';
  const top = data.reduce((a, b) => (b.value > a.value ? b : a));
  data.forEach((s, i) => {
    const frac = s.value / total;
    const a0 = ang;
    // Tiny gap so an arc never starts and ends on the same point (SVG would draw nothing).
    const a1 = ang + frac * Math.PI * 2 - (data.length > 1 ? 0.0001 : 0);
    ang += frac * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const P = (a: number, r: number) => `${(R + r * Math.cos(a)).toFixed(2)},${(R + r * Math.sin(a)).toFixed(2)}`;
    // A single slice is a full ring: two near-closed circles filled with evenodd.
    const d = data.length === 1 ? `M${R},${R - R}A${R},${R} 0 1 1 ${R - 0.01},${0}Z M${R},${R - rIn}A${rIn},${rIn} 0 1 0 ${R + 0.01},${R - rIn}Z` : `M${P(a0, R)}A${R},${R} 0 ${large} 1 ${P(a1, R)}L${P(a1, rIn)}A${rIn},${rIn} 0 ${large} 0 ${P(a0, rIn)}Z`;
    paths += `<path data-i="${i}" d="${d}" fill="${s.color}" fill-rule="evenodd" style="stroke:var(--card-bg,var(--surface))" stroke-width="2"/>`;
  });
  const pct = (v: number) => `${fmtNum((v / total) * 100, 0)}%`;
  const center = o.centerLabel ?? pct(top.value);
  const sub = o.centerLabel ? '' : top.label;
  const wrap = document.createElement('div');
  wrap.style.cssText = `display:flex;${side ? 'flex-direction:row' : 'flex-direction:column'};align-items:center;justify-content:center;gap:12px;height:100%`;
  wrap.innerHTML = `<div style="position:relative;width:${size}px;height:${size}px;flex:none"><svg width="${size}" height="${size}" style="display:block">${paths}</svg>
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;text-align:center">
      <div style="font-size:${Math.max(13, R / 3.2)}px;font-weight:600">${esc(center)}</div>${sub ? `<div style="font-size:11px;color:var(--ink-3);max-width:${rIn * 1.6}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sub)}</div>` : ''}</div></div>
    <div class="dbb-legend" style="${side ? 'flex-direction:column;gap:6px' : 'justify-content:center'}">${data
      .map((s) => `<span><i class="sq" style="background:${s.color}"></i>${esc(s.label)} <b style="color:var(--ink);font-weight:600">${pct(s.value)}</b></span>`)
      .join('')}</div>`;
  host.appendChild(wrap);
  const svg = wrap.querySelector('svg') as SVGSVGElement;
  const tip = tipAt(host);
  svg.addEventListener('mousemove', (ev) => {
    const t = ev.target as Element;
    const i = Number(t.getAttribute('data-i'));
    const s = data[i];
    if (!s) return void (tip.style.display = 'none');
    const hr = host.getBoundingClientRect();
    tip.innerHTML = `<div style="opacity:.7">${esc(s.detail ?? s.label)}</div><b>${o.percent === false ? fmtNum(s.value, o.decimals ?? 1) + ' ' + esc(o.unit ?? '') : pct(s.value)}</b>${o.percent !== false && o.unit ? ` · ${fmtNum(s.value, o.decimals ?? 1)} ${esc(o.unit)}` : ''}`;
    placeTip(host, tip, ev.clientX - hr.left, ev.clientY - hr.top);
  });
  svg.addEventListener('mouseleave', () => (tip.style.display = 'none'));
}

/** One row (machine) of a state timeline. */
export interface TimelineRow {
  /** Row label; rows get no label column when there is only one row. */
  label: string;
  /** Time spans in ms with their colour and state label. */
  segments: { start: number; end: number; color: string; label: string }[];
}

/**
 * State timeline: one horizontal strip per row, coloured segments clipped to startTs..endTs,
 * a time axis and an optional legend. Tooltip shows state, duration and times.
 * @param host Element to draw into (emptied first); expected to be a flex column.
 * @param o.legend Legend entries (state label -> colour), drawn above the strips when not empty.
 */
export function stateTimeline(host: HTMLElement, rows: TimelineRow[], o: { startTs: number; endTs: number; legend: { label: string; color: string }[] }) {
  host.innerHTML = '';
  host.style.position = 'relative';
  if (!rows.some((r) => r.segments.length)) {
    host.innerHTML = '<div class="dbb-ph">No data in this time range</div>';
    return;
  }
  if (o.legend.length) {
    const lg = document.createElement('div');
    lg.className = 'dbb-legend';
    lg.innerHTML = o.legend.map((l) => `<span><i class="sq" style="background:${l.color}"></i>${esc(l.label)}</span>`).join('');
    host.appendChild(lg);
  }
  const box = document.createElement('div');
  box.style.cssText = 'position:relative;flex:1';
  host.appendChild(box);
  const W = Math.max(160, inner(host).w);
  const H = Math.max(40, inner(host).h - (host.firstChild !== box ? (host.firstChild as HTMLElement).offsetHeight : 0));
  const labelW = rows.length > 1 ? Math.min(160, Math.max(...rows.map((r) => r.label.length)) * 6.5 + 10) : 0;
  const m = { l: labelW, r: 4, t: 2, b: 18 };
  const rowH = Math.max(12, Math.min(34, (H - m.t - m.b) / rows.length - 6));
  const span = o.endTs - o.startTs;
  const x = (t: number) => m.l + ((Math.max(o.startTs, Math.min(o.endTs, t)) - o.startTs) / span) * (W - m.l - m.r);
  let g = '';
  rows.forEach((r, i) => {
    const y0 = m.t + i * (rowH + 6);
    if (labelW) g += `<text x="${labelW - 8}" y="${y0 + rowH / 2 + 3.5}" text-anchor="end" font-size="11" style="fill:var(--ink-2)">${esc(r.label.length > 22 ? r.label.slice(0, 21) + '…' : r.label)}</text>`;
    g += `<rect x="${m.l}" y="${y0}" width="${W - m.l - m.r}" height="${rowH}" rx="4" style="fill:var(--grid)"/>`;
    r.segments.forEach((s, k) => {
      const x0 = x(s.start);
      const w = Math.max(1, x(s.end) - x0 - 1);
      g += `<rect data-r="${i}" data-k="${k}" x="${x0}" y="${y0}" width="${w}" height="${rowH}" rx="${Math.min(3, w / 2)}" fill="${s.color}"/>`;
    });
  });
  const xt = Math.max(2, Math.min(6, Math.floor(W / 140)));
  const yAx = m.t + rows.length * (rowH + 6) + 10;
  for (let i = 0; i <= xt; i++) {
    const ts = o.startTs + (span * i) / xt;
    g += `<text x="${x(ts)}" y="${yAx}" text-anchor="${i === 0 ? 'start' : i === xt ? 'end' : 'middle'}" font-size="10" ${AX}>${esc(fmtTime(ts, span))}</text>`;
  }
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(Math.min(H, yAx + 4)));
  svg.style.display = 'block';
  svg.innerHTML = g;
  box.appendChild(svg);
  const tip = tipAt(box);
  svg.addEventListener('mousemove', (ev) => {
    const t = ev.target as Element;
    const r = rows[Number(t.getAttribute('data-r'))];
    const s = r?.segments[Number(t.getAttribute('data-k'))];
    if (!s) return void (tip.style.display = 'none');
    const br = box.getBoundingClientRect();
    tip.innerHTML = `<div style="opacity:.7">${esc(r.label)}</div><b>${esc(s.label)}</b> · ${dur(s.end - s.start)}<div style="opacity:.7">${esc(fmt.range(s.start, s.end, { short: true }))}</div>`;
    placeTip(box, tip, ev.clientX - br.left, ev.clientY - br.top);
  });
  svg.addEventListener('mouseleave', () => (tip.style.display = 'none'));
}

export interface HeatRow {
  label: string;
  /** One value per column (null = no data). */
  cells: (number | null)[];
}

/**
 * Heatmap: one row per machine, one column per time bucket.
 * @param rows One row per machine; cells align with `cols`. A single unlabelled row gets no label column.
 * @param cols Bucket start times (ms).
 * @param o.bucketMs Bucket length (tooltip end time). o.colorOf(v, lo, hi): cell colour, where lo/hi
 *   are the min/max over all cells; null cells use --grid. o.legend: ramp colours for a min..max
 *   legend (omit for rule colours). o.unit / o.decimals: formatting.
 */
export function heatmap(host: HTMLElement, rows: HeatRow[], cols: number[], o: { bucketMs: number; colorOf(v: number, lo: number, hi: number): string; unit?: string; decimals?: number; legend?: string[] }) {
  host.innerHTML = '';
  host.style.position = 'relative';
  const vs = rows.flatMap((r) => r.cells).filter((v): v is number => v != null && Number.isFinite(v));
  if (!vs.length || !cols.length) {
    host.innerHTML = '<div class="dbb-ph">No data in this time range</div>';
    return;
  }
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const W = Math.max(160, inner(host).w);
  const H = Math.max(60, inner(host).h - 22);
  const labelW = Math.min(140, Math.max(40, ...rows.map((r) => r.label.length * 6.2 + 10)));
  const m = { l: rows.length > 1 || rows[0]?.label ? labelW : 4, r: 2, t: 2, b: 16 };
  const cw = (W - m.l - m.r) / cols.length;
  const ch = Math.max(8, Math.min(40, (H - m.t - m.b) / rows.length));
  // D-061 (M2): the app's format; the day too when the columns span more than 36 h (a viewer's long window)
  const fmtT = (t: number) => esc(fmtTime(t, cols.length * o.bucketMs));
  let g = '';
  rows.forEach((row, r) => {
    if (m.l > 4) g += `<text x="${m.l - 6}" y="${m.t + r * ch + ch / 2 + 3.5}" text-anchor="end" font-size="10" ${AX}>${esc(row.label.length > 22 ? row.label.slice(0, 21) + '…' : row.label)}</text>`;
    row.cells.forEach((v, c) => {
      g += `<rect data-r="${r}" data-c="${c}" x="${m.l + c * cw + 1}" y="${m.t + r * ch + 1}" width="${Math.max(1, cw - 2)}" height="${Math.max(1, ch - 2)}" rx="${Math.min(3, cw / 4)}" ${v != null ? `fill="${o.colorOf(v, lo, hi)}"` : 'style="fill:var(--grid)"'}/>`;
    });
  });
  const yb = m.t + rows.length * ch + 12;
  const every = Math.max(1, Math.ceil((cols.length * o.bucketMs > 36 * 3600e3 ? 78 : 46) / cw));
  cols.forEach((t, c) => {
    if (c % every === 0) g += `<text x="${m.l + c * cw}" y="${yb}" text-anchor="start" font-size="10" ${AX}>${fmtT(t)}</text>`;
  });
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(yb + 4));
  svg.style.display = 'block';
  svg.innerHTML = g;
  host.appendChild(svg);
  if (o.legend) {
    const lg = document.createElement('div');
    lg.className = 'dbb-legend';
    lg.style.cssText = 'justify-content:flex-end;margin-top:4px;align-items:center';
    lg.innerHTML = `<span>${fmtNum(lo, o.decimals ?? 1)}</span>${o.legend.map((c) => `<i class="sq" style="background:${c};margin:0 -3px"></i>`).join('')}<span>${fmtNum(hi, o.decimals ?? 1)} ${esc(o.unit ?? '')}</span>`;
    host.appendChild(lg);
  }
  const tip = tipAt(host);
  svg.addEventListener('mousemove', (ev) => {
    const t = ev.target as Element;
    const r = Number(t.getAttribute('data-r'));
    const c = Number(t.getAttribute('data-c'));
    const row = rows[r];
    if (!row || t.getAttribute('data-r') === null) return void (tip.style.display = 'none');
    const v = row.cells[c];
    const hr = host.getBoundingClientRect();
    tip.innerHTML = `<div style="opacity:.7">${esc(row.label ? row.label + ' · ' : '')}${esc(fmt.range(cols[c], cols[c] + o.bucketMs, { short: true }))}</div>${v == null ? 'No data' : `<b>${fmtNum(v, o.decimals ?? 1)}</b> ${esc(o.unit ?? '')}`}`;
    placeTip(host, tip, ev.clientX - hr.left, ev.clientY - hr.top);
  });
  svg.addEventListener('mouseleave', () => (tip.style.display = 'none'));
}
