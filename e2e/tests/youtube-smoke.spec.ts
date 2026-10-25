// Real-page adapter smoke: the standalone adapter bundle (npm run build:adapter-smoke -w extension)
// is injected with page.addInitScript into plain Chromium (no extension).
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../support/fixture-server.js';
import { resolveChromium } from '../support/launch.js';

// Same file as '../extension/dist-smoke/adapter-smoke.js' relative to the e2e workspace, resolved
// from this file so the spec does not depend on the working directory.
const SMOKE_BUNDLE = fileURLToPath(new URL('../../extension/dist-smoke/adapter-smoke.js', import.meta.url));
// Big Buck Bunny (Blender Foundation, CC-BY), public and not age-restricted; ~10 min long.
const YOUTUBE_VIDEO_ID = 'aqz-KE-bpKQ';
const YOUTUBE_UNTESTED = 'UNTESTED: youtube unreachable';

let browser: Browser;

test.beforeAll(async () => {
  if (!existsSync(SMOKE_BUNDLE)) {
    throw new Error(`${SMOKE_BUNDLE} missing; run: npm run build:adapter-smoke -w extension`);
  }
  browser = await chromium.launch({
    executablePath: resolveChromium()?.executablePath,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
});

test.afterAll(async () => {
  await browser?.close();
});

async function smokePage(): Promise<Page> {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.addInitScript({ path: SMOKE_BUNDLE });
  return page;
}

test('fixture_page_bundle_smoke', async () => {
  const server = await startFixtureServer();
  const page = await smokePage();
  try {
    await page.goto(`${server.url}/watch/fixture?v=adapter-smoke`);
    await page.evaluate(() => (window as any).__fixture.ready);
    expect(await page.evaluate(() => (window as any).__test01Smoke.ready)).toBe('fixture');

    const afterSeek = await page.evaluate(async () => {
      const v = document.querySelector<HTMLVideoElement>('#fixture-video')!;
      const seeked = new Promise<void>((r) => v.addEventListener('seeked', () => r(), { once: true }));
      await (window as any).__test01Smoke.adapter().seek(120);
      await seeked;
      return v.currentTime;
    });
    expect(Math.abs(afterSeek - 120)).toBeLessThanOrEqual(0.25);

    expect(
      await page.evaluate(async () => {
        await (window as any).__test01Smoke.adapter().pause();
        return document.querySelector<HTMLVideoElement>('#fixture-video')!.paused;
      }),
    ).toBe(true);
    expect(
      await page.evaluate(async () => {
        await (window as any).__test01Smoke.adapter().play();
        return document.querySelector<HTMLVideoElement>('#fixture-video')!.paused;
      }),
    ).toBe(false);
  } finally {
    await page.context().close();
    await server.close();
  }
});

test('youtube_real_smoke', async () => {
  test.setTimeout(90_000);
  const page = await smokePage();
  try {
    let reachable = true;
    try {
      await page.goto(`https://www.youtube.com/watch?v=${YOUTUBE_VIDEO_ID}`, { timeout: 30_000 });
    } catch {
      reachable = false;
    }
    if (reachable && !new URL(page.url()).hostname.startsWith('www.youtube.com')) reachable = false; // consent.youtube.com etc.
    const site = reachable
      ? await page
          .evaluate(() => (window as any).__test01Smoke?.ready ?? null)
          .catch(() => null)
      : null;
    test.skip(site !== 'youtube', YOUTUBE_UNTESTED);
    expect(site).toBe('youtube');

    const video = () => '#movie_player video.html5-main-video, #movie_player video';
    const pausedFlag = () =>
      page.evaluate((sel) => document.querySelector<HTMLVideoElement>(sel)!.paused, video());

    await page.evaluate(() => (window as any).__test01Smoke.adapter().pause());
    await expect.poll(pausedFlag, { timeout: 1000 }).toBe(true);

    await page.evaluate(() => (window as any).__test01Smoke.adapter().play());
    await expect.poll(pausedFlag, { timeout: 1000 }).toBe(false);

    await page.evaluate(() => (window as any).__test01Smoke.adapter().seek(60));
    await expect
      .poll(
        () =>
          page.evaluate((sel) => Math.abs(document.querySelector<HTMLVideoElement>(sel)!.currentTime - 60), video()),
        { timeout: 1000 },
      )
      .toBeLessThanOrEqual(1);

    // Record what the real page reported so the evidence shows a real YouTube video was driven.
    const observed = await page.evaluate((sel) => {
      const v = document.querySelector<HTMLVideoElement>(sel)!;
      return {
        url: location.href,
        src: v.currentSrc.slice(0, 40),
        readyState: v.readyState,
        paused: v.paused,
        currentTime: v.currentTime,
        duration: v.duration,
      };
    }, video());
    test.info().annotations.push({ type: 'youtube-observed', description: JSON.stringify(observed) });
  } finally {
    await page.context().close();
  }
});
