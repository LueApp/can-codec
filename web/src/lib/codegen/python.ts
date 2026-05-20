/**
 * Python 3 generator. Mirrors canfd_codec/codegen/python_gen.py.
 * The output must be bit-exact with the CLI generator.
 */

import type { DeviceConfig, Message, Signal } from '../types';
import {
  sanitizeC, toPascalCase, toSnakeCase, toUpperSnake,
  signalMaxRawDec, isEnum, isBitfield, isSigned,
  physicalFieldTypePy, resolveDefaultRawHex, resolveDefaultPhysical,
  userSignals, totalPayloadBytes, fmtFloat, pyRepr, pyReprAny,
} from './common';


function runtimeHelpers(): string {
  return `# ===== Bit-level helpers (do not edit) =====
def _ext_le(data, start, length):
    v = 0
    for i in range(length):
        bi = (start + i) // 8
        if bi < len(data) and data[bi] & (1 << ((start + i) % 8)):
            v |= 1 << i
    return v


def _ext_be(data, start, length):
    v = 0
    for i in range(length):
        bp = start + i
        bi = bp // 8
        if bi < len(data) and data[bi] & (1 << (7 - (bp % 8))):
            v |= 1 << (length - 1 - i)
    return v


def _pack_le(data, start, length, value):
    for i in range(length):
        bi = (start + i) // 8
        while bi >= len(data):
            data.append(0)
        if value & (1 << i):
            data[bi] |= 1 << ((start + i) % 8)
        else:
            data[bi] &= ~(1 << ((start + i) % 8))


def _pack_be(data, start, length, value):
    for i in range(length):
        bp = start + i
        bi = bp // 8
        while bi >= len(data):
            data.append(0)
        if value & (1 << (length - 1 - i)):
            data[bi] |= 1 << (7 - (bp % 8))
        else:
            data[bi] &= ~(1 << (7 - (bp % 8)))


def _p2r_unsigned(v, scale, offset, length):
    raw = int((v - offset) / scale) if scale != 0 else 0
    m = (1 << length) - 1
    return max(0, min(raw, m))


def _p2r_signed(v, scale, offset, length):
    raw = int((v - offset) / scale) if scale != 0 else 0
    if raw < 0:
        raw += 1 << length
    m = (1 << length) - 1
    return max(0, min(raw, m))


def _r2p_unsigned(raw, scale, offset):
    return raw * scale + offset


def _r2p_signed(raw, scale, offset, length):
    if raw >= (1 << (length - 1)):
        raw -= 1 << length
    return raw * scale + offset


def _f32_to_u32(v):
    return _struct.unpack("<I", _struct.pack("<f", float(v)))[0]


def _u32_to_f32(raw):
    return _struct.unpack("<f", _struct.pack("<I", raw & 0xFFFFFFFF))[0]


def _f64_to_u64(v):
    return _struct.unpack("<Q", _struct.pack("<d", float(v)))[0]


def _u64_to_f64(raw):
    return _struct.unpack("<d", _struct.pack("<Q", raw & 0xFFFFFFFFFFFFFFFF))[0]
`;
}


function emitEnumClass(sig: Signal, msg: Message, lines: string[]) {
  const clsName = `${toPascalCase(msg.name)}_${toSnakeCase(sig.name)}`;
  lines.push(`class ${clsName}:`);
  lines.push(`    """Enum constants for signal \`${sig.name}\` of \`${msg.name}\`."""`);
  const entries = Object.entries(sig.enum_map).map(([k, v]) => [Number(k), v] as [number, string]);
  entries.sort((a, b) => a[0] - b[0]);
  for (const [rawVal, name] of entries) {
    let constName = toUpperSnake(name);
    if (/^\d/.test(constName)) constName = '_' + constName;
    lines.push(`    ${constName} = ${rawVal}`);
  }
  lines.push('    _BY_NAME = {');
  for (const [rawVal, name] of entries) {
    lines.push(`        ${pyRepr(name.toLowerCase())}: ${rawVal},`);
  }
  lines.push('    }');
  lines.push('    _BY_VALUE = {');
  for (const [rawVal, name] of entries) {
    lines.push(`        ${rawVal}: ${pyRepr(name)},`);
  }
  lines.push('    }');
  lines.push('    @classmethod');
  lines.push('    def from_name(cls, name):');
  lines.push('        return cls._BY_NAME.get(name.lower())');
  lines.push('    @classmethod');
  lines.push('    def name_of(cls, value):');
  lines.push('        return cls._BY_VALUE.get(int(value))');
  lines.push('');
}


