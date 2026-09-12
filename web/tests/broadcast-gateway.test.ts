import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/lib/config-loader.ts';
import { SimulatorGateway } from '../src/lib/simulator-gateway.ts';
import { Codec } from '../src/lib/codec.ts';

const source = `
parameters: {limit: 12}
node_groups:
  - nodes: [1, 2]
    parameters: {limit: 70}
  - nodes: [3, 4]
    parameters: {limit: 40}
device: {name: Seven nodes, fd: true}
messages:
  - name: Control
    id: 0x400
    direction: tx
    dlc: 8
    node_count: 7
    node_id_start: 1
    node_id_offset: 1
    broadcast_node_id: 127
    broadcast_payload: per_node
    signals:
      - {name: effort, start_bit: 0, bit_length: 16, min: '-$limit', max: '$limit', linear_map: true}
  - name: Read
    id: 0
    direction: tx
    dlc: 1
    node_count: 7
    node_id_start: 1
    broadcast_node_id: 127
    broadcast_payload: shared
    signals: [{name: register, start_bit: 0, bit_length: 8}]
  - name: FloatWrite
    id: 0x80
    direction: tx
    dlc: 6
    node_count: 7
    node_id_start: 1
    match: {register: [35]}
    signals:
      - {name: register, start_bit: 0, bit_length: 8}
      - {name: value, start_bit: 16, bit_length: 32, value_type: float32}
  - name: IntegerWrite
    id: 0x80
    direction: tx
    dlc: 6
    node_count: 7
    node_id_start: 1
    match: {register: [69]}
    signals:
      - {name: register, start_bit: 0, bit_length: 8}
      - {name: value, start_bit: 16, bit_length: 32}
`;
function setup() {
  const protocol=parseConfig(source,'test.yaml');
  const codec=new Codec();codec.addDevice(protocol);
  const gateway=new SimulatorGateway({version:1,protocols:{test:protocol},bindings:Array.from({length:7},(_,i)=>({device:`motor_${i+1}`,protocol:'test',node:i+1}))});
  return {codec,gateway};
}
const hex=(data:Uint8Array)=>Buffer.from(data).toString('hex');

test('seven-node control broadcasts split correctly after CAN FD padding',()=>{
  const {codec,gateway}=setup();
  const values=[7,14,12,16,3,6,9];
  const encoded=codec.encodeBroadcast('Control',new Map(values.map((effort,i)=>[i+1,{effort}])));
  assert.equal(encoded.data.length,56);
  const padded=new Uint8Array(64);padded.set(encoded.data);
  const messages=gateway.receive({arbitration_id:encoded.canId,is_fd:true,data:hex(padded)});
  assert.equal(messages.length,7);
  messages.forEach((message,i)=>assert.ok(Math.abs(Number(message.fields.effort)-values[i])<0.003));
  assert.deepEqual(gateway.receive({arbitration_id:encoded.canId,is_fd:true,data:hex(padded.slice(0,8))}),[]);
});

test('shared one-byte register broadcasts fan out without splitting',()=>{
  const {codec,gateway}=setup();
  const messages=gateway.receive({arbitration_id:127,is_fd:true,data:'28'});
  assert.equal(messages.length,7);
  assert.ok(messages.every(message=>message.fields.register===40));
  assert.equal(codec.decode(127,new Uint8Array([40]))?.signals[0].physical_value,40);
});

test('equal-length register writes select their declared payload discriminator',()=>{
  const {gateway}=setup();
  const messages=gateway.receive({arbitration_id:0x81,is_fd:true,data:'450001000000'});
  assert.equal(messages[0].name,'IntegerWrite');
  assert.equal(messages[0].fields.value,1);
  assert.deepEqual(gateway.receive({arbitration_id:0x81,is_fd:true,data:'990001000000'}),[]);
});

test('normal encode/decode use per-node signal ranges too',()=>{
  const {codec}=setup();
  for(const [node,effort] of [[1,35],[3,20],[5,6]]) {
    const frame=codec.encode('Control',{effort},node);
    const decoded=codec.decode(frame.canId,frame.data);
    assert.ok(Math.abs(Number(decoded?.signals[0].physical_value)-effort)<0.003);
  }
});
