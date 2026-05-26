/**
 * Unit conversion module.
 *
 * Same parameter from different devices often arrives in different units
 * (one device sends `speed` in rpm, another in rad/s). This module provides
 * a small set of unit families with linear (and one affine) conversions so
 * the UI can normalize on display.
 *
 * Add families by extending UNIT_FAMILIES below. Each family has a base unit
 * and a list of alternates with either a linear factor (`toBase`) or a pair
 * of functions for nonlinear conversions (`toBaseFn` / `fromBaseFn`, used
 * for temperature).
 */

export interface UnitDef {
  /** Canonical unit string as it appears in YAML (e.g. "rad/s", "deg"). */
  name: string;
  /** Display label for the picker (usually same as name). */
  label: string;
  /** Linear factor: value_in_base = value_in_this * toBase. */
  toBase?: number;
  /** Nonlinear: convert this unit → base. Overrides toBase. */
  toBaseFn?: (x: number) => number;
  /** Nonlinear: convert base → this unit. Required if toBaseFn is set. */
  fromBaseFn?: (x: number) => number;
  /** Lowercased aliases that should match this unit (e.g. "C" matches "°C", "celsius"). */
  aliases?: string[];
}

export interface UnitFamily {
  id: string;
  label: string;
  baseUnit: string;
  units: UnitDef[];
}

const TAU = 2 * Math.PI;

export const UNIT_FAMILIES: UnitFamily[] = [
  {
    id: 'angular_velocity',
    label: 'Angular velocity',
    baseUnit: 'rad/s',
    units: [
      { name: 'rad/s', label: 'rad/s', toBase: 1 },
      { name: 'rpm',   label: 'rpm',   toBase: TAU / 60, aliases: ['r/min', 'rev/min'] },
      { name: 'deg/s', label: 'deg/s', toBase: Math.PI / 180, aliases: ['°/s'] },
      { name: 'rev/s', label: 'rev/s', toBase: TAU, aliases: ['rps', 'r/s'] },
    ],
  },
  {
    id: 'angle',
    label: 'Angle',
    baseUnit: 'rad',
    units: [
      { name: 'rad', label: 'rad', toBase: 1, aliases: ['radian', 'radians'] },
      { name: 'deg', label: 'deg', toBase: Math.PI / 180, aliases: ['°', 'degree', 'degrees'] },
      { name: 'rev', label: 'rev', toBase: TAU, aliases: ['revolution', 'turn'] },
    ],
  },
  {
    id: 'temperature',
    label: 'Temperature',
    baseUnit: 'K',
    units: [
      { name: 'K',  label: 'K',  toBase: 1, aliases: ['kelvin'] },
      {
        name: '°C', label: '°C',
        toBaseFn: c => c + 273.15,
        fromBaseFn: k => k - 273.15,
        aliases: ['c', 'celsius', 'degc', 'deg c'],
      },
      {
        name: '°F', label: '°F',
        toBaseFn: f => (f - 32) * 5 / 9 + 273.15,
        fromBaseFn: k => (k - 273.15) * 9 / 5 + 32,
        aliases: ['f', 'fahrenheit', 'degf', 'deg f'],
      },
    ],
  },
  {
    id: 'linear_velocity',
    label: 'Linear velocity',
    baseUnit: 'm/s',
    units: [
      { name: 'm/s',  label: 'm/s',  toBase: 1 },
      { name: 'km/h', label: 'km/h', toBase: 1 / 3.6, aliases: ['kph'] },
      { name: 'mph',  label: 'mph',  toBase: 0.44704 },
      { name: 'cm/s', label: 'cm/s', toBase: 0.01 },
      { name: 'mm/s', label: 'mm/s', toBase: 0.001 },
    ],
  },
  {
    id: 'linear_distance',
    label: 'Linear distance',
    baseUnit: 'm',
    units: [
      { name: 'm',  label: 'm',  toBase: 1, aliases: ['meter', 'meters', 'metre'] },
      { name: 'mm', label: 'mm', toBase: 0.001 },
      { name: 'cm', label: 'cm', toBase: 0.01 },
      { name: 'km', label: 'km', toBase: 1000 },
      { name: 'in', label: 'in', toBase: 0.0254, aliases: ['inch', 'inches'] },
      { name: 'ft', label: 'ft', toBase: 0.3048, aliases: ['foot', 'feet'] },
    ],
  },
];

/** Lookup index: normalized unit string → (family, unit def). */
const UNIT_INDEX: Map<string, { family: UnitFamily; def: UnitDef }> = (() => {
  const m = new Map<string, { family: UnitFamily; def: UnitDef }>();
  for (const family of UNIT_FAMILIES) {
    for (const def of family.units) {
      m.set(def.name.toLowerCase(), { family, def });
      for (const alias of def.aliases ?? []) {
        m.set(alias.toLowerCase(), { family, def });
      }
    }
  }
  return m;
})();

function lookup(unit: string | null | undefined): { family: UnitFamily; def: UnitDef } | null {
  if (!unit) return null;
  return UNIT_INDEX.get(unit.trim().toLowerCase()) ?? null;
}

/** Return the family containing `unit`, or null if unknown. */
export function getFamily(unit: string): UnitFamily | null {
  return lookup(unit)?.family ?? null;
}

/**
 * Return every unit name in `unit`'s family (including `unit` itself, using
 * its canonical name). Returns an empty array if the unit is unknown.
 */
export function getCompatibleUnits(unit: string): string[] {
  const found = lookup(unit);
  if (!found) return [];
  return found.family.units.map(u => u.name);
}

/** True if both units belong to the same family. */
export function canConvert(from: string, to: string): boolean {
  const a = lookup(from);
  const b = lookup(to);
  return !!a && !!b && a.family === b.family;
}

/**
 * Convert `value` from one unit to another. Returns the input unchanged if
 * either unit is unknown or they're in different families.
 */
export function convert(value: number, from: string, to: string): number {
  if (!Number.isFinite(value)) return value;
  const a = lookup(from);
  const b = lookup(to);
  if (!a || !b || a.family !== b.family) return value;
  if (a.def === b.def) return value;

  const base = a.def.toBaseFn ? a.def.toBaseFn(value) : value * (a.def.toBase ?? 1);
  return b.def.fromBaseFn ? b.def.fromBaseFn(base) : base / (b.def.toBase ?? 1);
}

/**
 * Resolve a unit string back to its canonical name within the family
 * (e.g. "c" → "°C"). Returns the input if no match.
 */
export function canonicalUnit(unit: string): string {
  return lookup(unit)?.def.name ?? unit;
}
