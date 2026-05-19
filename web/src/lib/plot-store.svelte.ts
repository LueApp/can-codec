import { codecStore } from './codec-store.svelte';
import { parseCandump, MavlinkReassembler, type MavlinkBuf } from './codec';
import { busStore } from './bus-store.svelte';
import type { RawFrame } from './websocket-client.svelte';
import type { DecodedMessage, DecodedSignal, Message, MavlinkInfo } from './types';
import type {
  FrameRef, SignalSample, SignalSeries, ChartPanel, MessageTimingEntry,
  InputMode, ChartView, BufferMode, PlotLayoutConfig,
} from './plot-types';
import yaml from 'js-yaml';

const CHART_UPDATE_INTERVAL = 50;

// ZLG USBCAN/USBCANFD CSV export → candump-line text. Header columns we use:
//   MAKE_CAN_ID(HEX)  e.g. "0x10101"
//   CAN/CANFD         "can_fd" | "can"
//   RX_TIMESTAMP      "[<microseconds>]"
//   DATA(HEX)         "fd 06 00 ..."   (space-separated bytes, trailing space possible)
export function zlgCsvToCandump(text: string): string {
  const stripped = text.replace(/^﻿/, '');
  const lines = stripped.split(/\r?\n/);
  if (lines.length < 2) return '';

  const header = lines[0].split(',').map(s => s.trim());
  const col = (name: string) => header.indexOf(name);
  const idCol = col('MAKE_CAN_ID(HEX)');
  const dataCol = col('DATA(HEX)');
  const tsCol = col('RX_TIMESTAMP');
  const fdCol = col('CAN/CANFD');
  if (idCol < 0 || dataCol < 0) return '';

  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row.trim()) continue;
    const c = row.split(',');
    if (c.length <= Math.max(idCol, dataCol)) continue;

    const idStr = (c[idCol] ?? '').trim().replace(/^0x/i, '');
    const hex = (c[dataCol] ?? '').trim().replace(/\s+/g, '');
    if (!idStr || !hex) continue;

    const isFd = fdCol >= 0 && c[fdCol]?.trim() === 'can_fd';
    const tsRaw = tsCol >= 0 ? (c[tsCol] ?? '').trim().replace(/^\[|\]$/g, '') : '';
    const tsNum = Number(tsRaw);
    const sep = isFd ? '##1' : '#';

    if (Number.isFinite(tsNum) && tsRaw !== '') {
      out.push(`(${(tsNum / 1e6).toFixed(6)}) can0 ${idStr}${sep}${hex}`);
    } else {
      out.push(`can0 ${idStr}${sep}${hex}`);
    }
  }
  return out.join('\n');
}

class PlotStore {
  // --- Reactive state ---
  mode = $state<InputMode>('paste');
  input = $state('');
  allSeries = $state<SignalSeries[]>([]);
  chartPanels = $state<ChartPanel[]>([]);
  status = $state('');
  activeViews = $state<Set<ChartView>>(new Set(['signals']));
  viewOrder = $state<ChartView[]>(['signals', 'timeline', 'interval']);
  messageTimingLabels = $state<string[]>([]);
  intervalPanels = $state<ChartPanel[]>([]);
  liveSampleCounts = $state<Record<string, number>>({});
  rawFrameCount = $state(0);
  rawLogMax = $state(2000);
  showRawLog = $state(false);
  paused = $state(false);
  dumpFrameCount = $state(0);
  dumpActive = $state(false);
  dumpMatchedOnly = $state(false);
  matchedFrameCount = $state(0);
  bufferMode = $state<BufferMode>('samples');
  bufferSamples = $state(5000);
  bufferSeconds = $state(60);
  pendingLayoutConfig = $state<PlotLayoutConfig | null>(null);
  timelineMode = $state<'normal' | 'set-origin' | 'measure'>('normal');
  timelineOrigin = $state(0);
  timelineMarkers = $state<{ time: number; label: string }[]>([]);
  applyTimingToAllViews = $state(false);

  // --- Zoom / follow-live state ---
  followLive = $state(
    typeof localStorage !== 'undefined'
      ? localStorage.getItem('cancodec_follow_live') !== '0'
      : true
  );
  followWindowSeconds = $state(
    typeof localStorage !== 'undefined'
      ? Number(localStorage.getItem('cancodec_follow_window')) || 10
      : 10
  );
  userZoomed = $state(false);
  showGestureHint = $state(
    typeof localStorage !== 'undefined'
      ? localStorage.getItem('cancodec_hide_gesture_hint') !== '1'
      : true
  );

  // --- Non-reactive state (performance) ---
  nextPanelId = 0;
  liveFrameUnsubscribe: (() => void) | null = null;
  liveSampleStore = new Map<string, SignalSample[]>();
  messageTimingStore = new Map<string, MessageTimingEntry[]>();
  rawFrameLog: string[] = [];
  liveStartTime: number | null = null;
  mavlinkReassembler = new MavlinkReassembler();
  mavlinkFlushTimer: ReturnType<typeof setTimeout> | null = null;
  chartUpdatePending = false;
  rawLogVersion = 0;
  dumpWriter: FileSystemWritableFileStream | null = null;

