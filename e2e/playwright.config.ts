import { defineConfig } from '@playwright/test';
import { resolveChromium } from './support/launch.js';

// Point workers at whichever cache actually holds the required Chromium build.
const resolved = resolveChromium();
if (resolved) process.env.PLAYWRIGHT_BROWSERS_PATH = resolved.browsersPath;

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
