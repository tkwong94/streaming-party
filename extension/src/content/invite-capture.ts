import { INVITE_FRAGMENT_PREFIX, parseInviteUrl, type InviteLink } from '@test01/protocol';

/** Invite captured from the address bar, waiting for the user to join from the popup. */
export interface PendingInviteStore {
  get(): InviteLink | null;
  set(invite: InviteLink | null): void;
}

export function createPendingInviteStore(): PendingInviteStore {
  let pending: InviteLink | null = null;
  return {
    get: () => pending,
    set: (invite) => {
      pending = invite;
    },
  };
}

export interface CaptureWindow {
  location: { href: string };
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void };
}

/**
 * Runs at document_start: stores a valid invite and removes the fragment from the
 * address bar. Invalid or tampered invites leave the URL untouched.
 */
export function captureInvite(win: CaptureWindow, store: PendingInviteStore): InviteLink | null {
  const href = win.location.href;
  if (!href.includes(INVITE_FRAGMENT_PREFIX)) return null;
  const invite = parseInviteUrl(href);
  if (!invite) return null;
  store.set(invite);
  win.history.replaceState(win.history.state, '', invite.titleUrl);
  return invite;
}
