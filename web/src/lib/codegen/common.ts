/**
 * Shared helpers for the codegen module. Mirrors canfd_codec/codegen/common.py
 * — the algorithms must stay byte-for-byte identical between the CLI and the
 * web UI.
 */

import type { Signal, Message } from '../types';

// ---------------------------------------------------------------------------
// DLC -> byte count (CAN FD)
// ---------------------------------------------------------------------------
export function dlcToBytes(dlc: number): number {
  if (dlc <= 8) return dlc;
  const map: Record<number, number> = { 12: 12, 16: 16, 20: 20, 24: 24, 32: 32, 48: 48, 64: 64 };
  return map[dlc] ?? dlc;
}

export function totalPayloadBytes(msg: Message): number {
  return dlcToBytes(msg.dlc);
}

// ---------------------------------------------------------------------------
// Identifier sanitization
// ---------------------------------------------------------------------------
const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g;

export function sanitizeC(name: string): string {
  let s = name.trim().replace(/[^a-zA-Z0-9_]/g, '_');
  if (!s) return '_';
  if (/^\d/.test(s)) s = '_' + s;
  return s;
}

const RUST_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
  'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop',
  'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static',
  'struct', 'super', 'trait', 'true', 'type', 'union', 'unsafe', 'use', 'where',
  'while', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv',
  'typeof', 'unsized', 'virtual', 'yield', 'try', 'gen',
]);
const RUST_NON_RAW_IDENTIFIERS = new Set(['crate', 'self', 'Self', 'super']);

export function sanitizeRust(name: string): string {
  const s = sanitizeC(name);
  if (RUST_NON_RAW_IDENTIFIERS.has(s)) return '_' + s;
  return RUST_KEYWORDS.has(s) ? `r#${s}` : s;
}

export function toSnakeCase(name: string): string {
  let s = sanitizeC(name);
  s = s.replace(CAMEL_BOUNDARY, '_');
  s = s.replace(/_+/g, '_').replace(/^_|_$/g, '');
  return s ? s.toLowerCase() : '_';
}

export function toPascalCase(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]/);
  const out: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    const sub = p.replace(CAMEL_BOUNDARY, ' ').split(/\s+/);
    for (const s of sub) {
      if (s) out.push(s[0].toUpperCase() + s.slice(1).toLowerCase());
    }
  }
  let result = out.join('');
  if (!result) return 'Unnamed';
  if (/^\d/.test(result)) result = 'M' + result;
  return result;
}

export function toUpperSnake(name: string): string {
  return toSnakeCase(name).toUpperCase();
}

// ---------------------------------------------------------------------------
// Signal type analysis
// ---------------------------------------------------------------------------
/** As a hex string for emission into target source. Handles 64-bit cleanly. */
export function signalMaxRawHex(sig: Signal): string {
  if (sig.bit_length >= 64) return '0xFFFFFFFFFFFFFFFF';
  const mask = (1n << BigInt(sig.bit_length)) - 1n;
  return '0x' + mask.toString(16).toUpperCase();
}

/** As a decimal string. Used for emission in language sources that the Python
 *  CLI generator emits with decimal literals (parity). */
export function signalMaxRawDec(sig: Signal): string {
  if (sig.bit_length >= 64) return '18446744073709551615';
  const mask = (1n << BigInt(sig.bit_length)) - 1n;
  return mask.toString();
}

export function fittingUintBits(bitLength: number): number {
  for (const w of [8, 16, 32, 64]) if (bitLength <= w) return w;
  throw new Error(`bit_length ${bitLength} too large for stdint type`);
}

export function cUintType(bitLength: number): string {
  return `uint${fittingUintBits(bitLength)}_t`;
}

export function cIntType(bitLength: number): string {
  return `int${fittingUintBits(bitLength)}_t`;
}

export function rustUintType(bitLength: number): string {
  return `u${fittingUintBits(bitLength)}`;
}

export function rustIntType(bitLength: number): string {
  return `i${fittingUintBits(bitLength)}`;
}

export function isFloat(sig: Signal): boolean {
  return sig.value_type === 'float32' || sig.value_type === 'float64';
}

export function isSigned(sig: Signal): boolean {
  return sig.value_type === 'signed';
}

export function isEnum(sig: Signal): boolean {
  return !!sig.enum_map && Object.keys(sig.enum_map).length > 0;
}

export function isBitfield(sig: Signal): boolean {
  return !!sig.bitfield_map && Object.keys(sig.bitfield_map).length > 0;
}

export function isIdentityInteger(sig: Signal): boolean {
  return sig.value_type !== 'float32'
    && sig.value_type !== 'float64'
    && sig.scale === 1
    && sig.offset === 0
    && !sig.unit;
}

