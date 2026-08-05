/**
 * Rust single-file generator. Mirrors canfd_codec/codegen/rust_gen.py.
 */

import type { DeviceConfig, Message, Signal } from '../types';
import {
  sanitizeRust, toSnakeCase, toPascalCase, toUpperSnake,
  signalMaxRawDec, isEnum, isBitfield, isSigned, isIdentityInteger,
  physicalFieldTypeRust, resolveDefaultPhysical, resolveDefaultRawHex,
  userSignals, totalPayloadBytes, fmtFloat,
} from './common';


function runtimeHelpers(): string {
  return String.raw`
mod detail {
    #[inline]
    pub fn ext_le(data: &[u8], start: usize, length: usize) -> u64 {
        let mut v: u64 = 0;
        for i in 0..length {
            let bi = (start + i) >> 3;
            if bi < data.len() && (data[bi] & (1u8 << ((start + i) & 7))) != 0 {
                v |= 1u64 << i;
            }
        }
        v
    }

    #[inline]
    pub fn ext_be(data: &[u8], start: usize, length: usize) -> u64 {
        let mut v: u64 = 0;
        for i in 0..length {
            let bp = start + i;
            let bi = bp >> 3;
            if bi < data.len() && (data[bi] & (1u8 << (7 - (bp & 7)))) != 0 {
                v |= 1u64 << (length - 1 - i);
            }
        }
        v
    }

    #[inline]
    pub fn pack_le(data: &mut [u8], start: usize, length: usize, value: u64) {
        for i in 0..length {
            let bi = (start + i) >> 3;
            if bi >= data.len() { break; }
            let b = (start + i) & 7;
            if (value & (1u64 << i)) != 0 { data[bi] |=  1u8 << b; }
            else                          { data[bi] &= !(1u8 << b); }
        }
    }

    #[inline]
    pub fn pack_be(data: &mut [u8], start: usize, length: usize, value: u64) {
        for i in 0..length {
            let bp = start + i;
            let bi = bp >> 3;
            if bi >= data.len() { break; }
            let b = 7 - (bp & 7);
            if (value & (1u64 << (length - 1 - i))) != 0 { data[bi] |=  1u8 << b; }
            else                                         { data[bi] &= !(1u8 << b); }
        }
    }

    #[inline]
    pub fn sign_extend(raw: u64, length: usize) -> i64 {
        if length >= 64 { return raw as i64; }
        let sign = 1u64 << (length - 1);
        if (raw & sign) != 0 {
            (raw | (!0u64 << length)) as i64
        } else {
            raw as i64
        }
    }

    #[inline]
    pub fn f32_to_u32(v: f32) -> u32 { v.to_bits() }
    #[inline]
    pub fn u32_to_f32(r: u32) -> f32 { f32::from_bits(r) }
    #[inline]
    pub fn f64_to_u64(v: f64) -> u64 { v.to_bits() }
    #[inline]
    pub fn u64_to_f64(r: u64) -> f64 { f64::from_bits(r) }

    #[inline]
    pub fn clamp_u(raw: i64, length: usize) -> u64 {
        let maxv: i64 = if length >= 64 { i64::MAX } else { ((1u64 << length) - 1) as i64 };
        if raw < 0 { 0 } else if raw > maxv { maxv as u64 } else { raw as u64 }
    }

    #[inline]
    pub fn phys_to_raw_signed(v: f64, scale: f64, offset: f64, length: usize) -> u64 {
        let r = if scale != 0.0 { (v - offset) / scale } else { 0.0 };
        let mut raw = r as i64;
        if raw < 0 { raw += 1i64 << length; }
        clamp_u(raw, length)
    }

    #[inline]
    pub fn phys_to_raw_unsigned(v: f64, scale: f64, offset: f64, length: usize) -> u64 {
        let r = if scale != 0.0 { (v - offset) / scale } else { 0.0 };
        clamp_u(r as i64, length)
    }

    #[inline]
    pub fn raw_to_phys_signed(raw: u64, scale: f64, offset: f64, length: usize) -> f64 {
        sign_extend(raw, length) as f64 * scale + offset
    }

    #[inline]
    pub fn raw_to_phys_unsigned(raw: u64, scale: f64, offset: f64) -> f64 {
        raw as f64 * scale + offset
    }
}
`;
}


