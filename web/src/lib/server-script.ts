/**
 * Embedded copy of canfd_codec/serve.py, used by the "Download server script"
 * button on both /plot and /encode. This file is a single source of truth so
 * the script stays consistent across pages.
 *
 * IMPORTANT: when serve.py changes, this string must be updated to match.
 */

export const SERVER_SCRIPT = `#!/usr/bin/env python3
"""
CAN-to-WebSocket bridge server (zero external dependencies).

Reads CAN frames via candump (can-utils) and broadcasts them as JSON
over WebSocket to connected browser clients. Uses only Python stdlib.

Requirements:
    sudo apt install can-utils    # provides candump
    Python 3.10+

Usage:
    python can_ws_server.py                    # defaults: vcan0, port 8765
    python can_ws_server.py --bus can0         # use real CAN interface
    python can_ws_server.py --port 9000        # custom port
    python can_ws_server.py --filter 0x101,0x201  # only forward these IDs

    # Relay mode: connect to a remote server on the LAN
    python can_ws_server.py --source ws://192.168.25.201:8765
"""

import argparse, asyncio, base64, hashlib, json, os, queue, re, signal
import socket as socket_mod, struct, subprocess, threading, time

WS_MAGIC = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
CANDUMP_RE = re.compile(
    r"^\\s*\\((\\d+\\.\\d+)\\)\\s+(\\S+)\\s+([0-9A-Fa-f]+)\\s+\\[(\\d+)\\]\\s+(.+)$"
)

def parse_candump(line):
    m = CANDUMP_RE.match(line)
    if not m: return None
    ts = float(m.group(1))
    arb_id = int(m.group(3), 16)
    dlc = int(m.group(4))
    data = m.group(5).strip().replace(" ", "").upper()
    return ts, arb_id, data, dlc, dlc > 8

def format_cansend_arg(arb_id, data, is_fd):
    id_str = f"{arb_id:08X}" if arb_id > 0x7FF else f"{arb_id:03X}"
    hd = data.hex().upper()
    return f"{id_str}##0{hd}" if is_fd else f"{id_str}#{hd}"

def ws_accept(key):
    return base64.b64encode(hashlib.sha1(key.encode() + WS_MAGIC).digest()).decode()

def ws_frame(payload, opcode=0x1, masked=False):
    n = len(payload); mb = 0x80 if masked else 0
    if n < 126: hdr = struct.pack("!BB", 0x80|opcode, mb|n)
    elif n < 65536: hdr = struct.pack("!BBH", 0x80|opcode, mb|126, n)
    else: hdr = struct.pack("!BBQ", 0x80|opcode, mb|127, n)
    if masked:
        mk = os.urandom(4); mp = bytearray(payload)
        for i in range(len(mp)): mp[i] ^= mk[i%4]
        return hdr + mk + bytes(mp)
    return hdr + payload

def ws_read(data):
    if len(data) < 2: return None
    op = data[0] & 0x0F; masked = bool(data[1] & 0x80); n = data[1] & 0x7F; off = 2
    if n == 126:
        if len(data) < 4: return None
        n = struct.unpack("!H", data[2:4])[0]; off = 4
    elif n == 127:
        if len(data) < 10: return None
        n = struct.unpack("!Q", data[2:10])[0]; off = 10
    if masked:
        if len(data) < off+4: return None
        mask = data[off:off+4]; off += 4
    if len(data) < off+n: return None
    payload = bytearray(data[off:off+n])
    if masked:
        for i in range(n): payload[i] ^= mask[i%4]
    return op, bytes(payload), off+n


class CANWebSocketServer:
    def __init__(self, bus="vcan0", interface="socketcan", fd=True, bitrate=None,
                 data_bitrate=None, host="0.0.0.0", port=8765, filter_ids=None, source_url=None):
        self.bus, self.interface, self.fd = bus, interface, fd
        self.bitrate, self.data_bitrate = bitrate, data_bitrate
        self.host, self.port = host, port
        self.filter_ids = filter_ids
        self.source_url = source_url
        self._running = False
        self._clients = set()
        self._lock = threading.Lock()
        self._send_queue = queue.Queue()
        self._pycan_bus = None
        self._source_sock = None
        self._source_sock_lock = threading.Lock()

    async def _handle(self, reader, writer):
        remote = writer.get_extra_info("peername")
        reason = "unknown"
        try:
            req = await asyncio.wait_for(reader.readuntil(b"\\r\\n\\r\\n"), timeout=10)
        except Exception:
            writer.close(); return
        req_text = req.decode(errors="replace")
        lines = req_text.split("\\r\\n")
        method = lines[0].split(" ")[0] if lines else ""
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        origin = headers.get("origin", "*")
        if method == "OPTIONS":
            resp = f"HTTP/1.1 204 No Content\\r\\nAccess-Control-Allow-Origin: {origin}\\r\\nAccess-Control-Allow-Methods: GET, OPTIONS\\r\\nAccess-Control-Allow-Headers: *\\r\\nAccess-Control-Allow-Private-Network: true\\r\\nAccess-Control-Max-Age: 86400\\r\\n\\r\\n"
            writer.write(resp.encode())
            await writer.drain(); writer.close(); return
        key = headers.get("sec-websocket-key")
        if not key:
            writer.write(b"HTTP/1.1 400 Bad Request\\r\\n\\r\\n")
            await writer.drain(); writer.close(); return
        accept = ws_accept(key)
        resp = f"HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: {accept}\\r\\nAccess-Control-Allow-Origin: {origin}\\r\\nAccess-Control-Allow-Private-Network: true\\r\\n\\r\\n"
        writer.write(resp.encode())
        await writer.drain()
        with self._lock: self._clients.add(writer)
        print(f"  + Client {remote} ({len(self._clients)} connected)")
        try:
            writer.write(ws_frame(json.dumps({"type":"status","bus":self.bus,"fd":self.fd}).encode()))
            await writer.drain()
        except Exception as e:
            reason = f"status write failed: {e}"
        buf = b""
        try:
            while self._running:
                try: chunk = await asyncio.wait_for(reader.read(4096), timeout=30)
                except asyncio.TimeoutError:
                    try: writer.write(ws_frame(b"", opcode=0x9)); await writer.drain()
                    except Exception: reason = "ping failed"; break
                    continue
                if not chunk: reason = "client closed (EOF)"; break
                buf += chunk
                while True:
                    r = ws_read(buf)
                    if not r: break
                    op, payload, consumed = r; buf = buf[consumed:]
                    if op == 0x8:
                        reason = "close frame"
                        writer.write(ws_frame(payload[:2] if payload else b"", opcode=0x8))
                        await writer.drain(); return
                    elif op == 0x9:
                        writer.write(ws_frame(payload, opcode=0xA)); await writer.drain()
                    elif op == 0x1:
                        self._handle_text(payload, writer)
        except (ConnectionError, OSError) as e: reason = f"connection error: {e}"
        except Exception as e: reason = f"unexpected: {e}"
        finally:
            with self._lock: self._clients.discard(writer)
            print(f"  - Client {remote} ({len(self._clients)} connected) reason: {reason}")
            try: writer.close()
            except Exception: pass

    def _handle_text(self, payload, writer):
        try: msg = json.loads(payload.decode("utf-8", errors="replace"))
        except Exception: return
        if not isinstance(msg, dict) or msg.get("type") != "send": return
        try:
            aid_raw = msg.get("arbitration_id")
            aid = int(aid_raw, 0) if isinstance(aid_raw, str) else int(aid_raw)
            data_hex = str(msg.get("data", "")).replace(" ", "").replace(":", "")
            if len(data_hex) % 2: raise ValueError("odd-length data hex")
            data = bytes.fromhex(data_hex)
            is_fd = bool(msg.get("is_fd", False))
        except Exception as e:
            self._ack(writer, False, error=f"bad send payload: {e}"); return
        if aid < 0 or aid > 0x1FFFFFFF:
            self._ack(writer, False, aid=aid, error="arbitration_id out of range"); return
        mx = 64 if is_fd else 8
        if len(data) > mx:
            self._ack(writer, False, aid=aid, error=f"data too long ({len(data)}>{mx})"); return
        self._send_queue.put((aid, data, is_fd, writer))

    def _ack(self, writer, ok, aid=None, error=None):
        m = {"type":"send_ack","ok":ok}
        if aid is not None: m["arbitration_id"] = aid
        if error: m["error"] = error
        try: writer.write(ws_frame(json.dumps(m).encode()))
        except Exception: pass

    def _sender(self, loop):
        while self._running:
            try: item = self._send_queue.get(timeout=0.25)
            except queue.Empty: continue
            aid, data, is_fd, writer = item
            try: err = self._send_one(aid, data, is_fd)
            except Exception as e: err = f"send failed: {e}"
            if writer is not None:
                loop.call_soon_threadsafe(self._ack, writer, err is None, aid, err)
            if err: print(f"  send 0x{aid:X} ({len(data)}B fd={is_fd}) -> {err}")
            else:
                # Broadcast a tx-tagged frame so the plot can show what was sent.
                loop.call_soon_threadsafe(self._bcast,
                    json.dumps({"type":"frame","direction":"tx","arbitration_id":aid,
                        "data":data.hex().upper(),"dlc":len(data),
                        "timestamp":time.time(),"is_fd":is_fd}))

    def _send_one(self, aid, data, is_fd):
        if self.source_url:
            with self._source_sock_lock:
                sock = self._source_sock
                if sock is None: return "upstream not connected"
                try:
                    m = json.dumps({"type":"send","arbitration_id":aid,
                                    "data":data.hex().upper(),"is_fd":is_fd}).encode()
                    sock.sendall(ws_frame(m, masked=True)); return None
                except OSError as e: return f"upstream write failed: {e}"
        if self.interface != "socketcan" and self._pycan_bus is not None:
            try: import can
            except ImportError: return "python-can not installed"
            try:
                self._pycan_bus.send(can.Message(arbitration_id=aid, data=data,
                    is_fd=is_fd, is_extended_id=aid > 0x7FF))
                return None
            except Exception as e: return f"python-can send failed: {e}"
        arg = format_cansend_arg(aid, data, is_fd)
        try:
            res = subprocess.run(["cansend", self.bus, arg], capture_output=True, text=True, timeout=2)
        except FileNotFoundError: return "cansend not found (install can-utils)"
        except subprocess.TimeoutExpired: return "cansend timed out"
        if res.returncode != 0:
            return (res.stderr or res.stdout or "").strip() or f"cansend exit {res.returncode}"
        return None

    def _reader(self, loop):
        while self._running:
            try:
                proc = subprocess.Popen(["candump","-ta",self.bus],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
            except FileNotFoundError:
                print("  Error: candump not found. Install: sudo apt install can-utils"); break
            print(f"  CAN connected: {self.bus}")
            self._notify(loop, True)
            try:
                for line in proc.stdout:
                    if not self._running: break
                    p = parse_candump(line)
                    if not p: continue
                    ts, aid, data, dlc, is_fd = p
                    if self.filter_ids and aid not in self.filter_ids: continue
                    with self._lock:
                        if not self._clients: continue
                    loop.call_soon_threadsafe(self._bcast,
                        json.dumps({"type":"frame","direction":"rx","arbitration_id":aid,"data":data,"dlc":dlc,"timestamp":ts,"is_fd":is_fd}))
            except Exception: pass
            proc.terminate()
            try: proc.wait(timeout=2)
            except subprocess.TimeoutExpired: proc.kill()
            if not self._running: break
            err = ""
            if proc.returncode != 0 and proc.stderr: err = proc.stderr.read().strip()
            print(f"  CAN lost: {err or 'exited'}"); self._notify(loop, False, err or None)
            if self._running: print(f"  Reconnecting in 1s..."); time.sleep(1)

    def _source_reader(self, loop):
        from urllib.parse import urlparse
        parsed = urlparse(self.source_url)
        host = parsed.hostname or "localhost"; port = parsed.port or 8765
        print(f"  Source: {self.source_url}")
        while self._running:
            sock = None
            try:
                sock = socket_mod.create_connection((host, port), timeout=5)
                key = base64.b64encode(os.urandom(16)).decode()
                sock.sendall(f"GET / HTTP/1.1\\r\\nHost: {host}:{port}\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: {key}\\r\\n\\r\\n".encode())
                resp = b""
                while b"\\r\\n\\r\\n" not in resp:
                    c = sock.recv(4096)
                    if not c: raise ConnectionError("EOF during handshake")
                    resp += c
                idx = resp.index(b"\\r\\n\\r\\n")
                if "101" not in resp[:idx].decode(errors="replace").split("\\r\\n")[0]:
                    raise ConnectionError("Bad handshake")
                buf = resp[idx+4:]
                print(f"  Source connected: {host}:{port}")
                self._notify(loop, True)
                with self._source_sock_lock: self._source_sock = sock
                sock.settimeout(30)
                while self._running:
                    try: chunk = sock.recv(4096)
                    except socket_mod.timeout:
                        try: sock.sendall(ws_frame(b"", opcode=0x9, masked=True))
                        except Exception: break
                        continue
                    if not chunk: break
                    buf += chunk
                    while True:
                        r = ws_read(buf)
                        if not r: break
                        op, payload, consumed = r; buf = buf[consumed:]
                        if op == 0x1:
                            msg_str = payload.decode(errors="replace")
                            try: msg = json.loads(msg_str)
                            except json.JSONDecodeError: continue
                            if msg.get("type") == "status":
                                self.bus = msg.get("bus", self.bus)
                                self.fd = msg.get("fd", self.fd)
                            if msg.get("type") == "frame" and self.filter_ids:
                                if msg.get("arbitration_id") not in self.filter_ids: continue
                            with self._lock:
                                if self._clients: loop.call_soon_threadsafe(self._bcast, msg_str)
                        elif op == 0x9: sock.sendall(ws_frame(payload, opcode=0xA, masked=True))
                        elif op == 0x8: break
            except (ConnectionError, OSError, socket_mod.timeout) as e:
                print(f"  Source lost: {e}"); self._notify(loop, False, str(e))
            finally:
                with self._source_sock_lock:
                    if self._source_sock is sock: self._source_sock = None
                if sock:
                    try: sock.close()
                    except Exception: pass
            if not self._running: break
            print(f"  Reconnecting to source in 1s..."); time.sleep(1)

    def _pycan_reader(self, loop):
        try: import can
        except ImportError:
            print("  Error: python-can not installed. Run: pip install python-can"); return
        print(f"  CAN bus: {self.bus} (python-can, interface={self.interface}, fd={self.fd})")
        while self._running:
            try:
                kw = {"interface": self.interface, "channel": self.bus, "fd": self.fd}
                if self.bitrate: kw["bitrate"] = self.bitrate
                bus = can.Bus(**kw)
                if self.data_bitrate and hasattr(bus, "set_bitrate"):
                    bus.set_bitrate(self.bitrate, self.data_bitrate)
            except Exception as e:
                print(f"  Error opening CAN bus: {e}")
                if self._running: print("  Reconnecting in 1s..."); time.sleep(1)
                continue
            print(f"  CAN connected: {self.bus}")
            self._notify(loop, True)
            self._pycan_bus = bus
            try:
                while self._running:
                    try: msg = bus.recv(timeout=1.0)
                    except (ValueError, IndexError): continue
                    if msg is None: continue
                    aid = msg.arbitration_id
                    if self.filter_ids and aid not in self.filter_ids: continue
                    with self._lock:
                        if not self._clients: continue
                    loop.call_soon_threadsafe(self._bcast,
                        json.dumps({"type":"frame","direction":"rx","arbitration_id":aid,
                            "data":msg.data.hex().upper(),"dlc":msg.dlc,
                            "timestamp":msg.timestamp or time.time(), "is_fd":msg.is_fd}))
            except (ConnectionError, OSError) as e: print(f"  python-can error: {e}")
            finally:
                self._pycan_bus = None
                try: bus.shutdown()
                except Exception: pass
            if not self._running: break
            print(f"  CAN lost"); self._notify(loop, False)
            if self._running: print("  Reconnecting in 1s..."); time.sleep(1)

    def _notify(self, loop, connected, error=None):
        msg = json.dumps({"type":"status","bus":self.bus,"fd":self.fd,
                          "connected":connected,**({"error":error} if error else {})})
        with self._lock:
            if self._clients: loop.call_soon_threadsafe(self._bcast, msg)

    def _bcast(self, message):
        frame = ws_frame(message.encode())
        with self._lock:
            dead = [w for w in self._clients if not _try_write(w, frame)]
            for w in dead: self._clients.discard(w)

    async def run(self):
        self._running = True; loop = asyncio.get_running_loop()
        for s in (signal.SIGINT, signal.SIGTERM): loop.add_signal_handler(s, self.stop)
        srv = await asyncio.start_server(self._handle, self.host, self.port)
        print(f"WebSocket server on ws://{self.host}:{self.port}")
        if self.source_url: target = self._source_reader
        elif self.interface != "socketcan": target = self._pycan_reader
        else: target = self._reader
        rt = threading.Thread(target=target, args=(loop,), daemon=True); rt.start()
        st = threading.Thread(target=self._sender, args=(loop,), daemon=True); st.start()
        while self._running: await asyncio.sleep(0.5)
        srv.close(); await srv.wait_closed()
        rt.join(timeout=3); st.join(timeout=3)
        print("\\nStopped.")

    def stop(self): self._running = False

def _try_write(w, data):
    try: w.write(data); return True
    except Exception: return False

if __name__ == "__main__":
    p = argparse.ArgumentParser(description="CAN-to-WebSocket bridge (zero dependencies)")
    p.add_argument("--bus", default="vcan0", help="CAN interface (default: vcan0)")
    p.add_argument("--interface", default="socketcan",
        help="python-can interface type (default: socketcan, use slcan for USB adapters)")
    p.add_argument("--no-fd", action="store_true", help="Disable CAN FD")
    p.add_argument("--bitrate", type=int, help="CAN bitrate in bit/s (e.g. 1000000)")
    p.add_argument("--data-bitrate", type=int, help="CAN FD data bitrate in bit/s (e.g. 5000000)")
    p.add_argument("--host", default="0.0.0.0", help="Bind address (default: 0.0.0.0)")
    p.add_argument("--port", type=int, default=8765, help="Port (default: 8765)")
    p.add_argument("--filter", help="CAN IDs to forward (e.g. 0x101,0x202)")
    p.add_argument("--source", help="Connect to remote server instead of candump (e.g. ws://192.168.25.201:8765)")
    args = p.parse_args()
    fids = {int(x, 0) for x in args.filter.split(",")} if args.filter else None
    asyncio.run(CANWebSocketServer(
        bus=args.bus, interface=args.interface, fd=not args.no_fd,
        bitrate=args.bitrate, data_bitrate=args.data_bitrate,
        host=args.host, port=args.port, filter_ids=fids,
        source_url=args.source,
    ).run())
`;

export const SERVER_SCRIPT_SHA256 = 'f17df2fca81bb454477e961d1a6e710e0b6defa4410cd32452a7eafe129e46f5';

export function downloadServerScript(filename = 'can_ws_server.py'): void {
  const blob = new Blob([SERVER_SCRIPT], { type: 'text/x-python' });
  const link = document.createElement('a');
  link.download = filename;
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
}
