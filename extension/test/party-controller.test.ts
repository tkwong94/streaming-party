// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientMessage,
  Clock,
  InviteLink,
  JoinedMessage,
  ParticipantWire,
  PlaybackStateWire,
  PlayerAdapter,
  ServerMessage,
  SyncTransport,
} from '@test01/protocol';
import { PartyController } from '../src/content/party-controller.js';
import { PartySession } from '../src/content/session.js';
import type { WsTransport } from '../src/transport/ws-transport.js';
import type { ClockSync } from '../src/sync/clock.js';
import type { SyncEngine, SyncEngineOptions } from '../src/sync/engine.js';
import { FakeAdapter } from './sync/fake-adapter.js';

const ROOM_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const SECRET = 'B'.repeat(43);
const HOST_ID = 'HHHHHHHHHHHHHHHHHHHHHH';
const GUEST_ID = 'GGGGGGGGGGGGGGGGGGGGGG';
const INVITE: InviteLink = { v: 1, s: 'ws://127.0.0.1:8787/ws', r: ROOM_ID, k: SECRET, titleUrl: 'http://127.0.0.1:8790/watch/fixture' };
const STATE: PlaybackStateWire = { playing: false, positionSec: 30, updatedAtServerMs: 1000, seq: 3, updatedBy: HOST_ID, hostBuffering: false };

function participant(id: string, nickname: string, isHost: boolean, joinedAtServerMs: number): ParticipantWire {
  return { id, nickname, isHost, joinedAtServerMs };
}

const JOINED: JoinedMessage = {
  v: 1,
  type: 'joined',
  roomId: ROOM_ID,
  selfId: GUEST_ID,
  hostId: HOST_ID,
  mode: 'everyone',
  participants: [participant(HOST_ID, 'Alice', true, 1000), participant(GUEST_ID, 'Bob', false, 2000)],
  state: STATE,
};

/** WsTransport stand-in: answers join with JOINED; tests push frames with emit(). */
class FakeWsTransport implements WsTransport {
  readonly sent: ClientMessage[] = [];
  closed = false;
  private readonly messageCbs = new Set<(m: ServerMessage) => void>();
  private readonly closeCbs = new Set<(code: number) => void>();

  send(msg: ClientMessage): void {
    this.sent.push(msg);
    if (msg.type === 'join') queueMicrotask(() => this.emit(JOINED));
  }

  onMessage(cb: (m: ServerMessage) => void): () => void {
    this.messageCbs.add(cb);
    return () => this.messageCbs.delete(cb);
  }

