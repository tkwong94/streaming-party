import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SyncServerHandle } from '../src/index.js';
import { TestClient, createRoom, startServer } from './helpers.js';

describe('clock ping', () => {
  let handle: SyncServerHandle;
  let clients: TestClient[];

  beforeEach(async () => {
    handle = await startServer();
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await handle.close();
    for (const client of clients) expect(client.invalid).toEqual([]);
  });

  it('ping_returns_pong', async () => {
    const { client: host } = await createRoom(handle);
    clients.push(host);
    const clientSentMs = 1_234_567.25;
    host.send({ v: 1, type: 'ping', clientSentMs });
    const pong = await host.waitFor('pong');
    const now = Date.now();
    expect(pong.clientSentMs).toBe(clientSentMs);
    expect(Math.abs(pong.serverMs - now)).toBeLessThanOrEqual(50);
    expect(handle.counters.received.ping).toBe(1);
  });

  it('ping is answered before join', async () => {
    const client = await TestClient.connect(handle.wsUrl);
    clients.push(client);
    client.send({ v: 1, type: 'ping', clientSentMs: 42 });
    const pong = await client.waitFor('pong');
    expect(pong.clientSentMs).toBe(42);
    expect(Math.abs(pong.serverMs - Date.now())).toBeLessThanOrEqual(50);
  });
});
