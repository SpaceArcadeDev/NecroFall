// NECROFALL — official match schema (plan §25/§27/§28/§45).
//
// `match` and `match_player` are public because the client renders them;
// `match_input` is private (authority data — clients only send it);
// high-frequency temporary state is deleted when the match ends (plan §46).
import { table, t } from 'spacetimedb/server';

export const match = table(
  { name: 'match', public: true },
  {
    match_id: t.u32().primaryKey().autoInc(),
    /** MATCH_STARTING / MATCH_RUNNING / MATCH_FINISHED */
    status: t.u8(),
    created_at: t.timestamp(),
    started_at: t.option(t.timestamp()),
    ended_at: t.option(t.timestamp()),
    /** World seed decided by the SERVER — every client builds the same planet (plan §54). */
    map_seed: t.u32(),
    winner_colony: t.option(t.u8()),
    duration_seconds: t.u32(),
    server_tick: t.u64(),
    player_count: t.u32(),
  }
);

/**
 * One row per player per match: identity metadata, live authoritative pose and
 * the tally the server keeps while playing. The pose columns are what remote
 * clients interpolate (plan §20/§51).
 */
export const match_player = table(
  { name: 'match_player', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    match_id: t.u32().index('btree'),
    identity: t.identity().index('btree'),
    name: t.string(),
    colony: t.u8(),
    kills: t.u32(),
    deaths: t.u32(),
    damage: t.f64(),
    objectives: t.u32(),
    /** Necrotech class index used as the starting Nexus loadout for this match. */
    necrotech: t.u32(),
    confirmed: t.bool(),
    connected: t.bool(),
    // ---- live pose (world space, on the sphere) ----
    x: t.f64(),
    y: t.f64(),
    z: t.f64(),
    fx: t.f64(),
    fy: t.f64(),
    fz: t.f64(),
    vx: t.f64(),
    vy: t.f64(),
    vz: t.f64(),
    hp: t.f64(),
    max_hp: t.f64(),
    alive: t.bool(),
    /**
     * True once the owning client has reported a real spawn pose. Pose columns
     * before that are meaningless (0,0,0) and remote clients ignore them.
     */
    has_pose: t.bool(),
    /** Last interim combat-stat report (micros) — rate-limits `report_match_stats`. */
    stats_reported_at: t.u64(),
    updated_at: t.timestamp(),
  }
);

/**
 * Latest input / pose report per player. PRIVATE: this is the anti-cheat and
 * simulation feed, not something clients read (plan §18/§22/§54).
 */
export const match_input = table(
  { name: 'match_input' },
  {
    id: t.u32().primaryKey().autoInc(),
    match_id: t.u32().index('btree'),
    identity: t.identity().index('btree'),
    /** Desired world-space velocity (direction * speed) — see `submit_input`. */
    move_x: t.f64(),
    move_y: t.f64(),
    move_z: t.f64(),
    /** Aim/facing direction (world space). */
    aim_x: t.f64(),
    aim_y: t.f64(),
    aim_z: t.f64(),
    /** Monotonic client sequence — stale packets are dropped. */
    seq: t.u64(),
    /** One-shot dash request counter; the server sees how often it fires (plan §74). */
    dash_seq: t.u64(),
    /** Absolute pose the client last claimed (validated against the simulated one). */
    pose_x: t.f64(),
    pose_y: t.f64(),
    pose_z: t.f64(),
    pose_fx: t.f64(),
    pose_fy: t.f64(),
    pose_fz: t.f64(),
    /** Micros since epoch — the sim does deadline arithmetic on these. */
    last_input_at: t.u64(),
    last_pose_at: t.u64(),
  }
);

/** Compact per-match result per player — the match-history screen (plan §45). */
export const match_history = table(
  { name: 'match_history', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    identity: t.identity().index('btree'),
    match_id: t.u32(),
    colony: t.u8(),
    won: t.bool(),
    kills: t.u32(),
    deaths: t.u32(),
    objectives: t.u32(),
    duration_seconds: t.u32(),
    ended_at: t.timestamp(),
    soft_currency_earned: t.u64(),
    xp_earned: t.u32(),
  }
);

/**
 * Per-match server usage summary (plan §28). PRIVATE — admin/debug only; never
 * exposed to normal players. Read it from the CLI:
 *   spacetime sql <db> "SELECT * FROM match_server_usage"
 */
export const match_server_usage = table(
  { name: 'match_server_usage' },
  {
    match_id: t.u32().primaryKey(),
    started_at: t.option(t.timestamp()),
    ended_at: t.option(t.timestamp()),
    duration_seconds: t.u32(),
    player_count: t.u32(),
    server_ticks: t.u64(),
    input_commands: t.u64(),
    state_updates: t.u64(),
    events: t.u64(),
    /** Estimated bytes replicated out during the match (plan §28/§29). */
    estimated_egress_bytes: t.u64(),
    storage_bytes: t.u64(),
  }
);
