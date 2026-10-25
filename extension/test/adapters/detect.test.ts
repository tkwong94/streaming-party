// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { selectAdapter } from '../../src/adapters/detect.js';
import { FixtureAdapter } from '../../src/adapters/fixture.js';
import { YouTubeAdapter } from '../../src/adapters/youtube.js';

const loc = (url: string) => new URL(url) as unknown as Location;

function pageWith(html: string): Document {
  const doc = document.implementation.createHTMLDocument('t');
  doc.body.innerHTML = html;
  return doc;
}

const YOUTUBE_HTML = '<div id="movie_player"><video class="html5-main-video"></video></div>';
const FIXTURE_HTML = '<video id="fixture-video"></video>';

describe('selectAdapter', () => {
  test('detect_selects_by_url', async () => {
    const yt = await selectAdapter(loc('https://www.youtube.com/watch?v=abc'), pageWith(YOUTUBE_HTML));
    expect(yt).toBeInstanceOf(YouTubeAdapter);
    expect(yt?.site).toBe('youtube');
    yt?.dispose();

    const fx = await selectAdapter(loc('http://127.0.0.1:8790/watch/fixture?v=1'), pageWith(FIXTURE_HTML));
    expect(fx).toBeInstanceOf(FixtureAdapter);
    expect(fx?.site).toBe('fixture');
    fx?.dispose();

    expect(await selectAdapter(loc('https://example.com/'), pageWith(YOUTUBE_HTML + FIXTURE_HTML))).toBeNull();
  });

  test('detect_rejects_non_watch_paths', async () => {
    expect(await selectAdapter(loc('https://www.youtube.com/'), pageWith(YOUTUBE_HTML))).toBeNull();
    expect(await selectAdapter(loc('http://127.0.0.1:8790/other'), pageWith(FIXTURE_HTML))).toBeNull();
  });

  test('detect_waits_for_late_video_element', async () => {
    const doc = pageWith('');
    setTimeout(() => {
      doc.body.innerHTML = YOUTUBE_HTML;
    }, 50);
    const yt = await selectAdapter(loc('https://www.youtube.com/watch?v=abc'), doc);
    expect(yt).toBeInstanceOf(YouTubeAdapter);
    yt?.dispose();
  });
});
