// NECROFALL — the Game⇄Official-provider seam (plan §10/§19/§21).
//
// Game.ts imports these TYPES ONLY, so the 3D game never bundles SpacetimeDB,
// WebRTC or any networking implementation: it talks to whatever object
// implements `OfficialGameBridge`, and the official provider translates rows
// into the same pose messages the P2P code already understands.
export interface OfficialGamePlayerInfo {
  /** Game-side player id (stable, derived from the SpacetimeDB identity). */
  id: string;
  name: string;
  colony: number;
  necrotech: number;
}

export interface OfficialMatchPayload {
  matchId: number;
  /** Server-chosen world seed — every client builds the same planet (plan §54). */
  seed: number;
  elapsed: number;
  /** The local player's game-side id. */
  meId: string;
  players: OfficialGamePlayerInfo[];
}

/**
 * A pose/input message. `state` carries the same shape as the P2P `PlayerNet`
 * wire object; the provider fills server-known fields and neutral values for
 * the rest until the server sim owns them.
 */
export interface OfficialStateMessage {
  t: string;
  time: number;
  state: Record<string, unknown>;
}

export interface OfficialMatchResult {
  winnerColony: number | null;
  reason: string;
}

export interface OfficialGameApi {
  /** Feed one remote player's pose (already translated onto server time). */
  applyRemote(id: string, msg: OfficialStateMessage): void;
  /** The server finished the match — show the authoritative result. */
  matchEnded(result: OfficialMatchResult): void;
}

export interface OfficialGameBridge {
  /**
   * Called from the game's net tick at CONFIG.netTickPlayers. The provider
   * throttles this into change-driven reducer calls (plan §18/§39/§77).
   */
  sendLocalState(msg: OfficialStateMessage): void;
  /** The game is ready: hand it the remote-pose sink. */
  attachGame(api: OfficialGameApi): void;
}
