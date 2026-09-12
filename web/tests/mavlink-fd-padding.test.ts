import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMavlinkV2Frame, mavlinkCanMakeId, parseMavlinkV2Header,
  reassembleMavlinkFrames, splitMavlinkFrames,
} from '../src/lib/codec.ts';

const legalLengths = [...Array(9).keys(), 12, 16, 20, 24, 32, 48, 64];
const canId = mavlinkCanMakeId(1, 1, 5, 8);
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

test('ARM_MODE_SWITCH idle and CSV keep MAVLink intact inside 16-byte CAN FD payloads', () => {
  for (const mode of [0, 3]) {
    // CRC_EXTRA is arbitrary here: transport padding must preserve *any* checksum.
    const original = buildMavlinkV2Frame(62006, Uint8Array.of(5, 8, mode), 42);
    assert.equal(original.length, mode === 0 ? 14 : 15);
    const [frame] = splitMavlinkFrames(canId, original);
    assert.equal(frame.canId, '10104148');
    assert.equal(frame.fdFlag, '##1');
    const wire = bytes(frame.data);
    assert.equal(wire.length, 16);
    assert.deepEqual(wire.slice(0, original.length), original);
    assert.ok(wire.slice(original.length).every(value => value === 0));
    // Padding belongs after the MAVLink checksum, never inside its payload.
    assert.deepEqual(parseMavlinkV2Header(wire), parseMavlinkV2Header(original));
  }
});

test('every fragment length rounds to the next legal wire length without changing data', () => {
  // Includes short final chunks, exact boundaries, and the largest signed v2 frame.
  for (let length = 1; length <= 280; length++) {
    const original = Uint8Array.from({ length }, (_, i) => (i * 17 + 3) & 255);
    const saved = original.slice();
    const frames = splitMavlinkFrames(canId, original);
    assert.equal(frames.length, Math.ceil(length / 64));
    for (let i = 0; i < frames.length; i++) {
      const chunk = original.slice(i * 64, (i + 1) * 64);
      const wire = bytes(frames[i].data);
      assert.equal(wire.length, legalLengths.find(size => size >= chunk.length), `length=${length}, fragment=${i}`);
      assert.deepEqual(wire.slice(0, chunk.length), chunk);
      assert.ok(wire.slice(chunk.length).every(value => value === 0));
      assert.equal(frames[i].fdFlag, chunk.length > 8 ? '##1' : '#');
    }
    const joined = reassembleMavlinkFrames(frames.map(frame => bytes(frame.data)));
    assert.deepEqual(joined.slice(0, length), original);
    assert.deepEqual(original, saved, 'must not mutate the MAVLink packet');
  }
});

test('fragmented MAVLink payload and checksum survive final-fragment padding', () => {
  const payload = Uint8Array.from({ length: 130 }, (_, i) => (i % 250) + 1);
  const original = buildMavlinkV2Frame(62010, payload, 42);
  const frames = splitMavlinkFrames(canId, original).map(frame => bytes(frame.data));
  assert.deepEqual(frames.map(frame => frame.length), [64, 64, 16]);
  const joined = reassembleMavlinkFrames(frames);
  assert.deepEqual(joined.slice(0, original.length), original);
  assert.deepEqual(parseMavlinkV2Header(joined)?.payload, payload);
});