function emitEnumMod(sig: Signal, msg: Message, lines: string[]) {
  const modName = `${toSnakeCase(msg.name)}_${toSnakeCase(sig.name)}`;
  lines.push(`/// Enum constants for \`${msg.name}.${sig.name}\`.`);
  lines.push(`pub mod ${modName} {`);
  const entries = Object.entries(sig.enum_map).map(([k, v]) => [Number(k), v] as [number, string]);
  entries.sort((a, b) => a[0] - b[0]);
  for (const [raw, name] of entries) {
    let constName = toUpperSnake(name);
    if (/^\d/.test(constName)) constName = '_' + constName;
    lines.push(`    pub const ${constName}: u32 = ${raw};`);
  }
  lines.push('}');
  lines.push('');
}


function emitBitfieldMod(sig: Signal, msg: Message, lines: string[]) {
  const modName = `${toSnakeCase(msg.name)}_${toSnakeCase(sig.name)}_flags`;
  lines.push(`/// Bit flags for \`${msg.name}.${sig.name}\`.`);
  lines.push(`pub mod ${modName} {`);
  const entries = Object.entries(sig.bitfield_map).map(([k, v]) => [Number(k), v] as [number, string]);
  entries.sort((a, b) => a[0] - b[0]);
  for (const [bit, name] of entries) {
    let constName = toUpperSnake(name);
    if (/^\d/.test(constName)) constName = '_' + constName;
    lines.push(`    pub const ${constName}: u32 = 1u32 << ${bit};`);
  }
  lines.push('}');
  lines.push('');
}


function physToRawCall(sig: Signal, variable: string): string {
  if (isBitfield(sig) || isEnum(sig)) {
    return `(${variable} as u64) & ${signalMaxRawDec(sig)}u64`;
  }
  if (sig.value_type === 'float32') return `detail::f32_to_u32(${variable} as f32) as u64`;
  if (sig.value_type === 'float64') return `detail::f64_to_u64(${variable} as f64)`;
  if (isIdentityInteger(sig)) return `(${variable} as u64) & ${signalMaxRawDec(sig)}u64`;
  const fn = isSigned(sig) ? 'detail::phys_to_raw_signed' : 'detail::phys_to_raw_unsigned';
  return `${fn}(${variable} as f64, ${fmtFloat(sig.scale)}f64, ${fmtFloat(sig.offset)}f64, ${sig.bit_length})`;
}


function rawToPhysCall(sig: Signal, rawVar: string): string {
  if (isBitfield(sig) || isEnum(sig)) return rawVar;
  if (sig.value_type === 'float32') return `detail::u32_to_f32(${rawVar} as u32)`;
  if (sig.value_type === 'float64') return `detail::u64_to_f64(${rawVar})`;
  if (isIdentityInteger(sig)) return isSigned(sig) ? `detail::sign_extend(${rawVar}, ${sig.bit_length})` : rawVar;
  if (isSigned(sig)) {
    return `detail::raw_to_phys_signed(${rawVar}, ${fmtFloat(sig.scale)}f64, ${fmtFloat(sig.offset)}f64, ${sig.bit_length})`;
  }
  return `detail::raw_to_phys_unsigned(${rawVar}, ${fmtFloat(sig.scale)}f64, ${fmtFloat(sig.offset)}f64)`;
}


