import type { ClientMessage, ServerMessage, Site } from './messages.js';

export interface LocalPlayerEvent {
  kind: 'play' | 'pause' | 'seek' | 'buffering_start' | 'buffering_end';
  positionSec: number;
}

export type AdapterErrorCode = 'MEDIA_PLAY_REJECTED' | 'NETFLIX_BRIDGE_TIMEOUT' | 'NETFLIX_API_UNAVAILABLE';

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AdapterError';
    this.code = code;
  }
}

/** Site-specific player control. play/pause/seek reject only with AdapterError. */
export interface PlayerAdapter {
  readonly site: Site;
  getPositionSec(): number;
  isPaused(): boolean;
  isBuffering(): boolean;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionSec: number): Promise<void>;
  /** Returns an unsubscribe function. */
  onLocalEvent(cb: (e: LocalPlayerEvent) => void): () => void;
  dispose(): void;
}

/** Multiple subscribers allowed; onMessage returns an unsubscribe function. */
export interface SyncTransport {
  send(msg: ClientMessage): void;
  onMessage(cb: (m: ServerMessage) => void): () => void;
}

/** Local epoch ms. */
export interface Clock {
  now(): number;
}

/** Estimated server epoch ms; implemented by ClockSync (T09). */
export interface ServerClock {
  serverNow(): number;
}
