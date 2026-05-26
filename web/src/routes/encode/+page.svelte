<script lang="ts">
  import { codecStore } from '$lib/codec-store.svelte';
  import { groupArraySignalDefs } from '$lib/codec';
  import { busStore } from '$lib/bus-store.svelte';
  import { sequenceStore, type SendStmt } from '$lib/sequence-store.svelte';
  import { downloadServerScript } from '$lib/server-script';
  import { t } from '$lib/i18n.svelte';
  import { unitPrefs } from '$lib/unit-pref-store.svelte';
  import { convert, canConvert } from '$lib/unit-conversion';

  // The unit shown to the user for a given signal. Equals signal.unit unless
  // the user picked something else on the messages page.
  function displayUnitForSig(msgName: string, sig: { name: string; unit: string }): string {
    return sig.unit ? unitPrefs.resolve(msgName, sig.name, sig.unit) : sig.unit;
  }

  // Convert a user-entered numeric value from the displayed unit back to the
  // YAML-native unit. Strings (enum names) and non-convertible values pass through.
  function nativeNumber(msgName: string, sig: { name: string; unit: string }, raw: string | number): string | number {
    if (typeof raw === 'string') return raw;
    if (!sig.unit) return raw;
    const display = unitPrefs.resolve(msgName, sig.name, sig.unit);
    if (display === sig.unit) return raw;
    if (!canConvert(display, sig.unit)) return raw;
    return convert(raw, display, sig.unit);
  }

  // Default value of a signal, expressed in the chosen display unit (for placeholder text).
  function displayDefault(msgName: string, sig: { name: string; unit: string; default_value: number | string | null }): string | null {
    if (sig.default_value === null) return null;
    if (typeof sig.default_value !== 'number' || !sig.unit) return String(sig.default_value);
    const display = unitPrefs.resolve(msgName, sig.name, sig.unit);
    if (display === sig.unit) return String(sig.default_value);
    if (!canConvert(sig.unit, display)) return String(sig.default_value);
    const converted = convert(sig.default_value, sig.unit, display);
    return Number(converted.toPrecision(6)).toString();
  }

  let selectedDevice = $state('');
  let selectedMsg = $state('');
  let nodeId = $state(0);
  let sysId = $state(1);
  let compId = $state(1);
  let signalValues = $state<Record<string, string>>({});
  let broadcastMode = $state(false);
  let broadcastValues = $state<Record<number, Record<string, string>>>({});
  let activeNode = $state(1);
  let error = $state<string | null>(null);
  let copied = $state('');
  let sendStatus = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
  let sendStatusTimer: ReturnType<typeof setTimeout> | undefined;
  let showSetup = $state(false);

  let canResult = $state<{ canId: number; data: Uint8Array } | null>(null);
  let mavResult = $state<{ frames: { canId: string; data: string; fdFlag: string }[]; rawPayload: Uint8Array } | null>(null);

  const deviceGroups = $derived(codecStore.codec.getMessagesByDevice());
  const selectedGroup = $derived(deviceGroups.find(g => g.device === selectedDevice));
  const messagesForDevice = $derived(selectedGroup?.messages ?? []);
  const isMavlink = $derived(selectedGroup?.mavlink ?? false);
  const msgDef = $derived(selectedMsg ? codecStore.codec.getMessageByName(selectedMsg) : null);
  const editableSignals = $derived(msgDef?.signals.filter((s) => !s.constant) ?? []);
  const signalGroups = $derived(groupArraySignalDefs(editableSignals));
  const hasBroadcast = $derived(msgDef !== null && msgDef.broadcast_node_id !== null && msgDef.node_count > 1);
  const nodeRange = $derived(msgDef ? Array.from({ length: msgDef.node_count }, (_, i) => msgDef.node_id_start + i) : []);

  function onDeviceChange() {
    selectedMsg = '';
    signalValues = {};
    broadcastMode = false;
    broadcastValues = {};
    canResult = null;
    mavResult = null;
    error = null;
  }

  function onMsgChange() {
    signalValues = {};
    broadcastMode = false;
    broadcastValues = {};
    canResult = null;
    mavResult = null;
    error = null;
    if (msgDef) {
      const defaults: Record<string, string> = {};
      for (const sig of msgDef.signals) {
        if (!sig.constant && sig.default_value !== null)
          defaults[sig.name] = String(sig.default_value);
      }
      signalValues = { ...defaults };
      if (msgDef.node_count > 1) {
        const bv: Record<number, Record<string, string>> = {};
        for (let i = 0; i < msgDef.node_count; i++) {
          bv[msgDef.node_id_start + i] = { ...defaults };
        }
        broadcastValues = bv;
        activeNode = msgDef.node_id_start;
      }
    }
  }

  function copyToAllNodes() {
    if (!msgDef) return;
    const src = broadcastValues[activeNode] ?? {};
    const bv: Record<number, Record<string, string>> = {};
    for (const nid of nodeRange) bv[nid] = { ...src };
    broadcastValues = bv;
  }

  function parseValues(raw: Record<string, string>): Record<string, string | number> {
    const values: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === '') continue;
      const group = signalGroups.find(g => g.key === k);
      if (group && group.items.length > 1) {
        const trimmed = v.trim().replace(/^\[|\]$/g, '');
        const parts = trimmed.split(',').map(s => s.trim());
        for (let i = 0; i < group.items.length; i++) {
          const val = parts[i] ?? '';
          if (val === '') continue;
          const num = Number(val);
          const sig = group.items[i];
          const parsed: string | number = isNaN(num) ? val : num;
          values[sig.name] = nativeNumber(selectedMsg, sig, parsed);
        }
      } else {
        const num = Number(v);
        const sig = group?.items[0];
        const parsed: string | number = isNaN(num) ? v : num;
        values[k] = sig ? nativeNumber(selectedMsg, sig, parsed) : parsed;
      }
    }
    return values;
  }

  function doEncode() {
    error = null; canResult = null; mavResult = null;
    try {
      if (broadcastMode && hasBroadcast && msgDef) {
        const perNodeValues = new Map<number, Record<string, string | number | Record<string, boolean>>>();
        for (const nid of nodeRange) perNodeValues.set(nid, parseValues(broadcastValues[nid] ?? {}));
        canResult = codecStore.codec.encodeBroadcast(selectedMsg, perNodeValues);
      } else if (isMavlink) {
        mavResult = codecStore.codec.encodeMavlink(selectedMsg, parseValues(signalValues), sysId, compId);
      } else {
        canResult = codecStore.codec.encode(selectedMsg, parseValues(signalValues), nodeId);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function hexStr(data: Uint8Array) {
    return Array.from(data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  }

  function cansendStr() {
    if (!canResult) return '';
    const hex = Array.from(canResult.data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    const flag = canResult.data.length > 8 ? '##1' : '#';
    return `vcan0 ${canResult.canId.toString(16).toUpperCase().padStart(3, '0')}${flag}${hex}`;
  }

  function mavCansendLines() {
    if (!mavResult) return '';
    return mavResult.frames.map(f => `vcan0 ${f.canId}${f.fdFlag}${f.data}`).join('\n');
  }

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text);
    copied = key;
    setTimeout(() => (copied = ''), 1500);
  }

  function showSendStatus(kind: 'ok' | 'err', text: string) {
    sendStatus = { kind, text };
    if (sendStatusTimer) clearTimeout(sendStatusTimer);
    sendStatusTimer = setTimeout(() => { sendStatus = null; }, 2500);
  }

  function hexFromString(s: string): Uint8Array {
    const cleaned = s.replace(/[^0-9A-Fa-f]/g, '');
    const out = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function sendNow() {
    if (!busStore.connected) {
      showSendStatus('err', t('encode.send_not_connected'));
      return;
    }
    if (canResult) {
      const isFd = canResult.data.length > 8;
      const ok = busStore.client.send(canResult.canId, canResult.data, isFd);
      showSendStatus(ok ? 'ok' : 'err', ok
        ? t('encode.send_ok')
        : (busStore.client.lastSendError ?? t('encode.send_failed')));
      return;
    }
    if (mavResult) {
      let allOk = true;
      let lastErr: string | null = null;
      for (const f of mavResult.frames) {
        const canId = parseInt(f.canId, 16);
        const data = hexFromString(f.data);
        const isFd = f.fdFlag.startsWith('##') || data.length > 8;
        const ok = busStore.client.send(canId, data, isFd);
        if (!ok) { allOk = false; lastErr = busStore.client.lastSendError; }
      }
      showSendStatus(allOk ? 'ok' : 'err', allOk
        ? `${t('encode.send_ok')} (${mavResult.frames.length} ${mavResult.frames.length > 1 ? t('encode.frames_many') : t('encode.frames_one')})`
        : (lastErr ?? t('encode.send_failed')));
    }
  }

  function sendAllNodes() {
    if (!busStore.connected) { showSendStatus('err', t('encode.send_not_connected')); return; }
    if (!msgDef || msgDef.node_count <= 1) { showSendStatus('err', 'not a multi-node message'); return; }
    const values = parseValues(signalValues);
    let okCount = 0;
    let lastErr: string | null = null;
    for (const nid of nodeRange) {
      try {
        const { canId, data } = codecStore.codec.encode(selectedMsg, values, nid);
        const isFd = data.length > 8;
        const ok = busStore.client.send(canId, data, isFd);
        if (ok) okCount++;
        else { lastErr = busStore.client.lastSendError; }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    if (okCount === nodeRange.length) {
      showSendStatus('ok', `${t('encode.send_ok')} (${okCount} ${t('encode.frames_many')})`);
    } else {
      showSendStatus('err', `${okCount}/${nodeRange.length} ${t('encode.frames_many')}${lastErr ? ' — ' + lastErr : ''}`);
    }
  }

  /** Build a SendStmt from the current form state — used by the "+ Sequence" button. */
  function currentSendStmt(): Omit<SendStmt, 'id'> | null {
    if (!selectedMsg) return null;
    if (broadcastMode && hasBroadcast) {
      const perNode: Record<number, Record<string, string | number>> = {};
      for (const nid of nodeRange) perNode[nid] = parseValues(broadcastValues[nid] ?? {});
      return {
        type: 'send',
        enabled: true,
        label: `${selectedMsg} (broadcast)`,
        msgName: selectedMsg,
        isBroadcast: true,
        perNodeValues: perNode,
      };
    }
    if (isMavlink) {
      return {
        type: 'send',
        enabled: true,
        label: `${selectedMsg} sys=${sysId} comp=${compId}`,
        msgName: selectedMsg,
        isMavlink: true,
        sysId,
        compId,
        values: parseValues(signalValues),
      };
    }
    return {
      type: 'send',
      enabled: true,
      label: selectedMsg,
      msgName: selectedMsg,
      nodeId,
      values: parseValues(signalValues),
    };
  }

  function addCurrentToSequence() {
    const stmt = currentSendStmt();
    if (!stmt) {
      if (canResult) {
        const raw: Omit<SendStmt, 'id'> = {
          type: 'send',
          enabled: true,
          label: `0x${canResult.canId.toString(16).toUpperCase()}`,
          raw: { canId: canResult.canId, data: Array.from(canResult.data), isFd: canResult.data.length > 8 },
        };
        sequenceStore.addStmt<SendStmt>(null, raw);
        showSendStatus('ok', t('encode.seq_added'));
      }
      return;
    }
    sequenceStore.addStmt<SendStmt>(null, stmt);
    showSendStatus('ok', t('encode.seq_added'));
  }
</script>

<div class="container">
  <div class="page-header">
    <h1>{t('encode.title')}</h1>
    <p>{t('encode.subtitle')}</p>
  </div>

  <!-- Connection panel -->
  <div class="card connection-card">
    <div class="form-row" style="align-items:end;gap:12px;flex-wrap:wrap">
      <div class="form-group" style="margin-bottom:0;flex:1;min-width:240px">
        <label for="enc-ws-url">{t('encode.label_bus_server')}</label>
        <input id="enc-ws-url" type="text" bind:value={busStore.wsUrl}
          placeholder="ws://localhost:8765"
          disabled={busStore.client.status === 'connected' || busStore.client.status === 'connecting'}
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); busStore.connect(); } }} />
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        {#if busStore.client.status === 'disconnected' || busStore.client.status === 'error'}
          <button class="primary" onclick={() => busStore.connect()} disabled={!busStore.wsUrl.trim()}>
            {t('plot.connect')}
          </button>
        {:else}
          <button style="background:var(--red)" onclick={() => busStore.disconnect()}>{t('plot.disconnect')}</button>
        {/if}
        <button class="copy-btn" onclick={() => downloadServerScript()} title={t('encode.download_server')}>
          ⬇ {t('encode.download_server')}
        </button>
        <span class="connection-status {busStore.client.status}">
          {#if busStore.client.status === 'connected'}
            {t('plot.connected')}{busStore.client.busInfo ? ` — ${busStore.client.busInfo.bus}` : ''}
          {:else if busStore.client.status === 'connecting'}
            {t('plot.connecting')}
          {:else if busStore.client.status === 'error'}
            {busStore.client.error ?? t('plot.error')}
          {:else}
            {t('plot.disconnected')}
          {/if}
        </span>
        {#if busStore.client.status === 'connected'}
          <span style="font-size:12px;color:var(--text-dim)">↑ {busStore.client.sendCount}  ↓ {busStore.client.frameCount}</span>
        {/if}
      </div>
    </div>
    {#if busStore.client.lastSendError && busStore.client.status === 'connected'}
      <div style="font-size:12px;color:var(--red);margin-top:6px">{busStore.client.lastSendError}</div>
    {/if}
    <div style="margin-top:8px">
      <button class="setup-toggle" onclick={() => showSetup = !showSetup}>
        {showSetup ? '▾' : '▸'} {t('encode.setup_help_toggle')}
      </button>
      {#if showSetup}
        <div class="setup-content" style="margin-top:6px">
          <p style="font-size:13px;margin:6px 0 4px"><strong>{t('encode.setup_quick_start')}</strong></p>
          <p style="font-size:12px;color:var(--text-dim);margin:2px 0 6px">{t('encode.setup_run_local')}</p>
          <pre style="margin:0"><code>python3 can_ws_server.py --bus can0</code></pre>
          <p style="font-size:12px;color:var(--text-dim);margin:6px 0">{t('encode.setup_then_connect')}</p>
          <p style="font-size:12px;color:var(--text-dim);margin:6px 0">
            <a href="/plot" style="color:var(--accent, #58a6ff)">{t('encode.setup_more_on_plot')}</a>
          </p>
        </div>
      {/if}
    </div>
  </div>

  <!-- Encode form -->
  <div class="card">
    <div class="form-group">
      <label for="dev-select">{t('encode.label_device')}</label>
      <select id="dev-select" bind:value={selectedDevice} onchange={onDeviceChange}>
        <option value="">{t('encode.placeholder_device')}</option>
        {#each deviceGroups as group}
          <option value={group.device}>{group.device}{group.mavlink ? ' (MAVLink)' : ''} — {group.messages.length} {t('messages.count_messages')}</option>
        {/each}
      </select>
    </div>

    {#if selectedDevice}
      <div class="form-row">
        <div class="form-group" style="margin-bottom:0">
          <label for="msg-select">{t('encode.label_message')}</label>
          <select id="msg-select" bind:value={selectedMsg} onchange={onMsgChange}>
            <option value="">{t('encode.placeholder_message')}</option>
            {#each messagesForDevice as name}
              <option value={name}>{name}</option>
            {/each}
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          {#if isMavlink}
            <label for="sys-id">{t('encode.label_sys_comp')}</label>
            <div style="display:flex; gap:8px;">
              <input id="sys-id" type="number" bind:value={sysId} min="0" max="255" placeholder="sys_id" />
              <input type="number" bind:value={compId} min="0" max="255" placeholder="comp_id" />
            </div>
          {:else if broadcastMode}
            <span style="display:block; font-size:12px; color:var(--text-dim); margin-bottom:4px;">{t('encode.label_broadcast')}</span>
            <div style="font-size:13px; color:var(--text-dim); padding:8px 0;">{t('encode.broadcast_help_prefix')} {msgDef?.node_count} {t('encode.broadcast_help_suffix')}</div>
          {:else}
            <label for="node-id">{t('encode.label_node_id')}</label>
            <input id="node-id" type="number" bind:value={nodeId} min="0" />
          {/if}
        </div>
      </div>
    {/if}

    {#if selectedMsg && isMavlink}
      <div class="alert info" style="margin-top: 12px; margin-bottom: 0; font-size: 13px;">{t('encode.mavlink_note')}</div>
    {/if}

    {#if hasBroadcast}
      <div style="margin-top: 16px; display:flex; align-items:center; gap:12px;">
        <label class="toggle" style="cursor:pointer;">
          <input type="checkbox" bind:checked={broadcastMode} />
          <span class="toggle-slider"></span>
        </label>
        <span style="font-size:13px;">{t('encode.broadcast_mode')}</span>
        <span style="font-size:12px;color:var(--text-dim)">
          {t('encode.broadcast_mode_help_prefix')} {msgDef?.node_count} {t('encode.broadcast_mode_help_suffix')}
        </span>
      </div>
    {/if}

    {#if editableSignals.length > 0}
      {#if broadcastMode && hasBroadcast}
        <div style="margin-top: 20px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
            {#each nodeRange as nid}
              <button class="node-tab" class:active={activeNode === nid} onclick={() => activeNode = nid}>{t('encode.node')} {nid}</button>
            {/each}
            <button class="copy-btn" style="margin-left:auto;font-size:11px;" onclick={copyToAllNodes}>{t('encode.copy_to_all_nodes')}</button>
          </div>
          <div class="signal-inputs">
            {#each signalGroups as group}
              {@const dispU = displayUnitForSig(selectedMsg, group.items[0])}
              {@const defStr = displayDefault(selectedMsg, group.items[0])}
              <div class="form-group" style="margin-bottom: 0;">
                <label for="bsig-{activeNode}-{group.key}">
                  {group.base}{#if dispU}<span style="color:var(--text-dim);font-weight:400"> ({dispU})</span>{/if}
                </label>
                {#if group.items.length === 1 && Object.keys(group.items[0].enum_map).length > 0}
                  <select id="bsig-{activeNode}-{group.key}" bind:value={broadcastValues[activeNode][group.key]}>
                    <option value="">{t('encode.select_placeholder')}</option>
                    {#each Object.entries(group.items[0].enum_map) as [k, v]}<option value={v}>{v} ({k})</option>{/each}
                  </select>
                {:else}
                  <input id="bsig-{activeNode}-{group.key}" bind:value={broadcastValues[activeNode][group.key]}
                    placeholder={defStr !== null ? `${t('encode.default_prefix')} ${defStr}` : ''}
                    onkeydown={(e) => e.key === 'Enter' && doEncode()} />
                {/if}
                {#if group.items[0].description}<div style="font-size:11px;color:var(--text-dim);margin-top:3px">{group.items[0].description}</div>{/if}
              </div>
            {/each}
          </div>
        </div>
      {:else}
        <div style="margin-top: 20px;">
          <span style="margin-bottom: 12px; display: block; font-size: 13px; font-weight: 500; color: var(--text-dim);">{t('encode.signal_values')}</span>
          <div class="signal-inputs">
            {#each signalGroups as group}
              {@const dispU = displayUnitForSig(selectedMsg, group.items[0])}
              {@const defStr = displayDefault(selectedMsg, group.items[0])}
              <div class="form-group" style="margin-bottom: 0;">
                <label for="sig-{group.key}">
                  {group.base}{#if dispU}<span style="color:var(--text-dim);font-weight:400"> ({dispU})</span>{/if}
                  {#if group.items.length > 1}<span style="color:var(--text-dim);font-weight:400;font-size:11px"> [{group.items.length}]</span>{/if}
                </label>
                {#if group.items.length === 1 && Object.keys(group.items[0].enum_map).length > 0}
                  <select id="sig-{group.key}" bind:value={signalValues[group.key]}>
                    <option value="">{t('encode.select_placeholder')}</option>
                    {#each Object.entries(group.items[0].enum_map) as [k, v]}<option value={v}>{v} ({k})</option>{/each}
                  </select>
                {:else}
                  <input id="sig-{group.key}" bind:value={signalValues[group.key]}
                    placeholder={group.items.length > 1 ? `[${group.items.map((_, i) => i).join(', ')}]` : (defStr !== null ? `${t('encode.default_prefix')} ${defStr}` : '')}
                    onkeydown={(e) => e.key === 'Enter' && doEncode()} />
                {/if}
                {#if group.items[0].description}<div style="font-size:11px;color:var(--text-dim);margin-top:3px">{group.items[0].description}</div>{/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/if}

    <div style="margin-top: 20px;">
      <button class="primary" onclick={doEncode} disabled={!selectedMsg}>{t('encode.button')}</button>
    </div>
  </div>

  {#if error}<div class="alert error">{error}</div>{/if}

  {#if canResult}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong>{selectedMsg}</strong>
        <span style="font-family:var(--font-mono);color:var(--orange)">{t('encode.id')} 0x{canResult.canId.toString(16).toUpperCase().padStart(3, '0')}</span>
      </div>
      <div class="hex-display">{hexStr(canResult.data)}</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">
        <button class="primary" onclick={sendNow} disabled={!busStore.connected}
          title={busStore.connected ? '' : t('encode.send_not_connected')}>{t('encode.send_btn')}</button>
        {#if msgDef && msgDef.node_count > 1 && !broadcastMode}
          <button class="copy-btn" onclick={sendAllNodes} disabled={!busStore.connected}
            title="{t('encode.send_all_nodes_title')}">
            {t('encode.send_all_nodes')} ({msgDef.node_count})
          </button>
        {/if}
        <button class="copy-btn" onclick={addCurrentToSequence}>
          {t('encode.add_to_sequence')}
          {#if sequenceStore.ast.length > 0}
            <span style="margin-left:4px;color:var(--text-dim);font-size:11px">
              ({sequenceStore.ast.length} <a href="/program" style="color:var(--accent, #58a6ff);text-decoration:none">{t('nav.program')}</a>)
            </span>
          {/if}
        </button>
        <button class="copy-btn" onclick={() => copy(hexStr(canResult!.data), 'hex')}>{copied === 'hex' ? t('encode.copied') : t('encode.copy_hex')}</button>
        <button class="copy-btn" onclick={() => copy(cansendStr(), 'cs')}>{copied === 'cs' ? t('encode.copied') : t('encode.copy_cansend')}</button>
        {#if sendStatus}<span style="font-size:12px;color:{sendStatus.kind === 'ok' ? 'var(--green, #3fb950)' : 'var(--red)'}">{sendStatus.text}</span>{/if}
      </div>
      <div style="margin-top:12px;font-family:var(--font-mono);font-size:13px;color:var(--text-dim);background:var(--bg);padding:10px;border-radius:var(--radius)">{cansendStr()}</div>
    </div>
  {/if}

  {#if mavResult}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong>{selectedMsg}</strong>
        <span style="font-family:var(--font-mono);color:var(--text-dim); font-size: 13px;">
          MAVLink v2 | sys={sysId} comp={compId} | {mavResult.frames.length} {mavResult.frames.length > 1 ? t('encode.frames_many') : t('encode.frames_one')}
        </span>
      </div>
      <div class="hex-display" style="font-size: 13px;">{t('encode.payload')} {hexStr(mavResult.rawPayload)}</div>
      <div style="margin-top:12px;font-family:var(--font-mono);font-size:13px;color:var(--text-dim);background:var(--bg);padding:10px;border-radius:var(--radius);white-space:pre-wrap">
        {#each mavResult.frames as f, i}
          <div style="margin-bottom: {i < mavResult.frames.length - 1 ? '4px' : '0'}; color: var(--green);">vcan0 {f.canId}{f.fdFlag}{f.data}</div>
        {/each}
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">
        <button class="primary" onclick={sendNow} disabled={!busStore.connected} title={busStore.connected ? '' : t('encode.send_not_connected')}>{t('encode.send_btn')}</button>
        <button class="copy-btn" onclick={addCurrentToSequence}>
          {t('encode.add_to_sequence')}
          {#if sequenceStore.ast.length > 0}
            <span style="margin-left:4px;color:var(--text-dim);font-size:11px">
              ({sequenceStore.ast.length} <a href="/program" style="color:var(--accent, #58a6ff);text-decoration:none">{t('nav.program')}</a>)
            </span>
          {/if}
        </button>
        <button class="copy-btn" onclick={() => copy(mavCansendLines(), 'mav')}>{copied === 'mav' ? t('encode.copied') : t('encode.copy_cansend')}</button>
        <button class="copy-btn" onclick={() => copy(hexStr(mavResult!.rawPayload), 'payload')}>{copied === 'payload' ? t('encode.copied') : t('encode.copy_payload')}</button>
        {#if sendStatus}<span style="font-size:12px;color:{sendStatus.kind === 'ok' ? 'var(--green, #3fb950)' : 'var(--red)'}">{sendStatus.text}</span>{/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .connection-card { padding: 12px 16px; }

  .setup-content pre {
    background: var(--bg);
    padding: 8px 12px;
    border-radius: var(--radius);
    overflow-x: auto;
    font-size: 12px;
  }
</style>
