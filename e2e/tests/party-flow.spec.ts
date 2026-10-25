// Full party flow with the built test extension (dist-test) against the real sync server.
import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { MAX_PARTICIPANTS, parseInviteUrl } from '@test01/protocol';
import type { SyncServerHandle } from '@test01/server';
import { startFixtureServer } from '../support/fixture-server.js';
import {
  createParty,
  EXTENSION_DIR,
  joinParty,
  joinRaw,
  openParticipant,
  sidebar,
  startPartyServer,
  video,
  type Participant,
} from '../support/party.js';

test.describe.configure({ mode: 'serial' });

/** Just over the sync engine's ECHO_SUPPRESS_MS (extension/src/sync/engine.ts). */
const ECHO_SUPPRESS_WAIT_MS = 1200;

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let server: SyncServerHandle;
let host: Participant;
let guest: Participant;
let inviteUrl: string;
const extras: WebSocket[] = [];
const others: Participant[] = [];

test.beforeAll(async () => {
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error(`${EXTENSION_DIR} missing; run: npm run build:test -w extension`);
  }
  server = await startPartyServer();
  fixture = await startFixtureServer();
  host = await openParticipant('party-host', `${fixture.url}/watch/fixture?v=party`);
});

test.afterAll(async () => {
  for (const ws of extras) ws.close();
  for (const p of others) await p.close();
  await guest?.close();
  await host?.close();
  await fixture?.close();
  await server?.close();
});

test('e2e_host_creates_party_and_sidebar_appears', async () => {
  test.setTimeout(90_000);
  inviteUrl = await createParty(host, 'Hosty');
  expect(parseInviteUrl(inviteUrl)?.s).toBe('ws://127.0.0.1:8787/ws');
  await expect(sidebar(host.page, '.participants li')).toHaveCount(1);
  await expect(sidebar(host.page, '.participants li .badge')).toHaveText('Host');
});

test('e2e_guest_joins_via_invite', async () => {
  test.setTimeout(90_000);
  guest = await openParticipant('party-guest', inviteUrl);
  // invite-capture strips the fragment from the address bar.
  expect(guest.page.url()).not.toContain('#test01=');
  await joinParty(guest, 'Guesty');
  await expect(sidebar(guest.page, '.participants li')).toHaveCount(2);
  await expect(sidebar(host.page, '.participants li')).toHaveCount(2);
});

test('e2e_play_pause_seek_sync', async () => {
  const h = video(host.page);
  const g = video(guest.page);
  await h.play();
  await expect.poll(g.paused, { timeout: 5000 }).toBe(false);

  await h.pause();
  await expect.poll(g.paused, { timeout: 5000 }).toBe(true);

  await h.seek(120);
  await expect.poll(async () => Math.abs((await g.time()) - 120), { timeout: 5000 }).toBeLessThanOrEqual(1);

  // Guest control works too in 'everyone' mode. The guest engine ignores local events of the kind it
  // applied itself within ECHO_SUPPRESS_MS (1 s), so act like a user who clicks after that window.
  await guest.page.waitForTimeout(ECHO_SUPPRESS_WAIT_MS);
  await g.play();
  await expect.poll(h.paused, { timeout: 5000 }).toBe(false);
  await guest.page.waitForTimeout(ECHO_SUPPRESS_WAIT_MS);
  await g.pause();
  await expect.poll(h.paused, { timeout: 5000 }).toBe(true);
  const drift = Math.abs((await h.time()) - (await g.time()));
  test.info().annotations.push({ type: 'paused-drift-sec', description: drift.toFixed(3) });
  expect(drift).toBeLessThanOrEqual(1);
});

test('e2e_chat_roundtrip', async () => {
  const input = sidebar(guest.page, '.chat-input');
  await input.fill('hello from guest');
  await input.press('Enter');
  await expect(sidebar(host.page, '.chat-msg .chat-text').last()).toHaveText('hello from guest', { timeout: 5000 });
  await expect(sidebar(guest.page, '.chat-msg .chat-text').last()).toHaveText('hello from guest');
});

test('e2e_eleventh_join_room_full', async () => {
  test.setTimeout(90_000);
  const invite = parseInviteUrl(inviteUrl)!;
  // host + guest + 8 protocol-level clients = MAX_PARTICIPANTS.
  for (let i = 0; i < MAX_PARTICIPANTS - 2; i++) extras.push(await joinRaw(invite, `filler${i + 1}`));
  await expect(sidebar(host.page, '.participants li')).toHaveCount(MAX_PARTICIPANTS);

  const eleventh = await openParticipant('party-eleventh', inviteUrl);
  others.push(eleventh);
  const popupStatus = await joinParty(eleventh, 'Eleven');
  expect(popupStatus).toContain('full');
  await expect(sidebar(eleventh.page, '.status')).toContainText('Room full');
  await expect(sidebar(host.page, '.participants li')).toHaveCount(MAX_PARTICIPANTS);

  for (const ws of extras.splice(0)) ws.close();
  await expect(sidebar(host.page, '.participants li')).toHaveCount(2, { timeout: 10_000 });
});

test('e2e_guest_leaves_from_sidebar', async () => {
  await sidebar(guest.page, '.leave').click();
  await expect(guest.page.locator('test01-sidebar')).toHaveCount(0);
  await expect(sidebar(host.page, '.participants li')).toHaveCount(1, { timeout: 10_000 });
  // The guest's player is no longer driven by the party.
  await video(host.page).play();
  await guest.page.waitForTimeout(1500);
  expect(await video(guest.page).paused()).toBe(true);
});
