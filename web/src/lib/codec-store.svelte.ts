/**
 * Svelte 5 reactive state for the codec instance and loaded configs.
 */

import { Codec } from './codec';
import { parseConfig, saveConfigsToStorage, loadConfigsFromStorage, type StoredConfig } from './config-loader';

class CodecStore {
  codec = $state(new Codec());
  configs = $state<StoredConfig[]>([]);
  error = $state<string | null>(null);

  constructor() {
    if (typeof window !== 'undefined') {
      const stored = loadConfigsFromStorage();
      if (stored.length > 0) {
        this.configs = stored;
        this.rebuildCodec();
      }
    }
  }

  addConfig(filename: string, content: string): void {
    this.error = null;
    try {
      parseConfig(content, filename);
      this.configs = [...this.configs.filter((c) => c.filename !== filename), { filename, content }];
      saveConfigsToStorage(this.configs);
      this.rebuildCodec();
    } catch (e) {
      this.error = `Failed to parse ${filename}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  removeConfig(filename: string): void {
    this.configs = this.configs.filter((c) => c.filename !== filename);
    saveConfigsToStorage(this.configs);
    this.rebuildCodec();
  }

  private rebuildCodec(): void {
    const c = new Codec();
    for (const cfg of this.configs) {
      try { c.addDevice(parseConfig(cfg.content, cfg.filename)); } catch { /* skip */ }
    }
    this.codec = c;
  }
}

export const codecStore = new CodecStore();
