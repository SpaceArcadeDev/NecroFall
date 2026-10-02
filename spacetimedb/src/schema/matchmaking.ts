// NECROFALL — matchmaking schema (plan §15/§72).
//
// Queue and candidate state are PRIVATE: clients only see their own slice
// through the views in `src/views.ts` (plan §22). One global 1 Hz scan table
// drives the 5 s fill window and the 10 s confirmation window (plan §40 bans
// per-entity schedulers — there is one scanner for the whole queue).
import { table, t } from 'spacetimedb/server';
import { QUEUE_QUEUED } from '../constants';

/** A pre-made group queuing together. Max size enforced by reducers (plan §72). */
export const party = table(
  { name: 'party', public: true },
  {
    party_id: t.u32().primaryKey().autoInc(),
    leader: t.identity(),
    /** PARTY_OPEN / PARTY_LOCKED */
    state: t.u8(),
    created_at: t.timestamp(),
    /** Short shareable invite code — how friends join your party ('' = legacy row). */
    join_code: t.string().default(''),
  }
);

export const party_member = table(
  { name: 'party_member', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    party_id: t.u32().index('btree'),
    /** One party per player: unique index enforces it. */
    identity: t.identity().unique(),
    joined_at: t.timestamp(),
    /** Avatar outfit wire ("hat,backpack,pet") — renders every member's figure lobby-style. */
    acc: t.string().default(''),
    /**
     * Connection liveness. A member row now SURVIVES a socket drop and is only swept after
     * the reconnect grace — sharing an invite on mobile means switching apps, and that used
     * to delete the membership instantly and throw the sharer out of their own lobby
     * (user report 2026-10-03). Legacy rows read as connected.
     */
    connected: t.bool().default(true),
    /** When the member's connection dropped (undefined while connected / legacy rows). */
    disconnected_at: t.option(t.timestamp()).default(undefined),
  }
);

/**
 * A lobby invite from a party member to a player (friends rail ▸ INVITE — user ask
 * 2026-09-29). Public and targeted: the invitee's account scope subscribes only
 * `WHERE to_identity = me`, and the client shows it as a JOIN notification.
 * One live invite per (party, target); consumed on join, declined, dissolved or swept.
 */
export const party_invite = table(
  { name: 'party_invite', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    party_id: t.u32().index('btree'),
    from_identity: t.identity(),
    to_identity: t.identity().index('btree'),
    /** The party's join code at invite time — JOIN runs the normal join_party_by_code. */
    code: t.string(),
    created_at: t.timestamp(),
  }
);

/** Internal queue row. One per player (identity is the primary key). */
export const queue_entry = table(
  { name: 'queue_entry' },
  {
    identity: t.identity().primaryKey(),
    party_id: t.option(t.u32()),
    colony: t.u8(),
    skill_rating: t.u32(),
    /** Micros since epoch — keep arithmetic simple inside the scanner. */
    queued_at: t.u64(),
    /** QUEUE_QUEUED / QUEUE_CANDIDATE / QUEUE_CONFIRMED */
    status: t.u8(),
    candidate_match_id: t.option(t.u32()),
    /** RANKED queue (plan §5/§53): ranked candidates only mix with ranked entries. */
    ranked: t.bool().default(false),
    /** The planet the player queued for (`ring:g:s:p`) — '' for classic queues. */
    planet_key: t.string().default(''),
    /**
     * Coarse player region ('as','eu','na','sa','oc','af'; '' = unknown) — a LATENCY hint:
     * hybrid gameplay is peer-to-peer, so same-region pairing keeps the direct hop short.
     * After a short wait the region lock relaxes so small regions still find matches.
     */
    region: t.string().default(''),
  }
);

/** A candidate being filled/confirmed before it becomes a real match. */
export const candidate_match = table(
  { name: 'candidate_match' },
  {
    match_id: t.u32().primaryKey().autoInc(),
    created_at: t.u64(),
    /** Server micros after which the fill window closes / confirmation expires. */
    deadline: t.u64(),
    /** CANDIDATE_FILLING / CANDIDATE_CONFIRMING / CANDIDATE_STARTED */
    status: t.u8(),
    /** Ranked candidate: only ranked queue entries on the same planet may fill it. */
    ranked: t.bool().default(false),
    planet_key: t.string().default(''),
    /** Region of the candidate's seed entry — same-region entries fill it first (see queue.ts). */
    region: t.string().default(''),
  }
);

export const match_candidate_player = table(
  { name: 'match_candidate_player' },
  {
    id: t.u32().primaryKey().autoInc(),
    match_id: t.u32().index('btree'),
    /** At most one candidate seat per player — unique index enforces it. */
    identity: t.identity().unique(),
    colony: t.u8(),
    confirmed: t.bool(),
    confirmed_at: t.option(t.u64()),
  }
);

/**
 * The one global matchmaking scanner (1 Hz). A single schedule row lives for
 * the lifetime of the database; every pass ages the fill/confirmation windows.
 */
export const matchmaking_scan = table(
  { name: 'matchmaking_scan' },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
  }
);

export const DEFAULT_QUEUE_STATUS = QUEUE_QUEUED;
