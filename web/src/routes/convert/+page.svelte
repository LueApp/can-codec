<script lang="ts">
  import { t } from '$lib/i18n.svelte';

  let input = $state('');
  let output = $state('');
  let stats = $state({ total: 0, converted: 0, failed: 0 });
  let copied = $state(false);
  let bus = $state('vcan0');

  interface ParsedFrame {
    canId: string;
    data: string;
    isFD: boolean;
    isExtended: boolean;
  }

  function parseLine(line: string): ParsedFrame | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Format: [(timestamp)] interface ID##N DATA or interface ID#DATA
    const cansendMatch = trimmed.match(
      /^(?:\([\d.]+\)\s+)?(?:\S+)\s+([0-9A-Fa-f]+)(##([01]))?(#)?([0-9A-Fa-f]*)$/
    );
    if (cansendMatch) {
      const idStr = cansendMatch[1];
      const isFD = cansendMatch[2] !== undefined;
      const hexData = cansendMatch[5] || '';
      return {
        canId: idStr.toUpperCase(),
        data: hexData.toUpperCase(),
        isFD: isFD || hexData.length / 2 > 8,
        isExtended: idStr.length > 3,
      };
    }

    // Format: (timestamp) interface ID [DLC] HH HH HH ...
    const candumpMatch = trimmed.match(
      /(?:\([\d.]+\)\s+)?(?:\S+)\s+([0-9A-Fa-f]+)\s+\[\d+\]\s+((?:[0-9A-Fa-f]{2}\s*)+)/
    );
    if (candumpMatch) {
      const idStr = candumpMatch[1];
      const hexParts = candumpMatch[2].trim().split(/\s+/);
      const hexData = hexParts.join('').toUpperCase();
      return {
        canId: idStr.toUpperCase(),
        data: hexData,
        isFD: hexParts.length > 8,
        isExtended: idStr.length > 3,
      };
    }

    return null;
  }

  function convert() {
    const lines = input.split('\n');
    const results: string[] = [];
    let converted = 0;
    let failed = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = parseLine(line);
      if (frame) {
        const sep = frame.isFD ? '##1' : '#';
        results.push(`${bus} ${frame.canId}${sep}${frame.data}`);
        converted++;
      } else {
        results.push(`# FAILED: ${line.trim()}`);
        failed++;
      }
    }

    output = results.join('\n');
    stats = { total: converted + failed, converted, failed };
  }

  function copyOutput() {
    navigator.clipboard.writeText(output);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  function copyAsScript() {
    const lines = output.split('\n').filter(l => !l.startsWith('#'));
    const script = lines.map(l => `cansend ${l}`).join('\n');
    navigator.clipboard.writeText(script);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<div class="container">
  <div class="page-header">
    <h1>{t('convert.title')}</h1>
    <p>{t('convert.subtitle')}</p>
  </div>

  <div class="card">
    <div class="form-group">
      <label for="convert-input">{t('convert.label_input')}</label>
      <textarea id="convert-input" bind:value={input} rows="8"
        placeholder={t('convert.placeholder_input')}
        onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); convert(); } }}
      ></textarea>
      <div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">{t('convert.hint_ctrl_enter')}</div>
    </div>
    <div style="display: flex; gap: 12px; align-items: center;">
      <button class="primary" onclick={convert}>{t('convert.button')}</button>
      <div style="display: flex; align-items: center; gap: 6px;">
        <label for="bus-override" style="margin: 0; white-space: nowrap;">{t('convert.bus_label')}</label>
        <input id="bus-override" bind:value={bus} style="width: 100px;" />
      </div>
    </div>
  </div>

  {#if output}
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <div>
          <h2 style="margin-bottom: 0;">{t('convert.output_title')}</h2>
          <span style="font-size: 13px; color: var(--text-dim);">
            {stats.converted} {t('convert.converted_suffix')}{stats.failed > 0 ? `, ${stats.failed} ${t('convert.failed_suffix')}` : ''}
          </span>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="copy-btn" onclick={copyOutput}>{copied ? t('convert.copied') : t('convert.copy')}</button>
          <button class="copy-btn" onclick={copyAsScript}>{t('convert.copy_as_script')}</button>
        </div>
      </div>
      <pre class="raw-frame-log">{output}</pre>
    </div>
  {/if}
</div>
