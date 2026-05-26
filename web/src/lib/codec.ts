/**
 * Core codec engine for CAN/CAN-FD message encoding/decoding.
 * TypeScript port of the Python canfd_codec.codec module.
 */

import type { Signal, Message, DeviceConfig, DecodedSignal, DecodedMessage, MessageInfo, MavlinkInfo } from './types';

// ---------------------------------------------------------------------------
// Bit-level extraction & packing
// ---------------------------------------------------------------------------

function extractBitsLE(data: Uint8Array, startBit: number, bitLength: number): number {
  let value = 0;
  for (let i = 0; i < bitLength; i++) {
    const byteIdx = Math.floor((startBit + i) / 8);
    const bitIdx = (startBit + i) % 8;
    if (byteIdx < data.length) {
      if (data[byteIdx] & (1 << bitIdx)) {
        value |= (1 << i);
      }
    }
  }
  return value >>> 0;
}

function extractBitsBE(data: Uint8Array, startBit: number, bitLength: number): number {
  let value = 0;
  for (let i = 0; i < bitLength; i++) {
    const bitPos = startBit + i;
    const byteIdx = Math.floor(bitPos / 8);
    const bitInByte = 7 - (bitPos % 8);
    if (byteIdx < data.length) {
      if (data[byteIdx] & (1 << bitInByte)) {
        value |= (1 << (bitLength - 1 - i));
      }
    }
  }
  return value >>> 0;
}

function packBitsLE(data: Uint8Array, startBit: number, bitLength: number, value: number): void {
  for (let i = 0; i < bitLength; i++) {
    const byteIdx = Math.floor((startBit + i) / 8);
    const bitIdx = (startBit + i) % 8;
    if (byteIdx < data.length) {
      if (value & (1 << i)) {
        data[byteIdx] |= (1 << bitIdx);
      } else {
        data[byteIdx] &= ~(1 << bitIdx);
      }
    }
  }
}

function packBitsBE(data: Uint8Array, startBit: number, bitLength: number, value: number): void {
  for (let i = 0; i < bitLength; i++) {
    const bitPos = startBit + i;
    const byteIdx = Math.floor(bitPos / 8);
    const bitInByte = 7 - (bitPos % 8);
    if (byteIdx < data.length) {
      if (value & (1 << (bitLength - 1 - i))) {
        data[byteIdx] |= (1 << bitInByte);
      } else {
        data[byteIdx] &= ~(1 << bitInByte);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Signal-level decode / encode
// ---------------------------------------------------------------------------

function rawToPhysical(rawValue: number, signal: Signal): number {
  const vtype = signal.value_type;

  if (vtype === 'float32') {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint32(0, rawValue >>> 0, true);
    return view.getFloat32(0, true);
  }

  if (vtype === 'float64') {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, rawValue >>> 0, true);
    view.setUint32(4, 0, true);
    return view.getFloat64(0, true);
  }

  if (vtype === 'signed') {
    let signed = rawValue;
    if (rawValue >= (1 << (signal.bit_length - 1))) {
      signed = rawValue - (1 << signal.bit_length);
    }
    return signed * signal.scale + signal.offset;
  }

  return rawValue * signal.scale + signal.offset;
}

function physicalToRaw(physicalValue: number, signal: Signal): number {
  const vtype = signal.value_type;

  if (vtype === 'float32') {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setFloat32(0, physicalValue, true);
    return view.getUint32(0, true);
  }

  if (vtype === 'float64') {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setFloat64(0, physicalValue, true);
    return view.getUint32(0, true);
  }

  let raw = Math.trunc((physicalValue - signal.offset) / signal.scale);
  if (vtype === 'signed' && raw < 0) {
    raw += (1 << signal.bit_length);
  }
  const maxRaw = (1 << signal.bit_length) - 1;
  raw = Math.max(0, Math.min(raw, maxRaw));
  return raw;
}

function resolveEnum(rawInt: number, signal: Signal): string | null {
  if (Object.keys(signal.enum_map).length > 0) {
    return signal.enum_map[Math.round(rawInt)] ?? null;
  }
  return null;
}

function reverseEnum(name: string, signal: Signal): number | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(signal.enum_map)) {
    if (v.toLowerCase() === lower) return Number(k);
  }
  return null;
}

function resolveBitfield(rawInt: number, signal: Signal): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const [bit, name] of Object.entries(signal.bitfield_map)) {
    result[name] = Boolean(rawInt & (1 << Number(bit)));
  }
  return result;
}

