import { PROTOCOL_VERSION, ROOM_ID_PATTERN, SECRET_PATTERN } from './messages.js';
import { isValidTitleUrl } from './validate.js';

/** Bearer credential: whoever holds the link can join the room. */
export interface InviteLink {
  v: typeof PROTOCOL_VERSION;
  /** Server URL, ws: or wss:. */
  s: string;
  /** Room ID. */
  r: string;
  /** Room secret. */
  k: string;
  /** Watch-page URL without fragment. */
  titleUrl: string;
}

export const INVITE_FRAGMENT_PREFIX = '#test01=';
export const SERVER_URL_MAX_CHARS = 512;
const PAYLOAD_MAX_CHARS = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isServerUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > SERVER_URL_MAX_CHARS) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function stripFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

function encodeBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(encoded: string): string | null {
  if (!BASE64URL.test(encoded) || encoded.length % 4 === 1) return null;
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (encoded.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Reject non-canonical encodings so a tampered payload cannot decode to the same value.
    return encodeBase64Url(text) === encoded ? text : null;
  } catch {
    return null;
  }
}

function isInviteFields(s: unknown, r: unknown, k: unknown): boolean {
  return isServerUrl(s) && typeof r === 'string' && ROOM_ID_PATTERN.test(r) && typeof k === 'string' && SECRET_PATTERN.test(k);
}

/** `<titleUrl without fragment>#test01=<base64url(JSON {v,s,r,k})>`. Throws TypeError on invalid input. */
export function buildInviteUrl(invite: InviteLink): string {
  const titleUrl = stripFragment(invite.titleUrl);
  if (invite.v !== PROTOCOL_VERSION || !isInviteFields(invite.s, invite.r, invite.k) || !isValidTitleUrl(titleUrl, true)) {
    throw new TypeError('invalid invite link');
  }
  const payload = JSON.stringify({ v: PROTOCOL_VERSION, s: invite.s, r: invite.r, k: invite.k });
  return `${titleUrl}${INVITE_FRAGMENT_PREFIX}${encodeBase64Url(payload)}`;
}

/** Returns null for any URL that is not a well-formed v1 invite. */
export function parseInviteUrl(url: string): InviteLink | null {
  if (typeof url !== 'string') return null;
  const hash = url.indexOf('#');
  if (hash === -1 || !url.startsWith(INVITE_FRAGMENT_PREFIX, hash)) return null;

  const encoded = url.slice(hash + INVITE_FRAGMENT_PREFIX.length);
  if (encoded.length === 0 || encoded.length > PAYLOAD_MAX_CHARS) return null;
  const text = decodeBase64Url(encoded);
  if (text === null) return null;

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const keys = Object.keys(data).sort();
  if (keys.join(',') !== 'k,r,s,v') return null;

  const { v, s, r, k } = data as Record<string, unknown>;
  if (v !== PROTOCOL_VERSION || !isInviteFields(s, r, k)) return null;

  const titleUrl = url.slice(0, hash);
  if (!isValidTitleUrl(titleUrl, true)) return null;
  return { v: PROTOCOL_VERSION, s: s as string, r: r as string, k: k as string, titleUrl };
}
