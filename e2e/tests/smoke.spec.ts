import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../support/fixture-server.js';
import { launchWithExtension } from '../support/launch.js';

const STUB_EXTENSION = fileURLToPath(new URL('../fixtures/stub-extension/', import.meta.url));

let server: Awaited<ReturnType<typeof startFixtureServer>>;
let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = await startFixtureServer();
  context = await launchWithExtension(STUB_EXTENSION, { profileName: 'smoke' });
  page = await context.newPage();
  await page.goto(`${server.url}/watch/fixture?v=smoke`);
  await page.evaluate(() => (window as any).__fixture.ready);
});

test.afterAll(async () => {
  await context?.close();
  await server?.close();
});

test('smoke_loads_unpacked_extension', async () => {
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.test01Stub)).toBe('1');
});

test('smoke_fixture_video_plays_and_seeks', async () => {
  const duration = await page.evaluate(() => (window as any).__fixture.video.duration as number);
  expect(duration).toBeGreaterThanOrEqual(600);

  const advanced = await page.evaluate(async () => {
    const v = (window as any).__fixture.video as HTMLVideoElement;
    await v.play();
    const t0 = v.currentTime;
    await new Promise((r) => setTimeout(r, 2000));
    return v.currentTime - t0;
  });
  expect(advanced).toBeGreaterThanOrEqual(1.5);
  expect(advanced).toBeLessThanOrEqual(2.5);

  const afterSeek = await page.evaluate(async () => {
    const v = (window as any).__fixture.video as HTMLVideoElement;
    v.pause();
    await new Promise<void>((resolve) => {
      v.addEventListener('seeked', () => resolve(), { once: true });
      v.currentTime = 120;
    });
    return v.currentTime;
  });
  expect(Math.abs(afterSeek - 120)).toBeLessThanOrEqual(0.25);
});

test('smoke_stall_emits_waiting_then_playing', async () => {
  const events = await page.evaluate(async () => {
    const f = (window as any).__fixture;
    const v = f.video as HTMLVideoElement;
    await v.play();
    const seen: string[] = [];
    const onWaiting = () => seen.push('waiting');
    const onPlaying = () => seen.push('playing');
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    await f.stall(1000);
    await new Promise((r) => setTimeout(r, 100));
    v.removeEventListener('waiting', onWaiting);
    v.removeEventListener('playing', onPlaying);
    return seen;
  });
  expect(events).toEqual(['waiting', 'playing']);
});