function composeBitfield(flags: Record<string, boolean>, signal: Signal): number {
  let value = 0;
  const reverseMap: Record<string, number> = {};
  for (const [bit, name] of Object.entries(signal.bitfield_map)) {
    reverseMap[name.toLowerCase()] = Number(bit);
  }
  for (const [name, active] of Object.entries(flags)) {
    const bit = reverseMap[name.toLowerCase()];
    if (bit !== undefined && active) value |= (1 << bit);
  }
  return value;
}

/** Expected raw value of a `constant: true` signal, or null if it has no default. */
function constantRaw(sig: Signal): number | null {
  if (!sig.constant || sig.default_value === null) return null;
  const val = sig.default_value;
  if (Object.keys(sig.enum_map).length > 0 && typeof val === 'string') {
    return reverseEnum(val, sig);
  }
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return null;
  return physicalToRaw(num, sig);
}

/**
 * Check a frame's bytes against all `constant: true` signals of a message.
 * Returns { ok, matched }. ok is false on the first mismatch or when a
 * constant signal extends past the frame.
 */
function matchConstants(msgDef: Message, data: Uint8Array): { ok: boolean; matched: number } {
  let matched = 0;
  for (const sig of msgDef.signals) {
    const expected = constantRaw(sig);
    if (expected === null) continue;
    if (Math.floor((sig.start_bit + sig.bit_length - 1) / 8) >= data.length) {
      return { ok: false, matched: 0 };
    }
    const actual = sig.byte_order === 'big_endian'
      ? extractBitsBE(data, sig.start_bit, sig.bit_length)
      : extractBitsLE(data, sig.start_bit, sig.bit_length);
    if (actual !== expected) return { ok: false, matched };
    matched++;
  }
  return { ok: true, matched };
}

// ---------------------------------------------------------------------------
// Array signal grouping helpers
// ---------------------------------------------------------------------------

/** Group signals like name_0, name_1, ... into { baseName, indices: DecodedSignal[] } */
export function groupArraySignals(signals: DecodedSignal[]): { key: string; base: string; items: DecodedSignal[] }[] {
  const groups: { key: string; base: string; items: DecodedSignal[] }[] = [];
  const seen = new Set<string>();
  for (const sig of signals) {
    const m = sig.name.match(/^(.+)_(\d+)$/);
    if (m) {
      const base = m[1];
      if (!seen.has(base)) {
        seen.add(base);
        const members = signals.filter(s => s.name.match(new RegExp(`^${base}_\\d+$`)));
        groups.push({ key: base, base, items: members });
      }
    } else if (!seen.has(sig.name)) {
      seen.add(sig.name);
      groups.push({ key: sig.name, base: sig.name, items: [sig] });
    }
  }
  return groups;
}

