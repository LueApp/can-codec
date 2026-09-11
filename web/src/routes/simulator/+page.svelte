<script lang="ts">
  import { onMount } from 'svelte';
  import { codecStore } from '$lib/codec-store.svelte';
  import { simulatorStore as sim } from '$lib/simulator-store.svelte';
  import { downloadServerScript } from '$lib/server-script';
  let url = $state('ws://localhost:8765');
  let device = $state('motor_1');
  let protocol = $state('');
  let node = $state(1);
  let bindings = $state<any[]>([]);
  let error = $state('');
  let filter = $state('');
  let upload: HTMLInputElement;
  onMount(() => {
    try { const saved = JSON.parse(localStorage.getItem('simulator-routing-v1') ?? 'null'); if (saved) { url = saved.url; bindings = saved.bindings; } } catch { /* use defaults */ }
  });
  function save() { localStorage.setItem('simulator-routing-v1', JSON.stringify({ version: 1, url, bindings })); }
  function add() {
    if (!device || !protocol || bindings.some(b => b.device === device)) { error = 'Choose a protocol and a unique device name.'; return; }
    bindings = [...bindings, { device, protocol, node }]; error = ''; save();
  }
  function download() {
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, url, bindings }, null, 2)], { type: 'application/json' }));
    anchor.download = 'simulator-routing.json'; anchor.click(); URL.revokeObjectURL(anchor.href);
  }
  async function load(event: Event) {
    try {
      const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
      const value = JSON.parse(await file.text());
      if (value.version !== 1 || !Array.isArray(value.bindings)) throw new Error('Expected a version 1 routing file');
      bindings = value.bindings; url = value.url ?? url; save(); error = '';
    } catch (e) { error = String(e); }
  }
</script>

<div class="container">
  <h1>Simulator gateway</h1>
  <p>Connect decoded messages to a behavior simulator. Protocol conversion runs in this browser; keep this application open during tests.</p>
  <section>
    <h2>Connection</h2>
    <label>Bridge endpoint <input bind:value={url} placeholder="ws://localhost:8765" /></label>
    <button onclick={() => { save(); sim.start(url, $state.snapshot(bindings)); }} disabled={sim.running || !bindings.length}>Start gateway</button>
    <button onclick={() => sim.stop()} disabled={!sim.running}>Stop</button>
    <button onclick={() => downloadServerScript()}>Download bridge</button>
    <p role="status" data-testid="simulator-status">{sim.status} · Bus: {sim.report.bus ?? '—'} ({sim.report.busConnected ? 'connected' : 'disconnected'}) · Backend: {sim.report.backend ?? '—'}</p>
    <p>Point the simulator's common API connection at the same bridge endpoint. One browser codec and one simulator own each bridge session.</p>
  </section>
  <section>
    <h2>Device bindings</h2>
    <p>Load protocol files using “Add files”. Incoming/outgoing messages are derived from the protocol's controller TX/RX directions. Stop and restart the gateway to apply edits.</p>
    <div class="binding-form">
      <label>Device <input bind:value={device} /></label>
      <label>Protocol <select bind:value={protocol}><option value="">Select…</option>{#each codecStore.configs.filter(c => c.enabled) as config}<option value={config.filename}>{config.filename}</option>{/each}</select></label>
      <label>Node <input type="number" bind:value={node} min="0" /></label>
      <button onclick={add}>Add device</button>
    </div>
    <table><thead><tr><th>Simulator device</th><th>Protocol file</th><th>Node</th><th></th></tr></thead><tbody>
      {#each bindings as binding, index}<tr><td>{binding.device}</td><td>{binding.protocol}</td><td>{binding.node}</td><td><button onclick={() => { bindings = bindings.filter((_, i) => i !== index); save(); }}>Remove</button></td></tr>{/each}
    </tbody></table>
    <input type="file" accept=".json" bind:this={upload} onchange={load} hidden />
    <button onclick={download}>Export routing</button><button onclick={() => upload.click()}>Import routing</button>
  </section>
  {#if error}<p class="alert error">{error}</p>{/if}
  <section>
    <h2>Activity</h2>
    <p data-testid="simulator-metrics" data-commands={sim.report.received ?? 0} data-outputs={sim.report.sent ?? 0} data-errors={sim.report.errors ?? 0} data-p99={sim.report.submitP99Ms ?? 0}>Commands: {sim.report.received ?? 0} · Outputs: {sim.report.sent ?? 0} · Errors: {sim.report.errors ?? 0} · Pending: {sim.report.pending ?? 0}</p>
    <p>Gateway submission acknowledgement p99: {(sim.report.submitP99Ms ?? 0).toFixed(2)} ms (not controller round-trip latency).</p>
    <label>Filter trace <input bind:value={filter} placeholder="device, message, or error" /></label>
    <div class="trace"><table><thead><tr><th>Time</th><th>Stage</th><th>Details</th></tr></thead><tbody>
      {#each [...(sim.report.trace ?? [])].reverse().filter(row => JSON.stringify(row).includes(filter)) as row}<tr><td>{new Date(row.time).toLocaleTimeString()}</td><td>{row.stage}</td><td><code>{JSON.stringify(row.detail)}</code></td></tr>{/each}
    </tbody></table></div>
  </section>
</div>

<style>
  section { border: 1px solid var(--border); border-radius: 8px; padding: 18px; margin: 18px 0; }
  label { display: inline-flex; flex-direction: column; gap: 5px; margin: 8px 12px 8px 0; }
  input, select { min-width: 160px; } button { margin: 4px; }
  .binding-form { display: flex; align-items: end; flex-wrap: wrap; }
  .trace { max-height: 440px; overflow: auto; } code { overflow-wrap: anywhere; white-space: pre-wrap; }
</style>
