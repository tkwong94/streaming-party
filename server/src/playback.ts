import { MAX_POSITION_SEC, type ControlAction } from '@test01/protocol';
import type { PlaybackState } from './rooms.js';

/** The part of a host position_report that rebases room state. */
export interface HostReport {
  positionSec: number;
  buffering: boolean;
}

/** Accepted control: seq+1, play/pause set playing, seek keeps it; position and time rebased. */
export function applyControl(
  state: PlaybackState,
  action: ControlAction,
  positionSec: number,
  by: string,
  nowMs: number,
): PlaybackState {
  const playing = action === 'play' ? true : action === 'pause' ? false : state.playing;
  return { ...state, playing, positionSec, updatedAtServerMs: nowMs, seq: state.seq + 1, updatedBy: by };
}

/** Host report: rebases position, time and hostBuffering; playing, seq and updatedBy unchanged. */
export function applyHostReport(state: PlaybackState, report: HostReport, nowMs: number): PlaybackState {
  return { ...state, positionSec: report.positionSec, updatedAtServerMs: nowMs, hostBuffering: report.buffering };
}

/** Expected position at nowMs: advances only while playing and the host is not buffering. */
export function extrapolate(state: PlaybackState, nowMs: number): number {
  if (!state.playing || state.hostBuffering) return state.positionSec;
  const elapsedSec = Math.max(0, nowMs - state.updatedAtServerMs) / 1000;
  return Math.min(MAX_POSITION_SEC, state.positionSec + elapsedSec);
}

/** Wire state extrapolated and rebased to nowMs (sent to late joiners). */
export function stateAt(state: PlaybackState, nowMs: number): PlaybackState {
  return { ...state, positionSec: extrapolate(state, nowMs), updatedAtServerMs: nowMs };
}
