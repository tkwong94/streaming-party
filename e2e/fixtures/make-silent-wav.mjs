// Generates the fixture media: 600 s of silence, 8 kHz, 8-bit unsigned PCM, mono WAV (~4.8 MB).
// Usage: node e2e/fixtures/make-silent-wav.mjs [outPath]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLE_RATE = 8000;
export const DURATION_SEC = 600;
export const DEFAULT_WAV_PATH = fileURLToPath(new URL('./video-page/media/silent-600s.wav', import.meta.url));

export function makeSilentWav(durationSec = DURATION_SEC, sampleRate = SAMPLE_RATE) {
  const dataSize = durationSec * sampleRate; // 1 byte per sample, mono
  const buf = Buffer.alloc(44 + dataSize, 0x80); // 0x80 is silence for unsigned 8-bit PCM
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // channels
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28); // byte rate
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

export function writeSilentWav(outPath = DEFAULT_WAV_PATH) {
  const target = resolve(outPath);
  mkdirSync(dirname(target), { recursive: true });
  const buf = makeSilentWav();
  writeFileSync(target, buf);
  return { path: target, size: buf.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { path, size } = writeSilentWav(process.argv[2]);
  console.log(`wrote ${path} (${size} bytes)`);
}
