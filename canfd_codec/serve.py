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
import queue
import re
import signal as signal_module
import socket as socket_mod
import struct
import subprocess
import threading
import time
from typing import Optional

logger = logging.getLogger(__name__)

_WS_MAGIC = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

_CANDUMP_RE = re.compile(
    r"^\s*\((\d+\.\d+)\)\s+(\S+)\s+([0-9A-Fa-f]+)\s+\[(\d+)\]\s+(.+)$"
)


def _parse_candump_line(line: str) -> tuple[float, int, str, int, bool] | None:
    """Parse a candump -ta output line.

    Returns (timestamp, arbitration_id, data_hex_upper, dlc, is_fd) or None.
    """
    m = _CANDUMP_RE.match(line)
    if not m:
        return None
    timestamp = float(m.group(1))
    arb_id = int(m.group(3), 16)
    dlc = int(m.group(4))
    data_hex = m.group(5).strip().replace(" ", "").upper()
    is_fd = dlc > 8
    return timestamp, arb_id, data_hex, dlc, is_fd


def _format_cansend_arg(arb_id: int, data: bytes, is_fd: bool) -> str:
    """Build the `id#data` (or `id##flags+data`) arg for cansend."""
    extended = arb_id > 0x7FF
    id_str = f"{arb_id:08X}" if extended else f"{arb_id:03X}"
    hex_data = data.hex().upper()
    if is_fd:
        # `##` then a 1-nibble flags byte (0=no BRS/ESI) then data
        return f"{id_str}##0{hex_data}"
    return f"{id_str}#{hex_data}"


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
        # Items: (arb_id:int, data:bytes, is_fd:bool, ack_writer:StreamWriter|None)
        self._send_queue: queue.Queue = queue.Queue()
        # Reference to the pycan Bus instance (set by _pycan_reader_thread). None otherwise.
        self._pycan_bus = None
        # Reference + lock to the upstream socket (set by _ws_source_reader_thread).
        self._source_sock = None
        self._source_sock_lock = threading.Lock()

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
                    elif opcode == 0x1:
                        self._handle_text_message(payload, writer)
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

    def _handle_text_message(self, payload: bytes, writer: asyncio.StreamWriter):
        """Parse an inbound text WS frame from a client.

        Currently only `{type:"send", arbitration_id, data, is_fd}` is handled.
        Bad payloads are rejected with a send_ack carrying an error.
        """
        try:
            msg = json.loads(payload.decode("utf-8", errors="replace"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return  # silently drop garbage
        if not isinstance(msg, dict):
            return
        mtype = msg.get("type")
        if mtype != "send":
            return
        try:
            arb_id_raw = msg.get("arbitration_id")
            arb_id = int(arb_id_raw, 0) if isinstance(arb_id_raw, str) else int(arb_id_raw)
            data_hex = str(msg.get("data", "")).replace(" ", "").replace(":", "")
            if len(data_hex) % 2 != 0:
                raise ValueError("odd-length data hex")
            data = bytes.fromhex(data_hex)
            is_fd = bool(msg.get("is_fd", False))
        except (TypeError, ValueError) as e:
            self._send_ack_to(writer, False, error=f"bad send payload: {e}")
            return
        if arb_id < 0 or arb_id > 0x1FFFFFFF:
            self._send_ack_to(writer, False, arb_id=arb_id, error="arbitration_id out of range")
            return
        max_len = 64 if is_fd else 8
        if len(data) > max_len:
            self._send_ack_to(writer, False, arb_id=arb_id, error=f"data too long for {'CAN FD' if is_fd else 'classic CAN'} ({len(data)} > {max_len})")
            return
        # Enqueue for the sender thread to push to the bus.
        self._send_queue.put((arb_id, data, is_fd, writer))

    def _send_ack_to(
        self,
        writer: asyncio.StreamWriter,
        ok: bool,
        arb_id: Optional[int] = None,
        error: Optional[str] = None,
    ):
        """Send a send_ack JSON frame to a specific client. Safe from any thread."""
        msg = {"type": "send_ack", "ok": ok}
        if arb_id is not None:
            msg["arbitration_id"] = arb_id
        if error:
            msg["error"] = error
        frame = _ws_build_frame(json.dumps(msg).encode())
        try:
            writer.write(frame)
        except Exception:
            pass

    def _sender_thread(self, loop: asyncio.AbstractEventLoop):
        """Drain the send queue and push frames to the bus."""
        while self._running:
            try:
                item = self._send_queue.get(timeout=0.25)
            except queue.Empty:
                continue
            arb_id, data, is_fd, ack_writer = item
            try:
                err = self._send_one(arb_id, data, is_fd)
            except Exception as e:
                err = f"send failed: {e}"
            if ack_writer is not None:
                loop.call_soon_threadsafe(
                    self._send_ack_to, ack_writer, err is None, arb_id, err
                )
            if err:
                print(f"  send 0x{arb_id:X} ({len(data)}B, fd={is_fd}) -> {err}")
            else:
                # Broadcast a tx-tagged frame to all clients so the plot page can
                # display what was just sent — separately from rx frames that
                # candump/pycan might (or might not) loop back.
                frame_json = json.dumps({
                    "type": "frame",
                    "direction": "tx",
                    "arbitration_id": arb_id,
                    "data": data.hex().upper(),
                    "dlc": len(data),
                    "timestamp": time.time(),
                    "is_fd": is_fd,
                })
                loop.call_soon_threadsafe(self._broadcast_sync, frame_json)

    def _send_one(self, arb_id: int, data: bytes, is_fd: bool) -> Optional[str]:
        """Dispatch one frame to whichever backend is in use. Returns error or None."""
        if self.source_url:
            # Relay mode: forward the send command upstream.
            with self._source_sock_lock:
                sock = self._source_sock
                if sock is None:
                    return "upstream not connected"
                try:
                    msg = json.dumps({
                        "type": "send",
                        "arbitration_id": arb_id,
                        "data": data.hex().upper(),
                        "is_fd": is_fd,
                    }).encode()
                    sock.sendall(_ws_build_frame(msg, masked=True))
                    return None
                except OSError as e:
                    return f"upstream write failed: {e}"
        if self.interface != "socketcan" and self._pycan_bus is not None:
            try:
                import can
            except ImportError:
                return "python-can not installed"
            try:
                m = can.Message(
                    arbitration_id=arb_id,
                    data=data,
                    is_fd=is_fd,
                    is_extended_id=arb_id > 0x7FF,
                )
                self._pycan_bus.send(m)
                return None
            except Exception as e:
                return f"python-can send failed: {e}"
        # Default: socketcan -> shell out to cansend
        arg = _format_cansend_arg(arb_id, data, is_fd)
        try:
            res = subprocess.run(
                ["cansend", self.bus, arg],
                capture_output=True,
                text=True,
                timeout=2,
            )
        except FileNotFoundError:
            return "cansend not found (install can-utils)"
        except subprocess.TimeoutExpired:
            return "cansend timed out"
        if res.returncode != 0:
            err = (res.stderr or res.stdout or "").strip() or f"cansend exit {res.returncode}"
            return err
        return None

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
                    timestamp, arb_id, data_hex, dlc, is_fd = parsed
                    if self.filter_ids and arb_id not in self.filter_ids:
                        continue
                    with self._clients_lock:
                        if not self._clients:
                            continue

                    frame_json = json.dumps(
                        {
                            "type": "frame",
                            "direction": "rx",
                            "arbitration_id": arb_id,
                            "data": data_hex,
                            "dlc": dlc,
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
            self._pycan_bus = bus

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
                            "direction": "rx",
                            "arbitration_id": arb_id,
                            "data": data_hex,
                            "dlc": msg.dlc,
                            "timestamp": msg.timestamp or time.time(),
                            "is_fd": msg.is_fd,
                        }
                    )
                    loop.call_soon_threadsafe(self._broadcast_sync, frame_json)
            except (ConnectionError, OSError) as e:
                logger.error("python-can reader error: %s", e)
            finally:
                self._pycan_bus = None
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
                with self._source_sock_lock:
                    self._source_sock = sock

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
                with self._source_sock_lock:
                    if self._source_sock is sock:
                        self._source_sock = None
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

        sender_thread = threading.Thread(
            target=self._sender_thread,
            args=(loop,),
            daemon=True,
        )
        sender_thread.start()

        while self._running:
            await asyncio.sleep(0.5)

        server.close()
        await server.wait_closed()
        reader_thread.join(timeout=3.0)
        sender_thread.join(timeout=3.0)
        print("\nServer stopped.")

    def stop(self):
        """Signal the server to stop."""
        self._running = False
