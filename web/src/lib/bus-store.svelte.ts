/**
 * Shared CAN bus connection. Single WebSocketClient instance used by the
 * Plot page (RX, decoding) and the Encode/Sequence page (TX, commands).
 *
 * Persists the WS URL in localStorage so it survives reloads and is shared
 * across pages.
 */

import { WebSocketClient } from './websocket-client.svelte';

const LS_URL_KEY = 'cancodec_ws_url';
const DEFAULT_URL = 'ws://localhost:8765';

function loadUrl(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_URL;
  return localStorage.getItem(LS_URL_KEY) ?? DEFAULT_URL;
}

class BusStore {
  client = new WebSocketClient();
  wsUrl = $state<string>(loadUrl());

  connect(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_URL_KEY, this.wsUrl);
    }
    this.client.connect(this.wsUrl);
  }

  disconnect(): void {
    this.client.disconnect();
  }

  get connected(): boolean {
    return this.client.status === 'connected';
  }
}

export const busStore = new BusStore();
