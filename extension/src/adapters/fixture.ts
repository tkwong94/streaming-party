import { Html5VideoAdapter } from './html5-video.js';

export const FIXTURE_VIDEO_SELECTOR = '#fixture-video';

/** Adapter for the local fixture watch page (http://127.0.0.1:8790/watch/fixture). */
export class FixtureAdapter extends Html5VideoAdapter {
  constructor(video: HTMLVideoElement) {
    super(video, 'fixture');
  }
}
