// D-096: the shift and the crew on shift worked out in the browser (core/shiftcrew.ts): the computed properties of the
// value cards (Current shift, On shift: <crew role>), who sees names (Crew Hidden: nobody's), where the names come from
// (the app's own way: /api/users for a customer user, /api/customer/{id}/users for a tenant administrator), what the
// pickers no longer offer (the old calendar-month shift) and that the computed keys are never read as readings.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeTB, ithena, asUser, PUN, RIC } from './fake-tb';
import * as api from '../src/core/api';
import * as scope from '../src/core/scope';
import { clearShiftCache } from '../src/core/shifts';
import * as sc from '../src/core/shiftcrew';
import { MSG } from '../src/core/usermsg';
import { compatible, propKind } from '../src/core/compat';
import { analyzerKeys } from '../src/entries/renderer';

let tb: FakeTB;
const mem = new Map<string, string>();
const ses = new Map<string, string>();
const at = (iso: string) => Date.parse(iso);
const T38 = [
  { id: 'a', name: 'Morning', start: '06:00', end: '14:00' },
  { id: 'b', name: 'Afternoon', start: '14:00', end: '22:00' },
  { id: 'c', name: 'Night', start: '22:00', end: '06:00' },
];
const time = (t: number, tz: string) => new Date(t).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
const ROSTER = {
  v: 2,
  roles: [
    { id: 'op1', name: 'Primary operator', need: 1 },
    { id: 'op2', name: 'Secondary operator', need: 1 },
    { id: 'mgr', name: 'Shift manager', need: 1 },
  ],
  team: [
    { site: PUN, user: 'u-ravi', role: 'op1' },
    { site: PUN, user: 'u-sunita', role: 'mgr' },
    { site: RIC, user: 'u-sunita', role: 'mgr' },
  ],
  entries: [
    { site: PUN, user: 'u-ravi', from: '2026-11-01', to: '2026-11-30', shifts: ['a'] },
    { site: PUN, user: 'u-sunita', from: '2026-11-01', to: '2026-11-30', shifts: ['a', 'b'] },
    { site: PUN, user: 'u-gone', from: '2026-11-01', to: '2026-11-30', shifts: ['a'], role: 'op2' },
  ],
};

beforeEach(() => {
  tb = ithena();
  tb.add({ id: 'sys', entityType: 'ASSET', name: 'System Configuration', type: 'Config' });
  tb.setAttrs('ASSET', 'pun', { imexShifts: { v: 1, versions: [{ id: 'v1', from: null, shifts: T38 }] }, imexTimeZone: 'Asia/Kolkata' });
  tb.setAttrs('ASSET', 'ric', { imexShifts: { v: 1, versions: [{ id: 'v1', from: null, shifts: [{ id: 'd', name: 'Day', start: '08:00', end: '16:00' }] }] }, imexTimeZone: 'UTC' });
  tb.setAttrs('ASSET', 'sys', { imexCrew: JSON.stringify(ROSTER) });
  tb.users = [
    { id: 'u-ravi', firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com' },
    { id: 'u-sunita', firstName: 'Sunita', email: 'sunita@example.com' },
  ];
  mem.clear();
  ses.clear();
  mem.set('jwt_token', 'x');
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => ses.get(k) ?? null,
    setItem: (k: string, v: string) => ses.set(k, v),
    removeItem: (k: string) => ses.delete(k),
    key: (i: number) => [...ses.keys()][i] ?? null,
    get length() {
      return ses.size;
    },
  });
  api.clearCaches();
  clearShiftCache();
  sc.clearCrewCache();
});
afterEach(() => vi.unstubAllGlobals());

const MORNING = at('2026-11-19T10:00:00+05:30');

