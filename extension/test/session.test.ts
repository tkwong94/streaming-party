import { describe, expect, it } from 'vitest';
import {
  parseInviteUrl,
  type ClientMessage,
  type CreatedMessage,
  type InviteLink,
  type JoinedMessage,
  type ParticipantWire,
  type PlaybackStateWire,
  type ServerMessage,
} from '@test01/protocol';
import { PartySession } from '../src/content/session.js';
import type { WsTransport } from '../src/transport/ws-transport.js';

const SERVER_URL = 'ws://127.0.0.1:8787/ws';
const TITLE = 'https://www.youtube.com/watch?v=abc';
const ROOM_ID = 'R'.repeat(22);
const SECRET = 'S'.repeat(43);
const HOST_ID = 'H'.repeat(22);
const GUEST_ID = 'G'.repeat(22);

const STATE: PlaybackStateWire = {
  playing: false,
  positionSec: 0,
  updatedAtServerMs: 1000,
  seq: 0,
  updatedBy: HOST_ID,
  hostBuffering: false,
};

function participant(id: string, nickname: string, isHost: boolean, joinedAtServerMs: number): ParticipantWire {
  return { id, nickname, isHost, joinedAtServerMs };
}

/** Records sent messages and replies asynchronously, like a socket would. */
class FakeTransport implements WsTransport {
  readonly sent: ClientMessage[] = [];
  closed = false;
  private readonly messageCbs = new Set<(m: ServerMessage) => void>();
  private readonly closeCbs = new Set<(code: number) => void>();

  constructor(private readonly reply: (msg: ClientMessage) => ServerMessage[] = () => []) {}

