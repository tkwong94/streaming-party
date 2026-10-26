// dist/background.js: owns one WebSocket per content-script port. Content-script sockets
// are blocked by Local Network Access on public pages; the extension service worker is not.
import type { ClientMessage } from '@test01/protocol';
import {
  PORT_NAME,
  type ConnectErrorCode,
  type ContentToWorker,
  type WorkerToContent,
} from '../transport/port-transport.js';
import { CONNECT_TIMEOUT_MS, createWsTransport, type WsTransport } from '../transport/ws-transport.js';

export const SERVER_URL_MAX_LENGTH = 512;
export const HEALTH_PROBE_TIMEOUT_MS = 2000;

export interface TransportRelayDeps {
  runtime: typeof chrome.runtime;
  connect?: (url: string) => Promise<WsTransport>;
  probeHealth?: (serverUrl: string) => Promise<boolean>;
}

function isServerUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > SERVER_URL_MAX_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}

/**
 * No-cors GET <http(s) origin>/healthz. Resolves (opaque) when any HTTP server answers,
 * rejects when nothing listens; it cannot tell a test-01 server from another one.
 */
export async function probeHealthz(serverUrl: string): Promise<boolean> {
  let target: string;
  try {
    const url = new URL(serverUrl);
    target = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}/healthz`;
  } catch {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    await fetch(target, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function classifyConnectFailure(
  serverUrl: string,
  cause: 'error' | 'timeout',
  probeHealth: (serverUrl: string) => Promise<boolean>,
): Promise<'CONNECT_REJECTED' | 'CONNECT_REFUSED' | 'CONNECT_TIMEOUT'> {
  if (cause === 'timeout') return 'CONNECT_TIMEOUT';
  let reachable = false;
  try {
    reachable = await probeHealth(serverUrl);
  } catch {
    reachable = false;
  }
  // Reachable: something answered at that origin but no WebSocket opened at that path.
  return reachable ? 'CONNECT_REJECTED' : 'CONNECT_REFUSED';
}

export function startTransportRelay(deps: TransportRelayDeps): void {
  const { runtime } = deps;
  const connect = deps.connect ?? ((url: string) => createWsTransport(url));
  const probeHealth = deps.probeHealth ?? probeHealthz;

  runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME || port.sender?.id !== runtime.id || !port.sender?.tab) {
      port.disconnect();
      return;
    }

    let started = false;
    let gone = false;
    let transport: WsTransport | null = null;

    const post = (msg: WorkerToContent): void => {
      if (gone) return;
      try {
        port.postMessage(msg);
      } catch {
        gone = true;
      }
    };
    const end = (): void => {
      gone = true;
      try {
        port.disconnect();
      } catch {
        // Already disconnected.
      }
    };
    const fail = (code: ConnectErrorCode): void => {
      post({ t: 'error', code });
      end();
    };

    const open = async (url: unknown): Promise<void> => {
      if (!isServerUrl(url)) {
        fail('BAD_SERVER_URL');
        return;
      }
      const startedAt = Date.now();
      let opened: WsTransport;
      try {
        opened = await connect(url);
      } catch {
        if (gone) return;
        const cause = Date.now() - startedAt >= CONNECT_TIMEOUT_MS ? 'timeout' : 'error';
        const code = await classifyConnectFailure(url, cause, probeHealth);
        if (!gone) fail(code);
        return;
      }
      if (gone) {
        opened.close();
        return;
      }
      transport = opened;
      opened.onMessage((m) => post({ t: 'frame', data: JSON.stringify(m) }));
      opened.onClose((code) => {
        transport = null;
        post({ t: 'closed', code });
        end();
      });
      post({ t: 'open' });
    };

    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as Partial<ContentToWorker> | null;
      if (msg?.t === 'connect') {
        if (started) return;
        started = true;
        void open((msg as { url?: unknown }).url);
      } else if (msg?.t === 'send') {
        const frame = (msg as { frame?: unknown }).frame;
        if (!transport || typeof frame !== 'string') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame);
        } catch {
          return;
        }
        transport.send(parsed as ClientMessage);
      }
      // {t:'keepalive'} needs no reply: the message itself keeps the worker active.
    });

    // Tab closed, navigated or left: close the socket now so the server drops the participant.
    port.onDisconnect.addListener(() => {
      gone = true;
      const current = transport;
      transport = null;
      current?.close();
    });
  });
}
