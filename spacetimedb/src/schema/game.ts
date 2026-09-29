// NECROFALL — live game-world schema (plan §25/§40/§51).
//
// One match_tick schedule row per RUNNING match drives the 10 Hz authoritative
// simulation; entity rows carry only what clients must render (positions, HP,
// state — never meshes/textures/animations).
import { table, t } from 'spacetimedb/server';

/**
 * Per-match simulation schedule. Inserted when a match starts, one interval row
 * per match (never per player / per enemy), deleted when the match finishes.
 */
export const match_tick = table(
  { name: 'match_tick' },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    match_id: t.u32().index('btree'),
  }
);

/**
 * Server-owned world entity: enemies, bosses and driven objects. The client
 * maps `entity_type` onto a local 3D asset (plan §51/§52). Players are NOT
 * stored here — they live in `match_player`.
 */
export const match_entity = table(
  { name: 'match_entity', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    match_id: t.u32().index('btree'),
    /** Match-local entity id (plan §52) — the client pools objects by this. */
    entity_id: t.u32(),
    /** Entity kind id (enemy genome index, boss id, ...). */
    entity_type: t.u32(),
    x: t.f64(),
    y: t.f64(),
    z: t.f64(),
    vx: t.f64(),
    vy: t.f64(),
    vz: t.f64(),
    hp: t.f64(),
    state: t.u32(),
    target: t.u32(),
    updated_at: t.timestamp(),
  }
);

/** Objective state (beacons / Nexus) — written on change only (plan §20/§21). */
export const match_objective = table(
  { name: 'match_objective', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    match_id: t.u32().index('btree'),
    objective_id: t.u32(),
    owner_colony: t.u8(),
    capture_progress: t.f64(),
    shield: t.u32(),
    state: t.u32(),
    updated_at: t.timestamp(),
  }
);

/**
 * Discrete, one-shot game events (PLAYER_DIED, BOSS_RAGED, ...). Clients react
 * (VFX) instead of us re-broadcasting state flags (plan §21). Temporary:
 * purged with the rest of the live state when a match ends.
 */
export const match_event = table(
  { name: 'match_event', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    match_id: t.u32().index('btree'),
    /** EVENT_* constant from ../constants.ts */
    kind: t.u32(),
    a: t.u32(),
    b: t.u32(),
    x: t.f64(),
    y: t.f64(),
    z: t.f64(),
    at: t.timestamp(),
  }
);

/**
 * THE RELAY (2026-09-29) — the P2P message wire, carried by SpacetimeDB.
 *
 * The official match runs the SAME authority protocol as a P2P room: one seat (the lowest
 * connected match_player id, deterministic for everyone) is the match authority and behaves
 * exactly like a P2P host — it simulates the world and broadcasts the same snapshots/events;
 * the other seats behave like P2P clients (full pose+stats reports at ~15 Hz into the
 * authority, one-shot asks for hits/pickups/abilities). Every message is a row here instead
 * of a DataChannel frame, and receivers feed rows into the very same `onNetMessage`
 * handlers, so both modes share one gameplay protocol.
 *
 * Sliding window, not storage: the 10 Hz match tick sweeps rows older than a few seconds,
 * so the table only ever holds in-flight traffic (plan §46 spirit). ``to_hex`` '' = broadcast.
 */
export const match_msg = table(
  { name: 'match_msg', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    match_id: t.u32().index('btree'),
    /** Sender identity hex — receivers rebuild the game-side id from it. */
    from_hex: t.string(),
    /** Target identity hex; '' = every seat (the authority's broadcast). */
    to_hex: t.string(),
    /** P2P message kind — the NetMessage `t` field (`st`, `s`, `ehits`, ...). */
    kind: t.string(),
    /** Sender-monotonic counter (diagnostics). */
    seq: t.u64(),
    /** JSON body of the message (every field except `t`). Capped by the reducer. */
    payload: t.string(),
    at: t.timestamp(),
  }
);

/**
 * Per-sender relay rate limiter (private). Fixed one-second window per identity; the row
 * outlives the match (one row per account, tiny) so reconnects cannot reset a budget.
 */
export const match_msg_rate = table(
  { name: 'match_msg_rate' },
  {
    identity: t.identity().primaryKey(),
    /** Micros since epoch when the current 1 s window opened. */
    window_start: t.u64(),
    /** Messages accepted inside the current window. */
    count: t.u32(),
  }
);
