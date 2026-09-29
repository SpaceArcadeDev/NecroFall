// NECROFALL — SpacetimeDB module constants shared across schema/reducers.
//
// These mirror the numeric conventions the client keeps in
// `src/app/spacetimedb/rows.ts`. Changing a number here means changing it
// there too (both files carry the same comment).

// ------------------------------------------------------------ colonies
/** Player accounts WITHOUT a colony. 0/1/2 are the real colonies. */
export const COLONY_NONE = 255;
/** Hard cap of players per colony in one official match (plan §13). */
export const COLONY_CAP = 3;
/** Hard cap of players in one official match (3 colonies x cap). */
export const MATCH_MAX_PLAYERS = 9;
/** Minimum players for an official match to start (plan §12). */
export const MATCH_MIN_PLAYERS = 1;

// ------------------------------------------------------------ queue / candidate status
/** QueuedEntryStatus: waiting in the queue. */
export const QUEUE_QUEUED = 0;
/** QueuedEntryStatus: attached to a filling candidate match. */
export const QUEUE_CANDIDATE = 1;
/** QueuedEntryStatus: confirmed the candidate — a match is being created. */
export const QUEUE_CONFIRMED = 2;

/** CandidateMatchStatus: still inside the 5 second fill window. */
export const CANDIDATE_FILLING = 0;
/** CandidateMatchStatus: 10 second player confirmation window. */
export const CANDIDATE_CONFIRMING = 1;
/** CandidateMatchStatus: consumed — a match was created from it. */
export const CANDIDATE_STARTED = 2;

// ------------------------------------------------------------ match status
export const MATCH_STARTING = 0;
export const MATCH_RUNNING = 1;
export const MATCH_FINISHED = 2;
/**
 * How long a RUNNING match survives with ZERO connected players (user ask 2026-09-28): a dropped
 * client (reload, network blip) has this long to come back with `join_match` and continue where
 * it left off. Only a full window with nobody back concludes the match (`NECROPHAGES WIN`).
 */
export const MATCH_EMPTY_GRACE_US = 30_000_000n;

// ------------------------------------------------------------ party
export const PARTY_OPEN = 0;
/** Party is attached to a candidate/match — no joins/leaves mid-flight. */
export const PARTY_LOCKED = 1;

// ------------------------------------------------------------ presence
export const PRESENCE_OFFLINE = 0;
export const PRESENCE_ONLINE = 1;
export const PRESENCE_IN_MATCH = 2;

// ------------------------------------------------------------ match events
export const EVENT_PLAYER_SPAWNED = 1;
export const EVENT_PLAYER_DIED = 2;
export const EVENT_ENEMY_SPAWNED = 3;
export const EVENT_ENEMY_DIED = 4;
export const EVENT_BOSS_RAGED = 5;
export const EVENT_BOSS_DIED = 6;
export const EVENT_BEACON_CAPTURED = 7;
export const EVENT_NEXUS_CAPTURED = 8;
export const EVENT_MATCH_STARTED = 9;
export const EVENT_MATCH_ENDED = 10;
/** A whole ranked colony forfeited (user ask 2026-09-30): the surrender vote passed. */
export const EVENT_SURRENDER = 11;

// ------------------------------------------------------------ timers (microseconds)
/** One server simulation tick at 10 Hz (plan §17/§40). */
export const TICK_INTERVAL_US = 100_000n;
/** The 5 second fill window that starts once 2 players are queued (plan §12). */
export const FILL_WINDOW_US = 5_000_000n;
/** The 10 second confirmation window (plan §14). */
export const CONFIRM_WINDOW_US = 10_000_000n;
/** Safety net: an official match force-finishes after this long. */
export const MATCH_MAX_DURATION_US = 30n * 60n * 1_000_000n;

// ------------------------------------------------------------ movement validation (plan §74)
/**
 * Fastest a survivor may legitimately travel (u/s). Mirrors the dartiest
 * client-side movement caps (dash 19+ with momentum); a report further than
 * `MAX_SPEED * elapsed * SLACK` is clamped back onto the reachable sphere.
 */
export const MAX_MOVE_SPEED = 24;
export const MOVE_TOLERANCE = 1.6;
/** Milestone: planet radius — keep in sync with CONFIG.planetRadius (Config.ts). */
export const PLANET_RADIUS = 118;

// ------------------------------------------------------------ economy (plan §7)
/** Integer units only. */
export const REWARD_SOFT_WIN = 60;
export const REWARD_SOFT_LOSS = 15;
export const REWARD_SOFT_KILL = 5;
export const REWARD_SOFT_OBJECTIVE = 20;
export const REWARD_PREMIUM_WIN = 2;

// ------------------------------------------------------------ ranked mode (plan §33–§57)
/** Season 1's universe seed — the root of every galaxy/planet (plan §56). */
export const SEASON_ONE_UNIVERSE_SEED = 918273645n;
/** A ranked planet is locked while its match fills/plays (plan §36). */
export const PLANET_RESERVATION_US = 5n * 60n * 1_000_000n;
/** While a ranked match is LIVE the reservation covers the whole fight. */
export const PLANET_MATCH_RESERVATION_US = 60n * 60n * 1_000_000n;
/** Planetary shield lifetime after a liberation (plan §38 — 72 hours). */
export const PLANET_CONTROL_US = 72n * 60n * 60n * 1_000_000n;
/** Keep only the first N discoverers per planet (plan §35). */
export const MAX_PLANET_DISCOVERERS = 5;

// ------------------------------------------------------------ solo modes + planet records (2026-09-30)
/** Standard matches (matchmaking / ranked). */
export const MATCH_MODE_STANDARD = 0;
/** Custom lobbies and the matches they start. */
export const MATCH_MODE_CUSTOM = 1;
/** planet_record.mode: fastest win on the planet (lowest time_ms wins). */
export const RECORD_MODE_SPEEDRUN = 0;
/** planet_record.mode: longest survival on the planet (highest time_ms wins). */
export const RECORD_MODE_SURVIVAL = 1;
/** Heartbeat freshness window for `record_planet_play` — one call per match start. */
export const MAX_PLANET_PLAYS = 9;
/** Sanity bounds for submitted times (ms). A speedrun shorter than this is not real. */
export const RECORD_MIN_SPEEDRUN_MS = 20_000n;
export const RECORD_MAX_SPEEDRUN_MS = 3_600_000n;
/** A survival run must last this long to count, and cannot exceed this. */
export const RECORD_MIN_SURVIVAL_MS = 5_000n;
export const RECORD_MAX_SURVIVAL_MS = 86_400_000n;
