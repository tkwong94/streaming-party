import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlAction, ControlMode } from '@test01/protocol';
import type { SyncServerHandle } from '../src/index.js';
import { extrapolate } from '../src/playback.js';
import { TestClient, createRoom, delay, joinRoom, startServer } from './helpers.js';

const control = (action: ControlAction, positionSec: number, clientSeq = 0) => ({
  v: 1,
  type: 'control',
  action,
  positionSec,
  clientSeq,
});
const report = (positionSec: number, playing: boolean, buffering: boolean) => ({
  v: 1,
  type: 'position_report',
  positionSec,
  playing,
  buffering,
});
const setMode = (mode: ControlMode) => ({ v: 1, type: 'set_mode', mode });

describe('playback control', () => {
  let handle: SyncServerHandle;
  let clients: TestClient[];

  /** Host plus two guests, with every participants broadcast delivered. */
  const party = async () => {
    const { client: host, created } = await createRoom(handle);
    clients.push(host);
    const { client: guest1, joined: g1 } = await joinRoom(handle, created.roomId, created.secret, 'Guest 1');
    clients.push(guest1);
    const { client: guest2, joined: g2 } = await joinRoom(handle, created.roomId, created.secret, 'Guest 2');
    clients.push(guest2);
    await host.waitFor('participants', (m) => m.participants.length === 3);
    await guest1.waitFor('participants', (m) => m.participants.length === 3);
    const room = handle.registry.get(created.roomId)!;
    return { host, guest1, guest2, all: [host, guest1, guest2], hostId: created.selfId, g1Id: g1.selfId, g2Id: g2.selfId, room };
  };

  const marks = (all: TestClient[]) => all.map((c) => c.mark());

  beforeEach(async () => {
    handle = await startServer();
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await handle.close();
    for (const client of clients) expect(client.invalid).toEqual([]);
  });

  it('play_pause_seek_update_state_and_broadcast', async () => {
    const { host, guest1, guest2, all, hostId, g1Id, g2Id, room } = await party();
    const steps: [TestClient, ControlAction, number, string, boolean][] = [
      [host, 'play', 5, hostId, true],
      [guest1, 'pause', 6, g1Id, false],
      [guest2, 'seek', 30, g2Id, false],
    ];
    for (const [i, [sender, action, positionSec, senderId, playing]] of steps.entries()) {
      const from = marks(all);
      sender.send(control(action, positionSec, i));
      const received = await Promise.all(
        all.map((c, j) => c.waitFor('state', (m) => m.state.seq === i + 1, { from: from[j] })),
      );
      for (const message of received) {
        expect(message.cause).toBe('control');
        expect(message.state).toMatchObject({ seq: i + 1, playing, positionSec, updatedBy: senderId });
      }
    }
    expect(room.state.seq).toBe(3);
    expect(handle.counters.received.control).toBe(3);
  });

  it('everyone_mode_guest_control_accepted', async () => {
    const { host, guest1, all, hostId, g1Id, room } = await party();
    expect(room.mode).toBe('everyone');
    host.send(control('play', 0));
    await Promise.all(all.map((c) => c.waitFor('state', (m) => m.state.seq === 1)));

    guest1.send(control('pause', 3));
    const seen = await Promise.all(all.map((c) => c.waitFor('state', (m) => m.state.seq === 2)));
    for (const message of seen) expect(message.state).toMatchObject({ playing: false, positionSec: 3, updatedBy: g1Id });
    expect(room.state).toMatchObject({ playing: false, updatedBy: g1Id });
    expect(room.state.updatedBy).not.toBe(hostId);
  });

  it('host_only_guest_control_forbidden', async () => {
    const { host, guest1, all, room } = await party();
    host.send(setMode('host_only'));
    await Promise.all(all.map((c) => c.waitFor('mode')));

    const from = marks(all);
    const before = { ...room.state };
    guest1.send(control('play', 7));
    const error = await guest1.waitFor('error', () => true, { from: from[1] });
    expect(error.code).toBe('FORBIDDEN_CONTROL');
    expect(error.inReplyTo).toBe('control');
    await delay(100);
    expect(room.state).toEqual(before);
    expect(room.state.seq).toBe(0);
    for (const [i, client] of all.entries()) {
      const later = client.messages.slice(from[i]);
      expect(later.filter((m) => m.type === 'state')).toEqual([]);
      // The error goes to the sender only.
      expect(later.filter((m) => m.type === 'error')).toHaveLength(client === guest1 ? 1 : 0);
    }
    expect(host.isOpen && guest1.isOpen).toBe(true);
  });

  it('host_only_host_control_accepted', async () => {
    const { host, all, hostId, room } = await party();
    host.send(setMode('host_only'));
    await Promise.all(all.map((c) => c.waitFor('mode')));
    host.send(control('seek', 42));
    const seen = await Promise.all(all.map((c) => c.waitFor('state')));
    for (const message of seen) {
      expect(message.cause).toBe('control');
      expect(message.state).toMatchObject({ seq: 1, positionSec: 42, playing: false, updatedBy: hostId });
    }
    expect(room.state).toMatchObject({ seq: 1, positionSec: 42 });
  });

  it('guest_set_mode_forbidden', async () => {
    const { guest1, all, room } = await party();
    const from = marks(all);
    guest1.send(setMode('host_only'));
    const error = await guest1.waitFor('error', () => true, { from: from[1] });
    expect(error.code).toBe('FORBIDDEN_MODE');
    expect(error.inReplyTo).toBe('set_mode');
    await delay(100);
    expect(room.mode).toBe('everyone');
    for (const [i, client] of all.entries()) {
      expect(client.messages.slice(from[i]).filter((m) => m.type === 'mode')).toEqual([]);
    }
  });

  it('mode_change_broadcast_to_all', async () => {
    const { host, all, hostId, room } = await party();
    host.send(setMode('host_only'));
    const seen = await Promise.all(all.map((c) => c.waitFor('mode')));
    for (const message of seen) expect(message).toEqual({ v: 1, type: 'mode', mode: 'host_only', changedBy: hostId });
    expect(room.mode).toBe('host_only');
  });

  it('host_report_rebases_state', async () => {
    const { host, all, room } = await party();
    host.send(control('play', 0));
    await Promise.all(all.map((c) => c.waitFor('state', (m) => m.state.seq === 1)));

    host.send(report(42.0, true, false));
    const seen = await Promise.all(all.map((c) => c.waitFor('state', (m) => m.cause === 'host_report')));
    for (const message of seen) {
      expect(message.state).toMatchObject({ positionSec: 42.0, seq: 1, playing: true, hostBuffering: false });
    }
    expect(room.state).toMatchObject({ positionSec: 42.0, seq: 1, playing: true, hostBuffering: false });

    host.send(report(42.5, true, true));
    const buffering = await Promise.all(all.map((c) => c.waitFor('state', (m) => m.state.hostBuffering)));
    for (const message of buffering) {
      expect(message.cause).toBe('host_report');
      expect(message.state).toMatchObject({ positionSec: 42.5, seq: 1 });
    }
    expect(room.state).toMatchObject({ hostBuffering: true, seq: 1, playing: true });
    expect(extrapolate(room.state, room.state.updatedAtServerMs + 5000)).toBe(42.5);
  });

  it('guest_report_ignored', async () => {
    const { guest1, all, room } = await party();
    const before = { ...room.state };
    const from = marks(all);
    guest1.send(report(99, true, true));
    await delay(150);
    expect(room.state).toEqual(before);
    for (const [i, client] of all.entries()) expect(client.messages.slice(from[i])).toEqual([]);
    expect(handle.counters.received.position_report).toBe(1);
  });

  it('control_before_join_not_joined', async () => {
    const client = await TestClient.connect(handle.wsUrl);
    clients.push(client);
    client.send(control('play', 0));
    const error = await client.waitFor('error');
    expect(error.code).toBe('NOT_JOINED');
    expect(error.inReplyTo).toBe('control');
    client.send(setMode('host_only'));
    expect((await client.waitFor('error', (m) => m.inReplyTo === 'set_mode')).code).toBe('NOT_JOINED');
    client.send(report(1, true, false));
    expect((await client.waitFor('error', (m) => m.inReplyTo === 'position_report')).code).toBe('NOT_JOINED');
    expect(client.isOpen).toBe(true);
  });
});

describe('playback control late join', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('late_join_gets_extrapolated_state', async () => {
    // Only Date is faked, so socket I/O and test waits use real timers.
    vi.useFakeTimers({ toFake: ['Date'], now: 1_800_000_000_000 });
    const handle = await startServer();
    const clients: TestClient[] = [];
    try {
      const { client: host, created } = await createRoom(handle);
      clients.push(host);
      host.send(control('play', 10));
      const started = await host.waitFor('state');
      expect(started.state).toMatchObject({ playing: true, positionSec: 10 });

      vi.setSystemTime(Date.now() + 5000);
      const { client: guest, joined } = await joinRoom(handle, created.roomId, created.secret, 'Late');
      clients.push(guest);
      expect(joined.state.playing).toBe(true);
      expect(Math.abs(joined.state.positionSec - 15)).toBeLessThanOrEqual(0.05);
      expect(joined.state.updatedAtServerMs).toBe(Date.now());
      expect(joined.state.seq).toBe(1);
      for (const client of clients) expect(client.invalid).toEqual([]);
    } finally {
      for (const client of clients) client.close();
      await handle.close();
    }
  });
});
