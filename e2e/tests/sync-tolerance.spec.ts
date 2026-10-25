// R4/R3: host-vs-guest sync within 2.0 s through a 150 +/- 50 ms per-direction delay proxy.
// Fixture-page evidence only; not Netflix or real-internet acceptance (H1/H2).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncServerHandle } from '@test01/server';
import { startDelayProxy, type DelayProxy } from '../support/delay-proxy.js';
import { startFixtureServer } from '../support/fixture-server.js';
import { readFixture, recordScenario, sampleDiffs, TOLERANCE_SEC } from '../support/measure.js';
import { controlCount, EXTENSION_DIR, launchProfile, openParty, partyInfoOf, player, sidebar, startServer } from '../support/party.js';

test.describe.configure({ mode: 'serial' });

const SETTLE_MS = 3000;
/** Just over the sync engine's ECHO_SUPPRESS_MS (extension/src/sync/engine.ts). */
const ECHO_SUPPRESS_WAIT_MS = 1200;
const WINDOW = { intervalMs: 250, durationMs: 10_000 };
const DELAY = { meanMs: 150, jitterMs: 50 };

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let server: SyncServerHandle;
let proxy: DelayProxy;
const contexts: BrowserContext[] = [];
let host: Page;
let guests: Page[] = [];
let inviteUrl: string;

async function profile(name: string): Promise<BrowserContext> {
  const ctx = await launchProfile(name);
  contexts.push(ctx);
  return ctx;
}

function note(type: string, value: unknown): void {
  test.info().annotations.push({ type, description: typeof value === 'string' ? value : JSON.stringify(value) });
}

/** Samples the window, writes the report entry, then asserts (so failures are still reported). */
async function measure(
  scenario: string,
  guestPages: Page[],
  expectPaused: boolean,
  extra: { ok: boolean; label?: string } = { ok: true },
): Promise<void> {
  const r = await sampleDiffs(host, guestPages, WINDOW);
  const pausedOk = r.samples.every((s) => s.paused.every((p) => p === expectPaused));
  const passed = r.maxAbsDiffSec <= TOLERANCE_SEC && pausedOk && extra.ok;
  recordScenario({ scenario, maxAbsDiffSec: r.maxAbsDiffSec, sampleCount: r.samples.length, passed });
  note('maxAbsDiffSec', r.maxAbsDiffSec);
  note('sampleCount', r.samples.length);
  note('pausedFlagsAsExpected', pausedOk);
  note('firstLastSample', [r.samples[0], r.samples[r.samples.length - 1]]);
  if (extra.label) expect(extra.ok, extra.label).toBe(true);
  expect(pausedOk, `every sample paused=${expectPaused}`).toBe(true);
  expect(r.maxAbsDiffSec).toBeLessThanOrEqual(TOLERANCE_SEC);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error(`${EXTENSION_DIR} missing; run: npm run build:test -w extension`);
  }
  server = await startServer();
  proxy = await startDelayProxy(server.wsUrl, DELAY);
  fixture = await startFixtureServer();
  // The host types the proxy address, so the invite routes every guest through the proxy too.
  host = await openParty(await profile('sync-host'), 'host', {
    url: `${fixture.url}/watch/fixture?v=sync`,
    nickname: 'Host',
    serverUrl: proxy.wsUrl,
  });
  inviteUrl = partyInfoOf(host).inviteUrl!;
  for (const name of ['sync-guest1', 'sync-guest2']) {
    guests.push(await openParty(await profile(name), 'guest', { url: inviteUrl, nickname: name }));
  }
  await expect(sidebar(host, '.participants li')).toHaveCount(3, { timeout: 10_000 });
});

test.afterAll(async () => {
  for (const c of contexts) await c.close();
  await proxy?.close();
  await fixture?.close();
  await server?.close();
});

