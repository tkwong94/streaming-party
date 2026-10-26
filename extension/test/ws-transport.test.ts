import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { ServerMessage } from '@test01/protocol';
import { createWsTransport } from '../src/transport/ws-transport.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startServer(onConnection: (socket: WsSocket) => void): Promise<string> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws' });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  wss.on('connection', onConnection);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  );
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
}

describe('createWsTransport', () => {
  it('ws_transport_roundtrip', async () => {
    const received: unknown[] = [];
    const url = await startServer((socket) => {
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        received.push(msg);
        if (msg.type !== 'ping') return;
        socket.send('not json');
        socket.send(JSON.stringify({ v: 1, type: 'pong', clientSentMs: msg.clientSentMs }));
        socket.send(JSON.stringify({ v: 2, type: 'pong', clientSentMs: msg.clientSentMs, serverMs: 1 }));
        socket.send(JSON.stringify({ v: 1, type: 'pong', clientSentMs: msg.clientSentMs, serverMs: 1234 }));
      });
    });

    const transport = await createWsTransport(url);
    cleanups.push(async () => transport.close());
    const messages: ServerMessage[] = [];
    const unsubscribed: ServerMessage[] = [];
    const off = transport.onMessage((m) => unsubscribed.push(m));
    off();
    const got = new Promise<void>((resolve) =>
      transport.onMessage((m) => {
        messages.push(m);
        resolve();
      }),
    );

    expect(() => transport.send({ v: 1, type: 'ping', clientSentMs: 42 })).not.toThrow();
    await got;

    expect(received).toEqual([{ v: 1, type: 'ping', clientSentMs: 42 }]);
    expect(messages).toEqual([{ v: 1, type: 'pong', clientSentMs: 42, serverMs: 1234 }]);
    expect(unsubscribed).toEqual([]);
  });

  it('ws_transport_reports_close_code', async () => {
    let serverSocket: WsSocket | undefined;
    const url = await startServer((socket) => {
      serverSocket = socket;
    });
    const transport = await createWsTransport(url);
    const code = new Promise<number>((resolve) => transport.onClose(resolve));
    await expect.poll(() => serverSocket).toBeDefined();
    serverSocket!.close(4001, 'denied');
    expect(await code).toBe(4001);
  });

  it('ws_transport_connect_failure', async () => {
    const started = Date.now();
    await expect(createWsTransport('ws://127.0.0.1:1')).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(createWsTransport('not a url')).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
  });

  it('ws_transport_connect_timeout', async () => {
    // Accepts TCP but never answers the WebSocket handshake.
    const sockets = new Set<import('node:net').Socket>();
    const silent: Server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          silent.close(() => resolve());
        }),
    );
    const port = (silent.address() as AddressInfo).port;

    const started = Date.now();
    await expect(createWsTransport(`ws://127.0.0.1:${port}/ws`)).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(6000);
  }, 10_000);
});
