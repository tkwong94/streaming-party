import { parseServerMessage, type ClientMessage, type ServerMessage, type SyncTransport } from '@test01/protocol';

export const CONNECT_TIMEOUT_MS = 5000;

export interface WsTransport extends SyncTransport {
  close(): void;
  /** Fires once with the WebSocket close code after the socket was open. */
  onClose(cb: (code: number) => void): () => void;
}

export class TransportError extends Error {
  readonly code = 'CONNECT_FAILED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
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

/** Resolves once the socket is open; rejects with CONNECT_FAILED on error or after timeoutMs. */
export function createWsTransport(serverUrl: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<WsTransport> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      const url = new URL(serverUrl);
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('scheme');
      socket = new WebSocket(url);
    } catch {
      reject(new TransportError('server address must be a ws:// or wss:// URL'));
      return;
    }

    const messageListeners = new Set<(m: ServerMessage) => void>();
    const closeListeners = new Set<(code: number) => void>();
    let opened = false;
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new TransportError(message));
    };

    const timer = setTimeout(() => {
      fail(`could not connect within ${timeoutMs} ms`);
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    }, timeoutMs);

    socket.addEventListener('message', (event) => {
      // Anything that is not a valid v1 server frame is dropped.
      if (typeof event.data !== 'string') return;
      const parsed = parseServerMessage(event.data);
      if (parsed.ok) notify(messageListeners, parsed.value);
    });

    socket.addEventListener('error', () => {
      if (!opened) fail('could not connect to the server');
    });

    socket.addEventListener('close', (event) => {
      if (!opened) {
        fail('could not connect to the server');
        return;
      }
      notify(closeListeners, event.code);
      closeListeners.clear();
      messageListeners.clear();
    });

    socket.addEventListener('open', () => {
      if (settled) return;
      opened = true;
      settled = true;
      clearTimeout(timer);
      resolve({
        send(msg: ClientMessage) {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
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
          socket.close(1000);
        },
      });
    });
  });
}
