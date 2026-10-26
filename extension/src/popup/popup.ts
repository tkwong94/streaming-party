import type { ActionResponse, RuntimeRequest, StatusResponse } from '../content/main.js';
import { errorText } from './error-text.js';

const DEFAULT_SERVER_URL = 'ws://127.0.0.1:8787/ws';

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const ui = {
  unsupported: el<HTMLElement>('unsupported'),
  serverUrl: el<HTMLInputElement>('server-url'),
  nickname: el<HTMLInputElement>('nickname'),
  createSection: el<HTMLElement>('create-section'),
  create: el<HTMLButtonElement>('create'),
  joinSection: el<HTMLElement>('join-section'),
  joinServer: el<HTMLElement>('join-server'),
  joinRoom: el<HTMLElement>('join-room'),
  join: el<HTMLButtonElement>('join'),
  partySection: el<HTMLElement>('party-section'),
  inviteUrl: el<HTMLInputElement>('invite-url'),
  copy: el<HTMLButtonElement>('copy'),
  leave: el<HTMLButtonElement>('leave'),
  status: el<HTMLElement>('status'),
};

let tabId: number | null = null;
// Server address of the captured invite from the last status; named in join errors.
let pendingServerUrl: string | undefined;

function show(node: HTMLElement, visible: boolean): void {
  node.classList.toggle('hidden', !visible);
}

function setStatus(text: string): void {
  ui.status.textContent = text;
}

function showError(code: string, serverUrl?: string): void {
  setStatus(errorText(code, serverUrl));
}

async function send<T>(req: RuntimeRequest): Promise<T | null> {
  if (tabId === null) return null;
  try {
    return (await chrome.tabs.sendMessage(tabId, req)) as T;
  } catch {
    // No content script on this tab.
    return null;
  }
}

function render(status: StatusResponse | null): void {
  const supported = status?.site != null;
  show(ui.unsupported, !supported);
  const inParty = status?.inParty === true;
  show(ui.createSection, supported && !inParty);
  show(ui.partySection, inParty);
  ui.inviteUrl.value = status?.inviteUrl ?? '';
  const pending = supported && !inParty ? status?.pendingInvite ?? null : null;
  pendingServerUrl = pending?.serverUrl;
  show(ui.joinSection, pending !== null);
  ui.joinServer.textContent = pending?.serverUrl ?? '';
  ui.joinRoom.textContent = pending?.roomId ?? '';
}

async function refresh(): Promise<void> {
  render(await send<StatusResponse>({ kind: 'test01/status' }));
}

function readNickname(): string | null {
  const nickname = ui.nickname.value.trim();
  if (!nickname) {
    setStatus('Enter a nickname first.');
    return null;
  }
  return nickname;
}

async function withBusy(action: () => Promise<void>): Promise<void> {
  for (const b of [ui.create, ui.join, ui.leave]) b.disabled = true;
  setStatus('');
  try {
    await action();
  } finally {
    for (const b of [ui.create, ui.join, ui.leave]) b.disabled = false;
  }
}

ui.create.addEventListener('click', () =>
  withBusy(async () => {
    const nickname = readNickname();
    if (!nickname) return;
    const serverUrl = ui.serverUrl.value.trim() || DEFAULT_SERVER_URL;
    await chrome.storage.local.set({ serverUrl, nickname });
    const res = await send<ActionResponse>({ kind: 'test01/create', serverUrl, nickname });
    if (!res) return showError('UNSUPPORTED_PAGE');
    if (!res.ok) return showError(res.error, serverUrl);
    await chrome.storage.session.set({ [`invite:${tabId}`]: res.inviteUrl });
    await refresh();
  }),
);

ui.join.addEventListener('click', () =>
  withBusy(async () => {
    const nickname = readNickname();
    if (!nickname) return;
    await chrome.storage.local.set({ nickname });
    const serverUrl = pendingServerUrl;
    const res = await send<ActionResponse>({ kind: 'test01/join', nickname });
    if (!res) return showError('UNSUPPORTED_PAGE');
    if (!res.ok) return showError(res.error, serverUrl);
    await refresh();
  }),
);

ui.leave.addEventListener('click', () =>
  withBusy(async () => {
    await send<ActionResponse>({ kind: 'test01/leave' });
    await chrome.storage.session.remove(`invite:${tabId}`);
    await refresh();
  }),
);

ui.copy.addEventListener('click', async () => {
  if (!ui.inviteUrl.value) return;
  await navigator.clipboard.writeText(ui.inviteUrl.value);
  setStatus('Invite link copied.');
});

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  const saved = await chrome.storage.local.get(['serverUrl', 'nickname']);
  ui.serverUrl.value = typeof saved.serverUrl === 'string' ? saved.serverUrl : DEFAULT_SERVER_URL;
  ui.nickname.value = typeof saved.nickname === 'string' ? saved.nickname : '';
  await refresh();
}

void init();
