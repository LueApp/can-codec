/** Pure browser codec gateway. No protocol interpretation is delegated to the bridge. */
import { decode, encode, getIdForNode, matchConstants, dlcToBytes } from './codec.ts';
import type { DeviceConfig, Message } from './types';

export interface SimulatorBinding {
  device: string;
  protocol: string;
  node: number;
  extended?: boolean;
  bitrate_switch?: boolean;
  inputs?: string[];
  outputs?: string[];
}
export interface GatewayConfig {
  version: 1;
  bindings: SimulatorBinding[];
  protocols: Record<string, DeviceConfig>;
}
export interface WireFrame {
  arbitration_id: number;
  data: string;
  is_fd: boolean;
  is_extended_id?: boolean;
  is_remote_frame?: boolean;
  is_error_frame?: boolean;
  direction?: string;
  origin?: string;
  timestamp?: number;
}

function bytes(hex: string): Uint8Array {
  if (!/^(?:[\da-f]{2})*$/i.test(hex)) throw new Error('Malformed frame hex');
  return Uint8Array.from(hex.match(/../g) ?? [], v => parseInt(v, 16));
}

export class SimulatorGateway {
  private request = 0;
  private config: GatewayConfig;

  constructor(config: GatewayConfig) {
    this.config = structuredClone(config);
    if (config.version !== 1 || !config.bindings?.length) throw new Error('Version 1 and at least one device binding are required');
    const devices = new Set<string>();
    const addresses = new Set<string>();
    for (const binding of config.bindings) {
      if (!binding.device || devices.has(binding.device)) throw new Error(`Duplicate/empty device: ${binding.device}`);
      devices.add(binding.device);
      const protocol = config.protocols[binding.protocol];
      if (!protocol) throw new Error(`Unknown protocol file: ${binding.protocol}`);
      if (protocol.mavlink) throw new Error('Simulator routing currently requires direct CAN messages; MAVLink transport is not enabled');
      if (!Number.isInteger(binding.node)) throw new Error('Node must be an integer');
      for (const message of protocol.messages) {
        if (message.node_count > 1 && (binding.node < message.node_id_start || binding.node >= message.node_id_start + message.node_count)) {
          throw new Error(`${binding.device}: node outside ${message.name} range`);
        }
        for (const selected of [...(binding.inputs ?? []), ...(binding.outputs ?? [])]) {
          if (!protocol.messages.some(m => m.name === selected)) throw new Error(`Unknown selected message ${selected}`);
        }
      }
      // Overlapping IDs within one device (constant command discriminators) are valid.
      for (const id of new Set(protocol.messages.filter(m => this.isInput(binding, m))
          .map(m => getIdForNode(m, binding.node)))) {
        const key = `${binding.extended ?? id > 0x7ff}:${id}`;
        if (addresses.has(key)) throw new Error(`Overlapping device input address: ${key}`);
        addresses.add(key);
      }
    }
  }

  private isInput(binding: SimulatorBinding, message: Message) {
    return binding.inputs ? binding.inputs.includes(message.name) : message.direction === 'tx';
  }
  private isOutput(binding: SimulatorBinding, message: Message) {
    return binding.outputs ? binding.outputs.includes(message.name) : message.direction === 'rx';
  }

  definitions() {
    return { type: 'definitions', version: 1, devices: this.config.bindings.map(binding => {
      const protocol = this.config.protocols[binding.protocol];
      const fields = (message: Message) => Object.fromEntries(message.signals.map(s => [s.name, {
        type: s.value_type.startsWith('float') || s.scale !== 1 || s.offset !== 0 ? 'number' : 'integer',
        unit: s.unit, default: s.default_value, constant: s.constant,
      }]));
      return { device: binding.device,
        inputs: Object.fromEntries(protocol.messages.filter(m => this.isInput(binding, m)).map(m => [m.name, fields(m)])),
        outputs: Object.fromEntries(protocol.messages.filter(m => this.isOutput(binding, m)).map(m => [m.name, fields(m)])),
      };
    }) };
  }

