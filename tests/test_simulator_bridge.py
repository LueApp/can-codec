import asyncio
import json
import queue
import struct
import unittest
import hashlib
from pathlib import Path
import re

from canfd_codec.serve import CANWebSocketServer, _ws_read_frame


class Writer:
    def __init__(self):
        self.frames = []
        self.transport = self
        self.closed = False
    def write(self, data): self.frames.append(json.loads(_ws_read_frame(data)[1]))
    def close(self): self.closed = True
    def is_closing(self): return self.closed
    def get_write_buffer_size(self): return 0


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = CANWebSocketServer(interface="memory")
        self.codec, self.simulator = Writer(), Writer()

    def send(self, writer, message):
        self.bridge._handle_text_message(json.dumps(message).encode(), writer)

    def hello(self):
        self.send(self.codec, {"type":"sim_hello","role":"codec","version":1})
        self.send(self.simulator, {"type":"sim_hello","role":"simulator","version":1})

    def test_relay_is_opaque_and_roles_are_exclusive(self):
        self.hello()
        self.send(self.codec, {"type":"sim_data","payload":{"type":"message","device":"test","name":"AnyFutureProtocol","fields":{"x":1}}})
        self.assertEqual(self.simulator.frames[-1]["payload"]["name"], "AnyFutureProtocol")
        other = Writer()
        self.send(other, {"type":"sim_hello","role":"codec","version":1})
        self.assertEqual(other.frames[-1]["type"], "sim_error")

    def test_simulator_cannot_transmit_raw_frames(self):
        self.hello()
        self.send(self.simulator, {"type":"send","arbitration_id":1,"data":"FF","is_fd":False})
        self.assertFalse(self.simulator.frames[-1]["ok"])
        self.assertTrue(self.bridge._send_queue.empty())

    def test_explicit_extended_id_and_request_correlation(self):
        self.send(self.codec, {"type":"send","arbitration_id":1,"data":"0001","is_fd":True,
                               "is_extended_id":True,"bitrate_switch":True,"request_id":"a"})
        item = self.bridge._send_queue.get_nowait()
        self.assertTrue(item[4]["is_extended_id"])
        self.assertTrue(item[4]["bitrate_switch"])
        self.assertEqual(item[4]["request_id"], "a")

    def test_illegal_fd_length_and_flags_rejected(self):
        self.send(self.codec, {"type":"send","arbitration_id":1,"data":"00"*9,"is_fd":True,"request_id":"x"})
        self.assertFalse(self.codec.frames[-1]["ok"])
        self.assertEqual(self.codec.frames[-1]["request_id"], "x")
        self.send(self.codec, {"type":"send","arbitration_id":1,"data":"00","is_fd":False,"bitrate_switch":True})
        self.assertFalse(self.codec.frames[-1]["ok"])

    def test_native_frame_packing_preserves_fd_and_extended_flags(self):
        class Socket:
            def send(self, data): self.data = data
        bridge = CANWebSocketServer()
        bridge._can_socket = Socket()
        error = bridge._send_one(0x123, b'\x01\x02', True, {"is_extended_id":True,"bitrate_switch":True,"error_state_indicator":True})
        self.assertIsNone(error)
        raw = bridge._can_socket.data
        self.assertEqual(len(raw), 72)
        self.assertEqual(struct.unpack('=IBBBB', raw[:8])[:3], (0x80000123, 2, 3))
        self.assertEqual(raw[8:10], b'\x01\x02')

    def test_queue_overflow_has_explicit_failure(self):
        self.bridge._send_queue = queue.Queue(maxsize=1)
        frame = {"type":"send","arbitration_id":1,"data":"00","is_fd":False}
        self.send(self.codec, frame)
        self.send(self.codec, frame)
        self.assertIn("queue full", self.codec.frames[-1]["error"])

    def test_downloadable_script_is_generated_from_canonical_source(self):
        root = Path(__file__).resolve().parents[1]
        generated = (root / "web/src/lib/server-script.ts").read_text()
        source = json.loads(generated.split("export const SERVER_SCRIPT = ", 1)[1].split(";\n", 1)[0])
        expected = '#!/usr/bin/env python3\n' + (root / 'canfd_codec/serve.py').read_text()
        self.assertTrue(source.startswith(expected))
        digest = re.search(r'SERVER_SCRIPT_SHA256 = "([a-f0-9]+)"', generated).group(1)
        self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), digest)
        compile(source, 'downloaded_bridge.py', 'exec')


if __name__ == '__main__': unittest.main()
