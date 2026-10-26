// Wire protocol v1 shared by the sync server and the extension. Frozen once merged:
// any change to a message shape requires a new PROTOCOL_VERSION and a reviewed plan.

export const PROTOCOL_VERSION = 1 as const;
export const MAX_PARTICIPANTS = 10;
export const SYNC_TOLERANCE_MS = 2000;
export const DRIFT_REALIGN_MS = 1000;
export const MAX_MESSAGE_BYTES = 4096;
export const CHAT_MAX_CHARS = 500;
export const NICKNAME_MAX_CHARS = 32;
export const MAX_POSITION_SEC = 86400;
export const TITLE_URL_MAX_CHARS = 2048;
export const ERROR_MESSAGE_MAX_CHARS = 500;

/** 16 CSPRNG bytes, base64url. Used for room IDs and participant IDs. */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** 32 CSPRNG bytes, base64url. */
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** 12 CSPRNG bytes, base64url. */
export const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export const SITES = ['netflix', 'youtube', 'fixture'] as const;
export type Site = (typeof SITES)[number];

export const CONTROL_MODES = ['everyone', 'host_only'] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];

export const CONTROL_ACTIONS = ['play', 'pause', 'seek'] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const STATE_CAUSES = ['control', 'host_report'] as const;
export type StateCause = (typeof STATE_CAUSES)[number];

export const ERROR_CODES = [
  'BAD_MESSAGE',
  'UNSUPPORTED_VERSION',
  'JOIN_DENIED',
  'ROOM_FULL',
  'NOT_JOINED',
  'ALREADY_JOINED',
  'FORBIDDEN_CONTROL',
  'FORBIDDEN_MODE',
  'RATE_LIMITED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const CLIENT_MESSAGE_TYPES = [
  'create',
  'join',
  'leave',
  'control',
  'position_report',
  'set_mode',
  'chat',
  'ping',
] as const;
export type ClientMessageType = (typeof CLIENT_MESSAGE_TYPES)[number];

export const SERVER_MESSAGE_TYPES = [
  'created',
  'joined',
  'state',
  'participants',
  'mode',
  'chat',
  'pong',
  'error',
] as const;
export type ServerMessageType = (typeof SERVER_MESSAGE_TYPES)[number];

export interface PlaybackStateWire {
  playing: boolean;
  positionSec: number;
  updatedAtServerMs: number;
  seq: number;
  updatedBy: string;
  hostBuffering: boolean;
}

export interface ParticipantWire {
  id: string;
  nickname: string;
  isHost: boolean;
  joinedAtServerMs: number;
}

export interface ChatMessageWire {
  id: string;
  participantId: string;
  nickname: string;
  text: string;
  sentAtServerMs: number;
}

interface Envelope<T extends string> {
  v: typeof PROTOCOL_VERSION;
  type: T;
}

// Client -> server

export interface CreateMessage extends Envelope<'create'> {
  nickname: string;
  site: Site;
  titleUrl: string;
}

export interface JoinMessage extends Envelope<'join'> {
  roomId: string;
  secret: string;
  nickname: string;
}

export type LeaveMessage = Envelope<'leave'>;

export interface ControlMessage extends Envelope<'control'> {
  action: ControlAction;
  positionSec: number;
  clientSeq: number;
}

export interface PositionReportMessage extends Envelope<'position_report'> {
  positionSec: number;
  playing: boolean;
  buffering: boolean;
}

export interface SetModeMessage extends Envelope<'set_mode'> {
  mode: ControlMode;
}

export interface ClientChatMessage extends Envelope<'chat'> {
  text: string;
}

export interface PingMessage extends Envelope<'ping'> {
  clientSentMs: number;
}

export type ClientMessage =
  | CreateMessage
  | JoinMessage
  | LeaveMessage
  | ControlMessage
  | PositionReportMessage
  | SetModeMessage
  | ClientChatMessage
  | PingMessage;

// Server -> client

export interface CreatedMessage extends Envelope<'created'> {
  roomId: string;
  secret: string;
  selfId: string;
  hostId: string;
  mode: ControlMode;
  participants: ParticipantWire[];
  state: PlaybackStateWire;
}

export interface JoinedMessage extends Envelope<'joined'> {
  roomId: string;
  selfId: string;
  hostId: string;
  mode: ControlMode;
  participants: ParticipantWire[];
  /** Extrapolated to the server's current time. */
  state: PlaybackStateWire;
}

export interface StateMessage extends Envelope<'state'> {
  cause: StateCause;
  state: PlaybackStateWire;
}

export interface ParticipantsMessage extends Envelope<'participants'> {
  hostId: string;
  participants: ParticipantWire[];
}

export interface ModeMessage extends Envelope<'mode'> {
  mode: ControlMode;
  changedBy: string;
}

export interface ServerChatMessage extends Envelope<'chat'> {
  message: ChatMessageWire;
}

export interface PongMessage extends Envelope<'pong'> {
  clientSentMs: number;
  serverMs: number;
}

export interface ErrorMessage extends Envelope<'error'> {
  code: ErrorCode;
  /** Human-readable; never contains secrets. */
  message: string;
  /** Client message type when the rejected frame was parseable. */
  inReplyTo?: ClientMessageType;
}

export type ServerMessage =
  | CreatedMessage
  | JoinedMessage
  | StateMessage
  | ParticipantsMessage
  | ModeMessage
  | ServerChatMessage
  | PongMessage
  | ErrorMessage;
