/**
 * C99 header-only generator. Mirrors canfd_codec/codegen/c_gen.py.
 */

import type { DeviceConfig, Message, Signal } from '../types';
import {
  sanitizeC, toSnakeCase, toUpperSnake,
  signalMaxRawDec, isEnum, isBitfield, isSigned, isIdentityInteger,
  physicalFieldTypeC, resolveDefaultRawHex, resolveDefaultPhysical,
  userSignals, totalPayloadBytes, fmtFloat, pyReprAny,
} from './common';


function devicePrefix(device: DeviceConfig): string {
  return toSnakeCase(device.name) || 'device';
}

function msgPrefix(device: DeviceConfig, msg: Message): string {
  return `${devicePrefix(device)}_${toSnakeCase(msg.name)}`;
}


function runtimeHelpers(): string {
  return String.raw`
/* ===== Internal bit / float helpers (do not call directly) ===== */
static inline uint64_t _ccgen_ext_le(const uint8_t* data, size_t len, int start, int length) {
    uint64_t v = 0;
    for (int i = 0; i < length; ++i) {
        int bi = (start + i) >> 3;
        if ((size_t)bi < len && (data[bi] & (1u << ((start + i) & 7)))) {
            v |= (uint64_t)1 << i;
        }
    }
    return v;
}

static inline uint64_t _ccgen_ext_be(const uint8_t* data, size_t len, int start, int length) {
    uint64_t v = 0;
    for (int i = 0; i < length; ++i) {
        int bp = start + i;
        int bi = bp >> 3;
        if ((size_t)bi < len && (data[bi] & (1u << (7 - (bp & 7))))) {
            v |= (uint64_t)1 << (length - 1 - i);
        }
    }
    return v;
}

static inline void _ccgen_pack_le(uint8_t* data, size_t len, int start, int length, uint64_t value) {
    for (int i = 0; i < length; ++i) {
        int bi = (start + i) >> 3;
        if ((size_t)bi >= len) break;
        int b = (start + i) & 7;
        if (value & ((uint64_t)1 << i)) data[bi] |=  (uint8_t)(1u << b);
        else                            data[bi] &= (uint8_t)~(1u << b);
    }
}

static inline void _ccgen_pack_be(uint8_t* data, size_t len, int start, int length, uint64_t value) {
    for (int i = 0; i < length; ++i) {
        int bp = start + i;
        int bi = bp >> 3;
        if ((size_t)bi >= len) break;
        int b = 7 - (bp & 7);
        if (value & ((uint64_t)1 << (length - 1 - i))) data[bi] |=  (uint8_t)(1u << b);
        else                                           data[bi] &= (uint8_t)~(1u << b);
    }
}

static inline int64_t _ccgen_sign_extend(uint64_t raw, int length) {
    if (length >= 64) return (int64_t)raw;
    uint64_t sign = (uint64_t)1 << (length - 1);
    if (raw & sign) {
        return (int64_t)(raw | (~(uint64_t)0 << length));
    }
    return (int64_t)raw;
}

static inline uint32_t _ccgen_f32_to_u32(float v) {
    uint32_t out;
    memcpy(&out, &v, 4);
    return out;
}

static inline float _ccgen_u32_to_f32(uint32_t raw) {
    float out;
    memcpy(&out, &raw, 4);
    return out;
}

static inline uint64_t _ccgen_f64_to_u64(double v) {
    uint64_t out;
    memcpy(&out, &v, 8);
    return out;
}

static inline double _ccgen_u64_to_f64(uint64_t raw) {
    double out;
    memcpy(&out, &raw, 8);
    return out;
}

static inline uint64_t _ccgen_clamp_u(int64_t raw, int length) {
    int64_t maxv = (length >= 64) ? (int64_t)((uint64_t)~0ULL) : (int64_t)(((uint64_t)1 << length) - 1);
    if (raw < 0) return 0;
    if (raw > maxv) return (uint64_t)maxv;
    return (uint64_t)raw;
}

static inline uint64_t _ccgen_phys_to_raw_signed(double v, double scale, double offset, int length) {
    double r = (scale != 0) ? (v - offset) / scale : 0;
    int64_t raw = (int64_t)r;
    if (raw < 0) raw += (int64_t)1 << length;
    return _ccgen_clamp_u(raw, length);
}

static inline uint64_t _ccgen_phys_to_raw_unsigned(double v, double scale, double offset, int length) {
    double r = (scale != 0) ? (v - offset) / scale : 0;
    int64_t raw = (int64_t)r;
    return _ccgen_clamp_u(raw, length);
}

static inline double _ccgen_raw_to_phys_signed(uint64_t raw, double scale, double offset, int length) {
    return (double)_ccgen_sign_extend(raw, length) * scale + offset;
}

static inline double _ccgen_raw_to_phys_unsigned(uint64_t raw, double scale, double offset) {
    return (double)raw * scale + offset;
}
`;
}


