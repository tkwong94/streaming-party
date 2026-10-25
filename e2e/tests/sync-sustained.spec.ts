// R4: 5 minutes of playback through the 150 +/- 50 ms delay proxy stays within 2.0 s.
// Fixture-page evidence only; not Netflix or real-internet acceptance (H1/H2).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncServerHandle } from '@test01/server';
import { startDelayProxy, type DelayProxy } from '../support/delay-proxy.js';
import { startFixtureServer } from '../support/fixture-server.js';
import { recordScenario, REPORT_PATH, sampleDiffs, TOLERANCE_SEC } from '../support/measure.js';
import { EXTENSION_DIR, launchProfile, openParty, partyInfoOf, player, sidebar, startServer } from '../support/party.js';

const SETTLE_MS = 3000;

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let server: SyncServerHandle;
let proxy: DelayProxy;
const contexts: BrowserContext[] = [];

test.afterAll(async () => {
  for (const c of contexts) await c.close();
  await proxy?.close();
  await fixture?.close();
  await server?.close();
});

test('sustained_5_minutes', async () => {
  test.setTimeout(420_000);
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error(`${EXTENSION_DIR} missing; run: npm run build:test -w extension`);
  }
  server = await startServer();
  proxy = await startDelayProxy(server.wsUrl, { meanMs: 150, jitterMs: 50 });
  fixture = await startFixtureServer();
  const profile = async (name: string) => {
    const ctx = await launchProfile(name);
    contexts.push(ctx);
    return ctx;
  };
  const host = await openParty(await profile('sustain-host'), 'host', {
    url: `${fixture.url}/watch/fixture?v=sustained`,
    nickname: 'Host',
    serverUrl: proxy.wsUrl,
  });
  const inviteUrl = partyInfoOf(host).inviteUrl!;
  const guests: Page[] = [];
  for (const name of ['sustain-guest1', 'sustain-guest2']) {
    guests.push(await openParty(await profile(name), 'guest', { url: inviteUrl, nickname: name }));
  }
  await expect(sidebar(host, '.participants li')).toHaveCount(3, { timeout: 10_000 });

  await player(host).play();
  await host.waitForTimeout(SETTLE_MS);
  const r = await sampleDiffs(host, guests, { intervalMs: 1000, durationMs: 300_000 });
  const playingOk = r.samples.every((s) => s.paused.every((p) => !p));
  const passed = r.maxAbsDiffSec <= TOLERANCE_SEC && playingOk;
  recordScenario({ scenario: 'sustained_5_minutes', maxAbsDiffSec: r.maxAbsDiffSec, sampleCount: r.samples.length, passed });
  const perGuestMax = guests.map((_, i) => Math.max(...r.samples.map((s) => Math.abs(s.diffs[i]!))));
  test.info().annotations.push(
    { type: 'maxAbsDiffSec', description: String(r.maxAbsDiffSec) },
    { type: 'perGuestMaxAbsDiffSec', description: JSON.stringify(perGuestMax) },
    { type: 'sampleCount', description: String(r.samples.length) },
    { type: 'proxyFrames', description: JSON.stringify(proxy.frames) },
  );

  expect(existsSync(REPORT_PATH)).toBe(true);
  expect(playingOk, 'all players playing in every sample').toBe(true);
  expect(r.samples.length).toBeGreaterThanOrEqual(300);
  expect(r.maxAbsDiffSec).toBeLessThanOrEqual(TOLERANCE_SEC);
});
