// core/types.ts — shared plain types with no runtime code.

/**
 * Catalogue entry for one telemetry key of a machine type (device profile).
 * Comes from the store asset attribute `dbb_profile_keys` (`{ [profile]: KeyMeta[] }`, written by
 * DBB_DEPLOY from `profileKeys`; see core/scope.ts). Used by the builder for names, units and
 * limits, by core/compat.ts for property-kind checks, and sent (without min/max/decimals) to the
 * chat model as the catalogue. Since 9 Oct 2026 the catalogue is an overlay: ctx.profileKeys lists every key the
 * machines send (core/scope.ts liveKeys), and keys not in the catalogue get a readable name and the unit of the
 * machine's `telemetryKeys` list when it has one.
 */
export interface KeyMeta {
  key: string;
  displayName: string;
  unit: string;
  decimals: number;
  min: number;
  max: number;
  /** Value type; inferred from the key and values when missing. */
  type?: 'number' | 'boolean' | 'string';
  /** Labels for boolean / coded values, e.g. { "1": "Running", "0": "Stopped" }. */
  states?: Record<string, string>;
  /** D-077: a calculated value's formula in names (App UI U-128, from the machine model): marked "calculated". */
  calc?: string;
}
