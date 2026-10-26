import { Html5VideoAdapter } from './html5-video.js';

export const YOUTUBE_PLAYER_SELECTOR = '#movie_player';
/** Primary selector first, then fallbacks for player layouts without the html5-main-video class. */
export const YOUTUBE_VIDEO_SELECTORS = ['#movie_player video.html5-main-video', '#movie_player video'];
const AD_CLASS = 'ad-showing';

/**
 * YouTube watch-page adapter. Ads play in the same <video>, so while #movie_player has
 * class 'ad-showing' the adapter reports buffering and suppresses the ad's media events.
 */
export class YouTubeAdapter extends Html5VideoAdapter {
  private readonly player: HTMLElement;
  private readonly observer: MutationObserver;
  private adShowing: boolean;

  constructor(video: HTMLVideoElement, player: HTMLElement) {
    super(video, 'youtube');
    this.player = player;
    this.adShowing = player.classList.contains(AD_CLASS);
    this.observer = new MutationObserver(() => this.checkAd());
    this.observer.observe(player, { attributes: true, attributeFilter: ['class'] });
  }

  override isBuffering(): boolean {
    return this.adShowing || super.isBuffering();
  }

  override dispose(): void {
    this.observer.disconnect();
    super.dispose();
  }

  protected override shouldForwardMediaEvents(): boolean {
    return !this.adShowing;
  }

  private checkAd(): void {
    const showing = this.player.classList.contains(AD_CLASS);
    if (showing === this.adShowing) return;
    this.adShowing = showing;
    this.emit(showing ? 'buffering_start' : 'buffering_end');
  }
}
