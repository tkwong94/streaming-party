import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlMode, PlaybackStateWire } from '@test01/protocol';
import { SyncEngine } from '../../src/sync/engine.js';
import { FakeAdapter } from './fake-adapter.js';
import { FakeTransport, stubServerClock } from './fake-transport.js';

const T0 = 1_000_000;

function mkState(p: Partial<PlaybackStateWire> = {}): PlaybackStateWire {
  return { playing: true, positionSec: 10, updatedAtServerMs: Date.now(), seq: 1, updatedBy: 'h', hostBuffering: false, ...p };
}

function setup(opts: { role?: 'host' | 'guest'; mode?: ControlMode; offsetMs?: number; adapter?: FakeAdapter } = {}) {
  let mode: ControlMode = opts.mode ?? 'everyone';
  const adapter = opts.adapter ?? new FakeAdapter({ positionSec: 10, paused: false });
  const transport = new FakeTransport();
  const engine = new SyncEngine(adapter, transport, stubServerClock(opts.offsetMs ?? 0), {
    selfId: opts.role === 'host' ? 'h' : 'g',
    getHostId: () => 'h',
    getMode: () => mode,
  });
  return { adapter, transport, engine, setMode: (m: ControlMode) => (mode = m) };
}

function near(actual: number | undefined, expected: number, tol = 0.1) {
  expect(actual).toBeDefined();
  expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(tol);
}