test('tolerance_after_play', async () => {
  test.setTimeout(60_000);
  await player(host).play();
  await host.waitForTimeout(SETTLE_MS);
  await measure('tolerance_after_play', guests, false);
  note('proxyFrames', proxy.frames);
});

test('tolerance_after_pause', async () => {
  test.setTimeout(60_000);
  await host.waitForTimeout(ECHO_SUPPRESS_WAIT_MS);
  await player(host).pause();
  await host.waitForTimeout(SETTLE_MS);
  await measure('tolerance_after_pause', guests, true);
});

test('tolerance_after_seek', async () => {
  test.setTimeout(60_000);
  // Seek during playback, the harder case: guests must land on 300 s and keep pace.
  await host.waitForTimeout(ECHO_SUPPRESS_WAIT_MS);
  await player(host).play();
  await host.waitForTimeout(SETTLE_MS);
  await player(host).seek(300);
  await host.waitForTimeout(SETTLE_MS);
  const h = await readFixture(host);
  note('hostPositionAfterSettle', h.positionSec);
  await measure('tolerance_after_seek', guests, false, {
    ok: h.positionSec >= 300 && h.positionSec < 300 + SETTLE_MS / 1000 + 2,
    label: `host position ${h.positionSec} is just after 300 s`,
  });
});

test('tolerance_late_join', async () => {
  test.setTimeout(120_000);
  // The room has been playing since the seek; make sure 30 s of playback precede the join.
  await host.waitForTimeout(30_000);
  const before = await readFixture(host);
  note('hostPositionAtJoin', before.positionSec);
  const late = await openParty(await profile('sync-late'), 'guest', { url: inviteUrl, nickname: 'Late' });
  await expect(sidebar(host, '.participants li')).toHaveCount(4, { timeout: 10_000 });
  await late.waitForTimeout(SETTLE_MS);
  try {
    await measure('tolerance_late_join', [...guests, late], false);
  } finally {
    // Back to 1 host + 2 guests for the buffering scenarios.
    await late.context().close();
    contexts.splice(contexts.indexOf(late.context()), 1);
    await expect(sidebar(host, '.participants li')).toHaveCount(3, { timeout: 10_000 });
  }
});

test('tolerance_after_guest_buffering', async () => {
  test.setTimeout(60_000);
  const [g1] = guests;
  const controlsBefore = controlCount(server);
  await g1!.waitForTimeout(ECHO_SUPPRESS_WAIT_MS);
  const stall = g1!.evaluate(() => (window as any).__fixture.stall(3000) as Promise<void>);
  await host.waitForTimeout(1500);
  note('hostPausedDuringGuestStall', (await readFixture(host)).paused);
  // stall() resolves after play(), i.e. after the guest's 'playing' event.
  await stall;
  await g1!.waitForTimeout(SETTLE_MS);
  note('controlsDuringGuestStall', controlCount(server) - controlsBefore);
  await measure('tolerance_after_guest_buffering', guests, false);
});

test('tolerance_after_host_buffering', async () => {
  test.setTimeout(60_000);
  const controlsBefore = controlCount(server);
  await host.waitForTimeout(ECHO_SUPPRESS_WAIT_MS);
  const stallStart = Date.now();
  const stall = host.evaluate(() => (window as any).__fixture.stall(3000) as Promise<void>);
  let guestsPausedAtMs: number | null = null;
  while (Date.now() - stallStart < 2900) {
    const states = await Promise.all(guests.map(readFixture));
    if (states.every((s) => s.paused)) {
      guestsPausedAtMs = Date.now() - stallStart;
      break;
    }
    await host.waitForTimeout(100);
  }
  note('guestsPausedMsAfterStallStart', guestsPausedAtMs);
  await stall;
  await host.waitForTimeout(SETTLE_MS);
  note('controlsDuringHostStall', controlCount(server) - controlsBefore);
  await measure('tolerance_after_host_buffering', guests, false, {
    ok: guestsPausedAtMs !== null,
    label: 'all guests paused during the host stall',
  });
});
