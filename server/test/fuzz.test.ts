import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, parseServerMessage } from '@test01/protocol';
import type { SyncServerHandle } from '../src/index.js';
import { TestClient, createMessage, createRoom, delay, joinRoom, startServer } from './helpers.js';

const FUZZ_SEED = 0x7e570114;
const FUZZ_MESSAGES = 500;
const FUZZ_SOCKETS = 3;

/** Small deterministic PRNG so a failing fuzz run can be replayed from FUZZ_SEED. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const int = (rng: Rng, max: number) => Math.floor(rng() * max);

const WEIRD_VALUES: unknown[] = [
  null,
  true,
  false,
  0,
  -1,
  1.5,
  86401,
  -86400,
  1e308,
  -1e308,
  Number.MAX_SAFE_INTEGER + 2,
  '',
  ' ',
  '\u0000',
  '‮\u0007',
  'NaN',
  'Infinity',
  '<img src=x onerror=alert(1)>',
  'x'.repeat(600),
  '9'.repeat(400),
  '\ud800',
  [],
  [1, 2, 3],
  {},
  { nested: { deep: [true] } },
];

const FIELD_NAMES = ['v', 'type', 'text', 'nickname', 'roomId', 'secret', 'positionSec', 'clientSeq', 'action', 'mode', 'extra', 'constructor', 'toString'];

function validMessages(roomId: string, secret: string): Record<string, unknown>[] {
  return [
    { ...createMessage('Fuzz host') },
    { v: 1, type: 'join', roomId, secret, nickname: 'Fuzz guest' },
    { v: 1, type: 'leave' },
    { v: 1, type: 'control', action: 'play', positionSec: 12.5, clientSeq: 1 },
    { v: 1, type: 'control', action: 'pause', positionSec: 30, clientSeq: 2 },
    { v: 1, type: 'control', action: 'seek', positionSec: 95.5, clientSeq: 3 },
    { v: 1, type: 'position_report', positionSec: 40, playing: true, buffering: false },
    { v: 1, type: 'set_mode', mode: 'host_only' },
    { v: 1, type: 'chat', text: 'hello fuzz' },
    { v: 1, type: 'ping', clientSentMs: 1_800_000_000_000 },
  ];
}

/** One seeded mutation of a valid message: a string (text frame) or a Buffer (binary frame). */
function mutate(rng: Rng, templates: Record<string, unknown>[]): string | Buffer {
  const message: Record<string, unknown> = structuredClone(pick(rng, templates));
  const keys = Object.keys(message);
  switch (int(rng, 11)) {
    case 0: // unchanged valid message
      return JSON.stringify(message);
    case 1: // drop a field
      delete message[pick(rng, keys)];
      return JSON.stringify(message);
    case 2: // wrong type / out-of-range value
      message[pick(rng, keys)] = pick(rng, WEIRD_VALUES);
      return JSON.stringify(message);
    case 3: // unknown extra field
      message[pick(rng, FIELD_NAMES) + (rng() < 0.5 ? '' : String(int(rng, 100)))] = pick(rng, WEIRD_VALUES);
      return JSON.stringify(message);
    case 4: // unknown or non-string type
      message.type = pick(rng, ['created', 'error', 'state', 'JOIN', 'chat ', '', 42, null, ['chat']]);
      return JSON.stringify(message);
    case 5: // wrong or missing version
      if (rng() < 0.2) delete message.v;
      else message.v = pick(rng, [0, 2, '1', 1.0000001, null, -1, [1]]);
      return JSON.stringify(message);
    case 6: {
      // truncated JSON
      const json = JSON.stringify(message);
      return json.slice(0, int(rng, json.length));
    }
    case 7: {
      // one character replaced
      const json = JSON.stringify(message);
      const at = int(rng, json.length);
      return json.slice(0, at) + pick(rng, ['"', '{', '}', ',', ':', '\\', '0', ' ', '\u0000']) + json.slice(at + 1);
    }
    case 8: // random binary frame
      return Buffer.from(Array.from({ length: 1 + int(rng, 64) }, () => int(rng, 256)));
    case 9: {
      // prototype-pollution keys and duplicate keys, only expressible as raw JSON text
      const json = JSON.stringify(message);
      const inject = pick(rng, ['"__proto__":{"polluted":true}', '"constructor":{"prototype":{"polluted":true}}', '"type":"chat"', '"v":2']);
      return `{${inject},${json.slice(1)}`;
    }
    default: // valid JSON that is not an object
      return pick(rng, ['null', '[]', `[${JSON.stringify(message)}]`, '42', '"chat"', 'true']);
  }
}

const healthz = (handle: SyncServerHandle) => fetch(`http://127.0.0.1:${handle.port}/healthz`);

