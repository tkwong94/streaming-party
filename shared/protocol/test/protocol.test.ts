import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  MAX_MESSAGE_BYTES,
  buildInviteUrl,
  parseClientMessage,
  parseInviteUrl,
  parseServerMessage,
  type ClientMessage,
  type InviteLink,
  type ParticipantWire,
  type PlaybackStateWire,
  type ServerMessage,
} from '../src/index.js';

const ROOM_ID = randomBytes(16).toString('base64url');
const SECRET = randomBytes(32).toString('base64url');
const HOST_ID = randomBytes(16).toString('base64url');
const GUEST_ID = randomBytes(16).toString('base64url');

const STATE: PlaybackStateWire = {
  playing: true,
  positionSec: 42.5,
  updatedAtServerMs: 1792934000000,
  seq: 3,
  updatedBy: HOST_ID,
  hostBuffering: false,
};

const PARTICIPANTS: ParticipantWire[] = [
  { id: HOST_ID, nickname: 'Host', isHost: true, joinedAtServerMs: 1792933000000 },
  { id: GUEST_ID, nickname: 'Guest 1', isHost: false, joinedAtServerMs: 1792933100000 },
];

const CREATE: ClientMessage = {
  v: 1,
  type: 'create',
  nickname: 'Alice',
  site: 'youtube',
  titleUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
};
const JOIN: ClientMessage = { v: 1, type: 'join', roomId: ROOM_ID, secret: SECRET, nickname: 'Bob' };
const LEAVE: ClientMessage = { v: 1, type: 'leave' };
const CONTROL: ClientMessage = { v: 1, type: 'control', action: 'seek', positionSec: 95.5, clientSeq: 7 };
const POSITION_REPORT: ClientMessage = {
  v: 1,
  type: 'position_report',
  positionSec: 12.25,
  playing: true,
  buffering: false,
};
const SET_MODE: ClientMessage = { v: 1, type: 'set_mode', mode: 'host_only' };
const CHAT: ClientMessage = { v: 1, type: 'chat', text: 'hello <img src=x onerror=alert(1)>' };
const PING: ClientMessage = { v: 1, type: 'ping', clientSentMs: 1792934000123 };

const CLIENT_SAMPLES: ClientMessage[] = [CREATE, JOIN, LEAVE, CONTROL, POSITION_REPORT, SET_MODE, CHAT, PING];

const SERVER_SAMPLES: ServerMessage[] = [
  {
    v: 1,
    type: 'created',
    roomId: ROOM_ID,
    secret: SECRET,
    selfId: HOST_ID,
    hostId: HOST_ID,
    mode: 'everyone',
    participants: [PARTICIPANTS[0]!],
    state: { ...STATE, playing: false, positionSec: 0, seq: 0 },
  },
  {
    v: 1,
    type: 'joined',
    roomId: ROOM_ID,
    selfId: GUEST_ID,
    hostId: HOST_ID,
    mode: 'host_only',
    participants: PARTICIPANTS,
    state: STATE,
  },
  { v: 1, type: 'state', cause: 'control', state: STATE },
  { v: 1, type: 'participants', hostId: HOST_ID, participants: PARTICIPANTS },
  { v: 1, type: 'mode', mode: 'host_only', changedBy: HOST_ID },
  {
    v: 1,
    type: 'chat',
    message: {
      id: randomBytes(12).toString('base64url'),
      participantId: GUEST_ID,
      nickname: 'Guest 1',
      text: 'hi',
      sentAtServerMs: 1792934000500,
    },
  },
  { v: 1, type: 'pong', clientSentMs: 1792934000123, serverMs: 1792934000200 },
  { v: 1, type: 'error', code: 'FORBIDDEN_CONTROL', message: 'Only the host can control playback', inReplyTo: 'control' },
];

