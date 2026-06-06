<script lang="ts">
  import { i18n } from '$lib/i18n.svelte';
  const lang = $derived(i18n.locale);

  const versions = [
    {
      version: '1.4.6',
      date: '2026-06-06',
      tag: 'latest',
      en: {
        changes: [
          { type: 'fix', text: 'Plot: fix a 500 error when opening /plot directly (hard refresh or a pasted link) — the zoom/pan plugin was being loaded during server-side rendering, where its browser-only dependency has no window and crashed. It now loads in the browser only; zoom/pan is unchanged' },
        ],
      },
      zh: {
        changes: [
          { type: 'fix', text: 'Plot：修复直接打开 /plot（硬刷新或粘贴链接）时出现 500 错误的问题——缩放/平移插件在服务端渲染阶段被加载，而其依赖只能在浏览器中运行（没有 window），导致崩溃。现在该插件仅在浏览器端加载；缩放/平移功能不变' },
        ],
      },
    },
    {
      version: '1.4.5',
      date: '2026-06-03',
      en: {
        changes: [
          { type: 'fix', text: 'Plot: fix derived-signal formulas (e.g. delta = a − b) showing phantom spikes — signals sampled in the same frame are now evaluated together, so each timestamp produces one correct value' },
        ],
      },
      zh: {
        changes: [
          { type: 'fix', text: 'Plot：修复派生信号公式（如 delta = a − b）出现异常尖峰的问题——同一帧内采样的信号现在会一起求值，每个时间戳只产生一个正确的值' },
        ],
      },
    },
    {
      version: '1.4.4',
      date: '2026-05-31',
      tag: null,
      en: {
        changes: [
          { type: 'feat', text: 'Plot: Formulas — define derived signals as arithmetic expressions (a*0.1, a−b, (a+b)/2, …); formulas can chain (reference other formulas) and expand per-node via an "N*" placeholder' },
          { type: 'feat', text: 'Plot: formulas persist locally and export with the chart-layout YAML' },
        ],
      },
      zh: {
        changes: [
          { type: 'feat', text: 'Plot：公式——用算式（a*0.1、a−b、(a+b)/2 等）定义派生信号；公式可链式引用，并可用 "N*" 占位符按节点展开' },
          { type: 'feat', text: 'Plot：公式本地持久化，并随图表布局 YAML 一起导出' },
        ],
      },
    },
    {
      version: '1.4.3',
      date: '2026-05-28',
      tag: null,
      en: {
        changes: [
          { type: 'feat', text: 'Plot: CSV export — toolbar format selector (long / wide node:signal / wide signal:node) plus an "All signals" option; export stays available whenever data exists' },
          { type: 'feat', text: 'Plot: live signal recording — stream decoded samples to a .csv as frames arrive, with a "Selected only" toggle; recording buttons are now "Record raw frames" / "Record signals"' },
          { type: 'feat', text: 'Program: "custom (raw frame)" Send option — enter raw hex bytes to send arbitrary CAN frames without defining a YAML message first' },
        ],
      },
      zh: {
        changes: [
          { type: 'feat', text: 'Plot：CSV 导出——工具栏新增格式选择器（长表 / 宽表 节点:信号 / 宽表 信号:节点）与"全部信号"选项；只要有数据，导出始终可用' },
          { type: 'feat', text: 'Plot：实时信号录制——将解码样本随帧流式写入 .csv，可勾选"仅已选"；录制按钮现为"录制原始帧"/"录制信号"' },
          { type: 'feat', text: 'Program：Send 新增"自定义（原始帧）"选项——直接输入十六进制字节即可发送任意 CAN 帧，无需先在 YAML 中定义消息' },
        ],
      },
    },
    {
      version: '1.4.2',
      date: '2026-05-26',
      tag: null,
      en: {
        changes: [
          { type: 'feat', text: 'Messages: per-signal unit picker — pick a display unit (rad/s ↔ rpm, K ↔ °C ↔ °F, m/s ↔ km/h, …) that propagates to Decode, Plot and Encode; preferences persist per signal' },
          { type: 'fix', text: 'Codec: disambiguate messages sharing the same base ID and DLC by matching `constant: true` signal bits (e.g. the vesc.yaml messages all at base 0x000 / DLC=8). Python and TS codecs updated' },
        ],
      },
      zh: {
        changes: [
          { type: 'feat', text: 'Messages：每信号单位选择器——选择显示单位（rad/s ↔ rpm、K ↔ °C ↔ °F、m/s ↔ km/h 等），自动应用到 Decode、Plot 和 Encode；偏好按信号持久化' },
          { type: 'fix', text: 'Codec：通过匹配 `constant: true` 信号的比特位区分相同 base ID + DLC 的消息（如 vesc.yaml 中同处 base 0x000 / DLC=8 的多个消息）。Python 与 TS codec 同步更新' },
        ],
      },
    },
    {
      version: '1.4.1',
      date: '2026-05-19',
      tag: null,
      en: {
        changes: [
          { type: 'feat', text: 'Plot: "Load File" button in paste mode — pick a candump .log or ZLG USBCAN(FD) .csv export from disk; CSV is auto-detected by header and converted in-browser to cansend-format lines, then run through the existing decode path' },
        ],
      },
      zh: {
        changes: [
          { type: 'feat', text: 'Plot：粘贴模式新增 "Load File" 按钮——可直接从磁盘选择 candump .log 或致远（ZLG）USBCAN(FD) 导出的 .csv 文件；CSV 通过表头自动识别，浏览器内转换为 cansend 行后走原有解码流程' },
        ],
      },
    },
    {
      version: '1.4.0',
      date: '2026-05-17',
      tag: null,
      en: {
        changes: [
          { type: 'feat', text: 'Program: new page for building and running multi-step CAN command sequences — statements (send, wait, repeat, every, sweep, group, set, bind, read), notebook-style cells with persistent variables, expressions in any field, closed-loop Bind/Read control, and per-node broadcast editing' },
          { type: 'feat', text: 'Web: site-wide EN / 中文 i18n with a nav language toggle (defaults to the browser language)' },
          { type: 'feat', text: 'Plot: human-friendly zoom/pan gestures — scroll, Shift/Ctrl+scroll, drag, double-click-to-fit and pinch — with a ? cheat-sheet' },
          { type: 'feat', text: 'Plot: TX frames from Program / Encode are tagged separately from RX in the raw log and tooltips' },
          { type: 'feat', text: 'Encode: shared bus connection across Plot / Program — connect once, all three pages see live frames' },
        ],
      },
      zh: {
        changes: [
          { type: 'feat', text: 'Program：全新页面，用于构建并运行多步 CAN 命令序列——支持 send、wait、repeat、every、sweep、group、set、bind、read 等语句、notebook 风格 cell（变量可跨运行保留）、任意字段中的变量与表达式、Bind/Read 闭环控制，以及按节点的广播编辑' },
          { type: 'feat', text: 'Web：站点级 EN / 中文 i18n，导航栏新增语言切换（默认跟随浏览器语言）' },
          { type: 'feat', text: 'Plot：更直观的缩放/平移手势——滚轮、Shift/Ctrl+滚轮、拖动、双击自适应、双指缩放——并提供 ? 速查表' },
          { type: 'feat', text: 'Plot：来自 Program / Encode 的 TX 帧在原始日志和 tooltip 中与 RX 独立标记' },
          { type: 'feat', text: 'Encode：与 Plot / Program 共享同一条总线连接——连接一次，三个页面都能看到实时帧' },
        ],
      },
    },
    {
      version: '1.3.0',
      date: '2026-05-12',
      tag: null,
      en: {
        changes: [
          { type: 'feat', text: 'Plot: Timeline t=0 origin — right-click any data point to set as the time reference; all charts shift accordingly' },
          { type: 'feat', text: 'Plot: A/B timeline markers with Δt readout — click to place up to two markers on the timeline chart and see the time difference' },
          { type: 'feat', text: 'Plot: Apply timing origin and markers to all views simultaneously via the "Apply to all" toggle' },
          { type: 'fix', text: 'Codec: corrected 0xFF broadcast decode disambiguation between WriteRegUint8 and SwitchMode messages sharing the same node_id' },
        ],
      },
      zh: {
        changes: [
          { type: 'feat', text: 'Plot：时间线 t=0 起点——右键单击任意数据点将其设为时间参考点，所有图表随之偏移' },
          { type: 'feat', text: 'Plot：A/B 时间线标记与 Δt 读数——在时序图上点击可放置最多两个标记并显示时间差' },
          { type: 'feat', text: 'Plot：新增"Apply to all"开关，将时间原点和标记同步应用到所有视图' },
          { type: 'fix', text: 'Codec：修复 0xFF 广播解码歧义，正确区分共享同一 node_id 的 WriteRegUint8 与 SwitchMode 消息' },
        ],
      },
    },
    {
      version: '1.2.0',
      date: '2026-05-06',
      tag: null,
      en: {
        changes: [
          { type: 'feat', text: 'Web: per-message signal filtering — expand any message row to filter by node ID, signal name, or enum value' },
          { type: 'feat', text: 'Web: enable/disable all configs or all messages per device in one click' },
          { type: 'feat', text: 'Plot: live data controls — Clear, pause/resume, and panel/series/layout state that persists across navigation' },
          { type: 'feat', text: 'Plot: export/import chart layout as YAML, plus a "Matched only" record filter that skips undecodable frames' },
          { type: 'fix', text: 'Config: resolve $parameter references in signal min/max/scale/offset fields' },
        ],
      },
      zh: {
        changes: [
          { type: 'feat', text: 'Web：逐消息信号过滤——展开任意消息行，可按节点 ID、信号名称或枚举值进行筛选' },
          { type: 'feat', text: 'Web：一键启用/禁用所有配置文件或某设备的所有消息' },
          { type: 'feat', text: 'Plot：实时数据控制——清空、暂停/恢复，以及跨页面切换保留的面板/信号/布局状态' },
          { type: 'feat', text: 'Plot：图表布局导出/导入为 YAML，并新增"仅匹配"录制过滤，跳过无法解码的帧' },
          { type: 'fix', text: '配置：修复信号 min/max/scale/offset 字段中 $parameter 引用无法解析的问题' },
        ],
      },
    },
    {
      version: '1.1.0',
      date: '2026-04-20',
      tag: null,
      en: {
        changes: [
          { type: 'feat', text: 'Plot: Timeline and Interval views (per-message event timing and per-signal delta-time), with drag-to-reorder panels' },
          { type: 'feat', text: 'Plot: raw CAN frame log with click-to-copy candump lines, and streaming to a .log file during capture' },
          { type: 'feat', text: 'Serve: --source LAN relay and --interface USB-adapter support (SLCAN CAN FD, PCAN, …), now on a zero-dependency stdlib WebSocket + candump backend' },
          { type: 'feat', text: 'Web: candump-to-cansend converter page' },
          { type: 'feat', text: 'Web: mux_signal support to disambiguate register-based messages in the plot' },
        ],
      },
      zh: {
        changes: [
          { type: 'feat', text: 'Plot：新增 Timeline（消息事件时序）和 Interval（信号间隔时间）视图，并支持拖拽重排面板' },
          { type: 'feat', text: 'Plot：原始 CAN 帧日志，支持点击复制 candump 行，并可在采集时流式写入 .log 文件' },
          { type: 'feat', text: 'Serve：新增 --source 局域网中继与 --interface USB 适配器支持（SLCAN CAN FD、PCAN 等），并改用零依赖的 stdlib WebSocket + candump 后端' },
          { type: 'feat', text: 'Web：新增 candump 转 cansend 转换页面' },
          { type: 'feat', text: 'Web：支持 mux_signal，用于在 Plot 中区分寄存器类消息' },
        ],
      },
    },
    {
      version: '1.0.0',
      date: '2026-04-01',
      tag: null,
      en: {
        changes: [
          { type: 'feat', text: 'Initial release' },
          { type: 'feat', text: 'Browser-based CAN/CAN-FD encode/decode with YAML config files' },
          { type: 'feat', text: 'Live plot page with WebSocket streaming from can_ws_server.py' },
          { type: 'feat', text: 'Multi-node messages: node_count, node_id_offset, node_id_start' },
          { type: 'feat', text: 'Broadcast mode (broadcast_node_id) — single frame addresses all nodes' },
          { type: 'feat', text: 'Signal types: unsigned, signed, float32/float64, enum, bitfield' },
          { type: 'feat', text: 'Linear mapping (linear_map) — auto-calculate scale/offset from physical min/max' },
          { type: 'feat', text: 'Web UI: Messages, Decode, Encode, Plot pages' },
          { type: 'feat', text: 'CLI: list, describe, decode, encode, monitor subcommands' },
          { type: 'feat', text: 'Python API: Codec class for programmatic encode/decode' },
        ],
      },
      zh: {
        changes: [
          { type: 'feat', text: '首次发布' },
          { type: 'feat', text: '基于浏览器的 CAN/CAN-FD 编解码，使用 YAML 配置文件' },
          { type: 'feat', text: '实时绘图页面，通过 WebSocket 从 can_ws_server.py 接收数据流' },
          { type: 'feat', text: '多节点消息支持：node_count、node_id_offset、node_id_start' },
          { type: 'feat', text: '广播模式（broadcast_node_id）——单帧同时寻址所有节点' },
          { type: 'feat', text: '信号类型：unsigned、signed、float32/float64、enum、bitfield' },
          { type: 'feat', text: '线性映射（linear_map）——由物理量 min/max 自动计算 scale/offset' },
          { type: 'feat', text: '网页界面：Messages、Decode、Encode、Plot 四个功能页面' },
          { type: 'feat', text: '命令行工具：list、describe、decode、encode、monitor 子命令' },
          { type: 'feat', text: 'Python API：Codec 类，支持程序化编解码' },
        ],
      },
    },
  ];

  const typeStyle: Record<string, { bg: string; color: string; label: string }> = {
    feat:  { bg: 'rgba(63,185,80,0.12)',  color: '#3fb950', label: 'feat'  },
    fix:   { bg: 'rgba(248,81,73,0.12)',  color: '#f85149', label: 'fix'   },
    perf:  { bg: 'rgba(88,166,255,0.12)', color: '#58a6ff', label: 'perf'  },
    docs:  { bg: 'rgba(139,148,158,0.15)',color: '#8b949e', label: 'docs'  },
  };
