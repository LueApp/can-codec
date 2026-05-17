<script lang="ts">
  import { i18n } from '$lib/i18n.svelte';
  const lang = $derived(i18n.locale);

  const versions = [
    {
      version: '1.4.0',
      date: '2026-05-17',
      tag: 'latest',
      en: {
        changes: [
          { type: 'feat', text: 'Program: new page for building and running multi-step CAN command sequences with statements like send, wait, repeat, every, sweep, group, set, bind, read' },
          { type: 'feat', text: 'Program: notebook-style cells — top-level Group blocks each get a ▶ Run button; `set` variables persist across cell runs and Run All until you click Reset vars' },
          { type: 'feat', text: 'Program: variables and expressions usable in any Send / Bind / Read field (including nodeId), e.g. `set motor_idx = 2; bind pos ← Telemetry.position @=motor_idx`' },
          { type: 'feat', text: 'Program: closed-loop control via Bind (continuous) and Read (one-shot blocking with timeout); a live bindings panel shows current value and last-seen age' },
          { type: 'feat', text: 'Program: shift+click range selection — pick consecutive same-parent blocks and drag any one to move them together; ⎘ duplicates a block' },
          { type: 'feat', text: 'Program: in-place broadcast toggle in the Send editor with per-node tabs for messages that have a broadcast id' },
          { type: 'feat', text: 'Plot: TX frames from Program / Encode are tagged separately from RX in the status bar, raw log and chart tooltips; raw log now uses a fixed-width RX/TX column so both directions align' },
          { type: 'feat', text: 'Plot: human-friendly zoom — scroll = time, Shift+scroll = value, Ctrl/⌘+scroll = both axes; left-drag pans, Shift+drag box-zooms, double-click fits to data; pinch zooms both on touch. New ? button reveals a gesture cheat-sheet' },
          { type: 'feat', text: 'Plot: paste-mode timestamp parser handles candump variants with direction/flag tokens (e.g. `TX B -`) between iface and ID so timestamps survive the round-trip' },
          { type: 'feat', text: 'Encode: shared bus connection with Plot / Program — connect once, all three pages see live frames. "Send to bus" and "+ Sequence" actions hook into the same connection' },
          { type: 'feat', text: 'Web: site-wide EN / 中文 i18n. All seven pages read user-facing strings via a global locale store; default follows navigator.language (zh-* → 中文) and persists in localStorage. Nav has a single language toggle' },
          { type: 'fix', text: 'Codec: encoding non-numeric values now throws with a hint about the `=` expression prefix instead of silently packing NaN' },
        ],
      },
      zh: {
        changes: [
          { type: 'feat', text: 'Program：全新页面，用于构建并运行多步 CAN 命令序列，包含 send、wait、repeat、every、sweep、group、set、bind、read 等语句' },
          { type: 'feat', text: 'Program：notebook 风格的 cell —— 顶层 Group 块各自带有 ▶ 运行按钮，`set` 变量跨 cell 运行和 Run All 保留，直至点击 Reset vars' },
          { type: 'feat', text: 'Program：所有 Send / Bind / Read 字段（包括 nodeId）均可使用变量与表达式，例如 `set motor_idx = 2; bind pos ← Telemetry.position @=motor_idx`' },
          { type: 'feat', text: 'Program：闭环控制——Bind 持续绑定，Read 单次带超时阻塞读取；实时绑定面板显示当前值与最近更新时间' },
          { type: 'feat', text: 'Program：Shift+点击区间选择——选中同父级下的连续块，拖动其中任一块即可一起移动；⎘ 可复制块' },
          { type: 'feat', text: 'Program：Send 编辑器内的广播开关，对配置了 broadcast id 的消息显示节点页签，可分别编辑每个节点的数值' },
          { type: 'feat', text: 'Plot：来自 Program / Encode 的 TX 帧在状态栏、原始日志和图表 tooltip 中独立标记，原始日志使用定宽的 RX/TX 列以保证两个方向的对齐' },
          { type: 'feat', text: 'Plot：更直观的缩放手势——滚轮缩放时间，Shift+滚轮缩放数值，Ctrl/⌘+滚轮同时缩放两轴；左键拖动平移，Shift+拖动框选缩放，双击自适应，触摸双指缩放双轴。新增 ? 按钮可显示手势速查表' },
          { type: 'feat', text: 'Plot：粘贴模式的时间戳解析现已支持包含方向/标志 token（如 `TX B -`）的 candump 变体，时间戳不再因此丢失' },
          { type: 'feat', text: 'Encode：与 Plot / Program 共享同一条总线连接——任一页面连接后，三处都能看到实时帧；"Send to bus" 与 "+ Sequence" 操作复用同一连接' },
          { type: 'feat', text: 'Web：站点级 EN / 中文 i18n。全部七个页面通过统一的语言 store 读取文案，默认跟随 navigator.language（zh-* → 中文）并写入 localStorage；导航栏新增单一语言切换按钮' },
          { type: 'fix', text: 'Codec：发送非数值时抛出错误并提示使用 `=` 表达式前缀，不再静默地发送 NaN' },
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
          { type: 'feat', text: 'Web: Per-message signal filtering — expand any message row to filter by node ID, signal name, or enum value' },
          { type: 'feat', text: 'Web: Enable/disable all configs or all messages per device in one click' },
          { type: 'feat', text: 'Plot: "Clear" button to reset all collected data without disconnecting' },
          { type: 'feat', text: 'Plot: State (panels, series, layout) persists when navigating away and returning' },
          { type: 'feat', text: 'Plot: "Matched only" toggle for record-to-file — skip frames that do not decode to any known message' },
          { type: 'feat', text: 'Plot: Pause / resume live data collection' },
          { type: 'feat', text: 'Plot: Export/import chart panel layout as YAML' },
          { type: 'fix', text: 'Config: resolve $parameter references in signal min/max/scale/offset fields' },
        ],
      },
      zh: {
        changes: [
          { type: 'feat', text: 'Web：逐消息信号过滤——展开任意消息行，可按节点 ID、信号名称或枚举值进行筛选' },
          { type: 'feat', text: 'Web：一键启用/禁用所有配置文件或特定设备的所有消息' },
          { type: 'feat', text: 'Plot：新增 "Clear" 按钮，可在不断开连接的情况下清空所有采集数据' },
          { type: 'feat', text: 'Plot：页面切换后再返回，面板、信号系列和布局状态得以保留' },
          { type: 'feat', text: 'Plot：录制文件时新增"仅匹配"开关，跳过无法解码的帧' },
          { type: 'feat', text: 'Plot：支持暂停/恢复实时数据采集' },
          { type: 'feat', text: 'Plot：图表面板布局可导出/导入为 YAML 文件' },
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
          { type: 'feat', text: 'Plot: Timeline and Interval views — per-message event timing and per-signal delta-time charts' },
          { type: 'feat', text: 'Plot: Drag-to-reorder chart panels across views' },
          { type: 'feat', text: 'Web: candump-to-cansend converter page' },
          { type: 'feat', text: 'Serve: --source relay mode — run a local proxy that forwards frames from a remote CAN machine over LAN' },
          { type: 'feat', text: 'Serve: --interface flag — python-can backend support for USB adapters (SLCAN CAN FD, PCAN, etc.)' },
          { type: 'feat', text: 'Serve: replaced python-can + websockets dependency with zero-dependency stdlib WebSocket + candump' },
          { type: 'feat', text: 'Plot: raw CAN frame log panel with click-to-copy candump lines' },
          { type: 'feat', text: 'Plot: stream raw frames to a .log file during live capture' },
          { type: 'feat', text: 'Web: mux_signal support to disambiguate register-based messages in the plot' },
        ],
      },
      zh: {
        changes: [
          { type: 'feat', text: 'Plot：新增 Timeline（消息事件时序）和 Interval（信号间隔时间）视图' },
          { type: 'feat', text: 'Plot：支持拖拽跨视图重新排列图表面板' },
          { type: 'feat', text: 'Web：新增 candump 转 cansend 转换页面' },
          { type: 'feat', text: 'Serve：新增 --source 中继模式——通过局域网从远端 CAN 机器转发数据帧' },
          { type: 'feat', text: 'Serve：新增 --interface 标志——通过 python-can 支持 USB 适配器（SLCAN CAN FD、PCAN 等）' },
          { type: 'feat', text: 'Serve：以零依赖的 stdlib WebSocket + candump 方案替换 python-can + websockets 依赖' },
          { type: 'feat', text: 'Plot：新增原始帧日志面板，支持点击复制 candump 行' },
          { type: 'feat', text: 'Plot：实时采集时可将原始帧流式写入 .log 文件' },
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
          { type: 'feat', text: 'MAVLink XML message definition support (encode, decode, multi-frame splitting)' },
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
          { type: 'feat', text: 'MAVLink XML 消息定义支持（编码、解码、多帧分片）' },
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
