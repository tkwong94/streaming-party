import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOM_ID_PATTERN, SECRET_PATTERN, type ErrorMessage, type ServerMessage } from '@test01/protocol';
import { runHost, type HostDeps } from '../src/host-cli.js';
import type { SyncServerHandle } from '../src/index.js';
import type { SpawnFn } from '../src/tunnel.js';
import { TestClient, createRoom, delay, findValue, joinRoom, startServer, type MessageOf } from './helpers.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FAKE_CLOUDFLARED = join(FIXTURES, 'fake-cloudflared.mjs');
const FAKE_NGROK = join(FIXTURES, 'fake-ngrok.mjs');

const chat = (text: string) => ({ v: 1, type: 'chat', text });
const control = (positionSec: number, clientSeq: number) => ({ v: 1, type: 'control', action: 'seek', positionSec, clientSeq });
const joinFrame = (fields: Record<string, unknown>) => ({ v: 1, type: 'join', nickname: 'Mallory', ...fields });

/** A well-formed secret (43 base64url chars) that differs from `secret`. */
function otherSecret(secret: string): string {
  for (;;) {
    const candidate = randomBytes(32).toString('base64url');
    if (candidate !== secret) return candidate;
  }
}

/** Polls until the condition holds (real time), failing after timeoutMs. */
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > timeoutMs) throw new Error('condition not met in time');
    await delay(10);
  }
}

