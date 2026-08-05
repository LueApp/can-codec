/**
 * C++17 header-only generator. Mirrors canfd_codec/codegen/cpp_gen.py.
 */

import type { DeviceConfig, Message, Signal } from '../types';
import {
  sanitizeC, toSnakeCase, toPascalCase, toUpperSnake,
  signalMaxRawDec, isEnum, isBitfield, isSigned, isIdentityInteger,
  physicalFieldTypeC, resolveDefaultPhysical, resolveDefaultRawHex,
  userSignals, totalPayloadBytes, fmtFloat, pyReprAny,
} from './common';


function deviceNs(device: DeviceConfig): string {
  return toSnakeCase(device.name) || 'device';
}


function runtimeHelpers(): string {
  return String.raw`
namespace detail {

inline uint64_t ext_le(const uint8_t* d, std::size_t len, int start, int length) {
    uint64_t v = 0;
    for (int i = 0; i < length; ++i) {
        int bi = (start + i) >> 3;
        if (static_cast<std::size_t>(bi) < len && (d[bi] & (1u << ((start + i) & 7))))
            v |= (uint64_t)1 << i;
    }
    return v;
}

inline uint64_t ext_be(const uint8_t* d, std::size_t len, int start, int length) {
    uint64_t v = 0;
    for (int i = 0; i < length; ++i) {
        int bp = start + i;
        int bi = bp >> 3;
        if (static_cast<std::size_t>(bi) < len && (d[bi] & (1u << (7 - (bp & 7)))))
            v |= (uint64_t)1 << (length - 1 - i);
    }
    return v;
}

inline void pack_le(uint8_t* d, std::size_t len, int start, int length, uint64_t value) {
    for (int i = 0; i < length; ++i) {
        int bi = (start + i) >> 3;
        if (static_cast<std::size_t>(bi) >= len) break;
        int b = (start + i) & 7;
        if (value & ((uint64_t)1 << i)) d[bi] |=  static_cast<uint8_t>(1u << b);
        else                            d[bi] &= static_cast<uint8_t>(~(1u << b));
    }
}

inline void pack_be(uint8_t* d, std::size_t len, int start, int length, uint64_t value) {
    for (int i = 0; i < length; ++i) {
        int bp = start + i;
        int bi = bp >> 3;
        if (static_cast<std::size_t>(bi) >= len) break;
        int b = 7 - (bp & 7);
        if (value & ((uint64_t)1 << (length - 1 - i))) d[bi] |=  static_cast<uint8_t>(1u << b);
        else                                           d[bi] &= static_cast<uint8_t>(~(1u << b));
    }
}

inline int64_t sign_extend(uint64_t raw, int length) {
    if (length >= 64) return static_cast<int64_t>(raw);
    uint64_t sign = (uint64_t)1 << (length - 1);
    if (raw & sign) return static_cast<int64_t>(raw | (~(uint64_t)0 << length));
    return static_cast<int64_t>(raw);
}

inline uint32_t f32_to_u32(float v) { uint32_t o; std::memcpy(&o, &v, 4); return o; }
inline float    u32_to_f32(uint32_t r) { float o; std::memcpy(&o, &r, 4); return o; }
inline uint64_t f64_to_u64(double v) { uint64_t o; std::memcpy(&o, &v, 8); return o; }
inline double   u64_to_f64(uint64_t r) { double o; std::memcpy(&o, &r, 8); return o; }

inline uint64_t clamp_u(int64_t raw, int length) {
    int64_t maxv = (length >= 64) ? static_cast<int64_t>(static_cast<uint64_t>(~0ULL))
                                  : static_cast<int64_t>(((uint64_t)1 << length) - 1);
    if (raw < 0) return 0;
    if (raw > maxv) return static_cast<uint64_t>(maxv);
    return static_cast<uint64_t>(raw);
}

inline uint64_t phys_to_raw_signed(double v, double scale, double offset, int length) {
    double r = (scale != 0) ? (v - offset) / scale : 0;
    int64_t raw = static_cast<int64_t>(r);
    if (raw < 0) raw += static_cast<int64_t>(1) << length;
    return clamp_u(raw, length);
}

inline uint64_t phys_to_raw_unsigned(double v, double scale, double offset, int length) {
    double r = (scale != 0) ? (v - offset) / scale : 0;
    return clamp_u(static_cast<int64_t>(r), length);
}

inline double raw_to_phys_signed(uint64_t raw, double scale, double offset, int length) {
    return static_cast<double>(sign_extend(raw, length)) * scale + offset;
}

inline double raw_to_phys_unsigned(uint64_t raw, double scale, double offset) {
    return static_cast<double>(raw) * scale + offset;
}

}  // namespace detail
`;
}


