import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlAction } from '@test01/protocol';
import type { SyncServerHandle } from '../src/index.js';
import { TokenBucket } from '../src/ratelimit.js';
import { TestClient, createRoom, delay, joinRoom, startServer } from './helpers.js';

const chat = (text: string) => ({ v: 1, type: 'chat', text });
const control = (action: ControlAction, positionSec: number, clientSeq = 0) => ({
  v: 1,
  type: 'control',
  action,
  positionSec,
  clientSeq,
});
const ping = (clientSentMs: number) => ({ v: 1, type: 'ping', clientSentMs });

/** Polls until the condition holds (real time), failing after timeoutMs. */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > timeoutMs) throw new Error('condition not met in time');
    await delay(10);
  }
}

const ofType = (client: TestClient, type: string, from = 0) => client.messages.slice(from).filter((m) => m.type === type);

describe('TokenBucket', () => {
  it('allows capacity takes, then refills at refillPerSec', () => {
    let now = 0;
    const bucket = new TokenBucket(5, 0.5, () => now);
    for (let i = 0; i < 5; i++) expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    now += 1000;
    expect(bucket.take()).toBe(false);
    now += 1000;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it('never holds more than capacity and ignores a clock going backwards', () => {
    let now = 10_000;
    const bucket = new TokenBucket(2, 1, () => now);
    now += 60_000;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    now -= 5000;
    expect(bucket.take()).toBe(false);
  });
});

describe('per-participant rate limits', () => {
  let handle: SyncServerHandle;
  let clients: TestClient[];

  const party = async () => {
    const { client: host, created } = await createRoom(handle);
    clients.push(host);
    const { client: guest1 } = await joinRoom(handle, created.roomId, created.secret, 'Guest 1');
    clients.push(guest1);
    const { client: guest2 } = await joinRoom(handle, created.roomId, created.secret, 'Guest 2');
    clients.push(guest2);
    await host.waitFor('participants', (m) => m.participants.length === 3);
    await guest1.waitFor('participants', (m) => m.participants.length === 3);
    return { host, guest1, guest2, all: [host, guest1, guest2], room: handle.registry.get(created.roomId)! };
  };

  beforeEach(async () => {
    // Only Date is faked: buckets see frozen time, socket I/O and waits use real timers.
    vi.useFakeTimers({ toFake: ['Date'], now: 1_800_000_000_000 });
    handle = await startServer();
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await handle.close();
    vi.useRealTimers();
    for (const client of clients) expect(client.invalid).toEqual([]);
  });

  it('chat_rate_limited_after_5_per_10s', async () => {
    const { guest1, all } = await party();
    const from = all.map((c) => c.mark());
    for (let i = 1; i <= 6; i++) guest1.send(chat(`m${i}`));
    const error = await guest1.waitFor('error', () => true, { from: from[1] });
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.inReplyTo).toBe('chat');
    await delay(100);
    for (const [i, client] of all.entries()) {
      const texts = ofType(client, 'chat', from[i]).map((m) => (m.type === 'chat' ? m.message.text : ''));
      expect(texts).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    }
    expect(guest1.isOpen).toBe(true);
  });

  it('control_rate_limited_after_10_per_10s', async () => {
    const { host, all, room } = await party();
    const from = all.map((c) => c.mark());
    for (let i = 0; i < 11; i++) host.send(control('seek', i, i));
    const error = await host.waitFor('error', () => true, { from: from[0] });
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.inReplyTo).toBe('control');
    await delay(100);
    expect(room.state.seq).toBe(10);
    expect(room.state.positionSec).toBe(9);
    for (const [i, client] of all.entries()) expect(ofType(client, 'state', from[i])).toHaveLength(10);
  });

  it('total_rate_limited_after_50_per_10s', async () => {
    const client = await TestClient.connect(handle.wsUrl);
    clients.push(client);
    for (let i = 1; i <= 51; i++) client.send(ping(i));
    const error = await client.waitFor('error');
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.inReplyTo).toBe('ping');
    await delay(100);
    const pongs = ofType(client, 'pong');
    expect(pongs).toHaveLength(50);
    expect(pongs.map((m) => (m.type === 'pong' ? m.clientSentMs : 0))).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(ofType(client, 'error')).toHaveLength(1);
    expect(client.isOpen).toBe(true);
  });

  it('bucket_refills', async () => {
    const { guest1, all } = await party();
    for (let i = 1; i <= 6; i++) guest1.send(chat(`m${i}`));
    await guest1.waitFor('error', (m) => m.code === 'RATE_LIMITED');
    // Every member must have the first five relays before marking, or they leak into the count below.
    await Promise.all(all.map((c) => c.waitFor('chat', (m) => m.message.text === 'm5')));

    vi.setSystemTime(Date.now() + 2000);
    const from = all.map((c) => c.mark());
    guest1.send(chat('after refill'));
    await Promise.all(all.map((c, i) => c.waitFor('chat', (m) => m.message.text === 'after refill', { from: from[i] })));
    guest1.send(chat('one too many'));
    const error = await guest1.waitFor('error', (m) => m.code === 'RATE_LIMITED', { from: from[1] });
    expect(error.inReplyTo).toBe('chat');
    await delay(100);
    for (const [i, client] of all.entries()) expect(ofType(client, 'chat', from[i])).toHaveLength(1);
  });

  it('ten_bad_messages_close_4008', async () => {
    const client = await TestClient.connect(handle.wsUrl);
    clients.push(client);
    for (let i = 0; i < 9; i++) client.send('{not json');
    await until(() => ofType(client, 'error').length === 9);
    await delay(50);
    expect(client.isOpen).toBe(true);
    client.send('{not json');
    expect((await client.closed).code).toBe(4008);
    const errors = ofType(client, 'error');
    expect(errors).toHaveLength(10);
    expect(errors.every((m) => m.type === 'error' && m.code === 'BAD_MESSAGE')).toBe(true);
  });

  it('bad_messages_older_than_10s_do_not_count', async () => {
    const client = await TestClient.connect(handle.wsUrl);
    clients.push(client);
    for (let i = 0; i < 9; i++) client.send('{not json');
    await until(() => ofType(client, 'error').length === 9);
    vi.setSystemTime(Date.now() + 10_001);
    for (let i = 0; i < 9; i++) client.send('{not json');
    await until(() => ofType(client, 'error').length === 18);
    await delay(50);
    expect(client.isOpen).toBe(true);
  });
});
