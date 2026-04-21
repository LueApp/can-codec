<script lang="ts">
  import { codecStore } from '$lib/codec-store.svelte';
  import { parseCandump } from '$lib/codec';
  import { WebSocketClient, type RawFrame } from '$lib/websocket-client.svelte';
  import type { DecodedMessage, MavlinkInfo } from '$lib/types';
  import { Chart, LineController, LineElement, PointElement, LinearScale, Tooltip, Legend, Filler } from 'chart.js';

  Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Legend, Filler);

  // ---- Types ----

  interface SignalSample {
    time: number;
    value: number;
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

  // ---- Server script (embedded for download) ----

  const SERVER_SCRIPT = `#!/usr/bin/env python3
"""
CAN-to-WebSocket bridge server.

Reads CAN frames from a SocketCAN interface and broadcasts them
as JSON over WebSocket to connected browser clients.

Requirements:
    pip install python-can websockets

Usage:
    python can_ws_server.py                    # defaults: vcan0, port 8765
    python can_ws_server.py --bus can0         # use real CAN interface
    python can_ws_server.py --port 9000        # custom port
    python can_ws_server.py --filter 0x101,0x201  # only forward these IDs
"""

import argparse
import asyncio
import json
import signal
import threading

try:
    import can
except ImportError:
    print("Error: python-can not installed. Run: pip install python-can")
    raise SystemExit(1)

try:
    import websockets
except ImportError:
    print("Error: websockets not installed. Run: pip install websockets")
    raise SystemExit(1)


class CANWebSocketServer:
    def __init__(self, bus="vcan0", interface="socketcan", fd=True,
                 host="0.0.0.0", port=8765, filter_ids=None):
        self.bus = bus
        self.interface = interface
        self.fd = fd
        self.host = host
        self.port = port
        self.filter_ids = filter_ids
        self._running = False
        self._clients = set()

    async def _handler(self, websocket):
        self._clients.add(websocket)
        addr = websocket.remote_address
        print(f"  + Client {addr} ({len(self._clients)} connected)")
        try:
            await websocket.send(json.dumps({
                "type": "status", "bus": self.bus, "fd": self.fd,
            }))
            async for _ in websocket:
                pass
        finally:
            self._clients.discard(websocket)
            print(f"  - Client {addr} ({len(self._clients)} connected)")

    def _reader_thread(self, loop):
        import time
        cfg = {"interface": self.interface, "channel": self.bus}
        if self.fd:
            cfg["fd"] = True
        print(f"  CAN bus: {self.bus} (fd={self.fd})")
        while self._running:
            try:
                with can.Bus(**cfg) as bus:
                    print(f"  CAN bus connected: {self.bus}")
                    self._notify_bus(loop, True)
                    while self._running:
                        msg = bus.recv(timeout=1.0)
                        if msg is None or not self._clients:
                            continue
                        if self.filter_ids and msg.arbitration_id not in self.filter_ids:
                            continue
                        data = json.dumps({
                            "type": "frame",
                            "arbitration_id": msg.arbitration_id,
                            "data": bytes(msg.data).hex().upper(),
                            "timestamp": msg.timestamp,
                            "is_fd": msg.is_fd,
                        })
                        loop.call_soon_threadsafe(websockets.broadcast, self._clients, data)
            except Exception as e:
                print(f"  CAN bus lost: {e}")
                self._notify_bus(loop, False, str(e))
                if not self._running:
                    break
                print(f"  Reconnecting to {self.bus} in 1s...")
                time.sleep(1)

    def _notify_bus(self, loop, connected, error=None):
        msg = json.dumps({"type": "status", "bus": self.bus, "fd": self.fd,
                          "connected": connected, **({"error": error} if error else {})})
        if self._clients:
            loop.call_soon_threadsafe(websockets.broadcast, self._clients, msg)

    async def run(self):
        self._running = True
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self.stop)
        async with websockets.serve(self._handler, self.host, self.port, ping_interval=None):
            print(f"WebSocket server on ws://{self.host}:{self.port}")
            t = threading.Thread(target=self._reader_thread, args=(loop,), daemon=True)
            t.start()
            while self._running:
                await asyncio.sleep(0.5)
        t.join(timeout=3)
        print("\\nStopped.")

    def stop(self):
        self._running = False


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="CAN-to-WebSocket bridge")
    p.add_argument("--bus", default="vcan0", help="CAN interface (default: vcan0)")
    p.add_argument("--interface", default="socketcan", help="python-can backend")
    p.add_argument("--no-fd", action="store_true", help="Disable CAN FD")
    p.add_argument("--host", default="0.0.0.0", help="Bind address (default: 0.0.0.0)")
    p.add_argument("--port", type=int, default=8765, help="Port (default: 8765)")
    p.add_argument("--filter", help="CAN IDs to forward (e.g. 0x101,0x202)")
    args = p.parse_args()
    fids = {int(x, 0) for x in args.filter.split(",")} if args.filter else None
    asyncio.run(CANWebSocketServer(
        bus=args.bus, interface=args.interface, fd=not args.no_fd,
        host=args.host, port=args.port, filter_ids=fids,
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

  // Live mode state
  let wsClient = new WebSocketClient();
  let wsUrl = $state(
    typeof localStorage !== 'undefined'
      ? (localStorage.getItem('cancodec_ws_url') ?? 'ws://localhost:8765')
      : 'ws://localhost:8765'
  );
  let liveStartTime: number | null = null;
  let mavlinkBuffers = new Map<number, { frames: Uint8Array[]; lastTs: number }>();
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

  // Buffer mode
  type BufferMode = 'unlimited' | 'samples' | 'time';
  let bufferMode = $state<BufferMode>('samples');
  let bufferSamples = $state(5000);
  let bufferSeconds = $state(60);

  // ---- Mode switching ----

  function switchMode(newMode: InputMode) {
    if (mode === 'live' && newMode !== 'live') {
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
    allSeries = [];
    chartPanels = [];
    nextPanelId = 0;
    addDropdownOpen = null;
    status = '';
    liveStartTime = null;
    liveSampleStore.clear();
    liveSampleCounts = {};
    rawFrameLog = [];
    rawFrameCount = 0;
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

      if (timestamp !== undefined) {
        if (firstTs === null) firstTs = timestamp;
        timestamp = timestamp - firstTs;
      } else {
        timestamp = lineIndex;
      }

      const baseLabel = mavlink
        ? `${mavlink.sys_id}.${mavlink.comp_id} / ${decoded.name}`
        : decoded.name;

      const signalEntries: { signals: typeof decoded.signals; groupLabel: string }[] = [];
      if (decoded.is_broadcast && decoded.sub_messages) {
        for (const sub of decoded.sub_messages) {
          signalEntries.push({ signals: sub.signals, groupLabel: `${baseLabel} / N${sub.node_id}` });
        }
      } else {
        signalEntries.push({ signals: decoded.signals, groupLabel: baseLabel });
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
          series.samples.push({ time: timestamp!, value: val });
        }
      }
      lineIndex++;
    }

    allSeries = Array.from(seriesMap.values()).sort((a, b) => a.key.localeCompare(b.key));
    if (allSeries.length <= 12) {
      chartPanels = allSeries.map(s => ({ id: `p${nextPanelId++}`, keys: [s.key] }));
    }
    status = `${allSeries.length} signals found from ${groups.length} frames`;
    renderCharts();
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
    wsClient.disconnect();
    clearMavlinkBuffers();
  }

  function clearMavlinkBuffers() {
    for (const timer of mavlinkTimers.values()) clearTimeout(timer);
    mavlinkTimers.clear();
    mavlinkBuffers.clear();
  }

  function formatRawFrame(frame: RawFrame): string {
    const ts = frame.timestamp.toFixed(6);
    const id = frame.arbitration_id.toString(16).toUpperCase().padStart(3, '0');
    const hex = Array.from(frame.data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    const sep = frame.is_fd ? '##1' : '#';
    return `(${ts})  ${id}${sep}${hex}`;
  }

  let rawLogVersion = 0;
  function appendRawFrame(frame: RawFrame) {
    rawFrameLog.push(formatRawFrame(frame));
    if (rawFrameLog.length > rawLogMax) {
      rawFrameLog.splice(0, rawFrameLog.length - rawLogMax);
    }
    rawFrameCount = rawFrameLog.length;
    rawLogVersion++;
  }

  function handleLiveFrame(frame: RawFrame) {
    const canId = frame.arbitration_id;

    appendRawFrame(frame);

    if (isMavlinkCanId(canId)) {
      const isStartFrame = frame.data.length > 0 && frame.data[0] === 0xFD;
      const buf = mavlinkBuffers.get(canId);

      // Flush previous buffer if new MAVLink message starts
      if (isStartFrame && buf && buf.frames.length > 0) {
        flushMavlinkBuffer(canId, buf);
      }

      if (isStartFrame) {
        mavlinkBuffers.set(canId, { frames: [frame.data], lastTs: frame.timestamp });
      } else if (buf) {
        buf.frames.push(frame.data);
        buf.lastTs = frame.timestamp;
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
      // Standard CAN — decode immediately
      try {
        const res = codecStore.codec.smartDecode(canId, frame.data);
        if (res) {
          appendDecoded(res.decoded, res.mavlink, frame.timestamp);
        }
      } catch { /* skip */ }
    }

    scheduleChartUpdate();
  }

  function flushMavlinkBuffer(canId: number, buf: { frames: Uint8Array[]; lastTs: number }) {
    try {
      const res = buf.frames.length === 1
        ? codecStore.codec.smartDecode(canId, buf.frames[0])
        : codecStore.codec.smartDecodeMultiFrame(canId, buf.frames);
      if (res) {
        appendDecoded(res.decoded, res.mavlink, buf.lastTs);
      }
    } catch { /* skip */ }
    mavlinkBuffers.delete(canId);
  }

  function appendSignalSamples(
    signals: { name: string; physical_value: number; unit: string; bitfield_flags: Record<string, boolean> | null }[],
    groupLabel: string,
    time: number
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
      samples.push({ time, value: val });

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

  function appendDecoded(decoded: DecodedMessage, mavlink: MavlinkInfo | undefined, timestamp: number) {
    if (liveStartTime === null) liveStartTime = timestamp;
    const time = timestamp - liveStartTime;

    const baseLabel = mavlink
      ? `${mavlink.sys_id}.${mavlink.comp_id} / ${decoded.name}`
      : decoded.name;

    let newSeriesAdded = false;

    if (decoded.is_broadcast && decoded.sub_messages) {
      // Broadcast: create per-node signal series
      for (const sub of decoded.sub_messages) {
        const groupLabel = `${baseLabel} / N${sub.node_id}`;
        if (appendSignalSamples(sub.signals, groupLabel, time)) newSeriesAdded = true;
      }
    } else {
      if (appendSignalSamples(decoded.signals, baseLabel, time)) newSeriesAdded = true;
    }

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
  }

  function scheduleChartUpdate() {
    if (chartUpdatePending) return;
    chartUpdatePending = true;
    setTimeout(() => {
      try {
        updateLiveCharts();
        updateRawLog();
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
    // Check if charts need rebuild (panel set changed)
    let needsRebuild = chartPanels.some(p => !chartInstances.has(p.id));
    if (chartInstances.size !== chartPanels.length) needsRebuild = true;
    // Also rebuild if any panel's dataset count changed
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
      updateLiveCounts();
      return;
    }

    // Incremental update — read from plain (non-reactive) sample store
    for (const panel of chartPanels) {
      const chart = chartInstances.get(panel.id);
      if (!chart) continue;

      let xMin = Infinity, xMax = -Infinity;
      for (let j = 0; j < panel.keys.length; j++) {
        const samples = liveSampleStore.get(panel.keys[j]) ?? [];
        const ds = chart.data.datasets[j];
        if (!ds) continue;
        const points = samples.map(s => ({ x: s.time, y: s.value }));
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

    updateLiveCounts();
  }

  function updateLiveCounts() {
    // Update reactive counts for display (at chart refresh rate, not per-frame)
    const counts: Record<string, number> = {};
    for (const [key, samples] of liveSampleStore) counts[key] = samples.length;
    liveSampleCounts = counts;
    status = `${allSeries.length} signals, ${wsClient.frameCount} frames`;
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
            data: samples.map(s => ({ x: s.time, y: s.value })),
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
            plugins: {
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

  // ---- Export ----

  function savePng() {
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
            {wsClient.frameCount} frames
          </span>
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
            <p><strong>1.</strong> Download the server script and copy it to your Ubuntu machine with the CAN interface:</p>
            <div style="margin: 8px 0;">
              <button class="btn-sm" onclick={downloadServer}>Download can_ws_server.py</button>
            </div>
            <p><strong>2.</strong> Install dependencies:</p>
            <pre><code>pip install python-can websockets</code></pre>
            <p><strong>3.</strong> Run the server:</p>
            <pre><code>python can_ws_server.py --bus can0 --port 8765</code></pre>
            <p><strong>4.</strong> Enter <code>ws://&lt;server-ip&gt;:8765</code> above and click Connect.</p>
            <details style="margin-top: 8px;">
              <summary style="cursor: pointer; color: var(--text-dim); font-size: 12px;">More options</summary>
              <pre><code># Filter specific CAN IDs{'\n'}python can_ws_server.py --bus can0 --filter 0x101,0x201{'\n'}{'\n'}# Disable CAN FD{'\n'}python can_ws_server.py --bus can0 --no-fd{'\n'}{'\n'}# Custom port and bind address{'\n'}python can_ws_server.py --host 0.0.0.0 --port 9000{'\n'}{'\n'}# Test with virtual CAN{'\n'}sudo modprobe vcan{'\n'}sudo ip link add dev vcan0 type vcan{'\n'}sudo ip link set up vcan0{'\n'}python can_ws_server.py --bus vcan0</code></pre>
            </details>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if allSeries.length > 0}
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <strong style="font-size: 14px;">Signals</strong>
        <div style="display: flex; gap: 8px;">
          <button class="btn-sm" onclick={selectAll}>All</button>
          <button class="btn-sm" onclick={selectNone}>None</button>
          {#if chartPanels.length > 0}
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
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-signal-tags">
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
  {/if}
</div>
