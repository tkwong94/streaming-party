import {
  buildInviteUrl,
  PROTOCOL_VERSION,
  type ChatMessageWire,
  type ClientMessage,
  type ClientMessageType,
  type ControlMode,
  type CreatedMessage,
  type ErrorCode,
  type InviteLink,
  type JoinedMessage,
  type ParticipantWire,
  type PlaybackStateWire,
  type ServerMessage,
  type Site,
  type StateCause,
} from '@test01/protocol';
import { createWsTransport, type WsTransport } from '../transport/ws-transport.js';

export const REPLY_TIMEOUT_MS = 5000;

/** Server error codes pass through unchanged; CONNECT_FAILED covers transport failures. */
export class SessionError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'SessionError';
    this.code = code;
  }
}

export interface SessionEventMap {
  /** 'initial' is emitted once with the state from created/joined. */
  state: { cause: StateCause | 'initial'; state: PlaybackStateWire };
  participants: { hostId: string; participants: ParticipantWire[] };
  mode: { mode: ControlMode; changedBy: string };
  chat: ChatMessageWire;
  error: { code: ErrorCode; message: string; inReplyTo?: ClientMessageType };
  closed: { code: number };
}

export type SessionEvent = keyof SessionEventMap;

type Connect = (serverUrl: string) => Promise<WsTransport>;

function stripFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

function toSessionError(err: unknown): SessionError {
  if (err instanceof SessionError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : undefined;
  return new SessionError(typeof code === 'string' ? code : 'CONNECT_FAILED', message);
}

/** One party membership over one WebSocket, owned by the content script of one tab. */
export class PartySession {
  selfId: string | null = null;
  hostId: string | null = null;
  mode: ControlMode | null = null;
  transport: WsTransport | null = null;

  private readonly listeners = new Map<SessionEvent, Set<(payload: never) => void>>();
  private detach: (() => void)[] = [];
  private busy = false;

  constructor(private readonly connect: Connect = createWsTransport) {}

  get inParty(): boolean {
    return this.transport !== null && this.selfId !== null;
  }

  async create(serverUrl: string, nickname: string, titleUrl: string, site: Site): Promise<{ inviteUrl: string }> {
    const title = stripFragment(titleUrl);
    const { transport, reply } = await this.request(
      serverUrl,
      { v: PROTOCOL_VERSION, type: 'create', nickname, site, titleUrl: title },
      'created',
    );
    let inviteUrl: string;
    try {
      inviteUrl = buildInviteUrl({ v: PROTOCOL_VERSION, s: serverUrl, r: reply.roomId, k: reply.secret, titleUrl: title });
    } catch {
      transport.send({ v: PROTOCOL_VERSION, type: 'leave' });
      transport.close();
      throw new SessionError('INTERNAL', 'could not build the invite link');
    }
    this.enter(transport, reply);
    return { inviteUrl };
  }

  async join(invite: InviteLink, nickname: string): Promise<void> {
    const { transport, reply } = await this.request(
      invite.s,
      { v: PROTOCOL_VERSION, type: 'join', roomId: invite.r, secret: invite.k, nickname },
      'joined',
    );
    this.enter(transport, reply);
  }

  leave(): void {
    const transport = this.transport;
    if (!transport) return;
    transport.send({ v: PROTOCOL_VERSION, type: 'leave' });
    this.reset();
    transport.close();
  }

  on<E extends SessionEvent>(event: E, cb: (payload: SessionEventMap[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb as (payload: never) => void);
    return () => set.delete(cb as (payload: never) => void);
  }

  private emit<E extends SessionEvent>(event: E, payload: SessionEventMap[E]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) {
      (cb as (p: SessionEventMap[E]) => void)(payload);
    }
  }

  private async request<T extends 'created' | 'joined'>(
    serverUrl: string,
    msg: ClientMessage,
    expected: T,
  ): Promise<{ transport: WsTransport; reply: Extract<ServerMessage, { type: T }> }> {
    if (this.busy || this.transport) throw new SessionError('ALREADY_JOINED', 'already in a party');
    this.busy = true;
    try {
      let transport: WsTransport;
      try {
        transport = await this.connect(serverUrl);
      } catch (err) {
        throw toSessionError(err);
      }
      try {
        const reply = await new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
          let settled = false;
          const done = (err: SessionError | null, m?: ServerMessage) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            offMessage();
            offClose();
            if (err) reject(err);
            else resolve(m as Extract<ServerMessage, { type: T }>);
          };
          const timer = setTimeout(() => done(new SessionError('CONNECT_FAILED', 'no reply from the server')), REPLY_TIMEOUT_MS);
          const offMessage = transport.onMessage((m) => {
            if (m.type === expected) done(null, m);
            else if (m.type === 'error') done(new SessionError(m.code, m.message));
          });
          const offClose = transport.onClose((code) => done(new SessionError('CONNECT_FAILED', `connection closed (${code})`)));
          transport.send(msg);
        });
        return { transport, reply };
      } catch (err) {
        transport.close();
        throw err;
      }
    } finally {
      this.busy = false;
    }
  }

  private enter(transport: WsTransport, reply: CreatedMessage | JoinedMessage): void {
    this.transport = transport;
    this.selfId = reply.selfId;
    this.hostId = reply.hostId;
    this.mode = reply.mode;
    this.detach = [transport.onMessage((m) => this.handle(m)), transport.onClose((code) => this.handleClose(code))];
    this.emit('participants', { hostId: reply.hostId, participants: reply.participants });
    this.emit('state', { cause: 'initial', state: reply.state });
  }

  private handle(m: ServerMessage): void {
    switch (m.type) {
      case 'state':
        this.emit('state', { cause: m.cause, state: m.state });
        break;
      case 'participants':
        this.hostId = m.hostId;
        this.emit('participants', { hostId: m.hostId, participants: m.participants });
        break;
      case 'mode':
        this.mode = m.mode;
        this.emit('mode', { mode: m.mode, changedBy: m.changedBy });
        break;
      case 'chat':
        this.emit('chat', m.message);
        break;
      case 'error':
        this.emit('error', { code: m.code, message: m.message, ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}) });
        break;
      default:
        break;
    }
  }

  private handleClose(code: number): void {
    this.reset();
    this.emit('closed', { code });
  }

  private reset(): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.transport = null;
    this.selfId = null;
    this.hostId = null;
    this.mode = null;
  }
}