function emitEnum(sig: Signal, msg: Message, device: DeviceConfig, lines: string[]) {
  const prefix = `${msgPrefix(device, msg)}_${toSnakeCase(sig.name)}`.toUpperCase();
  const entries = Object.entries(sig.enum_map).map(([k, v]) => [Number(k), v] as [number, string]);
  entries.sort((a, b) => a[0] - b[0]);
  for (const [raw, name] of entries) {
    const macro = `${prefix}_${toUpperSnake(name)}`;
    lines.push(`#define ${macro} ((uint32_t)${raw}u)`);
  }
  lines.push('');
}


function emitBitfield(sig: Signal, msg: Message, device: DeviceConfig, lines: string[]) {
  const prefix = `${msgPrefix(device, msg)}_${toSnakeCase(sig.name)}`.toUpperCase();
  const entries = Object.entries(sig.bitfield_map).map(([k, v]) => [Number(k), v] as [number, string]);
  entries.sort((a, b) => a[0] - b[0]);
  for (const [bit, name] of entries) {
    const macro = `${prefix}_${toUpperSnake(name)}`;
    lines.push(`#define ${macro} ((uint32_t)1u << ${bit})`);
  }
  lines.push('');
}


function physToRawCall(sig: Signal, variable: string): string {
  if (isBitfield(sig) || isEnum(sig)) {
    return `((uint64_t)(${variable}) & ${signalMaxRawDec(sig)}ull)`;
  }
  if (sig.value_type === 'float32') return `(uint64_t)_ccgen_f32_to_u32((float)(${variable}))`;
  if (sig.value_type === 'float64') return `_ccgen_f64_to_u64((double)(${variable}))`;
  if (isIdentityInteger(sig)) return `((uint64_t)(${variable}) & ${signalMaxRawDec(sig)}ull)`;
  const fn = isSigned(sig) ? '_ccgen_phys_to_raw_signed' : '_ccgen_phys_to_raw_unsigned';
  return `${fn}((double)(${variable}), ${fmtFloat(sig.scale)}, ${fmtFloat(sig.offset)}, ${sig.bit_length})`;
}


function rawToPhysCall(sig: Signal, rawVar: string): string {
  if (isBitfield(sig) || isEnum(sig)) return rawVar;
  if (sig.value_type === 'float32') return `_ccgen_u32_to_f32((uint32_t)(${rawVar}))`;
  if (sig.value_type === 'float64') return `_ccgen_u64_to_f64(${rawVar})`;
  if (isIdentityInteger(sig)) return isSigned(sig) ? `_ccgen_sign_extend(${rawVar}, ${sig.bit_length})` : rawVar;
  if (isSigned(sig)) {
    return `_ccgen_raw_to_phys_signed(${rawVar}, ${fmtFloat(sig.scale)}, ${fmtFloat(sig.offset)}, ${sig.bit_length})`;
  }
  return `_ccgen_raw_to_phys_unsigned(${rawVar}, ${fmtFloat(sig.scale)}, ${fmtFloat(sig.offset)})`;
}


