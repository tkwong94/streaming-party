import { AdapterError } from '@test01/protocol';
import { Html5VideoAdapter } from './html5-video.js';
import {
  NETFLIX_CMD_EVENT,
  NETFLIX_RES_EVENT,
  type NetflixBridgeCommand,
  type NetflixBridgeOp,
  type NetflixBridgeResponse,
} from './netflix-page-bridge.js';

export const NETFLIX_BRIDGE_TIMEOUT_MS = 2000;
export const NETFLIX_VIDEO_SELECTORS = ['.watch-video video', 'video'];

type Pending = { resolve: () => void; reject: (err: AdapterError) => void; timer: ReturnType<typeof setTimeout> };

// Shared across adapters so two adapters on one document never reuse an id.
let nextId = 1;

/**
 * Netflix watch-page adapter. State and local events come from the <video> element like
 * Html5VideoAdapter, but play/pause/seek go through the MAIN-world page bridge to
 * Netflix's player API. Writing video.currentTime directly triggers a Netflix player error.
 */
export class NetflixAdapter extends Html5VideoAdapter {
  private readonly doc: Document;
  private readonly pending = new Map<number, Pending>();
  private readonly onResponse = (e: Event) => {
    const res = (e as CustomEvent<NetflixBridgeResponse>).detail;
    if (typeof res !== 'object' || res === null || typeof res.id !== 'number') return;
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok) p.resolve();
    else p.reject(new AdapterError('NETFLIX_API_UNAVAILABLE', 'Netflix player API is not available on this page'));
  };

  constructor(video: HTMLVideoElement, doc: Document) {
    super(video, 'netflix');
    this.doc = doc;
    doc.addEventListener(NETFLIX_RES_EVENT, this.onResponse);
  }

  override play(): Promise<void> {
    return this.send('play');
  }

  override pause(): Promise<void> {
    return this.send('pause');
  }

  override seek(positionSec: number): Promise<void> {
    return this.send('seek', Math.round(positionSec * 1000));
  }

  override dispose(): void {
    if (this.disposed) return;
    this.doc.removeEventListener(NETFLIX_RES_EVENT, this.onResponse);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AdapterError('NETFLIX_BRIDGE_TIMEOUT', 'adapter disposed before the bridge answered'));
    }
    this.pending.clear();
    super.dispose();
  }

  private send(op: NetflixBridgeOp, ms?: number): Promise<void> {
    const id = nextId++;
    const cmd: NetflixBridgeCommand = ms === undefined ? { id, op } : { id, op, ms };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterError('NETFLIX_BRIDGE_TIMEOUT', `no Netflix bridge response to '${op}' within ${NETFLIX_BRIDGE_TIMEOUT_MS} ms`));
      }, NETFLIX_BRIDGE_TIMEOUT_MS);
      // Registered before dispatch: the bridge may answer synchronously.
      this.pending.set(id, { resolve, reject, timer });
      this.doc.dispatchEvent(new CustomEvent(NETFLIX_CMD_EVENT, { detail: cmd }));
    });
  }
}
