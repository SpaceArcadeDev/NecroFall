// NECROFALL — client-side mirrors of the module schema (camelCase, as the
// generated bindings present them) plus the numeric constants both sides share.
// Keep in sync with `spacetimedb/src/constants.ts`.

// ------------------------------------------------------------ shared constants
export const COLONY_NONE = 255;
export const COLONY_CAP = 3;
export const MATCH_MAX_PLAYERS = 9;
export const MATCH_MIN_PLAYERS = 1;

export const QUEUE_QUEUED = 0;
export const QUEUE_CANDIDATE = 1;
export const QUEUE_CONFIRMED = 2;

export const CANDIDATE_FILLING = 0;
export const CANDIDATE_CONFIRMING = 1;
export const CANDIDATE_STARTED = 2;

/** Match rows: standard matchmaking/ranked vs a custom lobby + the match it started. */
export const MATCH_MODE_STANDARD = 0;
export const MATCH_MODE_CUSTOM = 1;
/** planet_record.mode values (mirror spacetimedb/src/constants.ts). */
export const RECORD_MODE_SPEEDRUN = 0;
export const RECORD_MODE_SURVIVAL = 1;
/** First players per planet, any mode (who 'discovered' it). */
export const MAX_PLANET_PLAYS = 9;

export const MATCH_STARTING = 0;
export const MATCH_RUNNING = 1;
export const MATCH_FINISHED = 2;

export const PRESENCE_OFFLINE = 0;
export const PRESENCE_ONLINE = 1;
export const PRESENCE_IN_MATCH = 2;

export const LOADOUT_SLOT = {
  avatar: 0,
  profileFrame: 1,
  profileBanner: 2,
  nameplate: 3,
  characterSkin: 4,
  emote: 5,
  effect: 6,
  victoryEffect: 7,
  badge: 8,
  title: 9,
} as const;

export const EVENT_MATCH_STARTED = 9;
export const EVENT_MATCH_ENDED = 10;

// ------------------------------------------------------------ ranked location discovery (plan §1–§4)
/** Location tiers of the discovery log. Mirrors `ranked/location.ts`. */
export const LOCATION_GALAXY = 0;
export const LOCATION_SYSTEM = 1;
export const LOCATION_PLANET = 2;
/** The first N UNIQUE players per galaxy/system/planet are kept (plan §3). */
export const MAX_LOCATION_DISCOVERERS = 9;

// ------------------------------------------------------------ sdk value types
export interface Identity {
  toHexString(): string;
}

export interface Timestamp {
  microsSinceUnixEpoch: bigint;
}

// ------------------------------------------------------------ rows
export interface PlayerRow {
  identity: Identity;
  playerName: string;
  normalizedName: string;
  playerCode: string;
  profileName: string;
  profilePicture: number;
  avatarId: number;
  colony: number;
  level: number;
  xp: bigint;
  wins: number;
  losses: number;
  matchesPlayed: number;
  currentRank: number;
  rankPoints: number;
  rankStatus: number;
  seasonId: number;
  skillRating: number;
  likesReceived: number;
  profileViews: number;
  followersCount: number;
  followingCount: number;
  createdAt: Timestamp;
  lastSeenAt: Timestamp;
  lastOnlineAt: Timestamp;
  banned: boolean;
  /** Profile bio (user ask 2026-09-29). '' = not set. */
  bio: string;
  /** Gender glyph: 0 = not set, 1 = male, 2 = female. */
  gender: number;
  /** Highest `rankPoints` ever held — the profile's BEST rank. */
  peakRankPoints: number;
}

export interface PlayerStatsRow {
  identity: Identity;
  kills: number;
  deaths: number;
  bossKills: number;
  beaconsCaptured: number;
  nexusCaptures: number;
  damageDealt: number;
  damageTaken: number;
  playTimeSeconds: bigint;
  p2pMatches: number;
  p2pWins: number;
}

/** One result row of the `searchPlayers` procedure — the compact public projection. */
export interface PlayerSearchHitRow {
  identity: Identity;
  playerName: string;
  playerCode: string;
  colony: number;
  level: number;
}

export interface PlayerWalletRow {
  identity: Identity;
  softCurrency: bigint;
  premiumCurrency: bigint;
}

/** Per-account client settings: `keybinds` is a JSON blob of action → key code ('' = defaults). */
export interface PlayerSettingsRow {
  identity: Identity;
  keybinds: string;
}

export interface PlayerInventoryRow {
  id: number;
  identity: Identity;
  itemId: number;
  quantity: number;
  acquiredAt: Timestamp;
}

export interface PlayerLoadoutRow {
  id: number;
  identity: Identity;
  slot: number;
  itemId: number;
}

