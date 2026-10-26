// dist/content.js entry: invite capture, popup message handling and the party controller.
import { buildInviteUrl, type Site } from '@test01/protocol';
import { selectAdapter } from '../adapters/detect.js';
import { captureInvite, createPendingInviteStore, type PendingInviteStore } from './invite-capture.js';
import { PartyController } from './party-controller.js';
import { PartySession, SessionError } from './session.js';

export type RuntimeRequest =
  | { kind: 'test01/status' }
  | { kind: 'test01/create'; serverUrl: string; nickname: string }
  | { kind: 'test01/join'; nickname: string }
  | { kind: 'test01/leave' };

export interface StatusResponse {
  site: Site | null;
  inParty: boolean;
  pendingInvite: { serverUrl: string; roomId: string } | null;
  inviteUrl: string | null;
}

export type ActionResponse = { ok: true; inviteUrl?: string } | { ok: false; error: string };

export function detectSite(href: string): Site | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol === 'https:' && url.hostname === 'www.netflix.com' && url.pathname.startsWith('/watch/')) return 'netflix';
  if (url.protocol === 'https:' && url.hostname === 'www.youtube.com' && url.pathname === '/watch') return 'youtube';
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return 'fixture';
  return null;
}

function errorCode(err: unknown): string {
  return err instanceof SessionError ? err.code : 'INTERNAL';
}

export function createRequestHandler(win: Window, session: PartySession, store: PendingInviteStore) {
  let inviteUrl: string | null = null;
  session.on('closed', () => {
    inviteUrl = null;
  });

  return async (req: RuntimeRequest): Promise<StatusResponse | ActionResponse> => {
    const site = detectSite(win.location.href);
    switch (req.kind) {
      case 'test01/status': {
        const pending = store.get();
        return {
          site,
          inParty: session.inParty,
          pendingInvite: pending ? { serverUrl: pending.s, roomId: pending.r } : null,
          inviteUrl: session.inParty ? inviteUrl : null,
        };
      }
      case 'test01/create': {
        if (!site) return { ok: false, error: 'UNSUPPORTED_PAGE' };
        try {
          const created = await session.create(req.serverUrl, req.nickname, win.location.href, site);
          inviteUrl = created.inviteUrl;
          return { ok: true, inviteUrl };
        } catch (err) {
          return { ok: false, error: errorCode(err) };
        }
      }
      case 'test01/join': {
        if (!site) return { ok: false, error: 'UNSUPPORTED_PAGE' };
        const pending = store.get();
        if (!pending) return { ok: false, error: 'NO_PENDING_INVITE' };
        try {
          await session.join(pending, req.nickname);
          store.set(null);
          inviteUrl = buildInviteUrl(pending);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: errorCode(err) };
        }
      }
      case 'test01/leave':
        session.leave();
        inviteUrl = null;
        return { ok: true };
      default:
        return { ok: false, error: 'BAD_MESSAGE' };
    }
  };
}

function start(): void {
  const store = createPendingInviteStore();
  captureInvite(window, store);
  const session = new PartySession();
  const controller = new PartyController(document, session, (loc, doc) => selectAdapter(loc, doc));
  void controller.start();
  const handle = createRequestHandler(window, session, store);
  chrome.runtime.onMessage.addListener((req: RuntimeRequest, _sender, sendResponse) => {
    if (typeof req?.kind !== 'string' || !req.kind.startsWith('test01/')) return false;
    void handle(req).then((res) => {
      // session.leave() already emitted 'closed' {initiatedLocally:true}; this exitParty() is an idempotent no-op.
      if (req.kind === 'test01/leave') controller.exitParty();
      if (req.kind === 'test01/join' && 'ok' in res && !res.ok) controller.reportJoinError(res.error);
      sendResponse(res);
    });
    return true;
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) start();
