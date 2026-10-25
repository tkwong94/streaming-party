import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runHost, type HostDeps } from '../src/host-cli.js';
import type { SpawnFn } from '../src/tunnel.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FAKE_CLOUDFLARED = join(FIXTURES, 'fake-cloudflared.mjs');
const FAKE_NGROK = join(FIXTURES, 'fake-ngrok.mjs');
const SENTINEL = 'SENTINEL-123';

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

async function canListen(port: number): Promise<boolean> {
  const server = createServer();
  const ok = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  if (ok) await new Promise<void>((resolve) => server.close(() => resolve()));
  return ok;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String);
}

const isTunnelHost = (host: string) => host.endsWith('.trycloudflare.com') || host.endsWith('.ngrok-free.app');

/** fetch that routes tunnel hostnames to the local server, standing in for the real tunnel. */
function tunnelFetch(port: number, hits: string[]): HostDeps['fetch'] {
  return (input, init) => {
    const url = new URL(input);
    hits.push(url.href);
    if (!isTunnelHost(url.hostname)) return Promise.reject(new Error(`unexpected host ${url.hostname}`));
    return fetch(`http://127.0.0.1:${port}${url.pathname}`, init);
  };
}

const running: { controller: AbortController; exit: Promise<number>; children: ChildProcess[] }[] = [];
const blockers: Server[] = [];
const tempDirs: string[] = [];

