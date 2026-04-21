"""
WebSocket bridge for live CAN bus frame streaming (zero external dependencies).

Broadcasts raw CAN frames as JSON to all connected WebSocket clients.
Decoding is performed client-side in the browser.

Uses candump (from can-utils) instead of python-can, and a stdlib WebSocket
implementation (RFC 6455) instead of the 'websockets' package.
"""

import asyncio
import base64
import hashlib
import json
import logging
import re
import signal as signal_module
import struct
import subprocess
import threading
import time

logger = logging.getLogger(__name__)

_WS_MAGIC = b"258EAFA5-E914-47DA-95CA-5AB5E17A1265"

_CANDUMP_RE = re.compile(
    r"^\s*\((\d+\.\d+)\)\s+(\S+)\s+([0-9A-Fa-f]+)\s+\[(\d+)\]\s+(.+)$"
)


def _parse_candump_line(line: str) -> tuple[float, int, str, bool] | None:
    """Parse a candump -ta output line.

    Returns (timestamp, arbitration_id, data_hex_upper, is_fd) or None.
    """
    m = _CANDUMP_RE.match(line)
    if not m:
        return None
    timestamp = float(m.group(1))
    arb_id = int(m.group(3), 16)
    dlc = int(m.group(4))
    data_hex = m.group(5).strip().replace(" ", "").upper()
    is_fd = dlc > 8
    return timestamp, arb_id, data_hex, is_fd


def _ws_accept_key(client_key: str) -> str:
    raw = client_key.encode() + _WS_MAGIC
    return base64.b64encode(hashlib.sha1(raw).digest()).decode()


def _ws_build_frame(payload: bytes, opcode: int = 0x1) -> bytes:
    fin_op = 0x80 | opcode
    length = len(payload)
    if length < 126:
        header = struct.pack("!BB", fin_op, length)
    elif length < 65536:
        header = struct.pack("!BBH", fin_op, 126, length)
    else:
        header = struct.pack("!BBQ", fin_op, 127, length)
    return header + payload


def _ws_read_frame(data: bytes) -> tuple[int, bytes, int] | None:
    """Parse one WebSocket frame from data.

    Returns (opcode, payload, total_consumed_bytes) or None if incomplete.
    """
    if len(data) < 2:
        return None
    opcode = data[0] & 0x0F
    masked = bool(data[1] & 0x80)
    length = data[1] & 0x7F
    offset = 2
    if length == 126:
        if len(data) < 4:
            return None
        length = struct.unpack("!H", data[2:4])[0]
        offset = 4
    elif length == 127:
        if len(data) < 10:
            return None
        length = struct.unpack("!Q", data[2:10])[0]
        offset = 10
    if masked:
        if len(data) < offset + 4:
            return None
        mask_key = data[offset : offset + 4]
        offset += 4
    if len(data) < offset + length:
        return None
    payload = bytearray(data[offset : offset + length])
    if masked:
        for i in range(length):
            payload[i] ^= mask_key[i % 4]
    return opcode, bytes(payload), offset + length


