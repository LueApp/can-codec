import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SimulatorGateway } from '../src/lib/simulator-gateway.ts';
import { parseConfig } from '../src/lib/config-loader.ts';

const protocol = parseConfig(readFileSync(new URL('../../configs/example_damiao.yaml', import.meta.url), 'utf8'), 'example_damiao.yaml');
const binding = { device: 'motor_1', protocol: 'motor', node: 1 };
const make = () => new SimulatorGateway({ version: 1, protocols: { motor: protocol }, bindings: [binding] });

test('known enable payload uses discriminator, preserving original message vocabulary', () => {
  const result = make().receive({ arbitration_id: 1, data: 'FFFFFFFFFFFFFFFC', is_fd: false });
  assert.equal(result[0].name, 'EnableMotor');
  assert.equal(result[0].device, 'motor_1');
});

test('repeated identical commands are distinct; simulated output echoes are ignored', () => {
  const gateway = make();
  const frame = { arbitration_id: 1, data: 'FFFFFFFFFFFFFFFC', is_fd: false };
  assert.notEqual(gateway.receive(frame)[0].request_id, gateway.receive(frame)[0].request_id);
  assert.deepEqual(gateway.receive({ ...frame, origin: 'simulator' }), []);
});

test('short payload and explicit extended-ID mismatch cannot become commands', () => {
  const gateway = make();
  assert.deepEqual(gateway.receive({ arbitration_id: 1, data: 'FFFF', is_fd: false }), []);
  assert.deepEqual(gateway.receive({ arbitration_id: 1, data: 'FFFFFFFFFFFFFFFC', is_fd: false, is_extended_id: true }), []);
});

test('feedback encoding matches an independently calculated zero-state vector', () => {
  const frame = make().output({device:'motor_1',name:'Feedback',fields:{position:0,velocity:0,torque:0,error_status:1,motor_id:1,temp_mos:35,temp_rotor:32}});
  assert.equal(frame.arbitration_id, 0x701);
  assert.equal(frame.data, '117fff7ff7ff2320');
});

test('output validation rejects missing fields and saturation instead of silently clamping', () => {
  assert.throws(() => make().output({device:'motor_1',name:'Feedback',fields:{position:0}}), /Missing output field/);
  assert.throws(() => make().output({device:'motor_1',name:'Feedback',fields:{position:100,velocity:0,torque:0,error_status:1,motor_id:1,temp_mos:35,temp_rotor:32}}), /out of range/);
});

test('definitions and routing collision checks', () => {
  const defs = make().definitions();
  assert.equal(defs.devices[0].inputs.MITControl.position.unit, 'rad');
  assert.ok(defs.devices[0].outputs.Feedback);
  assert.throws(() => new SimulatorGateway({ version:1, protocols:{motor:protocol}, bindings:[binding,{...binding,device:'other'}] }), /Overlapping/);
});
