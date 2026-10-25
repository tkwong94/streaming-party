import type { Room } from './rooms.js';

/** Any member in mode 'everyone'; only the host in mode 'host_only'. */
export function canControl(room: Room, participantId: string): boolean {
  if (!room.participants.has(participantId)) return false;
  return room.mode === 'everyone' || room.hostParticipantId === participantId;
}

/** Only the host may change the control mode. */
export function canSetMode(room: Room, participantId: string): boolean {
  return room.participants.has(participantId) && room.hostParticipantId === participantId;
}
