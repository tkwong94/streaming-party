// Bundles the adapter smoke entry as an IIFE for page.addInitScript (not part of the extension build).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ['src/adapters/smoke-entry.ts'],
  outfile: 'dist-smoke/adapter-smoke.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  logLevel: 'info',
});