function emitStruct(device: DeviceConfig, msg: Message, lines: string[]) {
  const prefix = msgPrefix(device, msg);
  const byteCount = totalPayloadBytes(msg);
  const fields = userSignals(msg);
  const isMulti = msg.node_count > 1;
  const hasBroadcast = msg.broadcast_node_id !== null && msg.broadcast_node_id !== undefined;

  const desc = (msg.description || '').trim().replace(/\n/g, ' ');
  lines.push(`/* ---- ${msg.name} (id=0x${msg.id.toString(16).toUpperCase()}, dlc=${msg.dlc}) ---- */`);
  if (desc) lines.push(`/* ${desc} */`);
  lines.push(`#define ${prefix}_BASE_ID      0x${msg.id.toString(16).toUpperCase()}u`);
  lines.push(`#define ${prefix}_DLC          ${msg.dlc}`);
  lines.push(`#define ${prefix}_PAYLOAD_BYTES ${byteCount}`);
  lines.push(`#define ${prefix}_NODE_COUNT   ${msg.node_count}`);
  lines.push(`#define ${prefix}_NODE_ID_OFFSET ${msg.node_id_offset}`);
  lines.push(`#define ${prefix}_NODE_ID_START ${msg.node_id_start}`);
  if (msg.crc_extra !== undefined) {
    lines.push(`#define ${prefix.toUpperCase()}_CRC_EXTRA ${msg.crc_extra}u`);
  }
  if (hasBroadcast) {
    lines.push(`#define ${prefix}_BROADCAST_NODE_ID 0x${(msg.broadcast_node_id as number).toString(16).toUpperCase()}u`);
  }
  lines.push('');

  lines.push('typedef struct {');
  for (const sig of fields) {
    const ftype = physicalFieldTypeC(sig);
    const unit = sig.unit ? `  /* ${sig.unit} */` : '';
    lines.push(`    ${ftype} ${sanitizeC(sig.name)};${unit}`);
  }
  if (fields.length === 0) {
    lines.push('    uint8_t _unused;  /* no user-facing signals */');
  }
  lines.push(`} ${prefix}_t;`);
  lines.push('');

  // Init macro
  const initParts: string[] = [];
  for (const sig of fields) {
    const d = resolveDefaultPhysical(sig);
    if (d === null) {
      initParts.push('0');
    } else {
      const ftype = physicalFieldTypeC(sig);
      if (ftype === 'float' || ftype === 'double') initParts.push(fmtFloat(d));
      else initParts.push(Math.trunc(d).toString());
    }
  }
  if (initParts.length) {
    lines.push(`#define ${prefix.toUpperCase()}_INIT { ${initParts.join(', ')} }`);
  }
  lines.push('');

  // id_for_node
  lines.push(`static inline uint32_t ${prefix}_id_for_node(uint32_t node_id) {`);
  if (isMulti) lines.push(`    return ${prefix}_BASE_ID + node_id * ${prefix}_NODE_ID_OFFSET;`);
  else lines.push(`    (void)node_id; return ${prefix}_BASE_ID;`);
  lines.push('}');
  lines.push('');

  // node_for_id
  lines.push(`static inline int ${prefix}_node_for_id(uint32_t can_id, uint32_t* out_node_id) {`);
  if (!isMulti) {
    lines.push(`    if (can_id == ${prefix}_BASE_ID) { if (out_node_id) *out_node_id = ${prefix}_NODE_ID_START; return 1; }`);
    lines.push('    return 0;');
  } else {
    lines.push(`    int32_t off = (int32_t)can_id - (int32_t)${prefix}_BASE_ID;`);
    lines.push(`    if (${prefix}_NODE_ID_OFFSET == 0) {`);
    lines.push(`        if (off == 0) { if (out_node_id) *out_node_id = ${prefix}_NODE_ID_START; return 1; }`);
    lines.push('        return 0;');
    lines.push('    }');
    lines.push(`    if (off % ${prefix}_NODE_ID_OFFSET != 0) return 0;`);
    lines.push(`    int32_t nid = off / ${prefix}_NODE_ID_OFFSET;`);
    if (hasBroadcast) {
      lines.push(`    if ((uint32_t)nid == ${prefix}_BROADCAST_NODE_ID) { if (out_node_id) *out_node_id = (uint32_t)nid; return 1; }`);
    }
    lines.push(`    if (nid >= (int32_t)${prefix}_NODE_ID_START && nid < (int32_t)(${prefix}_NODE_ID_START + ${prefix}_NODE_COUNT)) {`);
    lines.push('        if (out_node_id) *out_node_id = (uint32_t)nid;');
    lines.push('        return 1;');
    lines.push('    }');
    lines.push('    return 0;');
  }
  lines.push('}');
  lines.push('');

  // encode
  lines.push(`static inline size_t ${prefix}_encode(const ${prefix}_t* src, uint8_t* data, size_t cap) {`);
  lines.push(`    if (cap < ${byteCount}) return 0;`);
  if (fields.length === 0) lines.push('    (void)src;');
  lines.push(`    for (size_t _i = 0; _i < ${byteCount}; ++_i) data[_i] = 0;`);
  for (const sig of msg.signals) {
    if (sig.constant) {
      const raw = resolveDefaultRawHex(sig);
      const pack = sig.byte_order === 'big_endian' ? '_ccgen_pack_be' : '_ccgen_pack_le';
      lines.push(`    /* constant: ${sig.name} = ${pyReprAny(sig.default_value)} */`);
      lines.push(`    ${pack}(data, ${byteCount}, ${sig.start_bit}, ${sig.bit_length}, (uint64_t)${raw}ull);`);
    } else {
      const variable = `src->${sanitizeC(sig.name)}`;
      const raw = physToRawCall(sig, variable);
      const pack = sig.byte_order === 'big_endian' ? '_ccgen_pack_be' : '_ccgen_pack_le';
      lines.push(`    { uint64_t _raw = ${raw};`);
      lines.push(`      ${pack}(data, ${byteCount}, ${sig.start_bit}, ${sig.bit_length}, _raw); }`);
    }
  }
  lines.push(`    return ${byteCount};`);
  lines.push('}');
  lines.push('');

  // decode
  lines.push(`static inline int ${prefix}_decode(const uint8_t* data, size_t len, ${prefix}_t* dst) {`);
  lines.push(`    if (len < ${byteCount}) return 0;`);
  if (fields.length === 0) lines.push('    (void)data; (void)dst;');
  for (const sig of msg.signals) {
    if (sig.constant) continue;
    const fname = sanitizeC(sig.name);
    const ext = sig.byte_order === 'big_endian' ? '_ccgen_ext_be' : '_ccgen_ext_le';
    const ftype = physicalFieldTypeC(sig);
    const val = rawToPhysCall(sig, '_raw');
    lines.push(`    { uint64_t _raw = ${ext}(data, len, ${sig.start_bit}, ${sig.bit_length});`);
    lines.push(`      dst->${fname} = (${ftype})(${val}); }`);
  }
  lines.push('    return 1;');
  lines.push('}');
  lines.push('');

  if (hasBroadcast) {
    const n = msg.node_count;
    const total = n * byteCount;
    lines.push(`static inline size_t ${prefix}_encode_broadcast(const ${prefix}_t nodes[${n}], uint8_t* data, size_t cap) {`);
    lines.push(`    if (cap < ${total}) return 0;`);
    lines.push(`    for (size_t _i = 0; _i < ${total}; ++_i) data[_i] = 0;`);
    lines.push(`    for (size_t i = 0; i < ${n}; ++i) {`);
    lines.push(`        ${prefix}_encode(&nodes[i], data + i * ${byteCount}, ${byteCount});`);
    lines.push('    }');
    lines.push(`    return ${total};`);
    lines.push('}');
    lines.push('');
    lines.push(`static inline int ${prefix}_decode_broadcast(const uint8_t* data, size_t len, ${prefix}_t nodes[${n}]) {`);
    lines.push(`    if (len < ${total}) return 0;`);
    lines.push(`    for (size_t i = 0; i < ${n}; ++i) {`);
    lines.push(`        ${prefix}_decode(data + i * ${byteCount}, ${byteCount}, &nodes[i]);`);
    lines.push('    }');
    lines.push('    return 1;');
    lines.push('}');
    lines.push('');
    lines.push(`static inline uint32_t ${prefix}_broadcast_id(void) {`);
    lines.push(`    return ${prefix}_BASE_ID + ${prefix}_BROADCAST_NODE_ID * ${prefix}_NODE_ID_OFFSET;`);
    lines.push('}');
    lines.push('');
  }
}


