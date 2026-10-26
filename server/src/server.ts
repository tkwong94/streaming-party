import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { CLIENT_MESSAGE_TYPES, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, type ClientMessage } from '@test01/protocol';
import { Connection, type ServerContext } from './connection.js';
import { RoomRegistry } from './rooms.js';

export const WS_PATH = '/ws';
/** A socket that misses one ping cycle is terminated: removal within 2 cycles (6 s) of going silent. */
export const HEARTBEAT_INTERVAL_MS = 3000;

export interface SyncServerOptions {
  port: number;
  host: string;
}

export interface SyncServerHandle {
  port: number;
  wsUrl: string;
  registry: RoomRegistry;
  counters: { received: Record<ClientMessage['type'], number> };
  close(): Promise<void>;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '';
  }
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'GET' && pathOf(req) === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not Found');
}

function urlHost(host: string, port: number): string {
  if (host === '0.0.0.0' || host === '') return `127.0.0.1:${port}`;
  if (host === '::') return `[::1]:${port}`;
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

export async function createSyncServer(opts: SyncServerOptions): Promise<SyncServerHandle> {
  const registry = new RoomRegistry();
  const received = Object.fromEntries(CLIENT_MESSAGE_TYPES.map((type) => [type, 0])) as Record<
    ClientMessage['type'],
    number
  >;
  const ctx: ServerContext = { registry, counters: { received }, connections: new Map() };
  const sockets = new Set<Connection>();

  const http = createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (pathOf(req) !== WS_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = new Connection(ctx, ws);
      sockets.add(connection);
      ws.on('close', () => sockets.delete(connection));
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => {
      http.off('error', reject);
      resolve();
    });
  });

  const heartbeat = setInterval(() => {
    for (const connection of sockets) connection.heartbeat();
  }, HEARTBEAT_INTERVAL_MS);

  const port = (http.address() as AddressInfo).port;
  return {
    port,
    wsUrl: `ws://${urlHost(opts.host, port)}${WS_PATH}`,
    registry,
    counters: ctx.counters,
    async close() {
      clearInterval(heartbeat);
      for (const connection of sockets) connection.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
        http.closeAllConnections();
      });
    },
  };
}
