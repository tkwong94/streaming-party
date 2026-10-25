import WebSocket, { type RawData } from 'ws';
import {
  CLIENT_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientChatMessage,
  type ClientMessage,
  type ClientMessageType,
  type ControlMessage,
  type CreateMessage,
  type ErrorCode,
  type JoinMessage,
  type PingMessage,
  type PositionReportMessage,
  type ServerMessage,
  type SetModeMessage,
  type StateCause,
} from '@test01/protocol';
import { buildChatMessage } from './chat.js';
import { canControl, canSetMode } from './permissions.js';
import { applyControl, applyHostReport, stateAt } from './playback.js';
import { BadMessageWindow, ParticipantLimits } from './ratelimit.js';
import type { Room, RoomRegistry } from './rooms.js';

/** Close code after JOIN_DENIED, ROOM_FULL or UNSUPPORTED_VERSION. */
export const CLOSE_POLICY = 4001;
/** Close code after 10 BAD_MESSAGE replies within 10 s. */
export const CLOSE_TOO_MANY_BAD_MESSAGES = 4008;

export interface ServerContext {
  registry: RoomRegistry;
  counters: { received: Record<ClientMessageType, number> };
  /** Live connection per joined participant ID. */
  connections: Map<string, Connection>;
}

// One message for wrong secret and unknown room, so rooms cannot be enumerated.
const JOIN_DENIED_MESSAGE = 'Room not found or secret incorrect';
const ROOM_FULL_MESSAGE = 'Room is full';

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** Message type of a rejected frame when it is recognisable, for ErrorMessage.inReplyTo. */
function peekType(raw: string): ClientMessageType | undefined {
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
    const type = (data as { type?: unknown }).type;
    return typeof type === 'string' && (CLIENT_MESSAGE_TYPES as readonly string[]).includes(type)
      ? (type as ClientMessageType)
      : undefined;
  } catch {
    return undefined;
  }
}

/** One WebSocket bound to at most one participant. */
export class Connection {
  participantId: string | undefined;
  private alive = true;
  // Per connection, and a connection is bound to at most one participant.
  private readonly limits = new ParticipantLimits();
  private readonly badMessages = new BadMessageWindow();

  constructor(
    private readonly ctx: ServerContext,
    readonly ws: WebSocket,
  ) {
    ws.on('message', (data) => this.onFrame(rawToString(data)));
    ws.on('pong', () => this.onPong());
    ws.on('close', () => this.detach());
    // Protocol errors (e.g. maxPayload -> 1009) close the socket; nothing else to do.
    ws.on('error', () => {});
  }

