import type { ClientMessageType } from '@test01/protocol';

/** Classic token bucket: starts full, refills continuously, never exceeds capacity. */
export class TokenBucket {
  private tokens: number;
  private lastMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.lastMs = now();
  }

  /** Consumes one token when available. */
  take(): boolean {
    const nowMs = this.now();
    // A clock going backwards adds nothing; refill resumes once it passes lastMs again.
    if (nowMs > this.lastMs) {
      this.tokens = Math.min(this.capacity, this.tokens + ((nowMs - this.lastMs) / 1000) * this.refillPerSec);
      this.lastMs = nowMs;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export const CHAT_LIMIT = { capacity: 5, refillPerSec: 0.5 };
export const CONTROL_LIMIT = { capacity: 10, refillPerSec: 1 };
export const TOTAL_LIMIT = { capacity: 50, refillPerSec: 5 };

/** Rate limits for one participant (one connection): all messages, plus chat and control. */
export class ParticipantLimits {
  private readonly total: TokenBucket;
  private readonly byType: Partial<Record<ClientMessageType, TokenBucket>>;

  constructor(now: () => number = () => Date.now()) {
    this.total = new TokenBucket(TOTAL_LIMIT.capacity, TOTAL_LIMIT.refillPerSec, now);
    this.byType = {
      chat: new TokenBucket(CHAT_LIMIT.capacity, CHAT_LIMIT.refillPerSec, now),
      control: new TokenBucket(CONTROL_LIMIT.capacity, CONTROL_LIMIT.refillPerSec, now),
    };
  }

  /** True when the message may be processed; false means RATE_LIMITED and drop. */
  allow(type: ClientMessageType): boolean {
    if (!this.total.take()) return false;
    return this.byType[type]?.take() ?? true;
  }
}

export const BAD_MESSAGE_LIMIT = 10;
export const BAD_MESSAGE_WINDOW_MS = 10_000;

/** Sliding window of BAD_MESSAGE replies; record() returns true once the limit is reached. */
export class BadMessageWindow {
  private readonly times: number[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  record(): boolean {
    const nowMs = this.now();
    while (this.times.length > 0 && nowMs - this.times[0]! >= BAD_MESSAGE_WINDOW_MS) this.times.shift();
    this.times.push(nowMs);
    return this.times.length >= BAD_MESSAGE_LIMIT;
  }
}
