// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientMessage,
  Clock,
  CreatedMessage,
  PlaybackStateWire,
  PlayerAdapter,
  ServerMessage,
  SyncTransport,
} from '@test01/protocol';
import { DISCONNECTED_STATUS, PartyController } from '../src/content/party-controller.js';
import { PartySession, SessionError, type SessionEventMap } from '../src/content/session.js';
import { createPortTransport, PORT_CONNECT_TIMEOUT_MS } from '../src/transport/port-transport.js';
import type { ClockSync } from '../src/sync/clock.js';
import type { SyncEngine, SyncEngineOptions } from '../src/sync/engine.js';
import { FakeAdapter } from './sync/fake-adapter.js';

const SERVER_URL = 'ws://127.0.0.1:8787/ws';
const TITLE = 'https://www.youtube.com/watch?v=abc';
const ROOM_ID = 'R'.repeat(22);
const SECRET = 'S'.repeat(43);
const HOST_ID = 'H'.repeat(22);
const CODES = ['CONNECT_REJECTED', 'CONNECT_REFUSED', 'CONNECT_TIMEOUT', 'BAD_SERVER_URL'] as const;

const STATE: PlaybackStateWire = {
  playing: false,
  positionSec: 0,
  updatedAtServerMs: 1000,
  seq: 0,
  updatedBy: HOST_ID,
  hostBuffering: false,
};

const CREATED: CreatedMessage = {
  v: 1,
  type: 'created',
  roomId: ROOM_ID,
  secret: SECRET,
  selfId: HOST_ID,
  hostId: HOST_ID,
  mode: 'everyone',
  participants: [{ id: HOST_ID, nickname: 'Alice', isHost: true, joinedAtServerMs: 1000 }],
  state: STATE,
};

const PONG: ServerMessage = { v: 1, type: 'pong', clientSentMs: 42, serverMs: 1234 };

class FakeEvent<A extends unknown[]> {
  private readonly cbs = new Set<(...args: A) => void>();

  addListener(cb: (...args: A) => void): void {
    this.cbs.add(cb);
  }

  removeListener(cb: (...args: A) => void): void {
    this.cbs.delete(cb);
  }

  fire(...args: A): void {
    for (const cb of [...this.cbs]) cb(...args);
  }
}

/** Content-script end of a runtime port; the test plays the service worker. */
class FakePort {
  readonly posted: unknown[] = [];
  disconnected = false;
  readonly onMessage = new FakeEvent<[unknown, FakePort]>();
  readonly onDisconnect = new FakeEvent<[FakePort]>();

  constructor(readonly name: string) {}

  postMessage(msg: unknown): void {
    if (this.disconnected) throw new Error('Attempting to use a disconnected port object');
    this.posted.push(msg);
  }

  /** Like chrome: a local disconnect() does not fire this end's onDisconnect. */
  disconnect(): void {
    this.disconnected = true;
  }

  fromWorker(msg: unknown): void {
    if (!this.disconnected) this.onMessage.fire(msg, this);
  }

  /** The service worker disconnected the port or was terminated. */
  workerDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.fire(this);
  }
}

