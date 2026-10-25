// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { AdapterError } from '@test01/protocol';
import { FixtureAdapter } from '../../src/adapters/fixture.js';
import { Html5VideoAdapter } from '../../src/adapters/html5-video.js';
import { YouTubeAdapter } from '../../src/adapters/youtube.js';
import { mediaHarness, runAdapterContract } from './adapter-contract.js';
import { FakeMedia } from './fake-media.js';

runAdapterContract('fixture', async () => {
  const media = new FakeMedia();
  return mediaHarness(new FixtureAdapter(media.asVideo()), media, 'fixture');
});

runAdapterContract('youtube', async () => {
  const player = document.createElement('div');
  player.id = 'movie_player';
  document.body.replaceChildren(player);
  const media = new FakeMedia();
  return mediaHarness(new YouTubeAdapter(media.asVideo(), player), media, 'youtube');
});

describe('Html5VideoAdapter', () => {
  test('html5_play_rejection_maps_to_adapter_error', async () => {
    const media = new FakeMedia();
    media.playRejection = new DOMException('play() requires a user gesture', 'NotAllowedError');
    const adapter = new Html5VideoAdapter(media.asVideo(), 'fixture');
    const err = await adapter.play().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('MEDIA_PLAY_REJECTED');
    adapter.dispose();
  });
});