class CANWebSocketServer:
    """WebSocket server that reads CAN frames via candump and broadcasts them.

    Args:
        bus: CAN interface name (e.g., "can0", "vcan0")
        fd: Enable CAN FD mode
        host: WebSocket server bind address
        port: WebSocket server port
        filter_ids: Optional set of CAN IDs to forward (None = all)
    """

    def __init__(
        self,
        bus: str = "vcan0",
        interface: str = "socketcan",
        fd: bool = True,
        bitrate: int | None = None,
        data_bitrate: int | None = None,
        host: str = "0.0.0.0",
        port: int = 8765,
        filter_ids: set[int] | None = None,
    ):
        self.bus = bus
        self.interface = interface
        self.fd = fd
        self.bitrate = bitrate
        self.data_bitrate = data_bitrate
        self.host = host
        self.port = port
        self.filter_ids = filter_ids
        self._running = False
        self._clients: set[asyncio.StreamWriter] = set()
        self._clients_lock = threading.Lock()

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ):
        remote = writer.get_extra_info("peername")

        try:
            request = await asyncio.wait_for(
                reader.readuntil(b"\r\n\r\n"), timeout=10
            )
        except (asyncio.TimeoutError, asyncio.IncompleteReadError):
            writer.close()
            return

        headers = {}
        for line in request.decode(errors="replace").split("\r\n")[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        ws_key = headers.get("sec-websocket-key")
        if not ws_key:
            writer.write(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            await writer.drain()
            writer.close()
            return

        accept = _ws_accept_key(ws_key)
        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            "\r\n"
        )
        writer.write(response.encode())
        await writer.drain()

        with self._clients_lock:
            self._clients.add(writer)
        print(f"  Client connected: {remote} ({len(self._clients)} total)")

        status = json.dumps({"type": "status", "bus": self.bus, "fd": self.fd})
        try:
            writer.write(_ws_build_frame(status.encode()))
            await writer.drain()
        except Exception:
            pass

        buf = b""
        try:
            while self._running:
                try:
                    chunk = await asyncio.wait_for(reader.read(4096), timeout=30)
                except asyncio.TimeoutError:
                    try:
                        writer.write(_ws_build_frame(b"", opcode=0x9))
                        await writer.drain()
                    except Exception:
                        break
                    continue
                if not chunk:
                    break
                buf += chunk
                while True:
                    result = _ws_read_frame(buf)
                    if result is None:
                        break
                    opcode, payload, consumed = result
                    buf = buf[consumed:]
                    if opcode == 0x8:
                        writer.write(
                            _ws_build_frame(payload[:2] if payload else b"", opcode=0x8)
                        )
                        await writer.drain()
                        writer.close()
                        return
                    elif opcode == 0x9:
                        writer.write(_ws_build_frame(payload, opcode=0xA))
                        await writer.drain()
                    elif opcode == 0xA:
                        pass
        except (ConnectionError, OSError):
            pass
        finally:
            with self._clients_lock:
                self._clients.discard(writer)
            print(
                f"  Client disconnected: {remote} ({len(self._clients)} total)"
            )
            try:
                writer.close()
            except Exception:
                pass

    def _candump_reader_thread(self, loop: asyncio.AbstractEventLoop):
        """Thread that reads candump output and schedules broadcasts."""
        print(f"  CAN bus: {self.bus} (candump, fd={self.fd})")

        while self._running:
            cmd = ["candump", "-ta", self.bus]
            try:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                )
            except FileNotFoundError:
                print(
                    "  Error: candump not found. Install can-utils: "
                    "sudo apt install can-utils"
                )
                break

            print(f"  CAN bus connected: {self.bus}")
            self._notify_bus_status(loop, connected=True)

            try:
                for line in proc.stdout:
                    if not self._running:
                        break
                    parsed = _parse_candump_line(line)
                    if parsed is None:
                        continue
                    timestamp, arb_id, data_hex, is_fd = parsed
                    if self.filter_ids and arb_id not in self.filter_ids:
                        continue
                    with self._clients_lock:
                        if not self._clients:
                            continue

                    frame_json = json.dumps(
                        {
                            "type": "frame",
                            "arbitration_id": arb_id,
                            "data": data_hex,
                            "timestamp": timestamp,
                            "is_fd": is_fd,
                        }
                    )
                    loop.call_soon_threadsafe(self._broadcast_sync, frame_json)
            except Exception as e:
                logger.error("candump reader error: %s", e)

            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()

            if not self._running:
                break

            stderr_out = ""
            if proc.returncode != 0 and proc.stderr:
                stderr_out = proc.stderr.read().strip()

            error_msg = stderr_out or f"candump exited with code {proc.returncode}"
            print(f"  CAN bus lost: {error_msg}")
            self._notify_bus_status(loop, connected=False, error=error_msg)

            if self._running:
                print(f"  Reconnecting to {self.bus} in 1s...")
                time.sleep(1)

    def _notify_bus_status(
        self,
        loop: asyncio.AbstractEventLoop,
        connected: bool,
        error: str | None = None,
    ):
        msg = json.dumps(
            {
                "type": "status",
                "bus": self.bus,
                "fd": self.fd,
                "connected": connected,
                **({"error": error} if error else {}),
            }
        )
        with self._clients_lock:
            if self._clients:
                loop.call_soon_threadsafe(self._broadcast_sync, msg)

    def _broadcast_sync(self, message: str):
        frame = _ws_build_frame(message.encode())
        with self._clients_lock:
            dead: list[asyncio.StreamWriter] = []
            for writer in self._clients:
                try:
                    writer.write(frame)
                except Exception:
                    dead.append(writer)
            for w in dead:
                self._clients.discard(w)

    async def run(self):
        """Start the WebSocket server and candump reader. Blocks until stopped."""
        self._running = True
        loop = asyncio.get_running_loop()

        for sig in (signal_module.SIGINT, signal_module.SIGTERM):
            loop.add_signal_handler(sig, self.stop)

        server = await asyncio.start_server(
            self._handle_client, self.host, self.port
        )

        print(f"WebSocket server listening on ws://{self.host}:{self.port}")

        reader_thread = threading.Thread(
            target=self._candump_reader_thread,
            args=(loop,),
            daemon=True,
        )
        reader_thread.start()

        while self._running:
            await asyncio.sleep(0.5)

        server.close()
        await server.wait_closed()
        reader_thread.join(timeout=3.0)
        print("\nServer stopped.")

    def stop(self):
        """Signal the server to stop."""
        self._running = False
