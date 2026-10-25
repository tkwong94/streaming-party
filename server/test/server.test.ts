import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGE_BYTES, MAX_PARTICIPANTS } from '@test01/protocol';
import { hashSecret, newRoomId, newSecret, type SyncServerHandle } from '../src/index.js';
import { TestClient, createMessage, createRoom, delay, findValue, joinRoom, startServer } from './helpers.js';

describe('sync server', () => {
  let handle: SyncServerHandle;
  let clients: TestClient[];

  const track = <T extends { client: TestClient }>(value: T): T => {
    clients.push(value.client);
    return value;
  };
  const connect = async () => {
    const client = await TestClient.connect(handle.wsUrl);
    clients.push(client);
    return client;
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

  it('create_returns_128bit_room_id_and_distinct_secret', async () => {
    const host = await connect();
    const started = performance.now();
    host.send(createMessage());
    const created = await host.waitFor('created');
    expect(performance.now() - started).toBeLessThan(2000);

    expect(created.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.roomId).not.toBe(created.secret);
    expect(created.hostId).toBe(created.selfId);
    expect(created.mode).toBe('everyone');
    expect(created.participants).toEqual([
      expect.objectContaining({ id: created.selfId, nickname: 'Host', isHost: true }),
    ]);

    const room = handle.registry.get(created.roomId)!;
    expect(room.secretHash.equals(hashSecret(created.secret))).toBe(true);
    expect(findValue(room, created.secret)).toEqual([]);
    expect(findValue(handle.registry, created.secret)).toEqual([]);
  });

  it('join_with_correct_secret', async () => {
    const { client: host, created } = track(await createRoom(handle));
    const { joined } = track(await joinRoom(handle, created.roomId, created.secret, 'Guest'));

    expect(joined.roomId).toBe(created.roomId);
    expect(joined.hostId).toBe(created.selfId);
    expect(joined.participants).toHaveLength(2);
    expect(joined.participants.map((p) => p.nickname)).toEqual(['Host', 'Guest']);
    expect(joined.participants.find((p) => p.id === joined.selfId)?.isHost).toBe(false);

    const update = await host.waitFor('participants', (m) => m.participants.length === 2);
    expect(update.hostId).toBe(created.selfId);
    expect(handle.counters.received.create).toBe(1);
    expect(handle.counters.received.join).toBe(1);
  });

  it('join_wrong_secret_or_unknown_room_denied', async () => {
    const { created } = track(await createRoom(handle));
    const wrongSecret = await connect();
    const unknownRoom = await connect();
    wrongSecret.send({ v: 1, type: 'join', roomId: created.roomId, secret: newSecret(), nickname: 'Eve' });
    unknownRoom.send({ v: 1, type: 'join', roomId: newRoomId(), secret: created.secret, nickname: 'Eve' });

    const [a, b] = await Promise.all([wrongSecret.waitFor('error'), unknownRoom.waitFor('error')]);
    expect(a.code).toBe('JOIN_DENIED');
    expect(b.code).toBe('JOIN_DENIED');
    expect(a.message).toBe(b.message);
    expect(a.inReplyTo).toBe('join');
    expect(a.message).not.toContain(created.secret);
    expect((await wrongSecret.closed).code).toBe(4001);
    expect((await unknownRoom.closed).code).toBe(4001);
    expect(handle.registry.get(created.roomId)?.participants.size).toBe(1);
  });

  it('eleventh_join_rejected_room_full', async () => {
    // Host + 9 guests = 10 participants (the cap); the 11th participant is rejected.
    const { client: host, created } = track(await createRoom(handle));
    const members = [host];
    for (let i = 1; i < MAX_PARTICIPANTS; i++) {
      const { client, joined } = track(await joinRoom(handle, created.roomId, created.secret, `Guest ${i}`));
      expect(joined.participants).toHaveLength(i + 1);
      members.push(client);
    }
    expect(handle.registry.get(created.roomId)?.participants.size).toBe(MAX_PARTICIPANTS);

    const late = await connect();
    late.send({ v: 1, type: 'join', roomId: created.roomId, secret: created.secret, nickname: 'Late' });
    expect((await late.waitFor('error')).code).toBe('ROOM_FULL');
    expect((await late.closed).code).toBe(4001);
    await delay(50);
    expect(members.every((m) => m.isOpen)).toBe(true);
    expect(handle.registry.get(created.roomId)?.participants.size).toBe(MAX_PARTICIPANTS);

    // Later broadcasts still reach the existing members.
    const leaver = members.pop()!;
    const marks = members.map((m) => m.mark());
    leaver.send({ v: 1, type: 'leave' });
    await Promise.all(
      members.map((m, i) => m.waitFor('participants', (p) => p.participants.length === 9, { from: marks[i] })),
    );
    const marks2 = members.map((m) => m.mark());
    track(await joinRoom(handle, created.roomId, created.secret, 'Replacement'));
    await Promise.all(
      members.map((m, i) => m.waitFor('participants', (p) => p.participants.length === 10, { from: marks2[i] })),
    );
  });

  it('socket_close_removes_participant', async () => {
    const { client: host, created } = track(await createRoom(handle));
    const { client: guest, joined } = track(await joinRoom(handle, created.roomId, created.secret, 'Guest'));
    await host.waitFor('participants', (m) => m.participants.length === 2);
    const from = host.mark();
    guest.ws.close();
    const update = await host.waitFor('participants', (m) => m.participants.length === 1, { timeoutMs: 1000, from });
    expect(update.participants.some((p) => p.id === joined.selfId)).toBe(false);
  });

  it('host_leave_transfers_host', async () => {
    const { client: host, created } = track(await createRoom(handle));
    const { client: first, joined: firstJoined } = track(await joinRoom(handle, created.roomId, created.secret, 'First'));
    const { client: second } = track(await joinRoom(handle, created.roomId, created.secret, 'Second'));
    const marks = [first.mark(), second.mark()];

    host.send({ v: 1, type: 'leave' });
    expect((await host.closed).code).toBe(1000);
    for (const [i, client] of [first, second].entries()) {
      const update = await client.waitFor('participants', (m) => m.participants.length === 2, { from: marks[i] });
      expect(update.hostId).toBe(firstJoined.selfId);
      expect(update.participants.find((p) => p.isHost)?.id).toBe(firstJoined.selfId);
    }
  });

  it('last_leave_deletes_room', async () => {
    const { client: host, created } = track(await createRoom(handle));
    host.send({ v: 1, type: 'leave' });
    expect((await host.closed).code).toBe(1000);
    expect(handle.registry.get(created.roomId)).toBeUndefined();

    // Same outcome when the last socket simply closes.
    const { client: other, created: other2 } = track(await createRoom(handle));
    other.ws.close();
    await other.closed;
    for (let i = 0; i < 20 && handle.registry.get(other2.roomId); i++) await delay(25);
    expect(handle.registry.get(other2.roomId)).toBeUndefined();
  });

  it('second_join_on_same_socket_already_joined', async () => {
    const { client: host, created } = track(await createRoom(handle));
    host.send({ v: 1, type: 'join', roomId: created.roomId, secret: created.secret, nickname: 'Again' });
    const error = await host.waitFor('error');
    expect(error.code).toBe('ALREADY_JOINED');
    expect(error.inReplyTo).toBe('join');

    host.send(createMessage('Again'));
    expect((await host.waitFor('error', (m) => m.inReplyTo === 'create')).code).toBe('ALREADY_JOINED');
    await delay(50);
    expect(host.isOpen).toBe(true);
    expect(handle.registry.get(created.roomId)?.participants.size).toBe(1);
  });

  it('healthz_ok', async () => {
    const ok = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, protocol: 1 });
    const missing = await fetch(`http://127.0.0.1:${handle.port}/x`);
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
  });

  it('unsupported_version_closes_4001', async () => {
    const client = await connect();
    client.send({ v: 2, type: 'join', roomId: newRoomId(), secret: newSecret(), nickname: 'Future' });
    const error = await client.waitFor('error');
    expect(error.code).toBe('UNSUPPORTED_VERSION');
    expect(error.inReplyTo).toBe('join');
    expect((await client.closed).code).toBe(4001);
    expect(handle.counters.received.join).toBe(0);
  });

  it('rejects messages before join and malformed frames without closing', async () => {
    const client = await connect();
    client.send({ v: 1, type: 'leave' });
    expect((await client.waitFor('error')).code).toBe('NOT_JOINED');
    client.send('{not json');
    expect((await client.waitFor('error', (m) => m.code === 'BAD_MESSAGE')).inReplyTo).toBeUndefined();
    client.send({ ...createMessage(), nickname: '\u0007bell' });
    expect((await client.waitFor('error', (m) => m.inReplyTo === 'create')).code).toBe('BAD_MESSAGE');
    await delay(50);
    expect(client.isOpen).toBe(true);
    expect(handle.counters.received.leave).toBe(1);
    expect(handle.counters.received.create).toBe(0);
  });

  it('oversize frame closes with 1009', async () => {
    const client = await connect();
    client.send('x'.repeat(MAX_MESSAGE_BYTES + 1));
    expect((await client.closed).code).toBe(1009);
  });
});

