import type { PlayerAdapter } from '@test01/protocol';
import { FIXTURE_VIDEO_SELECTOR, FixtureAdapter } from './fixture.js';
import { YOUTUBE_PLAYER_SELECTOR, YOUTUBE_VIDEO_SELECTORS, YouTubeAdapter } from './youtube.js';

export const VIDEO_WAIT_MS = 10_000;
const POLL_MS = 100;

function isYouTubeWatch(loc: Location): boolean {
  return loc.protocol === 'https:' && loc.hostname === 'www.youtube.com' && loc.pathname === '/watch';
}

function isFixtureWatch(loc: Location): boolean {
  return (
    loc.protocol === 'http:' && loc.hostname === '127.0.0.1' && loc.port === '8790' && loc.pathname === '/watch/fixture'
  );
}

/** Polls until find() returns a value or timeoutMs elapses. Polling works even before <body> exists. */
function waitFor<T>(find: () => T | null, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const found = find();
      if (found) resolve(found);
      else if (Date.now() >= deadline) resolve(null);
      else setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

/** Picks the adapter for the current page; waits up to 10 s for the video element. */
export async function selectAdapter(
  loc: Location,
  doc: Document,
  timeoutMs = VIDEO_WAIT_MS,
): Promise<PlayerAdapter | null> {
  if (isYouTubeWatch(loc)) {
    const found = await waitFor(() => {
      const player = doc.querySelector<HTMLElement>(YOUTUBE_PLAYER_SELECTOR);
      if (!player) return null;
      for (const sel of YOUTUBE_VIDEO_SELECTORS) {
        const video = doc.querySelector<HTMLVideoElement>(sel);
        if (video) return { player, video };
      }
      return null;
    }, timeoutMs);
    return found ? new YouTubeAdapter(found.video, found.player) : null;
  }
  if (isFixtureWatch(loc)) {
    const video = await waitFor(() => doc.querySelector<HTMLVideoElement>(FIXTURE_VIDEO_SELECTOR), timeoutMs);
    return video ? new FixtureAdapter(video) : null;
  }
  return null;
}
