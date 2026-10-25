// npm run env:check — exits 0 when Node >= 20 and Playwright Chromium are installed, else 1 naming the missing item.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const missing = [];

const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) console.log(`ok   Node ${process.versions.node} (>= 20)`);
else missing.push(`Node >= 20 (found ${process.versions.node})`);

let revision = null;
try {
  const require = createRequire(join(REPO_ROOT, 'e2e', 'package.json'));
  const coreDir = resolve(require.resolve('playwright-core/package.json'), '..');
  const browsers = JSON.parse(readFileSync(join(coreDir, 'browsers.json'), 'utf8'));
  revision = browsers.browsers.find((b) => b.name === 'chromium')?.revision ?? null;
} catch {
  missing.push('@playwright/test (run: npm install)');
}

if (revision) {
  // Same candidate order as e2e/support/launch.ts.
  const candidates = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    resolve(REPO_ROOT, '../../.cache/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
    join(homedir(), 'Library/Caches/ms-playwright'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright'),
  ].filter((p) => p && p !== '0');
  const found = candidates.find((p) => existsSync(join(p, `chromium-${revision}`, 'INSTALLATION_COMPLETE')));
  if (found) console.log(`ok   Playwright Chromium ${revision} (${join(found, `chromium-${revision}`)})`);
  else missing.push(`Playwright Chromium ${revision} (run: npx playwright install chromium)`);
}

if (missing.length) {
  for (const m of missing) console.error(`MISSING ${m}`);
  process.exit(1);
}
console.log('env:check passed');
