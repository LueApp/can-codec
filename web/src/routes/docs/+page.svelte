<script lang="ts">
  let lang = $state<'en' | 'zh'>('en');
</script>

<div class="container">
  <div class="page-header" style="display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
    <div>
      {#if lang === 'en'}
        <h1>Documentation</h1>
        <p>Complete guide to CAN Codec web interface</p>
      {:else}
        <h1>使用文档</h1>
        <p>CAN Codec 网页界面完整指南</p>
      {/if}
    </div>
    <div style="display: flex; gap: 4px; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius); padding: 4px;">
      <button
        onclick={() => lang = 'en'}
        style="padding: 4px 14px; font-size: 13px; border-radius: 4px; {lang === 'en' ? 'background: var(--accent); color: #0f1419; font-weight: 600;' : 'background: none; color: var(--text-dim);'}"
      >EN</button>
      <button
        onclick={() => lang = 'zh'}
        style="padding: 4px 14px; font-size: 13px; border-radius: 4px; {lang === 'zh' ? 'background: var(--accent); color: #0f1419; font-weight: 600;' : 'background: none; color: var(--text-dim);'}"
      >中文</button>
    </div>
  </div>

  {#if lang === 'en'}
    <!-- ====== ENGLISH ====== -->

    <div class="card">
      <h2 id="overview">Overview</h2>
      <p style="margin-top: 8px;">CAN Codec is a browser-based tool for encoding and decoding CAN/CAN-FD messages. Load your device's YAML or MAVLink XML configuration file, then use the web interface to browse message definitions, decode raw frames, encode signal values, and monitor live CAN data.</p>
      <p style="margin-top: 8px; color: var(--text-dim); font-size: 13px;">All processing runs in the browser — no data leaves your machine.</p>

      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px;">
        {#each [
          { label: 'Messages', href: '/', desc: 'Browse & filter' },
          { label: 'Decode', href: '/decode', desc: 'Raw → signals' },
          { label: 'Encode', href: '/encode', desc: 'Signals → raw' },
          { label: 'Plot', href: '/plot', desc: 'Live monitor' },
          { label: 'Convert', href: '/convert', desc: 'candump ↔ cansend' },
          { label: 'Changelog', href: '/changelog', desc: 'Version history' },
        ] as p}
          <a href={p.href} style="display: flex; flex-direction: column; padding: 10px 16px; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius); text-decoration: none; min-width: 110px;">
            <span style="font-weight: 600; color: var(--accent);">{p.label}</span>
            <span style="font-size: 12px; color: var(--text-dim); margin-top: 2px;">{p.desc}</span>
          </a>
        {/each}
      </div>
    </div>

    <div class="card">
      <h2 id="getting-started">Getting Started</h2>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">1. Load a Config File</h3>
      <p>Click <strong>"+ Files"</strong> in the navbar to upload one or more <code>.yaml</code> / <code>.yml</code> / <code>.xml</code> config files. You can also click <strong>"+ Folder"</strong> to load an entire directory at once.</p>
      <p style="margin-top: 8px;">If you don't have a config file yet, use a built-in template on the <a href="/">Messages</a> page. Templates include example motor controller definitions.</p>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">2. Browse Messages</h3>
      <p>After loading, the <a href="/">Messages</a> page lists all decoded message definitions grouped by device. Each row shows the CAN ID, message name, direction (TX/RX), DLC, and description.</p>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">3. Use Decode / Encode / Plot</h3>
      <p>Navigate to any tool page using the nav bar. The loaded configs are shared across all pages in the same session.</p>
    </div>

    <div class="card">
      <h2 id="pages">Page Reference</h2>

      <div class="doc-section">
        <div class="doc-section-label">
          <a href="/" class="section-link">Messages <span style="font-size: 11px; font-weight: 400;">/</span></a>
        </div>
        <div class="doc-section-body">
          <p>Browse all loaded message definitions.</p>
          <ul class="doc-list">
            <li>Search by name or description</li>
            <li>Filter by device using the dropdown</li>
            <li>Toggle messages on/off — disabled messages are skipped during decoding</li>
            <li>Expand a message row to see its signals and configure filters:</li>
          </ul>
          <div style="margin-top: 8px; margin-left: 16px;">
            <p style="font-size: 13px; color: var(--text-dim); margin-bottom: 4px;"><strong style="color: var(--text);">Node filter</strong> — for multi-node messages, enable/disable individual node IDs</p>
            <p style="font-size: 13px; color: var(--text-dim); margin-bottom: 4px;"><strong style="color: var(--text);">Enum value filter</strong> — for signals with named values (e.g. <code>register_id</code>), show only specific values</p>
            <p style="font-size: 13px; color: var(--text-dim);"><strong style="color: var(--text);">Signal filter</strong> — hide individual signals from decode output</p>
          </div>
          <p style="margin-top: 8px; font-size: 13px; color: var(--text-dim);">A <span style="background: rgba(210,153,34,0.15); color: var(--orange); padding: 1px 5px; border-radius: 3px; font-size: 11px;">filtered</span> badge appears on messages with active filters.</p>
        </div>
      </div>

      <div class="doc-section">
        <div class="doc-section-label">
          <a href="/decode" class="section-link">Decode <span style="font-size: 11px; font-weight: 400;">/decode</span></a>
        </div>
        <div class="doc-section-body">
          <p>Decode a single raw CAN frame into human-readable signal values.</p>
          <ul class="doc-list">
            <li>Enter the CAN ID in hex (e.g. <code>0x481</code> or <code>481</code>)</li>
            <li>Paste the payload bytes space-separated (e.g. <code>FF 7F 66 26 66 06 00 08</code>)</li>
            <li>Click <strong>Decode</strong> — matching message name and all signal values are shown</li>
            <li>Multi-node messages show the resolved node ID alongside the message name</li>
            <li>MAVLink frames: check <strong>MAVLink mode</strong> to parse 29-bit extended IDs and MAVLink v2 framing</li>
          </ul>
        </div>
      </div>

      <div class="doc-section">
        <div class="doc-section-label">
          <a href="/encode" class="section-link">Encode <span style="font-size: 11px; font-weight: 400;">/encode</span></a>
        </div>
        <div class="doc-section-body">
          <p>Build a raw CAN frame from signal values.</p>
          <ul class="doc-list">
            <li>Select a message from the dropdown (loaded from configs)</li>
            <li>For multi-node messages, set the target node ID</li>
            <li>Fill in signal values — enum signals show a dropdown of named options</li>
            <li>Click <strong>Encode</strong> to generate the frame</li>
            <li>Output is shown as hex bytes and in cansend format (<code>can0 481##1FF7F…</code>)</li>
            <li>Click <strong>Copy</strong> to copy the cansend command to clipboard</li>
          </ul>
        </div>
      </div>

      <div class="doc-section">
        <div class="doc-section-label">
          <a href="/plot" class="section-link">Plot <span style="font-size: 11px; font-weight: 400;">/plot</span></a>
        </div>
        <div class="doc-section-body">
          <p>Signal plotter and live CAN monitor.</p>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">Paste mode</p>
          <ul class="doc-list">
            <li>Paste <code>candump -ta</code> output directly into the text area</li>
            <li>All decodable frames are parsed and signals are plotted over time</li>
            <li>A raw frame log shows the original candump lines</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">Live mode</p>
          <ul class="doc-list">
            <li>Download the server script (<strong>Download can_ws_server.py</strong>), run it on the machine with the CAN interface</li>
            <li>Enter the WebSocket URL (default <code>ws://localhost:8765</code>) and click <strong>Connect</strong></li>
            <li>Frames stream in real time; use <strong>Pause</strong> to freeze collection without disconnecting</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">Chart controls</p>
          <ul class="doc-list">
            <li><strong>Signal selector</strong> — check/uncheck series; drag to group into panels</li>
            <li><strong>Views</strong> — Signals (line chart), Timeline (per-message event timing), Interval (per-signal delta-time)</li>
            <li><strong>Zoom</strong> — scroll wheel, pinch, or drag to zoom; double-click to reset</li>
            <li><strong>Timeline markers A/B</strong> — click on the timeline chart to set markers and measure Δt</li>
            <li><strong>t=0 origin</strong> — right-click a data point in the timeline to set it as the time origin</li>
            <li><strong>Export Layout</strong> / <strong>Import Layout</strong> — save/restore panel arrangement as YAML</li>
            <li><strong>Save PNG</strong> — export all charts as a PNG image</li>
            <li><strong>Record to file</strong> — save raw frames to a <code>.log</code> file during live capture</li>
            <li><strong>Clear</strong> — reset all collected data</li>
          </ul>
        </div>
      </div>

      <div class="doc-section">
        <div class="doc-section-label">
          <a href="/convert" class="section-link">Convert <span style="font-size: 11px; font-weight: 400;">/convert</span></a>
        </div>
        <div class="doc-section-body">
          <p>Convert between <code>candump -ta</code> timestamped format and <code>cansend</code> replay format.</p>
          <ul class="doc-list">
            <li>Paste candump output on the left</li>
            <li>The right panel shows equivalent <code>cansend</code> commands</li>
            <li>Useful for replaying captures or scripting test sequences</li>
          </ul>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 id="live-monitor">Live Monitor Setup</h2>
      <p style="margin-top: 8px;">The Plot page can receive real-time CAN frames via WebSocket. You need to run a small bridge server on the machine that has the CAN interface.</p>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">Step 1 — Download the server script</h3>
      <p>On the <a href="/plot">Plot</a> page, expand <strong>"Server setup guide"</strong> and click <strong>"Download can_ws_server.py"</strong>. Copy it to the machine with the CAN interface.</p>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">Step 2 — Install requirements</h3>
      <pre><code class="doc-code"># SocketCAN (Linux built-in driver — most common setup)
sudo apt install can-utils        # provides candump — no pip needed

# USB adapters (SLCAN, PCAN, gs_usb python-can backend)
pip install python-can&gt;=4.0 pyserial&gt;=3.5
# or via the package:
pip install "canfd-codec[serve]"</code></pre>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">Step 3 — Run the server</h3>
      <pre><code class="doc-code"># SocketCAN interface
python3 can_ws_server.py --bus can0

# Virtual CAN (for testing)
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan &amp;&amp; sudo ip link set up vcan0
python3 can_ws_server.py --bus vcan0

# USB SLCAN adapter (CAN FD)
python3 can_ws_server.py --bus /dev/ttyACM0 --interface slcan \
    --bitrate 1000000 --data-bitrate 5000000

# LAN relay — run on remote CAN machine, re-serve on this PC
python3 can_ws_server.py --source ws://192.168.x.x:8765</code></pre>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">Step 4 — Connect in the browser</h3>
      <p>Go to the <a href="/plot">Plot</a> page, enter <code>ws://localhost:8765</code> in the URL field, and click <strong>Connect</strong>.</p>

      <div style="margin-top: 16px; padding: 12px 16px; background: var(--bg-input); border-left: 3px solid var(--orange); border-radius: 0 var(--radius) var(--radius) 0; font-size: 13px;">
        <strong>Browser security note:</strong> Some browsers block connections to <code>localhost</code> from HTTPS pages. If you are using the hosted web app, either run it locally (<code>npm run dev</code>) or use the relay mode from a local instance.
      </div>
    </div>

    <div class="card">
      <h2 id="config-reference">Config File Reference</h2>
      <p style="margin-top: 8px;">Device configs are YAML files that define CAN message layouts. Place them in the <code>configs/</code> directory or load them directly in the browser.</p>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">Minimal example</h3>
      <pre><code class="doc-code">device:
  name: "My Device"
  bus: "can0"

messages:
  - id: 0x100
    name: "SpeedCommand"
    dlc: 4
    signals:
      - name: "speed"
        start_bit: 0
        bit_length: 16
        scale: 0.1
        unit: "rpm"
      - name: "direction"
        start_bit: 16
        bit_length: 8
        enum:
          0: "stop"
          1: "forward"
          2: "reverse"</code></pre>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">Signal fields</h3>
      <div style="overflow-x: auto;">
        <table style="font-size: 13px; width: 100%;">
          <thead>
            <tr>
              <th style="text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--border); color: var(--text-dim); font-weight: 600;">Field</th>
              <th style="text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--border); color: var(--text-dim); font-weight: 600;">Required</th>
              <th style="text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--border); color: var(--text-dim); font-weight: 600;">Default</th>
              <th style="text-align: left; padding: 6px 0; border-bottom: 1px solid var(--border); color: var(--text-dim); font-weight: 600;">Description</th>
            </tr>
          </thead>
          <tbody>
            {#each [
              ['name', 'yes', '—', 'Signal name used in encode/decode'],
              ['start_bit', 'yes', '—', 'Bit offset in the payload'],
              ['bit_length', 'yes', '—', 'Number of bits'],
              ['byte_order', 'no', 'little_endian', 'little_endian or big_endian'],
              ['value_type', 'no', 'unsigned', 'unsigned · signed · float32 · float64'],
              ['scale', 'no', '1.0', 'physical = raw × scale + offset'],
              ['offset', 'no', '0.0', 'See scale'],
              ['min / max', 'no', '—', 'Physical range (used with linear_map)'],
              ['linear_map', 'no', 'false', 'Auto-calculate scale/offset from min/max'],
              ['unit', 'no', '""', 'Display unit string'],
              ['default', 'no', '—', 'Default value when encoding (omitted signals)'],
              ['constant', 'no', 'false', 'Always use default; user cannot override'],
              ['enum', 'no', '—', 'Map of int → name for named values'],
              ['bitfield', 'no', '—', 'Map of bit_position → flag_name'],
            ] as [field, req, def, desc]}
              <tr>
                <td style="padding: 5px 12px 5px 0; font-family: var(--font-mono); color: var(--accent); font-size: 12px;">{field}</td>
                <td style="padding: 5px 12px 5px 0; color: {req === 'yes' ? 'var(--green)' : 'var(--text-dim)'}; font-size: 12px;">{req}</td>
                <td style="padding: 5px 12px 5px 0; font-family: var(--font-mono); color: var(--text-dim); font-size: 12px;">{def}</td>
                <td style="padding: 5px 0; font-size: 12px;">{desc}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <h3 style="margin-top: 20px; margin-bottom: 8px; font-size: 15px;">Multi-node messages</h3>
      <p style="font-size: 13px;">For systems with multiple identical devices (e.g. 7 motors on IDs 0x481–0x487):</p>
      <pre><code class="doc-code">- id: 0x480          # base ID
  name: "PositionControl"
  node_count: 7       # 7 nodes
  node_id_offset: 1   # ID step per node
  node_id_start: 1    # first valid node_id (nodes 1–7)
  # actual IDs: 0x481, 0x482, ..., 0x487</code></pre>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">MAVLink XML</h3>
      <p style="font-size: 13px;">Load standard or custom MAVLink XML files the same way as YAML. The codec maps MAVLink message IDs to CAN frames automatically.</p>
    </div>

    <div class="card">
      <h2 id="cli">CLI Reference</h2>
      <p style="margin-top: 8px; font-size: 13px;">Install the Python package to use the CLI. The <code>-c</code> flag must come before the subcommand.</p>
      <pre><code class="doc-code">pip install canfd-codec

canfd-codec -c ./configs list
canfd-codec -c ./configs describe MITControl
canfd-codec -c ./configs decode 0x481 "FF 7F 66 26 66 06 00 08"
canfd-codec -c ./configs encode MITControl position=1.57 velocity=2.0 --node 1
canfd-codec -c ./configs encode MITControl position=1.57 --node 1 --cansend
canfd-codec -c ./configs monitor --bus can0
canfd-codec -c ./configs monitor --bus can0 --summary   # live table

# Start WebSocket server for web UI live monitor
canfd-codec -c ./configs serve --bus can0
canfd-codec -c ./configs serve --bus /dev/ttyACM0 --interface slcan --bitrate 1000000</code></pre>
    </div>

  {:else}
    <!-- ====== CHINESE ====== -->

    <div class="card">
      <h2 id="overview-zh">概览</h2>
      <p style="margin-top: 8px;">CAN Codec 是一个基于浏览器的 CAN/CAN-FD 消息编解码工具。加载设备的 YAML 或 MAVLink XML 配置文件，即可通过网页界面浏览消息定义、解码原始帧、编码信号值，并实时监控 CAN 数据。</p>
      <p style="margin-top: 8px; color: var(--text-dim); font-size: 13px;">所有处理均在浏览器本地完成，数据不会离开您的设备。</p>

      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px;">
        {#each [
          { label: 'Messages（消息）', href: '/', desc: '浏览与筛选' },
          { label: 'Decode（解码）', href: '/decode', desc: '原始帧 → 信号' },
          { label: 'Encode（编码）', href: '/encode', desc: '信号 → 原始帧' },
          { label: 'Plot（绘图）', href: '/plot', desc: '实时监控' },
          { label: 'Convert（转换）', href: '/convert', desc: 'candump ↔ cansend' },
          { label: 'Changelog（更新日志）', href: '/changelog', desc: '版本历史' },
        ] as p}
          <a href={p.href} style="display: flex; flex-direction: column; padding: 10px 16px; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius); text-decoration: none; min-width: 140px;">
            <span style="font-weight: 600; color: var(--accent); font-size: 13px;">{p.label}</span>
            <span style="font-size: 12px; color: var(--text-dim); margin-top: 2px;">{p.desc}</span>
          </a>
        {/each}
      </div>
    </div>

    <div class="card">
      <h2 id="getting-started-zh">快速上手</h2>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">1. 加载配置文件</h3>
      <p>点击导航栏中的 <strong>"+ Files"</strong> 上传一个或多个 <code>.yaml</code> / <code>.yml</code> / <code>.xml</code> 配置文件。也可点击 <strong>"+ Folder"</strong> 一次性加载整个目录。</p>
      <p style="margin-top: 8px;">如果您还没有配置文件，可在 <a href="/">Messages</a> 页面使用内置模板，模板包含示例电机控制器的消息定义。</p>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">2. 浏览消息定义</h3>
      <p>加载完成后，<a href="/">Messages</a> 页面会按设备分组展示所有消息定义。每行显示 CAN ID、消息名称、收发方向（TX/RX）、DLC 和描述。</p>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">3. 使用解码 / 编码 / 绘图功能</h3>
      <p>通过导航栏切换到任意工具页面。当前会话加载的配置文件在所有页面间共享。</p>
    </div>

    <div class="card">
      <h2 id="pages-zh">页面说明</h2>

      <div class="doc-section">
        <div class="doc-section-label">
          <a href="/" class="section-link">Messages <span style="font-size: 11px; font-weight: 400;">/</span></a>
        </div>
        <div class="doc-section-body">
          <p>浏览所有已加载的消息定义。</p>
          <ul class="doc-list">
            <li>按名称或描述搜索</li>
            <li>通过下拉框按设备过滤</li>
            <li>开关消息的启用状态——被禁用的消息在解码时会被跳过</li>
            <li>展开消息行可查看信号详情并配置过滤器：</li>
          </ul>
          <div style="margin-top: 8px; margin-left: 16px;">
            <p style="font-size: 13px; color: var(--text-dim); margin-bottom: 4px;"><strong style="color: var(--text);">节点过滤器</strong>——多节点消息可单独启用/禁用某个节点 ID</p>
            <p style="font-size: 13px; color: var(--text-dim); margin-bottom: 4px;"><strong style="color: var(--text);">枚举值过滤器</strong>——对含枚举值的信号（如 <code>register_id</code>），只显示特定枚举值的帧</p>
            <p style="font-size: 13px; color: var(--text-dim);"><strong style="color: var(--text);">信号过滤器</strong>——在解码输出中隐藏指定信号</p>
          </div>
          <p style="margin-top: 8px; font-size: 13px; color: var(--text-dim);">有活动过滤器的消息行会显示 <span style="background: rgba(210,153,34,0.15); color: var(--orange); padding: 1px 5px; border-radius: 3px; font-size: 11px;">filtered</span> 标签。</p>
        </div>
      </div>

      <div class="doc-section">
        <div class="doc-section-label">
          <a href="/decode" class="section-link">Decode <span style="font-size: 11px; font-weight: 400;">/decode</span></a>
        </div>
        <div class="doc-section-body">
          <p>将单个原始 CAN 帧解码为人类可读的信号值。</p>
          <ul class="doc-list">
            <li>输入十六进制 CAN ID（如 <code>0x481</code> 或 <code>481</code>）</li>
            <li>粘贴以空格分隔的负载字节（如 <code>FF 7F 66 26 66 06 00 08</code>）</li>
            <li>点击 <strong>Decode</strong>——显示匹配的消息名称及所有信号值</li>
            <li>多节点消息会在消息名旁显示解析出的节点 ID</li>
            <li>MAVLink 帧：勾选 <strong>MAVLink mode</strong> 以解析 29 位扩展 ID 和 MAVLink v2 帧结构</li>
          </ul>
        </div>
      </div>

      <div class="doc-section">
        <div class="doc-section-label">
          <a href="/encode" class="section-link">Encode <span style="font-size: 11px; font-weight: 400;">/encode</span></a>
        </div>
        <div class="doc-section-body">
          <p>由信号值生成原始 CAN 帧。</p>
          <ul class="doc-list">
            <li>从下拉框中选择消息（来自已加载的配置文件）</li>
            <li>多节点消息需设置目标节点 ID</li>
            <li>填写信号值——枚举信号显示命名选项下拉框</li>
            <li>点击 <strong>Encode</strong> 生成帧</li>
            <li>输出为十六进制字节，并提供 cansend 格式（<code>can0 481##1FF7F…</code>）</li>
            <li>点击 <strong>Copy</strong> 将 cansend 命令复制到剪贴板</li>
          </ul>
        </div>
      </div>

      <div class="doc-section">
        <div class="doc-section-label">
          <a href="/plot" class="section-link">Plot <span style="font-size: 11px; font-weight: 400;">/plot</span></a>
        </div>
        <div class="doc-section-body">
          <p>信号绘图器与实时 CAN 监控。</p>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">粘贴模式</p>
          <ul class="doc-list">
            <li>将 <code>candump -ta</code> 输出直接粘贴到文本框</li>
            <li>所有可解码的帧会被解析，信号按时间绘制成图表</li>
            <li>原始帧日志显示原始 candump 行</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">实时模式</p>
          <ul class="doc-list">
            <li>下载服务端脚本（<strong>Download can_ws_server.py</strong>），在连接了 CAN 接口的机器上运行</li>
            <li>输入 WebSocket URL（默认 <code>ws://localhost:8765</code>）并点击 <strong>Connect</strong></li>
            <li>帧数据实时流入；点击 <strong>Pause</strong> 可暂停数据采集而不断开连接</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">图表操作</p>
          <ul class="doc-list">
            <li><strong>信号选择器</strong>——勾选/取消信号系列；拖拽可分组到不同面板</li>
            <li><strong>视图切换</strong>——Signals（折线图）、Timeline（消息事件时序）、Interval（逐信号时间间隔）</li>
            <li><strong>缩放</strong>——滚轮缩放、双指缩放或框选缩放；双击复位</li>
            <li><strong>时间线标记 A/B</strong>——在时序图上点击设置标记并测量 Δt</li>
            <li><strong>t=0 起点</strong>——在时序图上右键点击数据点，将其设为时间原点</li>
            <li><strong>导出/导入布局</strong>——将面板排列保存为 YAML 文件</li>
            <li><strong>保存 PNG</strong>——将所有图表导出为 PNG 图像</li>
            <li><strong>录制到文件</strong>——实时采集时将原始帧保存为 <code>.log</code> 文件</li>
            <li><strong>Clear</strong>——清空所有已采集数据</li>
          </ul>
        </div>
      </div>

      <div class="doc-section">
        <div class="doc-section-label">
          <a href="/convert" class="section-link">Convert <span style="font-size: 11px; font-weight: 400;">/convert</span></a>
        </div>
        <div class="doc-section-body">
          <p>在 <code>candump -ta</code> 带时间戳格式与 <code>cansend</code> 回放格式之间互相转换。</p>
          <ul class="doc-list">
            <li>在左侧粘贴 candump 输出</li>
            <li>右侧面板显示对应的 <code>cansend</code> 命令</li>
            <li>适用于回放录制内容或编写测试脚本</li>
          </ul>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 id="live-monitor-zh">实时监控配置</h2>
      <p style="margin-top: 8px;">Plot 页面可通过 WebSocket 接收实时 CAN 帧。您需要在连接了 CAN 接口的机器上运行一个小型桥接服务器。</p>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">第一步——下载服务端脚本</h3>
      <p>在 <a href="/plot">Plot</a> 页面展开 <strong>"Server setup guide"</strong>，点击 <strong>"Download can_ws_server.py"</strong>，将文件复制到有 CAN 接口的机器上。</p>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">第二步——安装依赖</h3>
      <pre><code class="doc-code"># SocketCAN（Linux 内置驱动——最常见）
sudo apt install can-utils         # 提供 candump，无需 pip

# USB 适配器（SLCAN、PCAN、gs_usb python-can 后端）
pip install python-can&gt;=4.0 pyserial&gt;=3.5
# 或通过包安装：
pip install "canfd-codec[serve]"</code></pre>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">第三步——启动服务器</h3>
      <pre><code class="doc-code"># SocketCAN 接口
python3 can_ws_server.py --bus can0

# 虚拟 CAN（用于测试）
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan &amp;&amp; sudo ip link set up vcan0
python3 can_ws_server.py --bus vcan0

# USB SLCAN 适配器（CAN FD）
python3 can_ws_server.py --bus /dev/ttyACM0 --interface slcan \
    --bitrate 1000000 --data-bitrate 5000000

# 局域网中继——在远端 CAN 机器上运行，在本机转发
python3 can_ws_server.py --source ws://192.168.x.x:8765</code></pre>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">第四步——在浏览器中连接</h3>
      <p>打开 <a href="/plot">Plot</a> 页面，在 URL 输入框中填写 <code>ws://localhost:8765</code>，点击 <strong>Connect</strong> 即可连接。</p>

      <div style="margin-top: 16px; padding: 12px 16px; background: var(--bg-input); border-left: 3px solid var(--orange); border-radius: 0 var(--radius) var(--radius) 0; font-size: 13px;">
        <strong>浏览器安全提示：</strong>部分浏览器会阻止从 HTTPS 页面连接 <code>localhost</code>。如果您使用的是托管版网页，请在本地运行（<code>npm run dev</code>）或使用中继模式通过本地实例访问。
      </div>
    </div>

    <div class="card">
      <h2 id="config-reference-zh">配置文件参考</h2>
      <p style="margin-top: 8px;">设备配置文件是 YAML 格式，用于定义 CAN 消息结构。可放置在 <code>configs/</code> 目录，也可直接在浏览器中加载。</p>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">最小示例</h3>
      <pre><code class="doc-code">device:
  name: "我的设备"
  bus: "can0"

messages:
  - id: 0x100
    name: "SpeedCommand"
    dlc: 4
    signals:
      - name: "speed"
        start_bit: 0
        bit_length: 16
        scale: 0.1
        unit: "rpm"
      - name: "direction"
        start_bit: 16
        bit_length: 8
        enum:
          0: "stop"
          1: "forward"
          2: "reverse"</code></pre>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">信号字段说明</h3>
      <div style="overflow-x: auto;">
        <table style="font-size: 13px; width: 100%;">
          <thead>
            <tr>
              <th style="text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--border); color: var(--text-dim); font-weight: 600;">字段</th>
              <th style="text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--border); color: var(--text-dim); font-weight: 600;">必填</th>
              <th style="text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--border); color: var(--text-dim); font-weight: 600;">默认值</th>
              <th style="text-align: left; padding: 6px 0; border-bottom: 1px solid var(--border); color: var(--text-dim); font-weight: 600;">说明</th>
            </tr>
          </thead>
          <tbody>
            {#each [
              ['name', '是', '—', '信号名称，用于编解码'],
              ['start_bit', '是', '—', '在负载中的位偏移'],
              ['bit_length', '是', '—', '位数'],
              ['byte_order', '否', 'little_endian', 'little_endian 或 big_endian'],
              ['value_type', '否', 'unsigned', 'unsigned · signed · float32 · float64'],
              ['scale', '否', '1.0', '物理值 = 原始值 × scale + offset'],
              ['offset', '否', '0.0', '参见 scale'],
              ['min / max', '否', '—', '物理值范围（与 linear_map 配合使用）'],
              ['linear_map', '否', 'false', '由 min/max 自动计算 scale/offset'],
              ['unit', '否', '""', '显示单位字符串'],
              ['default', '否', '—', '编码时的默认值（信号未提供时使用）'],
              ['constant', '否', 'false', '始终使用默认值，用户无法覆盖'],
              ['enum', '否', '—', '整数 → 名称的枚举映射'],
              ['bitfield', '否', '—', '位位置 → 标志名称的映射'],
            ] as [field, req, def, desc]}
              <tr>
                <td style="padding: 5px 12px 5px 0; font-family: var(--font-mono); color: var(--accent); font-size: 12px;">{field}</td>
                <td style="padding: 5px 12px 5px 0; color: {req === '是' ? 'var(--green)' : 'var(--text-dim)'}; font-size: 12px;">{req}</td>
                <td style="padding: 5px 12px 5px 0; font-family: var(--font-mono); color: var(--text-dim); font-size: 12px;">{def}</td>
                <td style="padding: 5px 0; font-size: 12px;">{desc}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <h3 style="margin-top: 20px; margin-bottom: 8px; font-size: 15px;">多节点消息</h3>
      <p style="font-size: 13px;">适用于多个相同设备的场景（如 7 个电机分别占用 ID 0x481–0x487）：</p>
      <pre><code class="doc-code">- id: 0x480          # 基础 ID
  name: "PositionControl"
  node_count: 7       # 7 个节点
  node_id_offset: 1   # 每个节点的 ID 步长
  node_id_start: 1    # 起始节点 ID（节点 1–7）
  # 实际 ID：0x481, 0x482, ..., 0x487</code></pre>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">MAVLink XML</h3>
      <p style="font-size: 13px;">以与 YAML 相同的方式加载标准或自定义 MAVLink XML 文件。编解码器会自动将 MAVLink 消息 ID 映射到 CAN 帧。</p>
    </div>

    <div class="card">
      <h2 id="cli-zh">命令行参考</h2>
      <p style="margin-top: 8px; font-size: 13px;">安装 Python 包后即可使用命令行工具。<code>-c</code> 参数必须放在子命令之前。</p>
      <pre><code class="doc-code">pip install canfd-codec

