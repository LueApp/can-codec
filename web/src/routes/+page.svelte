<script lang="ts">
  import { codecStore } from '$lib/codec-store.svelte';
  import { CONFIG_TEMPLATES } from '$lib/templates';
  import { t } from '$lib/i18n.svelte';

  let search = $state('');
  let selectedDevice = $state('');
  let expandedMsg = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement>(null!);
  let folderInput = $state<HTMLInputElement>(null!);

  const allMessages = $derived(codecStore.allMessages);
  const deviceNames = $derived([...new Set(allMessages.map((m) => m.device))]);
  const messages = $derived(
    allMessages
      .filter((m) => !selectedDevice || m.device === selectedDevice)
      .filter((m) => !search || m.name.toLowerCase().includes(search.toLowerCase()) || m.description.toLowerCase().includes(search.toLowerCase()))
  );

  // Group messages by device for display
  const groupedMessages = $derived(() => {
    const groups: Map<string, typeof messages> = new Map();
    for (const msg of messages) {
      if (!groups.has(msg.device)) groups.set(msg.device, []);
      groups.get(msg.device)!.push(msg);
    }
    return Array.from(groups.entries());
  });

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.name.endsWith('.yaml') || file.name.endsWith('.yml') || file.name.endsWith('.xml'))
        codecStore.addConfig(file.name, await file.text());
    }
  }
</script>

