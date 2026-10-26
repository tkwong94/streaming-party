// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorText } from '../src/popup/error-text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const POPUP_HTML = readFileSync(resolve(HERE, '../src/popup/popup.html'), 'utf8');
const TAB_ID = 7;

type Reply = Record<string, unknown>;

interface FakeChrome {
  sendMessage: ReturnType<typeof vi.fn>;
}

function installChrome(status: Reply, actionReply: Reply): FakeChrome {
  const sendMessage = vi.fn(async (_tabId: number, req: { kind: string }) =>
    req.kind === 'test01/status' ? status : actionReply,
  );
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      query: vi.fn(async () => [{ id: TAB_ID }]),
      sendMessage,
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      session: { set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    },
  };
  return { sendMessage };
}

async function loadPopup(fake: FakeChrome): Promise<void> {
  const body = /<body>([\s\S]*)<\/body>/.exec(POPUP_HTML)?.[1] ?? '';
  document.body.innerHTML = body;
  vi.resetModules();
  await import('../src/popup/popup.js');
  // init() has rendered once the status request was answered.
  await vi.waitFor(() => expect(fake.sendMessage).toHaveBeenCalledWith(TAB_ID, { kind: 'test01/status' }));
  await new Promise((r) => setTimeout(r, 0));
}

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function statusText(): string {
  return document.getElementById('status')?.textContent ?? '';
}

const CREATE_STATUS: Reply = { site: 'youtube', inParty: false, pendingInvite: null, inviteUrl: null };
const JOIN_URL = 'wss://a.trycloudflare.com/ws';
const JOIN_STATUS: Reply = {
  site: 'youtube',
  inParty: false,
  pendingInvite: { serverUrl: JOIN_URL, roomId: 'AAAAAAAAAAAAAAAAAAAAAA' },
  inviteUrl: null,
};

async function clickCreate(error: string, serverInput: string): Promise<void> {
  const fake = installChrome(CREATE_STATUS, { ok: false, error });
  await loadPopup(fake);
  input('server-url').value = serverInput;
  input('nickname').value = 'Ann';
  document.getElementById('create')!.click();
  await vi.waitFor(() =>
    expect(fake.sendMessage).toHaveBeenCalledWith(TAB_ID, expect.objectContaining({ kind: 'test01/create' })),
  );
}

async function clickJoin(error: string): Promise<void> {
  const fake = installChrome(JOIN_STATUS, { ok: false, error });
  await loadPopup(fake);
  input('nickname').value = 'Bob';
  document.getElementById('join')!.click();
  await vi.waitFor(() =>
    expect(fake.sendMessage).toHaveBeenCalledWith(TAB_ID, expect.objectContaining({ kind: 'test01/join' })),
  );
}

describe('popup_renders_error_with_server_url', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('create CONNECT_REFUSED names the trimmed server-address input', async () => {
    await clickCreate('CONNECT_REFUSED', ' ws://127.0.0.1:9/ws ');
    const expected = errorText('CONNECT_REFUSED', 'ws://127.0.0.1:9/ws');
    await vi.waitFor(() => expect(statusText()).toBe(expected));
  });

  it('join CONNECT_REJECTED names the pending invite server address', async () => {
    await clickJoin('CONNECT_REJECTED');
    const expected = errorText('CONNECT_REJECTED', JOIN_URL);
    await vi.waitFor(() => expect(statusText()).toBe(expected));
  });

  for (const code of ['BAD_SERVER_URL', 'CONNECT_TIMEOUT', 'ROOM_FULL', 'UNSUPPORTED_VERSION']) {
    it(`create renders ${code} via errorText`, async () => {
      await clickCreate(code, 'ws://127.0.0.1:9/ws');
      const expected = errorText(code, 'ws://127.0.0.1:9/ws');
      await vi.waitFor(() => expect(statusText()).toBe(expected));
    });

    it(`join renders ${code} via errorText`, async () => {
      await clickJoin(code);
      const expected = errorText(code, JOIN_URL);
      await vi.waitFor(() => expect(statusText()).toBe(expected));
    });
  }
});
