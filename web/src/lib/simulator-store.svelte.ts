import { parseConfig } from './config-loader';
import { codecStore } from './codec-store.svelte';
import type { GatewayConfig, SimulatorBinding } from './simulator-gateway';

class SimulatorStore {
  status = $state('disconnected');
  report = $state<any>({ trace: [] });
  running = $state(false);
  private worker: Worker | null = null;

  async start(url: string, bindings: SimulatorBinding[]) {
    this.stop();
    try {
      const protocols = Object.fromEntries(codecStore.configs.filter(c => c.enabled)
        .map(c => {
          const protocol = parseConfig(c.content, c.filename);
          protocol.messages = protocol.messages.filter(message => !c.disabledMessages.includes(message.name));
          return [c.filename, protocol];
        }));
      const config: GatewayConfig = { version: 1, bindings, protocols };
      const worker = new Worker(new URL('./simulator-worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      this.running = true;
      worker.onmessage = event => { if (this.worker === worker) { this.report = event.data; this.status = event.data.status; } };
      worker.onerror = event => { this.status = event.message; };
      let connectUrl = url;
      try {
        const target = new URL(url);
        if (target.protocol === 'ws:' && target.hostname !== location.hostname) {
          const response = await fetch('/__ws_proxy');
          if (response.ok) {
            const { port } = await response.json();
            connectUrl = `ws://${location.hostname}:${port}/?target=${encodeURIComponent(target.host)}`;
          }
        }
      } catch { /* hosted pages connect to the explicit endpoint */ }
      if (this.worker === worker) worker.postMessage({ type: 'start', url: connectUrl, config });
    } catch (error) { this.stop(); this.status = String(error); }
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.running = false;
    this.status = 'disconnected';
  }
}
export const simulatorStore = new SimulatorStore();
