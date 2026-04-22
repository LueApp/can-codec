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
import os
import re
import signal as signal_module
import socket as socket_mod
import struct
import subprocess
import threading
import time

logger = logging.getLogger(__name__)

_WS_MAGIC = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

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


def _ws_build_frame(payload: bytes, opcode: int = 0x1, masked: bool = False) -> bytes:
    fin_op = 0x80 | opcode
    length = len(payload)
    mask_bit = 0x80 if masked else 0
    if length < 126:
        header = struct.pack("!BB", fin_op, mask_bit | length)
    elif length < 65536:
        header = struct.pack("!BBH", fin_op, mask_bit | 126, length)
    else:
        header = struct.pack("!BBQ", fin_op, mask_bit | 127, length)
    if masked:
        mask_key = os.urandom(4)
        masked_payload = bytearray(payload)
        for i in range(len(masked_payload)):
            masked_payload[i] ^= mask_key[i % 4]
        return header + mask_key + bytes(masked_payload)
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
        source_url: str | None = None,
    ):
        self.bus = bus
        self.interface = interface
        self.fd = fd
        self.bitrate = bitrate
        self.data_bitrate = data_bitrate
        self.host = host
        self.port = port
        self.filter_ids = filter_ids
        self.source_url = source_url
        self._running = False
        self._clients: set[asyncio.StreamWriter] = set()
        self._clients_lock = threading.Lock()

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ):
        remote = writer.get_extra_info("peername")
        disconnect_reason = "unknown"

        try:
            request = await asyncio.wait_for(
                reader.readuntil(b"\r\n\r\n"), timeout=10
            )
        except (asyncio.TimeoutError, asyncio.IncompleteReadError):
            writer.close()
            return

        req_text = request.decode(errors="replace")
        lines = req_text.split("\r\n")
        method = lines[0].split(" ")[0] if lines else ""
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        origin = headers.get("origin", "*")

        if method == "OPTIONS":
            response = (
                "HTTP/1.1 204 No Content\r\n"
                f"Access-Control-Allow-Origin: {origin}\r\n"
                "Access-Control-Allow-Methods: GET, OPTIONS\r\n"
                "Access-Control-Allow-Headers: *\r\n"
                "Access-Control-Allow-Private-Network: true\r\n"
                "Access-Control-Max-Age: 86400\r\n"
                "\r\n"
            )
            writer.write(response.encode())
            await writer.drain()
            writer.close()
            return

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
            f"Access-Control-Allow-Origin: {origin}\r\n"
            "Access-Control-Allow-Private-Network: true\r\n"
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
                        disconnect_reason = "ping write failed"
                        break
                    continue
                if not chunk:
                    disconnect_reason = "EOF (client closed connection)"
                    break
                buf += chunk
                while True:
                    result = _ws_read_frame(buf)
                    if result is None:
                        break
                    opcode, payload, consumed = result
                    buf = buf[consumed:]
                    if opcode == 0x8:
                        disconnect_reason = "close frame received"
                        try:
                            writer.write(
                                _ws_build_frame(
                                    payload[:2] if payload else b"", opcode=0x8
                                )
                            )
                            await writer.drain()
                        except Exception:
                            pass
                        return
                    elif opcode == 0x9:
                        writer.write(_ws_build_frame(payload, opcode=0xA))
                        await writer.drain()
                    elif opcode == 0xA:
                        pass
        except (ConnectionError, OSError) as e:
            disconnect_reason = f"connection error: {e}"
        except Exception as e:
            disconnect_reason = f"unexpected error: {e}"
        finally:
            with self._clients_lock:
                self._clients.discard(writer)
            print(
                f"  Client disconnected: {remote}"
                f" ({len(self._clients)} total)"
                f" reason: {disconnect_reason}"
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

    def _pycan_reader_thread(self, loop: asyncio.AbstractEventLoop):
        """Thread that reads frames via python-can (for slcanfd etc.)."""
        try:
            import can
        except ImportError:
            print("  Error: python-can not installed. Run: pip install python-can")
            return

        print(f"  CAN bus: {self.bus} (python-can, interface={self.interface}, fd={self.fd})")

        while self._running:
            try:
                kwargs: dict = {
                    "interface": self.interface,
                    "channel": self.bus,
                    "fd": self.fd,
                }
                if self.bitrate:
                    kwargs["bitrate"] = self.bitrate
                bus = can.Bus(**kwargs)
                if self.data_bitrate and hasattr(bus, "set_bitrate"):
                    bus.set_bitrate(self.bitrate, self.data_bitrate)
            except Exception as e:
                print(f"  Error opening CAN bus: {e}")
                if self._running:
                    print(f"  Reconnecting in 1s...")
                    time.sleep(1)
                continue

            print(f"  CAN bus connected: {self.bus}")
            self._notify_bus_status(loop, connected=True)

            try:
                while self._running:
                    try:
                        msg = bus.recv(timeout=1.0)
                    except (ValueError, IndexError):
                        continue
                    if msg is None:
                        continue
                    arb_id = msg.arbitration_id
                    if self.filter_ids and arb_id not in self.filter_ids:
                        continue
                    with self._clients_lock:
                        if not self._clients:
                            continue
                    data_hex = msg.data.hex().upper()
                    frame_json = json.dumps(
                        {
                            "type": "frame",
                            "arbitration_id": arb_id,
                            "data": data_hex,
                            "timestamp": msg.timestamp or time.time(),
                            "is_fd": msg.is_fd,
                        }
                    )
                    loop.call_soon_threadsafe(self._broadcast_sync, frame_json)
            except (ConnectionError, OSError) as e:
                logger.error("python-can reader error: %s", e)
            finally:
                try:
                    bus.shutdown()
                except Exception:
                    pass

            if not self._running:
                break
            print(f"  CAN bus lost")
            self._notify_bus_status(loop, connected=False)
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

    def _ws_source_reader_thread(self, loop: asyncio.AbstractEventLoop):
        """Thread that connects to a remote serve.py and re-broadcasts frames."""
        from urllib.parse import urlparse

        parsed = urlparse(self.source_url)
        host = parsed.hostname or "localhost"
        port = parsed.port or 8765

        print(f"  Source: {self.source_url}")

        while self._running:
            sock = None
            try:
                sock = socket_mod.create_connection((host, port), timeout=5)
                key = base64.b64encode(os.urandom(16)).decode()
                sock.sendall(
                    f"GET / HTTP/1.1\r\n"
                    f"Host: {host}:{port}\r\n"
                    f"Upgrade: websocket\r\n"
                    f"Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Version: 13\r\n"
                    f"Sec-WebSocket-Key: {key}\r\n"
                    f"\r\n".encode()
                )

                resp_buf = b""
                while b"\r\n\r\n" not in resp_buf:
                    chunk = sock.recv(4096)
                    if not chunk:
                        raise ConnectionError("EOF during handshake")
                    resp_buf += chunk

                header_end = resp_buf.index(b"\r\n\r\n")
                resp_header = resp_buf[:header_end].decode(errors="replace")
                if "101" not in resp_header.split("\r\n")[0]:
                    raise ConnectionError(f"Bad handshake: {resp_header.split(chr(13))[0]}")

                trailing = resp_buf[header_end + 4:]
                print(f"  Source connected: {host}:{port}")
                self._notify_bus_status(loop, connected=True)

                buf = trailing
                sock.settimeout(30)
                while self._running:
                    try:
                        chunk = sock.recv(4096)
                    except socket_mod.timeout:
                        try:
                            sock.sendall(_ws_build_frame(b"", opcode=0x9, masked=True))
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
                        if opcode == 0x1:
                            msg_str = payload.decode(errors="replace")
                            try:
                                msg = json.loads(msg_str)
                            except json.JSONDecodeError:
                                continue
                            if msg.get("type") == "status":
                                self.bus = msg.get("bus", self.bus)
                                self.fd = msg.get("fd", self.fd)
                            if msg.get("type") == "frame" and self.filter_ids:
                                if msg.get("arbitration_id") not in self.filter_ids:
                                    continue
                            with self._clients_lock:
                                if self._clients:
                                    loop.call_soon_threadsafe(
                                        self._broadcast_sync, msg_str
                                    )
                        elif opcode == 0x9:
                            sock.sendall(
                                _ws_build_frame(payload, opcode=0xA, masked=True)
                            )
                        elif opcode == 0x8:
                            break

            except (ConnectionError, OSError, socket_mod.timeout) as e:
                print(f"  Source lost: {e}")
                self._notify_bus_status(loop, connected=False, error=str(e))
            finally:
                if sock:
                    try:
                        sock.close()
                    except Exception:
                        pass

            if not self._running:
                break
            print(f"  Reconnecting to source in 1s...")
            time.sleep(1)

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

        if self.source_url:
            target = self._ws_source_reader_thread
        elif self.interface != "socketcan":
            target = self._pycan_reader_thread
        else:
            target = self._candump_reader_thread
        reader_thread = threading.Thread(
            target=target,
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
