// NECROFALL — the ONE interface game code may know (plan §10/rule 18).
//
// Official play (SpacetimeDB authoritative) and P2P play (existing WebRTC host
// authority) both implement this surface. Callers never touch SpacetimeDB,
// WebRTC, PeerJS or signalling directly — swapping modes must not duplicate the
// game.
import { MultiplayerMode } from './MultiplayerMode';

export type ProviderStatus = 'offline' | 'connecting' | 'connected' | 'reconnecting';

export interface ProviderConnectionState {
  status: ProviderStatus;
  detail?: string;
}

/** Discrete, one-shot things that happened — never per-frame state (plan §21). */
export type ProviderGameEvent =
  | { type: 'queue'; status: 'idle' | 'queued' | 'candidate' | 'confirmed'; queuedSeconds: number }
  | { type: 'candidate'; deadlineSeconds: number; seats: { colony: number; confirmed: boolean; me: boolean }[]; myConfirmed: boolean }
  | { type: 'match-start'; matchId: number }
  | { type: 'match-end'; matchId: number; winnerColony: number | null }
  | { type: 'match-event'; kind: number; a: number; b: number }
  | { type: 'error'; message: string };

export interface MultiplayerProvider {
  readonly mode: MultiplayerMode;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  createLobby(name?: string): Promise<boolean>;
  joinLobby(code?: string, name?: string): Promise<boolean>;
  leaveLobby(): Promise<void>;

  /** The plan §18 input model: called on input CHANGES, never per frame. */
  sendInput(input: unknown): void;
  /** One-shot ability/ultimate cast (server-validated once the sim owns combat). */
  sendAbility(id: number, data?: unknown): void;

  getPlayers(): string[];
  getWorldState(): unknown;
  getMatchState(): unknown;

  onGameEvent(cb: (event: ProviderGameEvent) => void): () => void;
  onConnectionState(cb: (state: ProviderConnectionState) => void): () => void;

  endMatch(): void;
}