canfd-codec -c ./configs list
canfd-codec -c ./configs describe MITControl
canfd-codec -c ./configs decode 0x481 "FF 7F 66 26 66 06 00 08"
canfd-codec -c ./configs encode MITControl position=1.57 velocity=2.0 --node 1
canfd-codec -c ./configs encode MITControl position=1.57 --node 1 --cansend
canfd-codec -c ./configs monitor --bus can0
canfd-codec -c ./configs monitor --bus can0 --summary   # 实时汇总表

# 启动 WebSocket 服务器供网页实时监控使用
canfd-codec -c ./configs serve --bus can0
canfd-codec -c ./configs serve --bus /dev/ttyACM0 --interface slcan --bitrate 1000000</code></pre>
    </div>

  {/if}
</div>

<style>
  h2 {
    font-size: 18px;
    font-weight: 700;
  }

  .doc-section {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 16px;
    padding: 16px 0;
    border-top: 1px solid var(--border);
  }
  .doc-section:first-of-type {
    margin-top: 16px;
  }

  .doc-section-label {
    padding-top: 2px;
  }

  .section-link {
    font-weight: 700;
    font-size: 15px;
    color: var(--text);
    text-decoration: none;
  }
  .section-link:hover {
    color: var(--accent);
  }

  .doc-section-body p {
    font-size: 14px;
    margin-bottom: 6px;
  }

  .doc-list {
    font-size: 13px;
    padding-left: 20px;
    color: var(--text);
    line-height: 1.8;
  }
  .doc-list li {
    margin-bottom: 2px;
  }

  .doc-code {
    font-family: var(--font-mono);
    font-size: 12px;
  }

  pre {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    overflow-x: auto;
    margin-top: 8px;
    margin-bottom: 4px;
  }

  code {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
  }

  p code {
    background: var(--bg-input);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 12px;
    color: var(--accent);
  }

  @media (max-width: 640px) {
    .doc-section {
      grid-template-columns: 1fr;
      gap: 8px;
    }
  }
</style>
