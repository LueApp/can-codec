/**
 * YAML config loader for the browser.
 * Parses YAML device configs into DeviceConfig objects.
 */

import yaml from 'js-yaml';
import type { Signal, Message, DeviceConfig } from './types';

function resolveParams(raw: Record<string, unknown>, params: Record<string, number>): Record<string, unknown> {
  const resolved = { ...raw };
  for (const key of ['min', 'max', 'scale', 'offset']) {
    const val = resolved[key];
    if (typeof val === 'string') {
      let negate = false;
      let ref = val;
      if (ref.startsWith('-$')) {
        negate = true;
        ref = ref.slice(1);
      }
      if (ref.startsWith('$')) {
        const paramName = ref.slice(1);
        if (paramName in params) {
          resolved[key] = negate ? -params[paramName] : params[paramName];
        }
      }
    }
  }
  return resolved;
}

function parseSignal(raw: Record<string, unknown>, params?: Record<string, number>): Signal {
  if (params) raw = resolveParams(raw, params);
  const bitLength = raw['bit_length'] as number;
  const valueType = (raw['value_type'] as string) ?? 'unsigned';

  let scale = (raw['scale'] as number) ?? 1.0;
  let offset = (raw['offset'] as number) ?? 0.0;
  const minVal = (raw['min'] as number) ?? null;
  const maxVal = (raw['max'] as number) ?? null;

  const isLinearMap = (raw['linear_map'] as boolean) ?? false;
  if (isLinearMap && minVal !== null && maxVal !== null) {
    let maxRaw: number, minRaw: number;
    if (valueType === 'signed') {
      maxRaw = (1 << (bitLength - 1)) - 1;
      minRaw = -(1 << (bitLength - 1));
    } else {
      maxRaw = (1 << bitLength) - 1;
      minRaw = 0;
    }
    const rawRange = maxRaw - minRaw;
    if (rawRange !== 0) {
      scale = (maxVal - minVal) / rawRange;
      offset = minVal - minRaw * scale;
    }
  }

  const byteOrder = (raw['byte_order'] as string) ?? (isLinearMap ? 'big_endian' : 'little_endian');

  const enumMap: Record<number, string> = {};
  if (raw['enum'] && typeof raw['enum'] === 'object') {
    for (const [k, v] of Object.entries(raw['enum'] as Record<string, string>)) {
      enumMap[Number(k)] = String(v);
    }
  }

  const bitfieldMap: Record<number, string> = {};
  if (raw['bitfield'] && typeof raw['bitfield'] === 'object') {
    for (const [k, v] of Object.entries(raw['bitfield'] as Record<string, string>)) {
      bitfieldMap[Number(k)] = String(v);
    }
  }

  return {
    name: raw['name'] as string,
    start_bit: raw['start_bit'] as number,
    bit_length: bitLength,
    byte_order: byteOrder as 'little_endian' | 'big_endian',
    value_type: valueType as Signal['value_type'],
    scale,
    offset,
    min_val: minVal,
    max_val: maxVal,
    unit: (raw['unit'] as string) ?? '',
    description: (raw['description'] as string) ?? '',
    enum_map: enumMap,
    bitfield_map: bitfieldMap,
    default_value: (raw['default'] as string | number) ?? null,
    constant: (raw['constant'] as boolean) ?? false,
  };
}

