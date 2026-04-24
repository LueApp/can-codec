<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { codecStore } from '$lib/codec-store.svelte';
  import { plotStore } from '$lib/plot-store.svelte';
  import type { SignalSeries, ChartPanel, ChartView, FrameRef } from '$lib/plot-types';
  import yaml from 'js-yaml';
  import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler, ScatterController } from 'chart.js';
  import zoomPlugin from 'chartjs-plugin-zoom';

  Chart.register(LineController, ScatterController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler, zoomPlugin);

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

  // ---- Ephemeral UI state ----

  let showSetup = $state(false);
  let addDropdownOpen = $state<string | null>(null);
  let copyToast = $state('');
  let copyToastTimer: ReturnType<typeof setTimeout> | undefined;

  function showCopyToast(msg: string) {
    copyToast = msg;
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => { copyToast = ''; }, 1500);
  }

  // ---- Chart.js instances (DOM-bound, cannot survive navigation) ----

  let chartInstances = new Map<string, Chart>();
  let timelineChart: Chart | null = null;
  let intervalInstances = new Map<string, Chart>();

  // ---- DOM refs ----

  let rawLogEl: HTMLPreElement | undefined;
  let rawLogAutoScroll = true;
  let rawLogRenderedVersion = 0;

  // ---- Drag state ----

  let dragView = $state<ChartView | null>(null);
  let dragOverView = $state<ChartView | null>(null);
  let dragPanelId = $state<string | null>(null);
  let dragOverPanelId = $state<string | null>(null);
  let dragPanelType = $state<'signals' | 'interval' | null>(null);

  // ---- Constants ----

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

  // ---- Chart rendering (full rebuild) ----

  function renderCurrentView() {
    if (plotStore.activeViews.has('signals')) renderCharts();
    if (plotStore.activeViews.has('timeline')) renderTimeline();
    if (plotStore.activeViews.has('interval')) renderIntervalCharts();
  }

  function renderCharts() {
    for (const [, chart] of chartInstances) chart.destroy();
    chartInstances.clear();

    requestAnimationFrame(() => {
      for (const panel of plotStore.chartPanels) {
        const canvas = document.getElementById(`chart-${panel.id}`) as HTMLCanvasElement | null;
        if (!canvas) continue;

        const seriesList = panel.keys.map(k => plotStore.allSeries.find(s => s.key === k)).filter(Boolean) as SignalSeries[];
        const multi = seriesList.length > 1;
        const units = new Set(seriesList.map(s => s.unit).filter(Boolean));
        const yLabel = units.size === 1 ? [...units][0] : 'value';

        const datasets = seriesList.map((series, j) => {
          const color = CHART_COLORS[j % CHART_COLORS.length];
          const samples = plotStore.getSamples(series.key);
          return {
            label: `${series.group} / ${series.signal}${series.unit ? ` (${series.unit})` : ''}`,
            data: samples.map(s => ({ x: s.time, y: s.value, frame: s.frame })),
            borderColor: color,
            backgroundColor: color + '20',
            borderWidth: 1.5,
            pointRadius: samples.length <= 100 ? 3 : 0,
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
                const text = plotStore.formatFrameCandump(pt.frame);
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
                    return f ? [`Frame: ${plotStore.formatFrameShort(f)}`, '(click to copy with timestamp)'] : '';
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
                title: { display: true, text: yLabel, color: '#8b949e', font: { size: 11 } },
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

  function renderTimeline() {
    if (timelineChart) { timelineChart.destroy(); timelineChart = null; }

    requestAnimationFrame(() => {
      const canvas = document.getElementById('timeline-chart') as HTMLCanvasElement | null;
      if (!canvas) return;

      const labels = plotStore.messageTimingLabels;
      if (labels.length === 0) return;

      const datasets = labels.map((label, laneIdx) => {
        const color = CHART_COLORS[laneIdx % CHART_COLORS.length];
        const entries = plotStore.messageTimingStore.get(label) ?? [];
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
              const text = plotStore.formatFrameCandump(pt.frame);
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
                  return f ? [`Frame: ${plotStore.formatFrameShort(f)}`, '(click to copy)'] : '';
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

  function renderIntervalCharts() {
    for (const [, chart] of intervalInstances) chart.destroy();
    intervalInstances.clear();

    requestAnimationFrame(() => {
      for (const panel of plotStore.intervalPanels) {
        const canvas = document.getElementById(`interval-${panel.id}`) as HTMLCanvasElement | null;
        if (!canvas) continue;

        const multi = panel.keys.length > 1;
        const datasets = panel.keys.map((key, j) => {
          const color = CHART_COLORS[j % CHART_COLORS.length];
          const data = plotStore.getIntervalData(key);
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
                const text = plotStore.formatFrameCandump(pt.frame);
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
                    return f ? [`Frame: ${plotStore.formatFrameShort(f)}`, '(click to copy)'] : '';
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

  // ---- Live chart updates (incremental) ----

  function updateLiveCharts() {
    if (plotStore.activeViews.has('timeline')) updateLiveTimeline();
    if (plotStore.activeViews.has('interval')) updateLiveIntervalCharts();
    if (plotStore.activeViews.has('signals')) updateLiveSignalCharts();
    plotStore.updateLiveCounts();
  }

  function updateLiveSignalCharts() {
    let needsRebuild = plotStore.chartPanels.some(p => !chartInstances.has(p.id));
    if (chartInstances.size !== plotStore.chartPanels.length) needsRebuild = true;
    if (!needsRebuild) {
      for (const panel of plotStore.chartPanels) {
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

    for (const panel of plotStore.chartPanels) {
      const chart = chartInstances.get(panel.id);
      if (!chart) continue;

      let xMin = Infinity, xMax = -Infinity;
      for (let j = 0; j < panel.keys.length; j++) {
        const samples = plotStore.liveSampleStore.get(panel.keys[j]) ?? [];
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

  function updateLiveTimeline() {
    if (!timelineChart) {
      renderTimeline();
      return;
    }

    const labels = plotStore.messageTimingLabels;
    const needsRebuild = timelineChart.data.datasets.length !== labels.length;
    if (needsRebuild) {
      renderTimeline();
      return;
    }

    let xMin = Infinity, xMax = -Infinity;
    for (let i = 0; i < labels.length; i++) {
      const entries = plotStore.messageTimingStore.get(labels[i]) ?? [];
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

  function updateLiveIntervalCharts() {
    let needsRebuild = plotStore.intervalPanels.some(p => !intervalInstances.has(p.id));
    if (intervalInstances.size !== plotStore.intervalPanels.length) needsRebuild = true;
    if (!needsRebuild) {
      for (const panel of plotStore.intervalPanels) {
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

    for (const panel of plotStore.intervalPanels) {
      const chart = intervalInstances.get(panel.id);
      if (!chart) continue;

      let xMin = Infinity, xMax = -Infinity;
      for (let j = 0; j < panel.keys.length; j++) {
        const data = plotStore.getIntervalData(panel.keys[j]);
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

  function updateRawLog() {
    if (!plotStore.showRawLog || !rawLogEl) return;
    if (plotStore.rawLogVersion === rawLogRenderedVersion) return;
    rawLogEl.textContent = plotStore.rawFrameLog.join('\n');
    rawLogRenderedVersion = plotStore.rawLogVersion;
    if (rawLogAutoScroll) {
      rawLogEl.scrollTop = rawLogEl.scrollHeight;
    }
  }

  // ---- Zoom & export ----

  function resetAllZoom() {
    for (const [, chart] of chartInstances) chart.resetZoom();
    if (timelineChart) timelineChart.resetZoom();
    for (const [, chart] of intervalInstances) chart.resetZoom();
  }

  function savePng() {
    if (plotStore.activeViews.has('timeline')) {
      const canvas = document.getElementById('timeline-chart') as HTMLCanvasElement | null;
      if (canvas) {
        const link = document.createElement('a');
        link.download = 'timeline.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
      }
    }
    if (plotStore.activeViews.has('interval')) {
      for (const panel of plotStore.intervalPanels) {
        const canvas = document.getElementById(`interval-${panel.id}`) as HTMLCanvasElement | null;
        if (!canvas) continue;
        const name = panel.keys.length === 1 ? `interval_${panel.keys[0]}` : `interval-${panel.id}`;
        const link = document.createElement('a');
        link.download = `${name}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
      }
    }
    if (plotStore.activeViews.has('signals')) {
      for (const panel of plotStore.chartPanels) {
        const canvas = document.getElementById(`chart-${panel.id}`) as HTMLCanvasElement | null;
        if (!canvas) continue;
        const seriesList = panel.keys.map(k => plotStore.allSeries.find(s => s.key === k)).filter(Boolean) as SignalSeries[];
        const name = seriesList.length === 1 ? `${seriesList[0].group}_${seriesList[0].signal}` : `chart-${panel.id}`;
        const link = document.createElement('a');
        link.download = `${name}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
      }
    }
  }

  // ---- Layout config ----

  function exportLayout() {
    const text = plotStore.exportLayoutYaml();
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
      const config = yaml.load(text) as any;
      if (!config?.plot) return;
      plotStore.applyLayoutConfig(config);
    };
    picker.click();
  }

  // ---- View drag-to-reorder ----

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
    const fromIdx = plotStore.viewOrder.indexOf(dragView);
    const toIdx = plotStore.viewOrder.indexOf(view);
    if (fromIdx < 0 || toIdx < 0) { dragView = null; dragOverView = null; return; }
    plotStore.reorderViews(fromIdx, toIdx);
    dragView = null;
    dragOverView = null;
  }

  function onViewDragEnd() {
    dragView = null;
    dragOverView = null;
  }

  // ---- Panel drag-to-reorder ----

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
    const panels = type === 'signals' ? plotStore.chartPanels : plotStore.intervalPanels;
    const fromIdx = panels.findIndex(p => p.id === dragPanelId);
    const toIdx = panels.findIndex(p => p.id === panelId);
    if (fromIdx < 0 || toIdx < 0) { dragPanelId = null; dragOverPanelId = null; dragPanelType = null; return; }
    plotStore.reorderPanels(type, fromIdx, toIdx);
    dragPanelId = null;
    dragOverPanelId = null;
    dragPanelType = null;
  }

  function onPanelDragEnd() {
    dragPanelId = null;
    dragOverPanelId = null;
    dragPanelType = null;
  }

  // ---- Lifecycle ----

  function destroyAllCharts() {
    for (const [, chart] of chartInstances) chart.destroy();
    chartInstances.clear();
    if (timelineChart) { timelineChart.destroy(); timelineChart = null; }
    for (const [, chart] of intervalInstances) chart.destroy();
    intervalInstances.clear();
  }

  onMount(() => {
    plotStore.registerRenderCallback((fullRebuild) => {
      if (fullRebuild) {
        renderCurrentView();
      } else {
        updateLiveCharts();
        updateRawLog();
      }
    });

    if (plotStore.allSeries.length > 0 || plotStore.messageTimingLabels.length > 0) {
      requestAnimationFrame(() => {
        renderCurrentView();
        updateRawLog();
      });
    }
  });

  onDestroy(() => {
    plotStore.unregisterRenderCallback();
    destroyAllCharts();
  });
</script>

<div class="container">
  <div class="page-header">
    <h1>Plot</h1>
    <p>Visualize CAN signal values over time</p>
  </div>

  <div class="card">
    <!-- Mode tabs -->
    <div class="mode-tabs">
      <button class="mode-tab" class:mode-tab-active={plotStore.mode === 'paste'} onclick={() => plotStore.switchMode('paste')}>
        Paste
      </button>
      <button class="mode-tab" class:mode-tab-active={plotStore.mode === 'live'} onclick={() => plotStore.switchMode('live')}>
        Live
      </button>
    </div>

    {#if plotStore.mode === 'paste'}
      <div class="form-group">
        <label for="plot-input">Candump Log</label>
        <textarea id="plot-input" bind:value={plotStore.input} rows="6"
          placeholder={"Paste candump lines (with timestamps for time axis):\n  (1713456789.123456) vcan0 101#E803050000000000\n  (1713456789.234567) vcan0 101#D007050000000000\n  (1713456789.345678) vcan0 00010101##1FD01000000..."}
          onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); plotStore.analyze(); } }}
        ></textarea>
        <div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">Press Ctrl+Enter to analyze</div>
      </div>
      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <button class="primary" onclick={() => plotStore.analyze()} disabled={codecStore.configs.length === 0}>Analyze</button>
        {#if codecStore.configs.length === 0}
          <span style="font-size: 13px; color: var(--text-dim);">Load a config first</span>
        {/if}
        {#if plotStore.status}
          <span style="font-size: 13px; color: var(--text-dim);">{plotStore.status}</span>
        {/if}
      </div>
    {:else}
      <div class="form-group">
        <label for="ws-url">WebSocket Server</label>
        <input id="ws-url" type="text" bind:value={plotStore.wsUrl}
          placeholder="ws://192.168.1.100:8765"
          disabled={plotStore.wsClient.status === 'connected' || plotStore.wsClient.status === 'connecting'}
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); plotStore.connectLive(); } }}
        />
      </div>
      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        {#if plotStore.wsClient.status === 'disconnected' || plotStore.wsClient.status === 'error'}
          <button class="primary" onclick={() => plotStore.connectLive()}
            disabled={codecStore.configs.length === 0 || !plotStore.wsUrl.trim()}>
            Connect
          </button>
        {:else}
          <button style="background: var(--red);" onclick={() => plotStore.disconnectLive()}>Disconnect</button>
          <button
            class="btn-sm"
            style="background: {plotStore.paused ? 'var(--green, #3fb950)' : 'var(--yellow, #d29922)'}; color: #000; font-weight: 600;"
            onclick={() => plotStore.togglePause()}
          >
            {plotStore.paused ? 'Resume' : 'Pause'}
          </button>
        {/if}

        <span class="connection-status {plotStore.wsClient.status}">
          {#if plotStore.wsClient.status === 'connected'}
            Connected{plotStore.wsClient.busInfo ? ` — ${plotStore.wsClient.busInfo.bus}` : ''}
          {:else if plotStore.wsClient.status === 'connecting'}
            Connecting...
          {:else if plotStore.wsClient.status === 'error'}
            {plotStore.wsClient.error ?? 'Error'}
          {:else}
            Disconnected
          {/if}
        </span>

        {#if plotStore.wsClient.status === 'connected'}
          <span style="font-size: 13px; color: var(--text-dim);">
            {#if plotStore.dumpMatchedOnly}{plotStore.matchedFrameCount} / {/if}{plotStore.wsClient.frameCount} frames{plotStore.paused ? ' (paused)' : ''}
          </span>
          {#if plotStore.dumpActive}
            <button style="background: var(--red); font-size: 12px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px;" onclick={() => plotStore.stopDumpToFile()}>
              <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: dump-pulse 1s infinite;"></span>
              Recording {plotStore.dumpFrameCount} frames — Stop
            </button>
          {:else}
            <button class="btn-sm" onclick={() => plotStore.startDumpToFile()}>Record to file</button>
          {/if}
          <label style="font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 4px; cursor: pointer;">
            <input type="checkbox" bind:checked={plotStore.dumpMatchedOnly} style="accent-color: var(--accent);" /> Matched only
          </label>
        {/if}

        {#if codecStore.configs.length === 0}
          <span style="font-size: 13px; color: var(--text-dim);">Load a config first</span>
        {/if}

        {#if plotStore.status}
          <span style="font-size: 13px; color: var(--text-dim);">{plotStore.status}</span>
        {/if}
      </div>

      <!-- Buffer mode -->
      <div style="display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap;">
        <span style="font-size: 12px; color: var(--text-dim);">Buffer:</span>
        <button class="chip" class:chip-active={plotStore.bufferMode === 'unlimited'} onclick={() => plotStore.bufferMode = 'unlimited'}>
          Unlimited
        </button>
        <button class="chip" class:chip-active={plotStore.bufferMode === 'samples'} onclick={() => plotStore.bufferMode = 'samples'}>
          Samples
        </button>
        <button class="chip" class:chip-active={plotStore.bufferMode === 'time'} onclick={() => plotStore.bufferMode = 'time'}>
          Time window
        </button>
        {#if plotStore.bufferMode === 'samples'}
          <input type="number" bind:value={plotStore.bufferSamples} min="100" step="1000"
            style="width: 80px; font-size: 12px; padding: 4px 8px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; color: var(--text);" />
        {/if}
        {#if plotStore.bufferMode === 'time'}
          <input type="number" bind:value={plotStore.bufferSeconds} min="5" step="5"
            style="width: 60px; font-size: 12px; padding: 4px 8px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; color: var(--text);" />
          <span style="font-size: 12px; color: var(--text-dim);">seconds</span>
        {/if}
        <span style="margin-left: 12px; border-left: 1px solid var(--border); padding-left: 12px; display: inline-flex; gap: 8px; align-items: center;">
          <span style="font-size: 12px; color: var(--text-dim);">Layout:</span>
          <button class="btn-sm" onclick={importLayout}>Import</button>
          {#if plotStore.pendingLayoutConfig}
            <span style="font-size: 12px; color: var(--yellow, #d29922);">Config loaded</span>
            <button class="btn-sm" onclick={() => { plotStore.pendingLayoutConfig = null; }}>Clear</button>
          {/if}
        </span>
      </div>

      <!-- Raw frame log -->
      {#if plotStore.wsClient.status === 'connected' || plotStore.rawFrameCount > 0}
        <div style="margin-top: 16px;">
          <button class="setup-toggle" onclick={() => { plotStore.showRawLog = !plotStore.showRawLog; if (plotStore.showRawLog) { rawLogRenderedVersion = 0; setTimeout(() => updateRawLog(), 0); } }}>
            {plotStore.showRawLog ? '▾' : '▸'} Raw frames
            <span style="color: var(--text-dim); font-size: 12px; margin-left: 6px;">{plotStore.rawFrameCount}</span>
          </button>
          {#if plotStore.showRawLog}
            <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center;">
              <label style="font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 4px; cursor: pointer;">
                <input type="checkbox" bind:checked={rawLogAutoScroll} style="accent-color: var(--accent);" /> Auto-scroll
              </label>
              <button class="btn-sm" onclick={() => { plotStore.clearRawLog(); rawLogRenderedVersion = 0; if (rawLogEl) rawLogEl.textContent = ''; }}>Clear</button>
              <button class="btn-sm" onclick={() => { const blob = new Blob([plotStore.rawFrameLog.join('\n')], { type: 'text/plain' }); const a = document.createElement('a'); a.download = 'candump.log'; a.href = URL.createObjectURL(blob); a.click(); URL.revokeObjectURL(a.href); }}>Save log</button>
              <span style="font-size: 12px; color: var(--text-dim);">Max lines</span>
              <input type="number" bind:value={plotStore.rawLogMax} min="100" step="500"
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

  {#if plotStore.allSeries.length > 0 || plotStore.messageTimingLabels.length > 0}
    <!-- View tabs (multi-select) + layout controls -->
    <div class="view-tabs">
      <button class="mode-tab" class:mode-tab-active={plotStore.activeViews.has('signals')} onclick={() => plotStore.toggleView('signals')}>
        Signals
      </button>
      <button class="mode-tab" class:mode-tab-active={plotStore.activeViews.has('timeline')} onclick={() => plotStore.toggleView('timeline')}>
        Timeline
      </button>
      <button class="mode-tab" class:mode-tab-active={plotStore.activeViews.has('interval')} onclick={() => plotStore.toggleView('interval')}>
        Interval
      </button>
      <div style="margin-left: auto; display: flex; gap: 8px;">
        <button class="btn-sm" onclick={() => plotStore.clearData()} style="color: var(--red, #f85149);">Clear</button>
        <button class="btn-sm" onclick={exportLayout}>Export Layout</button>
        <button class="btn-sm" onclick={importLayout}>Import Layout</button>
        {#if plotStore.pendingLayoutConfig}
          <button class="btn-sm" style="color: var(--yellow, #d29922);" onclick={() => { plotStore.pendingLayoutConfig = null; }}>Clear Layout</button>
        {/if}
      </div>
    </div>

    {#each plotStore.viewOrder as view (view)}
      {#if plotStore.activeViews.has(view)}
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
                  <button class="btn-sm" onclick={() => plotStore.selectAll()}>All</button>
                  <button class="btn-sm" onclick={() => plotStore.selectNone()}>None</button>
                  {#if plotStore.chartPanels.length > 0}
                    <button class="btn-sm" onclick={resetAllZoom}>Reset Zoom</button>
                    <button class="btn-sm" onclick={savePng}>Save PNG</button>
                  {/if}
                </div>
              </div>
              <div class="signal-selector">
                {#each plotStore.getGroups() as { group, signals }}
                  <div class="signal-group">
                    <div class="signal-group-label">{group}</div>
                    <div class="signal-chips">
                      {#each signals as s}
                        <button
                          class="chip"
                          class:chip-active={plotStore.selected.has(s.key)}
                          onclick={() => plotStore.toggleSignal(s.key)}
                        >
                          {s.signal}{s.unit ? ` (${s.unit})` : ''}
                          <span class="chip-count">{plotStore.mode === 'live' ? (plotStore.liveSampleCounts[s.key] ?? 0) : s.samples.length}</span>
                        </button>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            </div>

            {#if plotStore.chartPanels.length > 0}
              <div class="chart-stack">
                {#each plotStore.chartPanels as panel (panel.id)}
                  {@const seriesList = panel.keys.map(k => plotStore.allSeries.find(s => s.key === k)).filter(Boolean) as SignalSeries[]}
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
                              <button class="chart-signal-tag-remove" onclick={() => plotStore.splitFromPanel(panel.id, series.key)} title="Split to own chart">x</button>
                            {/if}
                          </span>
                        {/each}
                        <div class="chart-add-wrapper">
                          <button class="chart-add-btn" onclick={() => addDropdownOpen = addDropdownOpen === panel.id ? null : panel.id} title="Add signal to this chart">+</button>
                          {#if addDropdownOpen === panel.id}
                            {@const available = plotStore.getAvailableForPanel(panel.id)}
                            {#if available.length > 0}
                              <div class="chart-add-dropdown">
                                {#each available as s}
                                  <button class="chart-add-dropdown-item" onclick={() => { plotStore.addToPanel(panel.id, s.key); addDropdownOpen = null; }}>
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
                      <span class="chart-samples">{plotStore.getPanelSampleCount(panel)} samples</span>
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
                  {#if plotStore.messageTimingLabels.length > 0}
                    <button class="btn-sm" onclick={resetAllZoom}>Reset Zoom</button>
                    <button class="btn-sm" onclick={savePng}>Save PNG</button>
                  {/if}
                </div>
              </div>
              {#if plotStore.messageTimingLabels.length > 0}
                <div class="signal-selector" style="margin-bottom: 12px;">
                  {#each plotStore.messageTimingLabels as label, i}
                    <span class="chart-signal-tag" style="--tag-color: {CHART_COLORS[i % CHART_COLORS.length]}">
                      {label}
                      <span class="chip-count">{plotStore.messageTimingStore.get(label)?.length ?? 0}</span>
                    </span>
                  {/each}
                </div>
              {/if}
            </div>
            {#if plotStore.messageTimingLabels.length > 0}
              <div class="chart-card">
                <div class="chart-container" style="height: {Math.max(200, plotStore.messageTimingLabels.length * 40 + 60)}px;">
                  <canvas id="timeline-chart"></canvas>
                </div>
              </div>
            {/if}

          {:else if view === 'interval'}
            <div class="card">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <strong style="font-size: 14px;">Message Intervals</strong>
                <div style="display: flex; gap: 8px;">
                  <button class="btn-sm" onclick={() => plotStore.selectAllInterval()}>All</button>
                  <button class="btn-sm" onclick={() => plotStore.selectNoneInterval()}>None</button>
                  {#if plotStore.intervalPanels.length > 0}
                    <button class="btn-sm" onclick={resetAllZoom}>Reset Zoom</button>
                    <button class="btn-sm" onclick={savePng}>Save PNG</button>
                  {/if}
                </div>
              </div>
              <div class="signal-chips" style="flex-wrap: wrap;">
                {#each plotStore.messageTimingLabels as label, i}
                  <button
                    class="chip"
                    class:chip-active={plotStore.intervalSelected.has(label)}
                    onclick={() => plotStore.toggleIntervalSignal(label)}
                  >
                    {label}
                    <span class="chip-count">{Math.max(0, (plotStore.messageTimingStore.get(label)?.length ?? 0) - 1)}</span>
                  </button>
                {/each}
              </div>
            </div>

            {#if plotStore.intervalPanels.length > 0}
              <div class="chart-stack">
                {#each plotStore.intervalPanels as panel (panel.id)}
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
                              <button class="chart-signal-tag-remove" onclick={() => plotStore.splitFromIntervalPanel(panel.id, key)} title="Split to own chart">x</button>
                            {/if}
                          </span>
                        {/each}
                        <div class="chart-add-wrapper">
                          <button class="chart-add-btn" onclick={() => addDropdownOpen = addDropdownOpen === panel.id ? null : panel.id} title="Add message to this chart">+</button>
                          {#if addDropdownOpen === panel.id}
                            {@const available = plotStore.getAvailableForIntervalPanel(panel.id)}
                            {#if available.length > 0}
                              <div class="chart-add-dropdown">
                                {#each available as k}
                                  <button class="chart-add-dropdown-item" onclick={() => { plotStore.addToIntervalPanel(panel.id, k); addDropdownOpen = null; }}>
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
                      <span class="chart-samples">{plotStore.getIntervalPanelSampleCount(panel)} intervals</span>
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
