<script lang="ts">
  import { codecStore } from '$lib/codec-store.svelte';
  import { CONFIG_TEMPLATES } from '$lib/templates';

  let search = $state('');
  let selectedDevice = $state('');
  let expandedMsg = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement>(null!);
  let folderInput = $state<HTMLInputElement>(null!);

  const allMessages = $derived(codecStore.codec.listMessages());
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
    <h1>Messages</h1>
    <p>Browse all loaded CAN message definitions</p>
  </div>

  <!-- Config Management Card -->
  <div class="card">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: {codecStore.configs.length > 0 ? '16px' : '0'};">
      <h2 style="margin-bottom: 0;">Configs ({codecStore.configs.length})</h2>
      <div style="display: flex; gap: 8px;">
        <input bind:this={fileInput} type="file" accept=".yaml,.yml,.xml" multiple
          style="display:none" onchange={(e) => handleFiles((e.target as HTMLInputElement).files)} />
        <input bind:this={folderInput} type="file" accept=".yaml,.yml,.xml"
          style="display:none" onchange={(e) => handleFiles((e.target as HTMLInputElement).files)}
          webkitdirectory />
        <button onclick={() => fileInput.click()}>+ Files</button>
        <button onclick={() => folderInput.click()}>+ Folder</button>
      </div>
    </div>
    {#if codecStore.configs.length === 0}
      <div style="text-align: center; padding: 24px; color: var(--text-dim);">
        <p style="margin-bottom: 16px;">Upload YAML or MAVLink XML config files to get started</p>
        <p style="margin-bottom: 12px; font-size: 13px;">Or load an example template:</p>
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
        <div class="config-item">
          <div>
            <span class="config-name">{cfg.filename}</span>
            <span style="font-size: 12px; color: var(--text-dim); margin-left: 8px;">
              {cfg.filename.endsWith('.xml') ? 'MAVLink XML' : 'YAML'}
            </span>
          </div>
          <button class="danger" style="padding: 4px 10px; font-size: 12px;" onclick={() => codecStore.removeConfig(cfg.filename)}>Remove</button>
        </div>
      {/each}
      {#if CONFIG_TEMPLATES.some(t => !codecStore.configs.find(c => c.filename === t.filename))}
        <div style="padding: 8px 0; border-top: 1px solid var(--border); margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span style="font-size: 12px; color: var(--text-dim);">Templates:</span>
          {#each CONFIG_TEMPLATES.filter(t => !codecStore.configs.find(c => c.filename === t.filename)) as tmpl}
            <button style="padding: 4px 10px; font-size: 12px;" onclick={() => codecStore.loadTemplate(tmpl.id)}>+ {tmpl.name}</button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  {#if allMessages.length > 0}
    <div class="card" style="padding: 16px;">
      <div class="form-row" style="margin-bottom: 0;">
        <input placeholder="Search messages..." bind:value={search} />
        <select bind:value={selectedDevice}>
          <option value="">All devices ({allMessages.length} messages)</option>
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
          <span style="font-size: 12px; color: var(--text-dim);">({msgs.length} messages)</span>
          {#if msgs[0]?.mavlink}
            <span class="tag" style="background:rgba(139,148,158,0.15); color:var(--text-dim); font-size:10px;">MAVLink</span>
          {/if}
        </div>
        <table>
          <thead>
            <tr>
              <th>ID</th><th>Name</th><th>Dir</th><th>DLC</th><th>Description</th>
            </tr>
          </thead>
          <tbody>
            {#each msgs as msg}
              <tr style="cursor: pointer;" onclick={() => expandedMsg = expandedMsg === msg.name ? null : msg.name}>
                <td>
                  <code style="font-family: var(--font-mono); color: var(--orange);">{msg.id_range ?? msg.id}</code>
                </td>
                <td><strong>{msg.name}</strong></td>
                <td><span class="tag {msg.direction}">{msg.direction.toUpperCase()}</span></td>
                <td>{msg.dlc}{msg.fd ? ' FD' : ''}</td>
                <td style="color: var(--text-dim); font-size: 13px;">{msg.description}</td>
              </tr>
              {#if expandedMsg === msg.name}
                {@const msgDef = codecStore.codec.getMessageByName(msg.name)}
                <tr>
                  <td colspan="5" style="background: var(--bg); padding: 16px;">
                    {#if msgDef}
                      <strong style="color: var(--text-dim); font-size: 13px;">Signals ({msgDef.signals.length})</strong>
                      <table style="margin-top: 8px; font-size: 13px;">
                        <thead><tr><th>Name</th><th>Bits</th><th>Type</th><th>Scale/Offset</th><th>Unit</th><th>Enum/Bitfield</th></tr></thead>
                        <tbody>
                          {#each msgDef.signals as sig}
                            <tr>
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
      <div class="card" style="text-align: center; padding: 32px; color: var(--text-dim);">No messages match your search</div>
    {/if}
  {/if}
</div>