function emitStruct(msg: Message, lines: string[]) {
  const name = toPascalCase(msg.name);
  const byteCount = totalPayloadBytes(msg);
  const fields = userSignals(msg);
  const isMulti = msg.node_count > 1;
  const hasBroadcast = msg.broadcast_node_id !== null && msg.broadcast_node_id !== undefined;

  const desc = (msg.description || '').trim().replace(/\n/g, ' ');
  if (desc) lines.push(`/// ${desc}`);
  lines.push(`/// CAN id = 0x${msg.id.toString(16).toUpperCase()}, dlc = ${msg.dlc}`);
  lines.push('#[derive(Debug, Clone, Copy, PartialEq)]');
  lines.push(`pub struct ${name} {`);
  for (const sig of fields) {
    const ftype = physicalFieldTypeRust(sig);
    const unit = sig.unit ? `  // ${sig.unit}` : '';
    const fname = sanitizeRust(sig.name);
    lines.push(`    pub ${fname}: ${ftype},${unit}`);
  }
  if (isMulti) lines.push('    pub node_id: u32,');
  lines.push('}');
  lines.push('');

  // Default
  lines.push(`impl Default for ${name} {`);
  lines.push('    fn default() -> Self {');
  lines.push('        Self {');
  for (const sig of fields) {
    const ftype = physicalFieldTypeRust(sig);
    const fname = sanitizeRust(sig.name);
    const d = resolveDefaultPhysical(sig);
    let def: string;
    if (d === null) def = ftype.startsWith('f') ? '0.0' : '0';
    else if (ftype.startsWith('f')) def = `${fmtFloat(d)}${ftype}`;
    else def = Math.trunc(d).toString();
    lines.push(`            ${fname}: ${def},`);
  }
  if (isMulti) lines.push(`            node_id: ${msg.node_id_start},`);
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  lines.push('');

  lines.push(`impl ${name} {`);
  lines.push(`    pub const BASE_ID: u32 = 0x${msg.id.toString(16).toUpperCase()};`);
  lines.push(`    pub const DLC: usize = ${msg.dlc};`);
  lines.push(`    pub const PAYLOAD_BYTES: usize = ${byteCount};`);
  lines.push(`    pub const NODE_COUNT: u32 = ${msg.node_count};`);
  lines.push(`    pub const NODE_ID_OFFSET: u32 = ${msg.node_id_offset};`);
  lines.push(`    pub const NODE_ID_START: u32 = ${msg.node_id_start};`);
  if (msg.crc_extra !== undefined) {
    lines.push(`    pub const CRC_EXTRA: u8 = ${msg.crc_extra};`);
  }
  if (hasBroadcast) {
    lines.push(`    pub const BROADCAST_NODE_ID: u32 = 0x${(msg.broadcast_node_id as number).toString(16).toUpperCase()};`);
    lines.push(`    pub const BROADCAST_BYTES: usize = ${byteCount * msg.node_count};`);
  }
  lines.push('');

  lines.push('    #[inline]');
  lines.push('    pub const fn id_for_node(nid: u32) -> u32 {');
  if (isMulti) lines.push('        Self::BASE_ID + nid * Self::NODE_ID_OFFSET');
  else {
    lines.push('        let _ = nid;');
    lines.push('        Self::BASE_ID');
  }
  lines.push('    }');
  lines.push('');

  lines.push('    pub fn node_for_id(can_id: u32) -> Option<u32> {');
  if (!isMulti) {
    lines.push('        if can_id == Self::BASE_ID { Some(Self::NODE_ID_START) } else { None }');
  } else {
    lines.push('        let off = can_id as i64 - Self::BASE_ID as i64;');
    lines.push('        if Self::NODE_ID_OFFSET == 0 {');
    lines.push('            return if off == 0 { Some(Self::NODE_ID_START) } else { None };');
    lines.push('        }');
    lines.push('        if off % Self::NODE_ID_OFFSET as i64 != 0 { return None; }');
    lines.push('        let nid = off / Self::NODE_ID_OFFSET as i64;');
    if (hasBroadcast) {
      lines.push('        if nid as u32 == Self::BROADCAST_NODE_ID { return Some(nid as u32); }');
    }
    lines.push('        let max = (Self::NODE_ID_START + Self::NODE_COUNT - 1) as i64;');
    lines.push('        if nid >= Self::NODE_ID_START as i64 && nid <= max {');
    lines.push('            Some(nid as u32)');
    lines.push('        } else {');
    lines.push('            None');
    lines.push('        }');
  }
  lines.push('    }');
  lines.push('');

  // encode
  lines.push(`    pub fn encode(&self) -> [u8; ${byteCount}] {`);
  lines.push(`        let mut data = [0u8; ${byteCount}];`);
  for (const sig of msg.signals) {
    if (sig.constant) {
      const raw = resolveDefaultRawHex(sig);
      const pack = sig.byte_order === 'big_endian' ? 'detail::pack_be' : 'detail::pack_le';
      lines.push(`        // constant: ${sig.name}`);
      lines.push(`        ${pack}(&mut data, ${sig.start_bit}, ${sig.bit_length}, ${raw}u64);`);
    } else {
      const variable = `self.${sanitizeRust(sig.name)}`;
      const raw = physToRawCall(sig, variable);
      const pack = sig.byte_order === 'big_endian' ? 'detail::pack_be' : 'detail::pack_le';
      lines.push(`        { let r = ${raw};`);
      lines.push(`          ${pack}(&mut data, ${sig.start_bit}, ${sig.bit_length}, r); }`);
    }
  }
  lines.push('        data');
  lines.push('    }');
  lines.push('');

  // decode
  lines.push('    pub fn decode(data: &[u8]) -> Option<Self> {');
  lines.push(`        if data.len() < ${byteCount} { return None; }`);
  const nonConst = msg.signals.filter((s) => !s.constant);
  const mutKw = nonConst.length > 0 ? 'mut ' : '';
  lines.push(`        let ${mutKw}m = Self::default();`);
  for (const sig of msg.signals) {
    if (sig.constant) continue;
    const fname = sanitizeRust(sig.name);
    const ext = sig.byte_order === 'big_endian' ? 'detail::ext_be' : 'detail::ext_le';
    const ftype = physicalFieldTypeRust(sig);
    const val = rawToPhysCall(sig, 'r');
    lines.push(`        { let r = ${ext}(data, ${sig.start_bit}, ${sig.bit_length});`);
    lines.push(`          m.${fname} = (${val}) as ${ftype}; }`);
  }
  lines.push('        Some(m)');
  lines.push('    }');
  lines.push('');

  if (hasBroadcast) {
    const n = msg.node_count;
    const total = n * byteCount;
    lines.push('    pub const fn broadcast_id() -> u32 {');
    lines.push('        Self::BASE_ID + Self::BROADCAST_NODE_ID * Self::NODE_ID_OFFSET');
    lines.push('    }');
    lines.push('');
    lines.push(`    pub fn encode_broadcast(nodes: &[Self; ${n}]) -> [u8; ${total}] {`);
    lines.push(`        let mut data = [0u8; ${total}];`);
    lines.push(`        for i in 0..${n} {`);
    lines.push('            let p = nodes[i].encode();');
    lines.push(`            data[i*${byteCount}..(i+1)*${byteCount}].copy_from_slice(&p);`);
    lines.push('        }');
    lines.push('        data');
    lines.push('    }');
    lines.push('');
    lines.push(`    pub fn decode_broadcast(data: &[u8]) -> Option<[Self; ${n}]> {`);
    lines.push(`        if data.len() < ${total} { return None; }`);
    lines.push(`        let mut out = [Self::default(); ${n}];`);
    lines.push(`        for i in 0..${n} {`);
    const broadcastMutKw = isMulti ? 'mut ' : '';
    lines.push(`            let ${broadcastMutKw}m = Self::decode(&data[i*${byteCount}..(i+1)*${byteCount}])?;`);
    if (isMulti) lines.push('            m.node_id = Self::NODE_ID_START + i as u32;');
    lines.push('            out[i] = m;');
    lines.push('        }');
    lines.push('        Some(out)');
    lines.push('    }');
    lines.push('');
  }
  lines.push('}');
  lines.push('');
}


