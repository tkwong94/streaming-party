import { randomBytes } from 'node:crypto';
import type { ChatMessageWire } from '@test01/protocol';
import type { Participant } from './rooms.js';

/** 12 CSPRNG bytes, base64url (16 chars). */
export function newChatId(): string {
  return randomBytes(12).toString('base64url');
}

/** Wire chat message for one relay; the server keeps no copy. */
export function buildChatMessage(sender: Participant, text: string, nowMs: number): ChatMessageWire {
  return {
    id: newChatId(),
    participantId: sender.id,
    nickname: sender.nickname,
    text: text.trim(),
    sentAtServerMs: nowMs,
  };
}
