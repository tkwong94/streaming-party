import { parseServerMessage, type ClientMessage, type ServerMessage } from '@test01/protocol';
import type { WsTransport } from './ws-transport.js';

// Content-script side of the background relay: the WebSocket itself lives in the
// service worker (src/background/service-worker.ts), reached over one runtime port.

export const PORT_NAME = 'test01/transport';
export const PORT_CONNECT_TIMEOUT_MS = 8000;
export const KEEPALIVE_INTERVAL_MS = 20_000;
/** Close code reported when the port drops without {t:'closed'} (service worker terminated). */
export const PORT_LOST_CLOSE_CODE = 1006;

export type ConnectErrorCode = 'CONNECT_REJECTED' | 'CONNECT_REFUSED' | 'CONNECT_TIMEOUT' | 'BAD_SERVER_URL';

export type ContentToWorker = { t: 'connect'; url: string } | { t: 'send'; frame: string } | { t: 'keepalive' };

export type WorkerToContent =
  | { t: 'open' }
  | { t: 'frame'; data: string }
  | { t: 'error'; code: ConnectErrorCode }
  | { t: 'closed'; code: number };

export class PortTransportError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'PortTransportError';
    this.code = code;
  }
}

function notify<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const cb of [...listeners]) {
    try {
      cb(value);
    } catch (err) {
      console.error('[test01] transport listener failed', err);
    }
  }
}

/**
 * Resolves once the service worker reports {t:'open'}; rejects with the worker's error code,
 * or CONNECT_TIMEOUT when neither open nor error arrives within timeoutMs. Never reconnects.
 */
export function createPortTransport(
  serverUrl: string,
  timeoutMs = PORT_CONNECT_TIMEOUT_MS,
  runtime: typeof chrome.runtime = chrome.runtime,
): Promise<WsTransport> {
  return new Promise((resolve, reject) => {
    const port = runtime.connect({ name: PORT_NAME });
    const messageListeners = new Set<(m: ServerMessage) => void>();
    const closeListeners = new Set<(code: number) => void>();
    let state: 'connecting' | 'open' | 'closed' = 'connecting';
    let keepalive: ReturnType<typeof setInterval> | undefined;

    const post = (msg: ContentToWorker): void => {
      try {
        port.postMessage(msg);
      } catch {
        // Port already gone; onDisconnect reports it.
      }
    };

    const shutdown = (): void => {
      state = 'closed';
      clearTimeout(timer);
      clearInterval(keepalive);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      try {
        port.disconnect();
      } catch {
        // Already disconnected.
      }
    };

    const fail = (code: string): void => {
      if (state !== 'connecting') return;
      shutdown();
      reject(new PortTransportError(code));
    };

    const finish = (code: number): void => {
      if (state !== 'open') return;
      shutdown();
      notify(closeListeners, code);
      closeListeners.clear();
      messageListeners.clear();
    };

    const transport: WsTransport = {
      send(msg: ClientMessage) {
        if (state === 'open') post({ t: 'send', frame: JSON.stringify(msg) });
      },
      onMessage(cb) {
        messageListeners.add(cb);
        return () => messageListeners.delete(cb);
      },
      onClose(cb) {
        closeListeners.add(cb);
        return () => closeListeners.delete(cb);
      },
      close() {
        // Disconnecting the port makes the service worker close the socket with 1000.
        if (state === 'closed') return;
        shutdown();
        closeListeners.clear();
        messageListeners.clear();
      },
    };

    function onMessage(raw: unknown): void {
      const msg = raw as Partial<Record<string, unknown>> | null;
      switch (msg?.t) {
        case 'open':
          if (state !== 'connecting') return;
          state = 'open';
          clearTimeout(timer);
          keepalive = setInterval(() => post({ t: 'keepalive' }), KEEPALIVE_INTERVAL_MS);
          resolve(transport);
          break;
        case 'error':
          fail(typeof msg.code === 'string' ? msg.code : 'CONNECT_REFUSED');
          break;
        case 'frame': {
          // Anything that is not a valid v1 server frame is dropped.
          if (state !== 'open' || typeof msg.data !== 'string') return;
          const parsed = parseServerMessage(msg.data);
          if (parsed.ok) notify(messageListeners, parsed.value);
          break;
        }
        case 'closed':
          finish(typeof msg.code === 'number' ? msg.code : PORT_LOST_CLOSE_CODE);
          break;
        default:
          break;
      }
    }

    // A drop before any reply is left to the connect timeout (CONNECT_TIMEOUT).
    function onDisconnect(): void {
      if (state === 'open') finish(PORT_LOST_CLOSE_CODE);
    }

    const timer = setTimeout(() => fail('CONNECT_TIMEOUT'), timeoutMs);
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    post({ t: 'connect', url: serverUrl });
  });
}
