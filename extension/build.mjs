// Builds the unpacked extension: `node build.mjs` -> dist/, `node build.mjs --test` -> dist-test/
// (dist-test also matches the local fixture page on http://127.0.0.1/*).
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_MATCH = 'http://127.0.0.1/*';
const root = dirname(fileURLToPath(import.meta.url));
const testBuild = process.argv.includes('--test');
const outdir = join(root, testBuild ? 'dist-test' : 'dist');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: {
    content: join(root, 'src/content/main.ts'),
    popup: join(root, 'src/popup/popup.ts'),
  },
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  logLevel: 'warning',
});

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
if (testBuild) {
  for (const script of manifest.content_scripts) script.matches.push(FIXTURE_MATCH);
}
await writeFile(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await copyFile(join(root, 'src/popup/popup.html'), join(outdir, 'popup.html'));

console.log(`built ${outdir}`);
