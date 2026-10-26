import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackStateWire } from '@test01/protocol';
import { ClockSync, estimateOffset } from '../../src/sync/clock.js';
import { SyncEngine } from '../../src/sync/engine.js';
import { FakeAdapter } from './fake-adapter.js';
import { dateClock, PongingTransport } from './fake-transport.js';

function sample(clientSentMs: number, rttMs: number, offsetMs: number) {
  return { clientSentMs, serverMs: clientSentMs + rttMs / 2 + offsetMs, clientRecvMs: clientSentMs + rttMs };
}

describe('estimateOffset', () => {
  it('estimate_offset_uses_min_rtt', () => {
    // Asymmetric queuing on the slow samples skews their offset; the 40 ms one is exact.
    const samples = [
      { clientSentMs: 1000, serverMs: 1000 + 180 + 5000, clientRecvMs: 1200 },
      { clientSentMs: 2000, serverMs: 2000 + 20 + 5000, clientRecvMs: 2040 },
      { clientSentMs: 3000, serverMs: 3000 + 70 + 5000, clientRecvMs: 3090 },
    ];
    const r = estimateOffset(samples);
    expect(r.rttMs).toBe(40);
    expect(Math.abs(r.offsetMs - 5000)).toBeLessThanOrEqual(1);
  });

  it('estimate_offset_uses_last_8_only', () => {
    const samples = [sample(0, 10, 9999)];
    for (let i = 1; i <= 8; i++) samples.push(sample(i * 1000, 50 + i, 300));
    const r = estimateOffset(samples);
    expect(r.rttMs).toBe(51);
    expect(Math.abs(r.offsetMs - 300)).toBeLessThanOrEqual(1);
  });
});

describe('ClockSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clock_sync_offset_feeds_engine', async () => {
    const transport = new PongingTransport({ rttMs: 40, serverOffsetMs: 300 });
    const cs = new ClockSync(transport, dateClock);
    cs.start();
    expect(cs.offsetMs()).toBe(0);

    // Pings at 0/200/400/600/800 ms; the last pong lands at 840 ms.
    await vi.advanceTimersByTimeAsync(840);
    expect(transport.sentOfType('ping')).toHaveLength(5);
    expect(Math.abs(cs.serverNow() - dateClock.now() - 300)).toBeLessThanOrEqual(1);
    expect(Math.abs(cs.offsetMs() - 300)).toBeLessThanOrEqual(1);

    // Steady phase: next ping 2000 ms after the 5th.
    await vi.advanceTimersByTimeAsync(1959);
    expect(transport.sentOfType('ping')).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.sentOfType('ping')).toHaveLength(6);

    // Same state as aligns_late_joiner_within_2s, with ClockSync as the serverClock.
    vi.setSystemTime(1_000_000);
    const adapter = new FakeAdapter();
    const engine = new SyncEngine(adapter, transport, cs, {
      selfId: 'g',
      getHostId: () => 'h',
      getMode: () => 'everyone',
    });
    const initial: PlaybackStateWire = {
      playing: true,
      positionSec: 30,
      updatedAtServerMs: 1_000_300 - 1500,
      seq: 1,
      updatedBy: 'h',
      hostBuffering: false,
    };
    engine.start(initial);
    expect(adapter.calls.seeks).toHaveLength(1);
    expect(Math.abs(adapter.calls.seeks[0]! - 31.5)).toBeLessThanOrEqual(0.1);
    expect(adapter.calls.play).toBe(1);
    engine.stop();
    cs.stop();
  });

  it('stop halts pings and ignores later pongs', async () => {
    const transport = new PongingTransport({ rttMs: 40, serverOffsetMs: 300 });
    const cs = new ClockSync(transport, dateClock);
    cs.start();
    cs.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.sentOfType('ping')).toHaveLength(1);
    expect(cs.offsetMs()).toBe(0);
  });
});
