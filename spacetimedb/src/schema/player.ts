// NECROFALL — player-side schema (plan §3/§24/§44).
//
// All player data is keyed by the SpacetimeDB Identity: it IS the player id.
// Nothing here is writable by the client directly — reducers validate and
// mutate; the client only ever holds a subscribed read view.
import { table, t } from 'spacetimedb/server';

/**
 * One row per authenticated human. `colony` uses COLONY_NONE (255) until the
 * onboarding pick is made; official matchmaking refuses accounts without one.
 */
export const player = table(
  { name: 'player', public: true },
  {
    identity: t.identity().primaryKey(),
    player_name: t.string(),
    /** lowercased/trimmed player_name — UNIQUE so names cannot collide (plan §64). */
    normalized_name: t.string().unique(),
    profile_name: t.string(),
    /** Index into the predefined profile-picture set (plan §65: no uploads yet). */
    profile_picture: t.u32(),
    /** 3D avatar id (`survivor_01`, ...) — the client maps it to a model (plan §66). */
    avatar_id: t.u32(),
    /** 0..2, or COLONY_NONE (255) before onboarding. */
    colony: t.u8(),
    level: t.u32(),
    xp: t.u64(),
    wins: t.u32(),
    losses: t.u32(),
    matches_played: t.u32(),
    /** Rank placeholder — the database fields exist now, the system ships later (plan §43). */
    current_rank: t.u32(),
    rank_points: t.i32(),
    rank_status: t.u8(),
    season_id: t.u32(),
    /** Default until MMR exists; matchmaking reads it from day one (plan §13). */
    skill_rating: t.u32(),
    likes_received: t.u32(),
    profile_views: t.u32(),
    followers_count: t.u32(),
    following_count: t.u32(),
    created_at: t.timestamp(),
    last_seen_at: t.timestamp(),
    last_online_at: t.timestamp(),
    banned: t.bool(),
    /** Short shareable friend code (6 chars, no lookalikes) — how players find each other (plan §64).
        Indexed for exact-code lookups; added after the roster subscription was removed so no
        query ever sequentially scans this table (SpacetimeDB advisor warning).
        Appended LAST: additive schema changes must keep existing column order. */
    player_code: t.string().default('').index('btree'),
  }
);

/** Lifetime totals across official matches (plan §44). */
export const player_stats = table(
  { name: 'player_stats', public: true },
  {
    identity: t.identity().primaryKey(),
    kills: t.u32(),
    deaths: t.u32(),
    boss_kills: t.u32(),
    beacons_captured: t.u32(),
    nexus_captures: t.u32(),
    damage_dealt: t.f64(),
    damage_taken: t.f64(),
    play_time_seconds: t.u64(),
    /** Community (P2P) games are tracked separately and never grant official rewards (plan §34/§75). */
    p2p_matches: t.u32(),
    p2p_wins: t.u32(),
  }
);

/** Integer currency only — floating point money is forbidden (plan §7). */
export const player_wallet = table(
  { name: 'player_wallet', public: true },
  {
    identity: t.identity().primaryKey(),
    soft_currency: t.u64(),
    premium_currency: t.u64(),
  }
);

/** Cosmetic/item ownership. The client never claims ownership — reducers check here (plan §7). */
export const player_inventory = table(
  { name: 'player_inventory', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    identity: t.identity().index('btree'),
    item_id: t.u32(),
    quantity: t.u32(),
    acquired_at: t.timestamp(),
  }
);

/** One equipped item per cosmetic slot (plan §7). Slots are documented u32 ids. */
export const player_loadout = table(
  { name: 'player_loadout', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    identity: t.identity().index('btree'),
    slot: t.u32(),
    item_id: t.u32(),
  }
);

/** Presence drives the friends rail; written on connection lifecycle, not per second (plan §68). */
export const player_presence = table(
  { name: 'player_presence', public: true },
  {
    identity: t.identity().primaryKey(),
    /** PRESENCE_OFFLINE / ONLINE / IN_MATCH */
    status: t.u8(),
    last_seen: t.timestamp(),
  }
);

/**
 * Per-account client settings (plan §37). `keybinds` is a small JSON blob of
 * action → KeyboardEvent.code; empty means "use the defaults".
 */
export const player_settings = table(
  { name: 'player_settings', public: true },
  {
    identity: t.identity().primaryKey(),
    keybinds: t.string().default(''),
  }
);

/**
 * Admin allow-list (plan §42). PRIVATE — normal players never see it, and no
 * reducer exposes its contents. Seed it:
 *   spacetime sql <db> "INSERT INTO admin_identity (identity) VALUES (0x...)"
 */
export const admin_identity = table(
  { name: 'admin_identity' },
  {
    identity: t.identity().primaryKey(),
  }
);
