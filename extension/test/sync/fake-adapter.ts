import { AdapterError, type LocalPlayerEvent, type PlayerAdapter } from '@test01/protocol';

type Op = 'play' | 'pause' | 'seek';

export interface FakeAdapterOptions {
  positionSec?: number;
  paused?: boolean;
  /** Delay before a programmatic op emits its local event (0 = synchronous). */
  echoDelayMs?: number;
}

/**
 * Time-aware fake player: position advances with Date.now() (fake timers) while
 * playing and not buffering. Programmatic play/pause/seek emit the matching local
 * event like a real media element would.
 */
export class FakeAdapter implements PlayerAdapter {
  readonly site = 'fixture' as const;
  readonly calls = { play: 0, pause: 0, seeks: [] as number[] };

  private basePos: number;
  private baseAt: number;
  private paused: boolean;
  private buffering = false;
  private readonly echoDelayMs: number;
  private readonly listeners = new Set<(e: LocalPlayerEvent) => void>();
  private readonly failures = new Set<Op>();

  constructor(opts: FakeAdapterOptions = {}) {
    this.basePos = opts.positionSec ?? 0;
    this.baseAt = Date.now();
    this.paused = opts.paused ?? true;
    this.echoDelayMs = opts.echoDelayMs ?? 0;
  }

  getPositionSec(): number {
    const advancing = !this.paused && !this.buffering;
    return this.basePos + (advancing ? (Date.now() - this.baseAt) / 1000 : 0);
  }

  isPaused(): boolean {
    return this.paused;
  }

  isBuffering(): boolean {
    return this.buffering;
  }

  async play(): Promise<void> {
    this.calls.play++;
    this.maybeFail('play');
    this.rebase();
    this.paused = false;
    this.echo({ kind: 'play', positionSec: this.getPositionSec() });
  }

  async pause(): Promise<void> {
    this.calls.pause++;
    this.maybeFail('pause');
    this.rebase();
    this.paused = true;
    this.echo({ kind: 'pause', positionSec: this.getPositionSec() });
  }

  async seek(positionSec: number): Promise<void> {
    this.calls.seeks.push(positionSec);
    this.maybeFail('seek');
    this.basePos = positionSec;
    this.baseAt = Date.now();
    this.echo({ kind: 'seek', positionSec });
  }

  onLocalEvent(cb: (e: LocalPlayerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    this.listeners.clear();
  }

  // Test controls

  /** Next call of `op` rejects with AdapterError. */
  failNext(op: Op): void {
    this.failures.add(op);
  }

  /** Silently move the playhead (simulates drift; no event). */
  setPosition(positionSec: number): void {
    this.basePos = positionSec;
    this.baseAt = Date.now();
  }

  setBuffering(buffering: boolean): void {
    this.rebase();
    this.buffering = buffering;
    this.emit({ kind: buffering ? 'buffering_start' : 'buffering_end', positionSec: this.getPositionSec() });
  }

  /** A user action on the page: changes the player and emits the event immediately. */
  user(kind: Op, positionSec?: number): void {
    this.rebase();
    if (positionSec !== undefined) this.setPosition(positionSec);
    if (kind === 'play') this.paused = false;
    if (kind === 'pause') this.paused = true;
    this.emit({ kind, positionSec: this.getPositionSec() });
  }

  private rebase(): void {
    this.basePos = this.getPositionSec();
    this.baseAt = Date.now();
  }

  private maybeFail(op: Op): void {
    if (this.failures.delete(op)) throw new AdapterError('MEDIA_PLAY_REJECTED', `fake ${op} rejected`);
  }

  private echo(e: LocalPlayerEvent): void {
    if (this.echoDelayMs > 0) setTimeout(() => this.emit(e), this.echoDelayMs);
    else this.emit(e);
  }

  private emit(e: LocalPlayerEvent): void {
    for (const cb of [...this.listeners]) cb(e);
  }
}
