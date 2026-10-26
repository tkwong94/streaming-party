import { describe, expect, it, vi } from 'vitest';
import { buildInviteUrl, type InviteLink } from '@test01/protocol';
import { captureInvite, createPendingInviteStore } from '../src/content/invite-capture.js';

const TITLE = 'https://www.youtube.com/watch?v=abc';
const INVITE: InviteLink = {
  v: 1,
  s: 'wss://example.trycloudflare.com/ws',
  r: 'R'.repeat(22),
  k: 'K'.repeat(43),
  titleUrl: TITLE,
};

function fakeWindow(href: string) {
  return {
    location: { href },
    history: { state: { keep: true } as unknown, replaceState: vi.fn() },
  };
}

describe('invite capture', () => {
  it('captures_invite_and_strips_fragment', () => {
    const url = buildInviteUrl(INVITE);
    expect(url.startsWith(`${TITLE}#test01=`)).toBe(true);
    const win = fakeWindow(url);
    const store = createPendingInviteStore();

    const captured = captureInvite(win, store);

    expect(captured).toEqual(INVITE);
    expect(store.get()).toEqual(INVITE);
    expect(win.history.replaceState).toHaveBeenCalledTimes(1);
    const [state, , newUrl] = win.history.replaceState.mock.calls[0]!;
    expect(newUrl).toBe(TITLE);
    expect(String(newUrl)).not.toContain('#test01=');
    expect(state).toEqual({ keep: true });
  });

  it('ignores_invalid_invite', () => {
    const valid = buildInviteUrl(INVITE);
    const prefixEnd = valid.indexOf('#test01=') + '#test01='.length;
    const payload = valid.slice(prefixEnd);
    const shortRoom = Buffer.from(JSON.stringify({ v: 1, s: INVITE.s, r: 'short', k: INVITE.k })).toString('base64url');
    const httpServer = Buffer.from(JSON.stringify({ v: 1, s: 'https://evil.example/ws', r: INVITE.r, k: INVITE.k })).toString('base64url');
    const tampered = [
      // First payload char flipped: '{' no longer decodes, JSON breaks.
      `${TITLE}#test01=${payload[0] === 'f' ? 'e' : 'f'}${payload.slice(1)}`,
      `${TITLE}#test01=${payload.slice(0, -3)}`,
      `${TITLE}#test01=!!!not-base64`,
      `${TITLE}#test01=${shortRoom}`,
      `${TITLE}#test01=${httpServer}`,
      `${TITLE}#test01=`,
    ];

    for (const href of tampered) {
      const win = fakeWindow(href);
      const store = createPendingInviteStore();
      expect(captureInvite(win, store), href).toBeNull();
      expect(store.get(), href).toBeNull();
      expect(win.history.replaceState, href).not.toHaveBeenCalled();
      expect(win.location.href).toBe(href);
    }
  });

  it('leaves_urls_without_invite_alone', () => {
    for (const href of [TITLE, `${TITLE}#t=30`]) {
      const win = fakeWindow(href);
      const store = createPendingInviteStore();
      expect(captureInvite(win, store)).toBeNull();
      expect(win.history.replaceState).not.toHaveBeenCalled();
    }
  });
});
