import { chromium, type BrowserContext } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = resolve(E2E_DIR, '..');
export const PROFILES_DIR = join(E2E_DIR, '.profiles');

// Executable locations inside a chromium-<rev> directory, per platform build.
const CHROME_SUBPATHS = [
  'chrome-linux-arm64/chrome',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-win64/chrome.exe',
  'chrome-win/chrome.exe',
];

export function requiredChromiumRevision(): string {
  const require = createRequire(import.meta.url);
  const coreDir = resolve(require.resolve('playwright-core/package.json'), '..');
  const browsers = JSON.parse(readFileSync(join(coreDir, 'browsers.json'), 'utf8')) as {
    browsers: { name: string; revision: string }[];
  };
  const entry = browsers.browsers.find((b) => b.name === 'chromium');
  if (!entry) throw new Error('playwright-core browsers.json has no chromium entry');
  return entry.revision;
}

// Candidate browser caches, in order: inherited PLAYWRIGHT_BROWSERS_PATH, the
// project-level cache next to the worktrees (factory hosts where the inherited
// path is read-only), and Playwright's per-user default.
export function browserPathCandidates(): string[] {
  const list = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    resolve(REPO_ROOT, '../../.cache/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
    join(homedir(), 'Library/Caches/ms-playwright'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright'),
  ];
  return [...new Set(list.filter((p): p is string => !!p && p !== '0'))];
}

export function resolveChromium(): { browsersPath: string; executablePath: string } | null {
  const rev = requiredChromiumRevision();
  for (const browsersPath of browserPathCandidates()) {
    const dir = join(browsersPath, `chromium-${rev}`);
    if (!existsSync(join(dir, 'INSTALLATION_COMPLETE'))) continue;
    for (const sub of CHROME_SUBPATHS) {
      const executablePath = join(dir, sub);
      if (existsSync(executablePath)) return { browsersPath, executablePath };
    }
  }
  return null;
}

export async function launchWithExtension(
  extensionDir: string,
  opts: { profileName?: string } = {},
): Promise<BrowserContext> {
  const resolved = resolveChromium();
  if (!resolved) {
    throw new Error(`Playwright Chromium chromium-${requiredChromiumRevision()} not found; run: npm run env:check for the install command`);
  }
  const extPath = resolve(extensionDir);
  const userDataDir = join(PROFILES_DIR, opts.profileName ?? 'default');
  mkdirSync(userDataDir, { recursive: true });
  // The full Chromium build (not headless-shell) is required for extensions; it runs in new headless mode.
  return chromium.launchPersistentContext(userDataDir, {
    executablePath: resolved.executablePath,
    headless: process.env.TEST01_HEADED !== '1',
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
}