function emitEnum(sig: Signal, msg: Message, lines: string[]) {
  lines.push(`namespace ${toSnakeCase(msg.name)}_enums {`);
  lines.push(`// Enum constants for ${msg.name}.${sig.name}`);
  const entries = Object.entries(sig.enum_map).map(([k, v]) => [Number(k), v] as [number, string]);
  entries.sort((a, b) => a[0] - b[0]);
  for (const [raw, name] of entries) {
    let constName = toUpperSnake(name);
    if (/^\d/.test(constName)) constName = '_' + constName;
    lines.push(`inline constexpr uint32_t ${toSnakeCase(sig.name)}_${constName} = ${raw}u;`);
  }
  lines.push('}');
  lines.push('');
}


function emitBitfield(sig: Signal, msg: Message, lines: string[]) {
  lines.push(`namespace ${toSnakeCase(msg.name)}_flags {`);
  lines.push(`// Bitfield flags for ${msg.name}.${sig.name}`);
  const entries = Object.entries(sig.bitfield_map).map(([k, v]) => [Number(k), v] as [number, string]);
  entries.sort((a, b) => a[0] - b[0]);
  for (const [bit, name] of entries) {
    let constName = toUpperSnake(name);
    if (/^\d/.test(constName)) constName = '_' + constName;
    lines.push(`inline constexpr uint32_t ${toSnakeCase(sig.name)}_${constName} = 1u << ${bit};`);
  }
  lines.push('}');
  lines.push('');
}


function physToRawCall(sig: Signal, variable: string): string {
  if (isBitfield(sig) || isEnum(sig)) {
    return `(static_cast<uint64_t>(${variable}) & ${signalMaxRawDec(sig)}ull)`;
  }
  if (sig.value_type === 'float32') return `static_cast<uint64_t>(detail::f32_to_u32(static_cast<float>(${variable})))`;
  if (sig.value_type === 'float64') return `detail::f64_to_u64(static_cast<double>(${variable}))`;
  if (isIdentityInteger(sig)) return `(static_cast<uint64_t>(${variable}) & ${signalMaxRawDec(sig)}ull)`;
  const fn = isSigned(sig) ? 'detail::phys_to_raw_signed' : 'detail::phys_to_raw_unsigned';
  return `${fn}(static_cast<double>(${variable}), ${fmtFloat(sig.scale)}, ${fmtFloat(sig.offset)}, ${sig.bit_length})`;
}


function rawToPhysCall(sig: Signal, rawVar: string): string {
  if (isBitfield(sig) || isEnum(sig)) return rawVar;
  if (sig.value_type === 'float32') return `detail::u32_to_f32(static_cast<uint32_t>(${rawVar}))`;
  if (sig.value_type === 'float64') return `detail::u64_to_f64(${rawVar})`;
  if (isIdentityInteger(sig)) return isSigned(sig) ? `detail::sign_extend(${rawVar}, ${sig.bit_length})` : rawVar;
  if (isSigned(sig)) {
    return `detail::raw_to_phys_signed(${rawVar}, ${fmtFloat(sig.scale)}, ${fmtFloat(sig.offset)}, ${sig.bit_length})`;
  }
  return `detail::raw_to_phys_unsigned(${rawVar}, ${fmtFloat(sig.scale)}, ${fmtFloat(sig.offset)})`;
}


