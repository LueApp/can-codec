<script lang="ts">
  import { codecStore } from '$lib/codec-store.svelte';
  import { displayValue, parseCandump, groupArraySignals } from '$lib/codec';
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
    if (cleaned.length % 2 !== 0) throw new Error('Odd number of hex digits');
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
        if (!res) return { line, decoded: null, error: `Unknown ID 0x${frame.canId.toString(16).toUpperCase()}` };
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
        return { line, decoded: null, error: 'Unrecognized format' };
      }

      if (isNaN(canId)) return { line, decoded: null, error: 'Invalid CAN ID' };
      const res = codecStore.codec.smartDecode(canId, data);
      if (!res) return { line, decoded: null, error: `Unknown ID 0x${canId.toString(16).toUpperCase()}` };
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

    // Group consecutive lines with the same MAVLink CAN ID for multi-frame reassembly
    const groups: { lines: string[]; canId: number | null }[] = [];
    for (const line of lines) {
      const frame = parseCandump(line);
      const canId = frame ? frame.canId : null;
      const last = groups[groups.length - 1];
      if (canId !== null && isMavlinkCanId(canId) && last && last.canId === canId) {
        last.lines.push(line);
      } else {
        groups.push({ lines: [line], canId });
      }
    }

    const out: DecodeResult[] = [];
    for (const group of groups) {
      if (group.lines.length === 1) {
        out.push(decodeSingleLine(group.lines[0]));
        continue;
      }
      // Multi-frame MAVLink: reassemble then decode
      try {
        const frames = group.lines.map(l => parseCandump(l)!.data);
        const res = codecStore.codec.smartDecodeMultiFrame(group.canId!, frames);
        const label = group.lines.join('\n');
        if (!res) {
          out.push({ line: label, decoded: null, error: `Unknown MAVLink ID 0x${group.canId!.toString(16).toUpperCase()}` });
        } else {
          out.push({ line: label, decoded: res.decoded, mavlink: res.mavlink });
        }
      } catch (e) {
        out.push({ line: group.lines.join('\n'), decoded: null, error: e instanceof Error ? e.message : String(e) });
      }
    }
    results = out;
  }

  function copyJson(r: DecodeResult) {
    if (!r.decoded) return;
    const obj: Record<string, string> = {};
    for (const s of r.decoded.signals) obj[s.name] = displayValue(s);
    const out: Record<string, unknown> = { name: r.decoded.name, signals: obj };
    if (r.mavlink) out.mavlink = r.mavlink;
    navigator.clipboard.writeText(JSON.stringify(out, null, 2));
    copied = r.line;
    setTimeout(() => (copied = ''), 1500);
  }

  function copyAllJson() {
    const all = results.filter(r => r.decoded).map(r => {
      const obj: Record<string, string> = {};
      for (const s of r.decoded!.signals) obj[s.name] = displayValue(s);
      const out: Record<string, unknown> = { name: r.decoded!.name, signals: obj };
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
    <h1>Decode</h1>
    <p>Paste CAN frames, candump output, or cansend commands — one per line</p>
  </div>

  <div class="card">
    <div class="form-group">
      <label for="decode-input">CAN Frames</label>
      <textarea id="decode-input" bind:value={input} rows="5"
        placeholder={"Paste one or more frames (one per line):\n  vcan0 101#E803050000000000\n  vcan0 481#00008041\n  0x101 E8 03 05 01 00 00 00 00\n  (1234.567) vcan0 101 [8] E8 03 05 01 00 00 00 00"}
        onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); decode(); } }}
      ></textarea>
      <div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">Press Ctrl+Enter to decode</div>
    </div>
    <div style="display: flex; gap: 12px; align-items: center;">
      <button class="primary" onclick={decode} disabled={codecStore.enabledCount === 0}>Decode</button>
      {#if codecStore.enabledCount === 0}
        <span style="font-size: 13px; color: var(--text-dim);">
          {codecStore.configs.length === 0 ? 'Load a config first' : 'Enable a config first'}
        </span>
      {/if}
      {#if results.length > 0}
        {@const ok = results.filter(r => r.decoded).length}
        {@const fail = results.length - ok}
        <span style="font-size: 13px; color: var(--text-dim);">
          {ok} decoded{fail > 0 ? `, ${fail} unknown` : ''}
        </span>
        {#if ok > 1}
          <button class="copy-btn" onclick={copyAllJson}>{copied === '__all__' ? 'Copied!' : 'Copy all JSON'}</button>
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
            {#if res.node_id !== 0}
              <span class="tag" style="margin-left: 6px; background: rgba(210,153,34,0.15); color: var(--orange);">node {res.node_id}</span>
            {/if}
            {#if res.description}
              <div style="color: var(--text-dim); font-size: 12px; margin-top: 2px;">{res.description}</div>
            {/if}
          </div>
          <button class="copy-btn" onclick={() => copyJson(r)}>{copied === r.line ? 'Copied!' : 'JSON'}</button>
        </div>

        <div class="hex-display" style="font-size: 13px; padding: 8px;">
          {res.raw_data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}
        </div>

        <div class="result" style="padding: 0; background: none; border: none;">
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
        </div>
      </div>
    {:else}
      <div class="alert error" style="font-size: 13px; font-family: var(--font-mono);">
        <span style="color: var(--text-dim);">{r.line}</span> — {r.error}
      </div>
    {/if}
  {/each}
</div>