function ofType<T extends ServerMessage['type']>(client: TestClient, type: T, from = 0): MessageOf<T>[] {
  return client.messages.slice(from).filter((m): m is MessageOf<T> => m.type === type);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

describe('sync server security (R9, R2, R1)', () => {
  let handle: SyncServerHandle;
  let clients: TestClient[];
  const track = (client: TestClient) => (clients.push(client), client);

  const party = async () => {
    const { client: host, created } = await createRoom(handle);
    track(host);
    const { client: guest } = await joinRoom(handle, created.roomId, created.secret, 'Guest');
    track(guest);
    await host.waitFor('participants', (m) => m.participants.length === 2);
    return { host, guest, all: [host, guest], created, room: handle.registry.get(created.roomId)! };
  };

  beforeEach(async () => {
    handle = await startServer();
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await handle.close();
    // Every frame the server sent must have been a valid protocol message.
    for (const client of clients) expect(client.invalid).toEqual([]);
  });

  it('wrong_missing_or_malformed_secret_denied', async () => {
    const { client: host, created } = await createRoom(handle);
    track(host);
    const cases = [
      { name: 'wrong secret', frame: joinFrame({ roomId: created.roomId, secret: otherSecret(created.secret) }), code: 'JOIN_DENIED' },
      { name: 'missing secret field', frame: joinFrame({ roomId: created.roomId }), code: 'BAD_MESSAGE' },
      { name: '42-char secret', frame: joinFrame({ roomId: created.roomId, secret: created.secret.slice(0, 42) }), code: 'BAD_MESSAGE' },
      // The real secret paired with an unknown room must not help either.
      { name: 'unknown room', frame: joinFrame({ roomId: randomBytes(16).toString('base64url'), secret: created.secret }), code: 'JOIN_DENIED' },
    ] as const;

    const deniedTexts: string[] = [];
    for (const c of cases) {
      const client = track(await TestClient.connect(handle.wsUrl));
      client.send(c.frame);
      const error = await client.waitFor('error');
      expect(error.code, c.name).toBe(c.code);
      expect(error.inReplyTo, c.name).toBe('join');
      expect(error.message, c.name).not.toContain(created.secret);
      if (c.code === 'JOIN_DENIED') {
        deniedTexts.push(error.message);
        expect((await client.closed).code, c.name).toBe(4001);
      } else {
        await delay(100);
      }
      expect(ofType(client, 'joined'), c.name).toEqual([]);
    }

    expect(deniedTexts).toHaveLength(2);
    expect(new Set(deniedTexts).size).toBe(1);
    expect(handle.registry.get(created.roomId)!.participants.size).toBe(1);
    expect(ofType(host, 'participants')).toEqual([]);
  });

  it('no_room_enumeration_by_timing', async () => {
    const { client: host, created } = await createRoom(handle);
    track(host);
    const attempt = async (frame: unknown): Promise<{ ms: number; error: ErrorMessage }> => {
      const client = track(await TestClient.connect(handle.wsUrl));
      const started = performance.now();
      client.send(frame);
      const error = await client.waitFor('error');
      const ms = performance.now() - started;
      await client.closed;
      return { ms, error };
    };
    const unknownRoom = () => joinFrame({ roomId: randomBytes(16).toString('base64url'), secret: otherSecret('') });
    const wrongSecret = () => joinFrame({ roomId: created.roomId, secret: otherSecret(created.secret) });

    // Warm-up, not measured.
    for (let i = 0; i < 5; i++) {
      await attempt(unknownRoom());
      await attempt(wrongSecret());
    }
    const unknownMs: number[] = [];
    const wrongMs: number[] = [];
    const messages = new Set<string>();
    // Interleaved so drift in machine load affects both series equally.
    for (let i = 0; i < 50; i++) {
      for (const [frame, series] of [
        [unknownRoom(), unknownMs],
        [wrongSecret(), wrongMs],
      ] as const) {
        const { ms, error } = await attempt(frame);
        expect(error.code).toBe('JOIN_DENIED');
        messages.add(error.message);
        series.push(ms);
      }
    }

    expect(unknownMs).toHaveLength(50);
    expect(wrongMs).toHaveLength(50);
    expect(messages.size).toBe(1);
    const diff = Math.abs(median(unknownMs) - median(wrongMs));
    console.info(`[T14 timing] median unknown=${median(unknownMs).toFixed(3)} ms wrong=${median(wrongMs).toFixed(3)} ms diff=${diff.toFixed(3)} ms`);
    expect(diff).toBeLessThan(20);
  }, 60_000);

  it('message_before_join_not_joined', async () => {
    const client = track(await TestClient.connect(handle.wsUrl));
    client.send(chat('hello'));
    client.send(control(10, 0));
    client.send({ v: 1, type: 'set_mode', mode: 'host_only' });
    await until(() => ofType(client, 'error').length === 3);
    expect(ofType(client, 'error').map((m) => [m.code, m.inReplyTo])).toEqual([
      ['NOT_JOINED', 'chat'],
      ['NOT_JOINED', 'control'],
      ['NOT_JOINED', 'set_mode'],
    ]);
    expect(client.messages.filter((m) => m.type !== 'error')).toEqual([]);
    expect(client.isOpen).toBe(true);
  });

  it('chat_flood_rate_limited', async () => {
    const { guest, all } = await party();
    const from = all.map((c) => c.mark());
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      guest.send(chat(`flood ${i}`));
      if (i < 19) await delay(30);
    }
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(1000);

    await until(() => ofType(guest, 'error', from[1]).length === 15);
    await delay(150);
    const errors = ofType(guest, 'error', from[1]);
    expect(errors).toHaveLength(15);
    expect(errors.every((m) => m.code === 'RATE_LIMITED' && m.inReplyTo === 'chat')).toBe(true);
    for (const [i, client] of all.entries()) {
      expect(ofType(client, 'chat', from[i]).map((m) => m.message.text)).toEqual(['flood 0', 'flood 1', 'flood 2', 'flood 3', 'flood 4']);
    }
    expect(guest.isOpen).toBe(true);
  });

  it('control_flood_rate_limited', async () => {
    const { host, all, room } = await party();
    const from = all.map((c) => c.mark());
    const started = performance.now();
    for (let i = 0; i < 30; i++) host.send(control(i, i));
    expect(performance.now() - started).toBeLessThan(1000);

    await until(() => ofType(host, 'error', from[0]).length === 20);
    await delay(150);
    const errors = ofType(host, 'error', from[0]);
    expect(errors).toHaveLength(20);
    expect(errors.every((m) => m.code === 'RATE_LIMITED' && m.inReplyTo === 'control')).toBe(true);
    expect(room.state.seq).toBe(10);
    expect(room.state.positionSec).toBe(9);
    for (const [i, client] of all.entries()) expect(ofType(client, 'state', from[i])).toHaveLength(10);
  });

  it('secret_never_logged', async () => {
    const captured: string[] = [];
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }),
    );
    const writeSpies = [process.stdout, process.stderr].map((stream) =>
      vi.spyOn(stream, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        captured.push(Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof stream.write),
    );

    let secret: string;
    let errorTexts: string[];
    try {
      const { client: host, created } = await createRoom(handle);
      track(host);
      secret = created.secret;
      const { client: guest } = await joinRoom(handle, created.roomId, created.secret, 'Guest');
      track(guest);
      guest.send(chat('hi'));
      await host.waitFor('chat');
      // Denied joins with the secret against the wrong room, and a near-miss secret.
      const denied = track(await TestClient.connect(handle.wsUrl));
      denied.send(joinFrame({ roomId: randomBytes(16).toString('base64url'), secret }));
      await denied.closed;
      const malformed = track(await TestClient.connect(handle.wsUrl));
      malformed.send(joinFrame({ roomId: created.roomId, secret: `${secret}x` }));
      await malformed.waitFor('error');
      errorTexts = [...denied.messages, ...malformed.messages].map((m) => JSON.stringify(m));

      expect(findValue(handle.registry, secret)).toEqual([]);
    } finally {
      for (const spy of [...consoleSpies, ...writeSpies]) spy.mockRestore();
    }

    expect(errorTexts).toHaveLength(2);
    for (const text of errorTexts) expect(text).not.toContain(secret);
    expect(captured.join('\n')).not.toContain(secret);
  });

  it('room_id_entropy', async () => {
    const ids = new Set<string>();
    const secrets = new Set<string>();
    for (let batch = 0; batch < 10; batch++) {
      const rooms = await Promise.all(Array.from({ length: 100 }, () => createRoom(handle)));
      for (const { client, created } of rooms) {
        expect(created.roomId).toMatch(ROOM_ID_PATTERN);
        expect(created.secret).toMatch(SECRET_PATTERN);
        expect(Buffer.from(created.roomId, 'base64url')).toHaveLength(16);
        expect(Buffer.from(created.secret, 'base64url')).toHaveLength(32);
        ids.add(created.roomId);
        secrets.add(created.secret);
        client.close();
      }
      await Promise.all(rooms.map(({ client }) => client.closed));
    }
    expect(ids.size).toBe(1000);
    expect(secrets.size).toBe(1000);
    for (const id of ids) expect(secrets.has(id)).toBe(false);
    // Each room was deleted when its only participant left.
    await until(() => [...ids].every((id) => handle.registry.get(id) === undefined));
  }, 60_000);
});

