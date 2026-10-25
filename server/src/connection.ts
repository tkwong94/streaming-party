import WebSocket, { type RawData } from 'ws';
import {
  CLIENT_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type ClientMessageType,
  type CreateMessage,
  type ErrorCode,
  type JoinMessage,
  type ServerMessage,
} from '@test01/protocol';
import type { Room, RoomRegistry } from './rooms.js';

/** Close code after JOIN_DENIED, ROOM_FULL or UNSUPPORTED_VERSION. */
export const CLOSE_POLICY = 4001;

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
      default:
        // control, position_report, set_mode, chat and ping handlers are added by T04/T05.
        if (this.participantId === undefined) return this.sendError('NOT_JOINED', 'join a room first', message.type);
        return this.sendError('BAD_MESSAGE', 'message type not supported by this server', message.type);
    }
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
      state: registry.stateWire(room),
    });
    this.broadcastParticipants(room, participant.id);
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
  }
}
