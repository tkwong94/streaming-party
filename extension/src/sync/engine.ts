import {
  DRIFT_REALIGN_MS,
  MAX_POSITION_SEC,
  type ControlMode,
  type LocalPlayerEvent,
  type PlaybackStateWire,
  type PlayerAdapter,
  type ServerClock,
  type ServerMessage,
  type SyncTransport,
} from '@test01/protocol';

export interface SyncEngineOptions {
  selfId: string;
  getHostId: () => string;
  getMode: () => ControlMode;
}

/** Seek on an incoming state only when further than this from expected. */
export const STATE_SEEK_THRESHOLD_SEC = 0.5;
export const DRIFT_CHECK_MS = 500;
export const POSITION_REPORT_MS = 1000;
export const ECHO_SUPPRESS_MS = 1000;
/** After a local control, stale host reports are ignored until the ack (or this timeout). */
const CONTROL_ACK_WAIT_MS = 2000;

type Op = 'play' | 'pause' | 'seek';

function clampPosition(sec: number): number {
  return Math.min(MAX_POSITION_SEC, Math.max(0, Number.isFinite(sec) ? sec : 0));
}

/**
 * Applies room state to the local player. The host is the position reference and
 * reports every second; guests follow state and re-align when drift exceeds
 * DRIFT_REALIGN_MS. Programmatic ops never produce outgoing controls.
 */
export class SyncEngine {
  /** Effective state: last server state, or an optimistic local control awaiting its ack. */
  private state: PlaybackStateWire | null = null;
  private serverState: PlaybackStateWire | null = null;
  private lastSeq = -1;
  private clientSeq = 0;
  private controlPendingUntil = 0;
  private retryNeeded = false;
  private readonly suppressUntil: Record<Op, number> = { play: 0, pause: 0, seek: 0 };
  private timers: ReturnType<typeof setInterval>[] = [];
  private unsubs: (() => void)[] = [];

  constructor(
    private readonly adapter: PlayerAdapter,
    private readonly transport: SyncTransport,
    private readonly serverClock: ServerClock,
    private readonly opts: SyncEngineOptions,
  ) {}

  start(initial: PlaybackStateWire): void {
    this.stop();
    this.state = initial;
    this.serverState = initial;
    this.lastSeq = initial.seq;
    this.unsubs.push(
      this.transport.onMessage((m) => this.onServerMessage(m)),
      this.adapter.onLocalEvent((e) => this.onLocalEvent(e)),
    );
    this.timers.push(
      setInterval(() => this.checkDrift(), DRIFT_CHECK_MS),
      setInterval(() => this.reportPosition(), POSITION_REPORT_MS),
    );
    this.applyState(STATE_SEEK_THRESHOLD_SEC);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    for (const u of this.unsubs) u();
    this.timers = [];
    this.unsubs = [];
  }

  expectedPositionSec(): number {
    const st = this.state;
    if (!st) return 0;
    const advancing = st.playing && !st.hostBuffering;
    return st.positionSec + (advancing ? (this.serverClock.serverNow() - st.updatedAtServerMs) / 1000 : 0);
  }

  private isHost(): boolean {
    return this.opts.selfId === this.opts.getHostId();
  }

  private onServerMessage(m: ServerMessage): void {
    if (m.type === 'state') {
      if (m.cause === 'control') {
        if (m.state.seq <= this.lastSeq) return;
        this.acceptState(m.state);
        this.controlPendingUntil = 0;
        this.applyState(STATE_SEEK_THRESHOLD_SEC);
        return;
      }
      // host_report: rebases position/hostBuffering with an unchanged seq.
      if (m.state.seq < this.lastSeq) return;
      if (m.state.seq === this.lastSeq && Date.now() < this.controlPendingUntil) return;
      this.acceptState(m.state);
      // The host is the reference for its own reports; guests follow play/pause
      // (including host buffering) and leave position to the drift check.
      if (!this.isHost()) this.applyPlayState();
      return;
    }
    if (m.type === 'error' && m.inReplyTo === 'control') {
      // Control rejected (e.g. FORBIDDEN_CONTROL after a mode race): revert to room state.
      this.controlPendingUntil = 0;
      this.state = this.serverState;
      this.applyState(STATE_SEEK_THRESHOLD_SEC);
    }
  }

