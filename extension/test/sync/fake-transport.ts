import type { ClientMessage, Clock, ServerClock, ServerMessage, SyncTransport } from '@test01/protocol';

/** Records sent messages; tests push server messages with deliver(). */
export class FakeTransport implements SyncTransport {
  readonly sent: ClientMessage[] = [];
  private readonly subs = new Set<(m: ServerMessage) => void>();

  send(msg: ClientMessage): void {
    this.sent.push(msg);
  }

  onMessage(cb: (m: ServerMessage) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  deliver(m: ServerMessage): void {
    for (const cb of [...this.subs]) cb(m);
  }

  sentOfType<T extends ClientMessage['type']>(type: T): Extract<ClientMessage, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: T }> => m.type === type);
  }
}

/**
 * Answers each ping after rttMs of (fake) time with
 * serverMs = clientSentMs + rttMs / 2 + serverOffsetMs.
 */
export class PongingTransport extends FakeTransport {
  constructor(private readonly opts: { rttMs: number; serverOffsetMs: number }) {
    super();
  }

  override send(msg: ClientMessage): void {
    super.send(msg);
    if (msg.type !== 'ping') return;
    const { clientSentMs } = msg;
    setTimeout(() => {
      this.deliver({
        v: 1,
        type: 'pong',
        clientSentMs,
        serverMs: clientSentMs + this.opts.rttMs / 2 + this.opts.serverOffsetMs,
      });
    }, this.opts.rttMs);
  }
}

/** ServerClock stub: server time = Date.now() + offsetMs. */
export function stubServerClock(offsetMs = 0): ServerClock {
  return { serverNow: () => Date.now() + offsetMs };
}

export const dateClock: Clock = { now: () => Date.now() };
