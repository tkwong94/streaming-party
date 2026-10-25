// Party-flow helpers: the real sync server, the built test extension and popup driving.
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, type InviteLink } from '@test01/protocol';
import { createSyncServer, type SyncServerHandle } from '@test01/server';
import WebSocket from 'ws';
import { launchWithExtension } from './launch.js';

export const EXTENSION_DIR = fileURLToPath(new URL('../../extension/dist-test/', import.meta.url));
export const SERVER_PORT = 8787;
export const SERVER_URL = `ws://127.0.0.1:${SERVER_PORT}/ws`;

export function startPartyServer(): Promise<SyncServerHandle> {
  return createSyncServer({ port: SERVER_PORT, host: '127.0.0.1' });
}

/** Chromium derives an unpacked extension's ID from its absolute path: sha256, first 32 hex digits mapped to a-p. */
export function extensionIdFor(dir: string): string {
  const hex = createHash('sha256').update(realpathSync(dir).replace(/\/$/, '')).digest('hex').slice(0, 32);
  return Array.from(hex, (c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export interface Participant {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/** One browser profile with the test extension, its watch tab already loaded. */
export async function openParticipant(profileName: string, url: string): Promise<Participant> {
  const context = await launchWithExtension(EXTENSION_DIR, { profileName });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url);
  await page.evaluate(() => (window as any).__fixture.ready);
  return { context, page, close: () => context.close() };
}

/**
 * Opens popup.html in a background tab of the same window. The watch tab stays active, so the
 * popup's chrome.tabs.query({ active: true, currentWindow: true }) resolves to the watch tab.
 */
export async function openPopup(p: Participant): Promise<Page> {
  const popup = await p.context.newPage();
  await p.page.bringToFront();
  await popup.goto(`chrome-extension://${extensionIdFor(EXTENSION_DIR)}/popup.html`);
  return popup;
}

export async function createParty(p: Participant, nickname: string): Promise<string> {
  const popup = await openPopup(p);
  await popup.fill('#server-url', SERVER_URL);
  await popup.fill('#nickname', nickname);
  await popup.click('#create');
  await expect(popup.locator('#invite-url')).not.toHaveValue('', { timeout: 10_000 });
  const inviteUrl = await popup.inputValue('#invite-url');
  await popup.close();
  return inviteUrl;
}

/** Clicks Join in the popup and returns the popup's status text afterwards. */
export async function joinParty(p: Participant, nickname: string): Promise<string> {
  const popup = await openPopup(p);
  await expect(popup.locator('#join-section')).toBeVisible({ timeout: 10_000 });
  await popup.fill('#nickname', nickname);
  await popup.click('#join');
  await expect(popup.locator('#join')).toBeEnabled({ timeout: 10_000 });
  const status = (await popup.locator('#status').textContent()) ?? '';
  await popup.close();
  return status;
}

export function sidebar(page: Page, selector: string): Locator {
  return page.locator(`test01-sidebar ${selector}`);
}

export function video(page: Page) {
  return {
    paused: () => page.evaluate(() => ((window as any).__fixture.video as HTMLVideoElement).paused),
    time: () => page.evaluate(() => ((window as any).__fixture.video as HTMLVideoElement).currentTime),
    play: () => page.evaluate(() => ((window as any).__fixture.video as HTMLVideoElement).play()),
    pause: () => page.evaluate(() => ((window as any).__fixture.video as HTMLVideoElement).pause()),
    seek: (sec: number) =>
      page.evaluate(
        (s) =>
          new Promise<void>((resolve) => {
            const v = (window as any).__fixture.video as HTMLVideoElement;
            v.addEventListener('seeked', () => resolve(), { once: true });
            v.currentTime = s;
          }),
        sec,
      ),
  };
}

/** A protocol-level participant (no browser) used to fill a room. */
export async function joinRaw(invite: InviteLink, nickname: string): Promise<WebSocket> {
  const ws = new WebSocket(invite.s);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const m = JSON.parse(String(data)) as { type: string; code?: string };
      if (m.type === 'joined') {
        ws.off('message', onMessage);
        resolve();
      } else if (m.type === 'error') {
        ws.off('message', onMessage);
        reject(new Error(`raw join failed: ${m.code}`));
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'join', roomId: invite.r, secret: invite.k, nickname }));
  });
  return ws;
}
