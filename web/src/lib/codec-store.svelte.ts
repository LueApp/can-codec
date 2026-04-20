/**
 * Svelte 5 reactive state for the codec instance and loaded configs.
 */

import { Codec, getIdForNode } from './codec';
import { parseConfig, saveConfigsToStorage, loadConfigsFromStorage, type StoredConfig } from './config-loader';
import { CONFIG_TEMPLATES } from './templates';

export interface MessageEntry {
  device: string;
  filename: string;
  name: string;
  enabled: boolean;
  id: string;
  direction: string;
  dlc: number;
  fd: boolean;
  mavlink: boolean;
  description: string;
  signals: string[];
  id_range?: string;
}

class CodecStore {
  codec = $state(new Codec());
  configs = $state<StoredConfig[]>([]);
  error = $state<string | null>(null);
  /** All messages from enabled configs, including disabled messages (for the management UI). */
  allMessages = $state<MessageEntry[]>([]);

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
      this.configs = [...this.configs.filter((c) => c.filename !== filename), { filename, content, enabled: true, disabledMessages: [] }];
      saveConfigsToStorage(this.configs);
      this.rebuildCodec();
    } catch (e) {
      this.error = `Failed to parse ${filename}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  loadTemplate(templateId: string): void {
    const tmpl = CONFIG_TEMPLATES.find((t) => t.id === templateId);
    if (!tmpl) return;
    this.addConfig(tmpl.filename, tmpl.content);
  }

  removeConfig(filename: string): void {
    this.configs = this.configs.filter((c) => c.filename !== filename);
    saveConfigsToStorage(this.configs);
    this.rebuildCodec();
  }

  toggleConfig(filename: string): void {
    this.configs = this.configs.map((c) =>
      c.filename === filename ? { ...c, enabled: !c.enabled } : c
    );
    saveConfigsToStorage(this.configs);
    this.rebuildCodec();
  }

  toggleMessage(filename: string, messageName: string): void {
    this.configs = this.configs.map((c) => {
      if (c.filename !== filename) return c;
      const disabled = new Set(c.disabledMessages);
      if (disabled.has(messageName)) disabled.delete(messageName);
      else disabled.add(messageName);
      return { ...c, disabledMessages: [...disabled] };
    });
    saveConfigsToStorage(this.configs);
    this.rebuildCodec();
  }

  isMessageDisabled(filename: string, messageName: string): boolean {
    const cfg = this.configs.find((c) => c.filename === filename);
    return cfg?.disabledMessages.includes(messageName) ?? false;
  }

  getFilenameForDevice(deviceName: string): string | null {
    return this.deviceToFilename.get(deviceName) ?? null;
  }

  get enabledCount(): number {
    return this.configs.filter((c) => c.enabled).length;
  }

  private deviceToFilename = new Map<string, string>();

  private rebuildCodec(): void {
    const c = new Codec();
    const allMsgs: MessageEntry[] = [];
    this.deviceToFilename = new Map();
    for (const cfg of this.configs) {
      if (!cfg.enabled) continue;
      try {
        const device = parseConfig(cfg.content, cfg.filename);
        this.deviceToFilename.set(device.name, cfg.filename);
        const isMavlink = device.mavlink;
        for (const msg of device.messages) {
          const entry: MessageEntry = {
            device: device.name,
            filename: cfg.filename,
            name: msg.name,
            enabled: !cfg.disabledMessages.includes(msg.name),
            id: isMavlink ? `MAV:${msg.id}` : `0x${msg.id.toString(16).toUpperCase().padStart(3, '0')}`,
            direction: msg.direction,
            dlc: msg.dlc,
            fd: device.fd,
            mavlink: isMavlink,
            description: msg.description,
            signals: msg.signals.map((s) => s.name),
          };
          if (msg.node_count > 1) {
            const maxNodeId = msg.node_id_start + msg.node_count - 1;
            const maxId = getIdForNode(msg, maxNodeId);
            entry.id_range = `0x${msg.id.toString(16).toUpperCase().padStart(3, '0')}-0x${maxId.toString(16).toUpperCase().padStart(3, '0')}`;
          }
          allMsgs.push(entry);
        }
        if (cfg.disabledMessages.length > 0) {
          device.messages = device.messages.filter((m) => !cfg.disabledMessages.includes(m.name));
        }
        c.addDevice(device);
      } catch { /* skip */ }
    }
    this.allMessages = allMsgs;
    this.codec = c;
  }
}

export const codecStore = new CodecStore();
