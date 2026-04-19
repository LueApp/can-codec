<script lang="ts">
  import { codecStore } from '$lib/codec-store.svelte';
  import { groupArraySignalDefs } from '$lib/codec';

  let selectedDevice = $state('');
  let selectedMsg = $state('');
  let nodeId = $state(0);
  let sysId = $state(1);
  let compId = $state(1);
  let signalValues = $state<Record<string, string>>({});
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

  function onDeviceChange() {
    selectedMsg = '';
    signalValues = {};
    canResult = null;
    mavResult = null;
    error = null;
  }

  function onMsgChange() {
    signalValues = {};
    canResult = null;
    mavResult = null;
    error = null;
    if (msgDef) {
      for (const sig of msgDef.signals) {
        if (!sig.constant && sig.default_value !== null)
          signalValues[sig.name] = String(sig.default_value);
      }
    }
  }

  function doEncode() {
    error = null; canResult = null; mavResult = null;
    try {
      const values: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(signalValues)) {
        if (v === '') continue;
        // Expand array input "[v0, v1, ...]" back to name_0, name_1, ...
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
      if (isMavlink) {
        mavResult = codecStore.codec.encodeMavlink(selectedMsg, values, sysId, compId);
      } else {
        canResult = codecStore.codec.encode(selectedMsg, values, nodeId);
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

    {#if editableSignals.length > 0}
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
