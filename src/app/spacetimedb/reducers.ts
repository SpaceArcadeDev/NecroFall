// NECROFALL — typed reducer calls (plan §41/§57).
//
// The client ASKS; the module validates. Every wrapper here is a single
// reducer invocation (plan §39) and failures only log — the authoritative
// reply arrives through the subscribed rows.
import { SpacetimeConnection } from './connection';
import { Identity, PlayerSearchHitRow } from './rows';

export function callReducer(name: string, args?: unknown, quiet = false): void {
  const conn = SpacetimeConnection.shared.current;
  const fn = conn?.reducers?.[name];
  if (!fn) {
    console.warn(`[NECROFALL] reducer "${name}" unavailable (not connected or bindings missing)`);
    return;
  }
  try {
    void fn(args).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[NECROFALL] reducer "${name}" failed: ${message}`);
      // The shell listens for this and turns validation failures into a toast —
      // module reducers throw SenderError so `message` is user-readable.
      // `quiet` is for internal plumbing (the match relay): its traffic races match
      // end/authority handover by design, and a toast per late packet would be noise.
      if (quiet) return;
      try {
        window.dispatchEvent(new CustomEvent('nf:reducer-error', { detail: { name, message } }));
      } catch {
        /* non-browser context */
      }
    });
  } catch (err) {
    console.warn(`[NECROFALL] reducer "${name}" threw`, err);
  }
}

// ------------------------------------------------------------ account
export const chooseColony = (colony: number): void => callReducer('chooseColony', { colony });
export const setPlayerName = (name: string): void => callReducer('setPlayerName', { name });
export const setProfileName = (name: string): void => callReducer('setProfileName', { name });
export const setProfilePicture = (picture: number): void => callReducer('setProfilePicture', { picture });
export const setAvatar = (avatar: number): void => callReducer('setAvatar', { avatar });
/** The profile bio (user ask 2026-09-29): trimmed server-side, ≤160 chars, '' clears. */
export const setBio = (text: string): void => callReducer('setBio', { text });
/** The profile gender glyph: 0 = hidden, 1 = male, 2 = female. */
export const setGender = (gender: number): void => callReducer('setGender', { gender });
export const equipItem = (slot: number, itemId: number): void => callReducer('equipItem', { slot, itemId });
/** Save the control remap blob (JSON action → key code) to the account. */
export const setKeybinds = (binds: string): void => callReducer('setKeybinds', { binds });

// ------------------------------------------------------------ social
export const followPlayer = (target: Identity): void => callReducer('followPlayer', { target });
export const unfollowPlayer = (target: Identity): void => callReducer('unfollowPlayer', { target });
export const recordProfileView = (profile: Identity): void => callReducer('recordProfileView', { profile });

// ------------------------------------------------------------ parties
export const createParty = (acc: string): void => callReducer('createParty', { acc });
/** Leader-only: the lobby's MODE tag every member renders ('CLASSIC' | 'RANK'). */
export const setPartyFormat = (format: string): void => callReducer('setPartyFormat', { format });
export const joinParty = (partyId: number, acc: string): void => callReducer('joinParty', { partyId, acc });
export const joinPartyByCode = (code: string, acc: string): void => callReducer('joinPartyByCode', { code, acc });
export const leaveParty = (): void => callReducer('leaveParty');
export const setPartyLoadout = (acc: string): void => callReducer('setPartyLoadout', { acc });
export const kickFromParty = (target: Identity): void => callReducer('kickFromParty', { target });
/** Invite a player into the caller's lobby (friends rail ▸ INVITE — target gets a JOIN notification). */
export const inviteToParty = (target: Identity): void => callReducer('inviteToParty', { target });
/** Dismiss a lobby invite notification (the row is the caller's own). */
export const declineInvite = (id: number): void => callReducer('declineInvite', { id }, true);

// ------------------------------------------------------------ matchmaking
export const findMatch = (region: string): void => callReducer('findMatch', { region });
export const cancelFindMatch = (): void => callReducer('cancelFindMatch');
export const confirmMatch = (): void => callReducer('confirmMatch');
export const declineMatch = (): void => callReducer('declineMatch');

// ---- custom lobbies (user ask 2026-09-30): the P2P loop on the hybrid architecture
export const createCustomLobby = (): void => callReducer('createCustomLobby');
export const joinCustomLobby = (code: string): void => callReducer('joinCustomLobby', { code });
export const leaveCustomLobby = (): void => callReducer('leaveCustomLobby');
export const kickCustomSeat = (target: Identity): void => callReducer('kickCustomSeat', { target });
export const setCustomReady = (ready: boolean): void => callReducer('setCustomReady', { ready });
export const setCustomSeat = (colony: number, necrotech: number): void =>
  callReducer('setCustomSeat', { colony, necrotech });
export const startCustomMatch = (): void => callReducer('startCustomMatch');

// ---- solo-mode planet records (user ask 2026-09-30)
export const submitPlanetRecord = (mode: number, planetKey: string, timeMs: number): void =>
  callReducer('submitPlanetRecord', { mode: mode, planetKey: planetKey, timeMs: BigInt(Math.max(0, Math.round(timeMs))) });
export const recordPlanetPlay = (planetKey: string): void => callReducer('recordPlanetPlay', { planetKey }, true);

// ------------------------------------------------------------ ranked (plan §59)

/** FIND RANKED MATCH — queue for one planet; the server validates ring + availability. */
export const findRankedMatch = (ring: number, galaxyId: number, systemId: number, planetId: number): void =>
  callReducer('findRankedMatch', { ring, galaxyId, systemId, planetId });

/** DISCOVER PLANET — first contact, recorded among the first 5 discoverers (plan §35). */
export const discoverPlanet = (ring: number, galaxyId: number, systemId: number, planetId: number): void =>
  callReducer('discoverPlanet', { ring, galaxyId, systemId, planetId });

/**
 * DISCOVER LOCATION (plan §4/§47) — the map's first-contact request for a
 * galaxy / system / planet. The client sends ONLY the identity of the place;
 * the server derives the discovery slot, the player name, the colony and the
 * timestamp (plan §66), and silently no-ops when the slot cap is reached.
 */
export interface DiscoverLocationArgs {
  locationType: number;
  locationKey: string;
  galaxyId: number;
  systemId: number;
  planetId: number;
}
export const discoverLocation = (args: DiscoverLocationArgs): void => callReducer('discoverLocation', { ...args });

/** Season-wide colony power stats (procedure — computed on demand, plan §76). */
export interface ColonyStatsRow {
  colony: number;
  planets: number;
  systems: number;
  expiring: number;
}
export interface ColonyStatsResult {
  /** Codegen camelCases object fields: `total_planets` arrives as `totalPlanets`. */
  totalPlanets: number;
  totalSystems: number;
  colonies: ColonyStatsRow[];
}
export async function colonyStats(): Promise<ColonyStatsResult | null> {
  const conn = SpacetimeConnection.shared.current;
  const fn = conn?.procedures?.colonyStats;
  if (!fn) return null;
  try {
    const res = (await fn()) as ColonyStatsResult | undefined;
    return res ?? null;
  } catch (err) {
    console.warn('[NECROFALL] colonyStats failed', err);
    return null;
  }
}

// ------------------------------------------------------------ official match
export interface SubmitInputArgs {
  moveX: number;
  moveY: number;
  moveZ: number;
  aimX: number;
  aimY: number;
  aimZ: number;
  seq: bigint;
  dash: boolean;
}
export const submitInput = (args: SubmitInputArgs): void => callReducer('submitInput', args);

/** LEAVE MATCH — abandon the live seat; the row becomes a tombstone (plan §27/§71). */
export const leaveMatch = (): void => callReducer('leaveMatch');
/** JOIN / REJOIN a running official match by id (the id from the URL — user ask 2026-09-28). */
export const joinMatch = (matchId: number, colony: number, necrotech: number): void =>
  callReducer('joinMatch', { matchId, colony, necrotech });

/**
 * REPORT NEXUS CAPTURE — the local sim took the Nexus; the server finishes the match for
 * everyone the moment the first report lands (`finishMatchInternal` is idempotent).
 */
export const reportNexusCapture = (colony: number): void => callReducer('reportNexusCapture', { colony });

/**
 * REPORT NECROPHAGE VICTORY — the local clock ran out with no colony claiming the Nexus. The
 * server concludes the match for every seat at once (no winner), so the still-RUNNING row stops
 * answering "You are already in a match" and the player can requeue immediately.
 */
export const reportNecrophageVictory = (): void => callReducer('reportNecrophageVictory');

/**
 * REPORT SURRENDER (user ask 2026-09-30) — a RANKED colony's vote to forfeit passed: the whole
 * colony is tombstoned and counted as a recorded loss. Idempotent (a teammate's report wins).
 */
export const reportSurrender = (): void => callReducer('reportSurrender');

export interface SyncPoseArgs {
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
}
export const syncPose = (args: SyncPoseArgs): void => callReducer('syncPose', args);

/**
 * SEND MATCH MESSAGE (2026-09-29) — one P2P wire frame through the official relay. Quiet:
 * its traffic races match end and authority handovers by design (the server drops what it
 * can no longer place), and a toast per late packet would be noise, not information.
 */
export interface SendMatchMsgArgs {
  matchId: number;
  /** Target identity hex; '' = broadcast to every seat. */
  toHex: string;
  kind: string;
  seq: bigint;
  payload: string;
}
export const sendMatchMsg = (args: SendMatchMsgArgs): void => callReducer('sendMatchMsg', args, true);

/**
 * HYBRID ANTI-CHEAT (2026-09-29): report one observed impossible pose sample from another
 * seat's broadcast stream. Fire-and-forget — the server corroborates the sample against the
 * target's own pose record and decides (see `game/verification.ts`). Never gates gameplay.
 */
export interface ReportViolationArgs {
  matchId: number;
  /** Identity hex of the suspected seat. */
  targetHex: string;
  /** 'speed' — the only detector class today. */
  kind: string;
  x: number;
  y: number;
  z: number;
  /** Reporter-clock micros of the sample (metadata). */
  at: bigint;
}
export const reportViolation = (args: ReportViolationArgs): void => callReducer('reportViolation', args, true);

export const reportMatchStats = (kills: number, deaths: number, objectives: number, damage: number): void =>
  callReducer('reportMatchStats', { kills, deaths, objectives, damage });

// ------------------------------------------------------------ procedures (on-demand reads)

/**
 * Survivor search (plan §8/§64). A PROCEDURE: nothing is subscribed, the server
 * ranks by player id / name and returns a compact projection. Returns null when
 * the connection or the bindings are unavailable (offline shell).
 */
export async function searchPlayers(term: string): Promise<PlayerSearchHitRow[] | null> {
  const conn = SpacetimeConnection.shared.current;
  const fn = conn?.procedures?.searchPlayers;
  if (!fn) return null;
  const rows = await fn({ term });
  return Array.isArray(rows) ? (rows as PlayerSearchHitRow[]) : [];
}

// ------------------------------------------------------------ community (P2P)
export const submitPeerResult = (won: boolean, kills: number, deaths: number, durationSeconds: number): void =>
  callReducer('submitPeerResult', { won, kills, deaths, durationSeconds });