class Capture {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const filesUnder = (dir: string) => readdirSync(dir, { recursive: true }).map(String);

/** fetch that routes the fake tunnel hostnames to the local server, standing in for the real tunnel. */
function tunnelFetch(port: number): HostDeps['fetch'] {
  return (input, init) => {
    const url = new URL(input);
    if (!url.hostname.endsWith('.trycloudflare.com') && !url.hostname.endsWith('.ngrok-free.app')) {
      return Promise.reject(new Error(`unexpected host ${url.hostname}`));
    }
    return fetch(`http://127.0.0.1:${port}${url.pathname}`, init);
  };
}

describe('host helper token handling (R9)', () => {
  const runs: { controller: AbortController; exit: Promise<number>; children: ChildProcess[] }[] = [];
  const homes: string[] = [];

  afterEach(async () => {
    for (const run of runs.splice(0)) {
      run.controller.abort();
      await run.exit.catch(() => undefined);
      for (const child of run.children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it('helper_never_leaks_tokens', async () => {
    const home = mkdtempSync(join(tmpdir(), 'test01-t14-home-'));
    homes.push(home);
    const before = filesUnder(home);
    const sentinels = {
      NGROK_AUTHTOKEN: `T14-NGROK-SENTINEL-${randomBytes(8).toString('hex')}`,
      CLOUDFLARED_TOKEN: `T14-CLOUDFLARED-SENTINEL-${randomBytes(8).toString('hex')}`,
    };

    for (const [tunnel, bin] of [
      ['ngrok', FAKE_NGROK],
      ['cloudflared', FAKE_CLOUDFLARED],
    ] as const) {
      const port = await freePort();
      const stdout = new Capture();
      const stderr = new Capture();
      const calls: { command: string; args: string[] }[] = [];
      const children: ChildProcess[] = [];
      const spawnSpy: SpawnFn = (command, args, options) => {
        calls.push({ command, args: [...args] });
        const child = spawn(command, args, options);
        children.push(child);
        return child;
      };
      const controller = new AbortController();
      const exit = runHost(['--tunnel', tunnel, '--port', String(port)], {
        spawn: spawnSpy,
        fetch: tunnelFetch(port),
        env: { ...process.env, HOME: home, USERPROFILE: home, ...sentinels, TEST01_TUNNEL_BIN: bin },
        stdout,
        stderr,
        signal: controller.signal,
        tunnelTimeoutMs: 5000,
        healthTimeoutMs: 2000,
        healthIntervalMs: 50,
      });
      runs.push({ controller, exit, children });

      const deadline = Date.now() + 8000;
      while (!stdout.text.includes('Press Ctrl+C to stop')) {
        if (Date.now() > deadline) throw new Error(`${tunnel}: helper never became ready\nstdout:\n${stdout.text}\nstderr:\n${stderr.text}`);
        await delay(20);
      }
      expect(stdout.text, tunnel).toContain('Server address: wss://');
      controller.abort();
      expect(await exit, tunnel).toBe(0);

      expect(calls, tunnel).toHaveLength(1);
      for (const value of Object.values(sentinels)) {
        expect(stdout.text, tunnel).not.toContain(value);
        expect(stderr.text, tunnel).not.toContain(value);
        expect(JSON.stringify(calls), tunnel).not.toContain(value);
        for (const child of children) expect(child.spawnargs.join(' '), tunnel).not.toContain(value);
      }
    }

    expect(before).toEqual([]);
    expect(filesUnder(home)).toEqual([]);
  }, 30_000);
});