/** Group Signal definitions (for encode) similarly */
export function groupArraySignalDefs(signals: Signal[]): { key: string; base: string; items: Signal[] }[] {
  const groups: { key: string; base: string; items: Signal[] }[] = [];
  const seen = new Set<string>();
  for (const sig of signals) {
    const m = sig.name.match(/^(.+)_(\d+)$/);
    if (m) {
      const base = m[1];
      if (!seen.has(base)) {
        seen.add(base);
        const members = signals.filter(s => s.name.match(new RegExp(`^${base}_\\d+$`)));
        groups.push({ key: base, base, items: members });
      }
    } else if (!seen.has(sig.name)) {
      seen.add(sig.name);
      groups.push({ key: sig.name, base: sig.name, items: [sig] });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function displayValue(s: DecodedSignal, override?: { value?: number; unit?: string }): string {
  if (s.bitfield_flags !== null) {
    const active = Object.entries(s.bitfield_flags).filter(([, v]) => v).map(([n]) => n);
    return active.length > 0 ? active.join(', ') : '(none)';
  }
  if (s.enum_name !== null) return s.enum_name;
  const unit = override?.unit ?? s.unit;
  const value = override?.value ?? s.physical_value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === Math.floor(value) && Math.abs(value) < 1e15) {
      const v = String(Math.floor(value));
      return unit ? `${v} ${unit}` : v;
    }
    const v = Number(value.toPrecision(4)).toString();
    return unit ? `${v} ${unit}` : v;
  }
  const v = String(value);
  return unit ? `${v} ${unit}` : v;
}

// ---------------------------------------------------------------------------
// MAVLink X.25 CRC (for frame building)
// ---------------------------------------------------------------------------

function mavlinkCrc(data: number[], seed = 0xFFFF): number {
  let crc = seed;
  for (const byte of data) {
    let tmp = (byte ^ (crc & 0xFF)) & 0xFF;
    tmp = (tmp ^ ((tmp << 4) & 0xFF)) & 0xFF;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF;
  }
  return crc;
}

// ---------------------------------------------------------------------------
// MAVLink v2 frame building / parsing
// ---------------------------------------------------------------------------

export function buildMavlinkV2Frame(
  msgId: number, payload: Uint8Array, crcExtra: number,
  sysId = 1, compId = 1, seq = 0
): Uint8Array {
  // Trim trailing zeros (MAVLink v2 spec)
  let trimLen = payload.length;
  while (trimLen > 1 && payload[trimLen - 1] === 0) trimLen--;
  const trimmed = payload.slice(0, trimLen);

  const frame = new Uint8Array(10 + trimmed.length + 2);
  frame[0] = 0xFD;
  frame[1] = trimmed.length;
  frame[2] = 0x00; // incompat_flags
  frame[3] = 0x00; // compat_flags
  frame[4] = seq & 0xFF;
  frame[5] = sysId & 0xFF;
  frame[6] = compId & 0xFF;
  frame[7] = msgId & 0xFF;
  frame[8] = (msgId >> 8) & 0xFF;
  frame[9] = (msgId >> 16) & 0xFF;
  frame.set(trimmed, 10);

  // CRC over bytes 1..end (excluding magic), then accumulate CRC_EXTRA
  const crcData = Array.from(frame.slice(1, 10 + trimmed.length));
  let crc = mavlinkCrc(crcData);
  crc = mavlinkCrc([crcExtra], crc);
  frame[10 + trimmed.length] = crc & 0xFF;
  frame[10 + trimmed.length + 1] = (crc >> 8) & 0xFF;

  return frame;
}

export function parseMavlinkV2Header(data: Uint8Array): {
  payloadLen: number; seq: number; sysId: number; compId: number;
  msgId: number; payload: Uint8Array;
} | null {
  if (data.length < 12 || data[0] !== 0xFD) return null;
  const payloadLen = data[1];
  if (data.length < 12 + payloadLen) return null;
  return {
    payloadLen,
    seq: data[4],
    sysId: data[5],
    compId: data[6],
    msgId: data[7] | (data[8] << 8) | (data[9] << 16),
    payload: data.slice(10, 10 + payloadLen),
  };
}

/** Split a MAVLink v2 frame into CAN FD frames (max 64 bytes each). */
export function splitMavlinkFrames(
  mavlinkCanId: number, frame: Uint8Array
): { canId: string; data: string; fdFlag: string }[] {
  const chunks: { canId: string; data: string; fdFlag: string }[] = [];
  const maxLen = 64;
  for (let offset = 0; offset < frame.length; offset += maxLen) {
    const chunk = frame.slice(offset, offset + maxLen);
    const fdFlag = chunk.length > 8 ? '##1' : '#';
    chunks.push({
      canId: mavlinkCanId.toString(16).toUpperCase().padStart(8, '0'),
      data: Array.from(chunk).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(''),
      fdFlag,
    });
  }
  return chunks;
}

/** Reassemble multiple CAN FD frame payloads into one MAVLink v2 frame. */
export function reassembleMavlinkFrames(frames: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const f of frames) total += f.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) { result.set(f, offset); offset += f.length; }
  return result;
}

export interface MavlinkBuf {
  frames: Uint8Array[];
  timestamps: number[];
  expectedTotal: number;
  currentLength: number;
  is_fd: boolean;
}

/**
 * Stateful reassembler for multi-frame MAVLink-over-CAN messages.
 *
 * Continuation CAN frames carry no identifier, so when two MAVLink messages
 * are in flight at the same CAN ID, continuation frames are assigned to the
 * oldest incomplete buffer (FIFO). Completion is detected from the 0xFD
 * header's payload_len field (total wire length = 12 + payload_len).
 */
