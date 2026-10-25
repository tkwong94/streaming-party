// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import type { LocalPlayerEvent } from '@test01/protocol';
import { YouTubeAdapter } from '../../src/adapters/youtube.js';
import { FakeMedia } from './fake-media.js';

// MutationObserver callbacks run as microtasks; let them flush.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('YouTubeAdapter', () => {
  let adapter: YouTubeAdapter | null = null;

  afterEach(() => {
    adapter?.dispose();
    adapter = null;
  });

  test('youtube_ad_counts_as_buffering', async () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.replaceChildren(player);
    const media = new FakeMedia();
    adapter = new YouTubeAdapter(media.asVideo(), player);
    const events: LocalPlayerEvent[] = [];
    adapter.onLocalEvent((e) => events.push(e));
    expect(adapter.isBuffering()).toBe(false);

    media.currentTime = 42;
    player.classList.add('ad-showing');
    await flush();
    expect(adapter.isBuffering()).toBe(true);
    expect(events).toEqual([{ kind: 'buffering_start', positionSec: 42 }]);

    player.classList.remove('ad-showing');
    await flush();
    expect(adapter.isBuffering()).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(['buffering_start', 'buffering_end']);
  });

  test('youtube_ad_media_events_are_not_forwarded', async () => {
    // Ads play in the same <video>; their play/pause/seek must not look like user control.
    const player = document.createElement('div');
    player.id = 'movie_player';
    player.className = 'ad-showing';
    document.body.replaceChildren(player);
    const media = new FakeMedia();
    adapter = new YouTubeAdapter(media.asVideo(), player);
    expect(adapter.isBuffering()).toBe(true);
    const events: LocalPlayerEvent[] = [];
    adapter.onLocalEvent((e) => events.push(e));
    for (const type of ['play', 'pause', 'seeked', 'waiting', 'playing']) media.dispatchEvent(new Event(type));
    expect(events).toEqual([]);
    expect(adapter.isBuffering()).toBe(true);
  });

  test('youtube_dispose_stops_ad_observer', async () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.replaceChildren(player);
    const media = new FakeMedia();
    adapter = new YouTubeAdapter(media.asVideo(), player);
    const events: LocalPlayerEvent[] = [];
    adapter.onLocalEvent((e) => events.push(e));
    adapter.dispose();
    player.classList.add('ad-showing');
    await flush();
    expect(events).toEqual([]);
  });
});
