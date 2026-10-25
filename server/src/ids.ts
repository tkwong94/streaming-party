import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 16 CSPRNG bytes, base64url (22 chars, 128 bits). */
export function newRoomId(): string {
  return randomBytes(16).toString('base64url');
}

/** 32 CSPRNG bytes, base64url (43 chars). Independent of the room ID. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** 16 CSPRNG bytes, base64url (22 chars). */
export function newParticipantId(): string {
  return randomBytes(16).toString('base64url');
}

/** SHA-256 of the secret; the only form in which a secret is kept in memory. */
export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Constant-time comparison of a stored hash with the hash of a candidate secret. */
export function secretMatches(hash: Buffer, candidate: string): boolean {
  const candidateHash = hashSecret(candidate);
  return hash.length === candidateHash.length && timingSafeEqual(hash, candidateHash);
}
