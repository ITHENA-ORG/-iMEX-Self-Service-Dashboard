// D-061 (16 Oct 2026, usability audit H3 / M2 / A-046): the machine page's Time window choice (core/viewwindow.ts), the
// app's one date-time format in the Builder (core/datefmt.ts), the custom period's time field (entries/timepicker.ts
// parseTime), the pill's words (renderer timeHtml / windowTip / ownWindowCards), values at the end of a past window
// (api.latestAt) and the Create ticket write rule (renderer mayWrite).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fmt from '../src/core/datefmt';
import { presetLabel, viewLabel, chipLabel, isView, customProblem, viewWindow, hasEnded, loadView, saveView, viewKey, VIEW_PRESETS, MAX_CUSTOM_MS } from '../src/core/viewwindow';
import { calendar, template } from '../src/core/shiftcal';
import { parseTime } from '../src/entries/timepicker';
import { timeHtml, windowTip, ownWindowCards, mayWrite, VIEW_ONLY } from '../src/entries/renderer';
import { rawLimit } from '../src/render/widgets';
import { FakeTB, ithena } from './fake-tb';
import * as api from '../src/core/api';

const H = 3600e3;
const MIN = 60e3;

describe('datefmt: the app-wide "16 Oct 2026, 4:57 AM" format without the app shell', () => {
  const ts = Date.UTC(2026, 9, 16, 4, 57, 7); // 16 Oct 2026, 04:57:07 UTC
  const o12 = { tz: 'UTC', hour12: true };
  const o24 = { tz: 'UTC', hour12: false };
  it('writes date, time and both, 12 and 24 hours', () => {
    expect(fmt.dateTime(ts, o12)).toBe('16 Oct 2026, 4:57 AM');
    expect(fmt.dateTime(ts, o24)).toBe('16 Oct 2026, 04:57');
    expect(fmt.date(ts, o12)).toBe('16 Oct 2026');
    expect(fmt.time(ts, o12)).toBe('4:57 AM');
    expect(fmt.time(ts, { ...o12, seconds: true })).toBe('4:57:07 AM');
    expect(fmt.time(Date.UTC(2026, 9, 16, 0, 5), o12)).toBe('12:05 AM');
    expect(fmt.time(Date.UTC(2026, 9, 16, 12, 5), o12)).toBe('12:05 PM');
    expect(fmt.time(Date.UTC(2026, 9, 16, 18, 30), o24)).toBe('18:30');
  });
  it('drops the year in the current year with short, never writes a numeric date', () => {
    const now = Date.UTC(2026, 11, 1);
    expect(fmt.dateTime(ts, { ...o12, short: true, now })).toBe('16 Oct, 4:57 AM');
    expect(fmt.dateTime(Date.UTC(2025, 0, 2, 9, 0), { ...o12, short: true, now })).toBe('2 Jan 2025, 9:00 AM');
    for (const s of [fmt.dateTime(ts, o12), fmt.date(ts, o12), fmt.range(ts, ts + 30 * H, o12)]) expect(s).not.toMatch(/\d+\/\d+/);
  });
  it('writes periods: one day once, the shared year once', () => {
    expect(fmt.range(ts, ts + 2 * H, o12)).toBe('16 Oct 2026, 4:57 AM – 6:57 AM');
    expect(fmt.range(ts - 8 * H, ts, o12)).toBe('15 Oct, 8:57 PM – 16 Oct 2026, 4:57 AM');
    expect(fmt.range(ts - 8 * H, ts, { ...o12, short: true, now: ts })).toBe('15 Oct, 8:57 PM – 16 Oct, 4:57 AM');
  });
  it('gives "" for a bad timestamp', () => {
    for (const v of [null, undefined, '', NaN, 'x', true]) expect(fmt.dateTime(v as any, o12)).toBe('');
  });
  it('writes the time in a zone', () => {
    expect(fmt.time(ts, { tz: 'Asia/Kolkata', hour12: true })).toBe('10:27 AM');
  });
  it('axis labels: time up to 36 h, day and hour up to 8 days, else the day', () => {
    const t = fmt.axis(ts, 4 * H);
    expect(t).toBe(fmt.time(ts));
    expect(fmt.axis(ts, 3 * 24 * H)).toMatch(/^\d{1,2} [A-Z][a-z]{2}(?: \d{4})?, (\d{1,2} (AM|PM)|\d{2}:00)$/);
    expect(fmt.axis(ts, 30 * 24 * H)).toMatch(/^\d{1,2} [A-Z][a-z]{2}( \d{4})?$/);
  });
  it('uses imxShell.fmt when the app shell is on the page', () => {
    const calls: string[] = [];
    vi.stubGlobal('imxShell', {
      fmt: {
        dateTime: (t: number, o: any) => (calls.push('dt:' + JSON.stringify(o)), 'SHELL-DT'),
        date: () => 'SHELL-D',
        time: () => 'SHELL-T',
        range: () => 'SHELL-R',
      },
      hour12: () => false,
    });
    try {
      expect(fmt.dateTime(ts, { short: true })).toBe('SHELL-DT');
      expect(calls[0]).toBe('dt:{"short":true}'); // no undefined tz handed on
      expect(fmt.range(1, 2)).toBe('SHELL-R');
      expect(fmt.hour12()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('viewwindow: the presets, labels and windows', () => {
  const kolkata = calendar({ chain: [{ v: 1, versions: [{ id: 'v1', from: null, shifts: template('3x8') }] }] as any, tz: 'Asia/Kolkata' });
  const now = Date.UTC(2026, 9, 9, 3, 0); // 08:30 in Kolkata: Morning 06:00-14:00
  it('has the app preset words', () => {
    expect(VIEW_PRESETS).toEqual(['1h', '4h', '8h', '24h', 'shift', 'prevshift']);
    expect(VIEW_PRESETS.map(presetLabel)).toEqual(['Last hour', 'Last 4 hours', 'Last 8 hours', 'Last 24 hours', 'Current shift', 'Previous shift']);
    expect(presetLabel('realtime')).toBe('Live · last hour');
    expect(presetLabel('2h')).toBe('Last 2 hours');
    expect(chipLabel('4h')).toBe('4 h');
    expect(chipLabel('shift')).toBe('Shift');
  });
  it('resolves hours ending now, shifts from the calendar, custom periods as chosen', () => {
    expect(viewWindow({ range: '24h' }, null, now)).toEqual({ startTs: now - 24 * H, endTs: now });
    const cur = viewWindow({ range: 'shift' }, kolkata, now)!;
    expect(cur.shift?.name).toBe('Morning');
    expect(cur.endTs).toBe(now);
    const prev = viewWindow({ range: 'prevshift' }, kolkata, now)!;
    expect(prev.shift?.ended).toBe(true);
    expect(prev.endTs).toBe(cur.startTs);
    expect(viewWindow({ range: 'shift' }, null, now)).toBeNull();
    expect(viewWindow({ range: 'custom', from: now - 5 * H, to: now - 2 * H }, null, now)).toEqual({ startTs: now - 5 * H, endTs: now - 2 * H });
    // a custom end still ahead: the window runs to now
    expect(viewWindow({ range: 'custom', from: now - 2 * H, to: now + H }, null, now)).toEqual({ startTs: now - 2 * H, endTs: now });
  });
  it('tells an ended window from one ending now', () => {
    expect(hasEnded({ endTs: now }, now)).toBe(false);
    expect(hasEnded({ endTs: now - 60e3 }, now)).toBe(false);
    expect(hasEnded({ endTs: now - 5 * MIN }, now)).toBe(true);
    expect(hasEnded(null, now)).toBe(false);
  });
  it('checks custom periods', () => {
    expect(customProblem(now - H, now - 2 * H, now)).toMatch(/after the start/);
    expect(customProblem(now + H, now + 2 * H, now)).toMatch(/in the past/);
    expect(customProblem(now - 2 * MIN, now, now)).toMatch(/5 minutes/);
    expect(customProblem(now - MAX_CUSTOM_MS - H, now, now)).toMatch(/7 days/);
    expect(customProblem(now - 400 * 24 * H, now - 399 * 24 * H, now)).toMatch(/last year/);
    expect(customProblem(now - 3 * H, now - H, now)).toBeNull();
    expect(customProblem(NaN, now, now)).toMatch(/start and an end/);
  });
  it('labels a custom period in the app format', () => {
    expect(viewLabel({ range: 'custom', from: now - 3 * H, to: now - H })).toBe(fmt.range(now - 3 * H, now - H, { short: true }));
    expect(viewLabel({ range: '4h' })).toBe('Last 4 hours');
  });
  it('accepts only well-formed choices', () => {
    expect(isView({ range: '4h' })).toBe(true);
    expect(isView({ range: 'custom', from: 1, to: 2 })).toBe(true);
    for (const v of [null, 'x', {}, { range: '3h' }, { range: 'custom', from: 2, to: 1 }, { range: 'custom', from: 'a', to: 2 }]) expect(isView(v)).toBe(false);
  });
});

describe('viewwindow: the choice kept per user and page', () => {
  const mem = new Map<string, string>();
  beforeEach(() => {
    mem.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('stores, reads back and forgets', () => {
    expect(loadView('u1', 'd1')).toBeNull();
    saveView('u1', 'd1', { range: '8h' });
    saveView('u1', 'd2', { range: 'custom', from: 10, to: 20 });
    expect(loadView('u1', 'd1')).toEqual({ range: '8h' });
    expect(loadView('u1', 'd2')).toEqual({ range: 'custom', from: 10, to: 20 });
    expect(loadView('u2', 'd1')).toBeNull(); // another user
    saveView('u1', 'd1', null);
    expect(loadView('u1', 'd1')).toBeNull();
  });
  it('ignores what it cannot read', () => {
    mem.set(viewKey('u1', 'd1'), '{bad');
    expect(loadView('u1', 'd1')).toBeNull();
    mem.set(viewKey('u1', 'd1'), JSON.stringify({ range: '72h' }));
    expect(loadView('u1', 'd1')).toBeNull();
  });
  it('never throws when storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } });
    expect(loadView('u1', 'd1')).toBeNull();
    expect(() => saveView('u1', 'd1', { range: '1h' })).not.toThrow();
  });
});

describe('parseTime (the custom period time fields)', () => {
  it('reads the usual ways of writing a time', () => {
    expect(parseTime('6')).toBe(360);
    expect(parseTime('6:30')).toBe(390);
    expect(parseTime('06:30')).toBe(390);
    expect(parseTime('6.30')).toBe(390);
    expect(parseTime('6:30 PM')).toBe(1110);
    expect(parseTime('6pm')).toBe(1080);
    expect(parseTime('12 am')).toBe(0);
    expect(parseTime('12:15 PM')).toBe(735);
    expect(parseTime('18:30')).toBe(1110);
    expect(parseTime(' 7:05 a.m. ')).toBe(425);
  });
  it('refuses the rest', () => {
    for (const s of ['', 'x', '25:00', '6:75', '13 pm', '0 am']) expect(parseTime(s)).toBeNull();
  });
});

describe('the Time window pill (renderer)', () => {
  const wd = (type: string, timeRange?: string) => ({ id: type + (timeRange ?? ''), type, title: '', x: 0, y: 0, w: 4, h: 3, keys: ['a'], binding: { mode: 'current' }, settings: timeRange ? { timeRange } : {} }) as any;
  it('counts the cards that keep their own window', () => {
    const ws = [wd('line', '4h'), wd('line', '1h'), wd('line'), wd('value', '4h'), wd('text', '4h'), wd('bar', 'shift')];
    expect(ownWindowCards(ws, '1h')).toBe(2);
    expect(ownWindowCards(ws, '4h')).toBe(2);
  });
  it('names the window the cards show and who chose it', () => {
    const html = timeHtml('1h', null, 1);
    expect(html).toContain('<button type="button" class="dbb-tw"');
    expect(html).toContain('>Last hour<');
    expect(html).toContain('1 card has its own window');
    const mine = timeHtml('1h', { range: '24h' });
    expect(mine).toContain('>Last 24 hours<');
    expect(mine).toContain('class="v mine"');
    expect(windowTip('1h', { range: '24h' })).toMatch(/^Every card shows last 24 hours \(your choice, kept for this page\)\. The dashboard's own window: last hour\./);
    expect(timeHtml('realtime')).toContain('class="v live"');
    expect(windowTip('shift', null)).toMatch(/current shift/);
  });
});

describe('Create ticket follows the write rule (A-046)', () => {
  const ctx = (unrestricted: boolean, pages: Record<string, string>) => ({ perms: { unrestricted, eff: { pages } } }) as any;
  it('a tenant admin or a role with a page at Full may write; a view-only role may not', () => {
    expect(mayWrite(ctx(true, {}))).toBe(true);
    expect(mayWrite(ctx(false, { machines: 'view', alarms: 'full' }))).toBe(true);
    expect(mayWrite(ctx(false, { machines: 'view', alarms: 'view', reports: 'hidden' }))).toBe(false);
    expect(mayWrite(null)).toBe(false);
    expect(VIEW_ONLY).toBe('Your role can view only');
  });
});

describe('values at the end of a window that has ended (api.latestAt)', () => {
  let tb: FakeTB;
  const mem = new Map<string, string>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 9, 10, 0));
    tb = ithena();
    tb.telemetry.set('rc', { powerKw: [0, 1, 2, 3, 4].map((i) => ({ ts: Date.now() - (4 - i) * H, value: 10 + i })), mode: [{ ts: Date.now() - 3 * H, value: 'auto' }] });
    mem.clear();
    mem.set('jwt_token', 'x');
    vi.stubGlobal('fetch', tb.fetch);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
    api.clearCaches();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('gives the last value of each key at or before the end', async () => {
    const at = await api.latestAt('rc', ['powerKw', 'mode', 'missing'], Date.now() - 1.5 * H);
    expect(at.powerKw).toEqual({ ts: Date.now() - 2 * H, value: 12 });
    expect(at.mode).toEqual({ ts: Date.now() - 3 * H, value: 'auto' });
    expect(at.missing).toBeUndefined();
    expect(await api.latestAt('rc', [], Date.now())).toEqual({});
  });
});

describe('raw read page size for long windows', () => {
  it('keeps 5000 up to about 11 h and grows with the window, at most 100 000', () => {
    expect(rawLimit(0, 8 * H)).toBe(5000);
    expect(rawLimit(0, 24 * H)).toBe(10800);
    expect(rawLimit(0, 7 * 24 * H)).toBe(75600);
    expect(rawLimit(0, 30 * 24 * H)).toBe(100000);
  });
});