</script>

<div class="container">
  <div class="page-header" style="display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
    <div>
      {#if lang === 'en'}
        <h1>Changelog</h1>
        <p>Release history for CAN Codec</p>
      {:else}
        <h1>更新日志</h1>
        <p>CAN Codec 版本历史</p>
      {/if}
    </div>
  </div>

  {#each versions as v}
    {@const content = lang === 'en' ? v.en : v.zh}
    <div class="card version-card">
      <div class="version-header">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span class="version-number">v{v.version}</span>
          {#if v.tag === 'latest'}
            <span class="tag-latest">{lang === 'en' ? 'latest' : '最新'}</span>
          {/if}
        </div>
        <span class="version-date">{v.date}</span>
      </div>

      <ul class="change-list">
        {#each content.changes as change}
          {@const ts = typeStyle[change.type] ?? typeStyle.feat}
          <li class="change-item">
            <span class="change-tag" style="background: {ts.bg}; color: {ts.color};">{ts.label}</span>
            <span class="change-text">{change.text}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/each}
</div>

<style>
  .version-card {
    padding: 20px 24px;
  }

  .version-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }

  .version-number {
    font-size: 17px;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--text);
  }

  .version-date {
    font-size: 13px;
    color: var(--text-dim);
    font-family: var(--font-mono);
  }

  .tag-latest {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 20px;
    background: rgba(63, 185, 80, 0.15);
    color: var(--green);
    letter-spacing: 0.03em;
  }

  .change-list {
    list-style: none;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .change-item {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 14px;
    line-height: 1.5;
  }

  .change-tag {
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    font-family: var(--font-mono);
    letter-spacing: 0.02em;
    min-width: 36px;
    text-align: center;
  }

  .change-text {
    color: var(--text);
  }
</style>
