// D-069: the pure part of the live drag feedback (render/grid.ts dragFrame, sizeLabel). The DOM part (the card at the
// pointer, the drop cells, pushed cards, Esc, touch) is covered by the E2E scenario "D-069 live feedback ...".
import { describe, it, expect } from 'vitest';
import { dragFrame, sizeLabel, GAP, ROW_H, MAX_DRAG_H } from '../src/render/grid';

const colW = 100;
const cellW = colW + GAP;
const cellH = ROW_H + GAP;
const r = { x: 2, y: 1, w: 3, h: 2 };
const left0 = GAP + 2 * cellW;
const top0 = GAP + 1 * cellH;

describe('dragFrame: move', () => {
  it('no travel: the card and its cells stay', () => {
    const f = dragFrame('move', r, 0, 0, colW);
    expect(f.snap).toEqual(r);
    expect([f.left, f.top, f.width, f.height]).toEqual([left0, top0, 3 * colW + 2 * GAP, 2 * ROW_H + GAP]);
  });
  it('the card follows the pointer to the px; the cells snap to the nearest', () => {
    const f = dragFrame('move', r, 0.4 * cellW, 0.6 * cellH, colW);
    expect([f.left, f.top]).toEqual([left0 + 0.4 * cellW, top0 + 0.6 * cellH]);
    expect(f.snap).toEqual({ ...r, x: 2, y: 2 });
  });
  it('kept inside the 12 columns and below the top (card and cells)', () => {
    const right = dragFrame('move', r, 50 * cellW, 0, colW);
    expect(right.snap.x).toBe(12 - 3);
    expect(right.left).toBe(GAP + 9 * cellW);
    const up = dragFrame('move', r, -10 * cellW, -10 * cellH, colW);
    expect(up.snap).toEqual({ ...r, x: 0, y: 0 });
    expect([up.left, up.top]).toEqual([GAP, GAP]);
  });
  it('downwards is unbounded (the canvas grows)', () => {
    expect(dragFrame('move', r, 0, 30 * cellH, colW).snap.y).toBe(31);
  });
});

describe('dragFrame: resize', () => {
  it('top-left stays, the size follows the pointer, the cells round to the nearest', () => {
    const f = dragFrame('resize', r, 1.6 * cellW, 0.4 * cellH, colW);
    expect([f.left, f.top]).toEqual([left0, top0]);
    expect(f.width).toBeCloseTo(3 * colW + 2 * GAP + 1.6 * cellW);
    expect(f.snap).toEqual({ ...r, w: 5, h: 2 });
  });
  it('at least one cell; at most to the right edge and MAX_DRAG_H rows', () => {
    const small = dragFrame('resize', r, -10 * cellW, -10 * cellH, colW);
    expect(small.snap).toEqual({ ...r, w: 1, h: 1 });
    expect([small.width, small.height]).toEqual([colW, ROW_H]);
    const big = dragFrame('resize', r, 50 * cellW, 50 * cellH, colW);
    expect(big.snap).toEqual({ ...r, w: 10, h: MAX_DRAG_H });
    expect(big.width).toBe(10 * colW + 9 * GAP);
    expect(big.height).toBe(MAX_DRAG_H * ROW_H + (MAX_DRAG_H - 1) * GAP);
  });
  it('same rounding as before D-069 (half a cell or more counts)', () => {
    expect(dragFrame('resize', r, 0.49 * cellW, 0.51 * cellH, colW).snap).toEqual({ ...r, w: 3, h: 3 });
  });
});

describe('sizeLabel', () => {
  it('"w × h" and a spoken form', () => {
    expect(sizeLabel({ w: 4, h: 2 })).toEqual({ text: '4 × 2', aria: '4 columns wide, 2 rows high' });
    expect(sizeLabel({ w: 1, h: 1 }).aria).toBe('1 column wide, 1 row high');
  });
});