<div class="container">
  <div class="page-header">
    <h1>{t('messages.title')}</h1>
    <p>{t('messages.subtitle')}</p>
  </div>

  <!-- Config Management Card -->
  <div class="card">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: {codecStore.configs.length > 0 ? '16px' : '0'};">
      <h2 style="margin-bottom: 0;">{t('messages.configs_heading')} ({codecStore.configs.length})</h2>
      <div style="display: flex; gap: 8px; align-items: center;">
        {#if codecStore.configs.length > 1}
          <button style="padding: 4px 10px; font-size: 12px;" onclick={() => codecStore.enableAllConfigs()}>{t('messages.all')}</button>
          <button style="padding: 4px 10px; font-size: 12px;" onclick={() => codecStore.disableAllConfigs()}>{t('messages.none')}</button>
          <span style="width: 1px; height: 20px; background: var(--border);"></span>
        {/if}
        <input bind:this={fileInput} type="file" accept=".yaml,.yml,.xml" multiple
          style="display:none" onchange={(e) => handleFiles((e.target as HTMLInputElement).files)} />
        <input bind:this={folderInput} type="file" accept=".yaml,.yml,.xml"
          style="display:none" onchange={(e) => handleFiles((e.target as HTMLInputElement).files)}
          webkitdirectory />
        <button onclick={() => fileInput.click()}>{t('nav.add_files')}</button>
        <button onclick={() => folderInput.click()}>{t('nav.add_folder')}</button>
      </div>
    </div>
    {#if codecStore.configs.length === 0}
      <div style="text-align: center; padding: 24px; color: var(--text-dim);">
        <p style="margin-bottom: 16px;">{t('messages.empty_hint')}</p>
        <p style="margin-bottom: 12px; font-size: 13px;">{t('messages.template_hint')}</p>
        <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
          {#each CONFIG_TEMPLATES as tmpl}
            <button onclick={() => codecStore.loadTemplate(tmpl.id)} style="display: flex; flex-direction: column; align-items: center; padding: 12px 20px;">
              <strong>{tmpl.name}</strong>
              <span style="font-size: 12px; color: var(--text-dim); margin-top: 4px;">{tmpl.description}</span>
            </button>
          {/each}
        </div>
      </div>
    {:else}
      {#each codecStore.configs as cfg}
        <div class="config-item" style:opacity={cfg.enabled ? 1 : 0.5}>
          <div style="display: flex; align-items: center; gap: 12px;">
            <label class="toggle">
              <input type="checkbox" checked={cfg.enabled}
                onchange={() => codecStore.toggleConfig(cfg.filename)} />
              <span class="toggle-slider"></span>
            </label>
            <div>
              <span class="config-name">{cfg.filename}</span>
              <span style="font-size: 12px; color: var(--text-dim); margin-left: 8px;">
                {cfg.filename.endsWith('.xml') ? 'MAVLink XML' : 'YAML'}
              </span>
            </div>
          </div>
          <button class="danger" style="padding: 4px 10px; font-size: 12px;" onclick={() => codecStore.removeConfig(cfg.filename)}>{t('messages.remove')}</button>
        </div>
      {/each}
      {#if CONFIG_TEMPLATES.some(tpl => !codecStore.configs.find(c => c.filename === tpl.filename))}
        <div style="padding: 8px 0; border-top: 1px solid var(--border); margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span style="font-size: 12px; color: var(--text-dim);">{t('messages.templates_label')}</span>
          {#each CONFIG_TEMPLATES.filter(tpl => !codecStore.configs.find(c => c.filename === tpl.filename)) as tmpl}
            <button style="padding: 4px 10px; font-size: 12px;" onclick={() => codecStore.loadTemplate(tmpl.id)}>+ {tmpl.name}</button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  {#if allMessages.length > 0}
    <div class="card" style="padding: 16px;">
      <div class="form-row" style="margin-bottom: 0;">
        <input placeholder={t('messages.search_placeholder')} bind:value={search} />
        <select bind:value={selectedDevice}>
          <option value="">{t('messages.all_devices')} ({allMessages.length} {t('messages.count_messages')})</option>
          {#each deviceNames as name}
            {@const count = allMessages.filter(m => m.device === name).length}
            <option value={name}>{name} ({count})</option>
          {/each}
        </select>
      </div>
    </div>

    {#each groupedMessages() as [device, msgs]}
      <div class="card" style="padding: 0; overflow: hidden;">
        <div style="padding: 12px 16px; background: var(--bg-input); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px;">
          <strong>{device}</strong>
          <span style="font-size: 12px; color: var(--text-dim);">({msgs.length} {t('messages.count_messages')})</span>
          {#if msgs[0]?.mavlink}
            <span class="tag" style="background:rgba(139,148,158,0.15); color:var(--text-dim); font-size:10px;">{t('messages.mavlink_tag')}</span>
          {/if}
          <span style="margin-left: auto; display: flex; gap: 4px;">
            <button style="padding: 2px 8px; font-size: 11px;" onclick={() => codecStore.enableAllMessages(msgs[0].filename)}>{t('messages.all')}</button>
            <button style="padding: 2px 8px; font-size: 11px;" onclick={() => codecStore.disableAllMessages(msgs[0].filename)}>{t('messages.none')}</button>
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th style="width: 36px;"></th><th>{t('messages.col_id')}</th><th>{t('messages.col_name')}</th><th>{t('messages.col_dir')}</th><th>{t('messages.col_dlc')}</th><th>{t('messages.col_description')}</th>
            </tr>
          </thead>
          <tbody>
            {#each msgs as msg}
              <tr style="cursor: pointer;" style:opacity={msg.enabled ? 1 : 0.4}
                onclick={() => expandedMsg = expandedMsg === msg.name ? null : msg.name}>
                <td onclick={(e) => e.stopPropagation()}>
                  <label class="toggle" style="transform: scale(0.85);">
                    <input type="checkbox" checked={msg.enabled}
                      onchange={() => codecStore.toggleMessage(msg.filename, msg.name)} />
                    <span class="toggle-slider"></span>
                  </label>
                </td>
                <td>
                  <code style="font-family: var(--font-mono); color: var(--orange);">{msg.id_range ?? msg.id}</code>
                </td>
                <td>
                  <strong>{msg.name}</strong>
                  {#if (() => { const f = codecStore.getMessageFilter(msg.filename, msg.name); return f && (f.disabledNodes.length > 0 || f.disabledSignals.length > 0 || Object.keys(f.disabledEnumValues ?? {}).length > 0); })()}
                    <span class="tag" style="background: rgba(210,153,34,0.15); color: var(--orange); font-size: 10px; margin-left: 6px;">{t('messages.filtered')}</span>
                  {/if}
                </td>
                <td><span class="tag {msg.direction}">{msg.direction.toUpperCase()}</span></td>
                <td>{msg.dlc}{msg.fd ? ' FD' : ''}</td>
                <td style="color: var(--text-dim); font-size: 13px;">{msg.description}</td>
              </tr>
              {#if expandedMsg === msg.name}
                {@const msgDef = codecStore.codec.getMessageByName(msg.name)}
                {@const msgFilter = codecStore.getMessageFilter(msg.filename, msg.name)}
                <tr>
                  <td colspan="6" style="background: var(--bg); padding: 16px;">
                    {#if msgDef}
                      <!-- Node filter -->
                      {#if msg.node_count > 1}
                        {@const nodeIds = Array.from({length: msg.node_count}, (_, i) => msg.node_id_start + i)}
                        <div style="margin-bottom: 16px;">
                          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                            <strong style="font-size: 13px; color: var(--text-dim);">{t('messages.nodes')} ({msg.node_count})</strong>
                            <button style="padding: 2px 8px; font-size: 11px;"
                              onclick={() => codecStore.enableAllNodes(msg.filename, msg.name)}>{t('messages.all')}</button>
                            <button style="padding: 2px 8px; font-size: 11px;"
                              onclick={() => codecStore.disableAllNodes(msg.filename, msg.name, nodeIds)}>{t('messages.none')}</button>
                          </div>
                          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                            {#each nodeIds as nodeId}
                              {@const nodeDisabled = msgFilter?.disabledNodes.includes(nodeId) ?? false}
                              <button
                                class="filter-chip"
                                class:filter-chip-off={nodeDisabled}
                                onclick={() => codecStore.toggleNode(msg.filename, msg.name, nodeId)}>
                                N{nodeId}
                              </button>
                            {/each}
                          </div>
                        </div>
                      {/if}

                      <!-- Enum value filters (for any signal with enum values) -->
                      {#each msgDef.signals.filter(s => Object.keys(s.enum_map).length > 0) as enumSig}
                        {@const enumEntries = Object.entries(enumSig.enum_map).sort((a, b) => Number(a[0]) - Number(b[0]))}
                        {@const allEnumValues = enumEntries.map(([, v]) => v)}
                        {@const disabledForSig = msgFilter?.disabledEnumValues?.[enumSig.name] ?? []}
                        <div style="margin-bottom: 16px;">
                          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                            <strong style="font-size: 13px; color: var(--text-dim);">
                              {enumSig.name} {t('messages.filter_label')} ({enumEntries.length})
                            </strong>
                            <button style="padding: 2px 8px; font-size: 11px;"
                              onclick={() => codecStore.enableAllEnumValues(msg.filename, msg.name, enumSig.name)}>{t('messages.all')}</button>
                            <button style="padding: 2px 8px; font-size: 11px;"
                              onclick={() => codecStore.disableAllEnumValues(msg.filename, msg.name, enumSig.name, allEnumValues)}>{t('messages.none')}</button>
                          </div>
                          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                            {#each enumEntries as [key, name]}
                              {@const enumDisabled = disabledForSig.includes(name)}
                              <button
                                class="filter-chip"
                                class:filter-chip-off={enumDisabled}
                                onclick={() => codecStore.toggleEnumValue(msg.filename, msg.name, enumSig.name, name)}>
                                {name}
                              </button>
                            {/each}
                          </div>
                        </div>
                      {/each}

                      <!-- Signals table -->
                      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <strong style="color: var(--text-dim); font-size: 13px;">{t('messages.signals')} ({msgDef.signals.length})</strong>
                        <button style="padding: 2px 8px; font-size: 11px;"
                          onclick={() => codecStore.enableAllSignals(msg.filename, msg.name)}>{t('messages.all')}</button>
                        <button style="padding: 2px 8px; font-size: 11px;"
                          onclick={() => codecStore.disableAllSignals(msg.filename, msg.name, msgDef.signals.map(s => s.name))}>{t('messages.none')}</button>
                      </div>
                      <table style="font-size: 13px;">
                        <thead><tr><th style="width: 36px;"></th><th>{t('messages.col_name')}</th><th>{t('messages.col_bits')}</th><th>{t('messages.col_type')}</th><th>{t('messages.col_scale_offset')}</th><th>{t('messages.col_unit')}</th><th>{t('messages.col_enum_bitfield')}</th></tr></thead>
                        <tbody>
                          {#each msgDef.signals as sig}
                            {@const sigDisabled = msgFilter?.disabledSignals.includes(sig.name) ?? false}
                            <tr style:opacity={sigDisabled ? 0.4 : 1}>
                              <td onclick={(e) => e.stopPropagation()}>
                                <label class="toggle" style="transform: scale(0.75);">
                                  <input type="checkbox" checked={!sigDisabled}
                                    onchange={() => codecStore.toggleSignal(msg.filename, msg.name, sig.name)} />
                                  <span class="toggle-slider"></span>
                                </label>
                              </td>
                              <td style="color: var(--accent); font-family: var(--font-mono);">{sig.name}</td>
                              <td style="font-family: var(--font-mono);">[{sig.start_bit}:{sig.start_bit + sig.bit_length - 1}]</td>
                              <td>{sig.value_type}</td>
                              <td style="font-family: var(--font-mono);">{sig.scale !== 1 || sig.offset !== 0 ? `×${sig.scale} +${sig.offset}` : '—'}</td>
                              <td>{sig.unit || '—'}</td>
                              <td style="color: var(--text-dim);">
                                {#if Object.keys(sig.enum_map).length > 0}
                                  {Object.entries(sig.enum_map).map(([k,v]) => `${k}=${v}`).join(', ')}
                                {:else if Object.keys(sig.bitfield_map).length > 0}
                                  {Object.values(sig.bitfield_map).join(', ')}
                                {:else}—{/if}
                              </td>
                            </tr>
                          {/each}
                        </tbody>
                      </table>
                    {:else if !msg.enabled}
                      <span style="color: var(--text-dim); font-size: 13px;">{t('messages.enable_to_view')}</span>
                    {/if}
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {/each}

    {#if messages.length === 0}
      <div class="card" style="text-align: center; padding: 32px; color: var(--text-dim);">{t('messages.no_match')}</div>
    {/if}
  {/if}
</div>
