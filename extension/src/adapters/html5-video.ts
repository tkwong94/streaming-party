import { AdapterError, type LocalPlayerEvent, type PlayerAdapter, type Site } from '@test01/protocol';

type MediaEventType = 'play' | 'pause' | 'seeked' | 'waiting' | 'playing';

/** PlayerAdapter over a plain HTMLVideoElement; base class for site adapters. */
export class Html5VideoAdapter implements PlayerAdapter {
  readonly site: Site;
  protected readonly video: HTMLVideoElement;
  private readonly callbacks = new Set<(e: LocalPlayerEvent) => void>();
  private readonly listeners: [MediaEventType, () => void][];
  private mediaWaiting = false;
  protected disposed = false;

  constructor(video: HTMLVideoElement, site: Site) {
    this.video = video;
    this.site = site;
    this.listeners = [
      ['play', () => this.forward('play')],
      ['pause', () => this.forward('pause')],
      ['seeked', () => this.forward('seek')],
      [
        'waiting',
        () => {
          if (this.mediaWaiting || !this.shouldForwardMediaEvents()) return;
          this.mediaWaiting = true;
          this.emit('buffering_start');
        },
      ],
      [
        'playing',
        () => {
          // 'playing' also fires after every ordinary play; only a preceding 'waiting' makes it buffering_end.
          if (!this.mediaWaiting || !this.shouldForwardMediaEvents()) return;
          this.mediaWaiting = false;
          this.emit('buffering_end');
        },
      ],
    ];
    for (const [type, fn] of this.listeners) video.addEventListener(type, fn);
  }

  getPositionSec(): number {
    return this.video.currentTime;
  }

  isPaused(): boolean {
    return this.video.paused;
  }

  isBuffering(): boolean {
    return this.mediaWaiting;
  }

  async play(): Promise<void> {
    try {
      await this.video.play();
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new AdapterError('MEDIA_PLAY_REJECTED', `video.play() rejected (${reason})`);
    }
  }

  async pause(): Promise<void> {
    this.video.pause();
  }

  async seek(positionSec: number): Promise<void> {
    this.video.currentTime = positionSec;
  }

  onLocalEvent(cb: (e: LocalPlayerEvent) => void): () => void {
    if (this.disposed) return () => {};
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [type, fn] of this.listeners) this.video.removeEventListener(type, fn);
    this.callbacks.clear();
  }

  /** Subclasses return false while media events do not reflect the user's content (e.g. ads). */
  protected shouldForwardMediaEvents(): boolean {
    return true;
  }

  protected emit(kind: LocalPlayerEvent['kind']): void {
    if (this.disposed) return;
    const event: LocalPlayerEvent = { kind, positionSec: this.video.currentTime };
    for (const cb of [...this.callbacks]) cb(event);
  }

  private forward(kind: 'play' | 'pause' | 'seek'): void {
    if (this.shouldForwardMediaEvents()) this.emit(kind);
  }
}