export interface PlayerPresenceRow {
  identity: Identity;
  status: number;
  lastSeen: Timestamp;
}

export interface FollowRow {
  id: number;
  follower: Identity;
  following: Identity;
  createdAt: Timestamp;
}

export interface ProfileViewRow {
  id: number;
  viewer: Identity;
  profile: Identity;
  lastViewedAt: Timestamp;
  viewCount: number;
}

export interface PartyRow {
  partyId: number;
  leader: Identity;
  state: number;
  createdAt: Timestamp;
  /** Short shareable invite code ('' on legacy rows). */
  joinCode: string;
  /** The lobby MODE every member's room wears ('CLASSIC' | 'RANK'; leader-set, default CLASSIC). */
  format: string;
}

export interface PartyMemberRow {
  id: number;
  partyId: number;
  identity: Identity;
  joinedAt: Timestamp;
  /** Avatar outfit wire — lets every member's 3D figure render on the party line-up. */
  acc: string;
}

/** A live lobby invite addressed to one player (friends rail ▸ INVITE, user ask 2026-09-29). */
export interface PartyInviteRow {
  id: number;
  partyId: number;
  fromIdentity: Identity;
  toIdentity: Identity;
  /** The party's join code at invite time (JOIN runs joinPartyByCode). */
  code: string;
  createdAt: Timestamp;
}

export interface QueueEntryRow {
  identity: Identity;
  partyId?: number | null;
  colony: number;
  skillRating: number;
  queuedAt: bigint;
  status: number;
  candidateMatchId?: number | null;
  /** RANKED search (plan §5) — solo, tied to one planet. */
  ranked: boolean;
  /** `ring:galaxyId:systemId:planetId` for ranked searches, '' otherwise. */
  planetKey: string;
  /** Coarse region tag for regional matching ('as','eu','na','sa','oc','af', '' = unknown). */
  region: string;
}

export interface CandidateRow {
  matchId: number;
  createdAt: bigint;
  deadline: bigint;
  status: number;
  ranked: boolean;
  planetKey: string;
  /** Region of the candidate's seed entry — same-region players fill it first. */
  region: string;
}

export interface CandidatePlayerRow {
  id: number;
  matchId: number;
  identity: Identity;
  colony: number;
  confirmed: boolean;
  confirmedAt?: bigint | null;
}

export interface MatchRow {
  matchId: number;
  status: number;
  createdAt: Timestamp;
  startedAt?: Timestamp | null;
  endedAt?: Timestamp | null;
  mapSeed: number;
  winnerColony?: number | null;
  durationSeconds: number;
  serverTick: bigint;
  playerCount: number;
  /** RANKED match — awards stars and claims the planet (plan §37). */
  ranked: boolean;
  /** The ranked planet this match was fought on (`ring:g:s:p`), '' for classic. */
  planetKey: string;
  /** Rank ring of the planet (0..7), 255 for classic. */
  rankRing: number;
  /** MATCH_MODE_STANDARD (0) / MATCH_MODE_CUSTOM (1) — custom lobbies and their matches. */
  mode: number;
  /** The custom lobby's share code ('' for standard matches). */
  roomCode: string;
  /** Custom lobbies: the host's identity hex ('' for standard matches). */
  hostHex: string;
}

export interface MatchPlayerRow {
  id: number;
  matchId: number;
  identity: Identity;
  name: string;
  colony: number;
  kills: number;
  deaths: number;
  damage: number;
  objectives: number;
  necrotech: number;
  confirmed: boolean;
  connected: boolean;
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
  vx: number;
  vy: number;
  vz: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  hasPose: boolean;
  updatedAt: Timestamp;
  /** The player pressed LEAVE MATCH — the seat is a tombstone (no rewards, not "in a match"). */
  left: boolean;
  /** Non-empty when the anti-cheat layer force-removed the seat — shown to the offender. */
  kickReason: string;
  /** Custom lobbies: this seat is ready (the host's START gate). */
  ready: boolean;
}

/** The best SPEEDRUN / SURVIVAL run on one planet (user ask 2026-09-30). */
export interface PlanetRecordRow {
  id: number;
  /** Canonical `ring:g:s:p` planet key. */
  planetKey: string;
  /** RECORD_MODE_SPEEDRUN (0) / RECORD_MODE_SURVIVAL (1). */
  mode: number;
  /** Recorded time in milliseconds (speedrun: lowest wins; survival: highest). */
  timeMs: bigint;
  playerName: string;
  identity: Identity;
  setAt: Timestamp;
}

/** One first-play slot on a planet (any mode) — the overlay's DISCOVERED BY list. */
export interface PlanetPlayRow {
  id: number;
  planetKey: string;
  identity: Identity;
  playerName: string;
  /** 0-based discovery order (0 = first footfall). */
  slot: number;
  firstPlayedAt: Timestamp;
}

