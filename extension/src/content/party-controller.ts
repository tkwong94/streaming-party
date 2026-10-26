import {
  PROTOCOL_VERSION,
  type Clock,
  type ControlMode,
  type PlaybackStateWire,
  type PlayerAdapter,
  type ServerClock,
  type SyncTransport,
} from '@test01/protocol';
import { mountSidebar, type SidebarController } from '../sidebar/sidebar.js';
import { ClockSync } from '../sync/clock.js';
import { SyncEngine, type SyncEngineOptions } from '../sync/engine.js';
import type { PartySession } from './session.js';

interface ClockSyncLike extends ServerClock {
  start(): void;
  stop(): void;
}

interface EngineLike {
  start(initial: PlaybackStateWire): void;
  stop(): void;
}

export interface PartyControllerDeps {
  clock: Clock;
  createClockSync(transport: SyncTransport, clock: Clock): ClockSyncLike;
  createEngine(adapter: PlayerAdapter, transport: SyncTransport, serverClock: ServerClock, opts: SyncEngineOptions): EngineLike;
}

export type AdapterSelector = (loc: Location, doc: Document) => Promise<PlayerAdapter | null>;

export const defaultPartyControllerDeps: PartyControllerDeps = {
  clock: { now: () => Date.now() },
  createClockSync: (transport, clock) => new ClockSync(transport, clock),
  createEngine: (adapter, transport, serverClock, opts) => new SyncEngine(adapter, transport, serverClock, opts),
};

const NO_VIDEO_STATUS = 'No video found on this page; playback is not synced.';

export const DISCONNECTED_STATUS = 'The party connection was lost. Create or join the party again to continue.';

const JOIN_ERROR_STATUS: Record<string, string> = {
  ROOM_FULL: 'Room full: this party already has the maximum number of participants.',
  ROOM_NOT_FOUND: 'Party not found; it may have ended.',
  JOIN_DENIED: 'Could not join: the invite link is not valid.',
  CONNECT_FAILED: 'Could not reach the party server.',
};

/**
 * Wires one tab's party session to the player: clock sync and sync engine run
 * while in a party, and the sidebar shows participants, chat and control mode.
 */
export class PartyController {
  private adapter: PlayerAdapter | null = null;
  private sidebar: SidebarController | null = null;
  private clockSync: ClockSyncLike | null = null;
  private engine: EngineLike | null = null;
  private lastState: PlaybackStateWire | null = null;
  private unsubs: (() => void)[] = [];
  private stopped = false;

  private readonly deps: PartyControllerDeps;

  constructor(
    private readonly doc: Document,
    private readonly session: PartySession,
    private readonly selectAdapter: AdapterSelector,
    deps: Partial<PartyControllerDeps> = {},
  ) {
    this.deps = { ...defaultPartyControllerDeps, ...deps };
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.session.on('participants', ({ hostId, participants }) => {
        const selfId = this.session.selfId;
        if (!selfId) return;
        const sidebar = this.ensureSidebar();
        sidebar.setParticipants(participants, selfId, hostId);
        sidebar.setMode(this.session.mode ?? 'everyone', selfId === hostId);
      }),
      this.session.on('state', ({ cause, state }) => {
        this.lastState = state;
        if (cause === 'initial') this.enterParty(state);
      }),
      this.session.on('mode', ({ mode }) => {
        this.sidebar?.setMode(mode, this.isHost());
      }),
      this.session.on('chat', (msg) => this.sidebar?.appendChat(msg)),
      this.session.on('error', ({ message }) => this.sidebar?.setStatus(message)),
      this.session.on('closed', ({ initiatedLocally }) => {
        this.exitParty();
        // The connection dropped (server close or service worker terminated); no automatic reconnect.
        if (!initiatedLocally && !this.stopped) this.ensureSidebar().setStatus(DISCONNECTED_STATUS);
      }),
    );
    const loc = this.doc.location;
    const adapter = loc ? await this.selectAdapter(loc, this.doc) : null;
    if (this.stopped) {
      adapter?.dispose();
      return;
    }
    this.adapter = adapter;
    // A party entered before the video appeared starts syncing now.
    if (this.session.inParty && this.lastState && !this.engine) this.startSync(this.lastState);
  }

  /** Tears down the current party UI and sync; the controller keeps listening for the next party. */
  exitParty(): void {
    this.engine?.stop();
    this.engine = null;
    this.clockSync?.stop();
    this.clockSync = null;
    this.sidebar?.destroy();
    this.sidebar = null;
    this.lastState = null;
  }

  /** Shows why a join attempt failed (e.g. ROOM_FULL) in the sidebar; no sync is started. */
  reportJoinError(code: string): void {
    if (this.stopped || this.session.inParty) return;
    this.ensureSidebar().setStatus(JOIN_ERROR_STATUS[code] ?? `Could not join the party (${code}).`);
  }

  stop(): void {
    this.stopped = true;
    this.exitParty();
    for (const off of this.unsubs) off();
    this.unsubs = [];
    this.adapter?.dispose();
    this.adapter = null;
  }

  private isHost(): boolean {
    return this.session.selfId !== null && this.session.selfId === this.session.hostId;
  }

  private enterParty(state: PlaybackStateWire): void {
    const sidebar = this.ensureSidebar();
    if (this.adapter) this.startSync(state);
    else sidebar.setStatus(NO_VIDEO_STATUS);
  }

  private startSync(state: PlaybackStateWire): void {
    const transport = this.session.transport;
    const selfId = this.session.selfId;
    if (!transport || !selfId || !this.adapter) return;
    this.sidebar?.setStatus('');
    const clockSync = this.deps.createClockSync(transport, this.deps.clock);
    clockSync.start();
    const engine = this.deps.createEngine(this.adapter, transport, clockSync, {
      selfId,
      getHostId: () => this.session.hostId ?? '',
      getMode: () => this.session.mode ?? 'everyone',
    });
    this.clockSync = clockSync;
    this.engine = engine;
    engine.start(state);
  }

  private ensureSidebar(): SidebarController {
    if (!this.sidebar) {
      this.sidebar = mountSidebar(this.doc, {
        onSendChat: (text: string) => this.session.transport?.send({ v: PROTOCOL_VERSION, type: 'chat', text }),
        onSetMode: (mode: ControlMode) => this.session.transport?.send({ v: PROTOCOL_VERSION, type: 'set_mode', mode }),
        onLeave: () => {
          this.session.leave();
          this.exitParty();
        },
      });
    }
    return this.sidebar;
  }
}
