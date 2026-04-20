<script lang="ts">
  import { codecStore } from '$lib/codec-store.svelte';
  import { parseCandump } from '$lib/codec';
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

  // ---- State ----

  let input = $state('');
  let allSeries = $state<SignalSeries[]>([]);
  let selected = $state<Set<string>>(new Set());
  let status = $state('');
  let chartCanvases = $state<Map<string, HTMLCanvasElement>>(new Map());
  let chartInstances = new Map<string, Chart>();

  // ---- Analysis ----

  function isMavlinkCanId(canId: number): boolean {
    return (canId & 0x10000) !== 0;
  }

  function analyze() {
    const lines = input.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { allSeries = []; status = ''; return; }

    const codec = codecStore.codec;
    const seriesMap = new Map<string, SignalSeries>();
    let firstTs: number | null = null;
    let lineIndex = 0;

    // Group consecutive lines with the same MAVLink CAN ID for multi-frame reassembly
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
        // MAVLink group
        timestamp = group.timestamps[0] ?? undefined;
        try {
          const res = group.datas.length === 1
            ? codec.smartDecode(group.canId, group.datas[0])
            : codec.smartDecodeMultiFrame(group.canId, group.datas);
          if (res) { decoded = res.decoded; mavlink = res.mavlink; }
        } catch { /* skip bad frames */ }
      } else {
        // Standard CAN line
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

      // Determine time value
      if (timestamp !== undefined) {
        if (firstTs === null) firstTs = timestamp;
        timestamp = timestamp - firstTs;
      } else {
        timestamp = lineIndex;
      }

      // Build group label
      const groupLabel = mavlink
        ? `${mavlink.sys_id}.${mavlink.comp_id} / ${decoded.name}`
        : decoded.name;

      for (const sig of decoded.signals) {
        // Skip bitfield signals
        if (sig.bitfield_flags) continue;
        const val = typeof sig.physical_value === 'number' ? sig.physical_value : NaN;
        if (isNaN(val)) continue;

        const key = `${groupLabel} / ${sig.name}`;
        let series = seriesMap.get(key);
        if (!series) {
          series = { key, group: groupLabel, signal: sig.name, unit: sig.unit, samples: [] };
          seriesMap.set(key, series);
        }
        series.samples.push({ time: timestamp, value: val });
      }
      lineIndex++;
    }

    allSeries = Array.from(seriesMap.values()).sort((a, b) => a.key.localeCompare(b.key));

    // Auto-select all signals if not too many
    if (allSeries.length <= 12) {
      selected = new Set(allSeries.map(s => s.key));
    } else {
      selected = new Set();
    }

    status = `${allSeries.length} signals found from ${groups.length} frames`;
    renderCharts();
  }

  // ---- Signal selection ----

  function toggleSignal(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selected = next;
    renderCharts();
  }

  function selectAll() {
    selected = new Set(allSeries.map(s => s.key));
    renderCharts();
  }

  function selectNone() {
    selected = new Set();
    renderCharts();
  }

  // ---- Chart rendering ----

  const CHART_COLORS = [
    '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
    '#39d2c0', '#f78166', '#7ee787', '#a5d6ff', '#ffa657',
  ];

  function renderCharts() {
    // Destroy old charts
    for (const [key, chart] of chartInstances) {
      chart.destroy();
    }
    chartInstances.clear();

    // Need to wait for DOM to update with new canvases
    requestAnimationFrame(() => {
      const selectedSeries = allSeries.filter(s => selected.has(s.key));
      for (let i = 0; i < selectedSeries.length; i++) {
        const series = selectedSeries[i];
        const canvas = document.getElementById(`chart-${i}`) as HTMLCanvasElement | null;
        if (!canvas) continue;

        const color = CHART_COLORS[i % CHART_COLORS.length];
        const showPoints = series.samples.length <= 100;

        const chart = new Chart(canvas, {
          type: 'line',
          data: {
            datasets: [{
              label: `${series.signal}${series.unit ? ` (${series.unit})` : ''}`,
              data: series.samples.map(s => ({ x: s.time, y: s.value })),
              borderColor: color,
              backgroundColor: color + '20',
              borderWidth: 1.5,
              pointRadius: showPoints ? 3 : 0,
              pointHoverRadius: 4,
              fill: true,
              tension: 0,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  title: (items) => `t = ${items[0].parsed.x.toFixed(3)}s`,
                  label: (item) => `${series.signal}: ${item.parsed.y}${series.unit ? ' ' + series.unit : ''}`,
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
                  text: series.unit || 'value',
                  color: '#8b949e',
                  font: { size: 11 },
                },
                grid: { color: '#2d354833' },
                ticks: { color: '#8b949e', font: { size: 11 } },
              },
            },
          },
        });
        chartInstances.set(series.key, chart);
      }
    });
  }

  // ---- Export ----

  function savePng() {
    const selectedSeries = allSeries.filter(s => selected.has(s.key));
    for (let i = 0; i < selectedSeries.length; i++) {
      const canvas = document.getElementById(`chart-${i}`) as HTMLCanvasElement | null;
      if (!canvas) continue;
      const link = document.createElement('a');
      link.download = `${selectedSeries[i].signal}.png`;
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
</script>

<div class="container">
  <div class="page-header">
    <h1>Plot</h1>
    <p>Paste candump log lines to plot signal values over time</p>
  </div>

  <div class="card">
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
  </div>

  {#if allSeries.length > 0}
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <strong style="font-size: 14px;">Signals</strong>
        <div style="display: flex; gap: 8px;">
          <button class="btn-sm" onclick={selectAll}>All</button>
          <button class="btn-sm" onclick={selectNone}>None</button>
          {#if selected.size > 0}
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
                  <span class="chip-count">{s.samples.length}</span>
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>

    {#if selected.size > 0}
      <div class="chart-stack">
        {#each allSeries.filter(s => selected.has(s.key)) as series, i}
          <div class="chart-card">
            <div class="chart-header">
              <span class="chart-title">{series.key}</span>
              <span class="chart-samples">{series.samples.length} samples</span>
            </div>
            <div class="chart-container">
              <canvas id="chart-{i}"></canvas>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