export function generateC(device: DeviceConfig): string {
  const prefix = devicePrefix(device);
  const guard = `${prefix.toUpperCase()}_CODEC_H`;
  const L: string[] = [];
  L.push('/*');
  L.push(` * Auto-generated CAN/CAN-FD codec for device: ${device.name}`);
  if (device.description) {
    L.push(' *');
    for (const line of device.description.split('\n')) L.push(` * ${line}`);
  }
  L.push(' *');
  L.push(' * Generated by canfd-codec. DO NOT EDIT BY HAND.');
  L.push(' * Regenerate with: canfd-codec -c <config> genlib --lang c');
  L.push(' */');
  L.push(`#ifndef ${guard}`);
  L.push(`#define ${guard}`);
  L.push('');
  L.push('#include <stdint.h>');
  L.push('#include <stddef.h>');
  L.push('#include <string.h>');
  L.push('');
  L.push('#ifdef __cplusplus');
  L.push('extern "C" {');
  L.push('#endif');
  L.push('');
  L.push(`#define ${prefix.toUpperCase()}_DEVICE_NAME    "${device.name}"`);
  if (!device.mavlink) {
    L.push(`#define ${prefix.toUpperCase()}_DEVICE_FD      ${device.fd ? 1 : 0}`);
    if (device.bitrate !== undefined) {
      L.push(`#define ${prefix.toUpperCase()}_DEVICE_BITRATE ${device.bitrate}u`);
    }
    if (device.fd && device.data_bitrate !== undefined) {
      L.push(`#define ${prefix.toUpperCase()}_DATA_BITRATE   ${device.data_bitrate}u`);
    }
  }
  L.push('');
  L.push(runtimeHelpers());
  L.push('');
  L.push('/* ===== Enum / bitfield constants ===== */');
  for (const msg of device.messages) {
    for (const sig of msg.signals) {
      if (isEnum(sig)) emitEnum(sig, msg, device, L);
      else if (isBitfield(sig)) emitBitfield(sig, msg, device, L);
    }
  }
  L.push('');
  L.push('/* ===== Message structs & encode/decode ===== */');
  for (const msg of device.messages) emitStruct(device, msg, L);

  L.push('#ifdef __cplusplus');
  L.push('} /* extern "C" */');
  L.push('#endif');
  L.push('');
  L.push(`#endif /* ${guard} */`);
  L.push('');
  return L.join('\n');
}
