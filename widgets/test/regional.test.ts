// D-067 (16 Oct 2026, App UI U-073): regional formats in the Builder (core/regional.ts). Runs the "numbers", "percents"
// and "dates" cases of format-vectors.json (byte-identical copy of the App UI's tests/format-vectors.json, the contract
// shared with the shell and the Reports port), plus the config source order, the shell delegation, render/theme fmtNum
// and the time-window calendar's week start (entries/timepicker.ts uses weekStart / weekdayHeaders / leadDays).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as rg from '../src/core/regional';
import * as fmt from '../src/core/datefmt';
import { fmtNum } from '../src/render/theme';

const V: any = JSON.parse(readFileSync(new URL('./format-vectors.json', import.meta.url), 'utf8'));
const app = (formats: unknown) => vi.stubGlobal('__imexApp', { config: { formats } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('format-vectors.json: numbers and percents (the shell copy, byte for byte)', () => {
  it('has the cases', () => {
    expect(V.numbers.length).toBeGreaterThan(20);
    expect(V.percents.length).toBeGreaterThan(3);
  });
  for (const c of V.numbers) {
    it(`number ${JSON.stringify(c.v)} ${c.number} ${JSON.stringify(c.o)} → ${JSON.stringify(c.out)}`, () => {
      // as a per-call override, and as the page's config (window.__imexApp.config.formats)
      expect(rg.formatNumber(c.v, { ...c.o, formats: { number: c.number } })).toBe(c.out);
      app({ number: c.number });
      expect(rg.formatNumber(c.v, c.o)).toBe(c.out);
      expect(rg.number(c.v, c.o)).toBe(c.out);
    });
  }
  for (const c of V.percents) {
    it(`percent ${c.v} ${c.number} ${JSON.stringify(c.o)} → ${JSON.stringify(c.out)}`, () => {
      expect(rg.formatPercent(c.v, { ...c.o, formats: { number: c.number } })).toBe(c.out);
      app({ number: c.number });
      expect(rg.percent(c.v, c.o)).toBe(c.out);
    });
  }
});

describe('format-vectors.json: dates through core/datefmt without the shell', () => {
  for (const c of V.dates) {
    it(`${c.date} ${c.clock} h → ${c.dateTime_out}`, () => {
      const o = { tz: c.tz, now: c.now, hour12: c.clock === '12', formats: { date: c.date } };
      expect(fmt.date(c.ts, o)).toBe(c.date_out);
      expect(fmt.date(c.ts, { ...o, short: true })).toBe(c.short_out);
      expect(fmt.dateTime(c.ts, o)).toBe(c.dateTime_out);
      app({ date: c.date });
      expect(fmt.dateTime(c.ts, { tz: c.tz, now: c.now, hour12: c.clock === '12' })).toBe(c.dateTime_out);
    });
  }
  it('periods use the style and its separator', () => {
    const ts = Date.UTC(2026, 9, 16, 4, 57);
    expect(fmt.range(ts, ts + 3600e3, { tz: 'UTC', hour12: false, formats: { date: 'ymd' } })).toBe('2026-10-16 04:57 – 05:57');
    expect(fmt.range(ts - 8 * 3600e3, ts, { tz: 'UTC', hour12: false, formats: { date: 'dmy' } })).toBe('15/10, 20:57 – 16/10/2026, 04:57');
  });
});

describe('regional: where the formats come from', () => {
  it('defaults: dmon, comma-dot, Monday', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.useFakeTimers({ now: Date.now() + 5000 });
    expect(rg.appFormats()).toEqual({ locale: 'standard', date: 'dmon', number: 'comma-dot', weekStart: 1 });
    expect(rg.weekStart()).toBe(1);
  });
  it('the unsaved preview > the side menu copy > the cached copy in localStorage', () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'imx-app-config' ? JSON.stringify({ formats: { number: 'indian', weekStart: 0 } }) : null) });
    vi.useFakeTimers({ now: Date.now() + 10000 });
    expect(rg.appFormats().number).toBe('indian');
    expect(rg.weekStart()).toBe(0);
    app({ number: 'dot-comma', weekStart: 6 });
    expect(rg.appFormats().number).toBe('dot-comma');
    expect(rg.weekStart()).toBe(6);
    vi.stubGlobal('__imxFormats', { number: 'apos-dot' });
    expect(rg.appFormats()).toMatchObject({ number: 'apos-dot', weekStart: 1 });
  });
  it('unknown values fall back to the defaults', () => {
    app({ date: 'xx', number: 'yy', weekStart: 3 });
    expect(rg.appFormats()).toMatchObject({ date: 'dmon', number: 'comma-dot', weekStart: 1 });
    app({ weekStart: '0' });
    expect(rg.weekStart()).toBe(0);
  });
  it('uses imxShell.fmt when the app shell is on the page; an older shell falls back to the config', () => {
    const calls: any[] = [];
    vi.stubGlobal('imxShell', { fmt: { number: (v: unknown, o: unknown) => (calls.push([v, o]), 'SHELL-N'), weekStart: () => 6 } });
    expect(rg.number(12.5, { decimals: 1 })).toBe('SHELL-N');
    expect(calls[0]).toEqual([12.5, { decimals: 1 }]);
    expect(fmtNum(3, 2)).toBe('SHELL-N');
    expect(rg.weekStart()).toBe(6);
    vi.stubGlobal('imxShell', { fmt: { date: () => '' } });
    app({ number: 'dot-comma', weekStart: 0 });
    expect(rg.number(1234.5)).toBe('1.234,5');
    expect(rg.weekStart()).toBe(0);
  });
});

