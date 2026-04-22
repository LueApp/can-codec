import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { createServer as createHttpServer } from 'http';
import { createConnection, type Socket } from 'net';
import { createHash } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo } from 'net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsProxy(): Plugin {
  let proxyPort = 0;

  return {
    name: 'ws-proxy',
    configureServer(server) {
      function handleProxy(req: IncomingMessage, socket: Socket, head: Buffer) {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const target = url.searchParams.get('target');
        if (!target) { socket.destroy(); return; }

        const [host, portStr] = target.split(':');
        const port = parseInt(portStr) || 80;
        const clientKey = req.headers['sec-websocket-key'] || '';

        const accept = createHash('sha1').update(clientKey + WS_GUID).digest('base64');
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          `\r\n`
        );

        const upstream = createConnection(port, host);
        let upstreamReady = false;
        let pendingFromBrowser: Buffer[] = [];

        upstream.on('connect', () => {
          const upstreamKey = createHash('sha1')
            .update(String(Date.now() + Math.random()))
            .digest('base64')
            .slice(0, 24);
          const origin = req.headers['origin'] || '';
          upstream.write(
            `GET / HTTP/1.1\r\n` +
            `Host: ${target}\r\n` +
            `Connection: Upgrade\r\n` +
            `Upgrade: websocket\r\n` +
            `Sec-WebSocket-Version: 13\r\n` +
            `Sec-WebSocket-Key: ${upstreamKey}\r\n` +
            (origin ? `Origin: ${origin}\r\n` : '') +
            `\r\n`
          );
          if (head && head.length > 0) pendingFromBrowser.push(head);
        });

        let handshakeBuf = Buffer.alloc(0);

        upstream.on('data', (chunk) => {
          if (!upstreamReady) {
            handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
            const idx = handshakeBuf.indexOf('\r\n\r\n');
            if (idx === -1) return;
            upstreamReady = true;
            const trailing = handshakeBuf.slice(idx + 4);
            if (trailing.length > 0 && socket.writable) socket.write(trailing);
            handshakeBuf = Buffer.alloc(0);
            for (const pending of pendingFromBrowser) {
              if (upstream.writable) upstream.write(pending);
            }
            pendingFromBrowser = [];
            return;
          }
          if (socket.writable) socket.write(chunk);
        });

        socket.on('data', (chunk: Buffer) => {
          if (!upstreamReady) pendingFromBrowser.push(chunk);
          else if (upstream.writable) upstream.write(chunk);
        });

        upstream.on('error', (err) => {
          console.error(`[ws-proxy] upstream error: ${err.message}`);
          socket.destroy();
        });
        upstream.on('close', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
        socket.on('close', () => upstream.destroy());
      }

      const proxyServer = createHttpServer((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(404);
        res.end();
      });

      proxyServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
        handleProxy(req, socket, head);
      });

      proxyServer.listen(0, () => {
        proxyPort = (proxyServer.address() as AddressInfo).port;
        console.log(`[ws-proxy] proxy on port ${proxyPort}`);
      });

      server.middlewares.use('/__ws_proxy', (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ port: proxyPort }));
      });
    },
  };
}

export default defineConfig({
  plugins: [sveltekit(), wsProxy()]
});