function fakeRuntime() {
  const ports: FakePort[] = [];
  const connect = vi.fn((info?: { name?: string }) => {
    const port = new FakePort(info?.name ?? '');
    ports.push(port);
    return port;
  });
  return { runtime: { connect } as unknown as typeof chrome.runtime, connect, ports };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

function keepalives(port: FakePort): number {
  return port.posted.filter((m) => (m as { t?: string }).t === 'keepalive').length;
}

async function openTransport(runtime: typeof chrome.runtime, ports: FakePort[]) {
  const pending = createPortTransport(SERVER_URL, PORT_CONNECT_TIMEOUT_MS, runtime);
  const port = ports.at(-1)!;
  port.fromWorker({ t: 'open' });
  return { transport: await pending, port };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('createPortTransport', () => {
  it('port_transport_resolves_on_open', async () => {
    const { runtime, connect, ports } = fakeRuntime();
    let resolved = false;
    const pending = createPortTransport(SERVER_URL, PORT_CONNECT_TIMEOUT_MS, runtime).then((t) => {
      resolved = true;
      return t;
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({ name: 'test01/transport' });
    const port = ports[0]!;
    expect(port.posted).toEqual([{ t: 'connect', url: SERVER_URL }]);
    await flush();
    expect(resolved).toBe(false);

    port.fromWorker({ t: 'open' });
    const transport = await pending;
    expect(resolved).toBe(true);

    const msg: ClientMessage = { v: 1, type: 'ping', clientSentMs: 42 };
    transport.send(msg);
    expect(port.posted.at(-1)).toEqual({ t: 'send', frame: JSON.stringify(msg) });

    await vi.advanceTimersByTimeAsync(19_999);
    expect(keepalives(port)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(port.posted.at(-1)).toEqual({ t: 'keepalive' });
    expect(keepalives(port)).toBe(1);

    transport.close();
    expect(port.disconnected).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(keepalives(port)).toBe(1);
  });

  it('port_transport_rejects_with_sw_code', async () => {
    for (const code of CODES) {
      const { runtime, ports } = fakeRuntime();
      const outcome = createPortTransport(SERVER_URL, PORT_CONNECT_TIMEOUT_MS, runtime).catch((e: unknown) => e);
      const port = ports[0]!;
      port.fromWorker({ t: 'error', code });
      port.workerDisconnect();

      const err = await outcome;
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe(code);
      expect(port.disconnected).toBe(true);

      // PartySession rethrows the service-worker code unchanged.
      const session = new PartySession((url) => createPortTransport(url, PORT_CONNECT_TIMEOUT_MS, runtime));
      const created = session.create(SERVER_URL, 'Alice', TITLE, 'youtube').catch((e: unknown) => e);
      await flush();
      const sessionPort = ports.at(-1)!;
      expect(sessionPort).not.toBe(port);
      sessionPort.fromWorker({ t: 'error', code });
      const sessionErr = await created;
      expect(sessionErr).toBeInstanceOf(SessionError);
      expect((sessionErr as SessionError).code).toBe(code);
      expect(sessionPort.disconnected).toBe(true);
      expect(session.inParty).toBe(false);
    }
  });

  it('port_transport_times_out', async () => {
    const { runtime, ports } = fakeRuntime();
    let settled = false;
    const outcome = createPortTransport(SERVER_URL, PORT_CONNECT_TIMEOUT_MS, runtime)
      .catch((e: unknown) => e)
      .finally(() => {
        settled = true;
      });
    const port = ports[0]!;

    await vi.advanceTimersByTimeAsync(PORT_CONNECT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(port.disconnected).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const err = await outcome;
    expect((err as { code?: string }).code).toBe('CONNECT_TIMEOUT');
    expect(port.disconnected).toBe(true);

    // A late 'open' after the timeout changes nothing.
    port.fromWorker({ t: 'open' });
    expect(keepalives(port)).toBe(0);

    // timeoutMs is honoured.
    const short = createPortTransport(SERVER_URL, 100, runtime).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(((await short) as { code?: string }).code).toBe('CONNECT_TIMEOUT');
    expect(ports.at(-1)!.disconnected).toBe(true);
  });

  it('port_transport_frames_and_close', async () => {
    const { runtime, ports } = fakeRuntime();

    // Frames reach every subscriber; invalid frames are dropped.
    const a = await openTransport(runtime, ports);
    const first: ServerMessage[] = [];
    const second: ServerMessage[] = [];
    a.transport.onMessage((m) => first.push(m));
    a.transport.onMessage((m) => second.push(m));
    a.port.fromWorker({ t: 'frame', data: 'not json' });
    a.port.fromWorker({ t: 'frame', data: JSON.stringify({ ...PONG, v: 2 }) });
    a.port.fromWorker({ t: 'frame', data: JSON.stringify(PONG) });
    expect(first).toEqual([PONG]);
    expect(second).toEqual([PONG]);

    // {t:'closed'} fires onClose(code) once; the following disconnect adds nothing.
    const closesA: number[] = [];
    a.transport.onClose((code) => closesA.push(code));
    a.port.fromWorker({ t: 'closed', code: 4001 });
    a.port.workerDisconnect();
    expect(closesA).toEqual([4001]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(keepalives(a.port)).toBe(0);

    // A port disconnect after open (service worker gone) fires onClose(1006) once.
    const b = await openTransport(runtime, ports);
    const closesB: number[] = [];
    b.transport.onClose((code) => closesB.push(code));
    b.port.workerDisconnect();
    b.port.fromWorker({ t: 'closed', code: 1000 });
    expect(closesB).toEqual([1006]);

    // close() disconnects the port.
    const c = await openTransport(runtime, ports);
    c.transport.close();
    expect(c.port.disconnected).toBe(true);
    expect(() => c.transport.send({ v: 1, type: 'ping', clientSentMs: 1 })).not.toThrow();
  });

  it('sw_termination_ends_party', async () => {
    const { runtime, connect, ports } = fakeRuntime();
    // PartySession's default connect is createPortTransport over chrome.runtime.
    vi.stubGlobal('chrome', { runtime });
    const session = new PartySession();

    const engine = { start: vi.fn(), stop: vi.fn() } as unknown as SyncEngine;
    const clockSync = { start: vi.fn(), stop: vi.fn(), serverNow: () => 0 } as unknown as ClockSync;
    const clock: Clock = { now: () => 42 };
    const adapter = new FakeAdapter({ positionSec: 0, paused: true });
    const controller = new PartyController(document, session, async () => adapter as PlayerAdapter, {
      clock,
      createClockSync: (_t: SyncTransport, _c: Clock) => clockSync,
      createEngine: (_a: PlayerAdapter, _t: SyncTransport, _sc: unknown, _o: SyncEngineOptions) => engine,
    });
    await controller.start();

    const closedEvents: SessionEventMap['closed'][] = [];
    session.on('closed', (e) => closedEvents.push(e));
    const statusText = () =>
      document.querySelector('test01-sidebar')?.shadowRoot?.querySelector('.status')?.textContent ?? null;

    const enter = async () => {
      const pending = session.create(SERVER_URL, 'Alice', TITLE, 'youtube');
      await flush();
      const port = ports.at(-1)!;
      expect(port.posted[0]).toEqual({ t: 'connect', url: SERVER_URL });
      port.fromWorker({ t: 'open' });
      await flush();
      const frames = port.posted.filter((m) => (m as { t?: string }).t === 'send') as { frame: string }[];
      expect(frames.map((f) => JSON.parse(f.frame).type)).toEqual(['create']);
      port.fromWorker({ t: 'frame', data: JSON.stringify(CREATED) });
      await pending;
      expect(session.inParty).toBe(true);
      return port;
    };

    const port = await enter();
    expect(engine.start).toHaveBeenCalledTimes(1);
    const closes: number[] = [];
    session.transport!.onClose((code) => closes.push(code));

    // The service worker is terminated: the port disconnects without {t:'closed'}.
    port.workerDisconnect();

    expect(closes).toEqual([1006]);
    expect(closedEvents).toEqual([{ code: 1006, initiatedLocally: false }]);
    expect(session.inParty).toBe(false);
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(clockSync.stop).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe(DISCONNECTED_STATUS);

    // No automatic reconnect.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(closes).toEqual([1006]);
    expect(closedEvents).toHaveLength(1);

    // The user's own leave reports a local close and never shows the lost-party status.
    const second = await enter();
    expect(statusText()).toBe('');
    session.leave();
    expect(closedEvents.at(-1)).toEqual({ code: 1000, initiatedLocally: true });
    expect(closedEvents).toHaveLength(2);
    const lastFrame = second.posted.filter((m) => (m as { t?: string }).t === 'send').at(-1) as { frame: string };
    expect(JSON.parse(lastFrame.frame)).toEqual({ v: 1, type: 'leave' });
    expect(second.disconnected).toBe(true);
    expect(engine.stop).toHaveBeenCalledTimes(2);
    expect(statusText()).not.toBe(DISCONNECTED_STATUS);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusText()).not.toBe(DISCONNECTED_STATUS);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
