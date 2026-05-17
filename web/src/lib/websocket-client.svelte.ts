/**
 * Reactive WebSocket client for live CAN bus frame streaming.
 *
 * Multi-subscriber: any number of consumers (plot store, encode page, ...)
 * may call addFrameCallback to receive frames. Each returns an unsubscribe fn.
 */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface RawFrame {
  arbitration_id: number;
  data: Uint8Array;
  dlc?: number;
  timestamp: number;
  is_fd: boolean;
  /** 'rx' = received from bus (default), 'tx' = transmitted via send(). The server
   *  emits both, with this tag. Older servers omit the field — treat absence as 'rx'. */
  direction: 'rx' | 'tx';
}

export interface SendAck {
  ok: boolean;
  error?: string;
  arbitration_id?: number;
}

type FrameCallback = (frame: RawFrame) => void;
type AckCallback = (ack: SendAck) => void;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i++)
    out += data[i].toString(16).toUpperCase().padStart(2, '0');
  return out;
}

export class WebSocketClient {
  status = $state<ConnectionStatus>('disconnected');
  error = $state<string | null>(null);
  url = $state<string>('');
  frameCount = $state<number>(0);
  txFrameCount = $state<number>(0);
  sendCount = $state<number>(0);
  lastSendError = $state<string | null>(null);
  busInfo = $state<{ bus: string; fd: boolean } | null>(null);

  private ws: WebSocket | null = null;
  private frameCallbacks = new Set<FrameCallback>();
  private ackCallbacks = new Set<AckCallback>();

  addFrameCallback(cb: FrameCallback): () => void {
    this.frameCallbacks.add(cb);
    return () => this.frameCallbacks.delete(cb);
  }

  addAckCallback(cb: AckCallback): () => void {
    this.ackCallbacks.add(cb);
    return () => this.ackCallbacks.delete(cb);
  }

  /**
   * Compatibility shim for callers that used the old single-callback API.
   * Replaces any previously-set single callback with `cb`.
   */
  setFrameCallback(cb: FrameCallback): void {
    if (this._legacyUnsub) this._legacyUnsub();
    this._legacyUnsub = this.addFrameCallback(cb);
  }
  private _legacyUnsub: (() => void) | null = null;

  connect(url: string): void {
    if (this.ws) this.disconnect();

    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      this.status = 'error';
      this.error = 'URL must start with ws:// or wss://';
      return;
    }

    this.url = url;
    this.status = 'connecting';
    this.error = null;
    this.frameCount = 0;
    this.txFrameCount = 0;
    this.busInfo = null;

    this._connectAsync(url);
  }

  private async _connectAsync(url: string): Promise<void> {
    let connectUrl = url;
    try {
      const target = new URL(url.replace(/^ws/, 'http'));
      if (typeof window !== 'undefined' && target.hostname !== window.location.hostname) {
        const resp = await fetch('/__ws_proxy');
        const { port } = await resp.json();
        connectUrl = `ws://${window.location.hostname}:${port}/?target=${encodeURIComponent(target.host)}`;
      }
    } catch { /* use original url */ }

    const ws = new WebSocket(connectUrl);

    ws.onopen = () => {
      this.status = 'connected';
      this.error = null;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'status') {
          this.busInfo = { bus: msg.bus, fd: msg.fd };
        } else if (msg.type === 'frame') {
          const frame: RawFrame = {
            arbitration_id: msg.arbitration_id,
            data: hexToBytes(msg.data),
            dlc: msg.dlc,
            timestamp: msg.timestamp,
            is_fd: msg.is_fd,
            direction: msg.direction === 'tx' ? 'tx' : 'rx',
          };
          this.frameCount++;
          if (frame.direction === 'tx') this.txFrameCount++;
          for (const cb of this.frameCallbacks) cb(frame);
        } else if (msg.type === 'send_ack') {
          const ack: SendAck = {
            ok: !!msg.ok,
            error: msg.error,
            arbitration_id: msg.arbitration_id,
          };
          if (!ack.ok) this.lastSendError = ack.error ?? 'send failed';
          for (const cb of this.ackCallbacks) cb(ack);
        }
      } catch {
        // Skip malformed messages
      }
    };

    ws.onerror = (e) => {
      console.error('[WS] error:', e);
      this.status = 'error';
      this.error = 'Connection failed';
    };

    ws.onclose = (e) => {
      console.warn(`[WS] close: code=${e.code} reason="${e.reason}" clean=${e.wasClean}`);
      if (this.status !== 'error') {
        this.status = 'disconnected';
      }
      this.ws = null;
    };

    this.ws = ws;
  }

  /**
   * Send a CAN frame to the server for transmission on the bus.
   * Returns true if the frame was queued onto the WebSocket (not whether
   * the bus actually accepted it — listen for `send_ack` via addAckCallback
   * for confirmation).
   */
  send(arbitrationId: number, data: Uint8Array, isFd: boolean): boolean {
    if (!this.ws || this.status !== 'connected') {
      this.lastSendError = 'not connected';
      return false;
    }
    try {
      const msg = JSON.stringify({
        type: 'send',
        arbitration_id: arbitrationId,
        data: bytesToHex(data),
        is_fd: isFd,
      });
      this.ws.send(msg);
      this.sendCount++;
      this.lastSendError = null;
      return true;
    } catch (e) {
      this.lastSendError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.status = 'disconnected';
  }
}
