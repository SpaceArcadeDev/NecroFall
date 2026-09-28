// NECROFALL — ranked-world schema (plan §33/§35/§36/§56/§57).
//
// THE VIRTUAL UNIVERSE RULE (plan §0): never store a row for every generated
// planet. A `ranked_planet` row exists ONLY once a planet becomes
// player-relevant — discovered, controlled, or reserved for a live match.
// Everything else is regenerated from the season seed on demand.
import { table, t } from 'spacetimedb/server';

/**
 * One row per SEASON (plan §56). `universe_seed` is the root of the entire
 * deterministic universe — every galaxy, planet, terrain and ecology derives
 * from it, so a new season is a brand-new universe with one integer.
 */
export const ranked_season = table(
  { name: 'ranked_season', public: true },
  {
    season_id: t.u32().primaryKey().autoInc(),
    universe_seed: t.u64(),
    started_at: t.timestamp(),
    ends_at: t.option(t.timestamp()),
    active: t.bool(),
  }
);

/**
 * A persistent planet (plan §33): identity + ownership only. Terrain, biome,
 * ecology and enemies are NEVER stored — clients regenerate them from `seed`.
 */
export const ranked_planet = table(
  { name: 'ranked_planet', public: true },
  {
    /** `ring:galaxyId:systemId:planetId` — see `seed.ts`. */
    planet_key: t.string().primaryKey(),
    season_id: t.u32(),
    ring: t.u8(),
    galaxy_id: t.u32().index('btree'),
    system_id: t.u32(),
    planet_id: t.u32(),
    /** The canonical planet seed (u64) — matches `map_seed` of ranked matches. */
    seed: t.u64(),
    /** RANKED_PLANET_INFESTED (0) / RANKED_PLANET_CONTROLLED (1). */
    state: t.u8(),
    /** 0..2, or COLONY_NONE (255) while infested. */
    controlling_colony: t.u8(),
    /** Micros since epoch. 0 = never. */
    control_started_at: t.u64(),
    control_expires_at: t.u64(),
    discovered: t.bool(),
    first_discovered_at: t.u64(),
    last_match_id: t.u32(),
    /** The ring's generation rank at first contact (debug/analytics). */
    generated_rank: t.u32(),
  }
);

/**
 * First-discoverer log (plan §35). Only the first 5 discoverers are kept —
 * a collectible social record, not a click log.
 */
export const planet_discovery = table(
  { name: 'planet_discovery', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    planet_key: t.string().index('btree'),
    identity: t.identity(),
    player_name: t.string(),
    discovered_at: t.u64(),
    /** 1-based — who was first, second, … */
    discovery_order: t.u8(),
  }
);

/**
 * Short-lived planet lock while a ranked match fills/plays (plan §36).
 * `expires_at` is the safety net; the match finishing deletes the row.
 */
export const ranked_planet_reservation = table(
  { name: 'ranked_planet_reservation', public: true },
  {
    planet_key: t.string().primaryKey(),
    match_id: t.u32(),
    reserved_at: t.u64(),
    expires_at: t.u64(),
  }
);

/** Ownership timeline (plan §77): "this planet has changed hands N times". */
export const planet_control_history = table(
  { name: 'planet_control_history', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    planet_key: t.string().index('btree'),
    colony: t.u8(),
    match_id: t.u32(),
    started_at: t.u64(),
    /** 0 while the stint is still running. */
    ended_at: t.u64(),
  }
);

/** Every rank movement, for the profile feed and the post-match screen (plan §57). */
export const rank_history = table(
  { name: 'rank_history', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    identity: t.identity().index('btree'),
    season_id: t.u32(),
    old_tier: t.u8(),
    old_division: t.u8(),
    old_stars: t.u32(),
    new_tier: t.u8(),
    new_division: t.u8(),
    new_stars: t.u32(),
    /** RANK_CAUSE_WIN / RANK_CAUSE_DRAW / RANK_CAUSE_LOSS / RANK_CAUSE_SEED */
    cause: t.u8(),
    match_id: t.u32(),
    planet_key: t.string().default(''),
    delta: t.i32(),
    created_at: t.timestamp(),
  }
);

export const RANKED_PLANET_INFESTED = 0;
export const RANKED_PLANET_CONTROLLED = 1;

export const RANK_CAUSE_WIN = 0;
export const RANK_CAUSE_DRAW = 1;
export const RANK_CAUSE_LOSS = 2;
export const RANK_CAUSE_SEED = 3;
