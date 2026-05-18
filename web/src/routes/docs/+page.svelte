<script lang="ts">
  import { i18n } from '$lib/i18n.svelte';
  const lang = $derived(i18n.locale);
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
    <div style="display: flex; align-items: center; gap: 8px;">
      <a
        href="https://github.com/LueApp/can-codec"
        target="_blank"
        rel="noopener noreferrer"
        style="display: flex; align-items: center; gap: 6px; padding: 4px 12px; font-size: 13px; color: var(--text-dim); background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius); text-decoration: none;"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.342-3.369-1.342-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.579.688.481C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
        </svg>
        GitHub
      </a>
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
          { label: 'Program', href: '/program', desc: 'Notebook + closed-loop' },
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

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">3. Use Decode / Encode / Program / Plot</h3>
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
            <li>If you're connected to a bus, click <strong>Send to bus</strong> to transmit. Click <strong>+ Sequence</strong> to push the current message into the Program page as a Send block.</li>
          </ul>
        </div>
      </div>

      <div class="doc-section">
        <div class="doc-section-label">
          <a href="/program" class="section-link">Program <span style="font-size: 11px; font-weight: 400;">/program</span></a>
        </div>
        <div class="doc-section-body">
          <p>Build and run multi-step CAN command sequences (a small AST of statements). Mix open-loop sends with closed-loop signal bindings to react to live telemetry.</p>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">Connection</p>
          <ul class="doc-list">
            <li>Shares the same bus connection as the Plot and Encode pages. Connect once on any page and all three see live frames.</li>
            <li>Use the <strong>Download server script</strong> button if you haven't set up the bridge yet — see <a href="#live-monitor">Live Monitor Setup</a>.</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">Statement types</p>
          <ul class="doc-list">
            <li><strong>Send</strong> — encode and transmit a CAN frame. Pick a message, fill values, set node id (or expression for multi-node). For messages with a broadcast id, tick <strong>broadcast</strong> to address all nodes in one frame — node tabs appear so you can edit each node's values independently.</li>
            <li><strong>Wait</strong> — sleep for N ms.</li>
            <li><strong>Repeat</strong> — run a body N times.</li>
            <li><strong>Every</strong> — fire a body on a periodic timer. Unset <em>duration</em> runs in the background while the rest of the sequence continues; set <em>duration</em> blocks for that many ms.</li>
            <li><strong>Sweep</strong> — auto-generate a series of Sends stepping one signal from <code>from</code> to <code>to</code> by <code>step</code>, one frame every <em>period</em> ms.</li>
            <li><strong>Group</strong> — labeled container for organisation. Top-level groups also act as notebook cells (see below).</li>
            <li><strong>Set</strong> — assign <code>name = expr</code>. Expressions support <code>+ - * / %</code>, parentheses, hex/decimal/binary literals, and references to other variables.</li>
            <li><strong>Bind</strong> — continuous closed loop: <code>varName ← Msg.signal</code>. Each matching RX frame decodes the signal's physical value and writes it to the variable. Persists across runs until the binding is replaced or <em>Reset vars</em> is clicked.</li>
            <li><strong>Read</strong> — one-shot blocking variant of Bind: waits for the next matching frame (with a timeout), writes the value, then advances.</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">Variables &amp; expressions</p>
          <ul class="doc-list">
            <li>Any Send field can take an expression by prefixing with <code>=</code>: e.g. <code>position = =target_pos * 2</code>.</li>
            <li><code>nodeId</code> on Send, Bind and Read accepts the same syntax — handy for closed-loop control of one motor out of many: <code>set motor_idx = 2; bind pos ← Telemetry.position @=motor_idx</code>.</li>
            <li>Forgetting the <code>=</code> in front of a variable name raises a friendly error (no silent <code>NaN</code> sends).</li>
            <li>Variables persist across cell runs and Run All — only <strong>Reset vars</strong> clears them.</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">Notebook-style cells</p>
          <ul class="doc-list">
            <li>Each top-level <strong>Group</strong> block gets its own ▶ Run button (Jupyter-cell style).</li>
            <li>Click ▶ to run just that cell. Variables set in one cell are visible to the next.</li>
            <li><strong>Run All</strong> runs the whole sequence top to bottom; <strong>Stop</strong> cancels in-flight wait/every/read.</li>
            <li><strong>Reset vars</strong> wipes the vars map and drops all active bindings (use to start fresh).</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">Drag &amp; rearrange</p>
          <ul class="doc-list">
            <li>Click and drag any block (anywhere on the row) to a new position — before, after, or inside a container.</li>
            <li><strong>Shift+click</strong> a second block (same parent) to select a contiguous range; drag any of them to move the whole range together.</li>
            <li><kbd>Esc</kbd> clears the selection. <strong>⎘</strong> duplicates a block; <strong>×</strong> removes it.</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">Live bindings panel</p>
          <ul class="doc-list">
            <li>Appears under the run controls whenever a Bind has been executed.</li>
            <li>Each row shows <code>varName ← Msg.signal[@node] : lastValue  Ns ago</code>, updated on every matching frame.</li>
            <li>Bindings re-resolve their <code>nodeId</code> expression once, when the Bind statement executes — re-run the cell to chase a moving target.</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">TX/RX in the Plot view</p>
          <ul class="doc-list">
            <li>Frames the Program page transmits also appear in <a href="/plot">Plot</a>, tagged <strong>TX</strong> in the status bar, raw log and chart tooltips so you can correlate command and response on one timeline.</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">Import / Export</p>
          <ul class="doc-list">
            <li><strong>Export</strong> saves the current sequence as JSON for sharing or version control.</li>
            <li><strong>Import</strong> loads a JSON file back into the page.</li>
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
            <li><strong>Zoom &amp; pan</strong> — scroll wheel zooms time; <kbd>Shift</kbd>+scroll zooms value; <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+scroll zooms both. Left-drag pans, <kbd>Shift</kbd>+drag box-zooms, double-click fits to data. Pinch on touch zooms both axes.</li>
            <li><strong>Fit X / Fit Y / Fit</strong> — toolbar buttons. <em>Fit</em> resets both axes, <em>Fit X</em> auto-scales only the time axis (preserves Y zoom), <em>Fit Y</em> only the value axis.</li>
            <li><strong>Follow live</strong> (live mode only) — auto-scrolls the X axis with a rolling window. Adjust the window seconds inline. <em>Manually zooming or panning pauses follow</em> so you can investigate without the stream snapping you back; click <em>Follow live</em> again to resume.</li>
            <li><strong>Click a data point</strong> — copies the candump line (id + bytes + timestamp) to the clipboard</li>
            <li><strong>Timeline markers A/B</strong> — click <em>Measure Δt</em> then pick two frames on the timeline to measure time delta</li>
            <li><strong>t=0 origin</strong> — click <em>Set t=0</em> then pick a frame on the timeline to make it the time origin</li>
            <li><strong>Export Layout</strong> / <strong>Import Layout</strong> — save/restore panel arrangement as YAML</li>
            <li><strong>Save PNG</strong> — export all charts as a PNG image</li>
            <li><strong>Record to file</strong> — save raw frames to a <code>.log</code> file during live capture</li>
            <li><strong>Clear</strong> — reset all collected data</li>
          </ul>
          <p style="margin-top: 8px; font-size: 12px; color: var(--text-dim);">Tip: the <kbd>?</kbd> button next to <em>Clear</em> on the Plot page re-shows the gesture cheat-sheet if you've dismissed it.</p>
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

      <h3 id="usb-permissions" style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">Step 3 — USB adapter permissions (Linux, USB SLCAN/SLCANFD devices only)</h3>
      <p style="font-size: 13px;">If you're using a USB-to-CAN(FD) adapter such as <strong>CANable v2 / USB2SLCANFD</strong>, Linux by default exposes it as a <code>/dev/ttyACM*</code> device that only <code>root</code> can open. Skip this step if you only use built-in SocketCAN (<code>can0</code>, <code>vcan0</code>) — those don't go through <code>/dev/tty*</code>.</p>
      <p style="font-size: 13px; margin-top: 8px;"><strong>Symptoms of missing permission:</strong></p>
      <ul class="doc-list">
        <li><code>[Errno 13] Permission denied: '/dev/ttyACM0'</code> when starting <code>can_ws_server.py</code></li>
        <li><code>serial.serialutil.SerialException: could not open port</code></li>
        <li>ModemManager grabs the port for ~30 s on plug-in and replies to AT commands, corrupting the SLCAN protocol</li>
      </ul>

      <p style="font-size: 13px; margin-top: 10px;"><strong>1. Identify your adapter's USB IDs.</strong> Plug it in and run:</p>
      <pre><code class="doc-code">lsusb | grep -i -E 'can|stm|cdc'