function emitBitfieldClass(sig: Signal, msg: Message, lines: string[]) {
  const clsName = `${toPascalCase(msg.name)}_${toSnakeCase(sig.name)}`;
  lines.push(`class ${clsName}:`);
  lines.push(`    """Bit-flag constants for signal \`${sig.name}\` of \`${msg.name}\`."""`);
  const entries = Object.entries(sig.bitfield_map).map(([k, v]) => [Number(k), v] as [number, string]);
  entries.sort((a, b) => a[0] - b[0]);
  for (const [bit, name] of entries) {
    let constName = toUpperSnake(name);
    if (/^\d/.test(constName)) constName = '_' + constName;
    lines.push(`    ${constName} = 1 << ${bit}  # bit ${bit}`);
  }
  lines.push('    _BITS = {');
  for (const [bit, name] of entries) {
    lines.push(`        ${bit}: ${pyRepr(name)},`);
  }
  lines.push('    }');
  lines.push('    @classmethod');
  lines.push('    def names_set(cls, value):');
  lines.push('        """Return the list of flag names that are set in `value`."""');
  lines.push('        return [n for b, n in cls._BITS.items() if value & (1 << b)]');
  lines.push('');
}


function physicalToRawExpr(sig: Signal, variable: string): string {
  if (isBitfield(sig) || isEnum(sig)) {
    return `int(${variable}) & ${signalMaxRawDec(sig)}`;
  }
  if (sig.value_type === 'float32') return `_f32_to_u32(${variable})`;
  if (sig.value_type === 'float64') return `_f64_to_u64(${variable})`;
  if (isSigned(sig)) {
    return `_p2r_signed(${variable}, ${fmtFloat(sig.scale)}, ${fmtFloat(sig.offset)}, ${sig.bit_length})`;
  }
  return `_p2r_unsigned(${variable}, ${fmtFloat(sig.scale)}, ${fmtFloat(sig.offset)}, ${sig.bit_length})`;
}


function rawToPhysicalExpr(sig: Signal, rawVar: string): string {
  if (isBitfield(sig) || isEnum(sig)) return rawVar;
  if (sig.value_type === 'float32') return `_u32_to_f32(${rawVar})`;
  if (sig.value_type === 'float64') return `_u64_to_f64(${rawVar})`;
  if (isSigned(sig)) {
    return `_r2p_signed(${rawVar}, ${fmtFloat(sig.scale)}, ${fmtFloat(sig.offset)}, ${sig.bit_length})`;
  }
  return `_r2p_unsigned(${rawVar}, ${fmtFloat(sig.scale)}, ${fmtFloat(sig.offset)})`;
}


