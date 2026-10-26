// R1.1 repair: the fixture origin is marked public (--ip-address-space-overrides), so a page or
// content-script WebSocket to the loopback server is blocked by Local Network Access exactly as on
// youtube.com. Create must still work because the socket lives in the extension service worker.
// TEST01_EXT_DIR selects another unpacked build (e.g. eb527ba for the red run).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { parseInviteUrl } from '@test01/protocol';
import type { SyncServerHandle } from '@test01/server';
import { errorText } from '../../extension/src/popup/error-text.js';
import { startFixtureServer } from '../support/fixture-server.js';
import { PROFILES_DIR, testExtensionDir } from '../support/launch.js';
import {
  launchProfile,
  openParty,
  openPopup,
  partyInfoOf,
  publicOriginArgs,
  sidebar,
  startCountingProxy,
  startPlainHttpServer,
  startServer,
} from '../support/party.js';

test.describe.configure({ mode: 'serial' });

const LNA_ERROR = 'ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS';
const GENERIC_CONNECT_TEXT = 'Could not connect to the server.';
/** Longer than the 30 s MV3 service-worker idle limit and the 45 s probe window. */
const IDLE_WINDOW_MS = 75_000;

const extDir = testExtensionDir();
let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
const contexts: BrowserContext[] = [];
const closers: (() => Promise<void>)[] = [];

/** A fresh profile (no storage from earlier runs) that treats the fixture origin as public. */
async function publicProfile(name: string): Promise<BrowserContext> {
  rmSync(join(PROFILES_DIR, name), { recursive: true, force: true });
  const ctx = await launchProfile(name, { extensionDir: extDir, extraArgs: publicOriginArgs(fixture.url) });
  contexts.push(ctx);
  return ctx;
}

async function server(): Promise<SyncServerHandle> {
  const handle = await startServer();
  closers.push(() => handle.close());
  return handle;
}

function watchUrl(tag: string): string {
  return `${fixture.url}/watch/fixture?v=${tag}`;
}

/** Collects page console lines that report a Local Network Access block. */
function lnaLines(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().includes(LNA_ERROR)) lines.push(msg.text());
  });
  return lines;
}

async function loadWatch(ctx: BrowserContext, tag: string): Promise<Page> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(watchUrl(tag));
  await page.evaluate(() => (window as any).__fixture.ready);
  return page;
}

/** Clicks popup Create and waits until either an invite or a status message is shown. */
async function popupCreate(ctx: BrowserContext, watch: Page, serverUrl: string, nickname: string) {
  const popup = await openPopup(ctx, watch, extDir);
  await popup.fill('#server-url', serverUrl);
  await popup.fill('#nickname', nickname);
  const t0 = Date.now();
  await popup.click('#create');
  await expect
    .poll(async () => (await popup.inputValue('#invite-url')) || ((await popup.locator('#status').textContent()) ?? ''), {
      timeout: 15_000,
      intervals: [50],
    })
    .not.toBe('');
  const elapsedMs = Date.now() - t0;
  const inviteUrl = await popup.inputValue('#invite-url');
  const status = ((await popup.locator('#status').textContent()) ?? '').trim();
  return { popup, inviteUrl, status, elapsedMs };
}

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

test.beforeAll(async () => {
  if (!existsSync(join(extDir, 'manifest.json'))) {
    throw new Error(`${extDir} missing; run: npm run build:test -w extension`);
  }
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
  for (const close of closers.splice(0)) await close().catch(() => {});
  await fixture?.close();
});

test('e2e_public_origin_guard_reproduces_block', async () => {
  const srv = await server();
  const proxy = await startCountingProxy(srv);
  closers.push(() => proxy.close());
  const ctx = await publicProfile('public-guard');
  const page = await loadWatch(ctx, 'guard');
  const lna = lnaLines(page);
  const first = await page.evaluate(
    (url) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(url);
        ws.addEventListener('open', () => resolve('open'));
        ws.addEventListener('error', () => resolve('error'));
        setTimeout(() => resolve('timeout'), 5000);
      }),
    proxy.wsUrl,
  );
  await page.waitForTimeout(500);
  // tcpConnections is logged only: Chromium may open a raw TCP socket that never carries a request.
  // The sync server exposes no WebSocket connection counter; upgrades=0 means no handshake reached it.
  console.log(
    `GUARD_DIAG firstEvent=${first} lnaConsoleLines=${lna.length} tcpConnections=${proxy.connections} requests=${proxy.requests} upgrades=${proxy.upgrades} serverCreates=${srv.counters.received.create}`,
  );
  for (const line of lna) console.log(`GUARD_DIAG_CONSOLE ${line}`);
  expect(first).toBe('error');
  expect(lna.length).toBeGreaterThanOrEqual(1);
  expect(proxy.requests).toBe(0);
  expect(proxy.upgrades).toBe(0);
  expect(srv.counters.received.create).toBe(0);
});

