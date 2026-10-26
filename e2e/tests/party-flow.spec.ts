// Full party flow with the built test extension (dist-test) against the real sync server.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { MAX_PARTICIPANTS, parseInviteUrl } from '@test01/protocol';
import type { SyncServerHandle } from '@test01/server';
import { startFixtureServer } from '../support/fixture-server.js';
import {
  controlCount,
  EXTENSION_DIR,
  joinRaw,
  launchProfile,
  openParty,
  partyInfoOf,
  player,
  readPlayer,
  sidebar,
  startServer,
} from '../support/party.js';

test.describe.configure({ mode: 'serial' });

/** Settle time before checking propagation (card: "within 2.0 s after 3 s"). */
const SETTLE_MS = 3000;
/** Just over the sync engine's ECHO_SUPPRESS_MS (extension/src/sync/engine.ts). */
const ECHO_SUPPRESS_WAIT_MS = 1200;

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let server: SyncServerHandle;
const contexts: BrowserContext[] = [];
let host: Page;
let guest: Page;
let inviteUrl: string;
let controlDelta: number | undefined;
const extras: WebSocket[] = [];

async function profile(name: string): Promise<BrowserContext> {
  const ctx = await launchProfile(name);
  contexts.push(ctx);
  return ctx;
}

async function expectAllMatch(pages: Page[], paused: boolean, positionSec?: number): Promise<void> {
  const states = await Promise.all(pages.map(readPlayer));
  for (const s of states) expect(s.paused).toBe(paused);
  const ref = positionSec ?? states[0]!.positionSec;
  for (const s of states) expect(Math.abs(s.positionSec - ref)).toBeLessThanOrEqual(2.0);
}

test.beforeAll(async () => {
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error(`${EXTENSION_DIR} missing; run: npm run build:test -w extension`);
  }
  server = await startServer();
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  for (const ws of extras) ws.close();
  for (const c of contexts) await c.close();
  await fixture?.close();
  await server?.close();
});

test('e2e_create_and_join_by_invite', async () => {
  test.setTimeout(90_000);
  host = await openParty(await profile('party-host'), 'host', {
    url: `${fixture.url}/watch/fixture?v=party`,
    nickname: 'Hosty',
    serverUrl: server.wsUrl,
  });
  const info = partyInfoOf(host);
  inviteUrl = info.inviteUrl!;
  test.info().annotations.push({ type: 'create-to-invite-ms', description: String(info.createMs) });
  expect(info.createMs!).toBeLessThanOrEqual(2000);
  expect(parseInviteUrl(inviteUrl)?.s).toBe(server.wsUrl);
  await expect(sidebar(host, '.participants li')).toHaveCount(1);
  await expect(sidebar(host, '.participants li .badge')).toHaveText('Host');

  guest = await openParty(await profile('party-guest'), 'guest', { url: inviteUrl, nickname: 'Guesty' });
  // invite-capture strips the fragment from the address bar.
  expect(guest.url()).not.toContain('#test01=');
  for (const page of [host, guest]) {
    await expect(sidebar(page, '.participants li')).toHaveCount(2);
    await expect(sidebar(page, '.participants')).toContainText('Hosty');
    await expect(sidebar(page, '.participants')).toContainText('Guesty');
  }
});

test('e2e_play_pause_seek_propagate', async () => {
  const pages = [host, guest];
  const before = controlCount(server);

  await player(host).play();
  await host.waitForTimeout(SETTLE_MS);
  await expectAllMatch(pages, false);

  await player(guest).pause();
  await host.waitForTimeout(SETTLE_MS);
  await expectAllMatch(pages, true);

  await player(host).seek(120);
  await host.waitForTimeout(SETTLE_MS);
  await expectAllMatch(pages, true, 120);

  controlDelta = controlCount(server) - before;
});

test('e2e_no_control_echo', async () => {
  // Measured across e2e_play_pause_seek_propagate: host play, guest pause, host seek only.
  expect(controlDelta).toBe(3);
});

test('e2e_chat_visible_to_all', async () => {
  const input = sidebar(guest, '.chat-input');
  await input.fill('hello');
  await input.press('Enter');
  for (const page of [host, guest]) {
    await expect(sidebar(page, '.chat-msg .chat-text').last()).toHaveText('hello', { timeout: 2000 });
  }
});

test('e2e_host_only_mode', async () => {
  // The sidebar keeps the checkbox on the confirmed mode until the server's 'mode' broadcast,
  // so click (not check) and wait for the label instead.
  await sidebar(host, '.mode-switch input').click();
  await expect(sidebar(host, '.mode-switch input')).toBeChecked({ timeout: 5000 });
  await expect(sidebar(guest, '.mode-label')).toHaveText('Control: host only', { timeout: 5000 });
  await expect(sidebar(host, '.mode-label')).toHaveText('Control: host only');

  await player(host).play();
  await expect.poll(async () => (await readPlayer(guest)).paused, { timeout: 5000 }).toBe(false);
  const before = controlCount(server);
  // Act after the guest engine's echo window, like a real click would.
  await guest.waitForTimeout(ECHO_SUPPRESS_WAIT_MS);
  await player(guest).pause();
  // The guest engine reverts the blocked pause locally; nothing is sent.
  await expect.poll(async () => (await readPlayer(guest)).paused, { timeout: 5000 }).toBe(false);
  await host.waitForTimeout(1000);
  expect((await readPlayer(host)).paused).toBe(false);
  expect(controlCount(server) - before).toBe(0);
});

test('e2e_eleventh_join_room_full', async () => {
  test.setTimeout(90_000);
  const invite = parseInviteUrl(inviteUrl)!;
  // host + guest + 8 protocol-level clients = MAX_PARTICIPANTS.
  for (let i = 0; i < MAX_PARTICIPANTS - 2; i++) extras.push(await joinRaw(invite, `filler${i + 1}`));
  await expect(sidebar(host, '.participants li')).toHaveCount(MAX_PARTICIPANTS);

  const eleventh = await openParty(await profile('party-eleventh'), 'guest', { url: inviteUrl, nickname: 'Eleven' });
  expect(partyInfoOf(eleventh).popupStatus).toContain('full');
  await expect(sidebar(eleventh, '.status')).toContainText('Room full');
  await expect(sidebar(host, '.participants li')).toHaveCount(MAX_PARTICIPANTS);

  for (const ws of extras.splice(0)) ws.close();
  await expect(sidebar(host, '.participants li')).toHaveCount(2, { timeout: 10_000 });
});

test('e2e_leave_from_sidebar', async () => {
  test.setTimeout(90_000);
  const leaver = await openParty(await profile('party-leaver'), 'guest', { url: inviteUrl, nickname: 'Leaver' });
  await expect(sidebar(host, '.participants li')).toHaveCount(3, { timeout: 10_000 });
  await sidebar(leaver, '.leave').click();
  await expect(leaver.locator('test01-sidebar')).toHaveCount(0);
  await expect(sidebar(host, '.participants li')).toHaveCount(2, { timeout: 10_000 });
});

test('e2e_tab_close_removes_participant', async () => {
  await guest.close();
  await expect(sidebar(host, '.participants li')).toHaveCount(1, { timeout: 10_000 });
  await expect(sidebar(host, '.participants')).not.toContainText('Guesty');
});