function parseMessage(raw: Record<string, unknown>, params?: Record<string, number>): Message {
  let msgId = raw['id'];
  if (typeof msgId === 'string') {
    msgId = parseInt(msgId, 0);
  }

  const signals: Signal[] = [];
  if (Array.isArray(raw['signals'])) {
    for (const sigRaw of raw['signals'] as Record<string, unknown>[]) {
      signals.push(parseSignal(sigRaw, params));
    }
  }

  let broadcastNodeId: number | null = null;
  const broadcastRaw = raw['broadcast_node_id'];
  if (broadcastRaw !== undefined && broadcastRaw !== null) {
    broadcastNodeId = typeof broadcastRaw === 'string' ? parseInt(broadcastRaw, 0) : Number(broadcastRaw);
  }

  return {
    id: msgId as number,
    name: raw['name'] as string,
    direction: ((raw['direction'] as string) ?? 'tx') as 'tx' | 'rx',
    dlc: (raw['dlc'] as number) ?? 8,
    description: (raw['description'] as string) ?? '',
    node_id_offset: (raw['node_id_offset'] as number) ?? 1,
    node_count: (raw['node_count'] as number) ?? 1,
    node_id_start: (raw['node_id_start'] as number) ?? 0,
    broadcast_node_id: broadcastNodeId,
    signals,
    mux_signal: (raw['mux_signal'] as string) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// MAVLink XML parser (browser DOMParser port of mavlink_loader.py)
// ---------------------------------------------------------------------------

const MAVLINK_TYPES: Record<string, [number, Signal['value_type'], number]> = {
  uint8_t:  [8,  'unsigned', 1],
  int8_t:   [8,  'signed',   1],
  uint16_t: [16, 'unsigned', 2],
  int16_t:  [16, 'signed',   2],
  uint32_t: [32, 'unsigned', 4],
  int32_t:  [32, 'signed',   4],
  uint64_t: [64, 'unsigned', 8],
  int64_t:  [64, 'signed',   8],
  float:    [32, 'float32',  4],
  double:   [64, 'float64',  8],
  char:     [8,  'unsigned', 1],
};

function mavlinkCrc(data: number[], seed = 0xFFFF): number {
  let crc = seed;
  for (const byte of data) {
    let tmp = (byte ^ (crc & 0xFF)) & 0xFF;
    tmp = (tmp ^ ((tmp << 4) & 0xFF)) & 0xFF;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF;
  }
  return crc;
}

function strBytes(s: string): number[] {
  return Array.from(s).map(c => c.charCodeAt(0));
}

function computeCrcExtra(msgName: string, wireFields: { base_type: string; name: string; array_count: number }[]): number {
  let crc = mavlinkCrc(strBytes(msgName + ' '));
  for (const f of wireFields) {
    crc = mavlinkCrc(strBytes(f.base_type + ' '), crc);
    crc = mavlinkCrc(strBytes(f.name + ' '), crc);
    if (f.array_count > 1) crc = mavlinkCrc([f.array_count], crc);
  }
  return (crc & 0xFF) ^ (crc >> 8);
}

function parseEnums(doc: Document): Record<string, Record<number, string>> {
  const enums: Record<string, Record<number, string>> = {};
  for (const enumEl of Array.from(doc.querySelectorAll('enums > enum'))) {
    const enumName = enumEl.getAttribute('name');
    if (!enumName) continue;
    const values: Record<number, string> = {};
    for (const entry of Array.from(enumEl.querySelectorAll('entry'))) {
      const val = entry.getAttribute('value');
      const name = entry.getAttribute('name');
      if (val !== null && name) {
        let short = name.startsWith(enumName + '_') ? name.slice(enumName.length + 1) : name;
        values[Number(val)] = short.toLowerCase();
      }
    }
    enums[enumName] = values;
  }
  return enums;
}

export function parseMavlinkXml(xmlText: string, filename: string = 'unknown'): DeviceConfig {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML');

  const enums = parseEnums(doc);
  const messages: Message[] = [];

  for (const msgEl of Array.from(doc.querySelectorAll('messages > message'))) {
    const msgId = msgEl.getAttribute('id');
    const msgName = msgEl.getAttribute('name');
    if (!msgId || !msgName) continue;

    const description = msgEl.querySelector('description')?.textContent?.trim() ?? '';

    // Collect raw fields
    const rawFields: { name: string; base_type: string; bit_length: number; value_type: Signal['value_type']; array_count: number; wire_size: number; enum_map: Record<number, string>; description: string }[] = [];

    for (const fieldEl of Array.from(msgEl.querySelectorAll('field'))) {
      const typeStr = fieldEl.getAttribute('type') ?? '';
      const fieldName = fieldEl.getAttribute('name') ?? '';
      const fieldEnum = fieldEl.getAttribute('enum') ?? '';
      const fieldDesc = fieldEl.textContent?.trim() ?? '';

      const arrayMatch = typeStr.match(/^(\w+)\[(\d+)\]$/);
      const baseType = arrayMatch ? arrayMatch[1] : typeStr;
      const arrayCount = arrayMatch ? parseInt(arrayMatch[2]) : 1;

      const typeInfo = MAVLINK_TYPES[baseType];
      if (!typeInfo) continue;
      const [bit_length, value_type, wire_size] = typeInfo;

      rawFields.push({
        name: fieldName,
        base_type: baseType,
        bit_length,
        value_type,
        array_count: arrayCount,
        wire_size,
        enum_map: fieldEnum && enums[fieldEnum] ? enums[fieldEnum] : {},
        description: fieldDesc,
      });
    }

    // MAVLink wire ordering: largest type first (stable sort)
    const wireFields = [...rawFields].sort((a, b) => b.wire_size - a.wire_size);
    const crc_extra = computeCrcExtra(msgName, wireFields);

    // Build signals with sequential bit offsets
    const signals: Signal[] = [];
    let bitOffset = 0;
    for (const f of wireFields) {
      for (let i = 0; i < f.array_count; i++) {
        signals.push({
          name: f.array_count > 1 ? `${f.name}_${i}` : f.name,
          start_bit: bitOffset,
          bit_length: f.bit_length,
          byte_order: 'little_endian',
          value_type: f.value_type,
          scale: 1, offset: 0, min_val: null, max_val: null,
          unit: '',
          description: f.array_count > 1 ? `${f.description} [${i}]` : f.description,
          enum_map: { ...f.enum_map },
          bitfield_map: {},
          default_value: null,
          constant: false,
        });
        bitOffset += f.bit_length;
      }
    }

    messages.push({
      id: Number(msgId),
      name: msgName,
      direction: 'tx',
      dlc: Math.ceil(bitOffset / 8),
      description,
      node_id_offset: 1,
      node_count: 1,
      node_id_start: 0,
      broadcast_node_id: null,
      signals,
      crc_extra,
    });
  }

  const stem = filename.replace(/\.xml$/, '');
  return { name: stem, version: 'MAVLink', description: `MAVLink messages from ${filename}`, bus: 'vcan0', fd: true, mavlink: true, messages };
}

export function parseConfig(content: string, filename: string): DeviceConfig {
  if (filename.endsWith('.xml')) return parseMavlinkXml(content, filename);
  return parseYamlConfig(content, filename);
}

export function parseYamlConfig(yamlText: string, filename: string = 'unknown'): DeviceConfig {
  const raw = yaml.load(yamlText) as Record<string, unknown>;

  const devRaw = (raw['device'] as Record<string, unknown>) ?? {};
  const params = raw['parameters'] as Record<string, number> | undefined;

  const messages: Message[] = [];
  if (Array.isArray(raw['messages'])) {
    for (const msgRaw of raw['messages'] as Record<string, unknown>[]) {
      messages.push(parseMessage(msgRaw, params));
    }
  }

  return {
    name: (devRaw['name'] as string) ?? filename.replace(/\.(yaml|yml)$/, ''),
    version: (devRaw['version'] as string) ?? '',
    description: (devRaw['description'] as string) ?? '',
    bus: (devRaw['bus'] as string) ?? 'vcan0',
    fd: (devRaw['fd'] as boolean) ?? true,
    mavlink: false,
    messages,
  };
}

const CONFIG_STORAGE_KEY = 'cancodec_configs';

export interface MessageFilter {
  disabledNodes: number[];
  disabledSignals: string[];
  disabledEnumValues: Record<string, string[]>;
}

export interface StoredConfig {
  filename: string;
  content: string;
  enabled: boolean;
  disabledMessages: string[];
  messageFilters: Record<string, MessageFilter>;
}

export function saveConfigsToStorage(configs: StoredConfig[]): void {
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(configs));
  } catch {
    // Storage full or unavailable
  }
}

export function loadConfigsFromStorage(): StoredConfig[] {
  try {
    const data = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (data) {
      const parsed = JSON.parse(data) as Array<Record<string, unknown>>;
      return parsed.map((c) => ({
        filename: c.filename as string,
        content: c.content as string,
        enabled: c.enabled !== false,
        disabledMessages: Array.isArray(c.disabledMessages) ? c.disabledMessages as string[] : [],
        messageFilters: (c.messageFilters as Record<string, MessageFilter>) ?? {},
      }));
    }
  } catch {
    // Ignore
  }
  return [];
}
