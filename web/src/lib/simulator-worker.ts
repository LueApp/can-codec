/// <reference lib="webworker" />
import { SimulatorGateway, type GatewayConfig } from './simulator-gateway';

let socket: WebSocket | null = null;
let gateway: SimulatorGateway | null = null;
let status = 'disconnected';
let ready = false;
let received = 0, sent = 0, errors = 0;
let bus = '', backend = '', busConnected = false;
const trace: Record<string, unknown>[] = [];
const pending = new Map<string, number>();
const delays: number[] = [];

function log(stage: string, detail: unknown) {
  trace.push({ time: Date.now(), stage, detail });
  if (trace.length > 300) trace.shift();
}
function send(message: unknown) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Bridge disconnected');
  if (socket.bufferedAmount > 1_048_576) throw new Error('Bridge send buffer full');
  socket.send(JSON.stringify(message));
}
function disconnect() {
  const old = socket;
  socket = null;
  old?.close();
  ready = false;
  status = 'disconnected';
  pending.clear();
}

self.onmessage = (event: MessageEvent<{ type: string; url: string; config: GatewayConfig }>) => {
  if (event.data.type === 'stop') { disconnect(); return; }
  if (event.data.type !== 'start') return;
  disconnect();
  try {
    gateway = new SimulatorGateway(event.data.config);
    const connection = new WebSocket(event.data.url);
    socket = connection;
    received = sent = errors = 0;
    status = 'connecting';
    connection.onopen = () => {
      if (socket !== connection) return;
      status = 'waiting for simulator';
      send({ type: 'sim_hello', version: 1, role: 'codec' });
    };
    connection.onmessage = event => {
      if (socket !== connection) return;
      try {
        const packet = JSON.parse(event.data);
        if (packet.type === 'status') {
          bus = packet.bus;
          backend = packet.backend ?? 'unknown';
          busConnected = !!packet.connected;
        } else if (packet.type === 'sim_peer') {
          ready = false;
          status = packet.connected ? 'checking definitions' : 'simulator disconnected';
          if (packet.connected) send({ type: 'sim_data', payload: gateway!.definitions() });
        } else if (packet.type === 'sim_error') {
          throw new Error(packet.error);
        } else if (packet.type === 'frame' && ready) {
          const decodedMessages = gateway!.receive(packet);
          if (!decodedMessages.length && packet.origin !== 'simulator') log('not forwarded', packet);
          for (const decoded of decodedMessages) {
            send({ type: 'sim_data', payload: decoded });
            received++;
            log('forwarded', decoded);
          }
        } else if (packet.type === 'sim_data') {
          const payload = packet.payload;
          if (payload.type === 'ready') {
            ready = !!payload.ok;
            status = ready ? 'ready' : `incompatible: ${payload.errors.join('; ')}`;
            log('compatibility', payload);
          } else if (payload.type === 'message' && ready) {
            if (pending.size >= 4096) {
              ready = false;
              status = 'stopped: too many pending transmissions';
              throw new Error(status);
            }
            const frame = gateway!.output(payload);
            send(frame);
            pending.set(frame.request_id, performance.now());
            sent++;
            log('encoded', { ...payload, frame });
          } else if (payload.type === 'response') {
            log(payload.status, payload);
          }
        } else if (packet.type === 'send_ack') {
          const start = pending.get(packet.request_id);
          pending.delete(packet.request_id);
          if (start !== undefined) {
            delays.push(performance.now() - start);
            if (delays.length > 2000) delays.shift();
          }
          if (ready) send({ type: 'sim_data', payload: { ...packet, type: 'send_result' } });
          log('transmission', packet);
          if (!packet.ok) errors++;
        }
      } catch (error) {
        errors++;
        log('error', String(error));
      }
    };
    connection.onerror = () => { if (socket === connection) { status = 'connection error'; errors++; } };
    connection.onclose = () => { if (socket === connection) { status = 'disconnected'; ready = false; pending.clear(); } };
  } catch (error) {
    status = String(error);
    errors++;
    log('error', status);
  }
};

// Only UI reporting is timer-driven. Every control message is forwarded immediately.
setInterval(() => {
  for (const [id, started] of pending) {
    if (performance.now() - started > 2000) {
      pending.delete(id);
      errors++;
      log('transmission timeout', { request_id: id, stage: 'unknown' });
    }
  }
  const sorted = [...delays].sort((a, b) => a - b);
  self.postMessage({ type: 'status', status, ready, received, sent, errors, bus, backend, busConnected,
    pending: pending.size, submitP99Ms: sorted[Math.floor(sorted.length * 0.99)] ?? 0, trace: [...trace] });
}, 100);
