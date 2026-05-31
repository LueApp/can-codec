import { codecStore } from './codec-store.svelte';
import { parseCandump, MavlinkReassembler, type MavlinkBuf } from './codec';
import { busStore } from './bus-store.svelte';
import { evalExpr } from './sequence-store.svelte';
import type { RawFrame } from './websocket-client.svelte';
import type { DecodedMessage, DecodedSignal, Message, MavlinkInfo } from './types';
import type {
  FrameRef, SignalSample, SignalSeries, ChartPanel, MessageTimingEntry,
  InputMode, ChartView, BufferMode, PlotLayoutConfig, DerivedSignal,
} from './plot-types';
import yaml from 'js-yaml';

// Group label used for all derived (formula) signals. Sorted to the end of
// the signal list so source signals stay grouped at the top.
export const DERIVED_GROUP = 'Formulas';

const DERIVED_STORAGE_KEY = 'cancodec_derived_signals_v1';

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
  csvDumpActive = $state(false);
  csvDumpRowCount = $state(0);
  csvDumpSelectedOnly = $state(false);
  bufferMode = $state<BufferMode>('samples');
  bufferSamples = $state(5000);
  bufferSeconds = $state(60);
  pendingLayoutConfig = $state<PlotLayoutConfig | null>(null);
  derivedSignals = $state<DerivedSignal[]>([]);
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
  private _nextDerivedId = 0;
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
  csvDumpWriter: FileSystemWritableFileStream | null = null;

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
    // Preserve chart panels that reference derived (formula) signals — those
    // survive across data resets because the formula definitions do. Include
    // per-node expanded keys, though after the reset the expansion may shrink
    // (no source signals means no nodes discoverable).
    const derivedKeys = new Set<string>();
    for (const d of this.derivedSignals) {
      if (d.perNode) {
        for (const n of this.perNodeSeriesNames(d)) derivedKeys.add(`${DERIVED_GROUP} / ${n}`);
      } else {
        derivedKeys.add(this.derivedKey(d));
      }
    }
    this.chartPanels = this.chartPanels
      .map(p => ({ ...p, keys: p.keys.filter(k => derivedKeys.has(k)) }))
      .filter(p => p.keys.length > 0);
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
    // Keep user-defined formulas across resets — re-add their virtual entries.
    this._syncDerivedToAllSeries();
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
    this.stopCsvDump();
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

  async startCsvDump() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const handle = await (window as any).showSaveFilePicker({
      suggestedName: `plot_live_${ts}.csv`,
      types: [{ description: 'CSV files', accept: { 'text/csv': ['.csv'] } }],
    });
    this.csvDumpWriter = await handle.createWritable();
    await this.csvDumpWriter!.write('﻿t_rel,t_abs,group,signal,value,unit,frame_id,frame_data,direction\n');
    this.csvDumpRowCount = 0;
    this.csvDumpActive = true;
  }

  async stopCsvDump() {
    if (!this.csvDumpWriter) return;
    const w = this.csvDumpWriter;
    this.csvDumpWriter = null;
    this.csvDumpActive = false;
    await w.close();
  }

  writeCsvSample(groupLabel: string, signalName: string, value: number, unit: string, time: number, frame: FrameRef) {
    if (!this.csvDumpWriter) return;
    if (this.csvDumpSelectedOnly) {
      const key = `${groupLabel} / ${signalName}`;
      if (!this.selected.has(key)) return;
    }
    const csvEsc = (s: string) => /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const idHex = '0x' + frame.id.toString(16).toUpperCase().padStart(frame.id > 0x7FF ? 8 : 3, '0');
    const dataHex = frame.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    const row = `${time},${frame.timestamp},${csvEsc(groupLabel)},${csvEsc(signalName)},${value},${csvEsc(unit)},${idHex},${csvEsc(dataHex)},${frame.direction ?? ''}\n`;
    this.csvDumpWriter.write(row);
    this.csvDumpRowCount++;
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
        this.allSeries = [...this.allSeries, meta];
        this._sortAllSeries();
        newSeriesAdded = true;
      }
      samples.push({ time, value: val, frame });

      if (this.csvDumpWriter) this.writeCsvSample(groupLabel, sig.name, val, sig.unit, time, frame);

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
    return this._resolveSamples(key, new Set<string>());
  }

  /** Resolve samples for any key. Sources read from store; derived signals
   *  recurse via computeDerivedSamples. `visiting` tracks the in-progress
   *  derived-id stack so cycles bail out with empty samples instead of
   *  infinite recursion. */
  private _resolveSamples(key: string, visiting: Set<string>): SignalSample[] {
    // 1. Non-perNode derived: direct match by full key.
    const direct = this.derivedSignals.find(d => !d.perNode && this.derivedKey(d) === key);
    if (direct) {
      if (visiting.has(direct.id)) return [];
      return this.computeDerivedSamples(direct, visiting);
    }
    // 2. Per-node derived: parse the node out of "Formulas / <name>_N<n>".
    const perNode = this._matchPerNodeKey(key);
    if (perNode) {
      const visitKey = `${perNode.def.id}@${perNode.node}`;
      if (visiting.has(visitKey)) return [];
      const next = new Set(visiting);
      next.add(visitKey);
      const realVars: Record<string, string> = {};
      for (const [v, tpl] of Object.entries(perNode.def.vars)) {
        realVars[v] = tpl.includes('N*') ? tpl.replace(/N\*/g, `N${perNode.node}`) : tpl;
      }
      return this._computeSamples(perNode.def.expr, realVars, next);
    }
    // 3. Source.
    return this._getSourceSamples(key);
  }

  private _getSourceSamples(key: string): SignalSample[] {
    if (this.mode === 'live') return this.liveSampleStore.get(key) ?? [];
    const s = this.allSeries.find(s => s.key === key);
    return s && s.group !== DERIVED_GROUP ? s.samples : [];
  }

  /** Sample count for any series key (source or derived). Used by signal chips. */
  getSampleCount(key: string): number {
    if (this.derivedSignals.find(d => this.derivedKey(d) === key && !d.perNode)
        || this._matchPerNodeKey(key)) {
      return this.getSamples(key).length;
    }
    if (this.mode === 'live') return this.liveSampleCounts[key] ?? 0;
    return this.allSeries.find(s => s.key === key)?.samples.length ?? 0;
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
    return panel.keys.reduce((sum, k) => sum + this.getSampleCount(k), 0);
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
    for (const d of this.derivedSignals) {
      if (d.perNode) {
        for (const name of this.perNodeSeriesNames(d)) {
          const k = `${DERIVED_GROUP} / ${name}`;
          counts[k] = this.getSamples(k).length;
        }
      } else {
        counts[this.derivedKey(d)] = this.computeDerivedSamples(d).length;
      }
    }
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
    this._sortAllSeries();
    const sourceSeriesCount = this.allSeries.filter(s => s.group !== DERIVED_GROUP).length;
    if (sourceSeriesCount <= 12) {
      const existingKeys = new Set(this.chartPanels.flatMap(p => p.keys));
      const newPanels = this.allSeries
        .filter(s => s.group !== DERIVED_GROUP && !existingKeys.has(s.key))
        .map(s => ({ id: `p${this.nextPanelId++}`, keys: [s.key] }));
      this.chartPanels = [...this.chartPanels, ...newPanels];
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
        formulas: this.derivedSignals.map(d => ({ ...d, vars: { ...d.vars } })),
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

    if (Array.isArray(p.formulas)) {
      const incoming: DerivedSignal[] = [];
      const existingNames = new Set<string>();
      for (const f of p.formulas) {
        if (!f || typeof f.name !== 'string' || typeof f.expr !== 'string') continue;
        if (existingNames.has(f.name)) continue;
        if (this.validateExpr(f.expr) !== null) continue;
        existingNames.add(f.name);
        const id = `d${this._nextDerivedId++}`;
        const di: DerivedSignal = {
          id,
          name: f.name,
          expr: f.expr,
          unit: typeof f.unit === 'string' ? f.unit : '',
          vars: (f.vars && typeof f.vars === 'object') ? { ...f.vars } : {},
        };
        if (f.perNode) di.perNode = true;
        incoming.push(di);
      }
      // Merge with existing — replace by name match.
      const kept = this.derivedSignals.filter(d => !existingNames.has(d.name));
      this.derivedSignals = [...kept, ...incoming];
      this._syncDerivedToAllSeries();
      this._persistDerivedSignals();
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

  // --- Derived (formula) signals ---
  derivedKey(d: DerivedSignal): string {
    return `${DERIVED_GROUP} / ${d.name}`;
  }

  /** Identifiers used in `expr` that the user must bind to source signals.
   *  Hex literals like 0x10 contain no leading identifier so the regex is safe. */
  extractVarsFromExpr(expr: string): string[] {
    const out = new Set<string>();
    const re = /[a-zA-Z_][a-zA-Z0-9_]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(expr)) !== null) {
      // Filter out hex prefix matches when they follow "0x" — the tokenizer
      // strips them, but our naive regex would still pick up "x10" if standalone.
      // No-op: bare "x10" is a valid identifier and the user can use it.
      out.add(m[0]);
    }
    return Array.from(out);
  }

  /** Builds the SignalSeries shells for derived signals so they appear in the
   *  picker / panels. Samples stay empty — `getSamples()` computes on demand.
   *  Per-node formulas expand into one entry per discovered node (e.g.
   *  delta_N1, delta_N2…). */
  private _derivedAsSeries(): SignalSeries[] {
    const out: SignalSeries[] = [];
    for (const d of this.derivedSignals) {
      if (d.perNode) {
        for (const name of this.perNodeSeriesNames(d)) {
          out.push({
            key: `${DERIVED_GROUP} / ${name}`,
            group: DERIVED_GROUP,
            signal: name,
            unit: d.unit,
            samples: [],
          });
        }
      } else {
        out.push({
          key: this.derivedKey(d),
          group: DERIVED_GROUP,
          signal: d.name,
          unit: d.unit,
          samples: [],
        });
      }
    }
    return out;
  }

  /** Rewrite allSeries so source signals come first (sorted), derived at the bottom. */
  private _sortAllSeries() {
    const sources = this.allSeries.filter(s => s.group !== DERIVED_GROUP);
    sources.sort((a, b) => a.key.localeCompare(b.key));
    this.allSeries = [...sources, ...this._derivedAsSeries()];
  }

  /** Replace derived placeholder series in allSeries with fresh ones from
   *  this.derivedSignals. Idempotent. */
  private _syncDerivedToAllSeries() {
    const sources = this.allSeries.filter(s => s.group !== DERIVED_GROUP);
    this.allSeries = [...sources, ...this._derivedAsSeries()];
  }

  private _persistDerivedSignals() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(DERIVED_STORAGE_KEY, JSON.stringify(this.derivedSignals));
    } catch { /* quota */ }
  }

  /** Load saved derived signals on first access. Called from page onMount. */
  loadDerivedSignalsFromStorage() {
    if (typeof localStorage === 'undefined') return;
    if (this.derivedSignals.length > 0) return;
    try {
      const raw = localStorage.getItem(DERIVED_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      const valid: DerivedSignal[] = [];
      for (const item of parsed) {
        if (item && typeof item === 'object'
            && typeof (item as DerivedSignal).id === 'string'
            && typeof (item as DerivedSignal).name === 'string'
            && typeof (item as DerivedSignal).expr === 'string'
            && (item as DerivedSignal).vars && typeof (item as DerivedSignal).vars === 'object') {
          const d = item as DerivedSignal;
          const entry: DerivedSignal = { id: d.id, name: d.name, expr: d.expr, unit: d.unit ?? '', vars: { ...d.vars } };
          if (d.perNode) entry.perNode = true;
          valid.push(entry);
          const m = d.id.match(/^d(\d+)$/);
          if (m) this._nextDerivedId = Math.max(this._nextDerivedId, Number(m[1]) + 1);
        }
      }
      this.derivedSignals = valid;
      this._syncDerivedToAllSeries();
    } catch { /* malformed */ }
  }

  /** True if any source key in `vars` is a derived signal whose dependency
   *  chain reaches `formulaId`. Use to reject cycle-introducing saves. */
  private _wouldCycle(formulaId: string | null, vars: Record<string, string>): boolean {
    for (const sourceKey of Object.values(vars)) {
      if (!sourceKey) continue;
      const child = this.derivedSignals.find(d => this.derivedKey(d) === sourceKey);
      if (!child) continue;
      if (formulaId !== null && child.id === formulaId) return true;
      if (formulaId !== null && this._reaches(child, formulaId, new Set())) return true;
    }
    return false;
  }

  private _reaches(start: DerivedSignal, targetId: string, seen: Set<string>): boolean {
    if (start.id === targetId) return true;
    if (seen.has(start.id)) return false;
    seen.add(start.id);
    for (const sourceKey of Object.values(start.vars)) {
      const child = this.derivedSignals.find(d => this.derivedKey(d) === sourceKey);
      if (child && this._reaches(child, targetId, seen)) return true;
    }
    return false;
  }

  /** Probe-parses `expr` with all referenced identifiers bound to 0. Returns
   *  the error message on failure, or null on success. */
  validateExpr(expr: string): string | null {
    const trimmed = expr.trim();
    if (!trimmed) return 'expression: empty';
    try {
      const probe: Record<string, number> = {};
      for (const v of this.extractVarsFromExpr(trimmed)) probe[v] = 0;
      evalExpr(trimmed, probe);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  addDerivedSignal(opts: { name: string; expr: string; vars: Record<string, string>; unit?: string; perNode?: boolean }): { ok: true; def: DerivedSignal } | { ok: false; error: string } {
    const name = opts.name.trim();
    const expr = opts.expr.trim();
    if (!name) return { ok: false, error: 'name required' };
    if (!expr) return { ok: false, error: 'expression required' };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: false, error: 'name must be a valid identifier (letters, digits, underscore; not starting with a digit)' };
    if (this.derivedSignals.some(d => d.name === name)) return { ok: false, error: 'name already used' };
    const exprErr = this.validateExpr(expr);
    if (exprErr) return { ok: false, error: exprErr };
    const vars: Record<string, string> = {};
    for (const v of this.extractVarsFromExpr(expr)) {
      if (opts.vars[v]) vars[v] = opts.vars[v];
    }
    // For a brand-new formula there's no id yet, so no existing formula can
    // depend on it — cycles are impossible at add time. Skip the check.
    const id = `d${this._nextDerivedId++}`;
    const def: DerivedSignal = { id, name, expr, unit: (opts.unit ?? '').trim(), vars };
    if (opts.perNode) def.perNode = true;
    this.derivedSignals = [...this.derivedSignals, def];
    this._syncDerivedToAllSeries();
    this._persistDerivedSignals();
    // Auto-plot: one panel for the formula (or one per discovered node, for
    // per-node formulas).
    const keys = def.perNode
      ? this.perNodeSeriesNames(def).map(n => `${DERIVED_GROUP} / ${n}`)
      : [this.derivedKey(def)];
    const newPanels = keys.map(k => ({ id: `p${this.nextPanelId++}`, keys: [k] }));
    this.chartPanels = [...this.chartPanels, ...newPanels];
    this.requestRender(true);
    return { ok: true, def };
  }

  updateDerivedSignal(id: string, opts: { name?: string; expr?: string; vars?: Record<string, string>; unit?: string; perNode?: boolean }): { ok: true } | { ok: false; error: string } {
    const idx = this.derivedSignals.findIndex(d => d.id === id);
    if (idx < 0) return { ok: false, error: 'not found' };
    const cur = this.derivedSignals[idx];
    const name = (opts.name ?? cur.name).trim();
    const expr = (opts.expr ?? cur.expr).trim();
    const unit = (opts.unit ?? cur.unit).trim();
    const perNode = opts.perNode ?? cur.perNode ?? false;
    if (!name) return { ok: false, error: 'name required' };
    if (!expr) return { ok: false, error: 'expression required' };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: false, error: 'name must be a valid identifier (letters, digits, underscore; not starting with a digit)' };
    if (this.derivedSignals.some(d => d.id !== id && d.name === name)) return { ok: false, error: 'name already used' };
    const exprErr = this.validateExpr(expr);
    if (exprErr) return { ok: false, error: exprErr };
    const referenced = this.extractVarsFromExpr(expr);
    const incomingVars = opts.vars ?? cur.vars;
    const vars: Record<string, string> = {};
    for (const v of referenced) {
      if (incomingVars[v]) vars[v] = incomingVars[v];
    }
    if (this._wouldCycle(id, vars)) return { ok: false, error: 'binding would create a formula cycle' };
    const next: DerivedSignal = { ...cur, name, expr, unit, vars };
    if (perNode) next.perNode = true; else delete next.perNode;
    const oldKeys = cur.perNode
      ? this.perNodeSeriesNames(cur).map(n => `${DERIVED_GROUP} / ${n}`)
      : [this.derivedKey(cur)];
    const newKeys = next.perNode
      ? this.perNodeSeriesNames(next).map(n => `${DERIVED_GROUP} / ${n}`)
      : [this.derivedKey(next)];
    // If the only change is the formula name (same per-node-ness and same
    // node count), rename panel keys 1:1 to preserve user's panel layout.
    // Otherwise drop the formula's old panels and add fresh ones.
    if (cur.perNode === next.perNode && oldKeys.length === newKeys.length && oldKeys.length > 0) {
      this.chartPanels = this.chartPanels.map(p => ({
        ...p,
        keys: p.keys.map(k => {
          const i = oldKeys.indexOf(k);
          return i >= 0 ? newKeys[i] : k;
        }),
      }));
    } else {
      const oldSet = new Set(oldKeys);
      this.chartPanels = this.chartPanels
        .map(p => ({ ...p, keys: p.keys.filter(k => !oldSet.has(k)) }))
        .filter(p => p.keys.length > 0);
      const addPanels = newKeys.map(k => ({ id: `p${this.nextPanelId++}`, keys: [k] }));
      this.chartPanels = [...this.chartPanels, ...addPanels];
    }
    this.derivedSignals = this.derivedSignals.map(d => d.id === id ? next : d);
    this._syncDerivedToAllSeries();
    this._persistDerivedSignals();
    this.requestRender(true);
    return { ok: true };
  }

  removeDerivedSignal(id: string): boolean {
    const idx = this.derivedSignals.findIndex(d => d.id === id);
    if (idx < 0) return false;
    const def = this.derivedSignals[idx];
    const keys = new Set(
      def.perNode
        ? this.perNodeSeriesNames(def).map(n => `${DERIVED_GROUP} / ${n}`)
        : [this.derivedKey(def)]
    );
    this.derivedSignals = this.derivedSignals.filter(d => d.id !== id);
    this.chartPanels = this.chartPanels
      .map(p => ({ ...p, keys: p.keys.filter(k => !keys.has(k)) }))
      .filter(p => p.keys.length > 0);
    this._syncDerivedToAllSeries();
    this._persistDerivedSignals();
    this.requestRender(true);
    return true;
  }

  /** Compute samples for a non-perNode derived signal. (Per-node templates
   *  produce ghost SignalSeries entries whose getSamples calls _resolveSamples
   *  directly with substituted vars.) Cycles bail to empty. */
  computeDerivedSamples(def: DerivedSignal, visiting?: Set<string>): SignalSample[] {
    if (def.perNode) return [];
    const next = new Set(visiting ?? []);
    next.add(def.id);
    return this._computeSamples(def.expr, def.vars, next);
  }

  /** Shared compute: evaluate `expr` over var bindings, merging sample streams
   *  by sample-and-hold. Single-var → map; multi-var → sorted-event merge. */
  private _computeSamples(expr: string, vars: Record<string, string>, visiting: Set<string>): SignalSample[] {
    const varNames = Object.keys(vars);
    if (varNames.length === 0) return [];
    for (const v of varNames) {
      if (!vars[v]) return [];
    }
    const sources: Record<string, SignalSample[]> = {};
    for (const v of varNames) {
      sources[v] = this._resolveSamples(vars[v], visiting);
      if (sources[v].length === 0) return [];
    }
    if (varNames.length === 1) {
      const v = varNames[0];
      const out: SignalSample[] = [];
      for (const s of sources[v]) {
        const scope: Record<string, number> = { [v]: s.value };
        try {
          const val = evalExpr(expr, scope);
          if (Number.isFinite(val)) out.push({ time: s.time, value: val, frame: s.frame });
        } catch { /* skip */ }
      }
      return out;
    }
    type Event = { time: number; v: string; value: number; frame: FrameRef };
    const events: Event[] = [];
    for (const v of varNames) {
      for (const s of sources[v]) {
        events.push({ time: s.time, v, value: s.value, frame: s.frame });
      }
    }
    events.sort((a, b) => a.time - b.time);
    const cur: Record<string, number> = {};
    const out: SignalSample[] = [];
    let bound = 0;
    for (const e of events) {
      if (!(e.v in cur)) bound++;
      cur[e.v] = e.value;
      if (bound < varNames.length) continue;
      try {
        const val = evalExpr(expr, cur);
        if (Number.isFinite(val)) out.push({ time: e.time, value: val, frame: e.frame });
      } catch { /* skip */ }
    }
    return out;
  }

  /** Find all node IDs N such that every "N*"-templated binding in `def.vars`
   *  resolves to an existing signal key. Static (non-N*) bindings are not
   *  used for node discovery — they apply unchanged to every per-node instance. */
  private _discoverNodesForFormula(def: DerivedSignal): number[] {
    const templated = Object.values(def.vars).filter(tpl => tpl && tpl.includes('N*'));
    if (templated.length === 0) return [];
    const perVarNodes: Set<number>[] = templated.map(tpl => this._matchTemplate(tpl));
    if (perVarNodes.some(s => s.size === 0)) return [];
    const result = new Set(perVarNodes[0]);
    for (let i = 1; i < perVarNodes.length; i++) {
      for (const n of [...result]) if (!perVarNodes[i].has(n)) result.delete(n);
    }
    return [...result].sort((a, b) => a - b);
  }

  /** All node IDs N for which `template` (with literal "N*") matches an existing
   *  source signal key. */
  private _matchTemplate(template: string): Set<number> {
    const out = new Set<number>();
    if (!template.includes('N*')) return out;
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + template.split('N*').map(escape).join('N(\\d+)') + '$');
    for (const s of this.allSeries) {
      if (s.group === DERIVED_GROUP) continue;
      const m = s.key.match(re);
      if (m) out.add(parseInt(m[1], 10));
    }
    return out;
  }

  /** If `key` is "Formulas / <name>_N<n>" matching a per-node template, return
   *  the template definition and the node number. */
  private _matchPerNodeKey(key: string): { def: DerivedSignal; node: number } | null {
    const prefix = `${DERIVED_GROUP} / `;
    if (!key.startsWith(prefix)) return null;
    const tail = key.slice(prefix.length);
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const d of this.derivedSignals) {
      if (!d.perNode) continue;
      const m = tail.match(new RegExp(`^${escape(d.name)}_N(\\d+)$`));
      if (m) return { def: d, node: parseInt(m[1], 10) };
    }
    return null;
  }

  perNodeSeriesNames(def: DerivedSignal): string[] {
    if (!def.perNode) return [];
    return this._discoverNodesForFormula(def).map(n => `${def.name}_N${n}`);
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
