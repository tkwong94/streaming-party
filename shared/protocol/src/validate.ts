import {
  CHAT_ID_PATTERN,
  CHAT_MAX_CHARS,
  CLIENT_MESSAGE_TYPES,
  CONTROL_ACTIONS,
  CONTROL_MODES,
  ERROR_CODES,
  ERROR_MESSAGE_MAX_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_PARTICIPANTS,
  MAX_POSITION_SEC,
  NICKNAME_MAX_CHARS,
  PARTICIPANT_ID_PATTERN,
  PROTOCOL_VERSION,
  ROOM_ID_PATTERN,
  SECRET_PATTERN,
  SITES,
  STATE_CAUSES,
  TITLE_URL_MAX_CHARS,
  type ClientMessage,
  type ServerMessage,
} from './messages.js';

export type ParseErrorCode = 'BAD_MESSAGE' | 'UNSUPPORTED_VERSION';

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ParseErrorCode; reason: string };

type Obj = Record<string, unknown>;
type Pred = (value: unknown) => boolean;
/** Returns a reason when the message is invalid, otherwise null. */
type Shape = (message: Obj) => string | null;

const CONTROL_CHAR = /\p{Cc}/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exact-key check: every required key present and valid, no unknown keys. */
function checkShape(value: unknown, required: Record<string, Pred>, optional: Record<string, Pred> = {}): string | null {
  if (!isObject(value)) return 'expected an object';
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) return `unexpected field '${key}'`;
  }
  for (const [key, pred] of Object.entries(required)) {
    if (!Object.hasOwn(value, key)) return `missing field '${key}'`;
    if (!pred(value[key])) return `invalid field '${key}'`;
  }
  for (const [key, pred] of Object.entries(optional)) {
    if (Object.hasOwn(value, key) && !pred(value[key])) return `invalid field '${key}'`;
  }
  return null;
}

function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

const isBool: Pred = (v) => typeof v === 'boolean';
const isFiniteNumber: Pred = (v) => typeof v === 'number' && Number.isFinite(v);
const isTimestamp: Pred = (v) => isFiniteNumber(v) && (v as number) >= 0;
const isNonNegativeInt: Pred = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const isPosition: Pred = (v) => isFiniteNumber(v) && (v as number) >= 0 && (v as number) <= MAX_POSITION_SEC;
const matches = (pattern: RegExp): Pred => (v) => typeof v === 'string' && pattern.test(v);
const oneOf = (values: readonly string[]): Pred => (v) => typeof v === 'string' && values.includes(v);
const isParticipantId = matches(PARTICIPANT_ID_PATTERN);

/** 1-32 characters after trimming, no control characters. */
export function isValidNickname(value: unknown): value is string {
  if (typeof value !== 'string' || CONTROL_CHAR.test(value)) return false;
  const length = codePointLength(value.trim());
  return length >= 1 && length <= NICKNAME_MAX_CHARS;
}

/** 1-500 characters after trimming. */
export function isValidChatText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const length = codePointLength(value.trim());
  return length >= 1 && length <= CHAT_MAX_CHARS;
}

/**
 * Watch-page URL: https, at most 2048 chars, no credentials. Plain http is only
 * accepted on loopback when allowLoopbackHttp is set (the local fixture page).
 */
