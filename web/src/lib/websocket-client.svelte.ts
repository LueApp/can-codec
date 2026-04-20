/**
 * Reactive WebSocket client for live CAN bus frame streaming.
 */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface RawFrame {
  arbitration_id: number;
  data: Uint8Array;
  timestamp: number;
  is_fd: boolean;
}

type FrameCallback = (frame: RawFrame) => void;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export class WebSocketClient {
  status = $state<ConnectionStatus>('disconnected');
  error = $state<string | null>(null);
  url = $state<string>('');
  frameCount = $state<number>(0);
  busInfo = $state<{ bus: string; fd: boolean } | null>(null);

  private ws: WebSocket | null = null;
  private onFrame: FrameCallback | null = null;

  setFrameCallback(cb: FrameCallback): void {
    this.onFrame = cb;
  }

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
    this.busInfo = null;

    const ws = new WebSocket(url);

    ws.onopen = () => {
      this.status = 'connected';
      this.error = null;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'status') {
          this.busInfo = { bus: msg.bus, fd: msg.fd };
        } else if (msg.type === 'frame' && this.onFrame) {
          this.frameCount++;
          this.onFrame({
            arbitration_id: msg.arbitration_id,
            data: hexToBytes(msg.data),
            timestamp: msg.timestamp,
            is_fd: msg.is_fd,
          });
        }
      } catch {
        // Skip malformed messages
      }
    };

    ws.onerror = () => {
      this.status = 'error';
      this.error = 'Connection failed';
    };

    ws.onclose = () => {
      if (this.status !== 'error') {
        this.status = 'disconnected';
      }
      this.ws = null;
    };

    this.ws = ws;
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.status = 'disconnected';
  }
}