export function physicalFieldTypeC(sig: Signal): string {
  if (isBitfield(sig) || isEnum(sig)) return cUintType(sig.bit_length);
  if (sig.value_type === 'float32') return 'float';
  if (sig.value_type === 'float64') return 'double';
  if (sig.scale !== 1.0 || sig.offset !== 0.0 || sig.unit) return 'double';
  return isSigned(sig) ? cIntType(sig.bit_length) : cUintType(sig.bit_length);
}

export function physicalFieldTypeRust(sig: Signal): string {
  if (isBitfield(sig) || isEnum(sig)) return rustUintType(sig.bit_length);
  if (sig.value_type === 'float32') return 'f32';
  if (sig.value_type === 'float64') return 'f64';
  if (sig.scale !== 1.0 || sig.offset !== 0.0 || sig.unit) return 'f64';
  return isSigned(sig) ? rustIntType(sig.bit_length) : rustUintType(sig.bit_length);
}

export function physicalFieldTypePy(sig: Signal): string {
  if (isBitfield(sig) || isEnum(sig)) return 'int';
  if (isFloat(sig)) return 'float';
  if (sig.scale !== 1.0 || sig.offset !== 0.0) return 'float';
  return 'int';
}

// ---------------------------------------------------------------------------
// Default value resolution
// ---------------------------------------------------------------------------
function f32ToU32(v: number): number {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = v;
  return new Uint32Array(buf)[0];
}

function f64ToU64Bigint(v: number): bigint {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = v;
  return new BigUint64Array(buf)[0];
}

/** Resolve a signal's default value as a decimal string for emission as a
 *  literal `<raw>ull`/`<raw>u64`/etc. into the target language. Mirrors the
 *  Python CLI generator which uses `f"{raw}"` (decimal). */
export function resolveDefaultRawHex(sig: Signal): string {
  return resolveDefaultRawBigInt(sig).toString();
}

function resolveDefaultRawBigInt(sig: Signal): bigint {
  const val = sig.default_value;
  if (val === null || val === undefined) return 0n;

  if (isBitfield(sig) && typeof val === 'object') {
    let raw = 0n;
    const rev: Record<string, number> = {};
    for (const [b, name] of Object.entries(sig.bitfield_map)) {
      rev[name.toLowerCase()] = Number(b);
    }
    for (const [n, on] of Object.entries(val as Record<string, unknown>)) {
      const b = rev[n.toLowerCase()];
      if (b !== undefined && on) raw |= 1n << BigInt(b);
    }
    return raw;
  }

  if (isEnum(sig) && typeof val === 'string') {
    for (const [k, v] of Object.entries(sig.enum_map)) {
      if (v.toLowerCase() === val.toLowerCase()) return BigInt(k);
    }
    return 0n;
  }

  const fval = Number(val);
  if (!Number.isFinite(fval)) return 0n;

  if (sig.value_type === 'float32') {
    return BigInt(f32ToU32(fval));
  }
  if (sig.value_type === 'float64') {
    return f64ToU64Bigint(fval);
  }

  const scale = sig.scale || 1.0;
  let raw = BigInt(Math.trunc((fval - sig.offset) / scale));
  if (isSigned(sig) && raw < 0n) raw += 1n << BigInt(sig.bit_length);
  const maxBig = (1n << BigInt(sig.bit_length)) - 1n;
  if (raw < 0n) raw = 0n;
  else if (raw > maxBig) raw = maxBig;
  return raw;
}

export function resolveDefaultPhysical(sig: Signal): number | null {
  if (sig.default_value === null || sig.default_value === undefined) return null;
  if (isBitfield(sig) || isEnum(sig)) {
    const hex = resolveDefaultRawHex(sig);
    return parseInt(hex, 16);
  }
  const fval = Number(sig.default_value);
  return Number.isFinite(fval) ? fval : null;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------
export function userSignals(msg: Message): Signal[] {
  return msg.signals.filter((s) => !s.constant);
}

// ---------------------------------------------------------------------------
// Number formatting for source code emission
// ---------------------------------------------------------------------------
/** Format a JS number as a decimal/float literal acceptable in the target. */
export function fmtFloat(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  if (Number.isInteger(v)) return v.toFixed(1); // e.g. 12 -> "12.0"
  // toString gives a round-trip representation in JS, which is suitable for
  // python/c/cpp/rust float literals.
  return v.toString();
}

export function fmtInt(v: number): string {
  return Math.trunc(v).toString();
}

/** Quote a string the way Python's `repr()` does — single quotes by default,
 *  double quotes if the string contains single quotes but not doubles. */
export function pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  if (hasSingle && !hasDouble) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/** Mimic Python's repr() for arbitrary JSON-compatible values. */
export function pyReprAny(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return "float('nan')";
    if (!Number.isFinite(v)) return v > 0 ? "float('inf')" : "float('-inf')";
    return Number.isInteger(v) ? v.toString() : v.toString();
  }
  if (typeof v === 'string') return pyRepr(v);
  // Fallback for arrays/objects (rare in our generators)
  return pyRepr(String(v));
}
