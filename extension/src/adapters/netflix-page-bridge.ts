// MAIN-world bridge for the Netflix page player. The isolated-world NetflixAdapter
// sends 'test01:netflix-cmd' CustomEvents on document; this script drives Netflix's
// own player API and answers with 'test01:netflix-res'. build.mjs bundles it as
// netflix-page-bridge.js and calls installNetflixBridge(window, document).
// The API path is an unconfirmed assumption verified only by human test H1.

export const NETFLIX_CMD_EVENT = 'test01:netflix-cmd';
export const NETFLIX_RES_EVENT = 'test01:netflix-res';

export type NetflixBridgeOp = 'seek' | 'play' | 'pause';

export interface NetflixBridgeCommand {
  id: number;
  op: NetflixBridgeOp;
  ms?: number;
}

export interface NetflixBridgeResponse {
  id: number;
  ok: boolean;
  error?: 'NETFLIX_API_UNAVAILABLE';
}

export interface NetflixVideoPlayer {
  seek(ms: number): void;
  play(): void;
  pause(): void;
}

/** The subset of window used by the bridge; window.netflix is undefined off Netflix. */
export interface NetflixPageWindow {
  netflix?: {
    appContext?: {
      state?: {
        playerApp?: {
          getAPI?: () => {
            videoPlayer?: {
              getAllPlayerSessionIds?: () => string[];
              getVideoPlayerBySessionId?: (id: string) => NetflixVideoPlayer | undefined;
            };
          };
        };
      };
    };
  };
}

function resolvePlayer(win: NetflixPageWindow): NetflixVideoPlayer | null {
  const videoPlayer = win.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
  const sessionId = videoPlayer?.getAllPlayerSessionIds?.()[0];
  if (!videoPlayer?.getVideoPlayerBySessionId || sessionId === undefined) return null;
  return videoPlayer.getVideoPlayerBySessionId(sessionId) ?? null;
}

function isCommand(value: unknown): value is NetflixBridgeCommand {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<NetflixBridgeCommand>;
  if (typeof c.id !== 'number') return false;
  if (c.op === 'seek') return typeof c.ms === 'number' && Number.isFinite(c.ms);
  return c.op === 'play' || c.op === 'pause';
}

/** Answers bridge commands on doc through the page's Netflix player. Returns an uninstall function. */
export function installNetflixBridge(win: NetflixPageWindow, doc: Document): () => void {
  const reply = (res: NetflixBridgeResponse) => {
    doc.dispatchEvent(new CustomEvent(NETFLIX_RES_EVENT, { detail: res }));
  };
  const onCommand = (e: Event) => {
    const cmd = (e as CustomEvent<unknown>).detail;
    if (!isCommand(cmd)) return;
    let player: NetflixVideoPlayer | null = null;
    try {
      player = resolvePlayer(win);
      if (player) {
        if (cmd.op === 'seek') player.seek(cmd.ms as number);
        else if (cmd.op === 'play') player.play();
        else player.pause();
      }
    } catch {
      player = null;
    }
    reply(player ? { id: cmd.id, ok: true } : { id: cmd.id, ok: false, error: 'NETFLIX_API_UNAVAILABLE' });
  };
  doc.addEventListener(NETFLIX_CMD_EVENT, onCommand);
  return () => doc.removeEventListener(NETFLIX_CMD_EVENT, onCommand);
}
