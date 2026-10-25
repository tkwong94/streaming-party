import { describe, expect, it } from 'vitest';
import { MAX_POSITION_SEC } from '@test01/protocol';
import { canControl, canSetMode } from '../src/permissions.js';
import { applyControl, applyHostReport, extrapolate, stateAt } from '../src/playback.js';
import { RoomRegistry, type PlaybackState } from '../src/rooms.js';
import { FIXTURE_TITLE_URL } from './helpers.js';

const T0 = 1_000_000;

function state(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    playing: false,
    positionSec: 0,
    updatedAtServerMs: T0,
    seq: 0,
    updatedBy: 'host',
    hostBuffering: false,
    ...overrides,
  };
}

describe('applyControl', () => {
  it('play sets playing, rebases position and time, increments seq and records the sender', () => {
    const before = state();
    const after = applyControl(before, 'play', 10, 'guest', T0 + 500);
    expect(after).toEqual({
      playing: true,
      positionSec: 10,
      updatedAtServerMs: T0 + 500,
      seq: 1,
      updatedBy: 'guest',
      hostBuffering: false,
    });
    expect(before).toEqual(state());
  });

  it('pause clears playing; seek keeps the current playing flag', () => {
    const playing = state({ playing: true, seq: 4 });
    expect(applyControl(playing, 'pause', 12, 'host', T0)).toMatchObject({ playing: false, positionSec: 12, seq: 5 });
    expect(applyControl(playing, 'seek', 30, 'host', T0)).toMatchObject({ playing: true, positionSec: 30, seq: 5 });
    expect(applyControl(state(), 'seek', 30, 'host', T0)).toMatchObject({ playing: false, positionSec: 30, seq: 1 });
  });

  it('keeps hostBuffering, which only host reports change', () => {
    expect(applyControl(state({ hostBuffering: true }), 'play', 1, 'host', T0).hostBuffering).toBe(true);
  });
});

describe('applyHostReport', () => {
  it('rebases position, time and hostBuffering; playing, seq and updatedBy unchanged', () => {
    const before = state({ playing: true, positionSec: 5, seq: 3, updatedBy: 'guest' });
    const after = applyHostReport(before, { positionSec: 42, buffering: true }, T0 + 100);
    expect(after).toEqual({
      playing: true,
      positionSec: 42,
      updatedAtServerMs: T0 + 100,
      seq: 3,
      updatedBy: 'guest',
      hostBuffering: true,
    });
    expect(applyHostReport(after, { positionSec: 43, buffering: false }, T0 + 200).hostBuffering).toBe(false);
  });
});

describe('extrapolate', () => {
  it('advances only while playing and the host is not buffering', () => {
    expect(extrapolate(state({ playing: true, positionSec: 10 }), T0 + 2500)).toBe(12.5);
    expect(extrapolate(state({ playing: false, positionSec: 10 }), T0 + 2500)).toBe(10);
    expect(extrapolate(state({ playing: true, positionSec: 10, hostBuffering: true }), T0 + 2500)).toBe(10);
  });

  it('never rewinds for an earlier clock and never exceeds the position limit', () => {
    expect(extrapolate(state({ playing: true, positionSec: 10 }), T0 - 1000)).toBe(10);
    expect(extrapolate(state({ playing: true, positionSec: MAX_POSITION_SEC - 1 }), T0 + 5000)).toBe(MAX_POSITION_SEC);
  });

  it('stateAt returns the wire state extrapolated and rebased to now', () => {
    expect(stateAt(state({ playing: true, positionSec: 10, seq: 2 }), T0 + 1000)).toEqual(
      state({ playing: true, positionSec: 11, seq: 2, updatedAtServerMs: T0 + 1000 }),
    );
  });
});

describe('permissions', () => {
  const setup = () => {
    const registry = new RoomRegistry();
    const { room, host, secret } = registry.create({ nickname: 'Host', titleUrl: FIXTURE_TITLE_URL, site: 'fixture' });
    const joined = registry.join(room.id, secret, 'Guest');
    if (!joined.ok) throw new Error('join failed');
    return { room, hostId: host.id, guestId: joined.participant.id };
  };

  it('canControl: every member in mode everyone, only the host in host_only', () => {
    const { room, hostId, guestId } = setup();
    expect(canControl(room, hostId)).toBe(true);
    expect(canControl(room, guestId)).toBe(true);
    expect(canControl(room, 'not-a-member')).toBe(false);
    room.mode = 'host_only';
    expect(canControl(room, hostId)).toBe(true);
    expect(canControl(room, guestId)).toBe(false);
  });

  it('canSetMode: only the host, in either mode', () => {
    const { room, hostId, guestId } = setup();
    expect(canSetMode(room, hostId)).toBe(true);
    expect(canSetMode(room, guestId)).toBe(false);
    room.mode = 'host_only';
    expect(canSetMode(room, hostId)).toBe(true);
    expect(canSetMode(room, guestId)).toBe(false);
  });
});