/**
 * One relayed P2P message of an official match (2026-09-29) — the SpacetimeDB-carried wire of
 * the authority protocol. Receivers rebuild the sender's game id from `fromHex` and feed
 * `{ t: kind, ...JSON.parse(payload) }` into the same `onNetMessage` handlers P2P uses.
 */
export interface MatchMsgRow {
  id: bigint;
  matchId: number;
  /** Sender identity hex. */
  fromHex: string;
  /** Target identity hex; '' = broadcast to every seat. */
  toHex: string;
  /** NetMessage kind (`st`, `s`, `ehits`, ...). */
  kind: string;
  seq: bigint;
  /** JSON body of the message (all fields except `t`). */
  payload: string;
  at: Timestamp;
}

export interface MatchHistoryRow {
  id: number;
  identity: Identity;
  matchId: number;
  colony: number;
  won: boolean;
  kills: number;
  deaths: number;
  objectives: number;
  durationSeconds: number;
  endedAt: Timestamp;
  softCurrencyEarned: bigint;
  xpEarned: number;
  /** The ranked planet this match was fought on (`ring:g:s:p`), '' for classic. */
  planetKey: string;
}

/** One row of the `my_match_usage` view — the caller's latest match's server usage summary. */
export interface MatchServerUsageRow {
  matchId: number;
  startedAt?: Timestamp | null;
  endedAt?: Timestamp | null;
  durationSeconds: number;
  playerCount: number;
  serverTicks: bigint;
  inputCommands: bigint;
  stateUpdates: bigint;
  events: bigint;
  estimatedEgressBytes: bigint;
  storageBytes: bigint;
}

// ------------------------------------------------------------ ranked mode (plan §33–§57)

/** An ACTIVE ranked season — the root of the deterministic universe. */
export interface RankedSeasonRow {
  seasonId: number;
  universeSeed: bigint;
  startedAt: Timestamp;
  endsAt?: Timestamp | null;
  active: boolean;
}

/** A persistent planet (identity + ownership only — terrain is regenerated). */
export interface RankedPlanetRow {
  planetKey: string;
  seasonId: number;
  ring: number;
  galaxyId: number;
  systemId: number;
  planetId: number;
  seed: bigint;
  state: number;
  controllingColony: number;
  controlStartedAt: bigint;
  controlExpiresAt: bigint;
  discovered: boolean;
  firstDiscoveredAt: bigint;
  lastMatchId: number;
  generatedRank: number;
}

/** First-discoverer record (first 5 only — plan §35). */
export interface PlanetDiscoveryRow {
  id: number;
  planetKey: string;
  identity: Identity;
  playerName: string;
  discoveredAt: bigint;
  discoveryOrder: number;
}

/**
 * One first-discoverer of a GALAXY / SYSTEM / PLANET (plan §1–§4): the first 9
 * unique players, `discoveryIndex` 1..9 in chronological order. `playerName`
 * and `colony` are the values AT DISCOVERY TIME (server-derived).
 */
export interface RankedLocationDiscoveryRow {
  id: number;
  locationKey: string;
  locationType: number;
  ring: number;
  galaxyId: number;
  systemId: number;
  planetId: number;
  playerIdentity: Identity;
  playerName: string;
  colony: number;
  discoveredAt: bigint;
  discoveryIndex: number;
}

/** The singleton SERVER CLOCK row (plan §14) — the 1 Hz scan stamps it. */
export interface ServerClockRow {
  id: number;
  nowUs: bigint;
}

/** A planet locked by a filling/playing ranked match (plan §36). */
export interface RankedPlanetReservationRow {
  planetKey: string;
  matchId: number;
  reservedAt: bigint;
  expiresAt: bigint;
}

/** Ownership stint (plan §77) — "this planet changed hands N times". */
export interface PlanetControlHistoryRow {
  id: number;
  planetKey: string;
  colony: number;
  matchId: number;
  startedAt: bigint;
  endedAt: bigint;
}

/** One rank movement (plan §57/§80) — the post-match screen reads the newest row. */
export interface RankHistoryRow {
  id: number;
  identity: Identity;
  seasonId: number;
  oldTier: number;
  oldDivision: number;
  oldStars: number;
  newTier: number;
  newDivision: number;
  newStars: number;
  cause: number;
  matchId: number;
  planetKey: string;
  delta: number;
  createdAt: Timestamp;
}

/** Row field for `player.identity` used as a map key. */
export function hexOf(identity: Identity | undefined | null): string {
  return identity ? identity.toHexString() : '';
}