  onClose(cb: (code: number) => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  close(): void {
    this.closed = true;
  }

  emit(m: ServerMessage): void {
    for (const cb of [...this.messageCbs]) cb(m);
  }
}

function shadow(): ShadowRoot {
  const host = document.querySelector('test01-sidebar');
  if (!host?.shadowRoot) throw new Error('sidebar not mounted');
  return host.shadowRoot;
}

function nicknames(): string[] {
  return Array.from(shadow().querySelectorAll('.participants .nick'), (n) => n.textContent ?? '');
}

function setup() {
  const log: string[] = [];
  const transport = new FakeWsTransport();
  const session = new PartySession(async () => transport);
  const adapter = new FakeAdapter({ positionSec: 0, paused: true });
  const clock: Clock = { now: () => 42 };
  const clockSync = {
    start: vi.fn(() => log.push('clock.start')),
    stop: vi.fn(() => log.push('clock.stop')),
    serverNow: () => 0,
  } as unknown as ClockSync;
  const engine = {
    start: vi.fn((_s: PlaybackStateWire) => log.push('engine.start')),
    stop: vi.fn(() => log.push('engine.stop')),
  } as unknown as SyncEngine;
  const createClockSync = vi.fn((_t: SyncTransport, _c: Clock) => clockSync);
  const createEngine = vi.fn((_a: PlayerAdapter, _t: SyncTransport, _sc: unknown, _o: SyncEngineOptions) => engine);
  const selectAdapter = vi.fn(async () => adapter as PlayerAdapter);
  const controller = new PartyController(document, session, selectAdapter, { clock, createClockSync, createEngine });
  return { log, transport, session, adapter, clock, clockSync, engine, createClockSync, createEngine, controller };
}

describe('PartyController', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('controller_starts_engine_after_join', async () => {
    const t = setup();
    await t.controller.start();
    expect(t.createEngine).not.toHaveBeenCalled();

    await t.session.join(INVITE, 'Bob');

    expect(t.createClockSync).toHaveBeenCalledTimes(1);
    expect(t.createClockSync.mock.calls[0][0]).toBe(t.transport);
    expect(t.createClockSync.mock.calls[0][1]).toBe(t.clock);
    expect(t.log.indexOf('clock.start')).toBeGreaterThanOrEqual(0);
    expect(t.log.indexOf('clock.start')).toBeLessThan(t.log.indexOf('engine.start'));

    expect(t.createEngine).toHaveBeenCalledTimes(1);
    const [adapter, transport, serverClock, opts] = t.createEngine.mock.calls[0];
    expect(adapter).toBe(t.adapter);
    expect(transport).toBe(t.transport);
    expect(serverClock).toBe(t.clockSync);
    expect(opts.selfId).toBe(GUEST_ID);
    expect(opts.getHostId()).toBe(HOST_ID);
    expect(opts.getMode()).toBe('everyone');
    expect(t.engine.start).toHaveBeenCalledWith(STATE);

    expect(nicknames()).toEqual(['Alice', 'Bob']);
  });

  it('controller_routes_chat_and_mode', async () => {
    const t = setup();
    await t.controller.start();
    await t.session.join(INVITE, 'Bob');

    const input = shadow().querySelector<HTMLInputElement>('.chat-input')!;
    input.value = '  hello  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(t.transport.sent).toContainEqual({ v: 1, type: 'chat', text: 'hello' });

    t.transport.emit({
      v: 1,
      type: 'chat',
      message: { id: 'CCCCCCCCCCCCCCCC', participantId: GUEST_ID, nickname: 'Bob', text: 'hello', sentAtServerMs: 5 },
    });
    expect(Array.from(shadow().querySelectorAll('.chat-text'), (n) => n.textContent)).toEqual(['hello']);

    t.transport.emit({ v: 1, type: 'mode', mode: 'host_only', changedBy: HOST_ID });
    expect(shadow().querySelector('.mode-label')!.textContent).toBe('Control: host only');
    // The guest does not see the switch.
    expect(shadow().querySelector<HTMLElement>('.mode-switch')!.hidden).toBe(true);
    const opts = t.createEngine.mock.calls[0][3];
    expect(opts.getMode()).toBe('host_only');

    // Guest promoted to host: switch shown and set_mode routed to the server.
    t.transport.emit({ v: 1, type: 'participants', hostId: GUEST_ID, participants: [participant(GUEST_ID, 'Bob', true, 2000)] });
    expect(opts.getHostId()).toBe(GUEST_ID);
    expect(shadow().querySelector<HTMLElement>('.mode-switch')!.hidden).toBe(false);
    const checkbox = shadow().querySelector<HTMLInputElement>('.mode-switch input')!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    expect(t.transport.sent).toContainEqual({ v: 1, type: 'set_mode', mode: 'everyone' });
  });

  it('controller_stop_tears_down', async () => {
    const t = setup();
    await t.controller.start();
    await t.session.join(INVITE, 'Bob');
    expect(document.querySelector('test01-sidebar')).not.toBeNull();

    t.controller.stop();

    expect(t.engine.stop).toHaveBeenCalledTimes(1);
    expect(t.clockSync.stop).toHaveBeenCalledTimes(1);
    expect(t.log.indexOf('engine.stop')).toBeLessThan(t.log.indexOf('clock.stop'));
    expect(document.querySelector('test01-sidebar')).toBeNull();
  });
});