function emitMessageClass(msg: Message, lines: string[]) {
  const clsName = toPascalCase(msg.name);
  const byteCount = totalPayloadBytes(msg);
  const fields = userSignals(msg);
  const isMulti = msg.node_count > 1;
  const hasBroadcast = msg.broadcast_node_id !== null && msg.broadcast_node_id !== undefined;

  lines.push('@_dataclass');
  lines.push(`class ${clsName}:`);
  const desc = (msg.description || '').trim().replace(/\n/g, ' ');
  if (desc) lines.push(`    """${desc}"""`);

  lines.push(`    BASE_ID = ${'0x' + msg.id.toString(16)}`);
  lines.push(`    DLC = ${msg.dlc}`);
  lines.push(`    PAYLOAD_BYTES = ${byteCount}`);
  lines.push(`    DIRECTION = ${pyRepr(msg.direction)}`);
  lines.push(`    NODE_COUNT = ${msg.node_count}`);
  lines.push(`    NODE_ID_OFFSET = ${msg.node_id_offset}`);
  lines.push(`    NODE_ID_START = ${msg.node_id_start}`);
  if (hasBroadcast) {
    lines.push(`    BROADCAST_NODE_ID = ${'0x' + (msg.broadcast_node_id as number).toString(16)}`);
  } else {
    lines.push('    BROADCAST_NODE_ID = None');
  }
  lines.push('');

  if (fields.length === 0) {
    lines.push('    pass');
  } else {
    for (const sig of fields) {
      const ftype = physicalFieldTypePy(sig);
      const fname = sanitizeC(sig.name);
      const dp = resolveDefaultPhysical(sig);
      let defaultLit = ftype === 'float' ? '0.0' : '0';
      if (dp !== null) defaultLit = ftype === 'float' ? fmtFloat(dp) : Math.trunc(dp).toString();
      const unit = sig.unit ? `  # ${sig.unit}` : '';
      lines.push(`    ${fname}: ${ftype} = ${defaultLit}${unit}`);
    }
  }
  lines.push(`    node_id: int = ${msg.node_id_start}`);
  lines.push('');

  // id_for_node
  lines.push('    @classmethod');
  lines.push('    def id_for_node(cls, node_id):');
  if (isMulti) lines.push('        return cls.BASE_ID + node_id * cls.NODE_ID_OFFSET');
  else lines.push('        return cls.BASE_ID');
  lines.push('');

  // node_for_id
  lines.push('    @classmethod');
  lines.push('    def node_for_id(cls, can_id):');
  lines.push('        """Return node_id if `can_id` belongs to this message, else None."""');
  if (!isMulti) {
    lines.push('        return cls.NODE_ID_START if can_id == cls.BASE_ID else None');
  } else {
    lines.push('        off = can_id - cls.BASE_ID');
    lines.push('        if cls.NODE_ID_OFFSET == 0:');
    lines.push('            return cls.NODE_ID_START if off == 0 else None');
    lines.push('        if off % cls.NODE_ID_OFFSET != 0:');
    lines.push('            return None');
    lines.push('        nid = off // cls.NODE_ID_OFFSET');
    if (hasBroadcast) {
      lines.push('        if nid == cls.BROADCAST_NODE_ID:');
      lines.push('            return nid');
    }
    lines.push('        if cls.NODE_ID_START <= nid <= cls.NODE_ID_START + cls.NODE_COUNT - 1:');
    lines.push('            return nid');
    lines.push('        return None');
  }
  lines.push('');

  // encode
  lines.push('    def encode(self, node_id=None):');
  lines.push('        """Pack signal values into raw bytes. Returns (can_id, bytes)."""');
  lines.push('        if node_id is None:');
  lines.push('            node_id = self.node_id');
  lines.push(`        data = bytearray(${byteCount})`);
  for (const sig of msg.signals) {
    if (sig.constant) {
      const raw = resolveDefaultRawHex(sig);
      lines.push(`        # constant: ${sig.name} = ${pyReprAny(sig.default_value)}`);
      const pack = sig.byte_order === 'big_endian' ? '_pack_be' : '_pack_le';
      lines.push(`        ${pack}(data, ${sig.start_bit}, ${sig.bit_length}, ${raw})`);
    } else {
      const variable = `self.${sanitizeC(sig.name)}`;
      const raw = physicalToRawExpr(sig, variable);
      lines.push(`        # ${sig.name}`);
      lines.push(`        _raw = ${raw}`);
      const pack = sig.byte_order === 'big_endian' ? '_pack_be' : '_pack_le';
      lines.push(`        ${pack}(data, ${sig.start_bit}, ${sig.bit_length}, _raw)`);
    }
  }
  lines.push('        return self.id_for_node(node_id), bytes(data)');
  lines.push('');

  // decode
  lines.push('    @classmethod');
  lines.push('    def decode(cls, data, node_id=None):');
  lines.push('        """Parse raw bytes into a message instance."""');
  lines.push(`        if len(data) < ${byteCount}:`);
  lines.push(`            data = bytes(data) + b'\\x00' * (${byteCount} - len(data))`);
  lines.push('        m = cls()');
  lines.push('        if node_id is not None:');
  lines.push('            m.node_id = node_id');
  for (const sig of msg.signals) {
    if (sig.constant) continue;
    const fname = sanitizeC(sig.name);
    const ext = sig.byte_order === 'big_endian' ? '_ext_be' : '_ext_le';
    const ftype = physicalFieldTypePy(sig);
    let valExpr = rawToPhysicalExpr(sig, '_raw');
    if (ftype === 'int') valExpr = `int(${valExpr})`;
    else if (ftype === 'float') valExpr = `float(${valExpr})`;
    lines.push(`        _raw = ${ext}(data, ${sig.start_bit}, ${sig.bit_length})`);
    lines.push(`        m.${fname} = ${valExpr}`);
  }
  lines.push('        return m');
  lines.push('');

  // broadcast
  if (hasBroadcast) {
    lines.push('    @classmethod');
    lines.push('    def encode_broadcast(cls, nodes):');
    lines.push('        """Pack a list of NODE_COUNT instances into one broadcast frame.');
    lines.push('        Returns (can_id, bytes)."""');
    lines.push('        if len(nodes) != cls.NODE_COUNT:');
    lines.push('            raise ValueError(');
    lines.push("                f'Broadcast expects {cls.NODE_COUNT} nodes, got {len(nodes)}'");
    lines.push('            )');
    lines.push('        data = bytearray()');
    lines.push('        for i, n in enumerate(nodes):');
    lines.push('            _, p = n.encode(node_id=cls.NODE_ID_START + i)');
    lines.push('            data.extend(p)');
    lines.push('        can_id = cls.BASE_ID + cls.BROADCAST_NODE_ID * cls.NODE_ID_OFFSET');
    lines.push('        return can_id, bytes(data)');
    lines.push('');
    lines.push('    @classmethod');
    lines.push('    def decode_broadcast(cls, data):');
    lines.push('        """Split a broadcast frame into per-node instances."""');
    lines.push('        size = cls.PAYLOAD_BYTES');
    lines.push('        need = size * cls.NODE_COUNT');
    lines.push('        if len(data) < need:');
    lines.push("            data = bytes(data) + b'\\x00' * (need - len(data))");
    lines.push('        out = []');
    lines.push('        for i in range(cls.NODE_COUNT):');
    lines.push('            seg = data[i*size:(i+1)*size]');
    lines.push('            out.append(cls.decode(seg, node_id=cls.NODE_ID_START + i))');
    lines.push('        return out');
    lines.push('');
  }
}


