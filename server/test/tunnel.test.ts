import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TunnelError,
  httpsToWss,
  parseCloudflaredUrl,
  parseNgrokUrl,
  startTunnel,
  type SpawnFn,
  type TunnelHandle,
} from '../src/tunnel.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FAKE_CLOUDFLARED = join(FIXTURES, 'fake-cloudflared.mjs');
const FAKE_NGROK = join(FIXTURES, 'fake-ngrok.mjs');

describe('tunnel URL parsing', () => {
  it('parses_trycloudflare_url', () => {
    const banner =
      '2026-10-25T12:00:00Z INF |  https://abc-def.trycloudflare.com                                                         |';
    expect(parseCloudflaredUrl(banner)).toBe('https://abc-def.trycloudflare.com');

    const unrelated = [
      '2026-10-25T12:00:00Z INF Thank you for trying Cloudflare Tunnel.',
      '2026-10-25T12:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
      '2026-10-25T12:00:00Z ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"',
      'https://example.com',
      'https://abc.trycloudflare.com.evil.example',
      'http://abc-def.trycloudflare.com',
      '',
    ];
    for (const line of unrelated) expect(parseCloudflaredUrl(line), line).toBeNull();
  });

  it('parses_ngrok_json_url', () => {
    const started = JSON.stringify({
      addr: 'http://localhost:8787',
      lvl: 'info',
      msg: 'started tunnel',
      name: 'command_line',
      obj: 'tunnels',
      t: '2026-10-25T12:00:00Z',
      url: 'https://1a2b-203-0-113-7.ngrok-free.app',
    });
    expect(parseNgrokUrl(started)).toBe('https://1a2b-203-0-113-7.ngrok-free.app');
    expect(parseNgrokUrl(JSON.stringify({ msg: 'started tunnel', public_url: 'https://x1.ngrok.io' }))).toBe(
      'https://x1.ngrok.io',
    );

    const unrelated = [
      't=2026-10-25T12:00:00Z lvl=info msg="started tunnel" url=https://x.ngrok.io',
      JSON.stringify({ msg: 'tunnel session started' }),
      JSON.stringify({ msg: 'started tunnel', url: 'http://x.ngrok.io' }),
      JSON.stringify({ msg: 'started tunnel', url: 'tcp://0.tcp.ngrok.io:1234' }),
      JSON.stringify(['https://x.ngrok.io']),
      'null',
      '',
    ];
    for (const line of unrelated) expect(parseNgrokUrl(line), line).toBeNull();
  });

  it('converts_https_to_wss', () => {
    expect(httpsToWss('https://abc.trycloudflare.com')).toBe('wss://abc.trycloudflare.com/ws');
    expect(httpsToWss('https://abc.trycloudflare.com/')).toBe('wss://abc.trycloudflare.com/ws');
  });
});

describe('startTunnel', () => {
  let handles: TunnelHandle[] = [];
  let children: ChildProcess[] = [];
  const calls: { command: string; args: string[] }[] = [];
  const spy: SpawnFn = (command, args, options) => {
    calls.push({ command, args: [...args] });
    const child = spawn(command, args, options);
    children.push(child);
    return child;
  };

  afterEach(async () => {
    for (const handle of handles) await handle.stop();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    handles = [];
    children = [];
    calls.length = 0;
  });

  it('starts the binary named by TEST01_TUNNEL_BIN and resolves the parsed URL', async () => {
    const handle = await startTunnel('cloudflared', 41234, {
      spawn: spy,
      env: { ...process.env, TEST01_TUNNEL_BIN: FAKE_CLOUDFLARED },
    });
    handles.push(handle);
    expect(handle.publicHttpsUrl).toBe('https://abc-def.trycloudflare.com');
    expect(handle.wsUrl).toBe('wss://abc-def.trycloudflare.com/ws');
    expect(calls).toEqual([
      { command: FAKE_CLOUDFLARED, args: ['tunnel', '--url', 'http://127.0.0.1:41234', '--no-autoupdate'] },
    ]);

    await handle.stop();
    expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
  });

  it('parses the ngrok JSON log on stdout', async () => {
    const handle = await startTunnel('ngrok', 41235, {
      spawn: spy,
      env: { ...process.env, TEST01_TUNNEL_BIN: FAKE_NGROK },
    });
    handles.push(handle);
    expect(handle.wsUrl).toBe('wss://1a2b-203-0-113-7.ngrok-free.app/ws');
    expect(calls[0]!.args).toEqual(['http', '41235', '--log', 'stdout', '--log-format', 'json']);
  });

  it('rejects with TUNNEL_NOT_FOUND when the binary does not exist', async () => {
    const error = await startTunnel('cloudflared', 41236, {
      spawn: spy,
      env: { ...process.env, TEST01_TUNNEL_BIN: '/nonexistent/cloudflared' },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TunnelError);
    expect((error as TunnelError).code).toBe('TUNNEL_NOT_FOUND');
  });

  it('rejects with TUNNEL_TIMEOUT and stops the child when no URL appears', async () => {
    const error = await startTunnel('cloudflared', 41237, {
      spawn: spy,
      env: { ...process.env, TEST01_TUNNEL_BIN: FAKE_CLOUDFLARED, FAKE_TUNNEL_MODE: 'silent' },
      timeoutMs: 300,
    }).catch((e: unknown) => e);
    expect((error as TunnelError).code).toBe('TUNNEL_TIMEOUT');
    expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
  });
});