  /** Called once per heartbeat interval: terminate if the previous ping went unanswered. */
  heartbeat(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.alive) {
      this.ws.terminate();
      return;
    }
    this.alive = false;
    this.ws.ping();
  }

  send(message: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private onPong(): void {
    this.alive = true;
    if (this.participantId === undefined) return;
    const participant = this.ctx.registry.participant(this.participantId);
    if (participant) participant.lastPongServerMs = Date.now();
  }

  private onFrame(raw: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const result = parseClientMessage(raw);
    if (!result.ok) {
      this.sendError(result.code, result.reason, peekType(raw));
      if (result.code === 'UNSUPPORTED_VERSION') this.ws.close(CLOSE_POLICY, 'unsupported version');
      return;
    }
    const message = result.value;
    // Counted for every accepted frame, before permission and rate-limit checks (read by e2e tests).
    this.ctx.counters.received[message.type]++;
    if (!this.limits.allow(message.type)) return this.sendError('RATE_LIMITED', 'too many messages, slow down', message.type);
    try {
      this.dispatch(message);
    } catch {
      this.sendError('INTERNAL', 'internal server error', message.type);
    }
  }

  private dispatch(message: ClientMessage): void {
    switch (message.type) {
      case 'create':
        return this.onCreate(message);
      case 'join':
        return this.onJoin(message);
      case 'leave':
        return this.onLeave();
      case 'control':
        return this.onControl(message);
      case 'position_report':
        return this.onPositionReport(message);
      case 'set_mode':
        return this.onSetMode(message);
      case 'chat':
        return this.onChat(message);
      case 'ping':
        return this.onPing(message);
    }
  }

  /** Answered before join too: clients estimate the clock offset while connecting. */
  private onPing(message: PingMessage): void {
    this.send({ v: PROTOCOL_VERSION, type: 'pong', clientSentMs: message.clientSentMs, serverMs: Date.now() });
  }

  /** Relayed once to every participant including the sender; nothing is kept. */
  private onChat(message: ClientChatMessage): void {
    const room = this.joinedRoom('chat');
    if (!room) return;
    const sender = room.participants.get(this.participantId!)!;
    this.broadcast(room, { v: PROTOCOL_VERSION, type: 'chat', message: buildChatMessage(sender, message.text, Date.now()) });
  }

  private onCreate(message: CreateMessage): void {
    if (this.participantId !== undefined) return this.sendError('ALREADY_JOINED', 'already in a room', 'create');
    const { registry } = this.ctx;
    const { room, host, secret } = registry.create({
      nickname: message.nickname,
      titleUrl: message.titleUrl,
      site: message.site,
    });
    this.bind(host.id);
    this.send({
      v: PROTOCOL_VERSION,
      type: 'created',
      roomId: room.id,
      secret,
      selfId: host.id,
      hostId: room.hostParticipantId,
      mode: room.mode,
      participants: registry.participantsWire(room),
      state: registry.stateWire(room),
    });
  }

  private onJoin(message: JoinMessage): void {
    if (this.participantId !== undefined) return this.sendError('ALREADY_JOINED', 'already in a room', 'join');
    const { registry } = this.ctx;
    const result = registry.join(message.roomId, message.secret, message.nickname);
    if (!result.ok) {
      this.sendError(result.code, result.code === 'ROOM_FULL' ? ROOM_FULL_MESSAGE : JOIN_DENIED_MESSAGE, 'join');
      this.ws.close(CLOSE_POLICY, result.code === 'ROOM_FULL' ? 'room full' : 'join denied');
      return;
    }
    const { room, participant } = result;
    this.bind(participant.id);
    this.send({
      v: PROTOCOL_VERSION,
      type: 'joined',
      roomId: room.id,
      selfId: participant.id,
      hostId: room.hostParticipantId,
      mode: room.mode,
      participants: registry.participantsWire(room),
      // Extrapolated with hostBuffering taken into account.
      state: stateAt(room.state, Date.now()),
    });
    this.broadcastParticipants(room, participant.id);
  }

  private onControl(message: ControlMessage): void {
    const room = this.joinedRoom('control');
    if (!room) return;
    const senderId = this.participantId!;
    if (!canControl(room, senderId)) {
      return this.sendError('FORBIDDEN_CONTROL', 'only the host can control playback in host-only mode', 'control');
    }
    Object.assign(room.state, applyControl(room.state, message.action, message.positionSec, senderId, Date.now()));
    this.broadcastState(room, 'control');
  }

  /** Host reports rebase the room state; guest reports are ignored without a reply. */
  private onPositionReport(message: PositionReportMessage): void {
    const room = this.joinedRoom('position_report');
    if (!room || room.hostParticipantId !== this.participantId) return;
    Object.assign(room.state, applyHostReport(room.state, message, Date.now()));
    this.broadcastState(room, 'host_report');
  }

  private onSetMode(message: SetModeMessage): void {
    const room = this.joinedRoom('set_mode');
    if (!room) return;
    const senderId = this.participantId!;
    if (!canSetMode(room, senderId)) return this.sendError('FORBIDDEN_MODE', 'only the host can change the control mode', 'set_mode');
    room.mode = message.mode;
    this.broadcast(room, { v: PROTOCOL_VERSION, type: 'mode', mode: room.mode, changedBy: senderId });
  }

  /** Room of the bound participant, or undefined after answering NOT_JOINED. */
  private joinedRoom(inReplyTo: ClientMessageType): Room | undefined {
    const participant = this.participantId === undefined ? undefined : this.ctx.registry.participant(this.participantId);
    const room = participant && this.ctx.registry.get(participant.roomId);
    if (!room) this.sendError('NOT_JOINED', 'join a room first', inReplyTo);
    return room;
  }

  private broadcastState(room: Room, cause: StateCause): void {
    this.broadcast(room, { v: PROTOCOL_VERSION, type: 'state', cause, state: { ...room.state } });
  }

  private broadcast(room: Room, message: ServerMessage): void {
    for (const id of room.participants.keys()) this.ctx.connections.get(id)?.send(message);
  }

  private onLeave(): void {
    if (this.participantId === undefined) return this.sendError('NOT_JOINED', 'join a room first', 'leave');
    this.detach();
    this.ws.close(1000, 'left');
  }

  private bind(participantId: string): void {
    this.participantId = participantId;
    this.ctx.connections.set(participantId, this);
  }

  /** Removes the bound participant (leave, socket close, heartbeat timeout) and tells the rest of the room. */
  private detach(): void {
    const participantId = this.participantId;
    if (participantId === undefined) return;
    this.participantId = undefined;
    this.ctx.connections.delete(participantId);
    const result = this.ctx.registry.leave(participantId);
    if (result.room && !result.deleted) this.broadcastParticipants(result.room);
  }

  private broadcastParticipants(room: Room, exceptId?: string): void {
    const message: ServerMessage = {
      v: PROTOCOL_VERSION,
      type: 'participants',
      hostId: room.hostParticipantId,
      participants: this.ctx.registry.participantsWire(room),
    };
    for (const id of room.participants.keys()) {
      if (id !== exceptId) this.ctx.connections.get(id)?.send(message);
    }
  }

  private sendError(code: ErrorCode, message: string, inReplyTo?: ClientMessageType): void {
    this.send({ v: PROTOCOL_VERSION, type: 'error', code, message, ...(inReplyTo ? { inReplyTo } : {}) });
    if (code === 'BAD_MESSAGE' && this.badMessages.record() && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(CLOSE_TOO_MANY_BAD_MESSAGES, 'too many bad messages');
    }
  }
}