  // --- Render callback ---
  private _renderCallback: ((fullRebuild: boolean) => void) | null = null;

  registerRenderCallback(cb: (fullRebuild: boolean) => void) {
    this._renderCallback = cb;
  }

  unregisterRenderCallback() {
    this._renderCallback = null;
  }

  // --- Shared bus proxies (the actual state lives in busStore) ---
  get wsClient() { return busStore.client; }
  get wsUrl() { return busStore.wsUrl; }
  set wsUrl(v: string) { busStore.wsUrl = v; }

  // --- Derived getters ---
  get selected(): Set<string> {
    return new Set(this.chartPanels.flatMap(p => p.keys));
  }

  get intervalSelected(): Set<string> {
    return new Set(this.intervalPanels.flatMap(p => p.keys));
  }

  // --- Render scheduling ---
  requestRender(fullRebuild = false) {
    this._renderCallback?.(fullRebuild);
  }

  scheduleChartUpdate() {
    if (this.chartUpdatePending) return;
    this.chartUpdatePending = true;
    setTimeout(() => {
      try {
        if (!this.paused) {
          this._renderCallback?.(false);
        }
      } finally {
        this.chartUpdatePending = false;
      }
    }, CHART_UPDATE_INTERVAL);
  }

  // --- Data reset ---
  resetData() {
    this.allSeries = [];
    this.chartPanels = [];
    this.intervalPanels = [];
    this.nextPanelId = 0;
    this.status = '';
    this.liveStartTime = null;
    this.liveSampleStore.clear();
    this.liveSampleCounts = {};
    this.messageTimingStore.clear();
    this.messageTimingLabels = [];
    this.rawFrameLog = [];
    this.rawFrameCount = 0;
    this.matchedFrameCount = 0;
    this.timelineMode = 'normal';
    this.timelineOrigin = 0;
    this.timelineMarkers = [];
  }

  // --- Timeline timing measurement ---
  enterTimelineMode(mode: 'set-origin' | 'measure') {
    if (this.timelineMode === mode) {
      this.timelineMode = 'normal';
    } else {
      this.timelineMode = mode;
      if (mode === 'measure') this.timelineMarkers = [];
    }
  }

  handleTimelineClick(time: number, label: string): 'origin-set' | 'marker-added' | 'measure-complete' | null {
    if (this.timelineMode === 'set-origin') {
      this.timelineOrigin = time;
      this.timelineMode = 'normal';
      this.requestRender(false);
      return 'origin-set';
    }
    if (this.timelineMode === 'measure') {
      const next = this.timelineMarkers.length >= 2
        ? [{ time, label }]
        : [...this.timelineMarkers, { time, label }];
      this.timelineMarkers = next;
      const done = next.length === 2;
      if (done) this.timelineMode = 'normal';
      this.requestRender(false);
      return done ? 'measure-complete' : 'marker-added';
    }
    return null;
  }

  resetTimelineOrigin() {
    this.timelineOrigin = 0;
    this.timelineMode = 'normal';
    this.requestRender(false);
  }

  clearTimelineMarkers() {
    this.timelineMarkers = [];
    this.timelineMode = 'normal';
    this.requestRender(false);
  }

  toggleApplyTimingToAllViews() {
    this.applyTimingToAllViews = !this.applyTimingToAllViews;
    this.requestRender(false);
  }

