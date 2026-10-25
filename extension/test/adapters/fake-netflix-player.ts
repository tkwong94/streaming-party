// Fake Netflix page player for NetflixAdapter tests. The harness wires a FakeMedia
// <video>, a FakeNetflixPlayer exposed through a fake window.netflix, and the real
// MAIN-world bridge (installNetflixBridge) on a per-harness document, so stale
// listeners from earlier harnesses never answer later commands.
import { NetflixAdapter } from '../../src/adapters/netflix.js';
import { installNetflixBridge, type NetflixPageWindow } from '../../src/adapters/netflix-page-bridge.js';
import type { AdapterHarness } from './adapter-contract.js';
import { FakeMedia } from './fake-media.js';

export class FakeNetflixPlayer {
  readonly seekCalls: number[] = [];
  playCount = 0;
  pauseCount = 0;

  seek(ms: number): void {
    this.seekCalls.push(ms);
  }

  play(): void {
    this.playCount++;
  }

  pause(): void {
    this.pauseCount++;
  }
}

/** Minimal window.netflix shape the bridge walks to reach the player. */
export function fakeNetflixWindow(player: FakeNetflixPlayer): NetflixPageWindow {
  const videoPlayer = {
    getAllPlayerSessionIds: () => ['watch-session-1'],
    getVideoPlayerBySessionId: (id: string) => (id === 'watch-session-1' ? player : undefined),
  };
  return { netflix: { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer }) } } } } };
}

export type NetflixHarness = AdapterHarness & { player: FakeNetflixPlayer; doc: Document; adapter: NetflixAdapter };

export async function makeNetflixHarness(): Promise<NetflixHarness> {
  const doc = document.implementation.createHTMLDocument('netflix');
  const media = new FakeMedia();
  const player = new FakeNetflixPlayer();
  installNetflixBridge(fakeNetflixWindow(player), doc);
  const adapter = new NetflixAdapter(media.asVideo(), doc);
  return {
    adapter,
    media,
    player,
    doc,
    expectedSite: 'netflix',
    fire: (type) => {
      media.dispatchEvent(new Event(type));
    },
    lastSeekSec: () => {
      const ms = player.seekCalls.at(-1);
      return ms === undefined ? null : ms / 1000;
    },
    playCalls: () => player.playCount,
    pauseCalls: () => player.pauseCount,
  };
}