describe('malformed input and fuzzing (R9)', () => {
  let handle: SyncServerHandle;
  let clients: TestClient[];
  const track = (client: TestClient) => (clients.push(client), client);

  beforeEach(async () => {
    handle = await startServer();
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await handle.close();
    // Whatever the input, the server only ever sends valid protocol messages.
    for (const client of clients) expect(client.invalid).toEqual([]);
  });

  it('malformed_frames_do_not_crash', async () => {
    const client = track(await TestClient.connect(handle.wsUrl));
    const deepObject = '{"a":'.repeat(650) + '1' + '}'.repeat(650);
    expect(Buffer.byteLength(deepObject)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);

    client.send('this is {not json');
    client.ws.send(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]), { binary: true });
    client.send('null');
    client.send('[{"v":1,"type":"ping","clientSentMs":1}]');
    client.send(deepObject);

    await client.waitFor('error', () => client.messages.filter((m) => m.type === 'error').length === 5);
    await delay(50);
    const errors = client.messages.filter((m) => m.type === 'error');
    expect(errors).toHaveLength(5);
    for (const error of errors) {
      expect(error.type === 'error' && error.code).toBe('BAD_MESSAGE');
      expect(error.type === 'error' && error.inReplyTo).toBeUndefined();
    }
    expect(client.isOpen).toBe(true);

    const response = await healthz(handle);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, protocol: 1 });
  });

  it('oversize_frame_closed_1009', async () => {
    const { client: host, created } = await createRoom(handle);
    track(host);
    const { client: guest } = await joinRoom(handle, created.roomId, created.secret, 'Guest');
    track(guest);
    await host.waitFor('participants', (m) => m.participants.length === 2);

    // A syntactically valid chat frame padded to exactly 5000 bytes.
    const prefix = '{"v":1,"type":"chat","text":"';
    const suffix = '"}';
    const frame = prefix + 'a'.repeat(5000 - prefix.length - suffix.length) + suffix;
    expect(Buffer.byteLength(frame)).toBe(5000);
    guest.send(frame);

    expect((await guest.closed).code).toBe(1009);
    // The rest of the room is unaffected and sees the guest removed.
    await host.waitFor('participants', (m) => m.participants.length === 1);
    expect(host.isOpen).toBe(true);
    expect(host.messages.filter((m) => m.type === 'chat')).toEqual([]);
    expect((await healthz(handle)).status).toBe(200);
  });

  it('fuzz_500_random_messages', async () => {
    const rng = mulberry32(FUZZ_SEED);
    // A silent observer keeps the room alive while fuzzing sockets get closed (4001/4008/1009/leave).
    const { client: observer, created } = await createRoom(handle, 'Observer');
    track(observer);
    const templates = validMessages(created.roomId, created.secret);

    const openLane = async (): Promise<TestClient> => {
      const client = track(await TestClient.connect(handle.wsUrl));
      client.send({ v: 1, type: 'join', roomId: created.roomId, secret: created.secret, nickname: 'Fuzzer' });
      await Promise.race([client.waitFor('joined', () => true, { timeoutMs: 1000 }).catch(() => undefined), client.closed]);
      return client;
    };

    const lanes: TestClient[] = [];
    for (let i = 0; i < FUZZ_SOCKETS; i++) lanes.push(await openLane());
    let sent = 0;
    let reopened = 0;
    for (let i = 0; i < FUZZ_MESSAGES; i++) {
      const lane = i % FUZZ_SOCKETS;
      if (!lanes[lane]!.isOpen) {
        lanes[lane] = await openLane();
        reopened++;
      }
      const frame = mutate(rng, templates);
      try {
        if (typeof frame === 'string') lanes[lane]!.send(frame);
        else lanes[lane]!.ws.send(frame, { binary: true });
        sent++;
      } catch {
        // Socket closed between the check and the send; the next frame reopens the lane.
      }
      if (i % 25 === 24) await delay(5);
    }
    await delay(300);
    console.info(`[T14 fuzz] seed=0x${FUZZ_SEED.toString(16)} sent=${sent} lanes_reopened=${reopened}`);

    expect(sent).toBeGreaterThanOrEqual(FUZZ_MESSAGES - 10);

    // Server still alive: health check and a fresh round trip.
    const response = await healthz(handle);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, protocol: 1 });
    const prober = track(await TestClient.connect(handle.wsUrl));
    prober.send({ v: 1, type: 'ping', clientSentMs: 1 });
    expect((await prober.waitFor('pong')).clientSentMs).toBe(1);

    // The existing room survives with a valid state.
    expect(observer.isOpen).toBe(true);
    const room = handle.registry.get(created.roomId);
    expect(room).toBeDefined();
    expect(room!.participants.has(created.selfId)).toBe(true);
    const stateFrame = JSON.stringify({ v: 1, type: 'state', cause: 'control', state: room!.state });
    expect(parseServerMessage(stateFrame)).toMatchObject({ ok: true });
    const participantsFrame = JSON.stringify({
      v: 1,
      type: 'participants',
      hostId: room!.hostParticipantId,
      participants: handle.registry.participantsWire(room!),
    });
    expect(parseServerMessage(participantsFrame)).toMatchObject({ ok: true });
    const { client: late, joined } = await joinRoom(handle, created.roomId, created.secret, 'Late');
    track(late);
    expect(joined.roomId).toBe(created.roomId);

    // No prototype pollution from __proto__ / constructor keys.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  }, 60_000);
});
