// NECROFALL — P2P provider (plan §34/§56/§75).
//
// The existing WebRTC/PeerJS implementation IS the P2P mode: host-authoritative,
// lobby codes, host migration — all of it stays exactly as it is. This provider
// is the thin adapter the new shell talks to; the actual lobby UI and match run
// inside the legacy game, so nothing about P2P gameplay is rewritten.
//
// P2P results never grant official progression. The module only keeps separate
// community counters via `submitPeerResult` (plan §34).
import { MultiplayerProvider, ProviderConnectionState, ProviderGameEvent } from './MultiplayerProvider';
import { submitPeerResult } from '../spacetimedb/reducers';

export interface LegacyLaunchOptions {
  /** Room code from the PLAY screen — the legacy client joins it (it hosts when absent). */
  roomCode?: string;
  /** True when the player pressed CREATE rather than JOIN. */
  host?: boolean;
  /** LIBERATOR NAME typed on the shell's PLAY screen. */
  name?: string;
}

export type LegacyLauncher = (options: LegacyLaunchOptions) => void;

export class P2PMultiplayerProvider implements MultiplayerProvider {
  readonly mode = 'p2p' as const;
  private launched = false;

  constructor(private launch: LegacyLauncher) {}

  async connect(): Promise<void> {
    // P2P has no always-on connection: the lobby is established by the legacy
    // game (signalling, room code, host election) exactly as before.
  }

  async disconnect(): Promise<void> {
    /* the legacy game owns teardown */
  }

  async createLobby(name?: string): Promise<boolean> {
    this.launched = true;
    this.launch({ host: true, name });
    return true;
  }

  async joinLobby(code?: string, name?: string): Promise<boolean> {
    this.launched = true;
    this.launch({ roomCode: code, name });
    return true;
  }

  async leaveLobby(): Promise<void> {
    /* handled inside the legacy lobby UI */
  }

  sendInput(): void {
    // The legacy NetworkManager already streams poses/inputs; nothing to add.
  }

  sendAbility(): void {
    // Ability casts ride the existing P2P message set.
  }

  getPlayers(): string[] {
    return [];
  }

  getWorldState(): unknown {
    return { mode: 'p2p', launched: this.launched };
  }

  getMatchState(): unknown {
    return { mode: 'p2p' };
  }

  onGameEvent(): () => void {
    return () => undefined;
  }

  onConnectionState(cb: (state: ProviderConnectionState) => void): () => void {
    cb({ status: 'connected', detail: 'p2p' });
    return () => undefined;
  }

  endMatch(): void {
    /* the legacy match lifecycle owns this */
  }

  /**
   * Community stats reporting — UNTRUSTED by design. The server only bumps
   * separate counters and never touches wins, currency or match history.
   */
  reportCommunityResult(won: boolean, kills: number, deaths: number, durationSeconds: number): void {
    submitPeerResult(won, kills, deaths, durationSeconds);
  }
}