describe('computed properties: Current shift and On shift: <crew role>', () => {
  it('the pickers get Current shift and one entry per roster role, in roster order', async () => {
    expect(await sc.loadRoles()).toEqual([
      { id: 'op1', name: 'Primary operator' },
      { id: 'op2', name: 'Secondary operator' },
      { id: 'mgr', name: 'Shift manager' },
    ]);
    expect(sc.computedMetas().map((m) => [m.key, m.displayName])).toEqual([
      ['@shift', 'Current shift'],
      ['@crew:op1', 'On shift: Primary operator'],
      ['@crew:op2', 'On shift: Secondary operator'],
      ['@crew:mgr', 'On shift: Shift manager'],
    ]);
    expect(sc.computedMeta('@crew:gone').displayName).toBe('On shift');
    expect(sc.isComputed('@shift') && sc.isComputed('@crew:op1') && !sc.isComputed('shift') && !sc.isComputed('@crew:') && !sc.isComputed('@other')).toBe(true);
  });

  it('Current shift: the name, its times in the site zone and the time left; between shifts the next one', async () => {
    asUser(tb, 'u1', 'Admin', ['root']);
    const ctx = await scope.loadUserContext();
    const v = await sc.computedValue(ctx, '@shift', 'pc', MORNING, time);
    expect(v).toEqual({ text: 'Morning', sub: '06:00–14:00 · 4 h left' });
    const gap = await sc.computedValue(ctx, '@shift', 'rc', at('2026-11-19T18:00:00Z'), time);
    expect(gap).toEqual({ text: 'Between shifts', sub: 'Next: Day at 08:00', muted: true });
  });

  it('On shift: the names of the role on shift now at the machine site; a removed user is not named', async () => {
    asUser(tb, 'u1', 'Admin', ['root']);
    const ctx = await scope.loadUserContext();
    expect(await sc.computedValue(ctx, '@crew:op1', 'pc', MORNING, time)).toEqual({ text: 'Ravi Kumar', sub: 'Morning' });
    expect(await sc.computedValue(ctx, '@crew:mgr', 'pw', MORNING, time)).toEqual({ text: 'Sunita', sub: 'Morning' });
    expect(await sc.computedValue(ctx, '@crew:op2', 'pc', MORNING, time)).toEqual({ text: sc.NO_NAME, sub: 'Morning' });
    // the night shift: nobody planned in the role
    expect(await sc.computedValue(ctx, '@crew:op1', 'pc', at('2026-11-19T23:00:00+05:30'), time)).toEqual({ text: 'Nobody planned', sub: undefined, muted: true });
    // a role that is no longer in the roster
    expect(await sc.computedValue(ctx, '@crew:old', 'pc', MORNING, time)).toMatchObject({ text: '—', muted: true });
    // Richmond: Sunita is on its roster but planned nowhere: nobody; between its shifts: says so
    expect(await sc.computedValue(ctx, '@crew:op1', 'rc', at('2026-11-19T10:00:00Z'), time)).toMatchObject({ text: 'Nobody planned' });
    expect(await sc.computedValue(ctx, '@crew:op1', 'rc', at('2026-11-19T18:00:00Z'), time)).toEqual({ text: 'Between shifts', muted: true });
  });

  it('a customer user reads the names once with GET /api/users (the app’s own way), cached for the page', async () => {
    asUser(tb, 'u1', 'Admin', ['root']);
    const ctx = await scope.loadUserContext();
    tb.calls = [];
    await sc.computedValue(ctx, '@crew:op1', 'pc', MORNING, time);
    await sc.computedValue(ctx, '@crew:mgr', 'pc', MORNING, time);
    expect(tb.calls.filter((c) => /users/.test(c))).toEqual(['GET /api/users']);
    // the roster is read once too (2 minutes per page)
    expect(tb.calls.filter((c) => c === 'POST /api/entitiesQuery/find').length).toBeLessThanOrEqual(4);
  });

  it('Crew Hidden (the built-in Viewer): the shared no-access sentence, and no names are read', async () => {
    asUser(tb, 'u2', 'Viewer', ['root']);
    const ctx = await scope.loadUserContext();
    expect(ctx.perms.page('crew')).toBe('hidden');
    expect(sc.canSeeCrew(ctx)).toBe(false);
    tb.calls = [];
    expect(await sc.computedValue(ctx, '@crew:op1', 'pc', MORNING, time)).toEqual({ message: MSG.noAccess });
    expect((await sc.crewNow(ctx, PUN, MORNING)).state).toBe('hidden');
    expect(tb.calls.some((c) => /users/.test(c))).toBe(false);
    // the shift itself is not personal: shown
    expect(await sc.computedValue(ctx, '@shift', 'pc', MORNING, time)).toMatchObject({ text: 'Morning' });
  });

  it('a tenant administrator: the names of the customer of System Configuration', async () => {
    tb.me = { ...tb.me, id: { id: 'u-t' }, authority: 'TENANT_ADMIN' };
    const ctx = await scope.loadUserContext({ tenantCustomerId: 'c1' });
    tb.calls = [];
    const c = await sc.crewNow(ctx, PUN, MORNING);
    expect(c.state).toBe('ok');
    expect(c.rows.map((r) => `${r.roleName}: ${r.name}`)).toEqual(['Primary operator: Ravi Kumar', 'Secondary operator: Name not available', 'Shift manager: Sunita']);
    expect(tb.calls).toContain('GET /api/customer/c1/users');
    expect(tb.calls).not.toContain('GET /api/users');
    // without the launcher's customer setting: the customer System Configuration is assigned to
    sc.clearCrewCache();
    tb.calls = [];
    const names = await sc.loadNames({ customerId: '', perms: { unrestricted: true } as any });
    expect(names.get('u-ravi')).toBe('Ravi Kumar');
    expect(tb.calls).toContain('GET /api/asset/sys');
    expect(tb.calls).toContain('GET /api/customer/c1/users');
  });

  it('no roster stored, no shifts set up, a machine at no site', async () => {
    asUser(tb, 'u1', 'Admin', ['root']);
    tb.setAttrs('ASSET', 'sys', { imexCrew: '' });
    const ctx = await scope.loadUserContext();
    expect((await sc.crewNow(ctx, PUN, MORNING)).state).toBe('noRoster');
    expect(await sc.computedValue(ctx, '@crew:op1', 'pc', MORNING, time)).toEqual({ text: '—', sub: 'No crew roster for this site yet', muted: true });
    sc.clearCrewCache();
    tb.setAttrs('ASSET', 'sys', { imexCrew: JSON.stringify(ROSTER) });
    expect((await sc.crewNow(ctx, null, MORNING)).state).toBe('noSite');
    tb.setAttrs('ASSET', 'pun', { imexShifts: '' });
    clearShiftCache();
    expect((await sc.crewNow(ctx, PUN, MORNING)).state).toBe('noShifts');
    expect(await sc.computedValue(ctx, '@shift', 'pc', MORNING, time)).toEqual({ text: 'No shifts set up', muted: true });
  });

  it('the site of a machine is the asset that directly contains it; a site is its own', async () => {
    asUser(tb, 'u1', 'Admin', ['root']);
    const ctx = await scope.loadUserContext();
    expect(sc.siteOf(ctx, 'pc')).toEqual({ id: PUN, name: 'Pune' });
    expect(sc.siteOf(ctx, 'rd')).toEqual({ id: RIC, name: 'Richmond' });
    expect(sc.siteOf(ctx, PUN)).toEqual({ id: PUN, name: 'Pune' });
    expect(sc.siteOf(ctx, 'nope')).toBeNull();
  });

  it('time left reads in hours and minutes', () => {
    expect([sc.duration(4 * 3600e3), sc.duration(135 * 60e3), sc.duration(45 * 60e3), sc.duration(20e3)]).toEqual(['4 h', '2 h 15 min', '45 min', 'less than a minute']);
  });
});

