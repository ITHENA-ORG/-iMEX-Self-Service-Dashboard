// core/oee-values.ts — D-077: the values the app's OEE chain saves on a machine (App UI U-127, docs/design/OEE_CHAIN.md
// "Keys"). They get these names, units and decimals when nobody named them: the machine model and the machines'
// telemetryKeys names still win. Pure.
// App UI U-137 (5 Nov 2026): ONE table in three places — App UI widgets/_shared/machine.js OEE_VALUES, Reports
// service/app/catalogue.py OEE_VALUES and this file — checked against the shared vectors (widgets/test/machine-vectors.json
// "oeeValues", "notAValue", "noDoubleUnit": a byte-for-byte copy of the App UI's tests/machine-vectors.json).

/** How a value adds up over time: a plain reading; a running shift figure that restarts at each shift (the largest
 * reading of a bucket); a total written once per shift (added up). */
export type OeeKind = 'number' | 'counter' | 'count';
export interface OeeValue { name: string; unit: string; decimals: number; kind: OeeKind }

export const OEE_VALUES: Record<string, OeeValue> = {
  OEE: { name: 'OEE', unit: '%', decimals: 1, kind: 'number' },
  OEE_A: { name: 'Availability', unit: '%', decimals: 1, kind: 'number' },
  OEE_P: { name: 'Performance', unit: '%', decimals: 1, kind: 'number' },
  OEE_Q: { name: 'Quality', unit: '%', decimals: 1, kind: 'number' },
  Shift_Good: { name: 'Good units this shift', unit: 'units', decimals: 0, kind: 'counter' },
  Shift_Reject: { name: 'Rejected units this shift', unit: 'units', decimals: 0, kind: 'counter' },
  Shift_Rework: { name: 'Rework units this shift', unit: 'units', decimals: 0, kind: 'counter' },
  Shift_Units: { name: 'Units this shift', unit: 'units', decimals: 0, kind: 'counter' },
  Shift_Run_Min: { name: 'Run time this shift', unit: 'min', decimals: 1, kind: 'counter' },
  Shift_Stop_Min: { name: 'Stop time this shift', unit: 'min', decimals: 1, kind: 'counter' },
  Shift_Short_Stop_Min: { name: 'Short stop time this shift', unit: 'min', decimals: 1, kind: 'counter' },
  Shift_Planned_Min: { name: 'Planned time so far this shift', unit: 'min', decimals: 1, kind: 'counter' },
  Shift_Stops: { name: 'Stops this shift', unit: '', decimals: 0, kind: 'counter' },
  Shift_Short_Stops: { name: 'Short stops this shift', unit: '', decimals: 0, kind: 'counter' },
  Shift_Energy_kWh: { name: 'Energy this shift', unit: 'kWh', decimals: 1, kind: 'counter' },
  Energy_Per_1000_Good: { name: 'Energy per 1,000 good units', unit: 'kWh', decimals: 2, kind: 'number' },
  Shift_OEE: { name: 'Shift OEE', unit: '%', decimals: 1, kind: 'number' },
  Shift_A: { name: 'Shift availability', unit: '%', decimals: 1, kind: 'number' },
  Shift_P: { name: 'Shift performance', unit: '%', decimals: 1, kind: 'number' },
  Shift_Q: { name: 'Shift quality', unit: '%', decimals: 1, kind: 'number' },
  Shift_Good_Total: { name: 'Good units per shift', unit: 'units', decimals: 0, kind: 'count' },
  Shift_Reject_Total: { name: 'Rejected units per shift', unit: 'units', decimals: 0, kind: 'count' },
};

/** Stored on machines but no value to list or chart: the OEE chain's shift record (JSON) and shift name (text), and the
 * Losses page's stop-reason store (App UI U-137: Current_Shift too, as Reports and the App UI). */
export const NOT_A_VALUE = /^(Shift_Record|Current_Shift|imexStopReason)$/;