  send(msg: ClientMessage): void {
    this.sent.push(msg);
    const replies = this.reply(msg);
    queueMicrotask(() => replies.forEach((m) => this.emit(m)));
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

  emitClose(code: number): void {
    for (const cb of [...this.closeCbs]) cb(code);
  }
}

const INVITE: InviteLink = { v: 1, s: SERVER_URL, r: ROOM_ID, k: SECRET, titleUrl: TITLE };

function joinedMessage(): JoinedMessage {
  return {
    v: 1,
    type: 'joined',
    roomId: ROOM_ID,
    selfId: GUEST_ID,
    hostId: HOST_ID,
    mode: 'host_only',
    participants: [participant(HOST_ID, 'Alice', true, 1000), participant(GUEST_ID, 'Bob', false, 2000)],
    state: STATE,
  };
}

describe('PartySession', () => {
  it('session_create_builds_invite', async () => {
    const created: CreatedMessage = {
      v: 1,
      type: 'created',
      roomId: ROOM_ID,
      secret: SECRET,
      selfId: HOST_ID,
      hostId: HOST_ID,
      mode: 'everyone',
      participants: [participant(HOST_ID, 'Alice', true, 1000)],
      state: STATE,
    };
    const transport = new FakeTransport((msg) => (msg.type === 'create' ? [created] : []));
    const connectedTo: string[] = [];
    const session = new PartySession(async (url) => {
      connectedTo.push(url);
      return transport;
    });

    const { inviteUrl } = await session.create(SERVER_URL, 'Alice', `${TITLE}#t=5`, 'youtube');

    expect(connectedTo).toEqual([SERVER_URL]);
    expect(transport.sent).toEqual([{ v: 1, type: 'create', nickname: 'Alice', site: 'youtube', titleUrl: TITLE }]);
    expect(parseInviteUrl(inviteUrl)).toEqual({ v: 1, s: SERVER_URL, r: created.roomId, k: created.secret, titleUrl: TITLE });
    expect(session.selfId).toBe(HOST_ID);
    expect(session.hostId).toBe(HOST_ID);
    expect(session.mode).toBe('everyone');
    expect(session.inParty).toBe(true);
    expect(session.transport).toBe(transport);
  });

  it('session_join_sends_join_and_emits_participants', async () => {
    const joined = joinedMessage();
    const transport = new FakeTransport((msg) => (msg.type === 'join' ? [joined] : []));
    const connectedTo: string[] = [];
    const session = new PartySession(async (url) => {
      connectedTo.push(url);
      return transport;
    });
    const seen: unknown[] = [];
    session.on('participants', (p) => seen.push(p));

    await session.join(INVITE, 'Bob');

    expect(connectedTo).toEqual([SERVER_URL]);
    expect(transport.sent).toEqual([{ type: 'join', v: 1, roomId: ROOM_ID, secret: SECRET, nickname: 'Bob' }]);
    expect(seen).toEqual([{ hostId: HOST_ID, participants: joined.participants }]);
    expect(session.selfId).toBe(GUEST_ID);
    expect(session.hostId).toBe(HOST_ID);
    expect(session.mode).toBe('host_only');

    // Later broadcasts (host left, Bob promoted) keep flowing to subscribers.
    const promoted = [participant(GUEST_ID, 'Bob', true, 2000)];
    transport.emit({ v: 1, type: 'participants', hostId: GUEST_ID, participants: promoted });
    expect(seen).toEqual([
      { hostId: HOST_ID, participants: joined.participants },
      { hostId: GUEST_ID, participants: promoted },
    ]);
    expect(session.hostId).toBe(GUEST_ID);
  });

  it('session_surfaces_join_errors', async () => {
    for (const code of ['JOIN_DENIED', 'ROOM_FULL'] as const) {
      const transport = new FakeTransport((msg) =>
        msg.type === 'join' ? [{ v: 1, type: 'error', code, message: 'rejected', inReplyTo: 'join' }] : [],
      );
      const session = new PartySession(async () => transport);

      await expect(session.join(INVITE, 'Bob')).rejects.toMatchObject({ code });
      expect(transport.closed).toBe(true);
      expect(session.inParty).toBe(false);
      expect(session.selfId).toBeNull();
    }
  });

  it('session_surfaces_connect_failure', async () => {
    const session = new PartySession(async () => {
      throw Object.assign(new Error('refused'), { code: 'CONNECT_FAILED' });
    });
    await expect(session.join(INVITE, 'Bob')).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
    await expect(session.create('https://not-ws.example/', 'Bob', TITLE, 'youtube')).rejects.toMatchObject({
      code: 'CONNECT_FAILED',
    });
    expect(session.inParty).toBe(false);
  });

  it('session_emits_events_and_closed', async () => {
    const transport = new FakeTransport((msg) => (msg.type === 'join' ? [joinedMessage()] : []));
    const session = new PartySession(async () => transport);
    const events: [string, unknown][] = [];
    for (const name of ['state', 'mode', 'chat', 'error', 'closed'] as const) {
      session.on(name, (payload: unknown) => events.push([name, payload]));
    }
    await session.join(INVITE, 'Bob');

    const next = { ...STATE, playing: true, seq: 1 };
    transport.emit({ v: 1, type: 'state', cause: 'control', state: next });
    transport.emit({ v: 1, type: 'mode', mode: 'everyone', changedBy: HOST_ID });
    transport.emit({ v: 1, type: 'error', code: 'RATE_LIMITED', message: 'slow down', inReplyTo: 'chat' });
    expect(session.mode).toBe('everyone');
    transport.emitClose(1006);

    expect(events).toEqual([
      ['state', { cause: 'initial', state: STATE }],
      ['state', { cause: 'control', state: next }],
      ['mode', { mode: 'everyone', changedBy: HOST_ID }],
      ['error', { code: 'RATE_LIMITED', message: 'slow down', inReplyTo: 'chat' }],
      ['closed', { code: 1006 }],
    ]);
    expect(session.mode).toBeNull();
    expect(session.inParty).toBe(false);
  });

  it('session_leave_sends_leave_and_closes', async () => {
    const transport = new FakeTransport((msg) => (msg.type === 'join' ? [joinedMessage()] : []));
    const session = new PartySession(async () => transport);
    await session.join(INVITE, 'Bob');

    session.leave();

    expect(transport.sent.at(-1)).toEqual({ v: 1, type: 'leave' });
    expect(transport.closed).toBe(true);
    expect(session.inParty).toBe(false);
    expect(session.transport).toBeNull();
  });
});
