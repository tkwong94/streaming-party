import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '@test01/protocol';
import { classifyConnectFailure, startTransportRelay } from '../src/background/service-worker.js';
import { CONNECT_TIMEOUT_MS, type WsTransport } from '../src/transport/ws-transport.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const URL_OK = 'ws://127.0.0.1:1/ws';
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

/** Service-worker end of a runtime port; the test plays the content script. */
class FakePort {
  readonly posted: unknown[] = [];
  disconnected = false;
  readonly onMessage = new FakeEvent<[unknown, FakePort]>();
  readonly onDisconnect = new FakeEvent<[FakePort]>();

  constructor(
    readonly name: string,
    readonly sender: chrome.runtime.MessageSender,
  ) {}

  postMessage(msg: unknown): void {
    if (this.disconnected) throw new Error('Attempting to use a disconnected port object');
    this.posted.push(msg);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  fromContent(msg: unknown): void {
    if (!this.disconnected) this.onMessage.fire(msg, this);
  }

  /** Tab closed or navigated: the content side went away. */
  contentDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.fire(this);
  }
}

class FakeTransport implements WsTransport {
  readonly sent: ClientMessage[] = [];
  closeCalls = 0;
  private readonly messageCbs = new Set<(m: ServerMessage) => void>();
  private readonly closeCbs = new Set<(code: number) => void>();

  send(msg: ClientMessage): void {
    this.sent.push(msg);
  }

  onMessage(cb: (m: ServerMessage) => void): () => void {
    this.messageCbs.add(cb);
    return () => this.messageCbs.delete(cb);
  }