describe('what the pickers offer; computed keys are text and never readings', () => {
  it('not offered: the old calendar-month shift and the OEE chain records; real shift values still are', () => {
    for (const k of ['shift', 'Current_Shift', 'Shift_Record', 'imexStopReason', 'aiml_score']) expect(scope.NOT_OFFERED.test(k), k).toBe(true);
    for (const k of ['Shift_OEE', 'Shift_Good', 'shift_count', 'Shift', 'dischargePressure']) expect(scope.NOT_OFFERED.test(k), k).toBe(false);
  });

  it('a computed property is text: on a value card or a status indicator, not on a gauge or a chart', () => {
    const m = sc.computedMeta('@crew:op1');
    expect(propKind(m)).toBe('string');
    expect(compatible('value', m).ok && compatible('status', m).ok && compatible('multivalue', m).ok).toBe(true);
    expect(compatible('gauge', m).ok || compatible('line', m).ok).toBe(false);
    expect(compatible('shiftinfo', null).ok).toBe(true);
  });

  it('the Analyzer button does not get a computed key', () => {
    const w = (keys: string[]) => ({ id: 'w', type: 'multivalue', title: '', x: 0, y: 0, w: 4, h: 3, binding: { mode: 'current' }, keys, settings: {} }) as any;
    expect(analyzerKeys([w(['@shift', 'powerKw', '@crew:op1'])], 'pc', 'Compressor')).toEqual(['powerKw']);
  });
});