# Example output for CANable v2:
# Bus 001 Device 005: ID 16d0:117e MCS CANable2</code></pre>
      <p style="font-size: 13px;">Note the <code>idVendor:idProduct</code> pair (here <code>16d0:117e</code>). Common USB2SLCANFD adapters: <code>16d0:117e</code> (CANable v2 / canable.io), <code>1d50:606f</code> (gs_usb / CANable v1).</p>

      <p style="font-size: 13px; margin-top: 12px;"><strong>2. Create a udev rule</strong> at <code>/etc/udev/rules.d/99-canable2.rules</code>:</p>
      <pre><code class="doc-code"># /etc/udev/rules.d/99-canable2.rules
# CANable2 / USB-to-CAN-FD adapter — set group + permissions, stop ModemManager hijack
SUBSYSTEM=="usb", ATTR&lcub;idVendor&rcub;=="16d0", ATTR&lcub;idProduct&rcub;=="117e", ENV&lcub;ID_MM_DEVICE_IGNORE&rcub;="1"
SUBSYSTEM=="tty", KERNEL=="ttyACM[0-9]*", ATTRS&lcub;idVendor&rcub;=="16d0", ATTRS&lcub;idProduct&rcub;=="117e", \
    GROUP="dialout", MODE:="0660", TAG+="uaccess", SYMLINK+="usb2can", ENV&lcub;ID_MM_DEVICE_IGNORE&rcub;="1"</code></pre>
      <p style="font-size: 12px; color: var(--text-dim);">If your <code>lsusb</code> showed different IDs, replace the four <code>idVendor</code>/<code>idProduct</code> values with yours. The rule does four things: (1) sets group <code>dialout</code> and rw for owner/group (<code>0660</code>), (2) tags <code>uaccess</code> so the currently logged-in graphical user can access the port without group setup, (3) creates a stable <code>/dev/usb2can</code> symlink so you can write <code>--bus /dev/usb2can</code> instead of guessing <code>ttyACM0</code> / <code>ttyACM1</code>, (4) sets <code>ID_MM_DEVICE_IGNORE=1</code> so ModemManager doesn't probe the adapter.</p>

      <p style="font-size: 13px; margin-top: 12px;"><strong>3. Reload udev and replug the adapter:</strong></p>
      <pre><code class="doc-code">sudo udevadm control --reload-rules
