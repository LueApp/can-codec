<script lang="ts">
  import { codecStore } from '$lib/codec-store.svelte';
  import { displayValue, parseCandump, groupArraySignals, MavlinkReassembler } from '$lib/codec';
  import { t } from '$lib/i18n.svelte';
  import type { DecodedMessage, MavlinkInfo } from '$lib/types';

  interface DecodeResult {
    line: string;
    decoded: DecodedMessage | null;
    mavlink?: MavlinkInfo;
    error?: string;
  }

  let input = $state('');
  let results = $state<DecodeResult[]>([]);
  let copied = $state('');

  function parseHex(s: string): Uint8Array {
    const cleaned = s.replace(/[:\s,]/g, '').replace(/0x/gi, '');
    if (cleaned.length % 2 !== 0) throw new Error(t('decode.odd_hex'));
    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  function decodeSingleLine(line: string): DecodeResult {
    try {
      // Try candump/cansend format
      const frame = parseCandump(line);
      if (frame) {
        const res = codecStore.codec.smartDecode(frame.canId, frame.data);
        if (!res) return { line, decoded: null, error: `${t('decode.unknown_id')} 0x${frame.canId.toString(16).toUpperCase()}` };
        return { line, decoded: res.decoded, mavlink: res.mavlink };
      }

      // Try "ID DATA" format
      const parts = line.trim().split(/\s+/);
      const first = parts[0];
      let canId: number;
      let data: Uint8Array;

      if (first.startsWith('0x') || first.startsWith('0X')) {
        canId = parseInt(first, 16);
        data = parseHex(parts.slice(1).join(''));
      } else if (parts.length >= 2 && first.length <= 8 && /^[0-9a-fA-F]+$/.test(first)) {
        canId = parseInt(first, 16);
        data = parseHex(parts.slice(1).join(''));
      } else {
        return { line, decoded: null, error: t('decode.unrecognized_format') };
      }

      if (isNaN(canId)) return { line, decoded: null, error: t('decode.invalid_can_id') };
      const res = codecStore.codec.smartDecode(canId, data);
      if (!res) return { line, decoded: null, error: `${t('decode.unknown_id')} 0x${canId.toString(16).toUpperCase()}` };
      return { line, decoded: res.decoded, mavlink: res.mavlink };
    } catch (e) {
      return { line, decoded: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  function getMaxArrayLen(groups: ReturnType<typeof groupArraySignals>) {
    const arrays = groups.filter(g => g.items.length > 1);
    return arrays.length > 0 ? Math.max(...arrays.map(g => g.items.length)) : 0;
  }

  function isMavlinkCanId(canId: number): boolean {
    return (canId & 0x10000) !== 0;
  }

  function decode() {
    const lines = input.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { results = []; return; }

    type Group =
      | { kind: 'mavlink'; canId: number; lines: string[]; frames: Uint8Array[] }
      | { kind: 'single'; line: string };
    const groups: Group[] = [];

    const reasm = new MavlinkReassembler();
    // Track which raw lines feed each in-flight buffer so we can label completed
    // groups with all the source lines that contributed.
    const inflightLines = new Map<number, string[][]>();

    for (const line of lines) {
      const frame = parseCandump(line);
      if (!frame || !isMavlinkCanId(frame.canId)) {
        groups.push({ kind: 'single', line });
        continue;
      }

      const isStart = frame.data.length > 0 && frame.data[0] === 0xFD;
      let canLines = inflightLines.get(frame.canId);
      if (isStart) {
        if (!canLines) { canLines = []; inflightLines.set(frame.canId, canLines); }
        canLines.push([line]);
      } else if (canLines && canLines.length > 0) {
        canLines[0].push(line);
      } else {
        // Continuation with no active buffer at this canId — render as single,
        // which will surface as "Unknown ID" (matching pre-existing UX).
        groups.push({ kind: 'single', line });
        continue;
      }

      const completed = reasm.feed(frame.canId, frame.data);
      for (const buf of completed) {
        const groupLines = canLines!.shift() ?? [line];
        groups.push({ kind: 'mavlink', canId: frame.canId, lines: groupLines, frames: buf.frames });
      }
      if (canLines && canLines.length === 0) inflightLines.delete(frame.canId);
    }

    // Anything still pending at end of input: render as single lines so the user
    // can see they were incomplete rather than silently lost.
    for (const { canId, buf } of reasm.flush()) {
      const groupLines = inflightLines.get(canId)?.shift();
      if (groupLines) {
        for (const l of groupLines) groups.push({ kind: 'single', line: l });
      } else {
        // Shouldn't happen but be safe
        for (let i = 0; i < buf.frames.length; i++) groups.push({ kind: 'single', line: '' });
      }
    }

    const out: DecodeResult[] = [];
    for (const group of groups) {
      if (group.kind === 'single') {
        if (!group.line) continue;
        out.push(decodeSingleLine(group.line));
        continue;
      }
      try {
        const res = group.frames.length === 1
          ? codecStore.codec.smartDecode(group.canId, group.frames[0])
          : codecStore.codec.smartDecodeMultiFrame(group.canId, group.frames);
        const label = group.lines.join('\n');
        if (!res) {
          out.push({ line: label, decoded: null, error: `${t('decode.unknown_mav_id')} 0x${group.canId.toString(16).toUpperCase()}` });
        } else {
          out.push({ line: label, decoded: res.decoded, mavlink: res.mavlink });
        }
      } catch (e) {
        out.push({ line: group.lines.join('\n'), decoded: null, error: e instanceof Error ? e.message : String(e) });
      }
    }
    results = out;
  }

  function decodedToJson(d: DecodedMessage): Record<string, unknown> {
    if (d.is_broadcast && d.sub_messages) {
      const nodes: Record<string, Record<string, string>> = {};
      for (const sub of d.sub_messages) {
        const obj: Record<string, string> = {};
        for (const s of sub.signals) obj[s.name] = displayValue(s);
        nodes[`node_${sub.node_id}`] = obj;
      }
      return { name: d.name, broadcast: true, nodes };
    }
    const obj: Record<string, string> = {};
    for (const s of d.signals) obj[s.name] = displayValue(s);
    return { name: d.name, signals: obj };
  }

  function copyJson(r: DecodeResult) {
    if (!r.decoded) return;
    const out = decodedToJson(r.decoded);
    if (r.mavlink) out.mavlink = r.mavlink;
    navigator.clipboard.writeText(JSON.stringify(out, null, 2));
    copied = r.line;
    setTimeout(() => (copied = ''), 1500);
  }

  function copyAllJson() {
    const all = results.filter(r => r.decoded).map(r => {
      const out = decodedToJson(r.decoded!);
      if (r.mavlink) out.mavlink = r.mavlink;
      return out;
    });
    navigator.clipboard.writeText(JSON.stringify(all, null, 2));
    copied = '__all__';
    setTimeout(() => (copied = ''), 1500);
  }
</script>

<div class="container">
  <div class="page-header">
    <h1>{t('decode.title')}</h1>
    <p>{t('decode.subtitle')}</p>
  </div>

  <div class="card">
    <div class="form-group">
      <label for="decode-input">{t('decode.label_frames')}</label>
      <textarea id="decode-input" bind:value={input} rows="5"
        placeholder={t('decode.placeholder_frames')}
        onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); decode(); } }}
      ></textarea>
      <div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">{t('decode.hint_ctrl_enter')}</div>
    </div>
    <div style="display: flex; gap: 12px; align-items: center;">
      <button class="primary" onclick={decode} disabled={codecStore.enabledCount === 0}>{t('decode.button')}</button>
      {#if codecStore.enabledCount === 0}
        <span style="font-size: 13px; color: var(--text-dim);">
          {codecStore.configs.length === 0 ? t('decode.load_config_first') : t('decode.enable_config_first')}
        </span>
      {/if}
      {#if results.length > 0}
        {@const ok = results.filter(r => r.decoded).length}
        {@const fail = results.length - ok}
        <span style="font-size: 13px; color: var(--text-dim);">
          {ok} {t('decode.decoded_suffix')}{fail > 0 ? `, ${fail} ${t('decode.unknown_suffix')}` : ''}
        </span>
        {#if ok > 1}
          <button class="copy-btn" onclick={copyAllJson}>{copied === '__all__' ? t('decode.copied') : t('decode.copy_all_json')}</button>
        {/if}
      {/if}
    </div>
  </div>

  {#each results as r, i}
    {#if r.decoded}
      {@const res = r.decoded}
      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <div>
            {#if r.mavlink}
              <span style="font-family: var(--font-mono); color: var(--text-dim); font-size: 12px;">
                MAVLink sys={r.mavlink.sys_id} comp={r.mavlink.comp_id}
                {#if r.mavlink.msg_id !== undefined} msg_id={r.mavlink.msg_id}{/if}
                {#if r.mavlink.seq !== undefined} seq={r.mavlink.seq}{/if}
              </span>
              <br />
            {/if}
            <span style="font-family: var(--font-mono); color: var(--orange); font-size: 15px;">
              {r.mavlink ? `MAV:${r.mavlink.msg_id}` : `0x${res.msg_id.toString(16).toUpperCase().padStart(3, '0')}`}
            </span>
            <strong style="margin-left: 10px; font-size: 16px;">{res.name}</strong>
            {#if res.is_broadcast}
              <span class="tag" style="margin-left: 6px; background: rgba(88,166,255,0.15); color: var(--accent);">{t('decode.broadcast')}</span>
            {:else if res.node_id !== 0}
              <span class="tag" style="margin-left: 6px; background: rgba(210,153,34,0.15); color: var(--orange);">{t('decode.node')} {res.node_id}</span>
            {/if}
            {#if res.description}
              <div style="color: var(--text-dim); font-size: 12px; margin-top: 2px;">{res.description}</div>
            {/if}
          </div>
          <button class="copy-btn" onclick={() => copyJson(r)}>{copied === r.line ? t('decode.copied') : t('decode.json')}</button>
        </div>

        <div class="hex-display" style="font-size: 13px; padding: 8px;">
          {res.raw_data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}
        </div>

        <div class="result" style="padding: 0; background: none; border: none;">
          {#if res.is_broadcast && res.sub_messages}
            <!-- Broadcast: show per-node signals as a table -->
            <div style="overflow-x: auto;">
              <table style="border-collapse: collapse; font-family: var(--font-mono); font-size: 12px; width: 100%;">
                <thead>
                  <tr>
                    <th style="padding: 3px 10px 3px 0; color: var(--text-dim); font-weight: 400; border-bottom: 1px solid var(--border); text-align: left;">{t('decode.signal')}</th>
                    {#each res.sub_messages as sub}
                      <th style="padding: 3px 8px; color: var(--text-dim); font-weight: 400; border-bottom: 1px solid var(--border); text-align: right;">N{sub.node_id}</th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each res.sub_messages[0].signals as sig, si}
                    <tr>
                      <td style="padding: 3px 10px 3px 0; color: var(--accent); white-space: nowrap;">{sig.name}{#if sig.unit} <span style="color:var(--text-dim)">({sig.unit})</span>{/if}</td>
                      {#each res.sub_messages as sub}
                        <td style="padding: 3px 8px; color: var(--green); text-align: right; white-space: nowrap;">{displayValue(sub.signals[si])}</td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            {#each groupArraySignals(res.signals).filter(g => g.items.length === 1) as group}
              <div class="signal-row">
                <span class="signal-name">{group.base}</span>
                <span class="signal-value">{displayValue(group.items[0])}</span>
              </div>
            {/each}

            {#if groupArraySignals(res.signals).some(g => g.items.length > 1)}
              <div style="overflow-x: auto; margin-top: 6px;">
                <table style="border-collapse: collapse; font-family: var(--font-mono); font-size: 12px; width: 100%;">
                  <thead>
                    <tr>
                      <th style="padding: 3px 10px 3px 0; color: var(--text-dim); font-weight: 400; border-bottom: 1px solid var(--border); text-align: left;"></th>
                      {#each {length: getMaxArrayLen(groupArraySignals(res.signals))} as _, i}
                        <th style="padding: 3px 8px; color: var(--text-dim); font-weight: 400; border-bottom: 1px solid var(--border); text-align: right;">[{i}]</th>
                      {/each}
                    </tr>
                  </thead>
                  <tbody>
                    {#each groupArraySignals(res.signals).filter(g => g.items.length > 1) as group}
                      <tr>
                        <td style="padding: 3px 10px 3px 0; color: var(--accent); white-space: nowrap;">{group.base}</td>
                        {#each group.items as item}
                          <td style="padding: 3px 8px; color: var(--green); text-align: right; white-space: nowrap;">{displayValue(item)}</td>
                        {/each}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {:else}
      <div class="alert error" style="font-size: 13px; font-family: var(--font-mono);">
        <span style="color: var(--text-dim);">{r.line}</span> — {r.error}
      </div>
    {/if}
  {/each}
</div>