function emitFrameEnum(device: DeviceConfig, lines: string[]) {
  lines.push('/// Decoded frame from any known message of this device.');
  lines.push('#[derive(Debug, Clone)]');
  lines.push('pub enum Frame {');
  for (const msg of device.messages) {
    const name = toPascalCase(msg.name);
    lines.push(`    ${name}(${name}),`);
    if (msg.broadcast_node_id !== null && msg.broadcast_node_id !== undefined) {
      lines.push(`    ${name}Broadcast([${name}; ${msg.node_count}]),`);
    }
  }
  lines.push('}');
  lines.push('');
  lines.push('/// Dispatch a CAN frame to the correct message decoder.');
  lines.push('pub fn decode_frame(can_id: u32, data: &[u8]) -> Option<Frame> {');
  for (const msg of device.messages) {
    const name = toPascalCase(msg.name);
    lines.push(`    if let Some(nid) = ${name}::node_for_id(can_id) {`);
    if (msg.broadcast_node_id !== null && msg.broadcast_node_id !== undefined) {
      lines.push(`        if nid == ${name}::BROADCAST_NODE_ID {`);
      lines.push(`            if let Some(arr) = ${name}::decode_broadcast(data) {`);
      lines.push(`                return Some(Frame::${name}Broadcast(arr));`);
      lines.push('            }');
      lines.push('        }');
    }
    if (msg.node_count > 1) {
      lines.push(`        if let Some(mut m) = ${name}::decode(data) {`);
      lines.push('            m.node_id = nid;');
    } else {
      lines.push(`        if let Some(m) = ${name}::decode(data) {`);
      lines.push('            let _ = nid;');
    }
    lines.push(`            return Some(Frame::${name}(m));`);
    lines.push('        }');
    lines.push('    }');
  }
  lines.push('    None');
  lines.push('}');
  lines.push('');
}


