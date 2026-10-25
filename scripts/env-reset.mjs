// npm run env:reset — removes e2e/.profiles and e2e/test-results and regenerates the fixture WAV.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeSilentWav } from '../e2e/fixtures/make-silent-wav.mjs';

for (const rel of ['../e2e/.profiles', '../e2e/test-results']) {
  const dir = fileURLToPath(new URL(rel, import.meta.url));
  rmSync(dir, { recursive: true, force: true });
  console.log(`removed ${dir}`);
}
const { path, size } = writeSilentWav();
console.log(`wrote ${path} (${size} bytes)`);
