import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';

export type TunnelKind = 'cloudflared' | 'ngrok';
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type TunnelErrorCode =
  | 'TUNNEL_NOT_FOUND'
  | 'TUNNEL_SPAWN_FAILED'
  | 'TUNNEL_TIMEOUT'
  | 'TUNNEL_EXITED'
  | 'TUNNEL_ABORTED';

export class TunnelError extends Error {
  constructor(
    readonly code: TunnelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

/** How long the tunnel tool gets to report its public URL. */
export const TUNNEL_URL_TIMEOUT_MS = 30_000;
/** Grace period between SIGTERM and SIGKILL when stopping the tunnel child. */
const STOP_GRACE_MS = 5000;

export interface TunnelDeps {
  spawn: SpawnFn;
  env: Record<string, string | undefined>;
  /** Defaults to TUNNEL_URL_TIMEOUT_MS; tests shorten it. */
  timeoutMs?: number;
  /** Aborting stops the child and rejects with TUNNEL_ABORTED while still waiting for the URL. */
  signal?: AbortSignal;
}

export interface TunnelHandle {
  publicHttpsUrl: string;
  wsUrl: string;
  /** Resolves when the tunnel child exits for any reason. */
  exited: Promise<void>;
  stop(): Promise<void>;
}

// A Quick Tunnel URL stands alone on the banner line; `api.trycloudflare.com/...` in error lines does not count.
const CLOUDFLARED_URL = /(?:^|[\s|"'(<])(https:\/\/[a-z0-9-]+\.trycloudflare\.com)\/?(?=$|[\s|"')>])/;

export function parseCloudflaredUrl(line: string): string | null {
  const url = CLOUDFLARED_URL.exec(line)?.[1];
  if (!url || url === 'https://api.trycloudflare.com') return null;
  return url;
}

function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname ? url.origin : null;
  } catch {
    return null;
  }
}

/** Public URL from one `ngrok --log-format json` line (`url` or `public_url` field), else null. */
export function parseNgrokUrl(line: string): string | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
  for (const key of ['url', 'public_url']) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value !== 'string') continue;
    const origin = httpsOrigin(value);
    if (origin) return origin;
  }
  return null;
}

export function httpsToWss(httpsUrl: string): string {
  const url = new URL(httpsUrl);
  if (url.protocol !== 'https:') throw new Error(`not an https URL: ${httpsUrl}`);
  return `wss://${url.host}/ws`;
}

export function tunnelArgs(kind: TunnelKind, port: number): string[] {
  return kind === 'cloudflared'
    ? ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate']
    : ['http', String(port), '--log', 'stdout', '--log-format', 'json'];
}

/**
 * Spawns the tunnel tool and resolves once it reports its public https URL. The tool keeps using its
 * own config/environment; this module never reads, prints or passes auth tokens as arguments, and the
 * tool's own output is parsed but never echoed.
 */
export function startTunnel(kind: TunnelKind, port: number, deps: TunnelDeps): Promise<TunnelHandle> {
  const command = deps.env.TEST01_TUNNEL_BIN || kind;
  const parse = kind === 'cloudflared' ? parseCloudflaredUrl : parseNgrokUrl;
  const timeoutMs = deps.timeoutMs ?? TUNNEL_URL_TIMEOUT_MS;

  return new Promise<TunnelHandle>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = deps.spawn(command, tunnelArgs(kind, port), {
        env: deps.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(spawnError(error, kind));
      return;
    }

    let running = true;
    let settled = false;
    let markExited!: () => void;
    const exited = new Promise<void>((done) => (markExited = done));

    const stop = async (): Promise<void> => {
      if (running) {
        child.kill('SIGTERM');
        const killer = setTimeout(() => {
          if (running) child.kill('SIGKILL');
        }, STOP_GRACE_MS);
        await exited;
        clearTimeout(killer);
      }
    };

    const timer = setTimeout(() => {
      if (settle()) void stop().then(() => reject(new TunnelError('TUNNEL_TIMEOUT', `${kind} reported no public URL within ${Math.round(timeoutMs / 1000)} s`)));
    }, timeoutMs);

    const onAbort = () => {
      if (settle()) void stop().then(() => reject(new TunnelError('TUNNEL_ABORTED', 'stopped before the tunnel was ready')));
    };
    deps.signal?.addEventListener('abort', onAbort, { once: true });

    function settle(): boolean {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', onAbort);
      return true;
    }

    child.once('error', (error) => {
      running = false;
      markExited();
      if (settle()) reject(spawnError(error, kind));
    });
    child.once('exit', (code, signal) => {
      running = false;
      markExited();
      if (settle()) reject(new TunnelError('TUNNEL_EXITED', `${kind} exited (${signal ?? `code ${code}`}) before reporting a public URL`));
    });

    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      stream.on('error', () => {});
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
        if (settled) return;
        const url = parse(line);
        if (!url || !settle()) return;
        resolve({ publicHttpsUrl: url, wsUrl: httpsToWss(url), exited, stop });
      });
    }

    if (deps.signal?.aborted) onAbort();
  });
}

function spawnError(error: unknown, kind: TunnelKind): TunnelError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return new TunnelError('TUNNEL_NOT_FOUND', `${kind} executable not found`);
  return new TunnelError('TUNNEL_SPAWN_FAILED', `could not start ${kind}${code ? ` (${code})` : ''}`);
}
