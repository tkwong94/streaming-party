// R1.1 repair on the real page: popup Create on https://www.youtube.com/watch with default Chromium
// flags reaches the loopback server through the extension service worker. Reported UNTESTED when
// youtube.com is unreachable from this network.
import { expect, test, type BrowserContext } from '@playwright/test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseInviteUrl } from '@test01/protocol';
import type { SyncServerHandle } from '@test01/server';
import { PROFILES_DIR, testExtensionDir } from '../support/launch.js';
import { extensionIdFor, launchProfile, openPopup, startServer } from '../support/party.js';

// Big Buck Bunny (Blender Foundation, CC-BY), same video as youtube-smoke.spec.ts.
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const LNA_ERROR = 'ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS';
const PROFILE = 'youtube-real-create';

const extDir = testExtensionDir();
let server: SyncServerHandle;
let context: BrowserContext | undefined;

test.beforeAll(async () => {
  if (!existsSync(join(extDir, 'manifest.json'))) {
    throw new Error(`${extDir} missing; run: npm run build:test -w extension`);
  }
  server = await startServer();
});

test.afterAll(async () => {
  await context?.close();
  await server?.close();
});

test('youtube_real_create', async () => {
  test.setTimeout(120_000);
  rmSync(join(PROFILES_DIR, PROFILE), { recursive: true, force: true });
  context = await launchProfile(PROFILE, { extensionDir: extDir });
  const page = context.pages()[0] ?? (await context.newPage());
  const lna: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().includes(LNA_ERROR)) lna.push(msg.text());
  });

  let untested: string | null = null;
  try {
    await page.goto(YOUTUBE_URL, { timeout: 30_000 });
    const { hostname, pathname } = new URL(page.url());
    if (hostname !== 'www.youtube.com' || pathname !== '/watch') untested = `UNTESTED: redirected to ${page.url()}`;
  } catch (err) {
    untested = `UNTESTED: youtube unreachable (${String(err).split('\n')[0]})`;
  }
  test.skip(untested !== null, untested ?? '');

  const popup = await openPopup(context, page, extDir);
  await popup.fill('#server-url', server.wsUrl);
  await popup.fill('#nickname', 'Hosty');
  const t0 = Date.now();
  await popup.click('#create');
  await expect(popup.locator('#invite-url')).not.toHaveValue('', { timeout: 10_000 });
  const createMs = Date.now() - t0;
  const inviteUrl = await popup.inputValue('#invite-url');

  const extId = extensionIdFor(extDir);
  const workers = context.serviceWorkers().map((w) => w.url());
  const status = ((await popup.locator('#status').textContent()) ?? '').trim();
  console.log(
    `YT_DIAG createMs=${createMs} serverCreates=${server.counters.received.create} lnaConsoleLines=${lna.length} workers=${JSON.stringify(workers)} status=${JSON.stringify(status)}`,
  );

  expect(createMs).toBeLessThanOrEqual(2000);
  expect(parseInviteUrl(inviteUrl)?.s).toBe(server.wsUrl);
  expect(server.counters.received.create).toBe(1);
  expect(workers.some((u) => u.startsWith(`chrome-extension://${extId}/`) && u.endsWith('/background.js'))).toBe(true);
  expect(lna).toHaveLength(0);
});
