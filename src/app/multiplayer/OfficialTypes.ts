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
  /** The seat was abandoned (LEAVE MATCH) — the game drops it like a P2P `bye`. */
  left?: boolean;
}

export interface OfficialMatchPayload {
  matchId: number;
  /** Server-chosen world seed — every client builds the same planet (plan §54). */
  seed: number;
  elapsed: number;
  /** The local player's game-side id. */
  meId: string;
  players: OfficialGamePlayerInfo[];
  /**
   * The match AUTHORITY (2026-09-29): the seat that runs the world exactly like a P2P host
   * and broadcasts through the relay. Lowest connected non-left seat id; it may move during
   * the match (the provider pushes every change through `setAuthority`).
   */
  authorityId?: string;
  /** RANKED match facts (plan §32): which planet is being fought over. */
  ranked?: boolean;
  /** `ring:galaxyId:systemId:planetId` of the ranked planet. */
  planetKey?: string;
  /** Rank ring (0..7); 255 = classic. Drives terrain + ecology complexity (plan §6/§29). */
  rankRing?: number;
  /** The season's universe seed — regenerates the planet descriptor client-side (plan §32). */
  universeSeed?: number;
}

/**
 * A relayed P2P message (2026-09-29): `t` is the message kind, every other field the body.
 * The payload crosses SpacetimeDB as JSON; receivers feed `{ t, ...body }` into the very
 * same `onNetMessage` handlers the P2P transport uses. `ex` (set by the relay broadcaster)
 * names the game id that must NOT apply the message — the `broadcast(msg, exceptId)` rule.
 */
export interface OfficialNetMessage {
  t: string;
  [key: string]: unknown;
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
  /** Server usage summary of this match (plan §28) — the results screen prints it for debug. */
  usage?: {
    matchId: number;
    serverTicks: number;
    inputCommands: number;
    stateUpdates: number;
    events: number;
    egressBytes: number;
    storageBytes: number;
    playerCount: number;
    durationSeconds: number;
  };
}

export interface OfficialGameApi {
  /**
   * Feed one relayed message from another seat. The game routes it through the same
   * `onNetMessage` switch P2P uses — poses (`st`), world snapshots (`s`), hits, pickups,
   * ability events, kills... all arrive here.
   */
  applyNetMessage(fromId: string, msg: OfficialNetMessage): void;
  /**
   * The authority seat changed (or was determined for the first time). The game adopts the
   * P2P host/client role it implies and re-targets its relay sends.
   */
  setAuthority(authorityId: string): void;
  /** Seats joined/left/renamed — keep the game roster in sync (names, colonies, classes). */
  setRoster(players: OfficialGamePlayerInfo[]): void;
  /** The server finished the match — show the authoritative result. */
  matchEnded(result: OfficialMatchResult): void;
}

export interface OfficialGameBridge {
  /**
   * Called from the game's net tick at CONFIG.netTickPlayers. The provider
   * throttles this into change-driven reducer calls (plan §18/§39/§77).
   */
  sendLocalState(msg: OfficialStateMessage): void;
  /** Relay ONE P2P message to one seat (game id) — the `sendToHost` / `sendTo` side. */
  sendNetTo(toId: string, msg: OfficialNetMessage): void;
  /** Relay one P2P message to every seat except `exceptId` — the host's broadcast side. */
  broadcastNet(msg: OfficialNetMessage, exceptId?: string): void;
  /** The game is ready: hand it the remote-message sink. */
  attachGame(api: OfficialGameApi): void;
  /** The player pressed LEAVE MATCH: abandon the seat server-side (never auto-rejoin). */
  leaveMatch(): void;
  /**
   * RANKED: the local colony's surrender vote passed (user ask 2026-09-30). The provider
   * tombstones the whole colony server-side (`report_surrender`, idempotent) and latches the
   * match id so the still-RUNNING row can never pull this client back in.
   */
  reportSurrender(): void;
  /**
   * The LOCAL simulation concluded the match. A non-null `colony` = a Nexus capture: the provider
   * also reports it to the server (`report_nexus_capture`) so the match finishes for everyone at
   * once. Either way it latches the id so the still-RUNNING row cannot pull the player back in
   * while the authoritative finish lands. Server-projected ends do NOT come through here.
   */
  reportVictory(colony: number | null): void;
}
