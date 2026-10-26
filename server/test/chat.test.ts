import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_ID_PATTERN } from '@test01/protocol';
import type { SyncServerHandle } from '../src/index.js';
import { TestClient, createRoom, delay, findValue, joinRoom, startServer } from './helpers.js';

const chat = (text: string) => ({ v: 1, type: 'chat', text });

describe('chat relay', () => {
  let handle: SyncServerHandle;
  let clients: TestClient[];

  const party = async () => {
    const { client: host, created } = await createRoom(handle);
    clients.push(host);
    const { client: guest1, joined: g1 } = await joinRoom(handle, created.roomId, created.secret, 'Guest 1');
    clients.push(guest1);
    const { client: guest2 } = await joinRoom(handle, created.roomId, created.secret, 'Guest 2');
    clients.push(guest2);
    await host.waitFor('participants', (m) => m.participants.length === 3);
    await guest1.waitFor('participants', (m) => m.participants.length === 3);
    return { host, guest1, guest2, all: [host, guest1, guest2], created, g1Id: g1.selfId };
  };

  beforeEach(async () => {
    handle = await startServer();
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await handle.close();
    for (const client of clients) expect(client.invalid).toEqual([]);
  });

  it('chat_relayed_to_all_including_sender', async () => {
    const { guest1, all, g1Id } = await party();
    const before = Date.now();
    guest1.send(chat('hello party'));
    const received = await Promise.all(all.map((c) => c.waitFor('chat')));
    const after = Date.now();
    const [first] = received;
    for (const message of received) expect(message).toEqual(first);
    expect(first!.message.id).toMatch(CHAT_ID_PATTERN);
    expect(first!.message).toMatchObject({ participantId: g1Id, nickname: 'Guest 1', text: 'hello party' });
    expect(first!.message.sentAtServerMs).toBeGreaterThanOrEqual(before);
    expect(first!.message.sentAtServerMs).toBeLessThanOrEqual(after);

    guest1.send(chat('second'));
    const second = await guest1.waitFor('chat', (m) => m.message.text === 'second');
    expect(second.message.id).not.toBe(first!.message.id);
    expect(handle.counters.received.chat).toBe(2);
  });

  it('chat_trimmed_and_blank_rejected', async () => {
    const { host, guest1, all } = await party();
    host.send(chat('  hi  '));
    const received = await Promise.all(all.map((c) => c.waitFor('chat')));
    for (const message of received) expect(message.message.text).toBe('hi');

    const from = all.map((c) => c.mark());
    guest1.send(chat('   '));
    const error = await guest1.waitFor('error', () => true, { from: from[1] });
    expect(error.code).toBe('BAD_MESSAGE');
    expect(error.inReplyTo).toBe('chat');
    await delay(100);
    for (const [i, client] of all.entries()) {
      expect(client.messages.slice(from[i]).filter((m) => m.type === 'chat')).toEqual([]);
    }
    expect(guest1.isOpen).toBe(true);
  });

  it('late_joiner_gets_no_chat_history', async () => {
    const { host, created, all } = await party();
    const text = 'said before you arrived';
    host.send(chat(text));
    await Promise.all(all.map((c) => c.waitFor('chat')));

    const { client: late, joined } = await joinRoom(handle, created.roomId, created.secret, 'Late');
    clients.push(late);
    expect(Object.hasOwn(joined, 'chat')).toBe(false);
    expect(JSON.stringify(joined)).not.toContain(text);
    await delay(150);
    expect(late.messages.filter((m) => m.type === 'chat')).toEqual([]);
    // Nothing is retained after the relay.
    expect(findValue(handle.registry, text)).toEqual([]);
  });

  it('chat_before_join_not_joined', async () => {
    const client = await TestClient.connect(handle.wsUrl);
    clients.push(client);
    client.send(chat('hi'));
    const error = await client.waitFor('error');
    expect(error.code).toBe('NOT_JOINED');
    expect(error.inReplyTo).toBe('chat');
    expect(client.isOpen).toBe(true);
  });
});