  receive(frame: WireFrame) {
    if (frame.origin === 'simulator' || frame.is_remote_frame || frame.is_error_frame) return [];
    const data = bytes(frame.data);
    const results = [];
    for (const binding of this.config.bindings) {
      const protocol = this.config.protocols[binding.protocol];
      if (protocol.fd !== frame.is_fd) continue;
      const candidates = protocol.messages.filter(m => {
        if (!this.isInput(binding, m)) return false;
        const extended = binding.extended ?? getIdForNode(m, binding.node) > 0x7ff;
        if (extended !== (frame.is_extended_id ?? frame.arbitration_id > 0x7ff)) return false;
        const addressed = getIdForNode(m, binding.node) === frame.arbitration_id;
        const broadcast = m.broadcast_node_id !== null && getIdForNode(m, m.broadcast_node_id) === frame.arbitration_id;
        return (addressed || broadcast) && dlcToBytes(m.dlc) === data.length;
      }).map(message => ({ message, match: matchConstants(message, data) }))
        .filter(c => c.match.ok).sort((a, b) => b.match.matched - a.match.matched);
      if (!candidates.length) continue;
      if (candidates.length > 1 && candidates[0].match.matched === candidates[1].match.matched) {
        throw new Error(`${binding.device}: ambiguous input frame 0x${frame.arbitration_id.toString(16)}`);
      }
      const decoded = decode(candidates[0].message, data, frame.arbitration_id, binding.node);
      results.push({ type: 'message', version: 1, request_id: `input-${++this.request}`,
        device: binding.device, name: decoded.name,
        fields: Object.fromEntries(decoded.signals.map(s => [s.name, s.physical_value])),
        received_time: frame.timestamp, clock_domain: 'unix' });
    }
    return results;
  }

  output(packet: { device: string; name: string; fields: Record<string, number | string> }) {
    const binding = this.config.bindings.find(b => b.device === packet.device);
    if (!binding) throw new Error(`Unknown simulator device ${packet.device}`);
    const protocol = this.config.protocols[binding.protocol];
    const message = protocol.messages.find(m => m.name === packet.name && this.isOutput(binding, m));
    if (!message) throw new Error(`Output ${packet.device}/${packet.name} is not declared`);
    if (!packet.fields || typeof packet.fields !== 'object') throw new Error('Output fields must be an object');
    for (const key of Object.keys(packet.fields)) {
      if (!message.signals.some(s => s.name === key)) throw new Error(`Unknown output field ${key}`);
    }
    for (const signal of message.signals) {
      const value = packet.fields[signal.name] ?? signal.default_value;
      if (signal.constant) continue;
      if (value === null || value === undefined) throw new Error(`Missing output field ${signal.name}`);
      const n = Number(value);
      const enumValue = typeof value === 'string' && Object.values(signal.enum_map).includes(value);
      if (!enumValue && !Number.isFinite(n)) throw new Error(`Non-finite output ${signal.name}`);
      if (!enumValue && (signal.min_val !== null && n < signal.min_val || signal.max_val !== null && n > signal.max_val)) {
        throw new Error(`Output ${signal.name} out of range`);
      }
      if (!enumValue && !signal.value_type.startsWith('float')) {
        const raw = (n - signal.offset) / signal.scale;
        const signed = signal.value_type === 'signed';
        const low = signed ? -(2 ** (signal.bit_length - 1)) : 0;
        const high = signed ? 2 ** (signal.bit_length - 1) - 1 : 2 ** signal.bit_length - 1;
        if (raw < low - 1e-6 || raw > high + 1e-6) throw new Error(`Output ${signal.name} cannot fit its field`);
      }
    }
    const data = encode(message, packet.fields);
    const canId = getIdForNode(message, binding.node);
    return { type: 'send', arbitration_id: canId, data: Array.from(data, b => b.toString(16).padStart(2, '0')).join(''),
      is_fd: protocol.fd, is_extended_id: binding.extended ?? canId > 0x7ff,
      bitrate_switch: binding.bitrate_switch ?? false, request_id: `output-${++this.request}` };
  }
}
