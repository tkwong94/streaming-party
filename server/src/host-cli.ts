import { networkInterfaces as osNetworkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { WS_PATH, createSyncServer, type SyncServerHandle } from './server.js';
import { TunnelError, startTunnel, type SpawnFn, type TunnelHandle, type TunnelKind } from './tunnel.js';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_TUNNEL_NOT_FOUND = 2;
export const EXIT_TUNNEL_NO_URL = 3;
export const EXIT_HEALTH_FAILED = 4;
export const EXIT_PORT_IN_USE = 5;
export const EXIT_USAGE = 64;

export const DEFAULT_PORT = 8787;
export const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 1000;
const HEALTH_REQUEST_TIMEOUT_MS = 5000;

export const INSTALL_HINTS: Record<TunnelKind, string> = {
  cloudflared: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
  ngrok: 'https://ngrok.com/download',
};

export const USAGE = `Usage: test01-host [--tunnel cloudflared|ngrok|none] [--port <1024-65535>] [--lan]
  --tunnel  public tunnel to start (default cloudflared; none = no tunnel)
  --port    port for the sync server (default ${DEFAULT_PORT})
  --lan     listen on all interfaces (0.0.0.0) instead of 127.0.0.1
Environment: TEST01_TUNNEL_BIN overrides the tunnel executable path.
`;

export interface OutputStream {
  write(chunk: string): unknown;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface HostDeps {
  spawn: SpawnFn;
  fetch: FetchFn;
  env: Record<string, string | undefined>;
  stdout: OutputStream;
  stderr: OutputStream;
  /** Abort = SIGINT/SIGTERM: stop the tunnel, then the server, and exit 0. */
  signal: AbortSignal;
  tunnelTimeoutMs?: number;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  networkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

export interface HostOptions {
  tunnel: TunnelKind | 'none';
  port: number;
  lan: boolean;
  help: boolean;
}

/** Parsed options, or an error message for exit 64. */
export function parseHostArgs(argv: readonly string[]): HostOptions | string {
  const options: HostOptions = { tunnel: 'cloudflared', port: DEFAULT_PORT, lan: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = name === arg ? undefined : arg.slice(eq + 1);
    const value = () => inline ?? argv[++i];
    switch (name) {
      case '--tunnel': {
        const kind = value();
        if (kind !== 'cloudflared' && kind !== 'ngrok' && kind !== 'none') return `--tunnel must be cloudflared, ngrok or none`;
        options.tunnel = kind;
        break;
      }
      case '--port': {
        const raw = value() ?? '';
        const port = Number(raw);
        if (!/^\d+$/.test(raw) || port < 1024 || port > 65535) return `--port must be an integer from 1024 to 65535`;
        options.port = port;
        break;
      }
      case '--lan':
        if (inline !== undefined) return `--lan takes no value`;
        options.lan = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        return `unknown argument '${arg}'`;
    }
  }
  return options;
}

/** First non-internal IPv4 address, or null. */
export function lanIPv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | null {
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      const family = String(info.family);
      if ((family === 'IPv4' || family === '4') && !info.internal) return info.address;
    }
  }
  return null;
}

function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

type HealthResult = { kind: 'ok' } | { kind: 'aborted' } | { kind: 'failed'; last: string };

async function waitForHealth(baseUrl: string, deps: HostDeps): Promise<HealthResult> {
  const url = `${baseUrl}/healthz`;
  const deadline = Date.now() + (deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
  const interval = deps.healthIntervalMs ?? HEALTH_INTERVAL_MS;
  let last = 'no response';
  for (;;) {
    if (deps.signal.aborted) return { kind: 'aborted' };
    try {
      const response = await deps.fetch(url, {
        signal: AbortSignal.any([deps.signal, AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS)]),
      });
      if (response.status === 200) {
        const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
        if (body?.ok === true) return { kind: 'ok' };
        last = 'HTTP 200 without the sync server health body';
      } else {
        last = `HTTP ${response.status}`;
        await response.body?.cancel().catch(() => {});
      }
    } catch (error) {
      if (deps.signal.aborted) return { kind: 'aborted' };
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() + interval > deadline) return { kind: 'failed', last };
    await sleep(interval, deps.signal);
  }
}

/** The `test01-host` command. Returns the process exit code (see USAGE and the spec's api_contracts). */
export async function runHost(argv: string[], deps: HostDeps): Promise<number> {
  const out = (line: string) => deps.stdout.write(`${line}\n`);
  const err = (line: string) => deps.stderr.write(`${line}\n`);

  const options = parseHostArgs(argv);
  if (typeof options === 'string') {
    deps.stderr.write(`test01-host: ${options}\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (options.help) {
    deps.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (deps.signal.aborted) return EXIT_OK;

  const bindHost = options.lan ? '0.0.0.0' : '127.0.0.1';
  let server: SyncServerHandle;
  try {
    server = await createSyncServer({ port: options.port, host: bindHost });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      err(`Port ${options.port} is already in use. Stop the program using it or choose another port with --port <1024-65535>.`);
      return EXIT_PORT_IN_USE;
    }
    err(`Could not start the sync server on ${bindHost}:${options.port}${code ? ` (${code})` : ''}.`);
    return EXIT_FAILURE;
  }
  out(`Sync server listening on ${bindHost}:${server.port}`);

  let tunnel: TunnelHandle | undefined;
  try {
    let address: string;
    if (options.tunnel === 'none') {
      const lan = options.lan ? lanIPv4((deps.networkInterfaces ?? osNetworkInterfaces)()) : null;
      if (options.lan && !lan) err('No LAN IPv4 address found; only this computer can connect.');
      if (!options.lan) out('No tunnel and no --lan: only this computer can connect.');
      address = `ws://${lan ?? '127.0.0.1'}:${server.port}${WS_PATH}`;
    } else {
      const kind = options.tunnel;
      out(`Starting ${kind} tunnel...`);
      try {
        tunnel = await startTunnel(kind, server.port, {
          spawn: deps.spawn,
          env: deps.env,
          timeoutMs: deps.tunnelTimeoutMs,
          signal: deps.signal,
        });
      } catch (error) {
        if (!(error instanceof TunnelError)) throw error;
        switch (error.code) {
          case 'TUNNEL_ABORTED':
            return EXIT_OK;
          case 'TUNNEL_NOT_FOUND':
          case 'TUNNEL_SPAWN_FAILED':
            err(`${error.message}. Install ${kind} from ${INSTALL_HINTS[kind]} and make sure it is on your PATH, or use --tunnel none.`);
            return EXIT_TUNNEL_NOT_FOUND;
          case 'TUNNEL_TIMEOUT':
          case 'TUNNEL_EXITED':
            err(`${error.message}. Check your internet connection and run ${kind} on its own to see its error.`);
            return EXIT_TUNNEL_NO_URL;
        }
      }
      out(`Tunnel ready at ${tunnel.publicHttpsUrl}; checking ${tunnel.publicHttpsUrl}/healthz ...`);
      const health = await waitForHealth(tunnel.publicHttpsUrl, deps);
      if (health.kind === 'aborted') return EXIT_OK;
      if (health.kind === 'failed') {
        err(`Health check through the tunnel failed (${health.last}). Guests could not connect; try again in a minute.`);
        return EXIT_HEALTH_FAILED;
      }
      address = tunnel.wsUrl;
    }

    out(`Server address: ${address}`);
    out('Paste this address into the extension popup before creating the party.');
    out('Press Ctrl+C to stop');

    const stopped = abortPromise(deps.signal).then(() => 'stop' as const);
    const outcome = await (tunnel ? Promise.race([stopped, tunnel.exited.then(() => 'tunnel-exited' as const)]) : stopped);
    if (outcome === 'tunnel-exited') {
      err('The tunnel process exited unexpectedly; guests can no longer connect. Stopping the server.');
      return EXIT_FAILURE;
    }
    out('Stopping tunnel and server...');
    return EXIT_OK;
  } finally {
    if (tunnel) await tunnel.stop();
    await server.close();
  }
}
