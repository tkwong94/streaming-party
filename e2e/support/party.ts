// Party-flow helpers: the in-process sync server, the built test extension and popup driving.
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, type InviteLink } from '@test01/protocol';
import { createSyncServer, type SyncServerHandle } from '@test01/server';
import WebSocket from 'ws';
import { launchWithExtension } from './launch.js';

export const EXTENSION_DIR = fileURLToPath(new URL('../../extension/dist-test/', import.meta.url));

/** In-process sync server on loopback with an OS-assigned port. */
export function startServer(): Promise<SyncServerHandle> {
  return createSyncServer({ port: 0, host: '127.0.0.1' });
}

/** Control messages the server has received so far (T03 counters). */
export function controlCount(handle: SyncServerHandle): number {
  return handle.counters.received.control;
}

/** Chromium derives an unpacked extension's ID from its absolute path: sha256, first 32 hex digits mapped to a-p. */
export function extensionIdFor(dir: string): string {
  const hex = createHash('sha256').update(realpathSync(dir).replace(/\/$/, '')).digest('hex').slice(0, 32);
  return Array.from(hex, (c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** A browser profile with the test extension loaded. */
export function launchProfile(profileName: string): Promise<BrowserContext> {
  return launchWithExtension(EXTENSION_DIR, { profileName });
}

export interface OpenPartyOptions {
  /** Watch page for the host, invite URL for a guest. */
  url: string;
  nickname: string;
  /** Host only: server URL typed into the popup. */
  serverUrl?: string;
}

export interface PartyInfo {
  inviteUrl?: string;
  /** Host only: ms from the popup Create click to the invite URL being shown. */
  createMs?: number;
  /** Popup status text after the click. */
  popupStatus: string;
}

const partyInfo = new WeakMap<Page, PartyInfo>();

export function partyInfoOf(page: Page): PartyInfo {
  const info = partyInfo.get(page);
  if (!info) throw new Error('page was not opened with openParty');
  return info;
}

/**
 * Opens popup.html in a background tab of the same window. The watch tab stays active, so the
 * popup's chrome.tabs.query({ active: true, currentWindow: true }) resolves to the watch tab.
 */
async function openPopup(context: BrowserContext, watch: Page): Promise<Page> {
  const popup = await context.newPage();
  await watch.bringToFront();
  await popup.goto(`chrome-extension://${extensionIdFor(EXTENSION_DIR)}/popup.html`);
  return popup;
}

/** Loads the watch page in `context` and creates (host) or joins (guest) a party through the popup. */
export async function openParty(context: BrowserContext, role: 'host' | 'guest', opts: OpenPartyOptions): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(opts.url);
  await page.evaluate(() => (window as any).__fixture.ready);
  const popup = await openPopup(context, page);
  const info: PartyInfo = { popupStatus: '' };
  if (role === 'host') {
    if (opts.serverUrl) await popup.fill('#server-url', opts.serverUrl);
    await popup.fill('#nickname', opts.nickname);
    const t0 = Date.now();
    await popup.click('#create');
    await expect(popup.locator('#invite-url')).not.toHaveValue('', { timeout: 10_000 });
    info.createMs = Date.now() - t0;
    info.inviteUrl = await popup.inputValue('#invite-url');
  } else {
    await expect(popup.locator('#join-section')).toBeVisible({ timeout: 10_000 });
    await popup.fill('#nickname', opts.nickname);
    await popup.click('#join');
    await expect(popup.locator('#join')).toBeEnabled({ timeout: 10_000 });
    info.inviteUrl = opts.url;
  }
  info.popupStatus = (await popup.locator('#status').textContent()) ?? '';
  await popup.close();
  partyInfo.set(page, info);
  return page;
}

export async function readPlayer(page: Page): Promise<{ positionSec: number; paused: boolean; sampledAtMs: number }> {
  return page.evaluate(() => {
    const v = (window as any).__fixture.video as HTMLVideoElement;
    return { positionSec: v.currentTime, paused: v.paused, sampledAtMs: Date.now() };
  });
}

/** User-like player actions on the fixture video (these fire real media events). */
export function player(page: Page) {
  return {
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

export function sidebar(page: Page, selector: string): Locator {
  return page.locator(`test01-sidebar ${selector}`);
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