test('e2e_public_origin_create_succeeds', async () => {
  const srv = await server();
  const ctx = await publicProfile('public-create');
  const page = await loadWatch(ctx, 'create');
  const lna = lnaLines(page);
  const result = await popupCreate(ctx, page, srv.wsUrl, 'Hosty');
  // Let a late console report land before counting.
  await page.waitForTimeout(500);
  const creates = srv.counters.received.create;
  console.log(`R11_DIAG lnaConsoleLines=${lna.length} serverCreates=${creates}`);
  for (const line of lna) console.log(`R11_DIAG_CONSOLE ${line}`);
  console.log(`R11_DIAG_POPUP elapsedMs=${result.elapsedMs} status=${JSON.stringify(result.status)}`);

  expect(result.inviteUrl).not.toBe('');
  expect(result.elapsedMs).toBeLessThanOrEqual(2000);
  expect(parseInviteUrl(result.inviteUrl)?.s).toBe(srv.wsUrl);
  expect(lna).toHaveLength(0);
  expect(creates).toBe(1);
});

test('e2e_public_origin_join_and_tab_close', async () => {
  test.setTimeout(90_000);
  const srv = await server();
  const host = await openParty(await publicProfile('public-host'), 'host', {
    url: watchUrl('join'),
    nickname: 'Hosty',
    serverUrl: srv.wsUrl,
    extensionDir: extDir,
  });
  const guest = await openParty(await publicProfile('public-guest'), 'guest', {
    url: partyInfoOf(host).inviteUrl!,
    nickname: 'Guesty',
    extensionDir: extDir,
  });
  await expect(sidebar(host, '.participants li')).toHaveCount(2, { timeout: 10_000 });
  await expect(sidebar(host, '.participants')).toContainText('Guesty');

  const t0 = Date.now();
  await guest.close();
  await expect(sidebar(host, '.participants li')).toHaveCount(1, { timeout: 10_000 });
  await expect(sidebar(host, '.participants')).not.toContainText('Guesty');
  test.info().annotations.push({ type: 'tab-close-removal-ms', description: String(Date.now() - t0) });
});

test('e2e_public_origin_idle_survives', async () => {
  test.setTimeout(IDLE_WINDOW_MS + 90_000);
  const srv = await server();
  // Both participants connect through the proxy so every socket close is counted.
  const proxy = await startCountingProxy(srv);
  closers.push(() => proxy.close());
  const host = await openParty(await publicProfile('public-idle-host'), 'host', {
    url: watchUrl('idle'),
    nickname: 'Hosty',
    serverUrl: proxy.wsUrl,
    extensionDir: extDir,
  });
  const guest = await openParty(await publicProfile('public-idle-guest'), 'guest', {
    url: partyInfoOf(host).inviteUrl!,
    nickname: 'Guesty',
    extensionDir: extDir,
  });
  await expect(sidebar(host, '.participants li')).toHaveCount(2, { timeout: 10_000 });
  for (const page of [host, guest]) {
    expect(await page.evaluate(() => ((window as any).__fixture.video as HTMLVideoElement).paused)).toBe(true);
  }

  const closesBefore = proxy.closes;
  await host.waitForTimeout(IDLE_WINDOW_MS);
  const closesDuring = proxy.closes - closesBefore;
  console.log(`IDLE_DIAG windowMs=${IDLE_WINDOW_MS} socketCloses=${closesDuring} connections=${proxy.connections}`);
  expect(closesDuring).toBe(0);
  await expect(sidebar(host, '.participants li')).toHaveCount(2);

  const input = sidebar(guest, '.chat-input');
  await input.fill('still here');
  await input.press('Enter');
  await expect(sidebar(host, '.chat-msg .chat-text').last()).toHaveText('still here', { timeout: 2000 });
});

test('e2e_refused_shows_specific_error', async () => {
  const url = `ws://127.0.0.1:${await closedPort()}/ws`;
  const ctx = await publicProfile('public-refused');
  const page = await loadWatch(ctx, 'refused');
  const { status, inviteUrl } = await popupCreate(ctx, page, url, 'Hosty');
  console.log(`REFUSED_DIAG status=${JSON.stringify(status)}`);
  expect(inviteUrl).toBe('');
  expect(status).toBe(errorText('CONNECT_REFUSED', url));
  expect(status).not.toBe(GENERIC_CONNECT_TEXT);
});

test('e2e_reachable_http_rejects_upgrade', async () => {
  const plain = await startPlainHttpServer();
  closers.push(() => plain.close());
  const srv = await server();
  const ctx = await publicProfile('public-rejected');
  const page = await loadWatch(ctx, 'rejected');

  const plainUrl = `ws://127.0.0.1:${plain.port}/ws`;
  const first = await popupCreate(ctx, page, plainUrl, 'Hosty');
  await first.popup.close();
  const wrongUrl = `ws://127.0.0.1:${srv.port}/wrong`;
  const second = await popupCreate(ctx, page, wrongUrl, 'Hosty');
  console.log(`REJECTED_DIAG plain=${JSON.stringify(first.status)} wrongPath=${JSON.stringify(second.status)}`);

  expect(first.status).toBe(errorText('CONNECT_REJECTED', plainUrl));
  expect(second.status).toBe(errorText('CONNECT_REJECTED', wrongUrl));
  expect(srv.counters.received.create).toBe(0);
  for (const s of [first.status, second.status]) {
    expect(s).not.toContain('Local Network Access');
    expect(s).not.toBe(GENERIC_CONNECT_TEXT);
  }
});
