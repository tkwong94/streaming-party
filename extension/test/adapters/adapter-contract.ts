// Shared PlayerAdapter contract suite. Every adapter (fixture, YouTube, Netflix)
// registers a harness factory with runAdapterContract.
import { afterEach, describe, expect, test } from 'vitest';
import type { LocalPlayerEvent, PlayerAdapter, Site } from '@test01/protocol';
import type { FakeMedia } from './fake-media.js';

export type MediaEventType = 'play' | 'pause' | 'seeked' | 'waiting' | 'playing';

export type AdapterHarness = {
  adapter: PlayerAdapter;
  media: FakeMedia;
  expectedSite: Site;
  fire(type: MediaEventType): void;
  lastSeekSec(): number | null;
  playCalls(): number;
  pauseCalls(): number;
};

/** Harness for adapters that drive the FakeMedia element directly. */
export function mediaHarness(adapter: PlayerAdapter, media: FakeMedia, expectedSite: Site): AdapterHarness {
  return {
    adapter,
    media,
    expectedSite,
    fire: (type) => {
      media.dispatchEvent(new Event(type));
    },
    lastSeekSec: () => media.currentTimeWrites.at(-1) ?? null,
    playCalls: () => media.playCalls,
    pauseCalls: () => media.pauseCalls,
  };
}

export function runAdapterContract(label: string, makeHarness: () => Promise<AdapterHarness>): void {
  describe('adapter contract [' + label + ']', () => {
    let created: AdapterHarness[] = [];

    async function harness(): Promise<AdapterHarness> {
      const h = await makeHarness();
      created.push(h);
      return h;
    }

    afterEach(() => {
      for (const h of created) h.adapter.dispose();
      created = [];
    });

    test('contract_site_is_declared', async () => {
      const h = await harness();
      expect(h.adapter.site).toBe(h.expectedSite);
    });

    test('contract_position_and_paused_mirror_media', async () => {
      const h = await harness();
      h.media.currentTime = 12.5;
      h.media.paused = true;
      expect(h.adapter.getPositionSec()).toBe(12.5);
      expect(h.adapter.isPaused()).toBe(true);
      h.media.paused = false;
      expect(h.adapter.isPaused()).toBe(false);
    });

    test('contract_play_pause_resolve', async () => {
      const h = await harness();
      await expect(h.adapter.play()).resolves.toBeUndefined();
      expect(h.playCalls()).toBe(1);
      await expect(h.adapter.pause()).resolves.toBeUndefined();
      expect(h.pauseCalls()).toBe(1);
    });

    test('contract_seek_resolves_and_reaches_player', async () => {
      const h = await harness();
      await expect(h.adapter.seek(30)).resolves.toBeUndefined();
      const last = h.lastSeekSec();
      expect(last).not.toBeNull();
      expect(Math.abs((last as number) - 30)).toBeLessThanOrEqual(0.001);
    });

    test('contract_local_events_order', async () => {
      const h = await harness();
      const events: LocalPlayerEvent[] = [];
      h.adapter.onLocalEvent((e) => events.push(e));
      const expectedPositions: number[] = [];
      const sequence: MediaEventType[] = ['play', 'pause', 'seeked', 'waiting', 'playing'];
      sequence.forEach((type, i) => {
        h.media.currentTime = 10 + i * 1.25;
        expectedPositions.push(h.media.currentTime);
        h.fire(type);
        if (type === 'waiting') expect(h.adapter.isBuffering()).toBe(true);
        if (type === 'playing') expect(h.adapter.isBuffering()).toBe(false);
      });
      expect(events.map((e) => e.kind)).toEqual(['play', 'pause', 'seek', 'buffering_start', 'buffering_end']);
      expect(events.map((e) => e.positionSec)).toEqual(expectedPositions);
    });

    test('contract_unsubscribe_and_dispose', async () => {
      const h = await harness();
      const a: LocalPlayerEvent[] = [];
      const b: LocalPlayerEvent[] = [];
      const unsubscribeA = h.adapter.onLocalEvent((e) => a.push(e));
      h.adapter.onLocalEvent((e) => b.push(e));
      unsubscribeA();
      h.fire('play');
      expect(a).toHaveLength(0);
      expect(b).toHaveLength(1);

      h.adapter.dispose();
      h.fire('pause');
      h.fire('seeked');
      expect(a).toHaveLength(0);
      expect(b).toHaveLength(1);
    });
  });
}
