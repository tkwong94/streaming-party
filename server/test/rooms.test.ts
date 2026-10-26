import { describe, expect, it } from 'vitest';
import { MAX_PARTICIPANTS, PARTICIPANT_ID_PATTERN } from '@test01/protocol';
import { RoomRegistry, hashSecret, newParticipantId, newRoomId, newSecret, secretMatches } from '../src/index.js';
import { FIXTURE_TITLE_URL, findValue } from './helpers.js';

const ROOM_INPUT = { nickname: 'Host', titleUrl: FIXTURE_TITLE_URL, site: 'fixture' as const };

function fakeClock(start = 1_000_000) {
  const clock = { t: start, now: () => clock.t };
  return clock;
}

describe('ids', () => {
  it('room ids are 16 random bytes and secrets 32 random bytes, base64url', () => {
    const roomIds = new Set<string>();
    const secrets = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const roomId = newRoomId();
      const secret = newSecret();
      expect(roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(roomId, 'base64url')).toHaveLength(16);
      expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
      roomIds.add(roomId);
      secrets.add(secret);
    }
    expect(roomIds.size).toBe(1000);
    expect(secrets.size).toBe(1000);
    expect(newParticipantId()).toMatch(PARTICIPANT_ID_PATTERN);
  });

  it('secretMatches compares SHA-256 hashes', () => {
    const secret = newSecret();
    const hash = hashSecret(secret);
    expect(hash).toHaveLength(32);
    expect(secretMatches(hash, secret)).toBe(true);
    expect(secretMatches(hash, newSecret())).toBe(false);
    expect(secretMatches(hash, '')).toBe(false);
    expect(secretMatches(Buffer.alloc(3), secret)).toBe(false);
  });
});

describe('RoomRegistry', () => {
  it('create stores only the secret hash and makes the creator host', () => {
    const registry = new RoomRegistry();
    const { room, host, secret } = registry.create(ROOM_INPUT);
    expect(registry.get(room.id)).toBe(room);
    expect(room.hostParticipantId).toBe(host.id);
    expect(room.mode).toBe('everyone');
    expect(room.participants.get(host.id)).toBe(host);
    expect(room.secretHash.equals(hashSecret(secret))).toBe(true);
    expect(findValue(registry, secret)).toEqual([]);
    expect(room.state).toMatchObject({ playing: false, positionSec: 0, seq: 0, updatedBy: host.id, hostBuffering: false });
  });

  it('join accepts the correct secret and trims the nickname', () => {
    const registry = new RoomRegistry();
    const { room, secret } = registry.create(ROOM_INPUT);
    const result = registry.join(room.id, secret, '  Guest  ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.room).toBe(room);
    expect(result.participant.nickname).toBe('Guest');
    expect(registry.participantsWire(room).map((p) => p.isHost)).toEqual([true, false]);
  });

  it('join denies a wrong secret and an unknown room with the same code', () => {
    const registry = new RoomRegistry();
    const { room, secret } = registry.create(ROOM_INPUT);
    expect(registry.join(room.id, newSecret(), 'Guest')).toEqual({ ok: false, code: 'JOIN_DENIED' });
    expect(registry.join(newRoomId(), secret, 'Guest')).toEqual({ ok: false, code: 'JOIN_DENIED' });
    expect(room.participants.size).toBe(1);
  });

  it('join rejects the eleventh participant with ROOM_FULL', () => {
    const registry = new RoomRegistry();
    const { room, secret } = registry.create(ROOM_INPUT);
    for (let i = 1; i < MAX_PARTICIPANTS; i++) expect(registry.join(room.id, secret, `Guest ${i}`).ok).toBe(true);
    expect(room.participants.size).toBe(MAX_PARTICIPANTS);
    expect(registry.join(room.id, secret, 'Late')).toEqual({ ok: false, code: 'ROOM_FULL' });
    expect(room.participants.size).toBe(MAX_PARTICIPANTS);
  });

  it('host leave transfers host to the earliest-joined participant', () => {
    const clock = fakeClock();
    const registry = new RoomRegistry(clock.now);
    const { room, host, secret } = registry.create(ROOM_INPUT);
    clock.t += 10;
    const first = registry.join(room.id, secret, 'First');
    clock.t += 10;
    const second = registry.join(room.id, secret, 'Second');
    if (!first.ok || !second.ok) throw new Error('join failed');
    const result = registry.leave(host.id);
    expect(result).toEqual({ room, newHostId: first.participant.id, deleted: false });
    expect(room.hostParticipantId).toBe(first.participant.id);
    expect(registry.participantsWire(room).find((p) => p.isHost)?.id).toBe(first.participant.id);
  });

  it('guest leave keeps the host', () => {
    const registry = new RoomRegistry();
    const { room, host, secret } = registry.create(ROOM_INPUT);
    const guest = registry.join(room.id, secret, 'Guest');
    if (!guest.ok) throw new Error('join failed');
    expect(registry.leave(guest.participant.id)).toEqual({ room, deleted: false });
    expect(room.hostParticipantId).toBe(host.id);
  });

  it('last leave deletes the room; unknown participant is a no-op', () => {
    const registry = new RoomRegistry();
    const { room, host } = registry.create(ROOM_INPUT);
    expect(registry.leave(host.id)).toEqual({ room, deleted: true });
    expect(registry.get(room.id)).toBeUndefined();
    expect(registry.leave(host.id)).toEqual({ deleted: false });
  });

  it('stateWire extrapolates a playing state to now', () => {
    const clock = fakeClock();
    const registry = new RoomRegistry(clock.now);
    const { room } = registry.create(ROOM_INPUT);
    room.state.playing = true;
    room.state.positionSec = 10;
    clock.t += 2500;
    expect(registry.stateWire(room)).toMatchObject({ playing: true, positionSec: 12.5, updatedAtServerMs: clock.t });
    room.state.playing = false;
    expect(registry.stateWire(room).positionSec).toBe(10);
  });
});
