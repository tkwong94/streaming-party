import { describe, expect, it } from 'vitest';
import { errorText } from '../src/popup/error-text.js';

const GENERIC = 'Could not connect to the server.';

// Exact popup text at eb527ba (extension/src/popup/popup.ts ERROR_TEXT).
const EB527BA_TEXT: Record<string, string> = {
  UNSUPPORTED_PAGE: 'This page is not a supported watch page.',
  NO_PENDING_INVITE: 'No invite found on this page.',
  CONNECT_FAILED: 'Could not connect to the server.',
  JOIN_DENIED: 'The invite is invalid or the party has ended.',
  ROOM_FULL: 'The party is full (10 people).',
  BAD_MESSAGE: 'The server rejected the request. Check your nickname.',
  ALREADY_JOINED: 'Already in a party.',
  RATE_LIMITED: 'Too many requests. Try again shortly.',
};

describe('error_text_specific_messages', () => {
  it('CONNECT_REJECTED names the address and the /ws path without claiming Local Network Access', () => {
    const text = errorText('CONNECT_REJECTED', 'ws://127.0.0.1:8787/ws');
    expect(text).toContain('ws://127.0.0.1:8787/ws');
    expect(text).toContain('/ws path');
    expect(text).not.toContain('Local Network Access');
  });

  it('CONNECT_REFUSED and CONNECT_TIMEOUT contain the server address', () => {
    const u = 'wss://a.trycloudflare.com/ws';
    expect(errorText('CONNECT_REFUSED', u)).toContain(u);
    expect(errorText('CONNECT_TIMEOUT', u)).toContain(u);
  });

  it("renders 'the server address' when serverUrl is missing", () => {
    expect(errorText('CONNECT_REFUSED')).toContain('the server address');
  });

  it('CONNECT_TIMEOUT has the exact duration-free text', () => {
    const text = errorText('CONNECT_TIMEOUT', 'ws://127.0.0.1:9/ws');
    expect(text).toBe(
      "The sync server at ws://127.0.0.1:9/ws did not answer in time. Check that the host's server is running and the address is correct, then try again.",
    );
    expect(text).not.toContain('second');
    expect(text).not.toContain('5000');
    expect(text).not.toContain('8000');
  });

  it('BAD_SERVER_URL explains the required scheme', () => {
    expect(errorText('BAD_SERVER_URL', 'http://x/ws')).toBe('The server address must start with ws:// or wss://.');
  });

  it('no connection code falls back to the generic message', () => {
    for (const code of ['CONNECT_REJECTED', 'CONNECT_REFUSED', 'CONNECT_TIMEOUT', 'BAD_SERVER_URL']) {
      expect(errorText(code, 'ws://127.0.0.1:8787/ws')).not.toBe(GENERIC);
      expect(errorText(code)).not.toBe(GENERIC);
    }
  });

  it('unknown codes render as Error: <code>', () => {
    expect(errorText('INTERNAL')).toBe('Error: INTERNAL');
  });

  it('previous codes keep their exact eb527ba text', () => {
    for (const [code, text] of Object.entries(EB527BA_TEXT)) {
      expect(errorText(code)).toBe(text);
      expect(errorText(code, 'ws://127.0.0.1:8787/ws')).toBe(text);
    }
  });
});