  onClose(cb: (code: number) => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  close(): void {
    this.closeCalls += 1;
  }

  emit(m: ServerMessage): void {
    for (const cb of [...this.messageCbs]) cb(m);
  }

  emitClose(code: number): void {
    for (const cb of [...this.closeCbs]) cb(code);
  }
}

function startRelay(
  opts: { connect?: (url: string) => Promise<WsTransport>; probeHealth?: (url: string) => Promise<boolean> } = {},
) {
  const onConnect = new FakeEvent<[FakePort]>();
  const runtime = { id: EXT_ID, onConnect } as unknown as typeof chrome.runtime;
  const transport = new FakeTransport();
  const connect = vi.fn(opts.connect ?? (async (_url: string): Promise<WsTransport> => transport));
  const probeHealth = vi.fn(opts.probeHealth ?? (async (_url: string) => true));
  startTransportRelay({ runtime, connect, probeHealth });
  const open = (
    name = 'test01/transport',
    sender: chrome.runtime.MessageSender = { id: EXT_ID, tab: { id: 7 } as chrome.tabs.Tab },
  ) => {
    const port = new FakePort(name, sender);
    onConnect.fire(port);
    return port;
  };
  return { open, connect, probeHealth, transport };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('background transport relay', () => {
  it('sw_opens_one_socket_per_port', async () => {
    const relay = startRelay();
    const port = relay.open();
    expect(port.disconnected).toBe(false);

    port.fromContent({ t: 'connect', url: URL_OK });
    expect(relay.connect).toHaveBeenCalledTimes(1);
    expect(relay.connect).toHaveBeenCalledWith(URL_OK);
    await flush();
    expect(port.posted).toEqual([{ t: 'open' }]);

    const msg: ClientMessage = { v: 1, type: 'ping', clientSentMs: 42 };
    port.fromContent({ t: 'send', frame: JSON.stringify(msg) });
    port.fromContent({ t: 'send', frame: 'not json' });
    port.fromContent({ t: 'keepalive' });
    expect(relay.transport.sent).toEqual([msg]);

    relay.transport.emit(PONG);
    expect(port.posted.at(-1)).toEqual({ t: 'frame', data: JSON.stringify(PONG) });
    expect(JSON.parse((port.posted.at(-1) as { data: string }).data)).toEqual(PONG);

    // A second port gets its own socket.
    const other = relay.open();
    other.fromContent({ t: 'connect', url: URL_OK });
    await flush();
    expect(relay.connect).toHaveBeenCalledTimes(2);
    expect(other.posted).toEqual([{ t: 'open' }]);
  });

  it('sw_rejects_foreign_ports_and_bad_urls', async () => {
    const relay = startRelay();
    const foreign = [
      relay.open('other/name'),
      relay.open('test01/transport', { id: EXT_ID }),
      relay.open('test01/transport', { id: 'someotherextensionidxxxxxxxxxxxx', tab: { id: 7 } as chrome.tabs.Tab }),
    ];
    for (const port of foreign) {
      expect(port.disconnected).toBe(true);
      port.fromContent({ t: 'connect', url: URL_OK });
    }
    await flush();
    expect(relay.connect).not.toHaveBeenCalled();

    for (const url of ['http://x/', 'not a url', `ws://127.0.0.1/${'a'.repeat(512)}`, 42]) {
      const port = relay.open();
      port.fromContent({ t: 'connect', url });
      await flush();
      expect(port.posted).toHaveLength(1);
      expect(port.posted[0]).toStrictEqual({ t: 'error', code: 'BAD_SERVER_URL' });
      expect(Object.keys(port.posted[0] as object).sort()).toEqual(['code', 't']);
      expect(port.disconnected).toBe(true);
    }
    expect(relay.connect).not.toHaveBeenCalled();

    const port = relay.open();
    port.fromContent({ t: 'connect', url: URL_OK });
    port.fromContent({ t: 'connect', url: 'ws://127.0.0.1:2/ws' });
    await flush();
    port.fromContent({ t: 'connect', url: 'ws://127.0.0.1:3/ws' });
    await flush();
    expect(relay.connect).toHaveBeenCalledTimes(1);
    expect(relay.connect).toHaveBeenCalledWith(URL_OK);
    expect(port.posted).toEqual([{ t: 'open' }]);
  });

  it('sw_classifies_connect_failures', async () => {
    expect(await classifyConnectFailure(URL_OK, 'error', async () => true)).toBe('CONNECT_REJECTED');
    expect(await classifyConnectFailure(URL_OK, 'error', async () => false)).toBe('CONNECT_REFUSED');
    const probe = vi.fn(async () => true);
    expect(await classifyConnectFailure(URL_OK, 'timeout', probe)).toBe('CONNECT_TIMEOUT');
    expect(probe).not.toHaveBeenCalled();

    for (const [reachable, code] of [
      [true, 'CONNECT_REJECTED'],
      [false, 'CONNECT_REFUSED'],
    ] as const) {
      const relay = startRelay({
        connect: async () => {
          throw Object.assign(new Error('could not connect'), { code: 'CONNECT_FAILED' });
        },
        probeHealth: async () => reachable,
      });
      const port = relay.open();
      port.fromContent({ t: 'connect', url: URL_OK });
      await flush();
      expect(relay.probeHealth).toHaveBeenCalledWith(URL_OK);
      expect(port.posted).toStrictEqual([{ t: 'error', code }]);
      expect(port.disconnected).toBe(true);
    }

    // A rejection CONNECT_TIMEOUT_MS after the attempt started is a timeout; no health probe.
    vi.useFakeTimers();
    const relay = startRelay({
      connect: () =>
        new Promise<WsTransport>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), CONNECT_TIMEOUT_MS)),
    });
    const port = relay.open();
    port.fromContent({ t: 'connect', url: URL_OK });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(relay.probeHealth).not.toHaveBeenCalled();
    expect(port.posted).toStrictEqual([{ t: 'error', code: 'CONNECT_TIMEOUT' }]);
    expect(port.disconnected).toBe(true);
  });

  it('sw_port_disconnect_closes_socket', async () => {
    const relay = startRelay();
    const port = relay.open();
    port.fromContent({ t: 'connect', url: URL_OK });
    await flush();
    expect(port.posted).toEqual([{ t: 'open' }]);

    // Same task, no timers: R2 tab-close leave depends on the socket closing promptly.
    port.contentDisconnect();
    expect(relay.transport.closeCalls).toBe(1);

    // Socket closed by the server: {t:'closed', code} then the port is disconnected.
    const second = startRelay();
    const port2 = second.open();
    port2.fromContent({ t: 'connect', url: URL_OK });
    await flush();
    second.transport.emitClose(4001);
    expect(port2.posted.at(-1)).toEqual({ t: 'closed', code: 4001 });
    expect(port2.disconnected).toBe(true);

    // A port that goes away while the socket is still connecting closes it once it opens.
    let resolveConnect!: (t: WsTransport) => void;
    const third = startRelay({ connect: () => new Promise<WsTransport>((resolve) => (resolveConnect = resolve)) });
    const port3 = third.open();
    port3.fromContent({ t: 'connect', url: URL_OK });
    port3.contentDisconnect();
    resolveConnect(third.transport);
    await flush();
    expect(third.transport.closeCalls).toBe(1);
    expect(port3.posted).toEqual([]);
  });
});
