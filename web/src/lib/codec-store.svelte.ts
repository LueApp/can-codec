/**
 * Svelte 5 reactive state for the codec instance and loaded configs.
 */

import { Codec, getIdForNode } from './codec';
import { parseConfig, saveConfigsToStorage, loadConfigsFromStorage, type StoredConfig, type MessageFilter } from './config-loader';
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
  node_count: number;
  node_id_start: number;
  mux_signal?: string;
}

class CodecStore {
  codec = $state(new Codec());
  configs = $state<StoredConfig[]>([]);
  error = $state<string | null>(null);
  /** All messages from enabled configs, including disabled messages (for the management UI). */
  allMessages = $state<MessageEntry[]>([]);
  filtersByMessage = $state(new Map<string, MessageFilter>());

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
      this.configs = [...this.configs.filter((c) => c.filename !== filename), { filename, content, enabled: true, disabledMessages: [], messageFilters: {} }];
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

  enableAllConfigs(): void {
    this.configs = this.configs.map((c) => ({ ...c, enabled: true }));
    saveConfigsToStorage(this.configs);
    this.rebuildCodec();
  }

  disableAllConfigs(): void {
    this.configs = this.configs.map((c) => ({ ...c, enabled: false }));
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

  enableAllMessages(filename: string): void {
    this.configs = this.configs.map((c) =>
      c.filename === filename ? { ...c, disabledMessages: [] } : c
    );
    saveConfigsToStorage(this.configs);
    this.rebuildCodec();
  }

  disableAllMessages(filename: string): void {
    this.configs = this.configs.map((c) => {
      if (c.filename !== filename) return c;
      try {
        const device = parseConfig(c.content, c.filename);
        return { ...c, disabledMessages: device.messages.map((m) => m.name) };
      } catch {
        return c;
      }
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

  private _ensureFilter(filename: string, messageName: string): MessageFilter {
    const cfg = this.configs.find((c) => c.filename === filename);
    if (!cfg) return { disabledNodes: [], disabledSignals: [], disabledEnumValues: {} };
    if (!cfg.messageFilters) cfg.messageFilters = {};
    let f = cfg.messageFilters[messageName];
    if (!f || !f.disabledEnumValues) {
      f = { disabledNodes: f?.disabledNodes ?? [], disabledSignals: f?.disabledSignals ?? [], disabledEnumValues: {} };
      cfg.messageFilters[messageName] = f;
    }
    return f;
  }

  getMessageFilter(filename: string, messageName: string): MessageFilter | null {
    const cfg = this.configs.find((c) => c.filename === filename);
    const f = cfg?.messageFilters?.[messageName];
    if (!f) return null;
    return {
      disabledNodes: f.disabledNodes ?? [],
      disabledSignals: f.disabledSignals ?? [],
      disabledEnumValues: (f as any).disabledEnumValues ?? {},
    };
  }

  toggleNode(filename: string, messageName: string, nodeId: number): void {
    const f = this._ensureFilter(filename, messageName);
    const idx = f.disabledNodes.indexOf(nodeId);
    if (idx >= 0) f.disabledNodes.splice(idx, 1);
    else f.disabledNodes.push(nodeId);
    this._saveAndRebuildFilters();
  }

  enableAllNodes(filename: string, messageName: string): void {
    const f = this._ensureFilter(filename, messageName);
    f.disabledNodes = [];
    this._saveAndRebuildFilters();
  }

  disableAllNodes(filename: string, messageName: string, allNodeIds: number[]): void {
    const f = this._ensureFilter(filename, messageName);
    f.disabledNodes = [...allNodeIds];
    this._saveAndRebuildFilters();
  }

  toggleSignal(filename: string, messageName: string, signalName: string): void {
    const f = this._ensureFilter(filename, messageName);
    const idx = f.disabledSignals.indexOf(signalName);
    if (idx >= 0) f.disabledSignals.splice(idx, 1);
    else f.disabledSignals.push(signalName);
    this._saveAndRebuildFilters();
  }

  enableAllSignals(filename: string, messageName: string): void {
    const f = this._ensureFilter(filename, messageName);
    f.disabledSignals = [];
    this._saveAndRebuildFilters();
  }

  disableAllSignals(filename: string, messageName: string, allSignals: string[]): void {
    const f = this._ensureFilter(filename, messageName);
    f.disabledSignals = [...allSignals];
    this._saveAndRebuildFilters();
  }

  toggleEnumValue(filename: string, messageName: string, signalName: string, enumValue: string): void {
    const f = this._ensureFilter(filename, messageName);
    if (!f.disabledEnumValues[signalName]) f.disabledEnumValues[signalName] = [];
    const arr = f.disabledEnumValues[signalName];
    const idx = arr.indexOf(enumValue);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(enumValue);
    if (arr.length === 0) delete f.disabledEnumValues[signalName];
    this._saveAndRebuildFilters();
  }

  enableAllEnumValues(filename: string, messageName: string, signalName: string): void {
    const f = this._ensureFilter(filename, messageName);
    delete f.disabledEnumValues[signalName];
    this._saveAndRebuildFilters();
  }

  disableAllEnumValues(filename: string, messageName: string, signalName: string, allValues: string[]): void {
    const f = this._ensureFilter(filename, messageName);
    f.disabledEnumValues[signalName] = [...allValues];
    this._saveAndRebuildFilters();
  }

  private _saveAndRebuildFilters(): void {
    this.configs = [...this.configs];
    saveConfigsToStorage(this.configs);
    this._rebuildFilterMap();
  }

  private _rebuildFilterMap(): void {
    const map = new Map<string, MessageFilter>();
    for (const cfg of this.configs) {
      if (!cfg.enabled || !cfg.messageFilters) continue;
      for (const [name, raw] of Object.entries(cfg.messageFilters)) {
        const filter: MessageFilter = {
          disabledNodes: raw.disabledNodes ?? [],
          disabledSignals: raw.disabledSignals ?? [],
          disabledEnumValues: (raw as any).disabledEnumValues ?? {},
        };
        if (filter.disabledNodes.length > 0 || filter.disabledSignals.length > 0 || Object.keys(filter.disabledEnumValues).length > 0) {
          map.set(name, filter);
        }
      }
    }
    this.filtersByMessage = map;
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
            node_count: msg.node_count,
            node_id_start: msg.node_id_start,
            mux_signal: msg.mux_signal,
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
    this._rebuildFilterMap();
  }
}

export const codecStore = new CodecStore();
