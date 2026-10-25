// Latency-injecting WebSocket proxy: every frame in each direction is held for
// meanMs +/- jitterMs (uniform) and delivered in arrival order.
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

export interface DelayOptions {
  meanMs: number;
  jitterMs: number;
}

export interface DelayProxy {
  wsUrl: string;
  /** Frames forwarded so far: up = client -> server, down = server -> client. */
  frames: { up: number; down: number };
  close(): Promise<void>;
}

type Item = { kind: 'frame'; data: RawData; isBinary: boolean } | { kind: 'close'; code: number; reason: string };

/** Codes a peer may send in a close frame (1005/1006/1015 are reserved for local use). */
function sendableCloseCode(code: number): number {
  if ((code >= 3000 && code <= 4999) || (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code))) {
    return code;
  }
  return 1000;
}

/**
 * One direction of a connection. A single timer drains a FIFO whose due times never decrease,
 * so jitter can never reorder frames.
 */
class DelayLane {
  private queue: { due: number; item: Item }[] = [];
  private lastDue = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly opts: DelayOptions,
    private readonly deliver: (item: Item) => void,
  ) {}

  push(item: Item): void {
    if (this.closed) return;
    const delay = this.opts.meanMs + (Math.random() * 2 - 1) * this.opts.jitterMs;
    const due = Math.max(this.lastDue, Date.now() + Math.max(0, delay));
    this.lastDue = due;
    this.queue.push({ due, item });
    if (!this.timer) this.schedule();
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
  }

  private schedule(): void {
    const head = this.queue[0];
    if (!head) {
      this.timer = undefined;
      return;
    }
    this.timer = setTimeout(() => this.drain(), Math.max(0, head.due - Date.now()));
  }

  private drain(): void {
    const now = Date.now();
    while (this.queue.length && this.queue[0]!.due <= now) this.deliver(this.queue.shift()!.item);
    this.schedule();
  }
}

export async function startDelayProxy(targetWsUrl: string, opts: DelayOptions): Promise<DelayProxy> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });
  const frames = { up: 0, down: 0 };
  const sockets = new Set<WebSocket>();
  const lanes = new Set<DelayLane>();

  wss.on('connection', (client) => {
    const upstream = new WebSocket(targetWsUrl);
    sockets.add(client);
    sockets.add(upstream);
    const pendingUp: Item[] = [];

    const sendTo = (ws: WebSocket, item: Item, dir: 'up' | 'down'): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (item.kind === 'frame') {
        ws.send(item.data, { binary: item.isBinary });
        frames[dir]++;
      } else {
        ws.close(sendableCloseCode(item.code), item.reason);
      }
    };
    const up = new DelayLane(opts, (item) => {
      if (upstream.readyState === WebSocket.CONNECTING) pendingUp.push(item);
      else sendTo(upstream, item, 'up');
    });
    const down = new DelayLane(opts, (item) => sendTo(client, item, 'down'));
    lanes.add(up);
    lanes.add(down);

    upstream.on('open', () => {
      for (const item of pendingUp.splice(0)) sendTo(upstream, item, 'up');
    });
    client.on('message', (data, isBinary) => up.push({ kind: 'frame', data, isBinary }));
    upstream.on('message', (data, isBinary) => down.push({ kind: 'frame', data, isBinary }));
    // Closes travel through the lanes too, so they arrive after the frames sent before them.
    client.on('close', (code, reason) => up.push({ kind: 'close', code, reason: reason.toString() }));
    upstream.on('close', (code, reason) => down.push({ kind: 'close', code, reason: reason.toString() }));
    const cleanup = (): void => {
      if (client.readyState === WebSocket.CLOSED && upstream.readyState === WebSocket.CLOSED) {
        up.dispose();
        down.dispose();
        lanes.delete(up);
        lanes.delete(down);
        sockets.delete(client);
        sockets.delete(upstream);
      }
    };
    client.on('close', cleanup);
    upstream.on('close', cleanup);
    client.on('error', () => upstream.terminate());
    upstream.on('error', () => client.terminate());
  });

  const port = (wss.address() as AddressInfo).port;
  return {
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    frames,
    async close() {
      for (const lane of lanes) lane.dispose();
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
