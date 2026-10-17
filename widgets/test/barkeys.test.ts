// Storyboard round (12 Oct 2026): the properties the machine page bar's Analyzer button opens the Analyzer with
// (entries/renderer.ts analyzerKeys): the keys the dashboard shows for this machine, unique, at most 15; without any,
// the machine type's first numeric properties (at most 6).
import { describe, it, expect } from 'vitest';
import { analyzerKeys } from '../src/entries/renderer';

const w = (keys: string[], binding: any) => ({ id: 'w' + keys.join(''), type: 'line', title: '', x: 0, y: 0, w: 4, h: 3, keys, settings: {}, binding }) as any;

describe('analyzerKeys', () => {
  it('takes the keys of widgets bound to this machine, its name or its type, once each, in order', () => {
    const ws = [
      w(['power', 'pressure'], { mode: 'current' }),
      w(['pressure', 'temp'], { mode: 'fixed', deviceIds: ['d1', 'd2'] }),
      w(['flow'], { mode: 'siblings', profile: 'Compressor' }),
      w(['other'], { mode: 'fixed', deviceIds: ['d9'] }),
      w(['dryer'], { mode: 'nearest', profile: 'Dryer' }),
      w([], { mode: 'none' }),
    ];
    expect(analyzerKeys(ws, 'd1', 'Compressor')).toEqual(['power', 'pressure', 'temp', 'flow']);
  });
  it('keeps at most 15', () => {
    const ws = [w(Array.from({ length: 10 }, (_, i) => 'a' + i), { mode: 'current' }), w(Array.from({ length: 10 }, (_, i) => 'b' + i), { mode: 'current' })];
    expect(analyzerKeys(ws, 'd1', 'P')).toHaveLength(15);
  });
  it('falls back to the first numeric properties of the machine type', () => {
    const cat = [{ key: 'runStatus', type: 'number', states: { 1: 'Running' } }, { key: 'mode', type: 'string' }, { key: 'on', type: 'boolean' }, ...Array.from({ length: 8 }, (_, i) => ({ key: 'k' + i, type: 'number' }))];
    expect(analyzerKeys([w(['x'], { mode: 'fixed', deviceIds: ['d9'] })], 'd1', 'P', cat)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
    expect(analyzerKeys([], 'd1', 'P')).toEqual([]);
  });
});

// D-057: setting analyzerState of the renderer (the phone dashboard sets 'trend')
import { analyzerTarget } from '../src/entries/renderer';
describe('analyzerTarget', () => {
  const node = { name: 'CMP-01', label: 'Compressor 1' };
  it('opens the Analyzer by default, without a top-level entityId', () => {
    for (const v of [undefined, '', '  ', 'analytics', 7]) {
      const t = analyzerTarget(v, 'd1', node, ['a', 'b']);
      expect(t.state).toBe('analytics');
      expect(t.params).toEqual({ selectedEquipment: { entityName: 'CMP-01', entityLabel: 'Compressor 1', entityId: { id: 'd1', entityType: 'DEVICE' } }, entityName: 'CMP-01', entityLabel: 'Compressor 1', key: ['a', 'b'] });
      expect('entityId' in t.params).toBe(false);
    }
  });
  it("opens the phone's Trend screen with the machine, the keys and the first key selected", () => {
    expect(analyzerTarget('trend', 'd1', node, ['a', 'b'])).toEqual({ state: 'trend', params: { entityId: { id: 'd1', entityType: 'DEVICE' }, entityName: 'CMP-01', entityLabel: 'Compressor 1', key: ['a', 'b'], selected: 'a' } });
    expect(analyzerTarget('trend', 'd1', { name: 'X' }, []).params).toMatchObject({ entityLabel: 'X', key: [], selected: null });
  });
  it('another state id gets the Analyzer parameters', () => {
    expect(analyzerTarget('my_analyzer', 'd1', node, ['a']).state).toBe('my_analyzer');
  });
});

import { dashHasState } from '../src/entries/renderer';
describe('dashHasState', () => {
  it('is true for a state of the dashboard, or when the state list cannot be read', () => {
    expect(dashHasState({ stateController: { states: { analytics: {}, machine: {} } } }, 'analytics')).toBe(true);
    expect(dashHasState({ stateController: { states: { machine: {}, trend: {} } } }, 'analytics')).toBe(false);
    expect(dashHasState({ stateController: { statesValue: { trend: {} } } }, 'trend')).toBe(true);
    expect(dashHasState({ stateController: {} }, 'analytics')).toBe(true);
    expect(dashHasState({}, 'analytics')).toBe(true);
    expect(dashHasState({ stateController: { states: {} } }, 'x')).toBe(true);
  });
});

import { helpFrom, HELP_STATE } from '../src/entries/renderer';
describe('helpFrom (D-063: the bar\'s "?" Help for this page)', () => {
  const sc = (states: any, id?: any) => ({ stateController: { states, getStateId: () => id } });
  it('names the current state when the dashboard has the Help state', () => {
    expect(HELP_STATE).toBe('help');
    expect(helpFrom(sc({ help: {}, machine: {} }, 'machine'), 'machine')).toBe('machine');
    expect(helpFrom(sc({ help: {}, dashboard_overview: {} }, 'dashboard_overview'), 'machine')).toBe('dashboard_overview');
    expect(helpFrom({ stateController: { statesValue: { help: {} }, getStateId: () => 'machine_view' } }, 'machine')).toBe('machine_view');
  });
  it('falls back to the given page when the state id cannot be read', () => {
    expect(helpFrom(sc({ help: {} }, ''), 'dashboard_overview')).toBe('dashboard_overview');
    expect(helpFrom({ stateController: { states: { help: {} }, getStateId: () => { throw new Error('x'); } } }, 'machine')).toBe('machine');
  });
  it('is null without a Help state, when the state list cannot be read, and on the Help page itself', () => {
    expect(helpFrom(sc({ machine: {} }, 'machine'), 'machine')).toBeNull();
    expect(helpFrom(sc(undefined, 'machine'), 'machine')).toBeNull();
    expect(helpFrom({}, 'machine')).toBeNull();
    expect(helpFrom(null, 'machine')).toBeNull();
    expect(helpFrom(sc({ help: {} }, 'help'), 'machine')).toBeNull();
  });
});

import { playbookTarget, PLAYBOOKS_STATE } from '../src/entries/renderer';
import * as perm from '../src/core/perm';
describe('playbookTarget (D-068: the bar\'s "Create playbook")', () => {
  const tb = (states: any) => ({ stateController: { states } });
  // Playbooks at View with ticked actions (Full grants every action of the page)
  const role = (actions: Record<string, true>) => ({ can: (k: string) => perm.can(perm.effective({ id: 'r', name: 'R', perms: { playbooks: 'view' }, actions } as any), k) });
  const editor = role({ 'playbooks.edit': true });
  const lic = (keys: string[]) => ({ has: (k: string) => keys.includes(k) });
  it('opens the Playbooks page with a new playbook for this machine', () => {
    expect(PLAYBOOKS_STATE).toBe('playbooks');
    expect(playbookTarget(tb({ machine: {}, playbooks: {} }), editor, 'd1', lic(['playbooks']))).toEqual({ state: 'playbooks', params: { tab: 'playbooks', newFor: { machineId: 'd1' } } });
    expect(playbookTarget({ stateController: { statesValue: { playbooks: {} } } }, editor, 'd1', lic(['playbooks']))?.state).toBe('playbooks');
  });
  it('needs the role action playbooks.edit (run / write / approve are not enough)', () => {
    const t = tb({ playbooks: {} });
    expect(playbookTarget(t, role({ 'playbooks.run': true, 'playbooks.write': true, 'playbooks.approve': true }), 'd1', lic(['playbooks']))).toBeNull();
    expect(playbookTarget(t, null, 'd1', lic(['playbooks']))).toBeNull();
    expect(playbookTarget(t, { can: () => { throw new Error('x'); } }, 'd1', lic(['playbooks']))).toBeNull();
    // the built-in Admin has every action; the Viewer, Supervisor and Operator templates have no playbooks.edit
    expect(playbookTarget(t, { can: (k) => perm.can(perm.effective(perm.BUILTINS()[0]), k) }, 'd1', lic(['playbooks']))).not.toBeNull();
    for (const r of [perm.BUILTINS()[1], ...perm.TEMPLATES()]) expect(playbookTarget(t, { can: (k) => perm.can(perm.effective(r), k) }, 'd1', lic(['playbooks']))).toBeNull();
  });
  it('needs the licence feature playbooks (no licence API on the page = allowed, as every licHas)', () => {
    const t = tb({ playbooks: {} });
    expect(playbookTarget(t, editor, 'd1', lic(['builder', 'playbooks.write']))).toBeNull();
    expect(playbookTarget(t, editor, 'd1', null)).not.toBeNull();
  });
  it('needs the Playbooks state on the dashboard (an unreadable state list counts as no) and a machine', () => {
    expect(playbookTarget(tb({ machine: {} }), editor, 'd1', lic(['playbooks']))).toBeNull();
    expect(playbookTarget(tb(undefined), editor, 'd1', lic(['playbooks']))).toBeNull();
    expect(playbookTarget({}, editor, 'd1', lic(['playbooks']))).toBeNull();
    expect(playbookTarget(null, editor, 'd1', lic(['playbooks']))).toBeNull();
    expect(playbookTarget(tb({ playbooks: {} }), editor, '', lic(['playbooks']))).toBeNull();
  });
});
