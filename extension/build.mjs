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

// MAIN-world Netflix bridge: installs itself on the page's window/document.
await build({
  stdin: {
    contents:
      "import { installNetflixBridge } from './src/adapters/netflix-page-bridge.ts';\ninstallNetflixBridge(window, document);\n",
    resolveDir: root,
    sourcefile: 'netflix-page-bridge-entry.ts',
    loader: 'ts',
  },
  outfile: join(outdir, 'netflix-page-bridge.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  logLevel: 'warning',
});

// Classic (non-module) service worker that owns the party WebSocket for every tab.
await build({
  stdin: {
    contents:
      "import { startTransportRelay } from './src/background/service-worker.ts';\nstartTransportRelay({ runtime: chrome.runtime });\n",
    resolveDir: root,
    sourcefile: 'background-entry.ts',
    loader: 'ts',
  },
  outfile: join(outdir, 'background.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  logLevel: 'warning',
});

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
if (testBuild) {
  // Only the isolated-world content script runs on the fixture page; the Netflix bridge stays Netflix-only.
  for (const script of manifest.content_scripts) {
    if (script.js.includes('content.js')) script.matches.push(FIXTURE_MATCH);
  }
}
await writeFile(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await copyFile(join(root, 'src/popup/popup.html'), join(outdir, 'popup.html'));

console.log(`built ${outdir}`);
