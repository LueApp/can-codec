<script lang="ts">
  import { codecStore } from '$lib/codec-store.svelte';
  import { parseCandump } from '$lib/codec';
  import { WebSocketClient, type RawFrame } from '$lib/websocket-client.svelte';
  import type { DecodedMessage, DecodedSignal, Message, MavlinkInfo } from '$lib/types';
  import yaml from 'js-yaml';
  import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler, ScatterController } from 'chart.js';
  import zoomPlugin from 'chartjs-plugin-zoom';

  Chart.register(LineController, ScatterController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler, zoomPlugin);

  // ---- Types ----

  interface FrameRef {
    id: number;
    data: number[];
    timestamp: number;
    is_fd: boolean;
    extraFrames?: { data: number[]; timestamp: number }[];
  }

  interface SignalSample {
    time: number;
    value: number;
    frame: FrameRef;
  }

  interface SignalSeries {
    key: string;        // e.g. "1.1 / ARM_MODE_SWITCH / mode"
    group: string;      // e.g. "1.1 / ARM_MODE_SWITCH" or "SetSpeed"
    signal: string;     // e.g. "mode"
    unit: string;
    samples: SignalSample[];
  }

  interface ChartPanel {
    id: string;          // unique panel ID
    keys: string[];      // signal keys rendered as datasets on this chart
  }

  interface MessageTimingEntry {
    time: number;
    frame: FrameRef;
  }

  // ---- Server script (embedded for download) ----

  const SERVER_SCRIPT = `#!/usr/bin/env python3
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

import argparse, asyncio, base64, hashlib, json, os, re, signal
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
    return ts, arb_id, data, dlc > 8

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
        except (ConnectionError, OSError) as e: reason = f"connection error: {e}"
        except Exception as e: reason = f"unexpected: {e}"
        finally:
            with self._lock: self._clients.discard(writer)
            print(f"  - Client {remote} ({len(self._clients)} connected) reason: {reason}")
            try: writer.close()
            except Exception: pass

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
                    ts, aid, data, is_fd = p
                    if self.filter_ids and aid not in self.filter_ids: continue
                    with self._lock:
                        if not self._clients: continue
                    loop.call_soon_threadsafe(self._bcast,
                        json.dumps({"type":"frame","arbitration_id":aid,"data":data,"timestamp":ts,"is_fd":is_fd}))
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
                        json.dumps({"type":"frame","arbitration_id":aid,
                            "data":msg.data.hex().upper(),"timestamp":msg.timestamp or time.time(),
                            "is_fd":msg.is_fd}))
            except (ConnectionError, OSError) as e: print(f"  python-can error: {e}")
            finally:
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
        t = threading.Thread(target=target, args=(loop,), daemon=True); t.start()
        while self._running: await asyncio.sleep(0.5)
        srv.close(); await srv.wait_closed(); t.join(timeout=3)
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

  function downloadServer() {
    const blob = new Blob([SERVER_SCRIPT], { type: 'text/x-python' });
    const link = document.createElement('a');
    link.download = 'can_ws_server.py';
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
  }

  let showSetup = $state(false);

  // ---- State ----

  type InputMode = 'paste' | 'live';
  let mode = $state<InputMode>('paste');

  // Paste mode state
  let input = $state('');

  // Shared state
  let allSeries = $state<SignalSeries[]>([]);
  let chartPanels = $state<ChartPanel[]>([]);
  let nextPanelId = 0;
  let selected = $derived(new Set(chartPanels.flatMap(p => p.keys)));
  let status = $state('');
  let chartInstances = new Map<string, Chart>();
  let addDropdownOpen = $state<string | null>(null); // panel ID of open "+" dropdown

  // Chart view mode (multi-select, reorderable)
  type ChartView = 'signals' | 'timeline' | 'interval';
  let activeViews = $state<Set<ChartView>>(new Set(['signals']));
  let viewOrder = $state<ChartView[]>(['signals', 'timeline', 'interval']);
  let dragView = $state<ChartView | null>(null);
  let dragOverView = $state<ChartView | null>(null);

  // Message-level timing store (non-reactive, same pattern as liveSampleStore)
  const messageTimingStore = new Map<string, MessageTimingEntry[]>();
  let messageTimingLabels = $state<string[]>([]);
  let timelineChart: Chart | null = null;

  // Interval view panels (reuse ChartPanel pattern)
  let intervalPanels = $state<ChartPanel[]>([]);
  let intervalSelected = $derived(new Set(intervalPanels.flatMap(p => p.keys)));
  let intervalInstances = new Map<string, Chart>();

  // Live mode state
  let wsClient = new WebSocketClient();
  let wsUrl = $state(
    typeof localStorage !== 'undefined'
      ? (localStorage.getItem('cancodec_ws_url') ?? 'ws://localhost:8765')
      : 'ws://localhost:8765'
  );
  let liveStartTime: number | null = null;
  let mavlinkBuffers = new Map<number, { frames: Uint8Array[]; timestamps: number[]; is_fd: boolean }>();
  let mavlinkTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let chartUpdatePending = false;
  const CHART_UPDATE_INTERVAL = 50; // ms (20 fps)

  // Non-reactive sample storage for live mode (bypasses Svelte $state proxy overhead)
  const liveSampleStore = new Map<string, SignalSample[]>();
  let liveSampleCounts = $state<Record<string, number>>({});

  // Raw frame log (candump-style)
  let showRawLog = $state(false);
  let rawFrameLog: string[] = [];
  let rawFrameCount = $state(0);
  let rawLogMax = $state(2000);
  let rawLogEl: HTMLPreElement | undefined;
  let rawLogAutoScroll = true;

  // Pause live chart updates (data still accumulates)
  let paused = $state(false);

  function togglePause() {
    paused = !paused;
    if (!paused) {
      updateLiveCharts();
      updateRawLog();
    }
  }

  // Stream-to-file recording (File System Access API)
  let dumpWriter: FileSystemWritableFileStream | null = null;
  let dumpFrameCount = $state(0);
  let dumpActive = $state(false);
  let dumpMatchedOnly = $state(false);
  let matchedFrameCount = $state(0);

  // Copy-to-clipboard toast
  let copyToast = $state('');
  let copyToastTimer: ReturnType<typeof setTimeout> | undefined;
  function showCopyToast(msg: string) {
    copyToast = msg;
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => { copyToast = ''; }, 1500);
  }

  // Buffer mode
  type BufferMode = 'unlimited' | 'samples' | 'time';
  let bufferMode = $state<BufferMode>('samples');
  let bufferSamples = $state(5000);
  let bufferSeconds = $state(60);

  // ---- Mode switching ----

  function switchMode(newMode: InputMode) {
    if (mode === 'live' && newMode !== 'live') {
      stopDumpToFile();
      wsClient.disconnect();
      clearMavlinkBuffers();
    }
    if (newMode !== mode) {
      resetCharts();
    }
    mode = newMode;
  }

  function resetCharts() {
    for (const [, chart] of chartInstances) chart.destroy();
    chartInstances.clear();
    if (timelineChart) { timelineChart.destroy(); timelineChart = null; }
    for (const [, chart] of intervalInstances) chart.destroy();
    intervalInstances.clear();
    allSeries = [];
    chartPanels = [];
    intervalPanels = [];
    nextPanelId = 0;
    addDropdownOpen = null;
    status = '';
    liveStartTime = null;
    liveSampleStore.clear();
    liveSampleCounts = {};
    messageTimingStore.clear();
    messageTimingLabels = [];
    rawFrameLog = [];
    rawFrameCount = 0;
    matchedFrameCount = 0;
  }

  // ---- Paste mode: analyze ----

  function isMavlinkCanId(canId: number): boolean {
    return (canId & 0x10000) !== 0;
  }

  function analyze() {
    resetCharts();
    const lines = input.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return;

    const codec = codecStore.codec;
    const seriesMap = new Map<string, SignalSeries>();
    let firstTs: number | null = null;
    let lineIndex = 0;

    type FrameGroup = { canId: number; timestamps: (number | undefined)[]; datas: Uint8Array[] };
    const groups: (FrameGroup | { line: string; timestamp?: number })[] = [];

    for (const line of lines) {
      const frame = parseCandump(line);
      if (!frame) continue;

      if (isMavlinkCanId(frame.canId)) {
        const last = groups[groups.length - 1];
        if (last && 'canId' in last && last.canId === frame.canId) {
          last.timestamps.push(frame.timestamp);
          last.datas.push(frame.data);
        } else {
          groups.push({ canId: frame.canId, timestamps: [frame.timestamp], datas: [frame.data] });
        }
      } else {
        groups.push({ line, timestamp: frame.timestamp });
      }
    }

    for (const group of groups) {
      let decoded: DecodedMessage | null = null;
      let mavlink: MavlinkInfo | undefined;
      let timestamp: number | undefined;

      if ('canId' in group) {
        timestamp = group.timestamps[0] ?? undefined;
        try {
          const res = group.datas.length === 1
            ? codec.smartDecode(group.canId, group.datas[0])
            : codec.smartDecodeMultiFrame(group.canId, group.datas);
          if (res) { decoded = res.decoded; mavlink = res.mavlink; }
        } catch { /* skip */ }
      } else {
        timestamp = group.timestamp;
        const frame = parseCandump(group.line);
        if (frame) {
          try {
            const res = codec.smartDecode(frame.canId, frame.data);
            if (res) { decoded = res.decoded; mavlink = res.mavlink; }
          } catch { /* skip */ }
        }
      }

      if (!decoded) { lineIndex++; continue; }

      const absTs = timestamp ?? 0;
      const isFd = 'canId' in group ? true : (() => { const f = parseCandump(group.line); return f?.isFD ?? false; })();
      let frameRef: FrameRef;
      if ('canId' in group) {
        frameRef = { id: decoded.msg_id, data: Array.from(group.datas[0]), timestamp: absTs, is_fd: isFd };
        if (group.datas.length > 1) {
          frameRef.extraFrames = group.datas.slice(1).map((d, i) => ({
            data: Array.from(d),
            timestamp: group.timestamps[i + 1] ?? absTs,
          }));
        }
      } else {
        const f = parseCandump(group.line);
        frameRef = { id: decoded.msg_id, data: f ? Array.from(f.data) : decoded.raw_data, timestamp: absTs, is_fd: isFd };
      }

      if (timestamp !== undefined) {
        if (firstTs === null) firstTs = timestamp;
        timestamp = timestamp - firstTs;
      } else {
        timestamp = lineIndex;
      }

      const baseLabel = mavlink
        ? `${mavlink.sys_id}.${mavlink.comp_id} / ${decoded.name}`
        : decoded.name;

      const msg = codecStore.codec.getMessageByName(decoded.name);
      const signalEntries: { signals: typeof decoded.signals; groupLabel: string }[] = [];
      if (decoded.is_broadcast && decoded.sub_messages) {
        for (const sub of decoded.sub_messages) {
          const mux = getMuxSuffix(msg, sub.signals);
          signalEntries.push({ signals: sub.signals, groupLabel: `${baseLabel} / N${sub.node_id}${mux}` });
        }
      } else {
        const mux = getMuxSuffix(msg, decoded.signals);
        const groupLabel = (msg && msg.node_count > 1)
          ? `${baseLabel} / N${decoded.node_id}${mux}`
          : `${baseLabel}${mux}`;
        signalEntries.push({ signals: decoded.signals, groupLabel });
      }

      // Message-level timing entry
      for (const entry of signalEntries) {
        let timingArr = messageTimingStore.get(entry.groupLabel);
        if (!timingArr) { timingArr = []; messageTimingStore.set(entry.groupLabel, timingArr); }
        timingArr.push({ time: timestamp!, frame: frameRef });
      }

      for (const entry of signalEntries) {
        for (const sig of entry.signals) {
          if (sig.bitfield_flags) continue;
          const val = typeof sig.physical_value === 'number' ? sig.physical_value : NaN;
          if (isNaN(val)) continue;

          const key = `${entry.groupLabel} / ${sig.name}`;
          let series = seriesMap.get(key);
          if (!series) {
            series = { key, group: entry.groupLabel, signal: sig.name, unit: sig.unit, samples: [] };
            seriesMap.set(key, series);
          }
          series.samples.push({ time: timestamp!, value: val, frame: frameRef });
        }
      }
      lineIndex++;
    }

    messageTimingLabels = Array.from(messageTimingStore.keys()).sort();

    allSeries = Array.from(seriesMap.values()).sort((a, b) => a.key.localeCompare(b.key));
    if (allSeries.length <= 12) {
      chartPanels = allSeries.map(s => ({ id: `p${nextPanelId++}`, keys: [s.key] }));
    }
    // Auto-select interval panels
    if (messageTimingLabels.length <= 12) {
      intervalPanels = messageTimingLabels.map(k => ({ id: `ip${nextPanelId++}`, keys: [k] }));
    }
    status = `${allSeries.length} signals found from ${groups.length} frames`;
    renderCurrentView();
  }

  // ---- Live mode ----

  function connectLive() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('cancodec_ws_url', wsUrl);
    }
    resetCharts();
    mavlinkBuffers.clear();
    wsClient.setFrameCallback(handleLiveFrame);
    wsClient.connect(wsUrl);
  }

  function disconnectLive() {
    paused = false;
    stopDumpToFile();
    wsClient.disconnect();
    clearMavlinkBuffers();
  }

  async function startDumpToFile() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const handle = await (window as any).showSaveFilePicker({
      suggestedName: `candump_${ts}.log`,
      types: [{ description: 'Log files', accept: { 'text/plain': ['.log'] } }],
    });
    dumpWriter = await handle.createWritable();
    dumpFrameCount = 0;
    dumpActive = true;
  }

  async function stopDumpToFile() {
    if (!dumpWriter) return;
    const w = dumpWriter;
    dumpWriter = null;
    dumpActive = false;
    await w.close();
  }

  function clearMavlinkBuffers() {
    for (const timer of mavlinkTimers.values()) clearTimeout(timer);
    mavlinkTimers.clear();
    mavlinkBuffers.clear();
  }

  function formatRawFrame(frame: RawFrame): string {
    const ts = frame.timestamp.toFixed(6);
    const iface = wsClient.busInfo?.bus ?? 'can0';
    const id = frame.arbitration_id > 0x7FF
      ? frame.arbitration_id.toString(16).toUpperCase().padStart(8, '0')
      : frame.arbitration_id.toString(16).toUpperCase().padStart(3, '0');
    const dlc = frame.data.length.toString().padStart(2, '0');
    const hex = Array.from(frame.data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    return ` (${ts})  ${iface}  ${id}  [${dlc}]  ${hex}`;
  }

  let rawLogVersion = 0;
  function appendRawFrame(frame: RawFrame, matched?: boolean) {
    const line = formatRawFrame(frame);
    rawFrameLog.push(line);
    if (rawFrameLog.length > rawLogMax) {
      rawFrameLog.splice(0, rawFrameLog.length - rawLogMax);
    }
    rawFrameCount = rawFrameLog.length;
    rawLogVersion++;
    if (dumpWriter && (!dumpMatchedOnly || matched === true)) {
      dumpWriter.write(line + '\n');
      dumpFrameCount++;
    }
  }

  function handleLiveFrame(frame: RawFrame) {
    const canId = frame.arbitration_id;

    if (isMavlinkCanId(canId)) {
      appendRawFrame(frame);

      const isStartFrame = frame.data.length > 0 && frame.data[0] === 0xFD;
      const buf = mavlinkBuffers.get(canId);

      // Flush previous buffer if new MAVLink message starts
      if (isStartFrame && buf && buf.frames.length > 0) {
        flushMavlinkBuffer(canId, buf);
      }

      if (isStartFrame) {
        mavlinkBuffers.set(canId, { frames: [frame.data], timestamps: [frame.timestamp], is_fd: frame.is_fd });
      } else if (buf) {
        buf.frames.push(frame.data);
        buf.timestamps.push(frame.timestamp);
      }
      // else: non-start frame with no buffer — skip

      // Set/reset flush timeout for stale buffers
      const existing = mavlinkTimers.get(canId);
      if (existing) clearTimeout(existing);
      mavlinkTimers.set(canId, setTimeout(() => {
        const b = mavlinkBuffers.get(canId);
        if (b && b.frames.length > 0) {
          flushMavlinkBuffer(canId, b);
          scheduleChartUpdate();
        }
        mavlinkTimers.delete(canId);
      }, 100));
    } else {
      // Standard CAN — decode first to know match status for dump filtering
      let matched = false;
      try {
        const res = codecStore.codec.smartDecode(canId, frame.data);
        if (res) {
          matched = true;
          matchedFrameCount++;
          appendDecoded(res.decoded, res.mavlink, frame.timestamp, frame.is_fd);
        }
      } catch { /* skip */ }
      appendRawFrame(frame, matched);
    }

    scheduleChartUpdate();
  }

  function flushMavlinkBuffer(canId: number, buf: { frames: Uint8Array[]; timestamps: number[]; is_fd: boolean }) {
    let decoded = false;
    try {
      const res = buf.frames.length === 1
        ? codecStore.codec.smartDecode(canId, buf.frames[0])
        : codecStore.codec.smartDecodeMultiFrame(canId, buf.frames);
      if (res) {
        decoded = true;
        matchedFrameCount += buf.frames.length;
        const ts = buf.timestamps[0] ?? 0;
        appendDecoded(res.decoded, res.mavlink, ts, buf.is_fd, buf.frames, buf.timestamps);
      }
    } catch { /* skip */ }
    if (decoded && dumpMatchedOnly && dumpWriter) {
      const iface = wsClient.busInfo?.bus ?? 'can0';
      const id = canId > 0x7FF
        ? canId.toString(16).toUpperCase().padStart(8, '0')
        : canId.toString(16).toUpperCase().padStart(3, '0');
      for (let i = 0; i < buf.frames.length; i++) {
        const ts = (buf.timestamps[i] ?? 0).toFixed(6);
        const data = buf.frames[i];
        const dlc = data.length.toString().padStart(2, '0');
        const hex = Array.from(data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        dumpWriter.write(` (${ts})  ${iface}  ${id}  [${dlc}]  ${hex}\n`);
        dumpFrameCount++;
      }
    }
    mavlinkBuffers.delete(canId);
  }

  function formatFrameShort(f: FrameRef): string {
    const id = f.id.toString(16).toUpperCase().padStart(f.id > 0x7FF ? 8 : 3, '0');
    const hex = f.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    const nFrames = 1 + (f.extraFrames?.length ?? 0);
    const suffix = nFrames > 1 ? ` (+${nFrames - 1} frames)` : '';
    return `0x${id}  ${hex}${suffix}`;
  }

  function formatOneFrame(id: string, iface: string, data: number[], timestamp: number): string {
    const ts = timestamp.toFixed(6);
    const dlc = data.length.toString().padStart(2, '0');
    const hex = data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    return ` (${ts})  ${iface}  ${id}  [${dlc}]  ${hex}`;
  }

  function formatFrameCandump(f: FrameRef): string {
    const iface = wsClient.busInfo?.bus ?? 'can0';
    const id = f.id > 0x7FF
      ? f.id.toString(16).toUpperCase().padStart(8, '0')
      : f.id.toString(16).toUpperCase().padStart(3, '0');
    const lines = [formatOneFrame(id, iface, f.data, f.timestamp)];
    if (f.extraFrames) {
      for (const ef of f.extraFrames) {
        lines.push(formatOneFrame(id, iface, ef.data, ef.timestamp));
      }
    }
    return lines.join('\n');
  }

  function getMuxSuffix(msg: Message | null, signals: { name: string; enum_name?: string | null }[]): string {
    if (!msg?.mux_signal) return '';
    const muxSig = signals.find(s => s.name === msg.mux_signal);
    if (muxSig?.enum_name) return ` / ${muxSig.enum_name}`;
    return '';
  }

  function appendSignalSamples(
    signals: { name: string; physical_value: number; unit: string; bitfield_flags: Record<string, boolean> | null }[],
    groupLabel: string,
    time: number,
    frame: FrameRef
  ): boolean {
    let newSeriesAdded = false;
    for (const sig of signals) {
      if (sig.bitfield_flags) continue;
      const val = typeof sig.physical_value === 'number' ? sig.physical_value : NaN;
      if (isNaN(val)) continue;

      const key = `${groupLabel} / ${sig.name}`;

      let samples = liveSampleStore.get(key);
      if (!samples) {
        samples = [];
        liveSampleStore.set(key, samples);
        const meta: SignalSeries = { key, group: groupLabel, signal: sig.name, unit: sig.unit, samples: [] };
        allSeries = [...allSeries, meta].sort((a, b) => a.key.localeCompare(b.key));
        newSeriesAdded = true;
      }
      samples.push({ time, value: val, frame });

      if (bufferMode === 'samples' && samples.length > bufferSamples) {
        samples.splice(0, samples.length - bufferSamples);
      } else if (bufferMode === 'time') {
        const cutoff = time - bufferSeconds;
        let trimTo = 0;
        while (trimTo < samples.length && samples[trimTo].time < cutoff) trimTo++;
        if (trimTo > 0) samples.splice(0, trimTo);
      }
    }
    return newSeriesAdded;
  }

  function appendDecoded(
    decoded: DecodedMessage, mavlink: MavlinkInfo | undefined, timestamp: number, is_fd: boolean,
    rawFrames?: Uint8Array[], rawTimestamps?: number[]
  ) {
    if (liveStartTime === null) liveStartTime = timestamp;
    const time = timestamp - liveStartTime;
    const primaryData = rawFrames ? Array.from(rawFrames[0]) : decoded.raw_data;
    const frame: FrameRef = { id: decoded.msg_id, data: primaryData, timestamp, is_fd };
    if (rawFrames && rawFrames.length > 1) {
      frame.extraFrames = rawFrames.slice(1).map((f, i) => ({
        data: Array.from(f),
        timestamp: rawTimestamps?.[i + 1] ?? timestamp,
      }));
    }

    const baseLabel = mavlink
      ? `${mavlink.sys_id}.${mavlink.comp_id} / ${decoded.name}`
      : decoded.name;

    let newSeriesAdded = false;
    let newTimingAdded = false;

    const msg = codecStore.codec.getMessageByName(decoded.name);
    if (decoded.is_broadcast && decoded.sub_messages) {
      for (const sub of decoded.sub_messages) {
        const mux = getMuxSuffix(msg, sub.signals);
        const groupLabel = `${baseLabel} / N${sub.node_id}${mux}`;
        if (appendMessageTiming(groupLabel, time, frame)) newTimingAdded = true;
        if (appendSignalSamples(sub.signals, groupLabel, time, frame)) newSeriesAdded = true;
      }
    } else {
      const mux = getMuxSuffix(msg, decoded.signals);
      const groupLabel = (msg && msg.node_count > 1)
        ? `${baseLabel} / N${decoded.node_id}${mux}`
        : `${baseLabel}${mux}`;
      if (appendMessageTiming(groupLabel, time, frame)) newTimingAdded = true;
      if (appendSignalSamples(decoded.signals, groupLabel, time, frame)) newSeriesAdded = true;
    }

    if (newSeriesAdded || newTimingAdded) {
      if (pendingLayoutConfig) {
        autoApplyPendingLayout();
      } else {
        // Auto-select new signals as solo panels if total is small
        if (newSeriesAdded && allSeries.length <= 12) {
          const inPanels = new Set(chartPanels.flatMap(p => p.keys));
          const newPanels = allSeries
            .filter(s => !inPanels.has(s.key))
            .map(s => ({ id: `p${nextPanelId++}`, keys: [s.key] }));
          if (newPanels.length > 0) {
            chartPanels = [...chartPanels, ...newPanels];
          }
        }

        if (newTimingAdded && messageTimingLabels.length <= 12) {
          const inPanels = new Set(intervalPanels.flatMap(p => p.keys));
          const newPanels = messageTimingLabels
            .filter(k => !inPanels.has(k))
            .map(k => ({ id: `ip${nextPanelId++}`, keys: [k] }));
          if (newPanels.length > 0) {
            intervalPanels = [...intervalPanels, ...newPanels];
          }
        }
      }
    }
  }

  function appendMessageTiming(groupLabel: string, time: number, frame: FrameRef): boolean {
    let arr = messageTimingStore.get(groupLabel);
    let isNew = false;
    if (!arr) {
      arr = [];
      messageTimingStore.set(groupLabel, arr);
      messageTimingLabels = Array.from(messageTimingStore.keys()).sort();
      isNew = true;
    }
    arr.push({ time, frame });
    if (bufferMode === 'samples' && arr.length > bufferSamples) {
      arr.splice(0, arr.length - bufferSamples);
    } else if (bufferMode === 'time') {
      const cutoff = time - bufferSeconds;
      let trimTo = 0;
      while (trimTo < arr.length && arr[trimTo].time < cutoff) trimTo++;
      if (trimTo > 0) arr.splice(0, trimTo);
    }
    return isNew;
  }

  function scheduleChartUpdate() {
    if (chartUpdatePending) return;
    chartUpdatePending = true;
    setTimeout(() => {
      try {
        if (!paused) {
          updateLiveCharts();
          updateRawLog();
        }
      } finally {
        chartUpdatePending = false;
      }
    }, CHART_UPDATE_INTERVAL);
  }

  let rawLogRenderedVersion = 0;
  function updateRawLog() {
    if (!showRawLog || !rawLogEl) return;
    if (rawLogVersion === rawLogRenderedVersion) return;
    rawLogEl.textContent = rawFrameLog.join('\n');
    rawLogRenderedVersion = rawLogVersion;
    if (rawLogAutoScroll) {
      rawLogEl.scrollTop = rawLogEl.scrollHeight;
    }
  }

  function updateLiveCharts() {
    if (activeViews.has('timeline')) updateLiveTimeline();
    if (activeViews.has('interval')) updateLiveIntervalCharts();
    if (activeViews.has('signals')) updateLiveSignalCharts();
    updateLiveCounts();
  }

  function updateLiveSignalCharts() {
    let needsRebuild = chartPanels.some(p => !chartInstances.has(p.id));
    if (chartInstances.size !== chartPanels.length) needsRebuild = true;
    if (!needsRebuild) {
      for (const panel of chartPanels) {
        const chart = chartInstances.get(panel.id);
        if (chart && chart.data.datasets.length !== panel.keys.length) {
          needsRebuild = true;
          break;
        }
      }
    }

    if (needsRebuild) {
      renderCharts();
      return;
    }

    for (const panel of chartPanels) {
      const chart = chartInstances.get(panel.id);
      if (!chart) continue;

      let xMin = Infinity, xMax = -Infinity;
      for (let j = 0; j < panel.keys.length; j++) {
        const samples = liveSampleStore.get(panel.keys[j]) ?? [];
        const ds = chart.data.datasets[j];
        if (!ds) continue;
        const points = samples.map(s => ({ x: s.time, y: s.value, frame: s.frame }));
        ds.data = points;
        (ds as any).pointRadius = points.length <= 100 ? 3 : 0;
        if (points.length > 0) {
          if (points[0].x < xMin) xMin = points[0].x;
          if (points[points.length - 1].x > xMax) xMax = points[points.length - 1].x;
        }
      }
      if (xMin < Infinity) {
        const xScale = chart.options.scales!.x as any;
        xScale.min = xMin;
        xScale.max = xMax;
      }
      chart.update('none');
    }
  }

  function updateLiveCounts() {
    // Update reactive counts for display (at chart refresh rate, not per-frame)
    const counts: Record<string, number> = {};
    for (const [key, samples] of liveSampleStore) counts[key] = samples.length;
    liveSampleCounts = counts;
    status = `${allSeries.length} signals`;
  }

  // ---- Signal selection & panel management ----

  function toggleSignal(key: string) {
    const panelIdx = chartPanels.findIndex(p => p.keys.includes(key));
    if (panelIdx >= 0) {
      // Remove signal from its panel
      const panel = chartPanels[panelIdx];
      if (panel.keys.length === 1) {
        chartPanels = chartPanels.filter((_, i) => i !== panelIdx);
      } else {
        chartPanels = chartPanels.map((p, i) =>
          i === panelIdx ? { ...p, keys: p.keys.filter(k => k !== key) } : p
        );
      }
    } else {
      // Add signal as a new solo panel
      chartPanels = [...chartPanels, { id: `p${nextPanelId++}`, keys: [key] }];
    }
    if (mode === 'live') scheduleChartUpdate();
    else renderCharts();
  }

  function selectAll() {
    const already = new Set(chartPanels.flatMap(p => p.keys));
    const newPanels = allSeries
      .filter(s => !already.has(s.key))
      .map(s => ({ id: `p${nextPanelId++}`, keys: [s.key] }));
    chartPanels = [...chartPanels, ...newPanels];
    if (mode === 'live') scheduleChartUpdate();
    else renderCharts();
  }

  function selectNone() {
    chartPanels = [];
    addDropdownOpen = null;
    renderCharts();
  }

  function addToPanel(panelId: string, signalKey: string) {
    // Move signal from its current panel (if any) into the target panel
    chartPanels = chartPanels
      .map(p => {
        if (p.id === panelId) return { ...p, keys: [...p.keys, signalKey] };
        if (p.keys.includes(signalKey)) return { ...p, keys: p.keys.filter(k => k !== signalKey) };
        return p;
      })
      .filter(p => p.keys.length > 0);
    addDropdownOpen = null;
    if (mode === 'live') scheduleChartUpdate();
    else renderCharts();
  }

  function splitFromPanel(panelId: string, signalKey: string) {
    // Move signal out of its panel into a new solo panel
    chartPanels = [
      ...chartPanels.map(p =>
        p.id === panelId ? { ...p, keys: p.keys.filter(k => k !== signalKey) } : p
      ).filter(p => p.keys.length > 0),
      { id: `p${nextPanelId++}`, keys: [signalKey] },
    ];
    if (mode === 'live') scheduleChartUpdate();
    else renderCharts();
  }

  // ---- Chart rendering (full rebuild) ----

  const CHART_COLORS = [
    '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
    '#39d2c0', '#f78166', '#7ee787', '#a5d6ff', '#ffa657',
  ];

  const zoomOptions = {
    zoom: {
      wheel: { enabled: true },
      pinch: { enabled: true },
      drag: {
        enabled: true,
        backgroundColor: 'rgba(88, 166, 255, 0.15)',
        borderColor: 'rgba(88, 166, 255, 0.5)',
        borderWidth: 1,
      },
      mode: 'xy' as const,
    },
  };

  function resetAllZoom() {
    for (const [, chart] of chartInstances) chart.resetZoom();
    if (timelineChart) timelineChart.resetZoom();
    for (const [, chart] of intervalInstances) chart.resetZoom();
  }

  function getSamples(key: string): SignalSample[] {
    return mode === 'live' ? (liveSampleStore.get(key) ?? []) : (allSeries.find(s => s.key === key)?.samples ?? []);
  }

  function renderCharts() {
    for (const [, chart] of chartInstances) chart.destroy();
    chartInstances.clear();

    requestAnimationFrame(() => {
      for (const panel of chartPanels) {
        const canvas = document.getElementById(`chart-${panel.id}`) as HTMLCanvasElement | null;
        if (!canvas) continue;

        const seriesList = panel.keys.map(k => allSeries.find(s => s.key === k)).filter(Boolean) as SignalSeries[];
        const multi = seriesList.length > 1;

        // Determine shared unit for y-axis label
        const units = new Set(seriesList.map(s => s.unit).filter(Boolean));
        const yLabel = units.size === 1 ? [...units][0] : 'value';

        const datasets = seriesList.map((series, j) => {
          const color = CHART_COLORS[j % CHART_COLORS.length];
          const samples = getSamples(series.key);
          return {
            label: `${series.group} / ${series.signal}${series.unit ? ` (${series.unit})` : ''}`,
            data: samples.map(s => ({ x: s.time, y: s.value, frame: s.frame })),
            borderColor: color,
            backgroundColor: color + '20',
            borderWidth: 1.5,
            pointRadius: samples.length <= 100 ? 3 : 0,
            pointHoverRadius: 4,
            fill: !multi, // disable fill when overlaying to avoid clutter
            tension: 0,
          };
        });

        const chart = new Chart(canvas, {
          type: 'line',
          data: { datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            onClick: (_event, elements, chart) => {
              if (elements.length === 0) return;
              const el = elements[0];
              const pt = chart.data.datasets[el.datasetIndex]?.data[el.index] as any;
              if (pt?.frame) {
                const text = formatFrameCandump(pt.frame);
                navigator.clipboard.writeText(text).then(
                  () => showCopyToast('Copied: ' + text),
                  () => showCopyToast('Copy failed'),
                );
              }
            },
            plugins: {
              zoom: zoomOptions,
              legend: {
                display: multi,
                labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12 },
              },
              tooltip: {
                callbacks: {
                  title: (items) => `t = ${items[0].parsed.x.toFixed(3)}s`,
                  label: (item) => {
                    const s = seriesList[item.datasetIndex];
                    return s ? `${s.group} / ${s.signal}: ${item.parsed.y}${s.unit ? ' ' + s.unit : ''}` : '';
                  },
                  afterBody: (items) => {
                    const f = (items[0]?.raw as any)?.frame as FrameRef | undefined;
                    return f ? [`Frame: ${formatFrameShort(f)}`, '(click to copy with timestamp)'] : '';
                  },
                },
              },
            },
            scales: {
              x: {
                type: 'linear',
                title: { display: false },
                grid: { color: '#2d354833' },
                ticks: { color: '#8b949e', font: { size: 11 } },
              },
              y: {
                title: {
                  display: true,
                  text: yLabel,
                  color: '#8b949e',
                  font: { size: 11 },
                },
                grid: { color: '#2d354833' },
                ticks: { color: '#8b949e', font: { size: 11 } },
              },
            },
          },
        });
        chartInstances.set(panel.id, chart);
      }
    });
  }

  // ---- View switching ----

  function renderCurrentView() {
    if (activeViews.has('signals')) renderCharts();
    if (activeViews.has('timeline')) renderTimeline();
    if (activeViews.has('interval')) renderIntervalCharts();
  }

  function toggleView(view: ChartView) {
    const next = new Set(activeViews);
    if (next.has(view)) {
      if (next.size > 1) next.delete(view);
    } else {
      next.add(view);
    }
    activeViews = next;
    requestAnimationFrame(() => renderCurrentView());
  }

  function onViewDragStart(view: ChartView, e: DragEvent) {
    dragView = view;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', view);
    }
  }

  function onViewDragOver(view: ChartView, e: DragEvent) {
    if (!dragView || dragView === view) { dragOverView = null; return; }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverView = view;
  }

  function onViewDrop(view: ChartView, e: DragEvent) {
    e.preventDefault();
    if (!dragView || dragView === view) { dragView = null; dragOverView = null; return; }
    const fromIdx = viewOrder.indexOf(dragView);
    const toIdx = viewOrder.indexOf(view);
    if (fromIdx < 0 || toIdx < 0) { dragView = null; dragOverView = null; return; }
    const next = [...viewOrder];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, dragView);
    viewOrder = next;
    dragView = null;
    dragOverView = null;
    requestAnimationFrame(() => renderCurrentView());
  }

  function onViewDragEnd() {
    dragView = null;
    dragOverView = null;
  }

  // ---- Panel drag-to-reorder ----
  let dragPanelId = $state<string | null>(null);
  let dragOverPanelId = $state<string | null>(null);
  let dragPanelType = $state<'signals' | 'interval' | null>(null);

  function onPanelDragStart(type: 'signals' | 'interval', panelId: string, e: DragEvent) {
    dragPanelId = panelId;
    dragPanelType = type;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', panelId);
    }
    e.stopPropagation();
  }

  function onPanelDragOver(type: 'signals' | 'interval', panelId: string, e: DragEvent) {
    if (!dragPanelId || dragPanelType !== type || dragPanelId === panelId) { dragOverPanelId = null; return; }
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverPanelId = panelId;
  }

  function onPanelDrop(type: 'signals' | 'interval', panelId: string, e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragPanelId || dragPanelType !== type || dragPanelId === panelId) {
      dragPanelId = null; dragOverPanelId = null; dragPanelType = null; return;
    }
    const panels = type === 'signals' ? chartPanels : intervalPanels;
    const fromIdx = panels.findIndex(p => p.id === dragPanelId);
    const toIdx = panels.findIndex(p => p.id === panelId);
    if (fromIdx < 0 || toIdx < 0) { dragPanelId = null; dragOverPanelId = null; dragPanelType = null; return; }
    const next = [...panels];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    if (type === 'signals') chartPanels = next;
    else intervalPanels = next;
    dragPanelId = null;
    dragOverPanelId = null;
    dragPanelType = null;
    if (mode === 'live') scheduleChartUpdate();
    else renderCurrentView();
  }

  function onPanelDragEnd() {
    dragPanelId = null;
    dragOverPanelId = null;
    dragPanelType = null;
  }

  // ---- Timeline rendering ----

  function renderTimeline() {
    if (timelineChart) { timelineChart.destroy(); timelineChart = null; }

    requestAnimationFrame(() => {
      const canvas = document.getElementById('timeline-chart') as HTMLCanvasElement | null;
      if (!canvas) return;

      const labels = messageTimingLabels;
      if (labels.length === 0) return;

      const datasets = labels.map((label, laneIdx) => {
        const color = CHART_COLORS[laneIdx % CHART_COLORS.length];
        const entries = messageTimingStore.get(label) ?? [];
        return {
          label,
          data: entries.map(e => ({ x: e.time, y: laneIdx, frame: e.frame })),
          backgroundColor: color,
          borderColor: color,
          pointRadius: entries.length <= 500 ? 4 : 2,
          pointHoverRadius: 6,
          showLine: false,
        };
      });

      timelineChart = new Chart(canvas, {
        type: 'scatter',
        data: { datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          onClick: (_event, elements, chart) => {
            if (elements.length === 0) return;
            const el = elements[0];
            const pt = chart.data.datasets[el.datasetIndex]?.data[el.index] as any;
            if (pt?.frame) {
              const text = formatFrameCandump(pt.frame);
              navigator.clipboard.writeText(text).then(
                () => showCopyToast('Copied: ' + text),
                () => showCopyToast('Copy failed'),
              );
            }
          },
          plugins: {
            zoom: zoomOptions,
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => `t = ${items[0].parsed.x.toFixed(3)}s`,
                label: (item) => {
                  const msgLabel = labels[item.parsed.y] ?? '';
                  return msgLabel;
                },
                afterBody: (items) => {
                  const f = (items[0]?.raw as any)?.frame as FrameRef | undefined;
                  return f ? [`Frame: ${formatFrameShort(f)}`, '(click to copy)'] : '';
                },
              },
            },
          },
          scales: {
            x: {
              type: 'linear',
              title: { display: true, text: 'time (s)', color: '#8b949e', font: { size: 11 } },
              grid: { color: '#2d354833' },
              ticks: { color: '#8b949e', font: { size: 11 } },
            },
            y: {
              type: 'linear',
              reverse: false,
              min: -0.5,
              max: labels.length - 0.5,
              grid: { color: '#2d354833' },
              ticks: {
                color: '#8b949e',
                font: { size: 11, family: "'JetBrains Mono', 'Fira Code', monospace" },
                stepSize: 1,
                callback: (value: any) => labels[value] ?? '',
              },
            },
          },
        },
      });
    });
  }

  function updateLiveTimeline() {
    if (!timelineChart) {
      renderTimeline();
      return;
    }

    const labels = messageTimingLabels;
    const needsRebuild = timelineChart.data.datasets.length !== labels.length;
    if (needsRebuild) {
      renderTimeline();
      return;
    }

    let xMin = Infinity, xMax = -Infinity;
    for (let i = 0; i < labels.length; i++) {
      const entries = messageTimingStore.get(labels[i]) ?? [];
      const ds = timelineChart.data.datasets[i];
      if (!ds) continue;
      const points = entries.map(e => ({ x: e.time, y: i, frame: e.frame }));
      ds.data = points;
      (ds as any).pointRadius = points.length <= 500 ? 4 : 2;
      if (points.length > 0) {
        if (points[0].x < xMin) xMin = points[0].x;
        if (points[points.length - 1].x > xMax) xMax = points[points.length - 1].x;
      }
    }
    if (xMin < Infinity) {
      const xScale = timelineChart.options.scales!.x as any;
      xScale.min = xMin;
      xScale.max = xMax;
    }
    const yScale = timelineChart.options.scales!.y as any;
    yScale.max = labels.length - 0.5;
    (yScale.ticks as any).callback = (value: any) => labels[value] ?? '';
    timelineChart.update('none');
  }

  // ---- Interval chart rendering ----

  function getIntervalData(label: string): { time: number; dt: number; frame: FrameRef }[] {
    const entries = messageTimingStore.get(label) ?? [];
    const result: { time: number; dt: number; frame: FrameRef }[] = [];
    for (let i = 1; i < entries.length; i++) {
      const dt = (entries[i].time - entries[i - 1].time) * 1000;
      result.push({ time: entries[i].time, dt, frame: entries[i].frame });
    }
    return result;
  }

  function renderIntervalCharts() {
    for (const [, chart] of intervalInstances) chart.destroy();
    intervalInstances.clear();

    requestAnimationFrame(() => {
      for (const panel of intervalPanels) {
        const canvas = document.getElementById(`interval-${panel.id}`) as HTMLCanvasElement | null;
        if (!canvas) continue;

        const multi = panel.keys.length > 1;
        const datasets = panel.keys.map((key, j) => {
          const color = CHART_COLORS[j % CHART_COLORS.length];
          const data = getIntervalData(key);
          return {
            label: key,
            data: data.map(d => ({ x: d.time, y: d.dt, frame: d.frame })),
            borderColor: color,
            backgroundColor: color + '20',
            borderWidth: 1.5,
            pointRadius: data.length <= 100 ? 3 : 0,
            pointHoverRadius: 4,
            fill: !multi,
            tension: 0,
          };
        });

        const chart = new Chart(canvas, {
          type: 'line',
          data: { datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            onClick: (_event, elements, chart) => {
              if (elements.length === 0) return;
              const el = elements[0];
              const pt = chart.data.datasets[el.datasetIndex]?.data[el.index] as any;
              if (pt?.frame) {
                const text = formatFrameCandump(pt.frame);
                navigator.clipboard.writeText(text).then(
                  () => showCopyToast('Copied: ' + text),
                  () => showCopyToast('Copy failed'),
                );
              }
            },
            plugins: {
              zoom: zoomOptions,
              legend: {
                display: multi,
                labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12 },
              },
              tooltip: {
                callbacks: {
                  title: (items) => `t = ${items[0].parsed.x.toFixed(3)}s`,
                  label: (item) => {
                    const key = panel.keys[item.datasetIndex] ?? '';
                    return `${key}: ${item.parsed.y.toFixed(2)} ms`;
                  },
                  afterBody: (items) => {
                    const f = (items[0]?.raw as any)?.frame as FrameRef | undefined;
                    return f ? [`Frame: ${formatFrameShort(f)}`, '(click to copy)'] : '';
                  },
                },
              },
            },
            scales: {
              x: {
                type: 'linear',
                title: { display: true, text: 'time (s)', color: '#8b949e', font: { size: 11 } },
                grid: { color: '#2d354833' },
                ticks: { color: '#8b949e', font: { size: 11 } },
              },
              y: {
                title: { display: true, text: 'interval (ms)', color: '#8b949e', font: { size: 11 } },
                grid: { color: '#2d354833' },
                ticks: { color: '#8b949e', font: { size: 11 } },
              },
            },
          },
        });
        intervalInstances.set(panel.id, chart);
      }
    });
  }

  function updateLiveIntervalCharts() {
    let needsRebuild = intervalPanels.some(p => !intervalInstances.has(p.id));
    if (intervalInstances.size !== intervalPanels.length) needsRebuild = true;
    if (!needsRebuild) {
      for (const panel of intervalPanels) {
        const chart = intervalInstances.get(panel.id);
        if (chart && chart.data.datasets.length !== panel.keys.length) {
          needsRebuild = true;
          break;
        }
      }
    }

    if (needsRebuild) {
      renderIntervalCharts();
      return;
    }

    for (const panel of intervalPanels) {
      const chart = intervalInstances.get(panel.id);
      if (!chart) continue;

      let xMin = Infinity, xMax = -Infinity;
      for (let j = 0; j < panel.keys.length; j++) {
        const data = getIntervalData(panel.keys[j]);
        const ds = chart.data.datasets[j];
        if (!ds) continue;
        const points = data.map(d => ({ x: d.time, y: d.dt, frame: d.frame }));
        ds.data = points;
        (ds as any).pointRadius = points.length <= 100 ? 3 : 0;
        if (points.length > 0) {
          if (points[0].x < xMin) xMin = points[0].x;
          if (points[points.length - 1].x > xMax) xMax = points[points.length - 1].x;
        }
      }
      if (xMin < Infinity) {
        const xScale = chart.options.scales!.x as any;
        xScale.min = xMin;
        xScale.max = xMax;
      }
      chart.update('none');
    }
  }

  // ---- Interval panel management ----

  function toggleIntervalSignal(key: string) {
    const panelIdx = intervalPanels.findIndex(p => p.keys.includes(key));
    if (panelIdx >= 0) {
      const panel = intervalPanels[panelIdx];
      if (panel.keys.length === 1) {
        intervalPanels = intervalPanels.filter((_, i) => i !== panelIdx);
      } else {
        intervalPanels = intervalPanels.map((p, i) =>
          i === panelIdx ? { ...p, keys: p.keys.filter(k => k !== key) } : p
        );
      }
    } else {
      intervalPanels = [...intervalPanels, { id: `ip${nextPanelId++}`, keys: [key] }];
    }
    if (mode === 'live') scheduleChartUpdate();
    else renderIntervalCharts();
  }

  function selectAllInterval() {
    const already = new Set(intervalPanels.flatMap(p => p.keys));
    const newPanels = messageTimingLabels
      .filter(k => !already.has(k))
      .map(k => ({ id: `ip${nextPanelId++}`, keys: [k] }));
    intervalPanels = [...intervalPanels, ...newPanels];
    if (mode === 'live') scheduleChartUpdate();
    else renderIntervalCharts();
  }

  function selectNoneInterval() {
    intervalPanels = [];
    renderIntervalCharts();
  }

  function addToIntervalPanel(panelId: string, key: string) {
    intervalPanels = intervalPanels
      .map(p => {
        if (p.id === panelId) return { ...p, keys: [...p.keys, key] };
        if (p.keys.includes(key)) return { ...p, keys: p.keys.filter(k => k !== key) };
        return p;
      })
      .filter(p => p.keys.length > 0);
    addDropdownOpen = null;
    if (mode === 'live') scheduleChartUpdate();
    else renderIntervalCharts();
  }

  function splitFromIntervalPanel(panelId: string, key: string) {
    intervalPanels = [
      ...intervalPanels.map(p =>
        p.id === panelId ? { ...p, keys: p.keys.filter(k => k !== key) } : p
      ).filter(p => p.keys.length > 0),
      { id: `ip${nextPanelId++}`, keys: [key] },
    ];
    if (mode === 'live') scheduleChartUpdate();
    else renderIntervalCharts();
  }

  function getAvailableForIntervalPanel(panelId: string): string[] {
    const panel = intervalPanels.find(p => p.id === panelId);
    if (!panel) return [];
    const panelKeys = new Set(panel.keys);
    return messageTimingLabels.filter(k => intervalSelected.has(k) && !panelKeys.has(k));
  }

  function getIntervalPanelSampleCount(panel: ChartPanel): number {
    return panel.keys.reduce((sum, k) => sum + Math.max(0, (messageTimingStore.get(k)?.length ?? 0) - 1), 0);
  }

  // ---- Export ----

  function savePng() {
    if (activeViews.has('timeline')) {
      const canvas = document.getElementById('timeline-chart') as HTMLCanvasElement | null;
      if (canvas) {
        const link = document.createElement('a');
        link.download = 'timeline.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
      }
    }
    if (activeViews.has('interval')) {
      for (const panel of intervalPanels) {
        const canvas = document.getElementById(`interval-${panel.id}`) as HTMLCanvasElement | null;
        if (!canvas) continue;
        const name = panel.keys.length === 1 ? `interval_${panel.keys[0]}` : `interval-${panel.id}`;
        const link = document.createElement('a');
        link.download = `${name}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
      }
    }
    if (activeViews.has('signals')) {
      for (const panel of chartPanels) {
        const canvas = document.getElementById(`chart-${panel.id}`) as HTMLCanvasElement | null;
        if (!canvas) continue;
        const seriesList = panel.keys.map(k => allSeries.find(s => s.key === k)).filter(Boolean) as SignalSeries[];
        const name = seriesList.length === 1 ? `${seriesList[0].group}_${seriesList[0].signal}` : `chart-${panel.id}`;
        const link = document.createElement('a');
        link.download = `${name}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
      }
    }
  }

  // ---- Groups for selector display ----

  function getGroups(): { group: string; signals: SignalSeries[] }[] {
    const map = new Map<string, SignalSeries[]>();
    for (const s of allSeries) {
      let list = map.get(s.group);
      if (!list) { list = []; map.set(s.group, list); }
      list.push(s);
    }
    return Array.from(map.entries()).map(([group, signals]) => ({ group, signals }));
  }

  function getAvailableForPanel(panelId: string): SignalSeries[] {
    const panel = chartPanels.find(p => p.id === panelId);
    if (!panel) return [];
    const panelKeys = new Set(panel.keys);
    return allSeries.filter(s => selected.has(s.key) && !panelKeys.has(s.key));
  }

  function getPanelSampleCount(panel: ChartPanel): number {
    if (mode === 'live') {
      return panel.keys.reduce((sum, k) => sum + (liveSampleCounts[k] ?? 0), 0);
    }
    return panel.keys.reduce((sum, k) => {
      const s = allSeries.find(se => se.key === k);
      return sum + (s?.samples.length ?? 0);
    }, 0);
  }

  // ---- Plot layout config (YAML export/import) ----

  interface PlotLayoutConfig {
    plot: {
      views?: {
        active?: ChartView[];
        order?: ChartView[];
      };
      buffer?: {
        mode?: BufferMode;
        samples?: number;
        seconds?: number;
      };
      signals?: {
        panels: string[][];
      };
      intervals?: {
        panels: string[][];
      };
    };
  }

  let pendingLayoutConfig = $state<PlotLayoutConfig | null>(null);

  function exportLayout() {
    const config: PlotLayoutConfig = {
      plot: {
        views: {
          active: [...activeViews],
          order: [...viewOrder],
        },
        buffer: {
          mode: bufferMode,
          samples: bufferSamples,
          seconds: bufferSeconds,
        },
        signals: {
          panels: chartPanels.map(p => [...p.keys]),
        },
        intervals: {
          panels: intervalPanels.map(p => [...p.keys]),
        },
      },
    };
    const text = yaml.dump(config, { lineWidth: -1 });
    const blob = new Blob([text], { type: 'text/yaml' });
    const link = document.createElement('a');
    link.download = 'plot_layout.yaml';
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function importLayout() {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.yaml,.yml';
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      const text = await file.text();
      const config = yaml.load(text) as PlotLayoutConfig;
      if (!config?.plot) return;
      applyLayoutConfig(config);
    };
    picker.click();
  }

  function applyLayoutConfig(config: PlotLayoutConfig) {
    const p = config.plot;

    if (p.views?.active) {
      const validViews: ChartView[] = ['signals', 'timeline', 'interval'];
      const active = p.views.active.filter(v => validViews.includes(v));
      if (active.length > 0) activeViews = new Set(active);
    }
    if (p.views?.order) {
      const validViews: ChartView[] = ['signals', 'timeline', 'interval'];
      const order = p.views.order.filter(v => validViews.includes(v));
      if (order.length === 3) viewOrder = order;
    }

    if (p.buffer) {
      if (p.buffer.mode) bufferMode = p.buffer.mode;
      if (p.buffer.samples != null) bufferSamples = p.buffer.samples;
      if (p.buffer.seconds != null) bufferSeconds = p.buffer.seconds;
    }

    const knownSignalKeys = new Set(allSeries.map(s => s.key));
    const knownTimingKeys = new Set(messageTimingLabels);

    if (p.signals?.panels) {
      const panels: ChartPanel[] = [];
      for (const keys of p.signals.panels) {
        const matched = keys.filter(k => knownSignalKeys.has(k));
        if (matched.length > 0) {
          panels.push({ id: `p${nextPanelId++}`, keys: matched });
        }
      }
      chartPanels = panels;
    }

    if (p.intervals?.panels) {
      const panels: ChartPanel[] = [];
      for (const keys of p.intervals.panels) {
        const matched = keys.filter(k => knownTimingKeys.has(k));
        if (matched.length > 0) {
          panels.push({ id: `ip${nextPanelId++}`, keys: matched });
        }
      }
      intervalPanels = panels;
    }

    // Store config for auto-apply when new signals arrive
    pendingLayoutConfig = config;

    renderCurrentView();
  }

  function autoApplyPendingLayout() {
    const config = pendingLayoutConfig;
    if (!config?.plot?.signals?.panels && !config?.plot?.intervals?.panels) return;

    const knownSignalKeys = new Set(allSeries.map(s => s.key));
    const currentPanelKeys = new Set(chartPanels.flatMap(p => p.keys));
    let signalChanged = false;

    if (config.plot.signals?.panels) {
      for (const keys of config.plot.signals.panels) {
        const matched = keys.filter(k => knownSignalKeys.has(k) && !currentPanelKeys.has(k));
        if (matched.length > 0) {
          // Check if a panel for this group already exists (partial match)
          const existingPanel = chartPanels.find(p =>
            keys.some(k => p.keys.includes(k))
          );
          if (existingPanel) {
            existingPanel.keys.push(...matched);
          } else {
            chartPanels = [...chartPanels, { id: `p${nextPanelId++}`, keys: matched }];
          }
          matched.forEach(k => currentPanelKeys.add(k));
          signalChanged = true;
        }
      }
    }

    const knownTimingKeys = new Set(messageTimingLabels);
    const currentIntervalKeys = new Set(intervalPanels.flatMap(p => p.keys));
    let intervalChanged = false;

    if (config.plot.intervals?.panels) {
      for (const keys of config.plot.intervals.panels) {
        const matched = keys.filter(k => knownTimingKeys.has(k) && !currentIntervalKeys.has(k));
        if (matched.length > 0) {
          const existingPanel = intervalPanels.find(p =>
            keys.some(k => p.keys.includes(k))
          );
          if (existingPanel) {
            existingPanel.keys.push(...matched);
          } else {
            intervalPanels = [...intervalPanels, { id: `ip${nextPanelId++}`, keys: matched }];
          }
          matched.forEach(k => currentIntervalKeys.add(k));
          intervalChanged = true;
        }
      }
    }

    return signalChanged || intervalChanged;
  }
</script>

<div class="container">
  <div class="page-header">
    <h1>Plot</h1>
    <p>Visualize CAN signal values over time</p>
  </div>

  <div class="card">
    <!-- Mode tabs -->
    <div class="mode-tabs">
      <button class="mode-tab" class:mode-tab-active={mode === 'paste'} onclick={() => switchMode('paste')}>
        Paste
      </button>
      <button class="mode-tab" class:mode-tab-active={mode === 'live'} onclick={() => switchMode('live')}>
        Live
      </button>
    </div>

    {#if mode === 'paste'}
      <div class="form-group">
        <label for="plot-input">Candump Log</label>
        <textarea id="plot-input" bind:value={input} rows="6"
          placeholder={"Paste candump lines (with timestamps for time axis):\n  (1713456789.123456) vcan0 101#E803050000000000\n  (1713456789.234567) vcan0 101#D007050000000000\n  (1713456789.345678) vcan0 00010101##1FD01000000..."}
          onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); analyze(); } }}
        ></textarea>
        <div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">Press Ctrl+Enter to analyze</div>
      </div>
      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <button class="primary" onclick={analyze} disabled={codecStore.configs.length === 0}>Analyze</button>
        {#if codecStore.configs.length === 0}
          <span style="font-size: 13px; color: var(--text-dim);">Load a config first</span>
        {/if}
        {#if status}
          <span style="font-size: 13px; color: var(--text-dim);">{status}</span>
        {/if}
      </div>
    {:else}
      <div class="form-group">
        <label for="ws-url">WebSocket Server</label>
        <input id="ws-url" type="text" bind:value={wsUrl}
          placeholder="ws://192.168.1.100:8765"
          disabled={wsClient.status === 'connected' || wsClient.status === 'connecting'}
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); connectLive(); } }}
        />
      </div>
      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        {#if wsClient.status === 'disconnected' || wsClient.status === 'error'}
          <button class="primary" onclick={connectLive}
            disabled={codecStore.configs.length === 0 || !wsUrl.trim()}>
            Connect
          </button>
        {:else}
          <button style="background: var(--red);" onclick={disconnectLive}>Disconnect</button>
          <button
            class="btn-sm"
            style="background: {paused ? 'var(--green, #3fb950)' : 'var(--yellow, #d29922)'}; color: #000; font-weight: 600;"
            onclick={togglePause}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
        {/if}

        <span class="connection-status {wsClient.status}">
          {#if wsClient.status === 'connected'}
            Connected{wsClient.busInfo ? ` — ${wsClient.busInfo.bus}` : ''}
          {:else if wsClient.status === 'connecting'}
            Connecting...
          {:else if wsClient.status === 'error'}
            {wsClient.error ?? 'Error'}
          {:else}
            Disconnected
          {/if}
        </span>

        {#if wsClient.status === 'connected'}
          <span style="font-size: 13px; color: var(--text-dim);">
            {#if dumpMatchedOnly}{matchedFrameCount} / {/if}{wsClient.frameCount} frames{paused ? ' (paused)' : ''}
          </span>
          {#if dumpActive}
            <button style="background: var(--red); font-size: 12px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px;" onclick={stopDumpToFile}>
              <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: dump-pulse 1s infinite;"></span>
              Recording {dumpFrameCount} frames — Stop
            </button>
          {:else}
            <button class="btn-sm" onclick={startDumpToFile}>Record to file</button>
          {/if}
          <label style="font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 4px; cursor: pointer;">
            <input type="checkbox" bind:checked={dumpMatchedOnly} style="accent-color: var(--accent);" /> Matched only
          </label>
        {/if}

        {#if codecStore.configs.length === 0}
          <span style="font-size: 13px; color: var(--text-dim);">Load a config first</span>
        {/if}

        {#if status}
          <span style="font-size: 13px; color: var(--text-dim);">{status}</span>
        {/if}
      </div>

      <!-- Buffer mode -->
      <div style="display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap;">
        <span style="font-size: 12px; color: var(--text-dim);">Buffer:</span>
        <button class="chip" class:chip-active={bufferMode === 'unlimited'} onclick={() => bufferMode = 'unlimited'}>
          Unlimited
        </button>
        <button class="chip" class:chip-active={bufferMode === 'samples'} onclick={() => bufferMode = 'samples'}>
          Samples
        </button>
        <button class="chip" class:chip-active={bufferMode === 'time'} onclick={() => bufferMode = 'time'}>
          Time window
        </button>
        {#if bufferMode === 'samples'}
          <input type="number" bind:value={bufferSamples} min="100" step="1000"
            style="width: 80px; font-size: 12px; padding: 4px 8px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; color: var(--text);" />
        {/if}
        {#if bufferMode === 'time'}
          <input type="number" bind:value={bufferSeconds} min="5" step="5"
            style="width: 60px; font-size: 12px; padding: 4px 8px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; color: var(--text);" />
          <span style="font-size: 12px; color: var(--text-dim);">seconds</span>
        {/if}
        <span style="margin-left: 12px; border-left: 1px solid var(--border); padding-left: 12px; display: inline-flex; gap: 8px; align-items: center;">
          <span style="font-size: 12px; color: var(--text-dim);">Layout:</span>
          <button class="btn-sm" onclick={importLayout}>Import</button>
          {#if pendingLayoutConfig}
            <span style="font-size: 12px; color: var(--yellow, #d29922);">Config loaded</span>
            <button class="btn-sm" onclick={() => { pendingLayoutConfig = null; }}>Clear</button>
          {/if}
        </span>
      </div>

      <!-- Raw frame log -->
      {#if wsClient.status === 'connected' || rawFrameCount > 0}
        <div style="margin-top: 16px;">
          <button class="setup-toggle" onclick={() => { showRawLog = !showRawLog; if (showRawLog) { rawLogRenderedVersion = 0; setTimeout(() => updateRawLog(), 0); } }}>
            {showRawLog ? '▾' : '▸'} Raw frames
            <span style="color: var(--text-dim); font-size: 12px; margin-left: 6px;">{rawFrameCount}</span>
          </button>
          {#if showRawLog}
            <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center;">
              <label style="font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 4px; cursor: pointer;">
                <input type="checkbox" bind:checked={rawLogAutoScroll} style="accent-color: var(--accent);" /> Auto-scroll
              </label>
              <button class="btn-sm" onclick={() => { rawFrameLog = []; rawFrameCount = 0; rawLogRenderedVersion = 0; if (rawLogEl) rawLogEl.textContent = ''; }}>Clear</button>
              <button class="btn-sm" onclick={() => { const blob = new Blob([rawFrameLog.join('\n')], { type: 'text/plain' }); const a = document.createElement('a'); a.download = 'candump.log'; a.href = URL.createObjectURL(blob); a.click(); URL.revokeObjectURL(a.href); }}>Save log</button>
              <span style="font-size: 12px; color: var(--text-dim);">Max lines</span>
              <input type="number" bind:value={rawLogMax} min="100" step="500"
                style="width: 70px; font-size: 12px; padding: 4px 8px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; color: var(--text);" />
            </div>
            <pre
              class="raw-frame-log"
              bind:this={rawLogEl}
              onscroll={() => { if (rawLogEl) rawLogAutoScroll = rawLogEl.scrollTop >= rawLogEl.scrollHeight - rawLogEl.clientHeight - 20; }}
            ></pre>
          {/if}
        </div>
      {/if}

      <!-- Setup guide -->
      <div class="setup-guide" style="margin-top: 16px;">
        <button class="setup-toggle" onclick={() => showSetup = !showSetup}>
          {showSetup ? '▾' : '▸'} Server setup guide
        </button>
        {#if showSetup}
          <div class="setup-content">
            <p><strong>1.</strong> Download the server script:</p>
            <div style="margin: 8px 0;">
              <button class="btn-sm" onclick={downloadServer}>Download can_ws_server.py</button>
            </div>
            <p style="font-size: 12px; color: var(--text-dim);">Zero dependencies — uses only Python 3.10+ stdlib + candump (can-utils).</p>

            <p><strong>2.</strong> Install <code>can-utils</code> on the machine with the CAN interface:</p>
            <pre><code>sudo apt install can-utils</code></pre>

            <p style="margin-top: 12px;"><strong>3.</strong> Choose your setup:</p>

            <details open style="margin-top: 8px;">
              <summary style="cursor: pointer; font-size: 13px; font-weight: 600;">CAN device is this PC (or reachable from browser)</summary>
              <div style="padding: 4px 0 4px 8px;">
                <p style="font-size: 12px;">Run the server on the machine with the CAN interface:</p>
                <pre><code>python3 can_ws_server.py --bus can0</code></pre>
                <p style="font-size: 12px;">Then enter <code>ws://localhost:8765</code> above and click Connect.</p>
              </div>
            </details>

            <details style="margin-top: 8px;">
              <summary style="cursor: pointer; font-size: 13px; font-weight: 600;">CAN device is on a LAN (not reachable from browser)</summary>
              <div style="padding: 4px 0 4px 8px;">
                <p style="font-size: 12px;">Copy <code>can_ws_server.py</code> to both the CAN device and your PC.</p>
                <pre><code># On the CAN device (e.g. 192.168.x.x):{'\n'}python3 can_ws_server.py --bus can0{'\n'}{'\n'}# On your PC:{'\n'}python3 can_ws_server.py --source ws://192.168.x.x:8765</code></pre>
                <p style="font-size: 12px;">Then enter <code>ws://localhost:8765</code> above and click Connect.</p>
                <p style="font-size: 12px; color: var(--text-dim);">The <code>--source</code> flag connects to the remote server and re-serves frames locally.</p>
              </div>
            </details>

            <details style="margin-top: 8px;">
              <summary style="cursor: pointer; color: var(--text-dim); font-size: 12px;">More options</summary>
              <pre><code># Filter specific CAN IDs{'\n'}python3 can_ws_server.py --bus can0 --filter 0x101,0x201{'\n'}{'\n'}# Disable CAN FD{'\n'}python3 can_ws_server.py --bus can0 --no-fd{'\n'}{'\n'}# Custom port and bind address{'\n'}python3 can_ws_server.py --host 0.0.0.0 --port 9000{'\n'}{'\n'}# Test with virtual CAN{'\n'}sudo modprobe vcan{'\n'}sudo ip link add dev vcan0 type vcan{'\n'}sudo ip link set up vcan0{'\n'}python3 can_ws_server.py --bus vcan0</code></pre>
            </details>
            <details style="margin-top: 8px;">
              <summary style="cursor: pointer; color: var(--text-dim); font-size: 12px;">USB-to-CAN adapters</summary>
              <pre><code># SLCAN adapters with CAN FD (requires: pip install python-can pyserial){'\n'}python3 can_ws_server.py --bus /dev/ttyACM0 --interface slcan \\{'\n'}    --bitrate 1000000 --data-bitrate 5000000{'\n'}{'\n'}# SLCAN classic CAN only (via slcand, no pip needed){'\n'}sudo slcand -o -c -s6 /dev/ttyACM0 slcan0{'\n'}sudo ip link set up slcan0{'\n'}python3 can_ws_server.py --bus slcan0{'\n'}{'\n'}# gs_usb adapters (e.g. CANable with candleLight firmware){'\n'}sudo ip link set can0 type can bitrate 1000000{'\n'}sudo ip link set up can0{'\n'}python3 can_ws_server.py --bus can0{'\n'}{'\n'}# gs_usb with CAN FD{'\n'}sudo ip link set can0 type can bitrate 1000000 dbitrate 5000000 fd on{'\n'}sudo ip link set up can0{'\n'}python3 can_ws_server.py --bus can0</code></pre>
            </details>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if allSeries.length > 0 || messageTimingLabels.length > 0}
    <!-- View tabs (multi-select) + layout controls -->
    <div class="view-tabs">
      <button class="mode-tab" class:mode-tab-active={activeViews.has('signals')} onclick={() => toggleView('signals')}>
        Signals
      </button>
      <button class="mode-tab" class:mode-tab-active={activeViews.has('timeline')} onclick={() => toggleView('timeline')}>
        Timeline
      </button>
      <button class="mode-tab" class:mode-tab-active={activeViews.has('interval')} onclick={() => toggleView('interval')}>
        Interval
      </button>
      <div style="margin-left: auto; display: flex; gap: 8px;">
        <button class="btn-sm" onclick={exportLayout}>Export Layout</button>
        <button class="btn-sm" onclick={importLayout}>Import Layout</button>
        {#if pendingLayoutConfig}
          <button class="btn-sm" style="color: var(--yellow, #d29922);" onclick={() => { pendingLayoutConfig = null; }}>Clear Layout</button>
        {/if}
      </div>
    </div>

    {#each viewOrder as view (view)}
      {#if activeViews.has(view)}
        <div
          class="view-section"
          class:view-drag-over={dragOverView === view}
          ondragover={(e) => onViewDragOver(view, e)}
          ondrop={(e) => onViewDrop(view, e)}
        >
          <div
            class="view-drag-handle"
            title="Drag to reorder"
            draggable="true"
            ondragstart={(e) => onViewDragStart(view, e)}
            ondragend={onViewDragEnd}
          >&#x2630;</div>

          {#if view === 'signals'}
            <div class="card">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <strong style="font-size: 14px;">Signals</strong>
                <div style="display: flex; gap: 8px;">
                  <button class="btn-sm" onclick={selectAll}>All</button>
                  <button class="btn-sm" onclick={selectNone}>None</button>
                  {#if chartPanels.length > 0}
                    <button class="btn-sm" onclick={resetAllZoom}>Reset Zoom</button>
                    <button class="btn-sm" onclick={savePng}>Save PNG</button>
                  {/if}
                </div>
              </div>
              <div class="signal-selector">
                {#each getGroups() as { group, signals }}
                  <div class="signal-group">
                    <div class="signal-group-label">{group}</div>
                    <div class="signal-chips">
                      {#each signals as s}
                        <button
                          class="chip"
                          class:chip-active={selected.has(s.key)}
                          onclick={() => toggleSignal(s.key)}
                        >
                          {s.signal}{s.unit ? ` (${s.unit})` : ''}
                          <span class="chip-count">{mode === 'live' ? (liveSampleCounts[s.key] ?? 0) : s.samples.length}</span>
                        </button>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            </div>

            {#if chartPanels.length > 0}
              <div class="chart-stack">
                {#each chartPanels as panel (panel.id)}
                  {@const seriesList = panel.keys.map(k => allSeries.find(s => s.key === k)).filter(Boolean) as SignalSeries[]}
                  <div
                    class="chart-card"
                    class:panel-drag-over={dragOverPanelId === panel.id && dragPanelType === 'signals'}
                    ondragover={(e) => onPanelDragOver('signals', panel.id, e)}
                    ondrop={(e) => onPanelDrop('signals', panel.id, e)}
                  >
                    <div class="chart-header">
                      <div class="chart-signal-tags">
                        <span
                          class="panel-drag-handle"
                          title="Drag to reorder"
                          draggable="true"
                          ondragstart={(e) => onPanelDragStart('signals', panel.id, e)}
                          ondragend={onPanelDragEnd}
                        >&#x2630;</span>
                        {#each seriesList as series, j}
                          <span class="chart-signal-tag" style="--tag-color: {CHART_COLORS[j % CHART_COLORS.length]}">
                            <span style="opacity: 0.6;">{series.group} /</span> {series.signal}{series.unit ? ` (${series.unit})` : ''}
                            {#if panel.keys.length > 1}
                              <button class="chart-signal-tag-remove" onclick={() => splitFromPanel(panel.id, series.key)} title="Split to own chart">x</button>
                            {/if}
                          </span>
                        {/each}
                        <div class="chart-add-wrapper">
                          <button class="chart-add-btn" onclick={() => addDropdownOpen = addDropdownOpen === panel.id ? null : panel.id} title="Add signal to this chart">+</button>
                          {#if addDropdownOpen === panel.id}
                            {@const available = getAvailableForPanel(panel.id)}
                            {#if available.length > 0}
                              <div class="chart-add-dropdown">
                                {#each available as s}
                                  <button class="chart-add-dropdown-item" onclick={() => addToPanel(panel.id, s.key)}>
                                    {s.signal}{s.unit ? ` (${s.unit})` : ''}
                                    <span style="color: var(--text-dim); font-size: 11px; margin-left: 4px;">{s.group}</span>
                                  </button>
                                {/each}
                              </div>
                            {:else}
                              <div class="chart-add-dropdown">
                                <span style="color: var(--text-dim); font-size: 12px; padding: 8px;">No other selected signals</span>
                              </div>
                            {/if}
                          {/if}
                        </div>
                      </div>
                      <span class="chart-samples">{getPanelSampleCount(panel)} samples</span>
                    </div>
                    <div class="chart-container">
                      <canvas id="chart-{panel.id}"></canvas>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}

          {:else if view === 'timeline'}
            <div class="card">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <strong style="font-size: 14px;">Message Timeline</strong>
                <div style="display: flex; gap: 8px;">
                  {#if messageTimingLabels.length > 0}
                    <button class="btn-sm" onclick={resetAllZoom}>Reset Zoom</button>
                    <button class="btn-sm" onclick={savePng}>Save PNG</button>
                  {/if}
                </div>
              </div>
              {#if messageTimingLabels.length > 0}
                <div class="signal-selector" style="margin-bottom: 12px;">
                  {#each messageTimingLabels as label, i}
                    <span class="chart-signal-tag" style="--tag-color: {CHART_COLORS[i % CHART_COLORS.length]}">
                      {label}
                      <span class="chip-count">{messageTimingStore.get(label)?.length ?? 0}</span>
                    </span>
                  {/each}
                </div>
              {/if}
            </div>
            {#if messageTimingLabels.length > 0}
              <div class="chart-card">
                <div class="chart-container" style="height: {Math.max(200, messageTimingLabels.length * 40 + 60)}px;">
                  <canvas id="timeline-chart"></canvas>
                </div>
              </div>
            {/if}

          {:else if view === 'interval'}
            <div class="card">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <strong style="font-size: 14px;">Message Intervals</strong>
                <div style="display: flex; gap: 8px;">
                  <button class="btn-sm" onclick={selectAllInterval}>All</button>
                  <button class="btn-sm" onclick={selectNoneInterval}>None</button>
                  {#if intervalPanels.length > 0}
                    <button class="btn-sm" onclick={resetAllZoom}>Reset Zoom</button>
                    <button class="btn-sm" onclick={savePng}>Save PNG</button>
                  {/if}
                </div>
              </div>
              <div class="signal-chips" style="flex-wrap: wrap;">
                {#each messageTimingLabels as label, i}
                  <button
                    class="chip"
                    class:chip-active={intervalSelected.has(label)}
                    onclick={() => toggleIntervalSignal(label)}
                  >
                    {label}
                    <span class="chip-count">{Math.max(0, (messageTimingStore.get(label)?.length ?? 0) - 1)}</span>
                  </button>
                {/each}
              </div>
            </div>

            {#if intervalPanels.length > 0}
              <div class="chart-stack">
                {#each intervalPanels as panel (panel.id)}
                  <div
                    class="chart-card"
                    class:panel-drag-over={dragOverPanelId === panel.id && dragPanelType === 'interval'}
                    ondragover={(e) => onPanelDragOver('interval', panel.id, e)}
                    ondrop={(e) => onPanelDrop('interval', panel.id, e)}
                  >
                    <div class="chart-header">
                      <div class="chart-signal-tags">
                        <span
                          class="panel-drag-handle"
                          title="Drag to reorder"
                          draggable="true"
                          ondragstart={(e) => onPanelDragStart('interval', panel.id, e)}
                          ondragend={onPanelDragEnd}
                        >&#x2630;</span>
                        {#each panel.keys as key, j}
                          <span class="chart-signal-tag" style="--tag-color: {CHART_COLORS[j % CHART_COLORS.length]}">
                            {key}
                            {#if panel.keys.length > 1}
                              <button class="chart-signal-tag-remove" onclick={() => splitFromIntervalPanel(panel.id, key)} title="Split to own chart">x</button>
                            {/if}
                          </span>
                        {/each}
                        <div class="chart-add-wrapper">
                          <button class="chart-add-btn" onclick={() => addDropdownOpen = addDropdownOpen === panel.id ? null : panel.id} title="Add message to this chart">+</button>
                          {#if addDropdownOpen === panel.id}
                            {@const available = getAvailableForIntervalPanel(panel.id)}
                            {#if available.length > 0}
                              <div class="chart-add-dropdown">
                                {#each available as k}
                                  <button class="chart-add-dropdown-item" onclick={() => addToIntervalPanel(panel.id, k)}>
                                    {k}
                                  </button>
                                {/each}
                              </div>
                            {:else}
                              <div class="chart-add-dropdown">
                                <span style="color: var(--text-dim); font-size: 12px; padding: 8px;">No other selected messages</span>
                              </div>
                            {/if}
                          {/if}
                        </div>
                      </div>
                      <span class="chart-samples">{getIntervalPanelSampleCount(panel)} intervals</span>
                    </div>
                    <div class="chart-container">
                      <canvas id="interval-{panel.id}"></canvas>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    {/each}
  {/if}
</div>

{#if copyToast}
  <div style="position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--bg-card, #161b22); color: var(--text, #c9d1d9); border: 1px solid var(--border, #30363d); padding: 8px 16px; border-radius: 6px; font-size: 13px; z-index: 1000; pointer-events: none;">{copyToast}</div>
{/if}
