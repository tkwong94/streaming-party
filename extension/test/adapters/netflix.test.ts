// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AdapterError } from '@test01/protocol';
import { selectAdapter } from '../../src/adapters/detect.js';
import { NetflixAdapter } from '../../src/adapters/netflix.js';
import {
  NETFLIX_CMD_EVENT,
  NETFLIX_RES_EVENT,
  installNetflixBridge,
  type NetflixBridgeResponse,
} from '../../src/adapters/netflix-page-bridge.js';
import { FakeMedia } from './fake-media.js';
import { makeNetflixHarness } from './fake-netflix-player.js';

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d();
  vi.useRealTimers();
});

describe('NetflixAdapter', () => {
  test('seek_uses_player_api_not_current_time', async () => {
    const h = await makeNetflixHarness();
    disposers.push(() => h.adapter.dispose());
    await expect(h.adapter.seek(95.5)).resolves.toBeUndefined();
    expect(h.player.seekCalls).toEqual([95500]);
    expect(h.media.currentTimeWrites).toHaveLength(0);
  });

  test('play_pause_via_bridge', async () => {
    const h = await makeNetflixHarness();
    disposers.push(() => h.adapter.dispose());
    await expect(h.adapter.play()).resolves.toBeUndefined();
    await expect(h.adapter.pause()).resolves.toBeUndefined();
    expect(h.player.playCount).toBe(1);
    expect(h.player.pauseCount).toBe(1);
    expect(h.media.playCalls).toBe(0);
    expect(h.media.pauseCalls).toBe(0);
  });

  test('bridge_timeout_rejects', async () => {
    vi.useFakeTimers();
    const doc = document.implementation.createHTMLDocument('no-bridge');
    const media = new FakeMedia();
    const adapter = new NetflixAdapter(media.asVideo(), doc);
    disposers.push(() => adapter.dispose());

    let seekSettled = false;
    const seekErr = rejection(adapter.seek(10)).finally(() => {
      seekSettled = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(seekSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await seekErr;
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('NETFLIX_BRIDGE_TIMEOUT');

    const playErr = rejection(adapter.play());
    await vi.advanceTimersByTimeAsync(2000);
    const err2 = await playErr;
    expect(err2).toBeInstanceOf(AdapterError);
    expect((err2 as AdapterError).code).toBe('NETFLIX_BRIDGE_TIMEOUT');
    expect(media.currentTimeWrites).toHaveLength(0);
  });

  test('bridge_reports_missing_api', async () => {
    const doc = document.implementation.createHTMLDocument('no-netflix');
    installNetflixBridge({}, doc);
    const replies: NetflixBridgeResponse[] = [];
    doc.addEventListener(NETFLIX_RES_EVENT, (e) => replies.push((e as CustomEvent<NetflixBridgeResponse>).detail));
    doc.dispatchEvent(new CustomEvent(NETFLIX_CMD_EVENT, { detail: { id: 7, op: 'seek', ms: 1000 } }));
    expect(replies).toEqual([{ id: 7, ok: false, error: 'NETFLIX_API_UNAVAILABLE' }]);

    const media = new FakeMedia();
    const adapter = new NetflixAdapter(media.asVideo(), doc);
    disposers.push(() => adapter.dispose());
    const err = await rejection(adapter.seek(10));
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('NETFLIX_API_UNAVAILABLE');
    expect(media.currentTimeWrites).toHaveLength(0);
  });

  test('detect_selects_netflix', async () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.body.innerHTML = '<div class="watch-video"><video></video></div>';
    const adapter = await selectAdapter(new URL('https://www.netflix.com/watch/81234567') as unknown as Location, doc);
    expect(adapter).toBeInstanceOf(NetflixAdapter);
    expect(adapter?.site).toBe('netflix');
    adapter?.dispose();
    expect(
      await selectAdapter(new URL('https://www.netflix.com/browse') as unknown as Location, doc, 0),
    ).toBeNull();
  });
});
