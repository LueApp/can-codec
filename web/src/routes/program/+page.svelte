<script lang="ts">
  import { codecStore } from '$lib/codec-store.svelte';
  import { groupArraySignalDefs } from '$lib/codec';
  import { busStore } from '$lib/bus-store.svelte';
  import { sequenceStore, sweepCount, sendLabel, sweepLabel,
    type SeqStatement, type SendStmt, type WaitStmt, type RepeatStmt,
    type EveryStmt, type SweepStmt, type GroupStmt, type SetStmt,
    type BindStmt, type ReadStmt } from '$lib/sequence-store.svelte';
  import { downloadServerScript } from '$lib/server-script';
  import { t } from '$lib/i18n.svelte';

  // ---- UI state ----
  let importError = $state<string | null>(null);
  let fileInput: HTMLInputElement | undefined;
  let expandedSends = $state<Record<string, boolean>>({});
  let copiedPreview = $state<Record<string, boolean>>({});

  // Drag and drop
  let dragId = $state<string | null>(null);
  let dropTarget = $state<{ id: string; position: 'before' | 'after' | 'inside' } | null>(null);
  let dropAtEnd = $state<boolean>(false);

  // Multi-select (shift+click for range, click to anchor, Esc to clear)
  let selectedIds = $state<string[]>([]);
  let anchorId = $state<string | null>(null);

  /** Per-statement active node when editing a broadcast Send. Page-local UI state. */
  let activeBcNode = $state<Record<string, number>>({});

  // Wall-clock ticker driving the "Xs ago" age column in the bindings panel.
  // Updated only when there is at least one binding.
  let nowMs = $state<number>(Date.now());
  $effect(() => {
    if (Object.keys(sequenceStore.bindings).length === 0) return;
    const iv = setInterval(() => { nowMs = Date.now(); }, 1000);
    return () => clearInterval(iv);
  });

  function ageLabel(ts: number, now: number): string {
    const dt = Math.max(0, now - ts);
    if (dt < 1000) return `${dt} ms`;
    const s = dt / 1000;
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = s / 60;
    if (m < 60) return `${m.toFixed(1)} min`;
    return `${(m / 60).toFixed(1)} h`;
  }

  // ---- Derived ----
  const deviceGroups = $derived(codecStore.codec.getMessagesByDevice());

  // Drop ids from the selection if they no longer exist in the AST
  // (deletion, import-replace, etc.). Runs on every AST mutation.
  $effect(() => {
    const ast = sequenceStore.ast;
    if (selectedIds.length === 0 && anchorId === null) return;
    const alive = new Set<string>();
    (function walk(list: SeqStatement[]) {
      for (const s of list) {
        alive.add(s.id);
        const body = (s as Partial<{ body: SeqStatement[] }>).body;
        if (Array.isArray(body)) walk(body);
      }
    })(ast);
    const filtered = selectedIds.filter(id => alive.has(id));
    if (filtered.length !== selectedIds.length) selectedIds = filtered;
    if (anchorId && !alive.has(anchorId)) anchorId = null;
  });

  // ---- Statement factory ----
  type SeqStmtType = SeqStatement['type'];

  function makeStmt(type: SeqStmtType): Omit<SeqStatement, 'id'> {
    switch (type) {
      case 'wait':   return { type, enabled: true, ms: 100 } as Omit<WaitStmt, 'id'>;
      case 'repeat': return { type, enabled: true, count: 3, body: [] } as Omit<RepeatStmt, 'id'>;
      case 'every':  return { type, enabled: true, periodMs: 100, initialDelayMs: 0, body: [] } as Omit<EveryStmt, 'id'>;
      case 'sweep':  return {
        type, enabled: true,
        msgName: '', signal: '',
        from: 0, to: 100, step: 10, periodMs: 50,
      } as Omit<SweepStmt, 'id'>;
      case 'group':  return { type, enabled: true, label: 'Group', body: [] } as Omit<GroupStmt, 'id'>;
      case 'set':    return { type, enabled: true, name: 'counter', expr: '0' } as Omit<SetStmt, 'id'>;
      case 'send':   return { type, enabled: true, label: '', msgName: '' } as Omit<SendStmt, 'id'>;
      case 'bind':   return { type, enabled: true, varName: '', msgName: '', signal: '' } as Omit<BindStmt, 'id'>;
      case 'read':   return { type, enabled: true, varName: '', msgName: '', signal: '', timeoutMs: 1000 } as Omit<ReadStmt, 'id'>;
    }
  }

  function insertAfter(siblingId: string, type: SeqStmtType) {
    const id = sequenceStore.insertAfter(siblingId, makeStmt(type));
    if (type === 'send' && id) expandedSends = { ...expandedSends, [id]: true };
  }
  function insertBefore(siblingId: string, type: SeqStmtType) {
    const id = sequenceStore.insertBefore(siblingId, makeStmt(type));
    if (type === 'send' && id) expandedSends = { ...expandedSends, [id]: true };
  }
  function addChild(parentId: string, type: SeqStmtType) {
    const id = sequenceStore.addStmt(parentId, makeStmt(type));
    if (type === 'send' && id) expandedSends = { ...expandedSends, [id]: true };
  }
  function addTop(type: SeqStmtType) {
    const id = sequenceStore.addStmt(null, makeStmt(type));
    if (type === 'send' && id) expandedSends = { ...expandedSends, [id]: true };
  }

  // ---- Message picker (inline) ----
  /** Look up which device group a message name belongs to (and whether it's MAVLink). */
  function findGroupFor(msgName: string): { device: string; mavlink: boolean } | null {
    for (const g of deviceGroups) {
      if (g.messages.includes(msgName)) return { device: g.device, mavlink: g.mavlink };
    }
    return null;
  }

  /** Switch a send statement's msgName, recompute isMavlink, reset values to defaults. */
  function pickMessage(stmt: SendStmt, newMsgName: string) {
    if (newMsgName === '') {
      sequenceStore.updateStmt(stmt.id, { msgName: '', isMavlink: false, values: {} } as Partial<SendStmt>);
      return;
    }
    const msg = codecStore.codec.getMessageByName(newMsgName);
    if (!msg) return;
    const info = findGroupFor(newMsgName);
    const defaults: Record<string, string | number> = {};
    for (const sig of msg.signals) {
      if (!sig.constant && sig.default_value !== null) {
        defaults[sig.name] = sig.default_value as string | number;
      }
    }
    sequenceStore.updateStmt(stmt.id, {
      msgName: newMsgName,
      isMavlink: info?.mavlink ?? false,
      label: newMsgName,
      values: defaults,
    } as Partial<SendStmt>);
  }

  // ---- Import / export ----
  function doExport() {
    const json = sequenceStore.exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `sequence-${ts}.json`;
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function onImportFile(e: Event) {
    importError = null;
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const res = sequenceStore.importJson(String(reader.result ?? ''));
      if (!res.ok) importError = res.error;
      if (fileInput) fileInput.value = '';
    };
    reader.readAsText(file);
  }

  // ---- Inline send editor ----
  function toggleExpand(id: string) {
    expandedSends = { ...expandedSends, [id]: !expandedSends[id] };
  }

  function setSendValue(stmt: SendStmt, signalName: string, rawValue: string) {
    if (stmt.isBroadcast) {
      const node = activeBcNode[stmt.id] ?? bcDefaultNode(stmt);
      const perNode = { ...(stmt.perNodeValues ?? {}) };
      const cell = { ...(perNode[node] ?? {}) };
      if (rawValue === '') delete cell[signalName];
      else {
        const num = Number(rawValue);
        cell[signalName] = isNaN(num) ? rawValue : num;
      }
      perNode[node] = cell;
      sequenceStore.updateStmt(stmt.id, { perNodeValues: perNode } as Partial<SendStmt>);
      return;
    }
    const newValues = { ...(stmt.values ?? {}) };
    if (rawValue === '') {
      delete newValues[signalName];
    } else {
      const num = Number(rawValue);
      newValues[signalName] = isNaN(num) ? rawValue : num;
    }
    sequenceStore.updateStmt(stmt.id, { values: newValues } as Partial<SendStmt>);
  }

  function setSendArrayValue(stmt: SendStmt, group: ReturnType<typeof groupArraySignalDefs>[number], rawValue: string) {
    const parts = rawValue.trim().replace(/^\[|\]$/g, '').split(',').map(s => s.trim());
    const updates: Record<string, string | number> = {};
    const toDelete: string[] = [];
    for (let i = 0; i < group.items.length; i++) {
      const val = parts[i] ?? '';
      if (val === '') toDelete.push(group.items[i].name);
      else {
        const num = Number(val);
        updates[group.items[i].name] = isNaN(num) ? val : num;
      }
    }
    if (stmt.isBroadcast) {
      const node = activeBcNode[stmt.id] ?? bcDefaultNode(stmt);
      const perNode = { ...(stmt.perNodeValues ?? {}) };
      const cell: Record<string, string | number> = { ...(perNode[node] ?? {}) };
      for (const k of toDelete) delete cell[k];
      Object.assign(cell, updates);
      perNode[node] = cell;
      sequenceStore.updateStmt(stmt.id, { perNodeValues: perNode } as Partial<SendStmt>);
      return;
    }
    const newValues = { ...(stmt.values ?? {}) };
    for (const k of toDelete) delete newValues[k];
    Object.assign(newValues, updates);
    sequenceStore.updateStmt(stmt.id, { values: newValues } as Partial<SendStmt>);
  }

  function getSendArrayDisplay(stmt: SendStmt, group: ReturnType<typeof groupArraySignalDefs>[number]): string {
    const values = sendValuesFor(stmt);
    return group.items.map(s => values[s.name] ?? '').join(', ');
  }

  /** Return the values map currently visible in the editor — either stmt.values
   *  (single-node) or stmt.perNodeValues[activeBcNode] (broadcast). */
  function sendValuesFor(stmt: SendStmt): Record<string, string | number> {
    if (stmt.isBroadcast) {
      const node = activeBcNode[stmt.id] ?? bcDefaultNode(stmt);
      return (stmt.perNodeValues?.[node] ?? {}) as Record<string, string | number>;
    }
    return (stmt.values ?? {}) as Record<string, string | number>;
  }

  function bcDefaultNode(stmt: SendStmt): number {
    const msg = stmt.msgName ? codecStore.codec.getMessageByName(stmt.msgName) : null;
    return msg?.node_id_start ?? 0;
  }

  /** Toggle broadcast mode on a Send statement. On enable, seed perNodeValues
   *  with empty maps for every node so the tabs render correctly. On disable,
   *  keep perNodeValues so re-enabling preserves prior data. */
  function toggleBroadcast(stmt: SendStmt, enabled: boolean) {
    const msg = stmt.msgName ? codecStore.codec.getMessageByName(stmt.msgName) : null;
    if (!msg) return;
    if (enabled) {
      const seed: Record<number, Record<string, string | number>> = { ...(stmt.perNodeValues as Record<number, Record<string, string | number>> ?? {}) };
      // Copy the current single-node values onto every node as a starting point.
      const base = stmt.values ?? {};
      const start = msg.node_id_start;
      for (let n = 0; n < msg.node_count; n++) {
        const nid = start + n;
        if (!seed[nid]) seed[nid] = { ...base } as Record<string, string | number>;
      }
      sequenceStore.updateStmt(stmt.id, { isBroadcast: true, perNodeValues: seed } as Partial<SendStmt>);
      activeBcNode[stmt.id] = start;
    } else {
      sequenceStore.updateStmt(stmt.id, { isBroadcast: false } as Partial<SendStmt>);
    }
  }

  function previewLine(stmt: SendStmt): { text: string; error: string | null } {
    const res = sequenceStore.encodeSendPreview(stmt);
    if (res.error || res.frames.length === 0) {
      return { text: '', error: res.error ?? 'no frames' };
    }
    const lines = res.frames.map(f => {
      const idStr = f.canId > 0x7FF
        ? f.canId.toString(16).toUpperCase().padStart(8, '0')
        : f.canId.toString(16).toUpperCase().padStart(3, '0');
      const flag = f.isFd ? '##0' : '#';
      const hex = Array.from(f.data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      return `${idStr}${flag}${hex}`;
    });
    return { text: lines.join('\n'), error: null };
  }

  function previewScript(stmt: SendStmt): string {
    const p = previewLine(stmt);
    if (p.error) return '';
    const bus = busStore.client.busInfo?.bus ?? 'vcan0';
    return p.text.split('\n').map(line => `${bus} ${line}`).join('\n');
  }

  function copyPreview(stmt: SendStmt) {
    const text = previewScript(stmt);
    if (!text) return;
    navigator.clipboard.writeText(text);
    copiedPreview = { ...copiedPreview, [stmt.id]: true };
    setTimeout(() => {
      copiedPreview = { ...copiedPreview, [stmt.id]: false };
    }, 1500);
  }

  // ---- Statement label/warning helpers ----
  function stmtSummary(s: SeqStatement): string {
    switch (s.type) {
      case 'send':   return sendLabel(s);
      case 'wait':   return `${s.ms} ms${s.label ? ' — ' + s.label : ''}`;
      case 'repeat': return `${s.count}× ${s.label ? ' (' + s.label + ')' : ''}`;
      case 'every':  return s.label ?? `${s.periodMs} ms`;
      case 'sweep':  return sweepLabel(s);
      case 'group':  return s.label;
      case 'set':    return `${s.name} = ${s.expr}`;
      case 'bind':   return `${s.varName || '?'} ← ${s.msgName || '?'}.${s.signal || '?'}`;
      case 'read':   return `${s.varName || '?'} ← ${s.msgName || '?'}.${s.signal || '?'} (≤${s.timeoutMs}ms)`;
    }
  }

  function isMissingConfig(s: SendStmt): boolean {
    if (!s.msgName) return false;
    return !codecStore.codec.getMessageByName(s.msgName);
  }

  function encodingError(s: SendStmt): string | null {
    if (!s.msgName) return null;
    if (isMissingConfig(s)) return null;
    return sequenceStore.encodeSendPreview(s).error;
  }

  // ---- Drag and drop ----
  const NON_DRAGGABLE_SELECTOR = 'input, select, textarea, button, label, .ast-actions, .send-editor';

  function clearSelection() {
    selectedIds = [];
    anchorId = null;
  }

  /** Click on a row body: with shift, extend selection from anchor (same-parent only).
   *  Without shift, set anchor + select just this row. */
  function onRowClick(e: MouseEvent, stmtId: string) {
    const t = e.target as HTMLElement | null;
    // Ignore clicks on form controls / action buttons — they already do their own thing.
    if (t && t.closest(NON_DRAGGABLE_SELECTOR)) return;
    if (e.shiftKey && anchorId && anchorId !== stmtId) {
      const range = sequenceStore.siblingRange(anchorId, stmtId);
      if (range) {
        selectedIds = range;
        e.preventDefault();
        return;
      }
      // Cross-parent shift+click: silently fall back to anchor reset.
    }
    anchorId = stmtId;
    selectedIds = [stmtId];
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && selectedIds.length > 0) {
      clearSelection();
    }
  }

  function onDragStart(e: DragEvent, stmtId: string) {
    if (sequenceStore.running) { e.preventDefault(); return; }
    const target = e.target as HTMLElement | null;
    if (target && target !== e.currentTarget && target.closest(NON_DRAGGABLE_SELECTOR)) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    if (!e.dataTransfer) return;
    // If user starts dragging a row that's NOT already in the selection,
    // treat it as a single-item drag (and reset selection so the visual matches).
    if (!selectedIds.includes(stmtId)) {
      selectedIds = [stmtId];
      anchorId = stmtId;
    }
    dragId = stmtId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', stmtId);
    const row = e.currentTarget as HTMLElement;
    const rect = row.getBoundingClientRect();
    e.dataTransfer.setDragImage(row, e.clientX - rect.left, e.clientY - rect.top);
  }

  function clearDragState() {
    dragId = null;
    dropTarget = null;
    dropAtEnd = false;
  }

  function onDragEnd(e: DragEvent) {
    e.stopPropagation();
    clearDragState();
  }

  function isContainer(s: SeqStatement): boolean {
    return s.type === 'repeat' || s.type === 'every' || s.type === 'group';
  }

  function onRowDragOver(e: DragEvent, stmt: SeqStatement) {
    if (!dragId || isDragSource(stmt.id)) return;
    if (isInsideDragged(stmt.id)) return;
    const row = e.currentTarget as HTMLElement;
    const line = row.querySelector(':scope > .ast-content > .ast-line') as HTMLElement | null;
    const anchor = (line ?? row).getBoundingClientRect();
    const y = e.clientY;
    let position: 'before' | 'after' | 'inside';
    if (y < anchor.top + anchor.height * 0.5) position = 'before';
    else if (y < anchor.bottom) position = isContainer(stmt) ? 'inside' : 'after';
    else position = isContainer(stmt) ? 'inside' : 'after';
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (!dropTarget || dropTarget.id !== stmt.id || dropTarget.position !== position) {
      dropTarget = { id: stmt.id, position };
    }
    if (dropAtEnd) dropAtEnd = false;
  }

  function onRowDrop(e: DragEvent, _stmt: SeqStatement) {
    if (!dragId || !dropTarget) { clearDragState(); return; }
    e.preventDefault();
    e.stopPropagation();
    const pos = dropTarget.position;
    const tgt = dropTarget.id;
    const sources = activeDragIds();
    clearDragState();
    if (sources.length > 1) {
      sequenceStore.moveStmtsTo(sources, tgt, pos);
    } else {
      sequenceStore.moveStmtTo(sources[0], tgt, pos);
    }
  }

  function onEndZoneDragOver(e: DragEvent) {
    if (!dragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (!dropAtEnd) dropAtEnd = true;
    if (dropTarget) dropTarget = null;
  }

  function onEndZoneDrop(e: DragEvent) {
    if (!dragId) return;
    e.preventDefault();
    const sources = activeDragIds();
    clearDragState();
    if (sources.length > 1) {
      sequenceStore.moveStmtsTo(sources, null, 'end');
    } else {
      sequenceStore.moveStmtTo(sources[0], null, 'end');
    }
  }

  /** Sources being dragged: the full selection if dragId is part of it; otherwise just dragId. */
  function activeDragIds(): string[] {
    if (!dragId) return [];
    return selectedIds.includes(dragId) && selectedIds.length > 1 ? selectedIds.slice() : [dragId];
  }

  function isDragSource(id: string): boolean {
    const ids = activeDragIds();
    return ids.includes(id);
  }

  function isInsideDragged(candidateTargetId: string): boolean {
    if (!dragId) return false;
    for (const id of activeDragIds()) {
      const dragged = findStmtById(sequenceStore.ast, id);
      if (dragged && subtreeContains(dragged, candidateTargetId)) return true;
    }
    return false;
  }

  function findStmtById(list: SeqStatement[], id: string): SeqStatement | null {
    for (const s of list) {
      if (s.id === id) return s;
      const body = (s as Partial<{ body: SeqStatement[] }>).body;
      if (Array.isArray(body)) {
        const r = findStmtById(body, id);
        if (r) return r;
      }
    }
    return null;
  }

  function subtreeContains(stmt: SeqStatement, id: string): boolean {
    const body = (stmt as Partial<{ body: SeqStatement[] }>).body;
    if (!Array.isArray(body)) return false;
    for (const s of body) {
      if (s.id === id) return true;
      if (subtreeContains(s, id)) return true;
    }
    return false;
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="container">
  <div class="page-header">
    <h1>{t('program.title')}</h1>
    <p>{t('program.subtitle')}</p>
  </div>

  <!-- Connection panel (shared with Encode page via busStore) -->
  <div class="card connection-card">
    <div class="form-row" style="align-items:end;gap:12px;flex-wrap:wrap">
      <div class="form-group" style="margin-bottom:0;flex:1;min-width:240px">
        <label for="prog-ws-url">{t('encode.label_bus_server')}</label>
        <input id="prog-ws-url" type="text" bind:value={busStore.wsUrl}
          placeholder="ws://localhost:8765"
          disabled={busStore.client.status === 'connected' || busStore.client.status === 'connecting'}
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); busStore.connect(); } }} />
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        {#if busStore.client.status === 'disconnected' || busStore.client.status === 'error'}
          <button class="primary" onclick={() => busStore.connect()} disabled={!busStore.wsUrl.trim()}>{t('plot.connect')}</button>
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
  </div>

  <!-- Sequence (SOP) panel -->
  <div class="card">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px">
      <strong style="font-size:15px">{t('encode.sequence_title')}</strong>
      <span style="color:var(--text-dim);font-size:12px">{sequenceStore.ast.length} {t('encode.sequence_steps')}</span>
      {#if selectedIds.length > 1}
        <span class="selection-chip" title={t('program.selection_hint')}>
          {selectedIds.length} {t('program.selected')}
          <button class="selection-clear" onclick={clearSelection} title={t('program.selection_clear')}>×</button>
        </span>
      {/if}
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="copy-btn" onclick={doExport} disabled={sequenceStore.ast.length === 0}>{t('encode.sequence_export')}</button>
        <button class="copy-btn" onclick={() => fileInput?.click()}>{t('encode.sequence_import')}</button>
        <input bind:this={fileInput} type="file" accept="application/json,.json" style="display:none" onchange={onImportFile} />
      </div>
    </div>
    <p style="font-size:12px;color:var(--text-dim);margin:0 0 12px 0">
      {t('program.notebook_hint')}<br/>
      <span style="opacity:0.85">{t('program.multiselect_hint')}</span><br/>
      <span style="opacity:0.85">{t('program.closedloop_hint')}</span>
    </p>

    {#if importError}
      <div class="alert error" style="margin-top:6px">{t('encode.import_invalid')}: {importError}</div>
    {/if}

    {#if sequenceStore.ast.length === 0}
      <div style="font-size:13px;color:var(--text-dim);padding:8px 0">{t('program.from_encode_hint')}</div>
    {:else}
      <div class="ast-tree">
        {#each sequenceStore.ast as stmt, idx (stmt.id)}
          {@render renderStmt(stmt, 0, idx)}
        {/each}
        {#if dragId}
          <div class="ast-end-zone" class:active={dropAtEnd}
            ondragover={onEndZoneDragOver} ondrop={onEndZoneDrop}>
            ↓ {t('encode.drop_at_end')}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Add-at-top menu -->
    <div style="display:flex;gap:6px;align-items:center;margin-top:12px;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--text-dim)">{t('encode.sequence_add_top')}:</span>
      <button class="chip" onclick={() => addTop('send')} disabled={sequenceStore.running}>+ {t('encode.stmt_send')}</button>
      <button class="chip" onclick={() => addTop('wait')} disabled={sequenceStore.running}>+ {t('encode.stmt_wait')}</button>
      <button class="chip" onclick={() => addTop('repeat')} disabled={sequenceStore.running}>+ {t('encode.stmt_repeat')}</button>
      <button class="chip" onclick={() => addTop('every')} disabled={sequenceStore.running}>+ {t('encode.stmt_every')}</button>
      <button class="chip" onclick={() => addTop('sweep')} disabled={sequenceStore.running}>+ {t('encode.stmt_sweep')}</button>
      <button class="chip" onclick={() => addTop('group')} disabled={sequenceStore.running}>+ {t('encode.stmt_group')}</button>
      <button class="chip" onclick={() => addTop('set')} disabled={sequenceStore.running}>+ {t('encode.stmt_set')}</button>
      <button class="chip" onclick={() => addTop('bind')} disabled={sequenceStore.running}>+ {t('program.stmt_bind')}</button>
      <button class="chip" onclick={() => addTop('read')} disabled={sequenceStore.running}>+ {t('program.stmt_read')}</button>
    </div>

    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">
      {#if sequenceStore.running}
        <button style="background:var(--red)" onclick={() => sequenceStore.stop()}>{t('encode.sequence_stop')}</button>
        <span style="font-size:13px;color:var(--green, #3fb950)">
          ▶ {sequenceStore.runningCellId ? t('program.running_cell') : t('program.running_all')}…
        </span>
      {:else}
        <button class="primary" onclick={() => sequenceStore.start()}
          disabled={!busStore.connected || sequenceStore.ast.length === 0}>{t('encode.sequence_run')}</button>
        {#if !busStore.connected}<span style="font-size:12px;color:var(--text-dim)">{t('encode.send_not_connected')}</span>{/if}
      {/if}
      {#if sequenceStore.varsCount > 0}
        <span style="font-size:12px;color:var(--text-dim)" title={t('program.vars_persist_hint')}>
          📦 {sequenceStore.varsCount} {sequenceStore.varsCount === 1 ? t('program.var_singular') : t('program.var_plural')}
        </span>
        <button class="copy-btn" style="font-size:11px" onclick={() => sequenceStore.clearVars()} disabled={sequenceStore.running}>{t('program.reset_vars')}</button>
      {/if}
      {#if sequenceStore.ast.length > 0}
        <button class="copy-btn" style="margin-left:auto" onclick={() => sequenceStore.clear()} disabled={sequenceStore.running}>{t('encode.sequence_clear')}</button>
      {/if}
      {#if sequenceStore.lastError}<span style="font-size:12px;color:var(--red)">{sequenceStore.lastError}</span>{/if}
    </div>

    {#if Object.keys(sequenceStore.bindings).length > 0}
      {@const bindingEntries = Object.entries(sequenceStore.bindings)}
      <details open class="bindings-panel">
        <summary>{t('program.bindings_title')} ({bindingEntries.length})</summary>
        <div class="bindings-grid">
          {#each bindingEntries as [name, b] (name)}
            <div class="binding-row">
              <span class="binding-name">{name}</span>
              <span class="binding-arrow">←</span>
              <span class="binding-src">{b.msgName}.{b.signal}{b.nodeId !== undefined ? ` @${b.nodeId}` : ''}</span>
              <span class="binding-value">
                {#if b.lastValue === null}<em style="opacity:.6">{t('program.bindings_waiting')}</em>
                {:else}{b.lastValue}{/if}
              </span>
              <span class="binding-ago">{b.lastTs === null ? '—' : ageLabel(b.lastTs, nowMs)}</span>
            </div>
          {/each}
        </div>
      </details>
    {/if}

    {#if sequenceStore.runLog.length > 0}
      <details style="margin-top:14px">
        <summary style="cursor:pointer;font-size:13px;color:var(--text-dim)">{t('encode.sequence_log')} ({sequenceStore.runLog.length})</summary>
        <div class="seq-log">
          {#each sequenceStore.runLog as entry (entry.ts + entry.stmtId)}
            <div class="seq-log-row">
              <span class="seq-log-ts">{new Date(entry.ts).toLocaleTimeString()}</span>
              <span class="seq-log-status" style="color:{entry.ok ? 'var(--green, #3fb950)' : 'var(--red)'}">{entry.ok ? '✓' : '✗'}</span>
              <span class="seq-log-label">{entry.label}</span>
              {#if entry.error}<span class="seq-log-err">{entry.error}</span>{/if}
            </div>
          {/each}
        </div>
        <button class="copy-btn" style="font-size:11px;margin-top:8px" onclick={() => sequenceStore.clearLog()}>{t('encode.sequence_clear_log')}</button>
      </details>
    {/if}
  </div>
</div>

{#snippet renderStmt(stmt: SeqStatement, depth: number, index: number)}
  {#if index === 0}
    <div class="ast-insert-row ast-insert-before-row">
      <span style="font-size:11px;color:var(--text-dim)">{t('encode.sequence_insert_before')}:</span>
      <button class="chip chip-sm" onclick={() => insertBefore(stmt.id, 'send')} disabled={sequenceStore.running}>+ {t('encode.stmt_send')}</button>
      <button class="chip chip-sm" onclick={() => insertBefore(stmt.id, 'wait')} disabled={sequenceStore.running}>+ {t('encode.stmt_wait')}</button>
      <button class="chip chip-sm" onclick={() => insertBefore(stmt.id, 'repeat')} disabled={sequenceStore.running}>+ {t('encode.stmt_repeat')}</button>
      <button class="chip chip-sm" onclick={() => insertBefore(stmt.id, 'every')} disabled={sequenceStore.running}>+ {t('encode.stmt_every')}</button>
      <button class="chip chip-sm" onclick={() => insertBefore(stmt.id, 'sweep')} disabled={sequenceStore.running}>+ {t('encode.stmt_sweep')}</button>
      <button class="chip chip-sm" onclick={() => insertBefore(stmt.id, 'group')} disabled={sequenceStore.running}>+ {t('encode.stmt_group')}</button>
      <button class="chip chip-sm" onclick={() => insertBefore(stmt.id, 'set')} disabled={sequenceStore.running}>+ {t('encode.stmt_set')}</button>
      <button class="chip chip-sm" onclick={() => insertBefore(stmt.id, 'bind')} disabled={sequenceStore.running}>+ {t('program.stmt_bind')}</button>
      <button class="chip chip-sm" onclick={() => insertBefore(stmt.id, 'read')} disabled={sequenceStore.running}>+ {t('program.stmt_read')}</button>
    </div>
  {/if}
  <div class="ast-row"
    class:running={sequenceStore.currentStmtId === stmt.id}
    class:dragging={dragId === stmt.id}
    class:selected={selectedIds.includes(stmt.id)}
    class:drop-before={dropTarget?.id === stmt.id && dropTarget.position === 'before'}
    class:drop-after={dropTarget?.id === stmt.id && dropTarget.position === 'after'}
    class:drop-inside={dropTarget?.id === stmt.id && dropTarget.position === 'inside'}
    style="--depth: {depth}"
    draggable={!sequenceStore.running}
    onclick={(e) => onRowClick(e, stmt.id)}
    ondragstart={(e) => onDragStart(e, stmt.id)}
    ondragend={onDragEnd}
    ondragover={(e) => onRowDragOver(e, stmt)}
    ondrop={(e) => onRowDrop(e, stmt)}>
    <span class="ast-rail" aria-hidden="true"></span>
    <div class="ast-content">
      <div class="ast-line">
        <input type="checkbox" checked={stmt.enabled} class="ast-enable"
          onchange={(e) => sequenceStore.updateStmt(stmt.id, { enabled: (e.target as HTMLInputElement).checked })}
          disabled={sequenceStore.running} />

        {#if stmt.type === 'send'}
          <span class="stmt-chip chip-send">{t('encode.stmt_send')}</span>
          <span class="ast-label" title={stmtSummary(stmt)}>{stmtSummary(stmt) || '(no message)'}</span>
          {#if isMissingConfig(stmt)}
            <span class="stmt-warn" title={t('encode.send_missing_config')}>⚠</span>
          {:else}
            {@const encErr = encodingError(stmt)}
            {#if encErr}
              <span class="stmt-warn stmt-warn-err" title={encErr}>⚠</span>
            {/if}
          {/if}

        {:else if stmt.type === 'wait'}
          <span class="stmt-chip chip-wait">{t('encode.stmt_wait')}</span>
          <input class="ast-num" type="number" min="0" value={stmt.ms}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { ms: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })}
            disabled={sequenceStore.running} />
          <span class="ast-unit">ms</span>

        {:else if stmt.type === 'repeat'}
          <span class="stmt-chip chip-repeat">{t('encode.stmt_repeat')}</span>
          <input class="ast-num" type="number" min="0" value={stmt.count}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { count: Math.max(0, Number((e.target as HTMLInputElement).value) | 0) })}
            disabled={sequenceStore.running} />
          <span class="ast-unit">{t('encode.repeat_times_suffix')}</span>

        {:else if stmt.type === 'every'}
          <span class="stmt-chip chip-every">{t('encode.stmt_every')}</span>
          <span class="ast-unit">{t('encode.every_period_label')}</span>
          <input class="ast-num" type="number" min="1" value={stmt.periodMs}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { periodMs: Math.max(1, Number((e.target as HTMLInputElement).value) | 0) })}
            disabled={sequenceStore.running} />
          <span class="ast-unit">ms</span>
          <span class="ast-unit">·  {t('encode.every_initial_label')}</span>
          <input class="ast-num" type="number" min="0" value={stmt.initialDelayMs}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { initialDelayMs: Math.max(0, Number((e.target as HTMLInputElement).value) | 0) })}
            disabled={sequenceStore.running} />
          <span class="ast-unit">ms</span>
          <span class="ast-unit">·  {t('encode.every_duration_label')}</span>
          <input class="ast-num" type="number" min="0" value={stmt.durationMs ?? ''} placeholder="∞"
            onchange={(e) => {
              const v = (e.target as HTMLInputElement).value;
              sequenceStore.updateStmt(stmt.id, { durationMs: v === '' ? undefined : Math.max(0, Number(v) | 0) });
            }}
            disabled={sequenceStore.running} />
          <span class="ast-unit">ms{#if stmt.durationMs === undefined} {t('encode.every_duration_unbounded')}{/if}</span>

        {:else if stmt.type === 'sweep'}
          <span class="stmt-chip chip-sweep">{t('encode.stmt_sweep')}</span>
          <select class="ast-text" value={stmt.msgName}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { msgName: (e.target as HTMLSelectElement).value } as Partial<SweepStmt>)}
            disabled={sequenceStore.running}>
            <option value="">{t('program.pick_message')}</option>
            {#each deviceGroups as group}
              <optgroup label={group.device}>
                {#each group.messages as name}<option value={name}>{name}</option>{/each}
              </optgroup>
            {/each}
          </select>
          <input class="ast-text" placeholder={t('encode.sweep_signal_label')} value={stmt.signal}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { signal: (e.target as HTMLInputElement).value })}
            disabled={sequenceStore.running} />
          <span class="ast-unit">{t('encode.sweep_from_label')}</span>
          <input class="ast-num" type="number" value={stmt.from}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { from: Number((e.target as HTMLInputElement).value) || 0 })}
            disabled={sequenceStore.running} />
          <span class="ast-unit">{t('encode.sweep_to_label')}</span>
          <input class="ast-num" type="number" value={stmt.to}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { to: Number((e.target as HTMLInputElement).value) || 0 })}
            disabled={sequenceStore.running} />
          <span class="ast-unit">{t('encode.sweep_step_label')}</span>
          <input class="ast-num" type="number" value={stmt.step}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { step: Number((e.target as HTMLInputElement).value) || 0 })}
            disabled={sequenceStore.running} />
          <span class="ast-unit">·  {t('encode.sweep_period_label')}</span>
          <input class="ast-num" type="number" min="0" value={stmt.periodMs}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { periodMs: Math.max(0, Number((e.target as HTMLInputElement).value) | 0) })}
            disabled={sequenceStore.running} />
          <span class="ast-unit">ms</span>
          <span class="ast-unit" style="color:var(--text-dim)">({sweepCount(stmt.from, stmt.to, stmt.step)} {t('encode.sweep_iterations')})</span>

        {:else if stmt.type === 'group'}
          <span class="stmt-chip chip-group">{t('encode.stmt_group')}</span>
          <input class="ast-text ast-text-wide" value={stmt.label}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { label: (e.target as HTMLInputElement).value })}
            disabled={sequenceStore.running} />

        {:else if stmt.type === 'set'}
          <span class="stmt-chip chip-set">{t('encode.stmt_set')}</span>
          <input class="ast-text" placeholder={t('encode.set_name_placeholder')} value={stmt.name}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { name: (e.target as HTMLInputElement).value } as Partial<SetStmt>)}
            disabled={sequenceStore.running} />
          <span class="ast-unit">=</span>
          <input class="ast-text ast-text-wide" placeholder={t('encode.set_expr_placeholder')} value={stmt.expr}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { expr: (e.target as HTMLInputElement).value } as Partial<SetStmt>)}
            disabled={sequenceStore.running} />

        {:else if stmt.type === 'bind' || stmt.type === 'read'}
          {@const isBind = stmt.type === 'bind'}
          {@const bMsg = stmt.msgName ? codecStore.codec.getMessageByName(stmt.msgName) : null}
          {@const bSigs = bMsg?.signals.filter(g => !g.constant) ?? []}
          {@const bMulti = (bMsg?.node_count ?? 1) > 1}
          <span class="stmt-chip {isBind ? 'chip-bind' : 'chip-read'}">{isBind ? t('program.stmt_bind') : t('program.stmt_read')}</span>
          <input class="ast-text" placeholder={t('program.var_name_placeholder')} value={stmt.varName}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { varName: (e.target as HTMLInputElement).value } as Partial<BindStmt | ReadStmt>)}
            disabled={sequenceStore.running} />
          <span class="ast-unit">←</span>
          <select class="ast-text" value={stmt.msgName}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, {
              msgName: (e.target as HTMLSelectElement).value,
              signal: '',
            } as Partial<BindStmt | ReadStmt>)}
            disabled={sequenceStore.running} style="min-width:160px">
            <option value="">{t('program.pick_message')}</option>
            {#each deviceGroups as group}
              <optgroup label={group.device}>
                {#each group.messages as name}<option value={name}>{name}</option>{/each}
              </optgroup>
            {/each}
          </select>
          <span class="ast-unit">.</span>
          <select class="ast-text" value={stmt.signal}
            onchange={(e) => sequenceStore.updateStmt(stmt.id, { signal: (e.target as HTMLSelectElement).value } as Partial<BindStmt | ReadStmt>)}
            disabled={sequenceStore.running || !bMsg} style="min-width:140px">
            <option value="">{t('program.pick_signal')}</option>
            {#each bSigs as s}<option value={s.name}>{s.name}{s.unit ? ` (${s.unit})` : ''}</option>{/each}
          </select>
          {#if bMulti}
            <span class="ast-unit">@</span>
            <input class="ast-text ast-text-narrow" type="text" placeholder="node | =expr"
              value={stmt.nodeId ?? ''}
              onchange={(e) => {
                const raw = (e.target as HTMLInputElement).value.trim();
                let next: number | string | undefined;
                if (raw === '') next = undefined;
                else if (/^-?\d+$/.test(raw)) next = Number(raw);
                else next = raw;
                sequenceStore.updateStmt(stmt.id, { nodeId: next } as Partial<BindStmt | ReadStmt>);
              }}
              disabled={sequenceStore.running} title={t('program.node_required_hint')} />
          {/if}
          {#if !isBind}
            <span class="ast-unit">{t('program.read_timeout_label')}</span>
            <input class="ast-text ast-text-narrow" type="number" min="1"
              value={(stmt as ReadStmt).timeoutMs}
              onchange={(e) => sequenceStore.updateStmt(stmt.id, { timeoutMs: Math.max(1, Number((e.target as HTMLInputElement).value) | 0) } as Partial<ReadStmt>)}
              disabled={sequenceStore.running} />
            <span class="ast-unit">ms</span>
          {/if}
        {/if}

        <span style="flex:1"></span>

        <div class="ast-actions">
          {#if stmt.type === 'send'}
            <button class="ast-btn ast-btn-expand" onclick={() => toggleExpand(stmt.id)}
              title={expandedSends[stmt.id] ? 'Collapse' : 'Edit values'}>
              {expandedSends[stmt.id] ? '⌄' : '›'}
            </button>
          {/if}
          {#if depth === 0 && stmt.type === 'group'}
            <button class="ast-btn ast-btn-run" onclick={() => sequenceStore.runCell(stmt.id)}
              disabled={sequenceStore.running || stmt.body.length === 0 || !busStore.connected}
              title={t('program.run_cell')}>▶ {t('program.run_label')}</button>
          {/if}
          <button class="ast-btn" onclick={() => sequenceStore.moveStmt(stmt.id, -1)} disabled={sequenceStore.running} title={t('encode.sequence_move_up')}>↑</button>
          <button class="ast-btn" onclick={() => sequenceStore.moveStmt(stmt.id, 1)} disabled={sequenceStore.running} title={t('encode.sequence_move_down')}>↓</button>
          <button class="ast-btn" onclick={() => sequenceStore.duplicateStmt(stmt.id)} disabled={sequenceStore.running} title={t('encode.sequence_duplicate')}>⎘</button>
          <button class="ast-btn" onclick={() => sequenceStore.removeStmt(stmt.id)} disabled={sequenceStore.running} title={t('encode.sequence_remove')}>×</button>
        </div>
      </div>

      {#if stmt.type === 'send' && expandedSends[stmt.id]}
        {@render sendEditor(stmt)}
      {/if}

      {#if stmt.type === 'repeat' || stmt.type === 'every' || stmt.type === 'group'}
        {@const body = stmt.body}
        <div class="ast-body">
          {#each body as child, j (child.id)}
            {@render renderStmt(child, depth + 1, j)}
          {/each}
          <div class="ast-add-row">
            <span style="font-size:11px;color:var(--text-dim)">{t('encode.sequence_add_child')}:</span>
            <button class="chip chip-sm" onclick={() => addChild(stmt.id, 'send')} disabled={sequenceStore.running}>+ {t('encode.stmt_send')}</button>
            <button class="chip chip-sm" onclick={() => addChild(stmt.id, 'wait')} disabled={sequenceStore.running}>+ {t('encode.stmt_wait')}</button>
            <button class="chip chip-sm" onclick={() => addChild(stmt.id, 'repeat')} disabled={sequenceStore.running}>+ {t('encode.stmt_repeat')}</button>
            <button class="chip chip-sm" onclick={() => addChild(stmt.id, 'every')} disabled={sequenceStore.running}>+ {t('encode.stmt_every')}</button>
            <button class="chip chip-sm" onclick={() => addChild(stmt.id, 'sweep')} disabled={sequenceStore.running}>+ {t('encode.stmt_sweep')}</button>
            <button class="chip chip-sm" onclick={() => addChild(stmt.id, 'group')} disabled={sequenceStore.running}>+ {t('encode.stmt_group')}</button>
            <button class="chip chip-sm" onclick={() => addChild(stmt.id, 'set')} disabled={sequenceStore.running}>+ {t('encode.stmt_set')}</button>
            <button class="chip chip-sm" onclick={() => addChild(stmt.id, 'bind')} disabled={sequenceStore.running}>+ {t('program.stmt_bind')}</button>
            <button class="chip chip-sm" onclick={() => addChild(stmt.id, 'read')} disabled={sequenceStore.running}>+ {t('program.stmt_read')}</button>
          </div>
        </div>
      {/if}

      <div class="ast-insert-row">
        <span style="font-size:11px;color:var(--text-dim)">{t('encode.sequence_insert_after')}:</span>
        <button class="chip chip-sm" onclick={() => insertAfter(stmt.id, 'send')} disabled={sequenceStore.running}>+ {t('encode.stmt_send')}</button>
        <button class="chip chip-sm" onclick={() => insertAfter(stmt.id, 'wait')} disabled={sequenceStore.running}>+ {t('encode.stmt_wait')}</button>
        <button class="chip chip-sm" onclick={() => insertAfter(stmt.id, 'repeat')} disabled={sequenceStore.running}>+ {t('encode.stmt_repeat')}</button>
        <button class="chip chip-sm" onclick={() => insertAfter(stmt.id, 'every')} disabled={sequenceStore.running}>+ {t('encode.stmt_every')}</button>
        <button class="chip chip-sm" onclick={() => insertAfter(stmt.id, 'sweep')} disabled={sequenceStore.running}>+ {t('encode.stmt_sweep')}</button>
        <button class="chip chip-sm" onclick={() => insertAfter(stmt.id, 'group')} disabled={sequenceStore.running}>+ {t('encode.stmt_group')}</button>
        <button class="chip chip-sm" onclick={() => insertAfter(stmt.id, 'set')} disabled={sequenceStore.running}>+ {t('encode.stmt_set')}</button>
        <button class="chip chip-sm" onclick={() => insertAfter(stmt.id, 'bind')} disabled={sequenceStore.running}>+ {t('program.stmt_bind')}</button>
        <button class="chip chip-sm" onclick={() => insertAfter(stmt.id, 'read')} disabled={sequenceStore.running}>+ {t('program.stmt_read')}</button>
      </div>
    </div>
  </div>
{/snippet}

{#snippet sendEditor(stmt: SendStmt)}
  {@const msg = stmt.msgName ? codecStore.codec.getMessageByName(stmt.msgName) : null}
  {@const sigs = msg?.signals.filter(s => !s.constant) ?? []}
  {@const groups = groupArraySignalDefs(sigs)}
  {@const preview = previewLine(stmt)}
  {@const bcSupported = !!(msg && msg.broadcast_node_id !== null && msg.node_count > 1 && !stmt.isMavlink)}
  {@const editorValues = sendValuesFor(stmt)}
  <div class="send-editor">
    <div class="send-editor-meta">
      <span class="send-editor-label">message</span>
      <select class="send-editor-input" value={stmt.msgName ?? ''}
        onchange={(e) => pickMessage(stmt, (e.target as HTMLSelectElement).value)}
        disabled={sequenceStore.running} style="min-width:200px">
        <option value="">{t('program.pick_message')}</option>
        {#each deviceGroups as group}
          <optgroup label={group.device}>
            {#each group.messages as name}<option value={name}>{name}</option>{/each}
          </optgroup>
        {/each}
      </select>
      {#if bcSupported}
        <label class="send-editor-bc-toggle" title={t('program.broadcast_hint')}>
          <input type="checkbox" checked={!!stmt.isBroadcast}
            onchange={(e) => toggleBroadcast(stmt, (e.target as HTMLInputElement).checked)}
            disabled={sequenceStore.running} />
          {t('program.broadcast')}
        </label>
      {/if}
      {#if msg && msg.node_count > 1 && !stmt.isMavlink && !stmt.isBroadcast}
        <span class="send-editor-label">node</span>
        <input class="ast-text ast-text-narrow" type="text"
          value={stmt.nodeId ?? msg.node_id_start}
          placeholder={String(msg.node_id_start)}
          title="Numeric id or expression (e.g. =node_var)"
          onchange={(e) => sequenceStore.updateStmt(stmt.id, { nodeId: (e.target as HTMLInputElement).value } as Partial<SendStmt>)}
          disabled={sequenceStore.running} />
      {/if}
      {#if stmt.isMavlink}
        <span class="send-editor-label">sys</span>
        <input class="ast-text ast-text-narrow" type="text" value={stmt.sysId ?? 1}
          onchange={(e) => sequenceStore.updateStmt(stmt.id, { sysId: (e.target as HTMLInputElement).value } as Partial<SendStmt>)}
          disabled={sequenceStore.running} />
        <span class="send-editor-label">comp</span>
        <input class="ast-text ast-text-narrow" type="text" value={stmt.compId ?? 1}
          onchange={(e) => sequenceStore.updateStmt(stmt.id, { compId: (e.target as HTMLInputElement).value } as Partial<SendStmt>)}
          disabled={sequenceStore.running} />
      {/if}
    </div>

    {#if stmt.isBroadcast && msg}
      {@const start = msg.node_id_start}
      {@const active = activeBcNode[stmt.id] ?? start}
      <div class="send-editor-bc-tabs">
        <span class="send-editor-label">{t('program.broadcast_editing')}</span>
        {#each Array(msg.node_count) as _, i}
          {@const nid = start + i}
          <button class="bc-tab" class:active={active === nid}
            onclick={() => (activeBcNode[stmt.id] = nid)}
            disabled={sequenceStore.running}>{nid}</button>
        {/each}
      </div>
    {/if}

    {#if msg && groups.length > 0}
      <div class="send-editor-grid">
        {#each groups as group}
          <div class="send-editor-cell">
            <span class="send-editor-cell-label">
              {group.base}{#if group.items[0].unit}<span style="color:var(--text-dim);font-weight:400"> ({group.items[0].unit})</span>{/if}
              {#if group.items.length > 1}<span style="color:var(--text-dim);font-weight:400;font-size:11px"> [{group.items.length}]</span>{/if}
            </span>
            {#if group.items.length === 1 && Object.keys(group.items[0].enum_map).length > 0}
              <select class="send-editor-input"
                value={String(editorValues[group.items[0].name] ?? '')}
                onchange={(e) => setSendValue(stmt, group.items[0].name, (e.target as HTMLSelectElement).value)}
                disabled={sequenceStore.running}>
                <option value="">{t('encode.select_placeholder')}</option>
                {#each Object.entries(group.items[0].enum_map) as [k, v]}<option value={v}>{v} ({k})</option>{/each}
              </select>
            {:else if group.items.length === 1}
              <input class="send-editor-input"
                value={String(editorValues[group.items[0].name] ?? '')}
                onchange={(e) => setSendValue(stmt, group.items[0].name, (e.target as HTMLInputElement).value)}
                disabled={sequenceStore.running} />
            {:else}
              <input class="send-editor-input"
                value={getSendArrayDisplay(stmt, group)}
                placeholder="v0, v1, v2, ..."
                onchange={(e) => setSendArrayValue(stmt, group, (e.target as HTMLInputElement).value)}
                disabled={sequenceStore.running} />
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if msg}
      <div class="send-editor-hint">{t('encode.var_hint')}</div>

      <div class="send-editor-preview">
        {#if preview.error}
          <span style="color:var(--red)">⚠ {preview.error}</span>
        {:else}
          <span class="send-editor-arrow">→</span>
          <pre class="send-editor-frame">{preview.text}</pre>
          <button class="copy-btn send-editor-copy" onclick={() => copyPreview(stmt)}
            title={t('encode.copy_cansend')}>
            {copiedPreview[stmt.id] ? t('encode.copied') : t('encode.copy_cansend')}
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<style>
  .connection-card { padding: 12px 16px; }

  .ast-tree {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px;
    background: var(--bg);
  }

  .ast-row {
    position: relative;
    padding-left: calc(var(--depth) * 18px);
  }

  .ast-row.running > .ast-content > .ast-line {
    background: rgba(63, 185, 80, 0.10);
  }

  .ast-row.selected > .ast-content > .ast-line {
    background: rgba(88, 166, 255, 0.14);
    box-shadow: inset 2px 0 0 var(--accent, #58a6ff);
  }
  .ast-row.dragging > .ast-content > .ast-line {
    opacity: 0.4;
  }

  .ast-rail {
    position: absolute;
    left: calc(var(--depth) * 18px - 8px);
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border);
    display: none;
  }

  .ast-content { display: flex; flex-direction: column; }

  .ast-line {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    background: var(--bg-card, transparent);
    border: 1px solid var(--border);
    border-radius: 4px;
    flex-wrap: wrap;
    cursor: grab;
  }
  .ast-line:active { cursor: grabbing; }
  .ast-row.dragging > .ast-content > .ast-line { cursor: grabbing; }

  .ast-enable { accent-color: var(--accent, #58a6ff); }

  .stmt-chip {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 3px;
    color: #000;
  }
  .chip-send   { background: #58a6ff; }
  .chip-wait   { background: #8b949e; }
  .chip-repeat { background: #d29922; }
  .chip-every  { background: #3fb950; }
  .chip-sweep  { background: #bc8cff; }
  .chip-group  { background: #f78166; }
  .chip-set    { background: #f0d000; }
  .chip-bind   { background: #58a6ff; }
  .chip-read   { background: #79c0ff; }

  .bindings-panel {
    margin-top: 14px;
    background: rgba(88, 166, 255, 0.06);
    border: 1px solid rgba(88, 166, 255, 0.25);
    border-radius: var(--radius);
    padding: 8px 12px;
  }
  .bindings-panel > summary {
    cursor: pointer;
    font-size: 13px;
    color: var(--accent, #58a6ff);
    font-weight: 600;
  }
  .bindings-grid {
    margin-top: 8px;
    display: grid;
    grid-template-columns: auto auto 1fr auto auto;
    column-gap: 10px;
    row-gap: 4px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .binding-row {
    display: contents;
  }
  .binding-name  { color: var(--accent, #58a6ff); font-weight: 600; }
  .binding-arrow { color: var(--text-dim); }
  .binding-src   { color: var(--text); }
  .binding-value { color: var(--green, #3fb950); text-align: right; }
  .binding-ago   { color: var(--text-dim); text-align: right; }

  .ast-text-narrow { max-width: 72px; }

  .ast-label {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ast-num {
    width: 72px;
    padding: 3px 6px;
    background: var(--bg-input, var(--bg));
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
    text-align: right;
  }
  .ast-text {
    width: 110px;
    padding: 3px 6px;
    background: var(--bg-input, var(--bg));
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .ast-text-wide { width: 200px; }
  .ast-text-narrow { width: 80px; }
  .ast-num:disabled, .ast-text:disabled { opacity: 0.6; }
  .ast-unit { font-size: 11px; color: var(--text-dim); }

  .ast-actions { display: flex; gap: 2px; }
  .ast-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 3px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1;
  }
  .ast-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.05); }
  .ast-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .ast-btn-run {
    color: var(--green, #3fb950);
    border-color: var(--green, #3fb950);
    width: auto;
    padding: 0 8px;
    font-weight: 600;
  }
  .ast-btn-run:hover:not(:disabled) { background: rgba(63, 185, 80, 0.12); }
  .ast-btn-expand {
    color: var(--text-dim);
    border-color: transparent;
    font-size: 14px;
  }

  .selection-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(88, 166, 255, 0.14);
    color: var(--accent, #58a6ff);
    border: 1px solid var(--accent, #58a6ff);
    border-radius: 12px;
    padding: 2px 10px;
    font-size: 12px;
    font-weight: 500;
  }
  .selection-clear {
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    padding: 0 4px;
    font-size: 14px;
    line-height: 1;
  }
  .selection-clear:hover { color: var(--text); }

  .ast-body {
    margin-top: 4px;
    margin-left: 18px;
    padding-left: 8px;
    border-left: 1px dashed var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .ast-add-row, .ast-insert-row {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    padding: 2px 0;
  }
  .ast-insert-row { margin-top: 2px; }

  .chip-sm {
    font-size: 11px;
    padding: 2px 8px;
  }

  .stmt-warn { color: var(--yellow, #d29922); font-size: 14px; }
  .stmt-warn-err { color: var(--red, #f85149); }

  .seq-log {
    margin-top: 8px;
    max-height: 240px;
    overflow-y: auto;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .seq-log-row { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
  .seq-log-ts { color: var(--text-dim); width: 90px; flex-shrink: 0; }
  .seq-log-status { width: 14px; flex-shrink: 0; text-align: center; }
  .seq-log-label { color: var(--text); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .seq-log-err { color: var(--red); font-size: 11px; }

  /* Drag-and-drop */
  .ast-row.dragging > .ast-content > .ast-line { opacity: 0.35; }

  .ast-row.drop-before > .ast-content > .ast-line {
    box-shadow: 0 -3px 0 var(--accent, #58a6ff);
  }
  .ast-row.drop-after > .ast-content > .ast-line {
    box-shadow: 0 3px 0 var(--accent, #58a6ff);
  }
  .ast-row.drop-inside > .ast-content > .ast-line {
    outline: 2px solid var(--accent, #58a6ff);
    outline-offset: -1px;
    background: rgba(88, 166, 255, 0.08);
  }

  .ast-end-zone {
    margin-top: 4px;
    padding: 10px 12px;
    border: 1px dashed var(--border);
    border-radius: 4px;
    text-align: center;
    color: var(--text-dim);
    font-size: 12px;
    background: rgba(255, 255, 255, 0.02);
  }
  .ast-end-zone.active {
    border-color: var(--accent, #58a6ff);
    color: var(--text);
    background: rgba(88, 166, 255, 0.10);
  }

  /* Inline send-statement editor */
  .send-editor {
    margin-top: 4px;
    margin-left: 18px;
    padding: 8px 12px;
    border-left: 2px solid var(--accent, #58a6ff);
    background: rgba(88, 166, 255, 0.04);
    border-radius: 0 4px 4px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .send-editor-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
  }

  .send-editor-label {
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  .send-editor-bc-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--accent, #58a6ff);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  .send-editor-bc-toggle input { margin: 0; cursor: pointer; }

  .send-editor-bc-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .send-editor-bc-tabs > .send-editor-label { white-space: nowrap; }
  .bc-tab {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
    width: 28px;
    height: 22px;
    padding: 0;
    border-radius: 3px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1;
  }
  .bc-tab:hover:not(:disabled) { background: rgba(255, 255, 255, 0.05); }
  .bc-tab.active {
    background: rgba(88, 166, 255, 0.18);
    border-color: var(--accent, #58a6ff);
    color: var(--accent, #58a6ff);
    font-weight: 600;
  }
  .bc-tab:disabled { opacity: 0.4; cursor: not-allowed; }

  .send-editor-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 8px;
  }

  .send-editor-cell { display: flex; flex-direction: column; gap: 2px; }

  .send-editor-cell-label {
    font-size: 11px;
    color: var(--text-dim);
    font-weight: 500;
  }

  .send-editor-input {
    padding: 4px 6px;
    background: var(--bg-input, var(--bg));
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    font-size: 12px;
    font-family: var(--font-mono);
  }

  .send-editor-input:disabled { opacity: 0.6; }

  .send-editor-preview {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding-top: 4px;
    border-top: 1px dashed var(--border);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .send-editor-hint {
    font-size: 11px;
    color: var(--text-dim);
    font-style: italic;
    padding: 2px 0;
  }

  .send-editor-arrow { color: var(--green, #3fb950); font-weight: 600; }

  .send-editor-copy {
    flex-shrink: 0;
    margin-left: auto;
    font-size: 11px;
    padding: 2px 8px;
  }

  .send-editor-frame {
    margin: 0;
    color: var(--green, #3fb950);
    white-space: pre-wrap;
    word-break: break-all;
    flex: 1;
  }
</style>
