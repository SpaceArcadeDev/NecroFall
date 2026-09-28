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
}

export interface PartyMemberRow {
  id: number;
  partyId: number;
  identity: Identity;
  joinedAt: Timestamp;
  /** Avatar outfit wire — lets every member's 3D figure render on the party line-up. */
  acc: string;
}

export interface QueueEntryRow {
  identity: Identity;
  partyId?: number | null;
  colony: number;
  skillRating: number;
  queuedAt: bigint;
  status: number;
  candidateMatchId?: number | null;
}

export interface CandidateRow {
  matchId: number;
  createdAt: bigint;
  deadline: bigint;
  status: number;
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

/** Row field for `player.identity` used as a map key. */
export function hexOf(identity: Identity | undefined | null): string {
  return identity ? identity.toHexString() : '';
}