export function isValidTitleUrl(value: unknown, allowLoopbackHttp: boolean): value is string {
  if (typeof value !== 'string' || value.length > TITLE_URL_MAX_CHARS) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

const isPlaybackState: Pred = (v) =>
  checkShape(v, {
    playing: isBool,
    positionSec: isPosition,
    updatedAtServerMs: isTimestamp,
    seq: isNonNegativeInt,
    updatedBy: isParticipantId,
    hostBuffering: isBool,
  }) === null;

const isParticipant: Pred = (v) =>
  checkShape(v, {
    id: isParticipantId,
    nickname: isValidNickname,
    isHost: isBool,
    joinedAtServerMs: isTimestamp,
  }) === null;

const isParticipantList: Pred = (v) =>
  Array.isArray(v) && v.length >= 1 && v.length <= MAX_PARTICIPANTS && v.every(isParticipant);

const isChatMessage: Pred = (v) =>
  checkShape(v, {
    id: matches(CHAT_ID_PATTERN),
    participantId: isParticipantId,
    nickname: isValidNickname,
    text: isValidChatText,
    sentAtServerMs: isTimestamp,
  }) === null;

const isErrorText: Pred = (v) => typeof v === 'string' && v.length >= 1 && v.length <= ERROR_MESSAGE_MAX_CHARS;

const envelope: Record<string, Pred> = { v: () => true, type: () => true };
const shape = (required: Record<string, Pred>, optional: Record<string, Pred> = {}): Shape =>
  (message) => checkShape(message, { ...envelope, ...required }, optional);

const CLIENT_SHAPES: Record<string, Shape> = {
  create: (m) =>
    shape({ nickname: isValidNickname, site: oneOf(SITES), titleUrl: (v) => typeof v === 'string' })(m) ??
    (isValidTitleUrl(m.titleUrl, m.site === 'fixture') ? null : "invalid field 'titleUrl'"),
  join: shape({ roomId: matches(ROOM_ID_PATTERN), secret: matches(SECRET_PATTERN), nickname: isValidNickname }),
  leave: shape({}),
  control: shape({ action: oneOf(CONTROL_ACTIONS), positionSec: isPosition, clientSeq: isNonNegativeInt }),
  position_report: shape({ positionSec: isPosition, playing: isBool, buffering: isBool }),
  set_mode: shape({ mode: oneOf(CONTROL_MODES) }),
  chat: shape({ text: isValidChatText }),
  ping: shape({ clientSentMs: isFiniteNumber }),
};

const SERVER_SHAPES: Record<string, Shape> = {
  created: shape({
    roomId: matches(ROOM_ID_PATTERN),
    secret: matches(SECRET_PATTERN),
    selfId: isParticipantId,
    hostId: isParticipantId,
    mode: oneOf(CONTROL_MODES),
    participants: isParticipantList,
    state: isPlaybackState,
  }),
  joined: shape({
    roomId: matches(ROOM_ID_PATTERN),
    selfId: isParticipantId,
    hostId: isParticipantId,
    mode: oneOf(CONTROL_MODES),
    participants: isParticipantList,
    state: isPlaybackState,
  }),
  state: shape({ cause: oneOf(STATE_CAUSES), state: isPlaybackState }),
  participants: shape({ hostId: isParticipantId, participants: isParticipantList }),
  mode: shape({ mode: oneOf(CONTROL_MODES), changedBy: isParticipantId }),
  chat: shape({ message: isChatMessage }),
  pong: shape({ clientSentMs: isFiniteNumber, serverMs: isTimestamp }),
  error: shape({ code: oneOf(ERROR_CODES), message: isErrorText }, { inReplyTo: oneOf(CLIENT_MESSAGE_TYPES) }),
};

function utf8ByteLength(text: string): number {
  // Each UTF-16 code unit encodes to at most 3 UTF-8 bytes.
  if (text.length > MAX_MESSAGE_BYTES) return text.length;
  if (text.length * 3 <= MAX_MESSAGE_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
}

function badMessage(reason: string): { ok: false; code: 'BAD_MESSAGE'; reason: string } {
  return { ok: false, code: 'BAD_MESSAGE', reason };
}

// Reasons never echo client-supplied values, so they are safe to send back or log.
function parseWith<T>(raw: string, shapes: Record<string, Shape>): ParseResult<T> {
  if (typeof raw !== 'string') return badMessage('message must be a string');
  if (utf8ByteLength(raw) > MAX_MESSAGE_BYTES) return badMessage(`message too large (max ${MAX_MESSAGE_BYTES} bytes)`);

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return badMessage('message is not valid JSON');
  }
  if (!isObject(data)) return badMessage('message must be a JSON object');

  if (!Object.hasOwn(data, 'v')) return badMessage("missing field 'v'");
  if (typeof data.v !== 'number') return badMessage("invalid field 'v'");
  if (data.v !== PROTOCOL_VERSION) {
    return { ok: false, code: 'UNSUPPORTED_VERSION', reason: `unsupported protocol version (expected ${PROTOCOL_VERSION})` };
  }

  const type = data.type;
  if (typeof type !== 'string' || !Object.hasOwn(shapes, type)) return badMessage('unknown message type');
  const reason = shapes[type]!(data);
  if (reason !== null) return badMessage(`${type}: ${reason}`);
  return { ok: true, value: data as T };
}

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseWith<ClientMessage>(raw, CLIENT_SHAPES);
}

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseWith<ServerMessage>(raw, SERVER_SHAPES);
}
