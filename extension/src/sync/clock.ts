import type { Clock, ServerClock, ServerMessage, SyncTransport } from '@test01/protocol';

export interface ClockSample {
  clientSentMs: number;
  serverMs: number;
  clientRecvMs: number;
}

export interface OffsetEstimate {
  offsetMs: number;
  rttMs: number;
}

export const CLOCK_SAMPLE_WINDOW = 8;
const BURST_PINGS = 5;
const BURST_INTERVAL_MS = 200;
const STEADY_INTERVAL_MS = 2000;

/**
 * Offset from the min-RTT sample among the last 8: that sample has the least
 * queuing asymmetry. offset = serverMs - (clientSentMs + rtt / 2).
 */
export function estimateOffset(samples: ClockSample[]): OffsetEstimate {
  const recent = samples.slice(-CLOCK_SAMPLE_WINDOW);
  let best: ClockSample | undefined;
  let bestRtt = Infinity;
  for (const s of recent) {
    const rtt = s.clientRecvMs - s.clientSentMs;
    if (rtt < bestRtt) {
      bestRtt = rtt;
      best = s;
    }
  }
  if (!best) return { offsetMs: 0, rttMs: Infinity };
  return { offsetMs: best.serverMs - (best.clientSentMs + bestRtt / 2), rttMs: bestRtt };
}

/** Estimates server time from ping/pong: 5 pings 200 ms apart, then one every 2000 ms. */
export class ClockSync implements ServerClock {
  private samples: ClockSample[] = [];
  private pending = new Set<number>();
  private offset = 0;
  private sentCount = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly transport: SyncTransport,
    private readonly clock: Clock,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.transport.onMessage((m) => this.onMessage(m));
    this.sentCount = 0;
    this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.pending.clear();
  }

  serverNow(): number {
    return this.clock.now() + this.offset;
  }

  /** 0 until the first pong. */
  offsetMs(): number {
    return this.offset;
  }

  private tick(): void {
    const clientSentMs = this.clock.now();
    this.pending.add(clientSentMs);
    this.transport.send({ v: 1, type: 'ping', clientSentMs });
    this.sentCount++;
    const delay = this.sentCount < BURST_PINGS ? BURST_INTERVAL_MS : STEADY_INTERVAL_MS;
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private onMessage(m: ServerMessage): void {
    if (m.type !== 'pong' || !this.pending.delete(m.clientSentMs)) return;
    const clientRecvMs = this.clock.now();
    if (clientRecvMs < m.clientSentMs) return;
    this.samples.push({ clientSentMs: m.clientSentMs, serverMs: m.serverMs, clientRecvMs });
    if (this.samples.length > CLOCK_SAMPLE_WINDOW) this.samples.shift();
    this.offset = estimateOffset(this.samples).offsetMs;
  }
}