describe('sync server heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('unresponsive_socket_removed_within_10s', async () => {
    // Only the heartbeat interval is faked; socket I/O and test waits use real time.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const handle = await startServer();
    const clients: TestClient[] = [];
    try {
      const { client: host, created } = await createRoom(handle);
      clients.push(host);
      const { client: silent, joined } = await joinRoom(handle, created.roomId, created.secret, 'Silent', {
        autoPong: false,
      });
      clients.push(silent);
      await host.waitFor('participants', (m) => m.participants.length === 2);
      const from = host.mark();

      let elapsedMs = 0;
      let removed = false;
      while (elapsedMs < 10_000 && !removed) {
        await vi.advanceTimersByTimeAsync(500);
        elapsedMs += 500;
        await delay(30);
        removed = host.messages
          .slice(from)
          .some((m) => m.type === 'participants' && !m.participants.some((p) => p.id === joined.selfId));
      }
      expect(removed).toBe(true);
      expect(elapsedMs).toBeLessThanOrEqual(10_000);
      expect(handle.registry.get(created.roomId)?.participants.has(joined.selfId)).toBe(false);
      // The host answers pings, so it survives the same heartbeat cycles.
      expect(host.isOpen).toBe(true);
      expect(handle.registry.get(created.roomId)?.participants.size).toBe(1);
      for (const client of clients) expect(client.invalid).toEqual([]);
    } finally {
      for (const client of clients) client.close();
      await handle.close();
    }
  });
});
