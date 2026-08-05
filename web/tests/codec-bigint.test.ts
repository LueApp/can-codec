import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

import { Codec, decode, encode } from '../src/lib/codec.ts';
import { isIdentityInteger } from '../src/lib/codegen/common.ts';
import { parseMavlinkEnumValue, parseMavlinkFieldType } from '../src/lib/config-loader.ts';
import type { DeviceConfig, Message, Signal } from '../src/lib/types.ts';

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    name: 'value',
    start_bit: 0,
    bit_length: 64,
    byte_order: 'little_endian',
    value_type: 'unsigned',
    scale: 1,
    offset: 0,
    min_val: null,
    max_val: null,
    unit: '',
    description: '',
    enum_map: {},
    bitfield_map: {},
    default_value: null,
    constant: false,
    ...overrides,
  };
}

function makeMessage(signal: Signal, overrides: Partial<Message> = {}): Message {
  return {
    id: 0x123,
    name: 'IntegerMessage',
    direction: 'rx',
    dlc: Math.ceil((signal.start_bit + signal.bit_length) / 8),
    description: '',
    node_id_offset: 0,
    node_count: 1,
    node_id_start: 0,
    broadcast_node_id: null,
    signals: [signal],
    ...overrides,
  };
}

function hex(data: Uint8Array): string {
  return Array.from(data, byte => byte.toString(16).padStart(2, '0')).join(' ');
}

test('uint32 max encodes and decodes without 32-bit signed truncation', () => {
  const msg = makeMessage(makeSignal({ bit_length: 32 }));
  const data = encode(msg, { value: 0xFFFFFFFF });
  assert.equal(hex(data), 'ff ff ff ff');
  const value = decode(msg, data).signals[0];
  assert.equal(value.raw_value, 0xFFFFFFFF);
  assert.equal(value.physical_value, 0xFFFFFFFF);
});

test('uint64 little-endian accepts exact decimal and hexadecimal strings', () => {
  const msg = makeMessage(makeSignal());
  const expected = '10 32 54 76 98 ba dc fe';
  for (const value of ['18364758544493064720', '0xFEDCBA9876543210']) {
    const data = encode(msg, { value });
    assert.equal(hex(data), expected);
    const decoded = decode(msg, data).signals[0];
    assert.equal(decoded.raw_value, '18364758544493064720');
    assert.equal(decoded.physical_value, '18364758544493064720');
  }
});

test('signed int64 minimum roundtrips exactly', () => {
  const msg = makeMessage(makeSignal({ value_type: 'signed' }));
  const data = encode(msg, { value: '-9223372036854775808' });
  assert.equal(hex(data), '00 00 00 00 00 00 00 80');
  const decoded = decode(msg, data).signals[0];
  assert.equal(decoded.raw_value, '9223372036854775808');
  assert.equal(decoded.physical_value, '-9223372036854775808');
});

test('64-bit big-endian packing and extraction preserve every bit', () => {
  const msg = makeMessage(makeSignal({ byte_order: 'big_endian' }));
  const data = encode(msg, { value: '0xFEDCBA9876543210' });
  assert.equal(hex(data), 'fe dc ba 98 76 54 32 10');
  assert.equal(decode(msg, data).signals[0].physical_value, '18364758544493064720');
});

test('float64 uses the complete 64-bit IEEE-754 bit pattern', () => {
  const msg = makeMessage(makeSignal({ value_type: 'float64' }));
  const data = encode(msg, { value: Math.PI });
  assert.equal(hex(data), '18 2d 44 54 fb 21 09 40');
  assert.equal(decode(msg, data).signals[0].physical_value, Math.PI);
});

test('unsafe integer number input is rejected with exact-string guidance', () => {
  const msg = makeMessage(makeSignal());
  assert.throws(
    () => encode(msg, { value: Number('18364758544493064720') }),
    /Pass the exact value as a decimal or hexadecimal string/,
  );
});

test('64-bit constants and bitfields use BigInt-safe matching', () => {
  const constantValue = '18364758544493064720';
  const first = makeMessage(makeSignal({ constant: true, default_value: '1' }), {
    name: 'WrongConstant', node_count: 2,
  });
  const second = makeMessage(makeSignal({
    constant: true,
    default_value: constantValue,
    bitfield_map: { 63: 'top_bit' },
  }), { name: 'RightConstant', node_count: 2 });
  const device: DeviceConfig = {
    name: 'test', version: '1', description: '', bus: '', fd: true, mavlink: false,
    messages: [first, second],
  };
  const codec = new Codec();
  codec.addDevice(device);
  const data = encode(second, {});
  const decoded = codec.decode(second.id, data);
  assert.equal(decoded?.name, 'RightConstant');
  assert.equal(decoded?.signals[0].bitfield_flags?.top_bit, true);
});

test('MAVLink XML helpers recognize magic HEARTBEAT type and hexadecimal enums', () => {
  assert.deepEqual(parseMavlinkFieldType('uint8_t_mavlink_version'), {
    base_type: 'uint8_t',
    bit_length: 8,
    value_type: 'unsigned',
    array_count: 1,
    wire_size: 1,
    default_value: 3,
    constant: true,
  });
  assert.equal(parseMavlinkEnumValue('0x1000000'), 0x1000000);
});

test('Web GenLib selects exact paths only for identity integer fields', () => {
  assert.equal(isIdentityInteger(makeSignal()), true);
  assert.equal(isIdentityInteger(makeSignal({ scale: 0.001 })), false);
  assert.equal(isIdentityInteger(makeSignal({ unit: 'us' })), false);
  assert.equal(isIdentityInteger(makeSignal({ value_type: 'float64' })), false);
});

test('Web Python GenLib keeps identity conversion helpers exact for uint64', async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    appType: 'custom',
    server: { middlewareMode: true },
  });
  try {
    const { generatePython } = await vite.ssrLoadModule('/src/lib/codegen/python.ts');
    const message = makeMessage(makeSignal({ name: 'timestamp' }), {
      id: 461,
      name: 'LINEAR_ACTUATOR_STATUS',
      dlc: 8,
      crc_extra: 8,
    });
    const device: DeviceConfig = {
      name: 'mavlink_pusher',
      version: 'MAVLink v2',
      description: '',
      bus: '',
      fd: true,
      mavlink: true,
      messages: [message],
    };
    const source = generatePython(device);
    assert.match(source, /def _is_identity\(scale, offset\):/);

    const check = `${source}\n
value = 0xFEDCBA9876543210
assert _p2r_unsigned(value, 1.0, 0.0, 64) == value
assert _r2p_unsigned(value, 1.0, 0.0) == value
assert _p2r_signed(-1, 1.0, 0.0, 64) == 0xFFFFFFFFFFFFFFFF
assert _r2p_signed(0xFFFFFFFFFFFFFFFF, 1.0, 0.0, 64) == -1
_, payload = LinearActuatorStatus(timestamp=value).encode()
decoded = LinearActuatorStatus.decode(payload)
print(payload.hex(), hex(decoded.timestamp))
`;
    const result = spawnSync('python3', ['-c', check], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      '1032547698badcfe 0xfedcba9876543210',
    );
  } finally {
    await vite.close();
  }
});