export function generateRust(device: DeviceConfig): string {
  const L: string[] = [];
  L.push(`//! Auto-generated CAN/CAN-FD codec for device: ${device.name}`);
  if (device.description) {
    L.push('//!');
    for (const line of device.description.split('\n')) L.push(`//! ${line}`);
  }
  L.push('//!');
  L.push('//! Generated by canfd-codec. DO NOT EDIT BY HAND.');
  L.push('//! Regenerate with: `canfd-codec -c <config> genlib --lang rust`.');
  L.push('');
  L.push('#![allow(dead_code, non_snake_case, non_camel_case_types, clippy::all)]');
  L.push('');
  L.push(`pub const DEVICE_NAME: &str = "${device.name}";`);
  if (!device.mavlink) {
    L.push(`pub const DEVICE_FD: bool = ${device.fd ? 'true' : 'false'};`);
    if (device.bitrate !== undefined) {
      L.push(`pub const DEVICE_BITRATE: u32 = ${device.bitrate};`);
    }
    if (device.fd && device.data_bitrate !== undefined) {
      L.push(`pub const DEVICE_DATA_BITRATE: u32 = ${device.data_bitrate};`);
    }
  }
  L.push('');
  L.push(runtimeHelpers());
  L.push('');
  L.push('// ===== Enum / bitfield constants =====');
  for (const msg of device.messages) {
    for (const sig of msg.signals) {
      if (isEnum(sig)) emitEnumMod(sig, msg, L);
      else if (isBitfield(sig)) emitBitfieldMod(sig, msg, L);
    }
  }
  L.push('');
  L.push('// ===== Message types =====');
  for (const msg of device.messages) emitStruct(msg, L);
  L.push('// ===== Top-level dispatch =====');
  emitFrameEnum(device, L);
  return L.join('\n');
}