function emitStruct(msg: Message, lines: string[]) {
  const cls = toPascalCase(msg.name);
  const byteCount = totalPayloadBytes(msg);
  const fields = userSignals(msg);
  const isMulti = msg.node_count > 1;
  const hasBroadcast = msg.broadcast_node_id !== null && msg.broadcast_node_id !== undefined;

  const desc = (msg.description || '').trim().replace(/\n/g, ' ');
  lines.push(`// ---- ${msg.name} (id=0x${msg.id.toString(16).toUpperCase()}, dlc=${msg.dlc}) ----`);
  if (desc) lines.push(`// ${desc}`);
  lines.push(`struct ${cls} {`);
  lines.push(`    static constexpr uint32_t BASE_ID = 0x${msg.id.toString(16).toUpperCase()}u;`);
  lines.push(`    static constexpr std::size_t DLC = ${msg.dlc};`);
  lines.push(`    static constexpr std::size_t PAYLOAD_BYTES = ${byteCount};`);
  lines.push(`    static constexpr uint32_t NODE_COUNT = ${msg.node_count}u;`);
  lines.push(`    static constexpr uint32_t NODE_ID_OFFSET = ${msg.node_id_offset}u;`);
  lines.push(`    static constexpr uint32_t NODE_ID_START = ${msg.node_id_start}u;`);
  if (msg.crc_extra !== undefined) {
    lines.push(`    static constexpr uint8_t CRC_EXTRA = ${msg.crc_extra}u;`);
  }
  if (hasBroadcast) {
    lines.push(`    static constexpr uint32_t BROADCAST_NODE_ID = 0x${(msg.broadcast_node_id as number).toString(16).toUpperCase()}u;`);
  }
  lines.push('');

  for (const sig of fields) {
    const ftype = physicalFieldTypeC(sig);
    const name = sanitizeC(sig.name);
    const d = resolveDefaultPhysical(sig);
    let def: string;
    if (d === null) def = '{}';
    else if (ftype === 'float' || ftype === 'double') def = `{ ${fmtFloat(d)} }`;
    else def = `{ ${Math.trunc(d)} }`;
    const unit = sig.unit ? `  // ${sig.unit}` : '';
    lines.push(`    ${ftype} ${name}${def};${unit}`);
  }
  if (isMulti) {
    lines.push(`    uint32_t node_id{ ${msg.node_id_start} };  // source node for decoded frames`);
  }
  lines.push('');

  lines.push('    static constexpr uint32_t id_for_node(uint32_t nid) noexcept {');
  if (isMulti) lines.push('        return BASE_ID + nid * NODE_ID_OFFSET;');
  else lines.push('        (void)nid; return BASE_ID;');
  lines.push('    }');
  lines.push('');

  lines.push('    static bool node_for_id(uint32_t can_id, uint32_t& out_nid) noexcept {');
  if (!isMulti) {
    lines.push('        if (can_id == BASE_ID) { out_nid = NODE_ID_START; return true; }');
    lines.push('        return false;');
  } else {
    lines.push('        int32_t off = static_cast<int32_t>(can_id) - static_cast<int32_t>(BASE_ID);');
    lines.push('        if (NODE_ID_OFFSET == 0) {');
    lines.push('            if (off == 0) { out_nid = NODE_ID_START; return true; }');
    lines.push('            return false;');
    lines.push('        }');
    lines.push('        if (off % static_cast<int32_t>(NODE_ID_OFFSET) != 0) return false;');
    lines.push('        int32_t nid = off / static_cast<int32_t>(NODE_ID_OFFSET);');
    if (hasBroadcast) {
      lines.push('        if (static_cast<uint32_t>(nid) == BROADCAST_NODE_ID) { out_nid = static_cast<uint32_t>(nid); return true; }');
    }
    lines.push('        if (nid >= static_cast<int32_t>(NODE_ID_START) && nid < static_cast<int32_t>(NODE_ID_START + NODE_COUNT)) {');
    lines.push('            out_nid = static_cast<uint32_t>(nid);');
    lines.push('            return true;');
    lines.push('        }');
    lines.push('        return false;');
  }
  lines.push('    }');
  lines.push('');

  // encode
  lines.push('    std::array<uint8_t, PAYLOAD_BYTES> encode() const {');
  lines.push('        std::array<uint8_t, PAYLOAD_BYTES> out{};');
  for (const sig of msg.signals) {
    if (sig.constant) {
      const raw = resolveDefaultRawHex(sig);
      const pack = sig.byte_order === 'big_endian' ? 'detail::pack_be' : 'detail::pack_le';
      lines.push(`        // constant: ${sig.name} = ${pyReprAny(sig.default_value)}`);
      lines.push(`        ${pack}(out.data(), out.size(), ${sig.start_bit}, ${sig.bit_length}, ${raw}ull);`);
    } else {
      const variable = `this->${sanitizeC(sig.name)}`;
      const raw = physToRawCall(sig, variable);
      const pack = sig.byte_order === 'big_endian' ? 'detail::pack_be' : 'detail::pack_le';
      lines.push(`        { uint64_t r = ${raw};`);
      lines.push(`          ${pack}(out.data(), out.size(), ${sig.start_bit}, ${sig.bit_length}, r); }`);
    }
  }
  lines.push('        return out;');
  lines.push('    }');
  lines.push('');

  lines.push('    std::size_t encode_to(uint8_t* data, std::size_t cap) const {');
  lines.push('        if (cap < PAYLOAD_BYTES) return 0;');
  lines.push('        auto a = encode();');
  lines.push('        std::memcpy(data, a.data(), PAYLOAD_BYTES);');
  lines.push('        return PAYLOAD_BYTES;');
  lines.push('    }');
  lines.push('');

  // decode
  lines.push(`    static std::optional<${cls}> decode(const uint8_t* data, std::size_t len) {`);
  lines.push('        if (len < PAYLOAD_BYTES) return std::nullopt;');
  if (fields.length === 0) lines.push('        (void)data;');
  lines.push(`        ${cls} m;`);
  for (const sig of msg.signals) {
    if (sig.constant) continue;
    const name = sanitizeC(sig.name);
    const ext = sig.byte_order === 'big_endian' ? 'detail::ext_be' : 'detail::ext_le';
    const ftype = physicalFieldTypeC(sig);
    const val = rawToPhysCall(sig, 'r');
    lines.push(`        { uint64_t r = ${ext}(data, len, ${sig.start_bit}, ${sig.bit_length});`);
    lines.push(`          m.${name} = static_cast<${ftype}>(${val}); }`);
  }
  lines.push('        return m;');
  lines.push('    }');
  lines.push('');
  lines.push(`    static std::optional<${cls}> decode(const std::array<uint8_t, PAYLOAD_BYTES>& a) {`);
  lines.push('        return decode(a.data(), a.size());');
  lines.push('    }');
  lines.push('');

  if (hasBroadcast) {
    const n = msg.node_count;
    const total = n * byteCount;
    lines.push(`    static constexpr std::size_t BROADCAST_BYTES = ${total};`);
    lines.push('    static constexpr uint32_t broadcast_id() noexcept {');
    lines.push('        return BASE_ID + BROADCAST_NODE_ID * NODE_ID_OFFSET;');
    lines.push('    }');
    lines.push('');
    lines.push(`    static std::array<uint8_t, BROADCAST_BYTES> encode_broadcast(const std::array<${cls}, ${n}>& nodes) {`);
    lines.push('        std::array<uint8_t, BROADCAST_BYTES> out{};');
    lines.push(`        for (std::size_t i = 0; i < ${n}; ++i) {`);
    lines.push('            auto p = nodes[i].encode();');
    lines.push('            std::memcpy(out.data() + i * PAYLOAD_BYTES, p.data(), PAYLOAD_BYTES);');
    lines.push('        }');
    lines.push('        return out;');
    lines.push('    }');
    lines.push('');
    lines.push(`    static std::optional<std::array<${cls}, ${n}>> decode_broadcast(const uint8_t* data, std::size_t len) {`);
    lines.push('        if (len < BROADCAST_BYTES) return std::nullopt;');
    lines.push(`        std::array<${cls}, ${n}> out{};`);
    lines.push(`        for (std::size_t i = 0; i < ${n}; ++i) {`);
    lines.push('            auto m = decode(data + i * PAYLOAD_BYTES, PAYLOAD_BYTES);');
    lines.push('            if (!m) return std::nullopt;');
    lines.push('            out[i] = *m;');
    lines.push('            out[i].node_id = NODE_ID_START + static_cast<uint32_t>(i);');
    lines.push('        }');
    lines.push('        return out;');
    lines.push('    }');
    lines.push('');
  }

  lines.push('};');
  lines.push('');
}