export class MavlinkReassembler {
  private buffers: Map<number, MavlinkBuf[]> = new Map();

  /** Feed one CAN frame's payload. Returns any buffers that just completed. */
  feed(canId: number, data: Uint8Array, timestamp = 0, is_fd = false): MavlinkBuf[] {
    if (data.length === 0) return [];
    const complete: MavlinkBuf[] = [];
    const isStart = data[0] === 0xFD;

    if (isStart) {
      const payloadLen = data[1] ?? 0;
      const expectedTotal = 12 + payloadLen;
      const buf: MavlinkBuf = {
        frames: [data],
        timestamps: [timestamp],
        expectedTotal,
        currentLength: data.length,
        is_fd,
      };
      if (buf.currentLength >= expectedTotal) {
        complete.push(buf);
      } else {
        const list = this.buffers.get(canId) ?? [];
        list.push(buf);
        this.buffers.set(canId, list);
      }
    } else {
      const list = this.buffers.get(canId);
      if (list && list.length > 0) {
        const buf = list[0];
        buf.frames.push(data);
        buf.timestamps.push(timestamp);
        buf.currentLength += data.length;
        if (buf.currentLength >= buf.expectedTotal) {
          complete.push(buf);
          list.shift();
          if (list.length === 0) this.buffers.delete(canId);
        }
      }
    }
    return complete;
  }

  /** Drop in-flight state and return whatever was pending (incomplete buffers). */
  flush(): { canId: number; buf: MavlinkBuf }[] {
    const out: { canId: number; buf: MavlinkBuf }[] = [];
    for (const [canId, list] of this.buffers) {
      for (const buf of list) out.push({ canId, buf });
    }
    this.buffers.clear();
    return out;
  }

  /** Number of in-flight buffers across all canIds. */
  pendingCount(): number {
    let n = 0;
    for (const list of this.buffers.values()) n += list.length;
    return n;
  }
}

// ---------------------------------------------------------------------------
// Candump parser
// ---------------------------------------------------------------------------

export interface CandumpFrame {
  interface: string;
  canId: number;
  data: Uint8Array;
  isFD: boolean;
  isExtended: boolean;
  timestamp?: number;
}

/**
 * Parse a candump/cansend line.
 * Formats:
 *   vcan0 101#E803050000000000                              (classic CAN)
 *   vcan0 00010101##1FD01000000...                          (CAN FD, ##1 = BRS flag)
 *   (timestamp) vcan0 101 [8] E8 03 05                      (candump -l format)
 *   (timestamp) can0 TX B - 00010101 [35] FD 55 00 ...      (direction/flag variant)
 */
