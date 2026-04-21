<script lang="ts">
  import { codecStore } from '$lib/codec-store.svelte';
  import { groupArraySignalDefs } from '$lib/codec';

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
      // Initialize broadcast values for each node
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
    for (const nid of nodeRange) {
      bv[nid] = { ...src };
    }
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
          values[group.items[i].name] = isNaN(num) ? val : num;
        }
      } else {
        const num = Number(v);
        values[k] = isNaN(num) ? v : num;
      }
    }
    return values;
  }

  function doEncode() {
    error = null; canResult = null; mavResult = null;
    try {
      if (broadcastMode && hasBroadcast && msgDef) {
        const perNodeValues = new Map<number, Record<string, string | number | Record<string, boolean>>>();
        for (const nid of nodeRange) {
          perNodeValues.set(nid, parseValues(broadcastValues[nid] ?? {}));
        }
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
</script>

<div class="container">
  <div class="page-header">
    <h1>Encode</h1>
    <p>Build a CAN frame from signal values</p>
  </div>

  <div class="card">
    <!-- Step 1: Select device -->
    <div class="form-group">
      <label for="dev-select">Device</label>
      <select id="dev-select" bind:value={selectedDevice} onchange={onDeviceChange}>
        <option value="">Select a device...</option>
        {#each deviceGroups as group}
          <option value={group.device}>{group.device}{group.mavlink ? ' (MAVLink)' : ''} — {group.messages.length} messages</option>
        {/each}
      </select>
    </div>

    <!-- Step 2: Select message -->
    {#if selectedDevice}
      <div class="form-row">
        <div class="form-group" style="margin-bottom:0">
          <label for="msg-select">Message</label>
          <select id="msg-select" bind:value={selectedMsg} onchange={onMsgChange}>
            <option value="">Select a message...</option>
            {#each messagesForDevice as name}
              <option value={name}>{name}</option>
            {/each}
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          {#if isMavlink}
            <label for="sys-id">System ID / Component ID</label>
            <div style="display:flex; gap:8px;">
              <input id="sys-id" type="number" bind:value={sysId} min="0" max="255" placeholder="sys_id" />
              <input type="number" bind:value={compId} min="0" max="255" placeholder="comp_id" />
            </div>
          {:else if broadcastMode}
            <label>Broadcast</label>
            <div style="font-size:13px; color:var(--text-dim); padding:8px 0;">All {msgDef?.node_count} nodes in one frame</div>
          {:else}
            <label for="node-id">Node ID (multi-node)</label>
            <input id="node-id" type="number" bind:value={nodeId} min="0" />
          {/if}
        </div>
      </div>
    {/if}

    {#if selectedMsg && isMavlink}
      <div class="alert info" style="margin-top: 12px; margin-bottom: 0; font-size: 13px;">
        MAVLink message — will output MAVLink v2 frame with CAN transport ID
      </div>
    {/if}

    {#if hasBroadcast}
      <div style="margin-top: 16px; display: flex; align-items: center; gap: 12px;">
        <label class="toggle" style="cursor:pointer;">
          <input type="checkbox" bind:checked={broadcastMode} />
          <span class="toggle-slider"></span>
        </label>
        <span style="font-size:13px;">Broadcast mode</span>
        <span style="font-size:12px;color:var(--text-dim)">
          Combine all {msgDef?.node_count} nodes into one CAN FD frame
        </span>
      </div>
    {/if}

    {#if editableSignals.length > 0}
      {#if broadcastMode && hasBroadcast}
        <!-- Broadcast: per-node tabs -->
        <div style="margin-top: 20px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
            {#each nodeRange as nid}
              <button
                class="node-tab"
                class:active={activeNode === nid}
                onclick={() => activeNode = nid}
              >Node {nid}</button>
            {/each}
            <button class="copy-btn" style="margin-left:auto;font-size:11px;" onclick={copyToAllNodes}>
              Copy to all nodes
            </button>
          </div>
          <div class="signal-inputs">
            {#each signalGroups as group}
              <div class="form-group" style="margin-bottom: 0;">
                <label for="bsig-{activeNode}-{group.key}">
                  {group.base}{#if group.items[0].unit}<span style="color:var(--text-dim);font-weight:400"> ({group.items[0].unit})</span>{/if}
                </label>
                {#if group.items.length === 1 && Object.keys(group.items[0].enum_map).length > 0}
                  <select id="bsig-{activeNode}-{group.key}" bind:value={broadcastValues[activeNode][group.key]}>
                    <option value="">-- select --</option>
                    {#each Object.entries(group.items[0].enum_map) as [k, v]}
                      <option value={v}>{v} ({k})</option>
                    {/each}
                  </select>
                {:else}
                  <input id="bsig-{activeNode}-{group.key}" bind:value={broadcastValues[activeNode][group.key]}
                    placeholder={group.items[0].default_value !== null ? `default: ${group.items[0].default_value}` : ''}
                    onkeydown={(e) => e.key === 'Enter' && doEncode()} />
                {/if}
                {#if group.items[0].description}
                  <div style="font-size:11px;color:var(--text-dim);margin-top:3px">{group.items[0].description}</div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {:else}
        <!-- Normal single-node signal inputs -->
        <div style="margin-top: 20px;">
          <span style="margin-bottom: 12px; display: block; font-size: 13px; font-weight: 500; color: var(--text-dim);">Signal Values</span>
          <div class="signal-inputs">
            {#each signalGroups as group}
              <div class="form-group" style="margin-bottom: 0;">
                <label for="sig-{group.key}">
                  {group.base}{#if group.items[0].unit}<span style="color:var(--text-dim);font-weight:400"> ({group.items[0].unit})</span>{/if}
                  {#if group.items.length > 1}<span style="color:var(--text-dim);font-weight:400;font-size:11px"> [{group.items.length}]</span>{/if}
                </label>
                {#if group.items.length === 1 && Object.keys(group.items[0].enum_map).length > 0}
                  <select id="sig-{group.key}" bind:value={signalValues[group.key]}>
                    <option value="">-- select --</option>
                    {#each Object.entries(group.items[0].enum_map) as [k, v]}
                      <option value={v}>{v} ({k})</option>
                    {/each}
                  </select>
                {:else}
                  <input id="sig-{group.key}" bind:value={signalValues[group.key]}
                    placeholder={group.items.length > 1 ? `[${group.items.map((_, i) => i).join(', ')}]` : (group.items[0].default_value !== null ? `default: ${group.items[0].default_value}` : '')}
                    onkeydown={(e) => e.key === 'Enter' && doEncode()} />
                {/if}
                {#if group.items[0].description}
                  <div style="font-size:11px;color:var(--text-dim);margin-top:3px">{group.items[0].description}</div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/if}

    <div style="margin-top: 20px;">
      <button class="primary" onclick={doEncode} disabled={!selectedMsg}>Encode</button>
    </div>
  </div>

  {#if error}<div class="alert error">{error}</div>{/if}

  {#if canResult}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong>{selectedMsg}</strong>
        <span style="font-family:var(--font-mono);color:var(--orange)">
          ID: 0x{canResult.canId.toString(16).toUpperCase().padStart(3, '0')}
        </span>
      </div>
      <div class="hex-display">{hexStr(canResult.data)}</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="copy-btn" onclick={() => copy(hexStr(canResult!.data), 'hex')}>{copied === 'hex' ? 'Copied!' : 'Copy hex'}</button>
        <button class="copy-btn" onclick={() => copy(cansendStr(), 'cs')}>{copied === 'cs' ? 'Copied!' : 'Copy cansend'}</button>
      </div>
      <div style="margin-top:12px;font-family:var(--font-mono);font-size:13px;color:var(--text-dim);background:var(--bg);padding:10px;border-radius:var(--radius)">
        {cansendStr()}
      </div>
    </div>
  {/if}

  {#if mavResult}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong>{selectedMsg}</strong>
        <span style="font-family:var(--font-mono);color:var(--text-dim); font-size: 13px;">
          MAVLink v2 | sys={sysId} comp={compId} | {mavResult.frames.length} frame{mavResult.frames.length > 1 ? 's' : ''}
        </span>
      </div>
      <div class="hex-display" style="font-size: 13px;">
        Payload: {hexStr(mavResult.rawPayload)}
      </div>
      <div style="margin-top:12px;font-family:var(--font-mono);font-size:13px;color:var(--text-dim);background:var(--bg);padding:10px;border-radius:var(--radius);white-space:pre-wrap">
        {#each mavResult.frames as f, i}
          <div style="margin-bottom: {i < mavResult.frames.length - 1 ? '4px' : '0'}; color: var(--green);">
            vcan0 {f.canId}{f.fdFlag}{f.data}
          </div>
        {/each}
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="copy-btn" onclick={() => copy(mavCansendLines(), 'mav')}>{copied === 'mav' ? 'Copied!' : 'Copy cansend'}</button>
        <button class="copy-btn" onclick={() => copy(hexStr(mavResult!.rawPayload), 'payload')}>{copied === 'payload' ? 'Copied!' : 'Copy payload'}</button>
      </div>
    </div>
  {/if}
</div>