export function generatePython(device: DeviceConfig): string {
  const L: string[] = [];
  L.push(`"""Auto-generated CAN/CAN-FD codec for device: ${device.name}`);
  if (device.description) {
    L.push('');
    L.push(device.description);
  }
  L.push('');
  L.push('Generated by canfd-codec. DO NOT EDIT BY HAND — regenerate with:');
  L.push('    canfd-codec -c <config> genlib --lang python');
  L.push('"""');
  L.push('import struct as _struct');
  L.push('from dataclasses import dataclass as _dataclass');
  L.push('');
  L.push(`DEVICE_NAME = ${pyRepr(device.name)}`);
  L.push(`DEVICE_BUS = ${pyRepr(device.bus)}`);
  L.push(`DEVICE_FD = ${device.fd ? 'True' : 'False'}`);
  if (device.bitrate !== undefined) {
    L.push(`DEVICE_BITRATE = ${device.bitrate}`);
  }
  if (device.fd && device.data_bitrate !== undefined) {
    L.push(`DEVICE_DATA_BITRATE = ${device.data_bitrate}`);
  }
  L.push('');
  L.push(runtimeHelpers());
  L.push('');

  L.push('# ===== Enum and bitfield constants =====');
  for (const msg of device.messages) {
    for (const sig of msg.signals) {
      if (isEnum(sig)) emitEnumClass(sig, msg, L);
      else if (isBitfield(sig)) emitBitfieldClass(sig, msg, L);
    }
  }

  L.push('# ===== Message classes =====');
  for (const msg of device.messages) {
    emitMessageClass(msg, L);
  }

  L.push('# ===== Top-level dispatch =====');
  L.push('ALL_MESSAGES = [');
  for (const msg of device.messages) L.push(`    ${toPascalCase(msg.name)},`);
  L.push(']');
  L.push('');
  L.push('MESSAGES_BY_NAME = {cls.__name__: cls for cls in ALL_MESSAGES}');
  L.push('');
  L.push('def decode_frame(can_id, data):');
  L.push('    """Find the right message class for `can_id` and decode `data`.');
  L.push('    Returns the decoded instance (a list for broadcast frames), or None');
  L.push('    if the ID is unknown."""');
  L.push('    for cls in ALL_MESSAGES:');
  L.push('        nid = cls.node_for_id(can_id)');
  L.push('        if nid is None:');
  L.push('            continue');
  L.push('        if cls.BROADCAST_NODE_ID is not None and nid == cls.BROADCAST_NODE_ID:');
  L.push('            expected = cls.PAYLOAD_BYTES * cls.NODE_COUNT');
  L.push('            if len(data) == expected:');
  L.push('                return cls.decode_broadcast(data)');
  L.push('        return cls.decode(data, node_id=nid)');
  L.push('    return None');
  L.push('');
  L.push('__all__ = [');
  L.push("    'DEVICE_NAME', 'DEVICE_BUS', 'DEVICE_FD',");
  L.push("    'ALL_MESSAGES', 'MESSAGES_BY_NAME', 'decode_frame',");
  for (const msg of device.messages) L.push(`    ${pyRepr(toPascalCase(msg.name))},`);
  L.push(']');
  L.push('');
  return L.join('\n');
}
