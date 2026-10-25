// Standalone IIFE entry for real-page adapter smoke tests (injected with Playwright addInitScript).
import type { PlayerAdapter, Site } from '@test01/protocol';
import { selectAdapter } from './detect.js';

declare global {
  interface Window {
    __test01Smoke?: { ready: Promise<Site | null>; adapter(): PlayerAdapter | null };
  }
}

// addInitScript also runs in subframes; only the top-level page gets the smoke hook.
if (window === window.top) {
  let current: PlayerAdapter | null = null;
  const ready = selectAdapter(location, document).then((adapter) => {
    current = adapter;
    return adapter ? adapter.site : null;
  });
  window.__test01Smoke = { ready, adapter: () => current };
}