  private acceptState(st: PlaybackStateWire): void {
    this.state = st;
    this.serverState = st;
    this.lastSeq = Math.max(this.lastSeq, st.seq);
  }

  private onLocalEvent(e: LocalPlayerEvent): void {
    if (!this.state) return;
    if (e.kind === 'buffering_start') return;
    if (e.kind === 'buffering_end') {
      if (!this.isHost()) this.resync();
      return;
    }
    if (Date.now() < this.suppressUntil[e.kind]) return;

    const allowed = this.isHost() || this.opts.getMode() === 'everyone';
    if (!allowed) {
      this.applyState(STATE_SEEK_THRESHOLD_SEC);
      return;
    }
    const positionSec = clampPosition(e.positionSec);
    this.transport.send({ v: 1, type: 'control', action: e.kind, positionSec, clientSeq: this.clientSeq++ });
    // Optimistic: keep the drift check from fighting the user until the server acks.
    this.state = {
      ...this.state,
      playing: e.kind === 'play' ? true : e.kind === 'pause' ? false : this.state.playing,
      positionSec,
      updatedAtServerMs: this.serverClock.serverNow(),
      updatedBy: this.opts.selfId,
    };
    this.controlPendingUntil = Date.now() + CONTROL_ACK_WAIT_MS;
  }

  /** After the guest's own buffering ends: one seek to the room position. */
  private resync(): void {
    const st = this.state;
    if (!st) return;
    if (st.playing && !st.hostBuffering) this.seek(this.expectedPositionSec());
    else if (Math.abs(this.adapter.getPositionSec() - this.expectedPositionSec()) > STATE_SEEK_THRESHOLD_SEC) {
      this.seek(this.expectedPositionSec());
    }
    this.applyPlayState();
  }

  private checkDrift(): void {
    if (!this.state) return;
    if (this.retryNeeded) {
      this.retryNeeded = false;
      this.applyState(STATE_SEEK_THRESHOLD_SEC);
      return;
    }
    if (this.isHost()) return;
    const st = this.state;
    if (!st.playing || st.hostBuffering || this.adapter.isBuffering()) return;
    const expected = this.expectedPositionSec();
    if (Math.abs(this.adapter.getPositionSec() - expected) * 1000 > DRIFT_REALIGN_MS) this.seek(expected);
  }

  private reportPosition(): void {
    if (!this.state || !this.isHost()) return;
    this.transport.send({
      v: 1,
      type: 'position_report',
      positionSec: clampPosition(this.adapter.getPositionSec()),
      playing: !this.adapter.isPaused(),
      buffering: this.adapter.isBuffering(),
    });
  }

  private applyState(seekThresholdSec: number): void {
    if (!this.state) return;
    const expected = this.expectedPositionSec();
    if (Math.abs(this.adapter.getPositionSec() - expected) > seekThresholdSec) this.seek(expected);
    this.applyPlayState();
  }

  private applyPlayState(): void {
    const st = this.state;
    if (!st) return;
    const wantPlaying = st.playing && (this.isHost() || !st.hostBuffering);
    if (wantPlaying && this.adapter.isPaused()) this.run('play', () => this.adapter.play());
    else if (!wantPlaying && !this.adapter.isPaused()) this.run('pause', () => this.adapter.pause());
  }

  private seek(positionSec: number): void {
    const target = clampPosition(positionSec);
    this.run('seek', () => this.adapter.seek(target));
  }

  /** Suppress the op's echo, then run it; rejections are swallowed and retried next drift check. */
  private run(kind: Op, op: () => Promise<void>): void {
    this.suppressUntil[kind] = Date.now() + ECHO_SUPPRESS_MS;
    let p: Promise<void>;
    try {
      p = op();
    } catch (err) {
      p = Promise.reject(err);
    }
    p.catch(() => {
      this.retryNeeded = true;
    });
  }
}
