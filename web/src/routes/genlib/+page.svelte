<script lang="ts">
  import { codecStore } from '$lib/codec-store.svelte';
  import { t } from '$lib/i18n.svelte';
  import { generate, GEN_LANGS, suggestedFilename, labelFor, type GenLang } from '$lib/codegen';
  import { toPascalCase, toSnakeCase } from '$lib/codegen/common';
  import type { DeviceConfig } from '$lib/types';

  let selectedDeviceIdx = $state(0);
  let selectedLang = $state<GenLang>('python');
  let copied = $state(false);

  const devices = $derived(codecStore.codec.devices);
  const selectedDevice = $derived<DeviceConfig | null>(devices[selectedDeviceIdx] ?? null);

  const source = $derived.by(() => {
    if (!selectedDevice) return '';
    try {
      return generate(selectedLang, selectedDevice);
    } catch (e) {
      return `// Generation failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  });

  const filename = $derived(selectedDevice ? suggestedFilename(selectedLang, selectedDevice) : '');
  const lineCount = $derived(source ? source.split('\n').length : 0);
  const byteCount = $derived(new TextEncoder().encode(source).length);

  function copyOutput() {
    navigator.clipboard.writeText(source);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  function downloadOutput() {
    const blob = new Blob([source], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function firstClassName(d: DeviceConfig | null): string {
    return d && d.messages[0] ? toPascalCase(d.messages[0].name) : 'Message';
  }
  function firstMsgSnake(d: DeviceConfig | null): string {
    return d && d.messages[0] ? toSnakeCase(d.messages[0].name) : 'msg';
  }
  function devSnake(d: DeviceConfig | null): string {
    return d ? toSnakeCase(d.name) : 'device';
  }

  const usagePython = $derived(`import ${filename.replace(/\.py$/, '')}  # the generated module

# Build a message and encode it
msg = ${filename.replace(/\.py$/, '')}.${firstClassName(selectedDevice)}()
can_id, data = msg.encode(node_id=1)
print(f"send 0x{can_id:X} {data.hex()}")

# Decode any incoming frame
decoded = ${filename.replace(/\.py$/, '')}.decode_frame(can_id, data)
print(decoded)`);

  const usageC = $derived(`#include "${filename}"

${devSnake(selectedDevice)}_${firstMsgSnake(selectedDevice)}_t cmd = ${devSnake(selectedDevice).toUpperCase()}_${firstMsgSnake(selectedDevice).toUpperCase()}_INIT;
uint8_t buf[64];
size_t n = ${devSnake(selectedDevice)}_${firstMsgSnake(selectedDevice)}_encode(&cmd, buf, sizeof(buf));
// then send buf[0..n] on your CAN bus`);

  const usageCpp = $derived(`#include "${filename}"
using namespace ${devSnake(selectedDevice)};

${firstClassName(selectedDevice)} cmd{};
auto data = cmd.encode();           // -> std::array<uint8_t, N>
auto id   = ${firstClassName(selectedDevice)}::id_for_node(1);

if (auto m = ${firstClassName(selectedDevice)}::decode(data); m) {
    // *m is the parsed struct
}`);

  const usageRust = $derived(`mod ${filename.replace(/\.rs$/, '')};

let cmd = ${filename.replace(/\.rs$/, '')}::${firstClassName(selectedDevice)}::default();
let data = cmd.encode();
let id   = ${filename.replace(/\.rs$/, '')}::${firstClassName(selectedDevice)}::id_for_node(1);

if let Some(frame) = ${filename.replace(/\.rs$/, '')}::decode_frame(id, &data) {
    println!("{:?}", frame);
}`);
</script>

<div class="container">
  <div class="page-header">
    <h1>{t('genlib.title')}</h1>
    <p>{t('genlib.subtitle')}</p>
  </div>

  {#if devices.length === 0}
    <div class="alert info">{t('genlib.no_device_loaded')}</div>
  {:else}
    <div class="card">
      <div class="form-row">
        <div class="form-group" style="flex: 2 1 260px;">
          <label for="genlib-device">{t('genlib.label_device')}</label>
          <select id="genlib-device" bind:value={selectedDeviceIdx}>
            {#each devices as dev, i}
              <option value={i}>
                {dev.name}
                {dev.messages.length === 1
                  ? `(1 ${t('genlib.message_singular')})`
                  : `(${dev.messages.length} ${t('genlib.message_plural')})`}
              </option>
            {/each}
          </select>
        </div>
        <div class="form-group" style="flex: 3 1 360px;">
          <label for="lang-tabs">{t('genlib.label_language')}</label>
          <div id="lang-tabs" class="lang-tabs">
            {#each GEN_LANGS as lang}
              <button
                type="button"
                class="lang-tab"
                class:active={selectedLang === lang}
                onclick={() => (selectedLang = lang)}
              >
                {labelFor(lang)}
              </button>
            {/each}
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="genlib-toolbar">
        <div>
          <h2 style="margin-bottom: 0;">{filename}</h2>
          <span style="font-size: 13px; color: var(--text-dim);">
            {lineCount} {t('genlib.lines')} · {formatBytes(byteCount)}
          </span>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="copy-btn" onclick={copyOutput}>{copied ? t('genlib.copied') : t('genlib.copy')}</button>
          <button class="primary" onclick={downloadOutput}>{t('genlib.download')}</button>
        </div>
      </div>
      <pre class="raw-frame-log genlib-source">{source}</pre>
    </div>

    <div class="card">
      <h3 style="margin-top: 0;">{t('genlib.how_to_use')}</h3>
      {#if selectedLang === 'python'}
        <pre class="raw-frame-log usage-snippet">{usagePython}</pre>
      {:else if selectedLang === 'c'}
        <pre class="raw-frame-log usage-snippet">{usageC}</pre>
      {:else if selectedLang === 'cpp'}
        <pre class="raw-frame-log usage-snippet">{usageCpp}</pre>
      {:else if selectedLang === 'rust'}
        <pre class="raw-frame-log usage-snippet">{usageRust}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .lang-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .lang-tab {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: var(--radius);
    padding: 6px 14px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s, color 0.1s;
  }
  .lang-tab:hover {
    background: rgba(88, 166, 255, 0.1);
    color: var(--text);
  }
  .lang-tab.active {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }

  .genlib-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    flex-wrap: wrap;
    gap: 8px;
  }

  .genlib-source {
    max-height: 540px;
    overflow: auto;
    white-space: pre;
    color: var(--text);
  }
  .usage-snippet {
    max-height: 220px;
    overflow: auto;
    white-space: pre;
    color: var(--text);
  }
</style>