export function parseCandump(line: string): CandumpFrame | null {
  let trimmed = line.trim();
  if (!trimmed) return null;

  // Extract a leading "(NUMBER.NUMBER)" timestamp if present, before running the
  // body regex. The body parsers won't see it. Done here because some candump
  // variants insert direction/flag tokens (e.g. "TX B -") between iface and ID,
  // which would otherwise force the body regex to backtrack past the timestamp.
  let ts: number | undefined;
  const tsMatch = trimmed.match(/^\((\d+(?:\.\d+)?)\)\s+(.+)$/);
  if (tsMatch) {
    ts = parseFloat(tsMatch[1]);
    trimmed = tsMatch[2];
  }

  // Format: interface ID#DATA or interface ID##FDATA
  const cansendMatch = trimmed.match(
    /^(\S+)\s+([0-9A-Fa-f]+)(##([01]))?#?([0-9A-Fa-f]*)$/
  );
  if (cansendMatch) {
    const iface = cansendMatch[1];
    const idStr = cansendMatch[2];
    const isFD = cansendMatch[3] !== undefined;
    const hexData = cansendMatch[5] || '';
    const canId = parseInt(idStr, 16);
    const bytes = new Uint8Array(hexData.length / 2);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = parseInt(hexData.slice(i * 2, i * 2 + 2), 16);
    return { interface: iface, canId, data: bytes, isFD, isExtended: idStr.length > 3, timestamp: ts };
  }

  // Format: interface [optional direction/flag tokens] ID [DLC] HH HH HH ...
  // The (?:\S+\s+){0,4} chunk absorbs up to 4 short non-ID tokens like "TX B -".
  const candumpMatch = trimmed.match(
    /^(\S+)\s+(?:\S+\s+){0,4}([0-9A-Fa-f]{3,8})\s+\[(\d+)\]\s+((?:[0-9A-Fa-f]{2}\s*)+)/
  );
  if (candumpMatch) {
    const iface = candumpMatch[1];
    const canId = parseInt(candumpMatch[2], 16);
    const hexParts = candumpMatch[4].trim().split(/\s+/);
    const bytes = new Uint8Array(hexParts.map(h => parseInt(h, 16)));
    return { interface: iface, canId, data: bytes, isFD: bytes.length > 8, isExtended: candumpMatch[2].length > 3, timestamp: ts };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API: decode / encode
// ---------------------------------------------------------------------------

export function decode(msgDef: Message, data: Uint8Array, actualId?: number, nodeId: number = 0): DecodedMessage {
  const decodedSignals: DecodedSignal[] = [];

  for (const sig of msgDef.signals) {
    const raw = sig.byte_order === 'big_endian'
      ? extractBitsBE(data, sig.start_bit, sig.bit_length)
      : extractBitsLE(data, sig.start_bit, sig.bit_length);

    const physical = rawToPhysical(raw, sig);
    const enumName = Object.keys(sig.enum_map).length > 0 ? resolveEnum(raw, sig) : null;
    const bitfield = Object.keys(sig.bitfield_map).length > 0 ? resolveBitfield(raw, sig) : null;

    decodedSignals.push({
      name: sig.name, raw_value: raw, physical_value: physical,
      enum_name: enumName, bitfield_flags: bitfield,
      unit: sig.unit, description: sig.description,
    });
  }

  return {
    msg_id: actualId ?? msgDef.id,
    name: msgDef.name, description: msgDef.description,
    signals: decodedSignals, raw_data: Array.from(data), node_id: nodeId,
  };
}

export function encode(msgDef: Message, values: Record<string, string | number | Record<string, boolean>>): Uint8Array {
  const byteCount = dlcToBytes(msgDef.dlc);
  const data = new Uint8Array(byteCount);

  for (const sig of msgDef.signals) {
    let val: string | number | Record<string, boolean> | null;
    if (sig.constant) {
      if (sig.default_value === null) continue;
      val = sig.default_value;
    } else if (sig.name in values) {
      val = values[sig.name];
    } else if (sig.default_value !== null) {
      val = sig.default_value;
    } else {
      continue;
    }

    let raw: number;
    if (Object.keys(sig.bitfield_map).length > 0 && typeof val === 'object' && val !== null) {
      raw = composeBitfield(val as Record<string, boolean>, sig);
    } else if (Object.keys(sig.enum_map).length > 0 && typeof val === 'string') {
      const r = reverseEnum(val, sig);
      if (r === null) throw new Error(`Unknown enum value '${val}' for signal '${sig.name}'. Valid: ${Object.values(sig.enum_map).join(', ')}`);
      raw = r;
    } else {
      const num = typeof val === 'number' ? val : Number(val);
      if (isNaN(num)) {
        // Don't silently pack NaN bits — that's how forgotten variable references end up
        // sending garbage onto the bus. Hint at the most likely cause.
        const hint = typeof val === 'string'
          ? ` (did you mean '=${val}' to evaluate as a variable / expression?)`
          : '';
        throw new Error(`Invalid value '${val}' for signal '${sig.name}': not a number${hint}`);
      }
      raw = physicalToRaw(num, sig);
    }

    if (sig.byte_order === 'big_endian') {
      packBitsBE(data, sig.start_bit, sig.bit_length, raw);
    } else {
      packBitsLE(data, sig.start_bit, sig.bit_length, raw);
    }
  }

  return data;
}

function dlcToBytes(dlc: number): number {
  if (dlc <= 8) return dlc;
  const mapping: Record<number, number> = { 12: 12, 16: 16, 20: 20, 24: 24, 32: 32, 48: 48, 64: 64 };
  return mapping[dlc] ?? dlc;
}

export function getIdForNode(msg: Message, nodeId: number): number {
  if (msg.node_count <= 1) return msg.id;
  return msg.id + nodeId * msg.node_id_offset;
}

function getNodeForId(msg: Message, canId: number): number | null {
  if (msg.node_count <= 1) return canId === msg.id ? msg.node_id_start : null;
  const offset = canId - msg.id;
  if (msg.node_id_offset === 0) return offset === 0 ? msg.node_id_start : null;
  if (offset % msg.node_id_offset !== 0) return null;
  const nodeId = Math.floor(offset / msg.node_id_offset);
  // Check broadcast address
  if (msg.broadcast_node_id !== null && nodeId === msg.broadcast_node_id) return msg.broadcast_node_id;
  const maxNodeId = msg.node_id_start + msg.node_count - 1;
  return (nodeId >= msg.node_id_start && nodeId <= maxNodeId) ? nodeId : null;
}

// ---------------------------------------------------------------------------
// Broadcast encode / decode
// ---------------------------------------------------------------------------

function encodeBroadcastFrame(
  msgDef: Message,
  perNodeValues: Map<number, Record<string, string | number | Record<string, boolean>>>
): Uint8Array {
  const byteCount = dlcToBytes(msgDef.dlc);
  const segments: Uint8Array[] = [];
  for (let i = 0; i < msgDef.node_count; i++) {
    const nodeId = msgDef.node_id_start + i;
    const values = perNodeValues.get(nodeId) ?? {};
    segments.push(encode(msgDef, values));
  }
  const result = new Uint8Array(byteCount * msgDef.node_count);
  let offset = 0;
  for (const seg of segments) {
    result.set(seg, offset);
    offset += byteCount;
  }
  return result;
}

function decodeBroadcastFrame(msgDef: Message, data: Uint8Array, actualId: number): DecodedMessage {
  const byteCount = dlcToBytes(msgDef.dlc);
  const subMessages: DecodedMessage[] = [];
  for (let i = 0; i < msgDef.node_count; i++) {
    const nodeId = msgDef.node_id_start + i;
    let segment = data.slice(i * byteCount, (i + 1) * byteCount);
    if (segment.length < byteCount) {
      const padded = new Uint8Array(byteCount);
      padded.set(segment);
      segment = padded;
    }
    const sub = decode(msgDef, segment, getIdForNode(msgDef, nodeId), nodeId);
    subMessages.push(sub);
  }
  return {
    msg_id: actualId,
    name: msgDef.name,
    description: msgDef.description,
    signals: [],
    raw_data: Array.from(data),
    node_id: msgDef.broadcast_node_id ?? 0,
    is_broadcast: true,
    sub_messages: subMessages,
  };
}

// ---------------------------------------------------------------------------
// Codec manager
// ---------------------------------------------------------------------------

export class Codec {
  devices: DeviceConfig[] = [];
  private byId: Map<number, { device: DeviceConfig; message: Message }> = new Map();
  private byMavlinkId: Map<number, { device: DeviceConfig; message: Message }> = new Map();
  private byName: Map<string, { device: DeviceConfig; message: Message }> = new Map();
  private multiNodeMessages: { device: DeviceConfig; message: Message }[] = [];

  addDevice(config: DeviceConfig): void {
    this.devices.push(config);
    this.rebuildLookups();
  }

  private rebuildLookups(): void {
    this.byId.clear();
    this.byMavlinkId.clear();
    this.byName.clear();
    this.multiNodeMessages = [];
    for (const dev of this.devices) {
      const idMap = dev.mavlink ? this.byMavlinkId : this.byId;
      for (const msg of dev.messages) {
        if (msg.node_count > 1) {
          this.multiNodeMessages.push({ device: dev, message: msg });
        } else {
          if (!idMap.has(msg.id)) idMap.set(msg.id, { device: dev, message: msg });
        }
        if (!this.byName.has(msg.name)) this.byName.set(msg.name, { device: dev, message: msg });
      }
    }
  }

  private findMessageById(
    msgId: number, dlc?: number, data?: Uint8Array
  ): { device: DeviceConfig; message: Message; nodeId: number } | null {
    const entry = this.byId.get(msgId);
    if (entry) return { ...entry, nodeId: 0 };
    let candidates: { device: DeviceConfig; message: Message; nodeId: number }[] = [];
    for (const { device, message } of this.multiNodeMessages) {
      const nodeId = getNodeForId(message, msgId);
      if (nodeId !== null) candidates.push({ device, message, nodeId });
    }
    if (candidates.length === 0) return null;
    if (dlc !== undefined) {
      const dlcMatches = candidates.filter(c => c.message.dlc === dlc);
      if (dlcMatches.length > 0) candidates = dlcMatches;
    }
    // If multiple messages share the same ID + DLC, use `constant: true`
    // signals as discriminators: reject any candidate whose constants don't
    // match the frame bytes, then prefer the one with the most matches.
    if (data !== undefined && candidates.length > 1) {
      const scored: { matched: number; cand: typeof candidates[0] }[] = [];
      for (const c of candidates) {
        const { ok, matched } = matchConstants(c.message, data);
        if (ok) scored.push({ matched, cand: c });
      }
      if (scored.length > 0) {
        scored.sort((a, b) => b.matched - a.matched);
        return scored[0].cand;
      }
    }
    return candidates[0];
  }

  /** Check if a message name belongs to a MAVLink device config. */
  isMavlinkMessage(msgName: string): boolean {
    const entry = this.byName.get(msgName);
    return entry?.device.mavlink ?? false;
  }

  /** Get device name for a message. */
  getDeviceForMessage(msgName: string): string | null {
    return this.byName.get(msgName)?.device.name ?? null;
  }

  /** Get CRC_EXTRA for a MAVLink message (needed for frame building). */
  getCrcExtra(msgName: string): number | null {
    const entry = this.byName.get(msgName);
    return entry?.message.crc_extra ?? null;
  }

  decode(msgId: number, data: Uint8Array, dlc?: number): DecodedMessage | null {
    const result = this.findMessageById(msgId, dlc ?? data.length, data);
    if (!result) return null;
    // Broadcast frame detection
    if (result.message.broadcast_node_id !== null && result.nodeId === result.message.broadcast_node_id) {
      return decodeBroadcastFrame(result.message, data, msgId);
    }
    let paddedData = data;
    if (data.length < result.message.dlc) {
      paddedData = new Uint8Array(result.message.dlc);
      paddedData.set(data);
    }
    return decode(result.message, paddedData, msgId, result.nodeId);
  }

  /**
   * Smart decode: auto-detects MAVLink CAN transport.
   * If CAN ID has bit 16 set and data starts with 0xFD, treats as MAVLink.
   * Supports multi-frame reassembly: pass all frame payloads for large messages.
   */
  smartDecode(canId: number, data: Uint8Array, dlc?: number): {
    decoded: DecodedMessage; mavlink?: MavlinkInfo;
  } | null {
    const isMavlinkTransport = (canId & 0x10000) !== 0 && data.length > 0 && data[0] === 0xFD;

    if (isMavlinkTransport) {
      const mavlink: MavlinkInfo = {
        sys_id: (canId >> 8) & 0xFF,
        comp_id: canId & 0xFF,
      };
      const hdr = parseMavlinkV2Header(data);
      if (!hdr) return null;
      mavlink.seq = hdr.seq;
      mavlink.frame_sys_id = hdr.sysId;
      mavlink.frame_comp_id = hdr.compId;
      mavlink.msg_id = hdr.msgId;
      const entry = this.byMavlinkId.get(hdr.msgId);
      if (!entry) return null;
      let paddedPayload = hdr.payload;
      if (hdr.payload.length < entry.message.dlc) {
        paddedPayload = new Uint8Array(entry.message.dlc);
        paddedPayload.set(hdr.payload);
      }
      const decoded = decode(entry.message, paddedPayload, canId, 0);
      return { decoded, mavlink };
    }

    const decoded = this.decode(canId, data, dlc);
    if (!decoded) return null;
    return { decoded };
  }

  /** Decode a MAVLink message split across multiple CAN FD frames (same CAN ID). */
  smartDecodeMultiFrame(canId: number, frames: Uint8Array[]): {
    decoded: DecodedMessage; mavlink?: MavlinkInfo;
  } | null {
    if (frames.length === 1) return this.smartDecode(canId, frames[0]);
    const reassembled = reassembleMavlinkFrames(frames);
    return this.smartDecode(canId, reassembled);
  }

  encode(msgName: string, values: Record<string, string | number | Record<string, boolean>>, nodeId: number = 0): { canId: number; data: Uint8Array } {
    const entry = this.byName.get(msgName);
    if (!entry) throw new Error(`Unknown message '${msgName}'. Available: ${Array.from(this.byName.keys()).sort().join(', ')}`);
    const data = encode(entry.message, values);
    const canId = getIdForNode(entry.message, nodeId);
    return { canId, data };
  }

  /**
   * Encode a broadcast frame with per-node values.
   * Returns { canId, data } where data is the concatenated payload of all nodes.
   */
  encodeBroadcast(
    msgName: string,
    perNodeValues: Map<number, Record<string, string | number | Record<string, boolean>>>
  ): { canId: number; data: Uint8Array } {
    const entry = this.byName.get(msgName);
    if (!entry) throw new Error(`Unknown message '${msgName}'.`);
    const msg = entry.message;
    if (msg.broadcast_node_id === null) throw new Error(`Message '${msgName}' does not support broadcast mode.`);
    const data = encodeBroadcastFrame(msg, perNodeValues);
    const canId = getIdForNode(msg, msg.broadcast_node_id);
    return { canId, data };
  }

  /**
   * Encode a MAVLink message: builds the MAVLink v2 frame and splits into CAN FD frames.
   * Returns cansend-format strings ready for use.
   */
  encodeMavlink(
    msgName: string,
    values: Record<string, string | number | Record<string, boolean>>,
    sysId = 1, compId = 1, seq = 0
  ): { frames: { canId: string; data: string; fdFlag: string }[]; rawPayload: Uint8Array } {
    const entry = this.byName.get(msgName);
    if (!entry) throw new Error(`Unknown message '${msgName}'.`);
    if (!entry.device.mavlink) throw new Error(`'${msgName}' is not a MAVLink message.`);
    const crcExtra = entry.message.crc_extra;
    if (crcExtra === undefined || crcExtra === null) throw new Error(`No CRC_EXTRA for '${msgName}'.`);

    const payload = encode(entry.message, values);
    const frame = buildMavlinkV2Frame(entry.message.id, payload, crcExtra, sysId, compId, seq);
    const mavCanId = 0x10000 | ((sysId & 0xFF) << 8) | (compId & 0xFF);
    const frames = splitMavlinkFrames(mavCanId, frame);
    return { frames, rawPayload: payload };
  }

  listMessages(): MessageInfo[] {
    const result: MessageInfo[] = [];
    for (const dev of this.devices) {
      for (const msg of dev.messages) {
        const isMavlink = dev.mavlink;
        const info: MessageInfo = {
          device: dev.name,
          id: isMavlink ? `MAV:${msg.id}` : `0x${msg.id.toString(16).toUpperCase().padStart(3, '0')}`,
          name: msg.name,
          direction: msg.direction,
          dlc: msg.dlc,
          fd: dev.fd,
          mavlink: isMavlink,
          signals: msg.signals.map((s) => s.name),
          description: msg.description,
        };
        if (msg.node_count > 1) {
          info.node_count = msg.node_count;
          info.node_id_offset = msg.node_id_offset;
          info.node_id_start = msg.node_id_start;
          const maxNodeId = msg.node_id_start + msg.node_count - 1;
          const maxId = getIdForNode(msg, maxNodeId);
          info.id_range = `0x${msg.id.toString(16).toUpperCase().padStart(3, '0')}-0x${maxId.toString(16).toUpperCase().padStart(3, '0')}`;
          info.node_range = `${msg.node_id_start}-${maxNodeId}`;
          if (msg.broadcast_node_id !== null) {
            const bcastId = getIdForNode(msg, msg.broadcast_node_id);
            info.broadcast_id = `0x${bcastId.toString(16).toUpperCase().padStart(3, '0')}`;
          }
        }
        result.push(info);
      }
    }
    return result;
  }

  getMessageByName(name: string): Message | null {
    return this.byName.get(name)?.message ?? null;
  }

  getMessageNames(): string[] {
    return Array.from(this.byName.keys()).sort();
  }

  /** Get message names grouped by device. */
  getMessagesByDevice(): { device: string; mavlink: boolean; messages: string[] }[] {
    const groups: Map<string, { mavlink: boolean; messages: string[] }> = new Map();
    for (const dev of this.devices) {
      if (!groups.has(dev.name)) groups.set(dev.name, { mavlink: dev.mavlink, messages: [] });
      for (const msg of dev.messages) {
        groups.get(dev.name)!.messages.push(msg.name);
      }
    }
    return Array.from(groups.entries()).map(([device, g]) => ({
      device, mavlink: g.mavlink, messages: g.messages.sort(),
    }));
  }
}