export function generateCpp(device: DeviceConfig): string {
  const ns = deviceNs(device);
  const L: string[] = [];
  L.push('// =====================================================================');
  L.push(`// Auto-generated CAN/CAN-FD codec for device: ${device.name}`);
  if (device.description) {
    L.push('//');
    for (const line of device.description.split('\n')) L.push(`// ${line}`);
  }
  L.push('//');
  L.push('// Generated by canfd-codec. DO NOT EDIT BY HAND.');
  L.push('// Regenerate with: canfd-codec -c <config> genlib --lang cpp');
  L.push('// =====================================================================');
  L.push('#pragma once');
  L.push('');
  L.push('#include <array>');
  L.push('#include <cstdint>');
  L.push('#include <cstddef>');
  L.push('#include <cstring>');
  L.push('#include <optional>');
  L.push('');
  L.push(`namespace ${ns} {`);
  L.push('');
  L.push(`inline constexpr const char* DEVICE_NAME = "${device.name}";`);
  if (!device.mavlink) {
    L.push(`inline constexpr bool DEVICE_FD = ${device.fd ? 'true' : 'false'};`);
    if (device.bitrate !== undefined) {
      L.push(`inline constexpr uint32_t DEVICE_BITRATE = ${device.bitrate}u;`);
    }
    if (device.fd && device.data_bitrate !== undefined) {
      L.push(`inline constexpr uint32_t DEVICE_DATA_BITRATE = ${device.data_bitrate}u;`);
    }
  }
  L.push('');
  L.push(runtimeHelpers());
  L.push('');
  L.push('// ===== Enum / bitfield constants =====');
  for (const msg of device.messages) {
    for (const sig of msg.signals) {
      if (isEnum(sig)) emitEnum(sig, msg, L);
      else if (isBitfield(sig)) emitBitfield(sig, msg, L);
    }
  }
  L.push('');
  L.push('// ===== Message types =====');
  for (const msg of device.messages) emitStruct(msg, L);
  L.push(`} // namespace ${ns}`);
  L.push('');
  return L.join('\n');
}