sudo udevadm trigger
# then unplug and replug the USB cable</code></pre>

      <p style="font-size: 13px; margin-top: 12px;"><strong>4. Make sure your user is in the <code>dialout</code> group</strong> (needed only if your distro doesn't honour <code>TAG+="uaccess"</code>):</p>
      <pre><code class="doc-code">sudo usermod -aG dialout $USER
# Then log out and log back in for the new group to take effect.
groups   # verify "dialout" appears</code></pre>

      <p style="font-size: 13px; margin-top: 12px;"><strong>5. Verify permissions:</strong></p>
      <pre><code class="doc-code">ls -l /dev/usb2can /dev/ttyACM*
# Expected: crw-rw---- 1 root dialout ... /dev/ttyACM0
#           lrwxrwxrwx 1 root root    ... /dev/usb2can -> ttyACM0</code></pre>

      <div style="margin-top: 12px; padding: 12px 16px; background: var(--bg-input); border-left: 3px solid var(--orange); border-radius: 0 var(--radius) var(--radius) 0; font-size: 13px;">
        <strong>Troubleshooting:</strong>
        <ul class="doc-list" style="margin-top: 6px;">
          <li>Still "Permission denied" after logging out/in? Run <code>id</code> — if <code>dialout</code> isn't listed, the group change didn't apply (try a full reboot).</li>
          <li>Adapter disconnects randomly mid-stream? ModemManager is still probing — confirm <code>ID_MM_DEVICE_IGNORE=1</code> applied with <code>udevadm info -a /dev/ttyACM0 | grep ID_MM</code>. As a last resort, disable it entirely: <code>sudo systemctl disable --now ModemManager</code>.</li>
          <li>Multiple adapters plugged in? Use the <code>SYMLINK+="usb2can"</code> alias (or extend the rule with <code>ATTRS&lcub;serial&rcub;==...</code> to disambiguate per-serial-number).</li>
        </ul>
      </div>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">Step 4 — Run the server</h3>
      <pre><code class="doc-code"># SocketCAN interface
python3 can_ws_server.py --bus can0

# Virtual CAN (for testing)
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan &amp;&amp; sudo ip link set up vcan0
python3 can_ws_server.py --bus vcan0

# USB SLCAN adapter (CAN FD) — use the /dev/usb2can symlink from the udev rule above
python3 can_ws_server.py --bus /dev/usb2can --interface slcan --bitrate 1000000 --data-bitrate 5000000
# (or --bus /dev/ttyACM0 if you didn't add the SYMLINK)

# LAN relay — run on remote CAN machine, re-serve on this PC
python3 can_ws_server.py --source ws://192.168.x.x:8765</code></pre>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">Step 5 — Connect in the browser</h3>
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
          { label: 'Program（程序）', href: '/program', desc: 'Notebook + 闭环' },
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

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">3. 使用解码 / 编码 / Program / 绘图功能</h3>
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
            <li>若已连接到总线，点击 <strong>Send to bus</strong> 直接发送；点击 <strong>+ Sequence</strong> 把当前消息作为 Send 块推送到 Program 页面。</li>
          </ul>
        </div>
      </div>

      <div class="doc-section">
        <div class="doc-section-label">
          <a href="/program" class="section-link">Program <span style="font-size: 11px; font-weight: 400;">/program</span></a>
        </div>
        <div class="doc-section-body">
          <p>构建并运行多步 CAN 命令序列（小型 AST）。开环发送与闭环信号绑定可混合使用，让程序对实时遥测做出反应。</p>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">连接</p>
          <ul class="doc-list">
            <li>与 Plot、Encode 页面共享同一条总线连接。任一页面连接后，三处都能看到实时帧。</li>
            <li>尚未配置桥接？点击 <strong>Download server script</strong>，或参考 <a href="#live-monitor-zh">实时监控配置</a>。</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">语句类型</p>
          <ul class="doc-list">
            <li><strong>Send</strong>——编码并发送 CAN 帧。选择消息、填写值，设置节点号（也可用表达式）。若消息配置了广播 ID，勾选 <strong>broadcast</strong> 即可一帧寻址所有节点；勾选后会出现节点页签，可分别编辑每个节点的数值。</li>
            <li><strong>Wait</strong>——暂停 N 毫秒。</li>
            <li><strong>Repeat</strong>——将一段子序列执行 N 次。</li>
            <li><strong>Every</strong>——按周期定时触发子序列。未设置 <em>duration</em> 时在后台运行（外层立刻继续）；设置后则阻塞指定毫秒数。</li>
            <li><strong>Sweep</strong>——自动生成一组 Send，将某个信号从 <code>from</code> 步进到 <code>to</code>，每 <em>period</em> 毫秒一帧。</li>
            <li><strong>Group</strong>——带标签的容器。顶层 Group 同时作为 notebook 的 cell（见下文）。</li>
            <li><strong>Set</strong>——赋值 <code>name = expr</code>，支持 <code>+ - * / %</code>、括号、十/十六/二进制字面量，以及对其它变量的引用。</li>
            <li><strong>Bind</strong>——持续闭环：<code>varName ← Msg.signal</code>。每次匹配到的 RX 帧都把该信号的物理值写入变量。绑定持续存在，直到重新绑定或点击 <em>Reset vars</em>。</li>
            <li><strong>Read</strong>——一次性阻塞读取：等待下一条匹配帧（带超时），写入变量后继续。</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">变量与表达式</p>
          <ul class="doc-list">
            <li>Send 字段以 <code>=</code> 开头即视为表达式：例如 <code>position = =target_pos * 2</code>。</li>
            <li>Send、Bind、Read 的 <code>nodeId</code> 同样支持表达式——便于在多电机系统中绑定单个节点：<code>set motor_idx = 2; bind pos ← Telemetry.position @=motor_idx</code>。</li>
            <li>忘记 <code>=</code> 直接写变量名会报错，避免静默发送 <code>NaN</code>。</li>
            <li>变量跨 cell 运行、跨 Run All 持久，只有 <strong>Reset vars</strong> 会清空。</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">Notebook cell 模式</p>
          <ul class="doc-list">
            <li>每个顶层 <strong>Group</strong> 都有自己的 ▶ Run 按钮（类似 Jupyter 的 cell）。</li>
            <li>点击 ▶ 只运行该 cell。前一个 cell 写入的变量对后一个 cell 可见。</li>
            <li><strong>Run All</strong> 从头到尾运行整张表；<strong>Stop</strong> 中断 wait / every / read。</li>
            <li><strong>Reset vars</strong> 清空所有变量并取消全部 Bind（用于重头开始）。</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">拖拽与重排</p>
          <ul class="doc-list">
            <li>点击块的任意空白处拖到新位置——前、后、或拖入容器内部。</li>
            <li><strong>Shift+点击</strong> 同一父级下的第二个块以选中连续范围，拖动其中任一块即可一起移动。</li>
            <li><kbd>Esc</kbd> 清除选择。<strong>⎘</strong> 复制块；<strong>×</strong> 删除块。</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">实时绑定面板</p>
          <ul class="doc-list">
            <li>有 Bind 执行后，运行控制下方会自动出现绑定面板。</li>
            <li>每行显示 <code>varName ← Msg.signal[@node] : lastValue  Ns ago</code>，每帧匹配后更新。</li>
            <li>Bind 的 <code>nodeId</code> 表达式在该语句执行时一次性解析——要追随变量变化，请重新执行 cell。</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">Plot 中的 TX/RX 区分</p>
          <ul class="doc-list">
            <li>Program 页面发送的帧同样在 <a href="/plot">Plot</a> 中显示，状态栏、原始日志、tooltip 都标记为 <strong>TX</strong>，可在同一时间线上对照命令与响应。</li>
          </ul>

          <p style="font-weight: 600; margin-top: 12px; margin-bottom: 4px;">导入 / 导出</p>
          <ul class="doc-list">
            <li><strong>Export</strong> 将当前序列保存为 JSON，便于分享或纳入版本管理。</li>
            <li><strong>Import</strong> 加载 JSON 重新填入页面。</li>
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
            <li><strong>缩放与平移</strong>——滚轮缩放时间轴；<kbd>Shift</kbd>+滚轮缩放数值轴；<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+滚轮同时缩放双轴。左键拖拽平移，<kbd>Shift</kbd>+拖拽框选缩放，双击适配数据。触摸双指捏合同时缩放双轴。</li>
            <li><strong>Fit X / Fit Y / Fit</strong>——工具栏按钮。<em>Fit</em> 复位双轴；<em>Fit X</em> 仅自适应时间轴（保留 Y 缩放）；<em>Fit Y</em> 仅自适应数值轴。</li>
            <li><strong>Follow live</strong>（仅实时模式）——自动滚动 X 轴跟随最新数据，可在按钮旁修改窗口秒数。<em>手动缩放或平移会暂停跟随</em>，避免实时流不断把视图拉回，方便排查；再次点击 <em>Follow live</em> 即可恢复。</li>
            <li><strong>点击数据点</strong>——将该帧的 candump 行（id + 字节 + 时间戳）复制到剪贴板</li>
            <li><strong>时间线标记 A/B</strong>——点击 <em>Measure Δt</em> 后在时序图上选两帧测量时间差</li>
            <li><strong>t=0 起点</strong>——点击 <em>Set t=0</em> 后在时序图上选一帧将其设为时间原点</li>
            <li><strong>导出/导入布局</strong>——将面板排列保存为 YAML 文件</li>
            <li><strong>保存 PNG</strong>——将所有图表导出为 PNG 图像</li>
            <li><strong>录制到文件</strong>——实时采集时将原始帧保存为 <code>.log</code> 文件</li>
            <li><strong>Clear</strong>——清空所有已采集数据</li>
          </ul>
          <p style="margin-top: 8px; font-size: 12px; color: var(--text-dim);">提示：Plot 页面 <em>Clear</em> 按钮旁的 <kbd>?</kbd> 可重新显示手势速查条。</p>
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

      <h3 id="usb-permissions-zh" style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">第三步——USB 适配器权限配置（仅 Linux + USB SLCAN/SLCANFD 设备）</h3>
      <p style="font-size: 13px;">如果使用 <strong>CANable v2 / USB2SLCANFD</strong> 等 USB 转 CAN(FD) 适配器，Linux 默认会把它注册为 <code>/dev/ttyACM*</code>，普通用户没有读写权限。如果只用系统自带的 SocketCAN（<code>can0</code>、<code>vcan0</code>），可跳过本步骤——它们不走 <code>/dev/tty*</code>。</p>
      <p style="font-size: 13px; margin-top: 8px;"><strong>权限不足时的常见现象：</strong></p>
      <ul class="doc-list">
        <li>启动 <code>can_ws_server.py</code> 时报 <code>[Errno 13] Permission denied: '/dev/ttyACM0'</code></li>
        <li><code>serial.serialutil.SerialException: could not open port</code></li>
        <li>插入后约 30 秒内 ModemManager 会探测设备并发 AT 指令，破坏 SLCAN 协议</li>
      </ul>

      <p style="font-size: 13px; margin-top: 10px;"><strong>1. 识别适配器的 USB ID。</strong> 插入设备后执行：</p>
      <pre><code class="doc-code">lsusb | grep -i -E 'can|stm|cdc'
# CANable v2 的典型输出：
# Bus 001 Device 005: ID 16d0:117e MCS CANable2</code></pre>
      <p style="font-size: 13px;">记下 <code>idVendor:idProduct</code>（此处为 <code>16d0:117e</code>）。常见 USB2SLCANFD 适配器：<code>16d0:117e</code>（CANable v2 / canable.io）、<code>1d50:606f</code>（gs_usb / CANable v1）。</p>

      <p style="font-size: 13px; margin-top: 12px;"><strong>2. 创建 udev 规则</strong>，文件路径 <code>/etc/udev/rules.d/99-canable2.rules</code>：</p>
      <pre><code class="doc-code"># /etc/udev/rules.d/99-canable2.rules
# CANable2 / USB 转 CAN-FD 适配器——设置用户组、权限，阻止 ModemManager 抢占
SUBSYSTEM=="usb", ATTR&lcub;idVendor&rcub;=="16d0", ATTR&lcub;idProduct&rcub;=="117e", ENV&lcub;ID_MM_DEVICE_IGNORE&rcub;="1"
SUBSYSTEM=="tty", KERNEL=="ttyACM[0-9]*", ATTRS&lcub;idVendor&rcub;=="16d0", ATTRS&lcub;idProduct&rcub;=="117e", \
    GROUP="dialout", MODE:="0660", TAG+="uaccess", SYMLINK+="usb2can", ENV&lcub;ID_MM_DEVICE_IGNORE&rcub;="1"</code></pre>
      <p style="font-size: 12px; color: var(--text-dim);">如果 <code>lsusb</code> 显示的不是 <code>16d0:117e</code>，把上面四处 <code>idVendor</code>/<code>idProduct</code> 改为你的实际值即可。该规则做了四件事：（1）将设备组设为 <code>dialout</code>、权限设为 <code>0660</code>；（2）添加 <code>uaccess</code> 标签，让当前登录的桌面用户无需加组即可访问；（3）创建固定的 <code>/dev/usb2can</code> 软链接，命令行可直接 <code>--bus /dev/usb2can</code>，无需猜测 <code>ttyACM0</code> / <code>ttyACM1</code>；（4）设置 <code>ID_MM_DEVICE_IGNORE=1</code>，阻止 ModemManager 探测。</p>

      <p style="font-size: 13px; margin-top: 12px;"><strong>3. 重新加载 udev 规则并重新插拔设备：</strong></p>
      <pre><code class="doc-code">sudo udevadm control --reload-rules
sudo udevadm trigger
# 然后拔下并重新插入 USB 线</code></pre>

      <p style="font-size: 13px; margin-top: 12px;"><strong>4. 把当前用户加入 <code>dialout</code> 组</strong>（仅当发行版不支持 <code>TAG+="uaccess"</code> 时需要）：</p>
      <pre><code class="doc-code">sudo usermod -aG dialout $USER
# 需要重新登录才能生效。
groups   # 确认输出包含 "dialout"</code></pre>

      <p style="font-size: 13px; margin-top: 12px;"><strong>5. 验证权限：</strong></p>
      <pre><code class="doc-code">ls -l /dev/usb2can /dev/ttyACM*
# 预期：crw-rw---- 1 root dialout ... /dev/ttyACM0
#       lrwxrwxrwx 1 root root    ... /dev/usb2can -> ttyACM0</code></pre>

      <div style="margin-top: 12px; padding: 12px 16px; background: var(--bg-input); border-left: 3px solid var(--orange); border-radius: 0 var(--radius) var(--radius) 0; font-size: 13px;">
        <strong>故障排查：</strong>
        <ul class="doc-list" style="margin-top: 6px;">
          <li>重新登录后仍报 "Permission denied"？运行 <code>id</code> 查看用户组——若没有 <code>dialout</code>，请重启系统让组变更生效。</li>
          <li>采集时设备随机断开？很可能仍被 ModemManager 干扰，执行 <code>udevadm info -a /dev/ttyACM0 | grep ID_MM</code> 确认 <code>ID_MM_DEVICE_IGNORE=1</code> 已应用。极端情况下可彻底关闭它：<code>sudo systemctl disable --now ModemManager</code>。</li>
          <li>同时插了多个适配器？使用 <code>SYMLINK+="usb2can"</code> 别名（或在规则里追加 <code>ATTRS&lcub;serial&rcub;==...</code> 用序列号区分）。</li>
        </ul>
      </div>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">第四步——启动服务器</h3>
      <pre><code class="doc-code"># SocketCAN 接口
python3 can_ws_server.py --bus can0

# 虚拟 CAN（用于测试）
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan &amp;&amp; sudo ip link set up vcan0
python3 can_ws_server.py --bus vcan0

# USB SLCAN 适配器（CAN FD）——使用上面 udev 规则创建的 /dev/usb2can 软链接
python3 can_ws_server.py --bus /dev/usb2can --interface slcan --bitrate 1000000 --data-bitrate 5000000
# 没有添加 SYMLINK 时，可写 --bus /dev/ttyACM0

# 局域网中继——在远端 CAN 机器上运行，在本机转发
python3 can_ws_server.py --source ws://192.168.x.x:8765</code></pre>

      <h3 style="margin-top: 16px; margin-bottom: 8px; font-size: 15px;">第五步——在浏览器中连接</h3>
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