function expectClientRejected(msg: unknown, code: 'BAD_MESSAGE' | 'UNSUPPORTED_VERSION' = 'BAD_MESSAGE') {
  const result = parseClientMessage(JSON.stringify(msg));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

function encodePayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function readJson(relativeToRepoRoot: string): any {
  return JSON.parse(readFileSync(new URL(`../../../${relativeToRepoRoot}`, import.meta.url), 'utf8'));
}

describe('message validator', () => {
  it('accepts_every_valid_client_message', () => {
    expect(CLIENT_SAMPLES.map((m) => m.type).sort()).toEqual(
      ['chat', 'control', 'create', 'join', 'leave', 'ping', 'position_report', 'set_mode'],
    );
    for (const msg of CLIENT_SAMPLES) {
      expect(parseClientMessage(JSON.stringify(msg))).toEqual({ ok: true, value: msg });
    }
  });

  it('accepts_every_valid_server_message', () => {
    expect(SERVER_SAMPLES.map((m) => m.type).sort()).toEqual(
      ['chat', 'created', 'error', 'joined', 'mode', 'participants', 'pong', 'state'],
    );
    for (const msg of SERVER_SAMPLES) {
      expect(parseServerMessage(JSON.stringify(msg))).toEqual({ ok: true, value: msg });
    }
  });

  it('rejects_unknown_type_and_extra_fields', () => {
    expectClientRejected({ v: 1, type: 'nuke' });
    expectClientRejected({ ...CHAT, x: 1 });
    // A server-only type is not a valid client message.
    expectClientRejected({ v: 1, type: 'pong', clientSentMs: 1, serverMs: 2 });
    // Extra fields are rejected inside nested server objects too.
    const result = parseServerMessage(JSON.stringify({ v: 1, type: 'state', cause: 'control', state: { ...STATE, x: 1 } }));
    expect(result.ok).toBe(false);
  });

  it('rejects_wrong_version', () => {
    expectClientRejected({ ...CHAT, v: 2 }, 'UNSUPPORTED_VERSION');
    const { v: _v, ...noVersion } = CHAT;
    expectClientRejected(noVersion, 'BAD_MESSAGE');
    expectClientRejected({ ...CHAT, v: '1' }, 'BAD_MESSAGE');
  });

  it('rejects_non_json_and_oversize', () => {
    expect(parseClientMessage('{')).toMatchObject({ ok: false, code: 'BAD_MESSAGE' });
    expect(parseClientMessage('[1,2]')).toMatchObject({ ok: false, code: 'BAD_MESSAGE' });

    const oversize = parseClientMessage('x'.repeat(MAX_MESSAGE_BYTES + 1));
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) {
      expect(oversize.code).toBe('BAD_MESSAGE');
      expect(oversize.reason).toContain('too large');
    }

    // Size is measured in UTF-8 bytes, not UTF-16 code units: 2049 x 'é' = 4098 bytes.
    const multiByte = parseClientMessage('é'.repeat(2049));
    expect(multiByte.ok).toBe(false);
    if (!multiByte.ok) expect(multiByte.reason).toContain('too large');

    // A well-formed message padded with JSON whitespace: 4096 bytes passes, 4097 does not.
    const json = JSON.stringify(CHAT);
    expect(parseClientMessage(json + ' '.repeat(MAX_MESSAGE_BYTES - json.length)).ok).toBe(true);
    const padded = parseClientMessage(json + ' '.repeat(MAX_MESSAGE_BYTES + 1 - json.length));
    expect(padded.ok).toBe(false);
    if (!padded.ok) expect(padded.reason).toContain('too large');
  });

  it('rejects_out_of_range_fields', () => {
    expectClientRejected({ ...JOIN, nickname: '' });
    expectClientRejected({ ...JOIN, nickname: '   ' });
    expectClientRejected({ ...JOIN, nickname: 'a'.repeat(33) });
    expect(parseClientMessage(JSON.stringify({ ...JOIN, nickname: 'a'.repeat(32) })).ok).toBe(true);
    expectClientRejected({ ...JOIN, nickname: 'bell\u0007' });
    expectClientRejected({ ...CREATE, nickname: 'tab\there' });

    expectClientRejected({ ...CHAT, text: 'a'.repeat(501) });
    expectClientRejected({ ...CHAT, text: '     ' });
    expect(parseClientMessage(JSON.stringify({ ...CHAT, text: 'a'.repeat(500) })).ok).toBe(true);

    for (const positionSec of [-1, Number.NaN, 86401]) {
      // JSON.stringify turns NaN into null, which is not a number.
      expectClientRejected({ ...CONTROL, positionSec });
      expectClientRejected({ ...POSITION_REPORT, positionSec });
    }
    expect(parseClientMessage(JSON.stringify({ ...CONTROL, positionSec: 86400 })).ok).toBe(true);
    expectClientRejected({ ...CONTROL, clientSeq: -1 });
    expectClientRejected({ ...CONTROL, clientSeq: 1.5 });
    expectClientRejected({ ...CONTROL, action: 'rewind' });

    expectClientRejected({ ...JOIN, roomId: ROOM_ID.slice(1) });
    expectClientRejected({ ...JOIN, secret: SECRET.slice(1) });
    expectClientRejected({ ...SET_MODE, mode: 'anarchy' });
    expectClientRejected({ ...CREATE, site: 'disney' });
    expectClientRejected({ ...CREATE, titleUrl: 'https://www.youtube.com/' + 'a'.repeat(2048) });
  });

  it('create_title_url_scheme', () => {
    expectClientRejected({ ...CREATE, titleUrl: 'http://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expectClientRejected({ ...CREATE, titleUrl: 'javascript:alert(1)' });
    expectClientRejected({ ...CREATE, titleUrl: 'not a url' });
    // The local fixture page is served over plain http on loopback.
    expect(
      parseClientMessage(JSON.stringify({ ...CREATE, site: 'fixture', titleUrl: 'http://127.0.0.1:5173/fixture.html' })).ok,
    ).toBe(true);
  });
});

describe('invite links', () => {
  const youtube: InviteLink = {
    v: 1,
    s: 'wss://quiet-river-1234.trycloudflare.com/ws',
    r: ROOM_ID,
    k: SECRET,
    titleUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  };
  const netflix: InviteLink = {
    v: 1,
    s: 'ws://192.168.1.20:8787/ws',
    r: ROOM_ID,
    k: SECRET,
    titleUrl: 'https://www.netflix.com/watch/80100172?trackId=14170286',
  };

  it('invite_roundtrip', () => {
    for (const invite of [youtube, netflix]) {
      const url = buildInviteUrl(invite);
      expect(url.startsWith(`${invite.titleUrl}#test01=`)).toBe(true);
      expect(parseInviteUrl(url)).toEqual(invite);
    }

    const withFragment = buildInviteUrl({ ...youtube, titleUrl: `${youtube.titleUrl}#t=10` });
    expect(withFragment.split('#')).toHaveLength(2);
    expect(withFragment).not.toContain('#t=10');
    expect(parseInviteUrl(withFragment)).toEqual(youtube);
  });

  it('invite_rejects_bad_payloads', () => {
    const base = youtube.titleUrl;
    const good = { v: 1, s: youtube.s, r: youtube.r, k: youtube.k };

    expect(parseInviteUrl(`${base}#test01=${encodePayload({ ...good, s: 'http://x' })}`)).toBeNull();
    expect(parseInviteUrl(`${base}#test01=${encodePayload({ ...good, v: 2 })}`)).toBeNull();
    expect(parseInviteUrl(`${base}#test01=${encodePayload({ ...good, r: 'short' })}`)).toBeNull();
    expect(parseInviteUrl(`${base}#test01=${encodePayload({ ...good, extra: true })}`)).toBeNull();

    const payload = buildInviteUrl(youtube).split('#test01=')[1]!;
    expect(parseInviteUrl(`${base}#test01=A${payload.slice(1)}`)).toBeNull();
    expect(parseInviteUrl(`${base}#test01=${payload.slice(0, -5)}`)).toBeNull();
    expect(parseInviteUrl(`${base}#test01=${payload}*`)).toBeNull();

    expect(parseInviteUrl(base)).toBeNull();
    expect(parseInviteUrl(`${base}#other=${payload}`)).toBeNull();
    expect(parseInviteUrl(`${base}#test01=`)).toBeNull();

    expect(() => buildInviteUrl({ ...youtube, s: 'http://x' })).toThrow(TypeError);
  });
});

describe('contracts', () => {
  it('adapter_error_carries_code', () => {
    const error = new AdapterError('NETFLIX_BRIDGE_TIMEOUT');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.code).toBe('NETFLIX_BRIDGE_TIMEOUT');
    expect(error.name).toBe('AdapterError');
    expect(new AdapterError('MEDIA_PLAY_REJECTED', 'autoplay blocked').message).toBe('autoplay blocked');
  });
});

describe('workspace layout', () => {
  it('root_workspace_scripts_declared', () => {
    const root = readJson('package.json');
    expect(root.private).toBe(true);
    expect(root.workspaces).toEqual(['shared/protocol', 'server', 'extension', 'e2e']);
    expect(root.scripts['env:check']).toBe('node scripts/env-check.mjs');
    expect(root.scripts['env:reset']).toBe('node scripts/env-reset.mjs');
    expect(root.scripts.test).toBe('npm test --workspaces --if-present');
    expect(root.scripts['test:e2e']).toBe('npm test -w e2e');

    const e2e = readJson('e2e/package.json');
    expect(e2e.name).toBe('@test01/e2e');
    expect(e2e.scripts.test).toBe('playwright test');

    const extension = readJson('extension/package.json');
    expect(extension.name).toBe('@test01/extension');
    for (const script of ['build', 'build:test', 'build:adapter-smoke', 'test']) {
      expect(extension.scripts).toHaveProperty([script]);
    }

    const server = readJson('server/package.json');
    expect(server.name).toBe('@test01/server');
    for (const script of ['build', 'test']) {
      expect(server.scripts).toHaveProperty([script]);
    }

    const protocol = readJson('shared/protocol/package.json');
    expect(protocol.name).toBe('@test01/protocol');
    expect(protocol.scripts.test).toBe('vitest run');
  });
});
