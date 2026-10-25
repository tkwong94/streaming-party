import {
  MAX_PARTICIPANTS,
  MAX_POSITION_SEC,
  type ControlMode,
  type ParticipantWire,
  type PlaybackStateWire,
  type Site,
} from '@test01/protocol';
import { hashSecret, newParticipantId, newRoomId, newSecret, secretMatches } from './ids.js';

export interface Participant {
  readonly id: string;
  readonly roomId: string;
  readonly nickname: string;
  readonly joinedAtServerMs: number;
  lastPongServerMs: number;
}

export type PlaybackState = PlaybackStateWire;

export interface Room {
  readonly id: string;
  /** SHA-256 of the room secret; the plain secret is never stored. */
  readonly secretHash: Buffer;
  hostParticipantId: string;
  mode: ControlMode;
  readonly titleUrl: string;
  readonly site: Site;
  readonly createdAtServerMs: number;
  /** Insertion order is join order. */
  readonly participants: Map<string, Participant>;
  readonly state: PlaybackState;
}

export interface CreateRoomInput {
  nickname: string;
  titleUrl: string;
  site: Site;
}

export type JoinResult =
  | { ok: true; room: Room; participant: Participant }
  | { ok: false; code: 'JOIN_DENIED' | 'ROOM_FULL' };

export interface LeaveResult {
  room?: Room;
  newHostId?: string;
  deleted: boolean;
}

// Compared against when the room does not exist, so unknown rooms cost the same as wrong secrets.
const ABSENT_ROOM_HASH = hashSecret(newSecret());

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly roomOfParticipant = new Map<string, string>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  create(input: CreateRoomInput): { room: Room; host: Participant; secret: string } {
    const now = this.now();
    const secret = newSecret();
    const roomId = newRoomId();
    const host = this.newParticipant(roomId, input.nickname, now);
    const room: Room = {
      id: roomId,
      secretHash: hashSecret(secret),
      hostParticipantId: host.id,
      mode: 'everyone',
      titleUrl: input.titleUrl,
      site: input.site,
      createdAtServerMs: now,
      participants: new Map([[host.id, host]]),
      state: {
        playing: false,
        positionSec: 0,
        updatedAtServerMs: now,
        seq: 0,
        updatedBy: host.id,
        hostBuffering: false,
      },
    };
    this.rooms.set(room.id, room);
    this.roomOfParticipant.set(host.id, room.id);
    return { room, host, secret };
  }

  join(roomId: string, secret: string, nickname: string): JoinResult {
    const room = this.rooms.get(roomId);
    const matches = secretMatches(room?.secretHash ?? ABSENT_ROOM_HASH, secret);
    if (!room || !matches) return { ok: false, code: 'JOIN_DENIED' };
    if (room.participants.size >= MAX_PARTICIPANTS) return { ok: false, code: 'ROOM_FULL' };
    const participant = this.newParticipant(room.id, nickname, this.now());
    room.participants.set(participant.id, participant);
    this.roomOfParticipant.set(participant.id, room.id);
    return { ok: true, room, participant };
  }

  /** Removes a participant; transfers host to the earliest-joined member or deletes the emptied room. */
  leave(participantId: string): LeaveResult {
    const roomId = this.roomOfParticipant.get(participantId);
    if (roomId === undefined) return { deleted: false };
    this.roomOfParticipant.delete(participantId);
    const room = this.rooms.get(roomId);
    if (!room) return { deleted: false };
    room.participants.delete(participantId);

    if (room.participants.size === 0) {
      this.rooms.delete(room.id);
      return { room, deleted: true };
    }
    if (room.hostParticipantId !== participantId) return { room, deleted: false };

    let next: Participant | undefined;
    for (const p of room.participants.values()) {
      if (!next || p.joinedAtServerMs < next.joinedAtServerMs) next = p;
    }
    room.hostParticipantId = next!.id;
    return { room, newHostId: next!.id, deleted: false };
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  participant(participantId: string): Participant | undefined {
    const roomId = this.roomOfParticipant.get(participantId);
    return roomId === undefined ? undefined : this.rooms.get(roomId)?.participants.get(participantId);
  }

  participantsWire(room: Room): ParticipantWire[] {
    return [...room.participants.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      isHost: p.id === room.hostParticipantId,
      joinedAtServerMs: p.joinedAtServerMs,
    }));
  }

  /** Playback state extrapolated to the server's current time. */
  stateWire(room: Room): PlaybackStateWire {
    const now = this.now();
    const { state } = room;
    const elapsedSec = state.playing ? Math.max(0, now - state.updatedAtServerMs) / 1000 : 0;
    return {
      ...state,
      positionSec: Math.min(MAX_POSITION_SEC, state.positionSec + elapsedSec),
      updatedAtServerMs: now,
    };
  }

  private newParticipant(roomId: string, nickname: string, now: number): Participant {
    return { id: newParticipantId(), roomId, nickname: nickname.trim(), joinedAtServerMs: now, lastPongServerMs: now };
  }
}