describe('SyncEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aligns_late_joiner_within_2s', () => {
    const late = mkState({ playing: true, positionSec: 30, updatedAtServerMs: 1_000_300 - 1500, seq: 1 });

    const a = setup({ offsetMs: 300, adapter: new FakeAdapter() });
    a.engine.start(late);
    expect(a.adapter.calls.seeks).toHaveLength(1);
    near(a.adapter.calls.seeks[0], 31.5);
    expect(a.adapter.calls.play).toBe(1);
    a.engine.stop();

    const b = setup({ offsetMs: 0, adapter: new FakeAdapter() });
    b.engine.start(late);
    expect(b.adapter.calls.seeks).toHaveLength(1);
    near(b.adapter.calls.seeks[0], 31.2);
    b.engine.stop();
  });

  it('ignores_drift_under_threshold', async () => {
    const { adapter, engine } = setup();
    engine.start(mkState());
    expect(adapter.calls.seeks).toHaveLength(0);
    adapter.setPosition(adapter.getPositionSec() - 0.8);
    await vi.advanceTimersByTimeAsync(5000);
    expect(adapter.calls.seeks).toHaveLength(0);
    engine.stop();
  });

  it('realigns_drift_over_threshold', async () => {
    const { adapter, engine, transport } = setup();
    engine.start(mkState());
    adapter.setPosition(adapter.getPositionSec() - 1.3);
    await vi.advanceTimersByTimeAsync(500);
    expect(adapter.calls.seeks).toHaveLength(1);
    near(adapter.calls.seeks[0], engine.expectedPositionSec());
    await vi.advanceTimersByTimeAsync(3000);
    expect(adapter.calls.seeks).toHaveLength(1);
    expect(transport.sentOfType('control')).toHaveLength(0);
    engine.stop();
  });

  it('suppresses_echo_of_programmatic_seek', async () => {
    const adapter = new FakeAdapter({ positionSec: 10, paused: false, echoDelayMs: 50 });
    const events: string[] = [];
    adapter.onLocalEvent((e) => events.push(e.kind));
    const { engine, transport } = setup({ adapter });
    engine.start(mkState());
    transport.deliver({ v: 1, type: 'state', cause: 'control', state: mkState({ positionSec: 60, seq: 2, updatedBy: 'x' }) });
    await vi.advanceTimersByTimeAsync(100);
    expect(adapter.calls.seeks).toHaveLength(1);
    near(adapter.calls.seeks[0], 60);
    expect(events).toContain('seek');
    expect(transport.sentOfType('control')).toHaveLength(0);
    engine.stop();
  });

  it('buffering_triggers_resync_not_drift', async () => {
    const { adapter, engine } = setup();
    engine.start(mkState());
    adapter.setBuffering(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(adapter.calls.seeks).toHaveLength(0);
    adapter.setBuffering(false);
    expect(adapter.calls.seeks).toHaveLength(1);
    near(adapter.calls.seeks[0], engine.expectedPositionSec());
    near(adapter.calls.seeks[0], 13);
    await vi.advanceTimersByTimeAsync(2000);
    expect(adapter.calls.seeks).toHaveLength(1);
    engine.stop();
  });

  it('host_buffering_pauses_guests', async () => {
    const { adapter, engine, transport } = setup();
    engine.start(mkState());
    transport.deliver({ v: 1, type: 'state', cause: 'host_report', state: mkState({ positionSec: 10.5, updatedAtServerMs: Date.now(), hostBuffering: true }) });
    expect(adapter.isPaused()).toBe(true);
    expect(adapter.calls.pause).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    transport.deliver({ v: 1, type: 'state', cause: 'host_report', state: mkState({ positionSec: 10.5, updatedAtServerMs: Date.now(), hostBuffering: false }) });
    expect(adapter.isPaused()).toBe(false);
    expect(adapter.calls.play).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.sentOfType('control')).toHaveLength(0);
    engine.stop();
  });

  it('user_action_sends_control', () => {
    const { adapter, engine, transport } = setup({ mode: 'everyone' });
    engine.start(mkState({ positionSec: 12 }));
    adapter.user('pause', 12.0);
    const controls = transport.sentOfType('control');
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({ v: 1, type: 'control', action: 'pause', positionSec: 12.0 });
    engine.stop();
  });

  it('blocked_guest_action_reverted', () => {
    const { adapter, engine, transport } = setup({ mode: 'host_only' });
    engine.start(mkState());
    adapter.user('pause');
    expect(transport.sentOfType('control')).toHaveLength(0);
    expect(adapter.calls.play).toBe(1);
    expect(adapter.isPaused()).toBe(false);
    engine.stop();
  });

  it('host_sends_position_reports', async () => {
    const host = setup({ role: 'host' });
    host.engine.start(mkState());
    await vi.advanceTimersByTimeAsync(3000);
    const reports = host.transport.sentOfType('position_report');
    expect(reports).toHaveLength(3);
    for (const r of reports) {
      expect(r).toMatchObject({ v: 1, type: 'position_report', playing: true, buffering: false });
    }
    near(reports[2]!.positionSec, 13);
    host.adapter.setBuffering(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.transport.sentOfType('position_report')[3]).toMatchObject({ buffering: true });
    host.engine.stop();

    const guest = setup({ role: 'guest' });
    guest.engine.start(mkState());
    await vi.advanceTimersByTimeAsync(3000);
    expect(guest.transport.sentOfType('position_report')).toHaveLength(0);
    guest.engine.stop();
  });

  it('adapter_error_is_caught_and_retried_by_drift_check', async () => {
    const adapter = new FakeAdapter({ positionSec: 10, paused: true });
    adapter.failNext('play');
    const { engine } = setup({ adapter });
    engine.start(mkState());
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls.play).toBe(1);
    expect(adapter.isPaused()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(adapter.calls.play).toBe(2);
    expect(adapter.isPaused()).toBe(false);
    engine.stop();
  });

  it('ignores stale state and stops timers on stop()', async () => {
    const { adapter, engine, transport } = setup({ role: 'host' });
    engine.start(mkState({ seq: 5 }));
    transport.deliver({ v: 1, type: 'state', cause: 'control', state: mkState({ positionSec: 99, seq: 4, playing: false }) });
    expect(adapter.calls.seeks).toHaveLength(0);
    expect(adapter.calls.pause).toBe(0);
    engine.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(transport.sentOfType('position_report')).toHaveLength(0);
  });
});
