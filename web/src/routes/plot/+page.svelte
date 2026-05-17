<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { codecStore } from '$lib/codec-store.svelte';
  import { plotStore } from '$lib/plot-store.svelte';
  import { t } from '$lib/i18n.svelte';
  import type { SignalSeries, ChartPanel, ChartView, FrameRef } from '$lib/plot-types';
  import yaml from 'js-yaml';
  import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler, ScatterController } from 'chart.js';
  import zoomPlugin from 'chartjs-plugin-zoom';
  import { downloadServerScript as downloadServer } from '$lib/server-script';

  Chart.register(LineController, ScatterController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler, zoomPlugin);

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

  // Plugin-driven zoom config:
  //  - Plugin wheel is OFF; we run a custom wheel handler (see attachChartInteractions)
  //    so modifier keys can switch between x / y / xy zoom dynamically.
  //  - Pinch stays xy (single config for two-finger gestures).
  //  - Left-drag pans x; Shift+drag draws a box-zoom rectangle.
  //  - onPan / onZoom call noteUserInteraction so live mode stops auto-fitting.
  const onZoomOrPanStart = (): undefined => {
    plotStore.noteUserInteraction();
    return undefined;
  };

  const zoomOptions = {
    pan: {
      enabled: true,
      mode: 'x' as const,
      threshold: 4,
      onPanStart: onZoomOrPanStart,
    },
    zoom: {
      wheel: { enabled: false },
      pinch: { enabled: true },
      drag: {
        enabled: true,
        modifierKey: 'shift' as const,
        backgroundColor: 'rgba(88, 166, 255, 0.15)',
        borderColor: 'rgba(88, 166, 255, 0.5)',
        borderWidth: 1,
      },
      mode: 'xy' as const,
      onZoomStart: onZoomOrPanStart,
    },
  };

  function attachChartInteractions(chart: Chart, canvas: HTMLCanvasElement) {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const focalPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const speed = 0.12;
      const factor = e.deltaY < 0 ? 1 + speed : 1 / (1 + speed);
      let x = 1, y = 1;
      if (e.shiftKey) y = factor;
      else if (e.ctrlKey || e.metaKey) { x = factor; y = factor; }
      else x = factor;
      (chart as any).zoom({ x, y, focalPoint });
      plotStore.noteUserInteraction();
    };
    const onDblClick = (e: MouseEvent) => {
      e.preventDefault();
      chart.resetZoom();
      plotStore.clearUserZoom();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    (chart as any).__detachInteractions = () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
    };
  }

  function detachChartInteractions(chart: Chart) {
    const fn = (chart as any).__detachInteractions as (() => void) | undefined;
    fn?.();
  }

  function fitAllCharts(mode: 'x' | 'y' | 'xy') {
    const fit = (chart: Chart) => (chart as any).resetZoom('none', mode);
    for (const [, c] of chartInstances) fit(c);
    if (timelineChart) fit(timelineChart);
    for (const [, c] of intervalInstances) fit(c);
    if (mode === 'xy') plotStore.clearUserZoom();
  }

  const MARKER_COLORS = ['#d29922', '#39d2c0'];

  function originForView(isTimelineView: boolean): number {
    return isTimelineView || plotStore.applyTimingToAllViews ? plotStore.timelineOrigin : 0;
  }

  function markerPluginOpts(isTimelineView: boolean) {
    return { isTimelineView };
  }

  function formatDelta(seconds: number): string {
    const abs = Math.abs(seconds);
    if (abs >= 1) return `${seconds.toFixed(3)} s`;
    if (abs >= 0.001) return `${(seconds * 1000).toFixed(2)} ms`;
    return `${(seconds * 1_000_000).toFixed(1)} µs`;
  }

  const markerPlugin = {
    id: 'timelineMarkers',
    afterDatasetsDraw(chart: Chart, _args: unknown, opts: { isTimelineView?: boolean } | undefined) {
      const isTimelineView = opts?.isTimelineView ?? false;
      if (!isTimelineView && !plotStore.applyTimingToAllViews) return;

      const markers = plotStore.timelineMarkers;
      if (markers.length === 0) return;

      const xScale = chart.scales.x;
      if (!xScale) return;
      const ctx = chart.ctx;
      const { top, bottom, left, right } = chart.chartArea;
      const origin = plotStore.timelineOrigin;
      const xs: number[] = [];

      ctx.save();
      for (let i = 0; i < markers.length; i++) {
        const x = xScale.getPixelForValue(markers[i].time - origin);
        xs.push(x);
        if (x < left || x > right) continue;
        ctx.strokeStyle = MARKER_COLORS[i];
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = MARKER_COLORS[i];
        ctx.font = "bold 12px 'JetBrains Mono', monospace";
        ctx.fillText(i === 0 ? 'A' : 'B', x + 4, top + 14);
      }

      if (markers.length === 2 && xs[0] >= left && xs[0] <= right && xs[1] >= left && xs[1] <= right) {
        const x1 = xs[0], x2 = xs[1];
        const xMid = (x1 + x2) / 2;
        const delta = markers[1].time - markers[0].time;
        const deltaText = `Δt = ${formatDelta(delta)}`;
        ctx.font = "bold 13px -apple-system, system-ui, sans-serif";
        const w = ctx.measureText(deltaText).width;
        const boxX = Math.min(Math.max(xMid - w / 2 - 8, left + 4), right - w - 20);
        ctx.fillStyle = 'rgba(15, 20, 25, 0.92)';
        ctx.strokeStyle = '#30363d';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(boxX, top + 24, w + 16, 22);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#e6edf3';
        ctx.fillText(deltaText, boxX + 8, top + 39);

        const yArrow = top + 56;
        const lx = Math.min(x1, x2);
        const rx = Math.max(x1, x2);
        ctx.strokeStyle = '#8b949e';
        ctx.fillStyle = '#8b949e';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lx + 6, yArrow);
        ctx.lineTo(rx - 6, yArrow);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(lx, yArrow);
        ctx.lineTo(lx + 6, yArrow - 4);
        ctx.lineTo(lx + 6, yArrow + 4);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(rx, yArrow);
        ctx.lineTo(rx - 6, yArrow - 4);
        ctx.lineTo(rx - 6, yArrow + 4);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    },
  };

  Chart.register(markerPlugin);

  // ---- Chart rendering (full rebuild) ----

  function renderCurrentView() {
    if (plotStore.activeViews.has('signals')) renderCharts();
    if (plotStore.activeViews.has('timeline')) renderTimeline();
    if (plotStore.activeViews.has('interval')) renderIntervalCharts();
  }

  function renderCharts() {
    for (const [, chart] of chartInstances) { detachChartInteractions(chart); chart.destroy(); }
    chartInstances.clear();

    requestAnimationFrame(() => {
      for (const panel of plotStore.chartPanels) {
        const canvas = document.getElementById(`chart-${panel.id}`) as HTMLCanvasElement | null;
        if (!canvas) continue;

        const seriesList = panel.keys.map(k => plotStore.allSeries.find(s => s.key === k)).filter(Boolean) as SignalSeries[];
        const multi = seriesList.length > 1;
        const units = new Set(seriesList.map(s => s.unit).filter(Boolean));
        const yLabel = units.size === 1 ? [...units][0] : t('plot.value_label');

        const signalsOrigin = originForView(false);
        const datasets = seriesList.map((series, j) => {
          const color = CHART_COLORS[j % CHART_COLORS.length];
          const samples = plotStore.getSamples(series.key);
          return {
            label: `${series.group} / ${series.signal}${series.unit ? ` (${series.unit})` : ''}`,
            data: samples.map(s => ({ x: s.time - signalsOrigin, y: s.value, frame: s.frame, absTime: s.frame?.timestamp ?? s.time })),
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
                  () => showCopyToast(t('plot.copied_prefix') + ' ' + text),
                  () => showCopyToast(t('plot.copy_failed')),
                );
              }
            },
            plugins: {
              zoom: zoomOptions,
              timelineMarkers: markerPluginOpts(false),
              legend: {
                display: multi,
                labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12 },
              },
              tooltip: {
                callbacks: {
                  title: (items) => {
                    const x = items[0]?.parsed.x;
                    if (x == null) return '';
                    const raw = items[0].raw as any;
                    const abs = typeof raw?.absTime === 'number' ? raw.absTime : x;
                    return Math.abs(abs - x) > 0.0005
                      ? `t = ${x.toFixed(3)}s  (abs ${abs.toFixed(3)}s)`
                      : `t = ${x.toFixed(3)}s`;
                  },
                  label: (item) => {
                    const s = seriesList[item.datasetIndex];
                    const raw = item.raw as any;
                    const dirTag = raw?.frame?.direction === 'tx' ? ' [TX]' : '';
                    return s ? `${s.group} / ${s.signal}: ${item.parsed.y}${s.unit ? ' ' + s.unit : ''}${dirTag}` : '';
                  },
                  afterBody: (items) => {
                    const f = (items[0]?.raw as any)?.frame as FrameRef | undefined;
                    return f ? [`${t('plot.frame_label')} ${plotStore.formatFrameShort(f)}`, t('plot.click_to_copy_ts')] : '';
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
        attachChartInteractions(chart, canvas);
        chartInstances.set(panel.id, chart);
      }
    });
  }

  function renderTimeline() {
    if (timelineChart) { detachChartInteractions(timelineChart); timelineChart.destroy(); timelineChart = null; }

    requestAnimationFrame(() => {
      const canvas = document.getElementById('timeline-chart') as HTMLCanvasElement | null;
      if (!canvas) return;

      const labels = plotStore.messageTimingLabels;
      if (labels.length === 0) return;

      const origin = plotStore.timelineOrigin;
      const datasets = labels.map((label, laneIdx) => {
        const color = CHART_COLORS[laneIdx % CHART_COLORS.length];
        const entries = plotStore.messageTimingStore.get(label) ?? [];
        return {
          label,
          data: entries.map(e => ({ x: e.time - origin, y: laneIdx, frame: e.frame, absTime: e.frame?.timestamp ?? e.time })),
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
            if (!pt?.frame) return;
            const normalizedTime = pt.x + plotStore.timelineOrigin;
            const wallTime = typeof pt.absTime === 'number' ? pt.absTime : normalizedTime;
            const lbl = labels[el.datasetIndex] ?? '';
            const result = plotStore.handleTimelineClick(normalizedTime, lbl);
            if (result === 'origin-set') {
              showCopyToast(`${t('plot.t0_set_at')} ${wallTime.toFixed(3)}s (${lbl})`);
            } else if (result === 'marker-added') {
              showCopyToast(t('plot.marker_set_hint'));
            } else if (result === 'measure-complete') {
              const d = plotStore.timelineMarkerDelta ?? 0;
              showCopyToast(`${t('plot.delta_t_eq')} ${formatDelta(d)}`);
            } else {
              const text = plotStore.formatFrameCandump(pt.frame);
              navigator.clipboard.writeText(text).then(
                () => showCopyToast(t('plot.copied_prefix') + ' ' + text),
                () => showCopyToast(t('plot.copy_failed')),
              );
            }
          },
          plugins: {
            zoom: zoomOptions,
            legend: { display: false },
            timelineMarkers: markerPluginOpts(true),
            tooltip: {
              callbacks: {
                title: (items) => {
                  const x = items[0]?.parsed.x;
                  if (x == null) return '';
                  const raw = items[0].raw as any;
                  const abs = typeof raw?.absTime === 'number' ? raw.absTime : x + plotStore.timelineOrigin;
                  return Math.abs(abs - x) > 0.0005
                    ? `t = ${x.toFixed(3)}s  (abs ${abs.toFixed(3)}s)`
                    : `t = ${x.toFixed(3)}s`;
                },
                label: (item) => {
                  const y = item.parsed.y;
                  if (y == null) return '';
                  return labels[y] ?? '';
                },
                afterBody: (items) => {
                  const f = (items[0]?.raw as any)?.frame as FrameRef | undefined;
                  if (!f) return '';
                  const mode = plotStore.timelineMode;
                  const hint = mode === 'set-origin' ? t('plot.click_set_t0') : mode === 'measure' ? t('plot.click_add_marker') : t('plot.click_to_copy');
                  return [`${t('plot.frame_label')} ${plotStore.formatFrameShort(f)}`, hint];
                },
              },
            },
          },
          scales: {
            x: {
              type: 'linear',
              title: { display: true, text: t('plot.time_label'), color: '#8b949e', font: { size: 11 } },
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
      attachChartInteractions(timelineChart, canvas);
    });
  }

  function renderIntervalCharts() {
    for (const [, chart] of intervalInstances) { detachChartInteractions(chart); chart.destroy(); }
    intervalInstances.clear();

    requestAnimationFrame(() => {
      for (const panel of plotStore.intervalPanels) {
        const canvas = document.getElementById(`interval-${panel.id}`) as HTMLCanvasElement | null;
        if (!canvas) continue;

        const multi = panel.keys.length > 1;
        const intervalOrigin = originForView(false);
        const datasets = panel.keys.map((key, j) => {
          const color = CHART_COLORS[j % CHART_COLORS.length];
          const data = plotStore.getIntervalData(key);
          return {
            label: key,
            data: data.map(d => ({ x: d.time - intervalOrigin, y: d.dt, frame: d.frame, absTime: d.frame?.timestamp ?? d.time })),
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
                  () => showCopyToast(t('plot.copied_prefix') + ' ' + text),
                  () => showCopyToast(t('plot.copy_failed')),
                );
              }
            },
            plugins: {
              zoom: zoomOptions,
              timelineMarkers: markerPluginOpts(false),
              legend: {
                display: multi,
                labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12 },
              },
              tooltip: {
                callbacks: {
                  title: (items) => {
                    const x = items[0]?.parsed.x;
                    if (x == null) return '';
                    const raw = items[0].raw as any;
                    const abs = typeof raw?.absTime === 'number' ? raw.absTime : x;
                    return Math.abs(abs - x) > 0.0005
                      ? `t = ${x.toFixed(3)}s  (abs ${abs.toFixed(3)}s)`
                      : `t = ${x.toFixed(3)}s`;
                  },
                  label: (item) => {
                    const key = panel.keys[item.datasetIndex] ?? '';
                    const y = item.parsed.y;
                    return y == null ? key : `${key}: ${y.toFixed(2)} ms`;
                  },
                  afterBody: (items) => {
                    const f = (items[0]?.raw as any)?.frame as FrameRef | undefined;
                    return f ? [`${t('plot.frame_label')} ${plotStore.formatFrameShort(f)}`, t('plot.click_to_copy')] : '';
                  },
                },
              },
            },
            scales: {
              x: {
                type: 'linear',
                title: { display: true, text: t('plot.time_label'), color: '#8b949e', font: { size: 11 } },
                grid: { color: '#2d354833' },
                ticks: { color: '#8b949e', font: { size: 11 } },
              },
              y: {
                title: { display: true, text: t('plot.interval_label'), color: '#8b949e', font: { size: 11 } },
                grid: { color: '#2d354833' },
                ticks: { color: '#8b949e', font: { size: 11 } },
              },
            },
          },
        });
        attachChartInteractions(chart, canvas);
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

    const signalsOrigin = originForView(false);
    const follow = plotStore.mode === 'live' && plotStore.followLive && !plotStore.userZoomed;
    const windowS = plotStore.followWindowSeconds;
    for (const panel of plotStore.chartPanels) {
      const chart = chartInstances.get(panel.id);
      if (!chart) continue;

      let xMax = -Infinity;
      for (let j = 0; j < panel.keys.length; j++) {
        const samples = plotStore.getSamples(panel.keys[j]);
        const ds = chart.data.datasets[j];
        if (!ds) continue;
        const points = samples.map(s => ({ x: s.time - signalsOrigin, y: s.value, frame: s.frame, absTime: s.frame?.timestamp ?? s.time }));
        ds.data = points;
        (ds as any).pointRadius = points.length <= 100 ? 3 : 0;
        if (points.length > 0 && points[points.length - 1].x > xMax) xMax = points[points.length - 1].x;
      }
      const xScale = chart.options.scales!.x as any;
      if (follow && xMax > -Infinity) {
        xScale.min = xMax - windowS;
        xScale.max = xMax;
      } else if (!plotStore.userZoomed) {
        xScale.min = undefined;
        xScale.max = undefined;
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

    const origin = plotStore.timelineOrigin;
    const follow = plotStore.mode === 'live' && plotStore.followLive && !plotStore.userZoomed;
    const windowS = plotStore.followWindowSeconds;
    let xMax = -Infinity;
    for (let i = 0; i < labels.length; i++) {
      const entries = plotStore.messageTimingStore.get(labels[i]) ?? [];
      const ds = timelineChart.data.datasets[i];
      if (!ds) continue;
      const points = entries.map(e => ({ x: e.time - origin, y: i, frame: e.frame, absTime: e.frame?.timestamp ?? e.time }));
      ds.data = points;
      (ds as any).pointRadius = points.length <= 500 ? 4 : 2;
      if (points.length > 0 && points[points.length - 1].x > xMax) xMax = points[points.length - 1].x;
    }
    const xScale = timelineChart.options.scales!.x as any;
    if (follow && xMax > -Infinity) {
      xScale.min = xMax - windowS;
      xScale.max = xMax;
    } else if (!plotStore.userZoomed) {
      xScale.min = undefined;
      xScale.max = undefined;
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

    const intervalOrigin = originForView(false);
    const follow = plotStore.mode === 'live' && plotStore.followLive && !plotStore.userZoomed;
    const windowS = plotStore.followWindowSeconds;
    for (const panel of plotStore.intervalPanels) {
      const chart = intervalInstances.get(panel.id);
      if (!chart) continue;

      let xMax = -Infinity;
      for (let j = 0; j < panel.keys.length; j++) {
        const data = plotStore.getIntervalData(panel.keys[j]);
        const ds = chart.data.datasets[j];
        if (!ds) continue;
        const points = data.map(d => ({ x: d.time - intervalOrigin, y: d.dt, frame: d.frame, absTime: d.frame?.timestamp ?? d.time }));
        ds.data = points;
        (ds as any).pointRadius = points.length <= 100 ? 3 : 0;
        if (points.length > 0 && points[points.length - 1].x > xMax) xMax = points[points.length - 1].x;
      }
      const xScale = chart.options.scales!.x as any;
      if (follow && xMax > -Infinity) {
        xScale.min = xMax - windowS;
        xScale.max = xMax;
      } else if (!plotStore.userZoomed) {
        xScale.min = undefined;
        xScale.max = undefined;
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

  function resetAllZoom() { fitAllCharts('xy'); }
  function fitX() { fitAllCharts('x'); }
  function fitY() { fitAllCharts('y'); }

  function toggleFollow() {
    const wasFollowing = plotStore.followLive;
    plotStore.toggleFollowLive();
    if (!wasFollowing && plotStore.followLive) {
      // Snap to live window: discard any plugin zoom state so updateLive* takes over.
      for (const [, c] of chartInstances) (c as any).resetZoom('none');
      if (timelineChart) (timelineChart as any).resetZoom('none');
      for (const [, c] of intervalInstances) (c as any).resetZoom('none');
    }
  }

  function onFollowWindowInput(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(v) && v > 0) plotStore.setFollowWindowSeconds(v);
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
    for (const [, chart] of chartInstances) { detachChartInteractions(chart); chart.destroy(); }
    chartInstances.clear();
    if (timelineChart) { detachChartInteractions(timelineChart); timelineChart.destroy(); timelineChart = null; }
    for (const [, chart] of intervalInstances) { detachChartInteractions(chart); chart.destroy(); }
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

    // If we're already in live mode when the page mounts (e.g. navigated
    // back from /encode while the shared bus is connected), make sure plot's
    // frame callback is hooked up — otherwise frames flow past silently.
    if (plotStore.mode === 'live') {
      plotStore.subscribeLiveFrames();
    }

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
    <h1>{t('plot.title')}</h1>
    <p>{t('plot.subtitle')}</p>
  </div>

  <div class="card">
    <!-- Mode tabs -->
    <div class="mode-tabs">
      <button class="mode-tab" class:mode-tab-active={plotStore.mode === 'paste'} onclick={() => plotStore.switchMode('paste')}>
        {t('plot.mode_paste')}
      </button>
      <button class="mode-tab" class:mode-tab-active={plotStore.mode === 'live'} onclick={() => plotStore.switchMode('live')}>
        {t('plot.mode_live')}
      </button>
    </div>

    {#if plotStore.mode === 'paste'}
      <div class="form-group">
        <label for="plot-input">{t('plot.label_candump_log')}</label>
        <textarea id="plot-input" bind:value={plotStore.input} rows="6"
          placeholder={t('plot.placeholder_candump')}
          onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); plotStore.analyze(); } }}
        ></textarea>
        <div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">{t('plot.hint_ctrl_enter')}</div>
      </div>
      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <button class="primary" onclick={() => plotStore.analyze()} disabled={codecStore.configs.length === 0}>{t('plot.analyze')}</button>
        {#if codecStore.configs.length === 0}
          <span style="font-size: 13px; color: var(--text-dim);">{t('plot.load_config_first')}</span>
        {/if}
        {#if plotStore.status}
          <span style="font-size: 13px; color: var(--text-dim);">{plotStore.status}</span>
        {/if}
      </div>
    {:else}
      <div class="form-group">
        <label for="ws-url">{t('plot.label_ws_server')}</label>
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
            {t('plot.connect')}
          </button>
        {:else}
          <button style="background: var(--red);" onclick={() => plotStore.disconnectLive()}>{t('plot.disconnect')}</button>
          <button
            class="btn-sm"
            style="background: {plotStore.paused ? 'var(--green, #3fb950)' : 'var(--yellow, #d29922)'}; color: #000; font-weight: 600;"
            onclick={() => plotStore.togglePause()}
          >
            {plotStore.paused ? t('plot.resume') : t('plot.pause')}
          </button>
        {/if}

        <span class="connection-status {plotStore.wsClient.status}">
          {#if plotStore.wsClient.status === 'connected'}
            {t('plot.connected')}{plotStore.wsClient.busInfo ? ` — ${plotStore.wsClient.busInfo.bus}` : ''}
          {:else if plotStore.wsClient.status === 'connecting'}
            {t('plot.connecting')}
          {:else if plotStore.wsClient.status === 'error'}
            {plotStore.wsClient.error ?? t('plot.error')}
          {:else}
            {t('plot.disconnected')}
          {/if}
        </span>

        {#if plotStore.wsClient.status === 'connected'}
          <span style="font-size: 13px; color: var(--text-dim);">
            {#if plotStore.dumpMatchedOnly}{plotStore.matchedFrameCount} / {/if}{plotStore.wsClient.frameCount} {t('plot.frames')}
            {#if plotStore.wsClient.txFrameCount > 0}<span style="color: var(--orange, #d29922)">({plotStore.wsClient.txFrameCount} TX)</span>{/if}
            {plotStore.paused ? t('plot.paused') : ''}
          </span>
          {#if plotStore.dumpActive}
            <button style="background: var(--red); font-size: 12px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px;" onclick={() => plotStore.stopDumpToFile()}>
              <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: dump-pulse 1s infinite;"></span>
              {t('plot.recording_prefix')} {plotStore.dumpFrameCount} {t('plot.recording_suffix')}
            </button>
          {:else}
            <button class="btn-sm" onclick={() => plotStore.startDumpToFile()}>{t('plot.record_to_file')}</button>
          {/if}
          <label style="font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap;">
            <input type="checkbox" bind:checked={plotStore.dumpMatchedOnly} style="accent-color: var(--accent);" /> {t('plot.matched_only')}
          </label>
        {/if}

        {#if codecStore.configs.length === 0}
          <span style="font-size: 13px; color: var(--text-dim);">{t('plot.load_config_first')}</span>
        {/if}

        {#if plotStore.status}
          <span style="font-size: 13px; color: var(--text-dim);">{plotStore.status}</span>
        {/if}
      </div>

      <!-- Buffer mode -->
      <div style="display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap;">
        <span style="font-size: 12px; color: var(--text-dim);">{t('plot.buffer')}</span>
        <button class="chip" class:chip-active={plotStore.bufferMode === 'unlimited'} onclick={() => plotStore.bufferMode = 'unlimited'}>
          {t('plot.buffer_unlimited')}
        </button>
        <button class="chip" class:chip-active={plotStore.bufferMode === 'samples'} onclick={() => plotStore.bufferMode = 'samples'}>
          {t('plot.buffer_samples')}
        </button>
        <button class="chip" class:chip-active={plotStore.bufferMode === 'time'} onclick={() => plotStore.bufferMode = 'time'}>
          {t('plot.buffer_time')}
        </button>
        {#if plotStore.bufferMode === 'samples'}
          <input type="number" bind:value={plotStore.bufferSamples} min="100" step="1000"
            style="width: 80px; font-size: 12px; padding: 4px 8px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; color: var(--text);" />
        {/if}
        {#if plotStore.bufferMode === 'time'}
          <input type="number" bind:value={plotStore.bufferSeconds} min="5" step="5"
            style="width: 60px; font-size: 12px; padding: 4px 8px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; color: var(--text);" />
          <span style="font-size: 12px; color: var(--text-dim);">{t('plot.buffer_seconds')}</span>
        {/if}
        <span style="margin-left: 12px; border-left: 1px solid var(--border); padding-left: 12px; display: inline-flex; gap: 8px; align-items: center;">
          <span style="font-size: 12px; color: var(--text-dim);">{t('plot.layout')}</span>
          <button class="btn-sm" onclick={importLayout}>{t('plot.layout_import')}</button>
          {#if plotStore.pendingLayoutConfig}
            <span style="font-size: 12px; color: var(--yellow, #d29922);">{t('plot.config_loaded')}</span>
            <button class="btn-sm" onclick={() => { plotStore.pendingLayoutConfig = null; }}>{t('plot.clear_btn')}</button>
          {/if}
        </span>
      </div>

      <!-- Raw frame log -->
      {#if plotStore.wsClient.status === 'connected' || plotStore.rawFrameCount > 0}
        <div style="margin-top: 16px;">
          <button class="setup-toggle" onclick={() => { plotStore.showRawLog = !plotStore.showRawLog; if (plotStore.showRawLog) { rawLogRenderedVersion = 0; setTimeout(() => updateRawLog(), 0); } }}>
            {plotStore.showRawLog ? '▾' : '▸'} {t('plot.raw_frames')}
            <span style="color: var(--text-dim); font-size: 12px; margin-left: 6px;">{plotStore.rawFrameCount}</span>
          </button>
          {#if plotStore.showRawLog}
            <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center;">
              <label style="font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 4px; cursor: pointer;">
                <input type="checkbox" bind:checked={rawLogAutoScroll} style="accent-color: var(--accent);" /> {t('plot.auto_scroll')}
              </label>
              <button class="btn-sm" onclick={() => { plotStore.clearRawLog(); rawLogRenderedVersion = 0; if (rawLogEl) rawLogEl.textContent = ''; }}>{t('plot.clear_btn')}</button>
              <button class="btn-sm" onclick={() => { const blob = new Blob([plotStore.rawFrameLog.join('\n')], { type: 'text/plain' }); const a = document.createElement('a'); a.download = 'candump.log'; a.href = URL.createObjectURL(blob); a.click(); URL.revokeObjectURL(a.href); }}>{t('plot.save_log')}</button>
              <span style="font-size: 12px; color: var(--text-dim);">{t('plot.max_lines')}</span>
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
          {showSetup ? '▾' : '▸'} {t('plot.setup_guide')}
        </button>
        {#if showSetup}
          <div class="setup-content">
            <p><strong>{t('plot.step_1_download')}</strong></p>
            <div style="margin: 8px 0;">
              <button class="btn-sm" onclick={() => downloadServer()}>{t('plot.download_server')}</button>
            </div>
            <p style="font-size: 12px; color: var(--text-dim);">{t('plot.python_note')}</p>

            <p><strong>{t('plot.step_2_install')}</strong></p>
            <pre><code># SocketCAN (built-in Linux kernel driver — most common){'\n'}sudo apt install can-utils          # provides candump{'\n'}{'\n'}# USB adapters via python-can (SLCAN FD, PCAN, etc.){'\n'}pip install "canfd-codec[serve]"    # python-can>=4.0 + pyserial>=3.5{'\n'}# or individually:{'\n'}pip install python-can>=4.0 pyserial>=3.5</code></pre>

            <p style="margin-top: 12px;"><strong>{t('plot.step_3_choose')}</strong></p>

            <details open style="margin-top: 8px;">
              <summary style="cursor: pointer; font-size: 13px; font-weight: 600;">{t('plot.setup_local')}</summary>
              <div style="padding: 4px 0 4px 8px;">
                <p style="font-size: 12px;">{t('plot.setup_local_p1')}</p>
                <pre><code>python3 can_ws_server.py --bus can0</code></pre>
                <p style="font-size: 12px;">{t('plot.setup_local_p2_prefix')} <code>ws://localhost:8765</code> {t('plot.setup_local_p2_suffix')}</p>
              </div>
            </details>

            <details style="margin-top: 8px;">
              <summary style="cursor: pointer; font-size: 13px; font-weight: 600;">{t('plot.setup_lan')}</summary>
              <div style="padding: 4px 0 4px 8px;">
                <p style="font-size: 12px;">{t('plot.setup_lan_p1_prefix')} <code>can_ws_server.py</code> {t('plot.setup_lan_p1_suffix')}</p>
                <pre><code># On the CAN device (e.g. 192.168.x.x):{'\n'}python3 can_ws_server.py --bus can0{'\n'}{'\n'}# On your PC:{'\n'}python3 can_ws_server.py --source ws://192.168.x.x:8765</code></pre>
                <p style="font-size: 12px;">{t('plot.setup_local_p2_prefix')} <code>ws://localhost:8765</code> {t('plot.setup_local_p2_suffix')}</p>
                <p style="font-size: 12px; color: var(--text-dim);">{t('plot.setup_lan_relay_note_prefix')}<code>--source</code> {t('plot.setup_lan_relay_note_suffix')}</p>
              </div>
            </details>

            <details style="margin-top: 8px;">
              <summary style="cursor: pointer; color: var(--text-dim); font-size: 12px;">{t('plot.more_options')}</summary>
              <pre><code># Filter specific CAN IDs{'\n'}python3 can_ws_server.py --bus can0 --filter 0x101,0x201{'\n'}{'\n'}# Disable CAN FD{'\n'}python3 can_ws_server.py --bus can0 --no-fd{'\n'}{'\n'}# Custom port and bind address{'\n'}python3 can_ws_server.py --host 0.0.0.0 --port 9000{'\n'}{'\n'}# Test with virtual CAN{'\n'}sudo modprobe vcan{'\n'}sudo ip link add dev vcan0 type vcan{'\n'}sudo ip link set up vcan0{'\n'}python3 can_ws_server.py --bus vcan0</code></pre>
            </details>
            <details style="margin-top: 8px;">
              <summary style="cursor: pointer; color: var(--text-dim); font-size: 12px;">{t('plot.usb_adapters')}</summary>
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
        {t('plot.signals')}
      </button>
      <button class="mode-tab" class:mode-tab-active={plotStore.activeViews.has('timeline')} onclick={() => plotStore.toggleView('timeline')}>
        {t('plot.timeline')}
      </button>
      <button class="mode-tab" class:mode-tab-active={plotStore.activeViews.has('interval')} onclick={() => plotStore.toggleView('interval')}>
        {t('plot.interval')}
      </button>
      <div style="margin-left: auto; display: flex; gap: 8px;">
        {#if !plotStore.showGestureHint}
          <button class="btn-sm" onclick={() => plotStore.showGestureHint = true} title={t('plot.gesture_show_title')}>?</button>
        {/if}
        <button class="btn-sm" onclick={() => plotStore.clearData()} style="color: var(--red, #f85149);">{t('plot.clear_btn')}</button>
        <button class="btn-sm" onclick={exportLayout}>{t('plot.layout_export')}</button>
        <button class="btn-sm" onclick={importLayout}>{t('plot.layout_import_btn')}</button>
        {#if plotStore.pendingLayoutConfig}
          <button class="btn-sm" style="color: var(--yellow, #d29922);" onclick={() => { plotStore.pendingLayoutConfig = null; }}>{t('plot.layout_clear')}</button>
        {/if}
      </div>
    </div>

    {#if plotStore.showGestureHint}
      <div class="gesture-hint">
        <span class="gesture-item"><kbd>Scroll</kbd> {t('plot.gesture_scroll')}</span>
        <span class="gesture-item"><kbd>Shift</kbd>+<kbd>Scroll</kbd> {t('plot.gesture_shift_scroll')}</span>
        <span class="gesture-item"><kbd>Ctrl</kbd>+<kbd>Scroll</kbd> {t('plot.gesture_ctrl_scroll')}</span>
        <span class="gesture-item"><kbd>Drag</kbd> {t('plot.gesture_drag')}</span>
        <span class="gesture-item"><kbd>Shift</kbd>+<kbd>Drag</kbd> {t('plot.gesture_shift_drag')}</span>
        <span class="gesture-item"><kbd>Double-click</kbd> {t('plot.gesture_dblclick')}</span>
        <span class="gesture-item"><kbd>Click</kbd> {t('plot.gesture_click_point')}</span>
        {#if plotStore.mode === 'live'}
          <span class="gesture-item" style="color: var(--accent);">{t('plot.gesture_live_hint_prefix')} <strong>{t('plot.gesture_live_hint_middle')}</strong> {t('plot.gesture_live_hint_suffix')}</span>
        {/if}
        <button class="gesture-dismiss" onclick={() => plotStore.dismissGestureHint()} title={t('plot.gesture_dismiss_title')}>×</button>
      </div>
    {/if}

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
            title={t('plot.drag_reorder_title')}
            draggable="true"
            ondragstart={(e) => onViewDragStart(view, e)}
            ondragend={onViewDragEnd}
          >&#x2630;</div>

          {#if view === 'signals'}
            <div class="card">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 8px; flex-wrap: wrap;">
                <strong style="font-size: 14px;">{t('plot.signals')}</strong>
                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                  <button class="btn-sm" onclick={() => plotStore.selectAll()}>{t('messages.all')}</button>
                  <button class="btn-sm" onclick={() => plotStore.selectNone()}>{t('messages.none')}</button>
                  {#if plotStore.chartPanels.length > 0}
                    <button class="btn-sm" onclick={fitX} title={t('plot.fit_x_title')}>{t('plot.fit_x')}</button>
                    <button class="btn-sm" onclick={fitY} title={t('plot.fit_y_title')}>{t('plot.fit_y')}</button>
                    <button class="btn-sm" onclick={resetAllZoom} title={t('plot.fit_title')}>{t('plot.fit')}</button>
                    {#if plotStore.mode === 'live'}
                      <button class="btn-sm" class:chip-active={plotStore.followLive} onclick={toggleFollow}
                        title={t('plot.follow_title')}>
                        {plotStore.followLive ? t('plot.following') : t('plot.follow_live')}
                      </button>
                      {#if plotStore.followLive}
                        <label class="follow-window" title={t('plot.window_title')}>
                          {t('plot.window')}
                          <input type="number" min="1" max="3600" step="1"
                            value={plotStore.followWindowSeconds} oninput={onFollowWindowInput} />
                          s
                        </label>
                      {/if}
                    {/if}
                    <button class="btn-sm" onclick={savePng}>{t('plot.save_png')}</button>
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
                          title={t('plot.drag_reorder_title')}
                          draggable="true"
                          ondragstart={(e) => onPanelDragStart('signals', panel.id, e)}
                          ondragend={onPanelDragEnd}
                        >&#x2630;</span>
                        {#each seriesList as series, j}
                          <span class="chart-signal-tag" style="--tag-color: {CHART_COLORS[j % CHART_COLORS.length]}">
                            <span style="opacity: 0.6;">{series.group} /</span> {series.signal}{series.unit ? ` (${series.unit})` : ''}
                            {#if panel.keys.length > 1}
                              <button class="chart-signal-tag-remove" onclick={() => plotStore.splitFromPanel(panel.id, series.key)} title={t('plot.split_title')}>x</button>
                            {/if}
                          </span>
                        {/each}
                        <div class="chart-add-wrapper">
                          <button class="chart-add-btn" onclick={() => addDropdownOpen = addDropdownOpen === panel.id ? null : panel.id} title={t('plot.add_signal_title')}>+</button>
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
                                <span style="color: var(--text-dim); font-size: 12px; padding: 8px;">{t('plot.no_other_signals')}</span>
                              </div>
                            {/if}
                          {/if}
                        </div>
                      </div>
                      <span class="chart-samples">{plotStore.getPanelSampleCount(panel)} {t('plot.samples')}</span>
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
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
                <strong style="font-size: 14px;">{t('plot.message_timeline')}</strong>
                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                  {#if plotStore.messageTimingLabels.length > 0}
                    <button class="btn-sm" class:chip-active={plotStore.timelineMode === 'set-origin'}
                      onclick={() => plotStore.enterTimelineMode('set-origin')}
                      title={t('plot.set_t0_title')}>
                      {plotStore.timelineMode === 'set-origin' ? t('plot.set_t0_picking') : t('plot.set_t0')}
                    </button>
                    <button class="btn-sm" class:chip-active={plotStore.timelineMode === 'measure'}
                      onclick={() => plotStore.enterTimelineMode('measure')}
                      title={t('plot.measure_title')}>
                      {plotStore.timelineMode === 'measure' ? `${t('plot.measure_picking')} ${plotStore.timelineMarkers.length + 1}/2…` : t('plot.measure_dt')}
                    </button>
                    <label style="font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 4px; cursor: pointer;" title={t('plot.apply_to_all_views_title')}>
                      <input type="checkbox"
                        checked={plotStore.applyTimingToAllViews}
                        onchange={() => plotStore.toggleApplyTimingToAllViews()}
                        style="accent-color: var(--accent);" />
                      {t('plot.apply_to_all_views')}
                    </label>
                    <button class="btn-sm" onclick={fitX} title={t('plot.fit_x_title')}>{t('plot.fit_x')}</button>
                    <button class="btn-sm" onclick={fitY} title={t('plot.fit_y_title')}>{t('plot.fit_y')}</button>
                    <button class="btn-sm" onclick={resetAllZoom} title={t('plot.fit_title')}>{t('plot.fit')}</button>
                    {#if plotStore.mode === 'live'}
                      <button class="btn-sm" class:chip-active={plotStore.followLive} onclick={toggleFollow}
                        title={t('plot.follow_title')}>
                        {plotStore.followLive ? t('plot.following') : t('plot.follow_live')}
                      </button>
                      {#if plotStore.followLive}
                        <label class="follow-window" title={t('plot.window_title')}>
                          {t('plot.window')}
                          <input type="number" min="1" max="3600" step="1"
                            value={plotStore.followWindowSeconds} oninput={onFollowWindowInput} />
                          s
                        </label>
                      {/if}
                    {/if}
                    <button class="btn-sm" onclick={savePng}>{t('plot.save_png')}</button>
                  {/if}
                </div>
              </div>
              {#if plotStore.timelineOrigin !== 0 || plotStore.timelineMarkers.length > 0}
                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px;">
                  {#if plotStore.timelineOrigin !== 0}
                    <span class="chart-signal-tag" style="--tag-color: #d29922;">
                      {t('plot.t0_origin_at')} {plotStore.timelineOrigin.toFixed(3)}s
                      <button class="chart-signal-tag-remove" onclick={() => plotStore.resetTimelineOrigin()} title={t('plot.reset_origin_title')}>x</button>
                    </span>
                  {/if}
                  {#if plotStore.timelineMarkers.length > 0}
                    <span class="chart-signal-tag" style="--tag-color: #39d2c0;">
                      {#if plotStore.timelineMarkerDelta !== null}
                        {t('plot.delta_t_eq')} {formatDelta(plotStore.timelineMarkerDelta)}
                        <span style="opacity: 0.7;">({plotStore.timelineMarkers[0].time.toFixed(3)}s → {plotStore.timelineMarkers[1].time.toFixed(3)}s)</span>
                      {:else}
                        {t('plot.marker_a_at')} {plotStore.timelineMarkers[0].time.toFixed(3)}s {t('plot.marker_pick_second')}
                      {/if}
                      <button class="chart-signal-tag-remove" onclick={() => plotStore.clearTimelineMarkers()} title={t('plot.clear_markers_title')}>x</button>
                    </span>
                  {/if}
                </div>
              {/if}
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
                <div
                  class="chart-container"
                  class:timeline-pick-mode={plotStore.timelineMode !== 'normal'}
                  style="height: {Math.max(200, plotStore.messageTimingLabels.length * 40 + 60)}px;"
                >
                  <canvas id="timeline-chart"></canvas>
                </div>
              </div>
            {/if}

          {:else if view === 'interval'}
            <div class="card">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 8px; flex-wrap: wrap;">
                <strong style="font-size: 14px;">{t('plot.message_intervals')}</strong>
                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                  <button class="btn-sm" onclick={() => plotStore.selectAllInterval()}>{t('messages.all')}</button>
                  <button class="btn-sm" onclick={() => plotStore.selectNoneInterval()}>{t('messages.none')}</button>
                  {#if plotStore.intervalPanels.length > 0}
                    <button class="btn-sm" onclick={fitX} title={t('plot.fit_x_title')}>{t('plot.fit_x')}</button>
                    <button class="btn-sm" onclick={fitY} title={t('plot.fit_y_title')}>{t('plot.fit_y')}</button>
                    <button class="btn-sm" onclick={resetAllZoom} title={t('plot.fit_title')}>{t('plot.fit')}</button>
                    {#if plotStore.mode === 'live'}
                      <button class="btn-sm" class:chip-active={plotStore.followLive} onclick={toggleFollow}
                        title={t('plot.follow_title')}>
                        {plotStore.followLive ? t('plot.following') : t('plot.follow_live')}
                      </button>
                      {#if plotStore.followLive}
                        <label class="follow-window" title={t('plot.window_title')}>
                          {t('plot.window')}
                          <input type="number" min="1" max="3600" step="1"
                            value={plotStore.followWindowSeconds} oninput={onFollowWindowInput} />
                          s
                        </label>
                      {/if}
                    {/if}
                    <button class="btn-sm" onclick={savePng}>{t('plot.save_png')}</button>
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
                          title={t('plot.drag_reorder_title')}
                          draggable="true"
                          ondragstart={(e) => onPanelDragStart('interval', panel.id, e)}
                          ondragend={onPanelDragEnd}
                        >&#x2630;</span>
                        {#each panel.keys as key, j}
                          <span class="chart-signal-tag" style="--tag-color: {CHART_COLORS[j % CHART_COLORS.length]}">
                            {key}
                            {#if panel.keys.length > 1}
                              <button class="chart-signal-tag-remove" onclick={() => plotStore.splitFromIntervalPanel(panel.id, key)} title={t('plot.split_title')}>x</button>
                            {/if}
                          </span>
                        {/each}
                        <div class="chart-add-wrapper">
                          <button class="chart-add-btn" onclick={() => addDropdownOpen = addDropdownOpen === panel.id ? null : panel.id} title={t('plot.add_message_title')}>+</button>
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
                                <span style="color: var(--text-dim); font-size: 12px; padding: 8px;">{t('plot.no_other_messages')}</span>
                              </div>
                            {/if}
                          {/if}
                        </div>
                      </div>
                      <span class="chart-samples">{plotStore.getIntervalPanelSampleCount(panel)} {t('plot.intervals')}</span>
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