  // --- Zoom / follow-live ---
  noteUserInteraction() {
    if (!this.userZoomed) this.userZoomed = true;
    if (this.followLive) {
      this.followLive = false;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('cancodec_follow_live', '0');
      }
    }
  }

  toggleFollowLive() {
    this.followLive = !this.followLive;
    if (this.followLive) this.userZoomed = false;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('cancodec_follow_live', this.followLive ? '1' : '0');
    }
    this.requestRender(false);
  }

  setFollowWindowSeconds(seconds: number) {
    const s = Math.max(1, Math.min(3600, Math.round(seconds)));
    this.followWindowSeconds = s;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('cancodec_follow_window', String(s));
    }
    this.requestRender(false);
  }

  clearUserZoom() {
    this.userZoomed = false;
  }

  dismissGestureHint() {
    this.showGestureHint = false;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('cancodec_hide_gesture_hint', '1');
    }
  }

  get timelineMarkerDelta(): number | null {
    if (this.timelineMarkers.length !== 2) return null;
    return this.timelineMarkers[1].time - this.timelineMarkers[0].time;
  }

  // --- Mode switching ---
  switchMode(newMode: InputMode) {
    if (this.mode === 'live' && newMode !== 'live') {
      this.stopDumpToFile();
      this.unsubscribeLiveFrames();
      this.clearMavlinkBuffers();
    }
    if (newMode !== this.mode) {
      this.resetData();
      this.requestRender(true);
    }
    this.mode = newMode;
    // When entering live mode, subscribe immediately — even if the bus was
    // already connected by another page (encode). Without this, frames flow
    // past plot silently because the Connect button is hidden.
    if (this.mode === 'live') {
      this.subscribeLiveFrames();
    }
  }

  // --- Connection management ---
  /** Public + idempotent: callers (plot page onMount, switchMode) can call freely. */
  subscribeLiveFrames() {
    if (this.liveFrameUnsubscribe) return;
    this.liveFrameUnsubscribe = busStore.client.addFrameCallback(
      (frame) => this.handleLiveFrame(frame)
    );
  }

  unsubscribeLiveFrames() {
    if (this.liveFrameUnsubscribe) {
      this.liveFrameUnsubscribe();
      this.liveFrameUnsubscribe = null;
    }
  }

  connectLive() {
    this.resetData();
    this.requestRender(true);
    this.clearMavlinkBuffers();
    this.subscribeLiveFrames();
    busStore.connect();
  }

  disconnectLive() {
    this.paused = false;
    this.stopDumpToFile();
    this.unsubscribeLiveFrames();
    busStore.disconnect();
    this.clearMavlinkBuffers();
  }

  clearMavlinkBuffers() {
    if (this.mavlinkFlushTimer) {
      clearTimeout(this.mavlinkFlushTimer);
      this.mavlinkFlushTimer = null;
    }
    this.mavlinkReassembler.flush();
  }

  // --- Pause ---
  togglePause() {
    this.paused = !this.paused;
    if (!this.paused) {
      this._renderCallback?.(false);
    }
  }

  // --- Dump to file ---
  async startDumpToFile() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const handle = await (window as any).showSaveFilePicker({
      suggestedName: `candump_${ts}.log`,
      types: [{ description: 'Log files', accept: { 'text/plain': ['.log'] } }],
    });
    this.dumpWriter = await handle.createWritable();
    this.dumpFrameCount = 0;
    this.dumpActive = true;
  }

  async stopDumpToFile() {
    if (!this.dumpWriter) return;
    const w = this.dumpWriter;
    this.dumpWriter = null;
    this.dumpActive = false;
    await w.close();
  }

  // --- Format helpers ---
  formatRawFrame(frame: RawFrame): string {
    const ts = frame.timestamp.toFixed(6);
    const iface = this.wsClient.busInfo?.bus ?? 'can0';
    const id = frame.arbitration_id > 0x7FF
      ? frame.arbitration_id.toString(16).toUpperCase().padStart(8, '0')
      : frame.arbitration_id.toString(16).toUpperCase().padStart(3, '0');
    const dlc = frame.data.length.toString().padStart(2, '0');
    const hex = Array.from(frame.data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    // Always print a 2-char RX/TX token so columns line up regardless of direction.
    const dir = frame.direction === 'tx' ? 'TX' : 'RX';
    return ` (${ts})  ${dir}  ${iface}  ${id}  [${dlc}]  ${hex}`;
  }

  formatFrameShort(f: FrameRef): string {
    const id = f.id.toString(16).toUpperCase().padStart(f.id > 0x7FF ? 8 : 3, '0');
    const hex = f.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    const nFrames = 1 + (f.extraFrames?.length ?? 0);
    const suffix = nFrames > 1 ? ` (+${nFrames - 1} frames)` : '';
    return `0x${id}  ${hex}${suffix}`;
  }

  formatOneFrame(id: string, iface: string, data: number[], timestamp: number): string {
    const ts = timestamp.toFixed(6);
    const dlc = data.length.toString().padStart(2, '0');
    const hex = data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    return ` (${ts})  ${iface}  ${id}  [${dlc}]  ${hex}`;
  }

  formatFrameCandump(f: FrameRef): string {
    const iface = this.wsClient.busInfo?.bus ?? 'can0';
    const id = f.id > 0x7FF
      ? f.id.toString(16).toUpperCase().padStart(8, '0')
      : f.id.toString(16).toUpperCase().padStart(3, '0');
    const lines = [this.formatOneFrame(id, iface, f.data, f.timestamp)];
    if (f.extraFrames) {
      for (const ef of f.extraFrames) {
        lines.push(this.formatOneFrame(id, iface, ef.data, ef.timestamp));
      }
    }
    return lines.join('\n');
  }

  getMuxSuffix(msg: Message | null, signals: { name: string; enum_name?: string | null }[]): string {
    if (!msg?.mux_signal) return '';
    const muxSig = signals.find(s => s.name === msg.mux_signal);
    if (muxSig?.enum_name) return ` / ${muxSig.enum_name}`;
    return '';
  }

  isMavlinkCanId(canId: number): boolean {
    return (canId & 0x10000) !== 0;
  }

  // --- Raw frame log ---
  appendRawFrame(frame: RawFrame, matched?: boolean) {
    const line = this.formatRawFrame(frame);
    this.rawFrameLog.push(line);
    if (this.rawFrameLog.length > this.rawLogMax) {
      this.rawFrameLog.splice(0, this.rawFrameLog.length - this.rawLogMax);
    }
    this.rawFrameCount = this.rawFrameLog.length;
    this.rawLogVersion++;
    if (this.dumpWriter && (!this.dumpMatchedOnly || matched === true)) {
      this.dumpWriter.write(line + '\n');
      this.dumpFrameCount++;
    }
  }

  // --- Live data ingestion ---
  handleLiveFrame(frame: RawFrame) {
    const canId = frame.arbitration_id;

    if (this.isMavlinkCanId(canId)) {
      this.appendRawFrame(frame);

      for (const buf of this.mavlinkReassembler.feed(canId, frame.data, frame.timestamp, frame.is_fd)) {
        this.decodeMavlinkBuf(canId, buf);
      }

      if (this.mavlinkFlushTimer) clearTimeout(this.mavlinkFlushTimer);
      if (this.mavlinkReassembler.pendingCount() > 0) {
        this.mavlinkFlushTimer = setTimeout(() => {
          this.mavlinkFlushTimer = null;
          for (const { canId: cid, buf } of this.mavlinkReassembler.flush()) {
            this.decodeMavlinkBuf(cid, buf);
          }
          this.scheduleChartUpdate();
        }, 100);
      }
    } else {
      let matched = false;
      try {
        const res = codecStore.codec.smartDecode(canId, frame.data, frame.dlc);
        if (res) {
          matched = true;
          this.matchedFrameCount++;
          this.appendDecoded(res.decoded, res.mavlink, frame.timestamp, frame.is_fd, undefined, undefined, frame.direction);
        }
      } catch { /* skip */ }
      this.appendRawFrame(frame, matched);
    }

    this.scheduleChartUpdate();
  }

  decodeMavlinkBuf(canId: number, buf: MavlinkBuf) {
    let decoded = false;
    try {
      const res = buf.frames.length === 1
        ? codecStore.codec.smartDecode(canId, buf.frames[0])
        : codecStore.codec.smartDecodeMultiFrame(canId, buf.frames);
      if (res) {
        decoded = true;
        this.matchedFrameCount += buf.frames.length;
        const ts = buf.timestamps[0] ?? 0;
        this.appendDecoded(res.decoded, res.mavlink, ts, buf.is_fd, buf.frames, buf.timestamps);
      }
    } catch { /* skip */ }
    if (decoded && this.dumpMatchedOnly && this.dumpWriter) {
      const iface = this.wsClient.busInfo?.bus ?? 'can0';
      const id = canId > 0x7FF
        ? canId.toString(16).toUpperCase().padStart(8, '0')
        : canId.toString(16).toUpperCase().padStart(3, '0');
      for (let i = 0; i < buf.frames.length; i++) {
        const ts = (buf.timestamps[i] ?? 0).toFixed(6);
        const data = buf.frames[i];
        const dlc = data.length.toString().padStart(2, '0');
        const hex = Array.from(data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        this.dumpWriter.write(` (${ts})  ${iface}  ${id}  [${dlc}]  ${hex}\n`);
        this.dumpFrameCount++;
      }
    }
  }

  appendSignalSamples(
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

      let samples = this.liveSampleStore.get(key);
      if (!samples) {
        samples = [];
        this.liveSampleStore.set(key, samples);
        const meta: SignalSeries = { key, group: groupLabel, signal: sig.name, unit: sig.unit, samples: [] };
        this.allSeries = [...this.allSeries, meta].sort((a, b) => a.key.localeCompare(b.key));
        newSeriesAdded = true;
      }
      samples.push({ time, value: val, frame });

      if (this.bufferMode === 'samples' && samples.length > this.bufferSamples) {
        samples.splice(0, samples.length - this.bufferSamples);
      } else if (this.bufferMode === 'time') {
        const cutoff = time - this.bufferSeconds;
        let trimTo = 0;
        while (trimTo < samples.length && samples[trimTo].time < cutoff) trimTo++;
        if (trimTo > 0) samples.splice(0, trimTo);
      }
    }
    return newSeriesAdded;
  }

  private _isNodeDisabled(filter: { disabledNodes: number[] } | undefined, nodeId: number): boolean {
    return !!filter && filter.disabledNodes.length > 0 && filter.disabledNodes.includes(nodeId);
  }

  private _isEnumDisabled(filter: { disabledEnumValues?: Record<string, string[]> } | undefined, signals: { name: string; enum_name?: string | null }[]): boolean {
    if (!filter?.disabledEnumValues) return false;
    for (const sig of signals) {
      const disabled = filter.disabledEnumValues[sig.name];
      if (!disabled?.length) continue;
      if (!sig.enum_name) return true;
      if (disabled.includes(sig.enum_name)) return true;
    }
    return false;
  }

  private _filterSignals<T extends { name: string }>(signals: T[], filter: { disabledSignals: string[] } | undefined): T[] {
    if (!filter || !filter.disabledSignals.length) return signals;
    return signals.filter(s => !filter.disabledSignals.includes(s.name));
  }

  appendDecoded(
    decoded: DecodedMessage, mavlink: MavlinkInfo | undefined, timestamp: number, is_fd: boolean,
    rawFrames?: Uint8Array[], rawTimestamps?: number[], direction?: 'rx' | 'tx',
  ) {
    if (this.liveStartTime === null) this.liveStartTime = timestamp;
    const time = timestamp - this.liveStartTime;
    const primaryData = rawFrames ? Array.from(rawFrames[0]) : decoded.raw_data;
    const frame: FrameRef = { id: decoded.msg_id, data: primaryData, timestamp, is_fd, direction };
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
    const filter = codecStore.filtersByMessage.get(decoded.name);

    if (decoded.is_broadcast && decoded.sub_messages) {
      for (const sub of decoded.sub_messages) {
        if (this._isNodeDisabled(filter, sub.node_id)) continue;
        if (this._isEnumDisabled(filter, sub.signals)) continue;
        const filteredSignals = this._filterSignals(sub.signals, filter);
        const mux = this.getMuxSuffix(msg, sub.signals);
        const groupLabel = `${baseLabel} / N${sub.node_id}${mux}`;
        if (this.appendMessageTiming(groupLabel, time, frame)) newTimingAdded = true;
        if (this.appendSignalSamples(filteredSignals, groupLabel, time, frame)) newSeriesAdded = true;
      }
    } else {
      if (this._isNodeDisabled(filter, decoded.node_id)) return;
      if (this._isEnumDisabled(filter, decoded.signals)) return;
      const filteredSignals = this._filterSignals(decoded.signals, filter);
      const mux = this.getMuxSuffix(msg, decoded.signals);
      const groupLabel = (msg && msg.node_count > 1)
        ? `${baseLabel} / N${decoded.node_id}${mux}`
        : `${baseLabel}${mux}`;
      if (this.appendMessageTiming(groupLabel, time, frame)) newTimingAdded = true;
      if (this.appendSignalSamples(filteredSignals, groupLabel, time, frame)) newSeriesAdded = true;
    }

    if (newSeriesAdded || newTimingAdded) {
      if (this.pendingLayoutConfig) {
        this.autoApplyPendingLayout();
      } else {
        if (newSeriesAdded && this.allSeries.length <= 12) {
          const inPanels = new Set(this.chartPanels.flatMap(p => p.keys));
          const newPanels = this.allSeries
            .filter(s => !inPanels.has(s.key))
            .map(s => ({ id: `p${this.nextPanelId++}`, keys: [s.key] }));
          if (newPanels.length > 0) {
            this.chartPanels = [...this.chartPanels, ...newPanels];
          }
        }

        if (newTimingAdded && this.messageTimingLabels.length <= 12) {
          const inPanels = new Set(this.intervalPanels.flatMap(p => p.keys));
          const newPanels = this.messageTimingLabels
            .filter(k => !inPanels.has(k))
            .map(k => ({ id: `ip${this.nextPanelId++}`, keys: [k] }));
          if (newPanels.length > 0) {
            this.intervalPanels = [...this.intervalPanels, ...newPanels];
          }
        }
      }
    }
  }

  appendMessageTiming(groupLabel: string, time: number, frame: FrameRef): boolean {
    let arr = this.messageTimingStore.get(groupLabel);
    let isNew = false;
    if (!arr) {
      arr = [];
      this.messageTimingStore.set(groupLabel, arr);
      this.messageTimingLabels = Array.from(this.messageTimingStore.keys()).sort();
      isNew = true;
    }
    arr.push({ time, frame });
    if (this.bufferMode === 'samples' && arr.length > this.bufferSamples) {
      arr.splice(0, arr.length - this.bufferSamples);
    } else if (this.bufferMode === 'time') {
      const cutoff = time - this.bufferSeconds;
      let trimTo = 0;
      while (trimTo < arr.length && arr[trimTo].time < cutoff) trimTo++;
      if (trimTo > 0) arr.splice(0, trimTo);
    }
    return isNew;
  }

  // --- Signal panel management ---
  toggleSignal(key: string) {
    const panelIdx = this.chartPanels.findIndex(p => p.keys.includes(key));
    if (panelIdx >= 0) {
      const panel = this.chartPanels[panelIdx];
      if (panel.keys.length === 1) {
        this.chartPanels = this.chartPanels.filter((_, i) => i !== panelIdx);
      } else {
        this.chartPanels = this.chartPanels.map((p, i) =>
          i === panelIdx ? { ...p, keys: p.keys.filter(k => k !== key) } : p
        );
      }
    } else {
      this.chartPanels = [...this.chartPanels, { id: `p${this.nextPanelId++}`, keys: [key] }];
    }
    if (this.mode === 'live') this.scheduleChartUpdate();
    else this.requestRender(true);
  }

  selectAll() {
    const already = new Set(this.chartPanels.flatMap(p => p.keys));
    const newPanels = this.allSeries
      .filter(s => !already.has(s.key))
      .map(s => ({ id: `p${this.nextPanelId++}`, keys: [s.key] }));
    this.chartPanels = [...this.chartPanels, ...newPanels];
    if (this.mode === 'live') this.scheduleChartUpdate();
    else this.requestRender(true);
  }

  selectNone() {
    this.chartPanels = [];
    this.requestRender(true);
  }

  addToPanel(panelId: string, signalKey: string) {
    this.chartPanels = this.chartPanels
      .map(p => {
        if (p.id === panelId) return { ...p, keys: [...p.keys, signalKey] };
        if (p.keys.includes(signalKey)) return { ...p, keys: p.keys.filter(k => k !== signalKey) };
        return p;
      })
      .filter(p => p.keys.length > 0);
    if (this.mode === 'live') this.scheduleChartUpdate();
    else this.requestRender(true);
  }

  splitFromPanel(panelId: string, signalKey: string) {
    this.chartPanels = [
      ...this.chartPanels.map(p =>
        p.id === panelId ? { ...p, keys: p.keys.filter(k => k !== signalKey) } : p
      ).filter(p => p.keys.length > 0),
      { id: `p${this.nextPanelId++}`, keys: [signalKey] },
    ];
    if (this.mode === 'live') this.scheduleChartUpdate();
    else this.requestRender(true);
  }

  // --- Interval panel management ---
  toggleIntervalSignal(key: string) {
    const panelIdx = this.intervalPanels.findIndex(p => p.keys.includes(key));
    if (panelIdx >= 0) {
      const panel = this.intervalPanels[panelIdx];
      if (panel.keys.length === 1) {
        this.intervalPanels = this.intervalPanels.filter((_, i) => i !== panelIdx);
      } else {
        this.intervalPanels = this.intervalPanels.map((p, i) =>
          i === panelIdx ? { ...p, keys: p.keys.filter(k => k !== key) } : p
        );
      }
    } else {
      this.intervalPanels = [...this.intervalPanels, { id: `ip${this.nextPanelId++}`, keys: [key] }];
    }
    if (this.mode === 'live') this.scheduleChartUpdate();
    else this.requestRender(true);
  }

  selectAllInterval() {
    const already = new Set(this.intervalPanels.flatMap(p => p.keys));
    const newPanels = this.messageTimingLabels
      .filter(k => !already.has(k))
      .map(k => ({ id: `ip${this.nextPanelId++}`, keys: [k] }));
    this.intervalPanels = [...this.intervalPanels, ...newPanels];
    if (this.mode === 'live') this.scheduleChartUpdate();
    else this.requestRender(true);
  }

  selectNoneInterval() {
    this.intervalPanels = [];
    this.requestRender(true);
  }

  addToIntervalPanel(panelId: string, key: string) {
    this.intervalPanels = this.intervalPanels
      .map(p => {
        if (p.id === panelId) return { ...p, keys: [...p.keys, key] };
        if (p.keys.includes(key)) return { ...p, keys: p.keys.filter(k => k !== key) };
        return p;
      })
      .filter(p => p.keys.length > 0);
    if (this.mode === 'live') this.scheduleChartUpdate();
    else this.requestRender(true);
  }

  splitFromIntervalPanel(panelId: string, key: string) {
    this.intervalPanels = [
      ...this.intervalPanels.map(p =>
        p.id === panelId ? { ...p, keys: p.keys.filter(k => k !== key) } : p
      ).filter(p => p.keys.length > 0),
      { id: `ip${this.nextPanelId++}`, keys: [key] },
    ];
    if (this.mode === 'live') this.scheduleChartUpdate();
    else this.requestRender(true);
  }

  // --- View management ---
  toggleView(view: ChartView) {
    const next = new Set(this.activeViews);
    if (next.has(view)) {
      if (next.size > 1) next.delete(view);
    } else {
      next.add(view);
    }
    this.activeViews = next;
    this.requestRender(true);
  }

  reorderViews(fromIdx: number, toIdx: number) {
    const next = [...this.viewOrder];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    this.viewOrder = next;
    this.requestRender(true);
  }

  reorderPanels(type: 'signals' | 'interval', fromIdx: number, toIdx: number) {
    const panels = type === 'signals' ? this.chartPanels : this.intervalPanels;
    const next = [...panels];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    if (type === 'signals') this.chartPanels = next;
    else this.intervalPanels = next;
    if (this.mode === 'live') this.scheduleChartUpdate();
    else this.requestRender(true);
  }

  // --- Query helpers ---
  getSamples(key: string): SignalSample[] {
    return this.mode === 'live' ? (this.liveSampleStore.get(key) ?? []) : (this.allSeries.find(s => s.key === key)?.samples ?? []);
  }

  getGroups(): { group: string; signals: SignalSeries[] }[] {
    const map = new Map<string, SignalSeries[]>();
    for (const s of this.allSeries) {
      let list = map.get(s.group);
      if (!list) { list = []; map.set(s.group, list); }
      list.push(s);
    }
    return Array.from(map.entries()).map(([group, signals]) => ({ group, signals }));
  }

  getAvailableForPanel(panelId: string): SignalSeries[] {
    const panel = this.chartPanels.find(p => p.id === panelId);
    if (!panel) return [];
    const panelKeys = new Set(panel.keys);
    return this.allSeries.filter(s => this.selected.has(s.key) && !panelKeys.has(s.key));
  }

  getPanelSampleCount(panel: ChartPanel): number {
    if (this.mode === 'live') {
      return panel.keys.reduce((sum, k) => sum + (this.liveSampleCounts[k] ?? 0), 0);
    }
    return panel.keys.reduce((sum, k) => {
      const s = this.allSeries.find(se => se.key === k);
      return sum + (s?.samples.length ?? 0);
    }, 0);
  }

  getAvailableForIntervalPanel(panelId: string): string[] {
    const panel = this.intervalPanels.find(p => p.id === panelId);
    if (!panel) return [];
    const panelKeys = new Set(panel.keys);
    return this.messageTimingLabels.filter(k => this.intervalSelected.has(k) && !panelKeys.has(k));
  }

  getIntervalPanelSampleCount(panel: ChartPanel): number {
    return panel.keys.reduce((sum, k) => sum + Math.max(0, (this.messageTimingStore.get(k)?.length ?? 0) - 1), 0);
  }

  getIntervalData(label: string): { time: number; dt: number; frame: FrameRef }[] {
    const entries = this.messageTimingStore.get(label) ?? [];
    const result: { time: number; dt: number; frame: FrameRef }[] = [];
    for (let i = 1; i < entries.length; i++) {
      const dt = (entries[i].time - entries[i - 1].time) * 1000;
      result.push({ time: entries[i].time, dt, frame: entries[i].frame });
    }
    return result;
  }

  updateLiveCounts() {
    const counts: Record<string, number> = {};
    for (const [key, samples] of this.liveSampleStore) counts[key] = samples.length;
    this.liveSampleCounts = counts;
    this.status = `${this.allSeries.length} signals`;
  }

  // --- Paste mode analysis ---
  analyze() {
    this.resetData();
    const lines = this.input.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { this.requestRender(true); return; }

    const codec = codecStore.codec;
    const seriesMap = new Map<string, SignalSeries>();
    let firstTs: number | null = null;
    let lineIndex = 0;

    type FrameGroup = { canId: number; timestamps: (number | undefined)[]; datas: Uint8Array[] };
    const groups: (FrameGroup | { line: string; timestamp?: number })[] = [];

    const reasm = new MavlinkReassembler();
    const pushBuf = (canId: number, buf: MavlinkBuf) => {
      groups.push({ canId, timestamps: buf.timestamps, datas: buf.frames });
    };

    for (const line of lines) {
      const frame = parseCandump(line);
      if (!frame) continue;

      if (this.isMavlinkCanId(frame.canId)) {
        const ts = frame.timestamp ?? 0;
        for (const buf of reasm.feed(frame.canId, frame.data, ts, frame.isFD)) {
          pushBuf(frame.canId, buf);
        }
      } else {
        groups.push({ line, timestamp: frame.timestamp });
      }
    }

    for (const { canId, buf } of reasm.flush()) pushBuf(canId, buf);

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
      const filter = codecStore.filtersByMessage.get(decoded.name);

      const signalEntries: { signals: typeof decoded.signals; groupLabel: string }[] = [];
      if (decoded.is_broadcast && decoded.sub_messages) {
        for (const sub of decoded.sub_messages) {
          if (this._isNodeDisabled(filter, sub.node_id)) continue;
          if (this._isEnumDisabled(filter, sub.signals)) continue;
          const mux = this.getMuxSuffix(msg, sub.signals);
          signalEntries.push({ signals: this._filterSignals(sub.signals, filter), groupLabel: `${baseLabel} / N${sub.node_id}${mux}` });
        }
      } else {
        if (this._isNodeDisabled(filter, decoded.node_id)) { lineIndex++; continue; }
        if (this._isEnumDisabled(filter, decoded.signals)) { lineIndex++; continue; }
        const mux = this.getMuxSuffix(msg, decoded.signals);
        const groupLabel = (msg && msg.node_count > 1)
          ? `${baseLabel} / N${decoded.node_id}${mux}`
          : `${baseLabel}${mux}`;
        signalEntries.push({ signals: this._filterSignals(decoded.signals, filter), groupLabel });
      }

      for (const entry of signalEntries) {
        let timingArr = this.messageTimingStore.get(entry.groupLabel);
        if (!timingArr) { timingArr = []; this.messageTimingStore.set(entry.groupLabel, timingArr); }
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

    this.messageTimingLabels = Array.from(this.messageTimingStore.keys()).sort();

    this.allSeries = Array.from(seriesMap.values()).sort((a, b) => a.key.localeCompare(b.key));
    if (this.allSeries.length <= 12) {
      this.chartPanels = this.allSeries.map(s => ({ id: `p${this.nextPanelId++}`, keys: [s.key] }));
    }
    if (this.messageTimingLabels.length <= 12) {
      this.intervalPanels = this.messageTimingLabels.map(k => ({ id: `ip${this.nextPanelId++}`, keys: [k] }));
    }
    this.status = `${this.allSeries.length} signals found from ${groups.length} frames`;
    this.requestRender(true);
  }

  // --- Layout config ---
  exportLayoutYaml(): string {
    const config: PlotLayoutConfig = {
      plot: {
        views: {
          active: [...this.activeViews],
          order: [...this.viewOrder],
        },
        buffer: {
          mode: this.bufferMode,
          samples: this.bufferSamples,
          seconds: this.bufferSeconds,
        },
        signals: {
          panels: this.chartPanels.map(p => [...p.keys]),
        },
        intervals: {
          panels: this.intervalPanels.map(p => [...p.keys]),
        },
      },
    };
    return yaml.dump(config, { lineWidth: -1 });
  }

  applyLayoutConfig(config: PlotLayoutConfig) {
    const p = config.plot;

    if (p.views?.active) {
      const validViews: ChartView[] = ['signals', 'timeline', 'interval'];
      const active = p.views.active.filter(v => validViews.includes(v));
      if (active.length > 0) this.activeViews = new Set(active);
    }
    if (p.views?.order) {
      const validViews: ChartView[] = ['signals', 'timeline', 'interval'];
      const order = p.views.order.filter(v => validViews.includes(v));
      if (order.length === 3) this.viewOrder = order;
    }

    if (p.buffer) {
      if (p.buffer.mode) this.bufferMode = p.buffer.mode;
      if (p.buffer.samples != null) this.bufferSamples = p.buffer.samples;
      if (p.buffer.seconds != null) this.bufferSeconds = p.buffer.seconds;
    }

    const knownSignalKeys = new Set(this.allSeries.map(s => s.key));
    const knownTimingKeys = new Set(this.messageTimingLabels);

    if (p.signals?.panels) {
      const panels: ChartPanel[] = [];
      for (const keys of p.signals.panels) {
        const matched = keys.filter(k => knownSignalKeys.has(k));
        if (matched.length > 0) {
          panels.push({ id: `p${this.nextPanelId++}`, keys: matched });
        }
      }
      this.chartPanels = panels;
    }

    if (p.intervals?.panels) {
      const panels: ChartPanel[] = [];
      for (const keys of p.intervals.panels) {
        const matched = keys.filter(k => knownTimingKeys.has(k));
        if (matched.length > 0) {
          panels.push({ id: `ip${this.nextPanelId++}`, keys: matched });
        }
      }
      this.intervalPanels = panels;
    }

    this.pendingLayoutConfig = config;
    this.requestRender(true);
  }

  autoApplyPendingLayout() {
    const config = this.pendingLayoutConfig;
    if (!config?.plot?.signals?.panels && !config?.plot?.intervals?.panels) return;

    const knownSignalKeys = new Set(this.allSeries.map(s => s.key));
    const currentPanelKeys = new Set(this.chartPanels.flatMap(p => p.keys));
    let signalChanged = false;

    if (config.plot.signals?.panels) {
      for (const keys of config.plot.signals.panels) {
        const matched = keys.filter(k => knownSignalKeys.has(k) && !currentPanelKeys.has(k));
        if (matched.length > 0) {
          const existingPanel = this.chartPanels.find(p =>
            keys.some(k => p.keys.includes(k))
          );
          if (existingPanel) {
            existingPanel.keys.push(...matched);
          } else {
            this.chartPanels = [...this.chartPanels, { id: `p${this.nextPanelId++}`, keys: matched }];
          }
          matched.forEach(k => currentPanelKeys.add(k));
          signalChanged = true;
        }
      }
    }

    const knownTimingKeys = new Set(this.messageTimingLabels);
    const currentIntervalKeys = new Set(this.intervalPanels.flatMap(p => p.keys));
    let intervalChanged = false;

    if (config.plot.intervals?.panels) {
      for (const keys of config.plot.intervals.panels) {
        const matched = keys.filter(k => knownTimingKeys.has(k) && !currentIntervalKeys.has(k));
        if (matched.length > 0) {
          const existingPanel = this.intervalPanels.find(p =>
            keys.some(k => p.keys.includes(k))
          );
          if (existingPanel) {
            existingPanel.keys.push(...matched);
          } else {
            this.intervalPanels = [...this.intervalPanels, { id: `ip${this.nextPanelId++}`, keys: matched }];
          }
          matched.forEach(k => currentIntervalKeys.add(k));
          intervalChanged = true;
        }
      }
    }

    return signalChanged || intervalChanged;
  }

  clearData() {
    this.resetData();
    this.requestRender(true);
  }

  // Load a candump .log or ZLG USBCANFD .csv export, populate the textarea, and run analyze().
  async loadFromFile(file: File) {
    const text = await file.text();
    const head = text.slice(0, 256);
    const isZlgCsv = /^WRITE_TIME\s*,\s*GROUP_ID/i.test(head)
      || (file.name.toLowerCase().endsWith('.csv') && /MAKE_CAN_ID\(HEX\)/i.test(head));
    this.input = isZlgCsv ? zlgCsvToCandump(text) : text;
    this.analyze();
    if (isZlgCsv && this.input === '') {
      this.status = `Failed to parse ZLG CSV (${file.name})`;
    }
  }

  // --- Clear raw log (from UI) ---
  clearRawLog() {
    this.rawFrameLog = [];
    this.rawFrameCount = 0;
    this.rawLogVersion++;
  }
}

export const plotStore = new PlotStore();
