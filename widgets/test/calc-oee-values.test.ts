// D-077 (round 18): calculated values (App UI U-128) and the values the OEE chain saves (U-127) in the Builder's value
// lists: the "calculated" mark from the machine model, and names / units / decimals for OEE values nobody named.
import { describe, it, expect } from 'vitest';
import * as M from '../src/core/machine';
import * as scope from '../src/core/scope';
import { readFileSync } from 'node:fs';
import { OEE_VALUES, NOT_A_VALUE } from '../src/core/oee-values';
import { picker } from '../src/builder/controls';

const MODEL = { v: 1, types: { 'Filling Line': { values: [
  { key: 'Motor_power_hp', label: 'Motor power', unit: 'hp', decimals: 1, calc: 'Motor Power × 1.341' },
  { key: 'Motor_Power', label: 'Motor Power', unit: 'kW' },
] } } };

describe('calculated values', () => {
  it('the model keeps the formula and the overlay carries it to the value list', () => {
    expect(M.value(MODEL, 'Filling Line', 'Motor_power_hp').calc).toBe('Motor Power × 1.341');
    expect(M.value(MODEL, 'Filling Line', 'Motor_Power').calc).toBe('');
    const list = M.overlay(MODEL, 'Filling Line', scope.mergeKeys([], ['Motor_Power', 'Motor_power_hp']));
    const hp = list.find((k) => k.key === 'Motor_power_hp')!;
    expect(hp).toMatchObject({ displayName: 'Motor power', unit: 'hp', decimals: 1, calc: 'Motor Power × 1.341' });
    expect(list.find((k) => k.key === 'Motor_Power')!.calc).toBeUndefined();
  });

  it('a blank or non-text formula is no mark', () => {
    const m = { v: 1, types: { T: { values: [{ key: 'a', label: 'A', calc: '  ' }, { key: 'b', label: 'B', calc: 5 }] } } };
    expect(M.value(m, 'T', 'a').calc).toBe('');
    expect(M.value(m, 'T', 'b').calc).toBe('');
  });

  it('the property picker shows the icon with the formula as its tooltip, and "calculated" finds it', () => {
    let html = '';
    // no DOM here: every element the picker wires is a stub that accepts anything (the e2e run clicks the real one)
    const stub: any = new Proxy({}, { get: (t: any, k) => (k in t ? t[k] : () => stub), set: (t: any, k, v) => ((t[k] = v), true) });
    const host: any = {
      classList: { add() {}, toggle() {} }, dataset: {}, querySelector: () => stub, querySelectorAll: () => [],
      addEventListener() {}, set innerHTML(v: string) { html = v; }, get innerHTML() { return html; },
    };
    picker(host, { name: 'keys', items: [{ value: 'Motor_power_hp', label: 'Motor power', sub: 'hp', calc: 'Calculated: Motor power = Motor Power × 1.341' }],
      selected: ['Motor_power_hp'], multi: false, placeholder: 'Choose a property…', noun: ['property', 'properties'], onChange() {} });
    expect(html).toContain('class="calc" role="img" aria-label="Calculated value" title="Calculated: Motor power = Motor Power × 1.341"');
  });
});

describe('OEE values', () => {
  it('get their names, units and decimals when nobody named them', () => {
    const list = scope.mergeKeys([], ['OEE', 'OEE_A', 'Shift_Good_Total', 'Shift_Run_Min', 'Current_Shift', 'Line_Speed']);
    const by = Object.fromEntries(list.map((k) => [k.key, k]));
    expect(by.OEE).toMatchObject({ displayName: 'OEE', unit: '%', decimals: 1 });
    expect(by.OEE_A).toMatchObject({ displayName: 'Availability', unit: '%', decimals: 1 });
    expect(by.Shift_Good_Total).toMatchObject({ displayName: 'Good units per shift', unit: 'units', decimals: 0 });
    expect(by.Shift_Run_Min).toMatchObject({ displayName: 'Run time this shift', unit: 'min' });
    expect(by.Current_Shift, 'App UI U-137: the shift name is not a value').toBeUndefined();
    expect(by.Line_Speed).toMatchObject({ displayName: 'Line Speed', unit: '', decimals: 1 });
  });

  it("the machines' own names and the model still win", () => {
    const named = new Map([['OEE_A', { label: 'Availability', unit: '%' }], ['Shift_Units', { label: 'Units This Shift', unit: '' }]]);
    const list = scope.mergeKeys([], ['OEE_A', 'Shift_Units'], named);
    expect(list.find((k) => k.key === 'Shift_Units')).toMatchObject({ displayName: 'Units This Shift', unit: '' });
    const m = { v: 1, types: { T: { values: [{ key: 'OEE', label: 'Line OEE', unit: '%' }] } } };
    expect(M.overlay(m, 'T', scope.mergeKeys([], ['OEE']))[0]).toMatchObject({ displayName: 'Line OEE' });
  });

  it('the shift record, the shift name and the stop-reason store are not values', () => {
    expect(scope.mergeKeys([], ['Shift_Record', 'Current_Shift', 'imexStopReason', 'OEE', 'aiml_x']).map((k) => k.key)).toEqual(['OEE']);
    expect(scope.NOT_A_PROPERTY.test('Shift_Records')).toBe(false);
    expect(Object.keys(OEE_VALUES)).toHaveLength(26); // App UI U-143: + Ideal_Rate_Now, Shift_Target_Units, Shift_Changeover_Min, Current_Product
  });
});

describe('a name that ends in its unit', () => {
  it('is not doubled ("Motor power (hp)" with the unit hp lists as "Motor power" + hp)', () => {
    const k = { key: 'k', displayName: 'Motor power (hp)', unit: 'hp', decimals: 1, min: 0, max: 100 };
    expect(scope.noDoubleUnit(k).displayName).toBe('Motor power');
    expect(scope.noDoubleUnit({ ...k, displayName: 'Flow (normal)', unit: 'm³/h' }).displayName).toBe('Flow (normal)');
    expect(scope.noDoubleUnit({ ...k, unit: '' }).displayName).toBe('Motor power (hp)');
  });
});

// App UI U-137: the shared vectors (widgets/test/machine-vectors.json, a byte-for-byte copy of the App UI's): the same OEE
// table as the App UI and Reports, the same not-a-values, the same no-double-unit rule
describe('shared vectors: oeeValues, notAValue, noDoubleUnit', () => {
  const V = JSON.parse(readFileSync(new URL('./machine-vectors.json', import.meta.url), 'utf8'));
  it('the OEE table is the shared one (name, unit, decimals, how it adds up)', () => {
    expect(Object.keys(OEE_VALUES).sort()).toEqual(Object.keys(V.oeeValues).sort());
    for (const [k, e] of Object.entries(V.oeeValues) as [string, any][]) {
      const o = OEE_VALUES[k];
      expect({ label: o.name, unit: o.unit, decimals: o.decimals, kind: o.kind }, k).toEqual(e);
    }
  });
  it('not a value', () => { for (const c of V.notAValue) expect(NOT_A_VALUE.test(c.key), c.key).toBe(c.expect); });
  it('no double unit', () => {
    for (const c of V.noDoubleUnit) expect(scope.noDoubleUnit({ key: 'k', displayName: c.label, unit: c.unit, decimals: 1, min: 0, max: 100 }).displayName, c.label + ' / ' + c.unit).toBe(c.expect);
  });
});
