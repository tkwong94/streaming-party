// HTMLVideoElement stand-in for adapter unit tests: settable currentTime/paused,
// play()/pause() call counters, configurable play() rejection and dispatchEvent.
export class FakeMedia extends EventTarget {
  paused = true;
  playCalls = 0;
  pauseCalls = 0;
  /** When set, play() rejects with this value instead of resolving. */
  playRejection: unknown = null;
  /** Every value written to currentTime, in order. */
  readonly currentTimeWrites: number[] = [];
  private time = 0;

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.time = value;
    this.currentTimeWrites.push(value);
  }

  play(): Promise<void> {
    this.playCalls++;
    if (this.playRejection !== null) return Promise.reject(this.playRejection);
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls++;
    this.paused = true;
  }

  asVideo(): HTMLVideoElement {
    return this as unknown as HTMLVideoElement;
  }
}