function host(
  argv: string[],
  port: number,
  options: Partial<Pick<HostDeps, 'fetch' | 'tunnelTimeoutMs' | 'healthTimeoutMs' | 'networkInterfaces'>> & {
    env?: Record<string, string>;
    hits?: string[];
  } = {},
) {
  const stdout = new Capture();
  const stderr = new Capture();
  const controller = new AbortController();
  const calls: { command: string; args: string[] }[] = [];
  const children: ChildProcess[] = [];
  const spy: SpawnFn = (command, args, spawnOptions) => {
    calls.push({ command, args: [...args] });
    const child = spawn(command, args, spawnOptions);
    children.push(child);
    return child;
  };
  const exit = runHost(argv, {
    spawn: spy,
    fetch: options.fetch ?? tunnelFetch(port, options.hits ?? []),
    env: { ...process.env, ...options.env },
    stdout,
    stderr,
    signal: controller.signal,
    tunnelTimeoutMs: options.tunnelTimeoutMs ?? 5000,
    healthTimeoutMs: options.healthTimeoutMs ?? 2000,
    healthIntervalMs: 50,
    networkInterfaces: options.networkInterfaces,
  });
  const run = { controller, exit, children };
  running.push(run);
  const waitForOutput = async (text: string, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!stdout.text.includes(text)) {
      if (Date.now() > deadline) throw new Error(`no '${text}' in stdout:\n${stdout.text}\nstderr:\n${stderr.text}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const childrenExited = () => children.every((c) => c.exitCode !== null || c.signalCode !== null);
  return { stdout, stderr, controller, calls, children, exit, waitForOutput, childrenExited };
}

afterEach(async () => {
  for (const run of running.splice(0)) {
    run.controller.abort();
    await run.exit.catch(() => undefined);
    for (const child of run.children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const server of blockers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('test01-host (runHost)', () => {
  it('cloudflared_flow_with_fake_binary', async () => {
    const port = await freePort();
    const hits: string[] = [];
    const run = host(['--port', String(port)], port, { env: { TEST01_TUNNEL_BIN: FAKE_CLOUDFLARED }, hits });
    await run.waitForOutput('Press Ctrl+C to stop');

    expect(run.stdout.text).toContain('Server address: wss://abc-def.trycloudflare.com/ws');
    expect(hits).toContain('https://abc-def.trycloudflare.com/healthz');
    expect(run.calls).toEqual([
      { command: FAKE_CLOUDFLARED, args: ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'] },
    ]);

    run.controller.abort();
    expect(await run.exit).toBe(0);
  });

  it('ngrok_flow_with_fake_binary', async () => {
    const port = await freePort();
    const run = host(['--tunnel', 'ngrok', '--port', String(port)], port, { env: { TEST01_TUNNEL_BIN: FAKE_NGROK } });
    await run.waitForOutput('Press Ctrl+C to stop');

    expect(run.stdout.text).toContain('Server address: wss://1a2b-203-0-113-7.ngrok-free.app/ws');
    expect(run.calls).toEqual([
      { command: FAKE_NGROK, args: ['http', String(port), '--log', 'stdout', '--log-format', 'json'] },
    ]);

    run.controller.abort();
    expect(await run.exit).toBe(0);
  });

  it('missing_tool_exit_2', async () => {
    const port = await freePort();
    const run = host(['--port', String(port)], port, { env: { TEST01_TUNNEL_BIN: '/nonexistent' } });
    expect(await run.exit).toBe(2);
    expect(run.stderr.text).toMatch(/https:\/\/\S+/);
    expect(run.stderr.text).toContain('https://developers.cloudflare.com/');
    expect(await canListen(port)).toBe(true);
  });

  it('no_url_exit_3', async () => {
    const port = await freePort();
    const run = host(['--port', String(port)], port, {
      env: { TEST01_TUNNEL_BIN: FAKE_CLOUDFLARED, FAKE_TUNNEL_MODE: 'silent' },
      tunnelTimeoutMs: 300,
    });
    expect(await run.exit).toBe(3);
    expect(run.childrenExited()).toBe(true);
    expect(await canListen(port)).toBe(true);
  });

  it('health_fail_exit_4', async () => {
    const port = await freePort();
    const run = host(['--port', String(port)], port, {
      env: { TEST01_TUNNEL_BIN: FAKE_CLOUDFLARED },
      fetch: async () => new Response('Bad Gateway', { status: 502 }),
      healthTimeoutMs: 300,
    });
    expect(await run.exit).toBe(4);
    expect(run.stdout.text).not.toContain('Server address:');
    expect(run.childrenExited()).toBe(true);
    expect(await canListen(port)).toBe(true);
  });

  it('port_in_use_exit_5', async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    blockers.push(blocker);

    const run = host(['--port', String(port)], port, { env: { TEST01_TUNNEL_BIN: FAKE_CLOUDFLARED } });
    expect(await run.exit).toBe(5);
    expect(run.stderr.text).toContain(String(port));
    expect(run.calls).toEqual([]);
  });

  it('no_token_leak', async () => {
    const home = mkdtempSync(join(tmpdir(), 'test01-home-'));
    tempDirs.push(home);
    const env = {
      HOME: home,
      USERPROFILE: home,
      NGROK_AUTHTOKEN: SENTINEL,
      CLOUDFLARED_TOKEN: SENTINEL,
    };

    const port = await freePort();
    const ok = host(['--tunnel', 'ngrok', '--port', String(port)], port, {
      env: { ...env, TEST01_TUNNEL_BIN: FAKE_NGROK },
    });
    await ok.waitForOutput('Press Ctrl+C to stop');
    ok.controller.abort();
    expect(await ok.exit).toBe(0);

    const missing = host(['--tunnel', 'ngrok', '--port', String(port)], port, {
      env: { ...env, TEST01_TUNNEL_BIN: '/nonexistent' },
    });
    expect(await missing.exit).toBe(2);

    for (const run of [ok, missing]) {
      expect(run.stdout.text).not.toContain(SENTINEL);
      expect(run.stderr.text).not.toContain(SENTINEL);
      expect(JSON.stringify(run.calls)).not.toContain(SENTINEL);
    }
    expect(filesUnder(home)).toEqual([]);
  });

  it('none_mode_prints_lan_address', async () => {
    const port = await freePort();
    const interfaces = (): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
      eth0: [
        { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '02:42:ac:16:00:03', internal: false, cidr: 'fe80::1/64', scopeid: 2 },
        { address: '192.168.1.23', netmask: '255.255.255.0', family: 'IPv4', mac: '02:42:ac:16:00:03', internal: false, cidr: '192.168.1.23/24' },
      ],
    });
    const run = host(['--tunnel', 'none', '--lan', '--port', String(port)], port, { networkInterfaces: interfaces });
    await run.waitForOutput('Press Ctrl+C to stop');

    expect(run.stdout.text).toContain(`Server address: ws://192.168.1.23:${port}/ws`);
    expect(run.calls).toEqual([]);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);

    run.controller.abort();
    expect(await run.exit).toBe(0);
  });

  it('sigint_stops_tunnel_then_server', async () => {
    const port = await freePort();
    const run = host(['--port', String(port)], port, { env: { TEST01_TUNNEL_BIN: FAKE_CLOUDFLARED } });
    await run.waitForOutput('Press Ctrl+C to stop');
    expect(run.children).toHaveLength(1);
    expect(run.childrenExited()).toBe(false);

    run.controller.abort();
    expect(await run.exit).toBe(0);
    expect(run.childrenExited()).toBe(true);
    expect(await canListen(port)).toBe(true);
  });

  it('bad_arguments_exit_64', async () => {
    for (const argv of [['--tunnel', 'frp'], ['--port', '80'], ['--port', 'abc'], ['--bogus']]) {
      const run = host(argv, 0);
      expect(await run.exit, argv.join(' ')).toBe(64);
      expect(run.stderr.text).toContain('Usage: test01-host');
      expect(run.calls).toEqual([]);
    }
  });
});