describe('render/theme fmtNum: fixed decimals in the app number style', () => {
  it('follows the style', () => {
    app({});
    expect(fmtNum(1234.5)).toBe('1,234.5');
    expect(fmtNum(1234.567, 2)).toBe('1,234.57');
    expect(fmtNum(12, 0)).toBe('12');
    app({ number: 'dot-comma' });
    expect(fmtNum(1234.5)).toBe('1.234,5');
    app({ number: 'space-comma' });
    expect(fmtNum(-1234567.25, 1)).toBe('-1 234 567,3');
    app({ number: 'indian' });
    expect(fmtNum(1234567, 0)).toBe('12,34,567');
  });
  it('keeps its non-number rules', () => {
    app({});
    expect(fmtNum(undefined)).toBe('—');
    expect(fmtNum('abc')).toBe('abc');
    expect(fmtNum(-0.04, 1)).toBe('0.0');
    expect(fmtNum('7', 1)).toBe('7.0');
  });
});

describe('time-window calendar: the week starts on the app day', () => {
  it('rotates the headers', () => {
    expect(rg.weekdayHeaders(1)).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    expect(rg.weekdayHeaders(0)).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
    expect(rg.weekdayHeaders(6)).toEqual(['Sa', 'Su', 'Mo', 'Tu', 'We', 'Th', 'Fr']);
  });
  it('counts the blank days before the 1st', () => {
    const oct = new Date(2026, 9, 1).getDay(); // Thursday
    expect(oct).toBe(4);
    expect(rg.leadDays(oct, 1)).toBe(3);
    expect(rg.leadDays(oct, 0)).toBe(4);
    expect(rg.leadDays(oct, 6)).toBe(5);
    // a month starting on the first weekday has no blanks; the day before it has six
    for (const ws of [0, 1, 6]) {
      expect(rg.leadDays(ws, ws)).toBe(0);
      expect(rg.leadDays((ws + 6) % 7, ws)).toBe(6);
    }
    // the first header is the weekday of the first cell
    for (const ws of [0, 1, 6]) {
      const first = new Date(2026, 9, 1 - rg.leadDays(oct, ws)).getDay();
      expect(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][first]).toBe(rg.weekdayHeaders(ws)[0]);
    }
  });
});
