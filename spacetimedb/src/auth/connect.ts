// NECROFALL — connection lifecycle (plan §63/§68).
//
// SpacetimeAuth handles authentication; the SpacetimeDB Identity that arrives
// with the connection IS the player identity. This file creates the account on
// first sight and maintains presence/party/queue hygiene as connections come
// and go. It NEVER writes per-second timestamps: presence is lifecycle-driven.
import { spacetimedb } from '../schema';
import { player, player_presence, player_stats, player_wallet, player_inventory } from '../schema/player';
import { party, party_member, queue_entry, candidate_match, match_candidate_player } from '../schema/matchmaking';
import { match_player } from '../schema/match';
import { COLONY_NONE, PRESENCE_OFFLINE, PRESENCE_ONLINE } from '../constants';

/** Starter cosmetics every fresh account owns (ids are the client catalog's). */
const STARTER_ITEMS = [
  { item: 1, qty: 1 }, // default avatar
  { item: 2, qty: 1 }, // default profile frame
  { item: 3, qty: 1 }, // default nameplate
];

/** Friend-code alphabet: uppercase, minus the lookalikes (I/O/0/1/B/8). */
const CODE_ALPHABET = 'ACDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/**
 * Mint a short unique friend code. Reducers are single-writer, so scanning the
 * roster for a collision is race-free; after a few attempts fall back to a
 * chunk of the identity hex, which is unique by construction.
 */
function allocate_player_code(ctx: any): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(ctx.random() * CODE_ALPHABET.length)];
    }
    let taken = false;
    for (const row of ctx.db.player.iter()) {
      if (row.player_code === code) {
        taken = true;
        break;
      }
    }
    if (!taken) return code;
  }
  return ctx.sender.toHexString().replace(/^0x/, '').slice(-CODE_LENGTH).toUpperCase();
}

/**
 * Find the caller's account, creating it (plus wallet/stats/inventory seed) on
 * first connection. Cheap: one primary-key lookup on the hot path.
 */
export function ensureAccount(ctx: any): any {
  const identity = ctx.sender;
  let p = ctx.db.player.identity.find(identity);
  if (p) {
    // Rows created before friend codes existed get one on first contact.
    if (!p.player_code) {
      p = ctx.db.player.identity.update({ ...p, player_code: allocate_player_code(ctx) });
    }
    return p;
  }

  const now = ctx.timestamp;
  p = ctx.db.player.insert({
    identity,
    player_name: '',
    normalized_name: `pending:${identity.toHexString()}`,
    player_code: allocate_player_code(ctx),
    profile_name: '',
    profile_picture: 0,
    avatar_id: 0,
    colony: COLONY_NONE,
    level: 1,
    xp: 0n,
    wins: 0,
    losses: 0,
    matches_played: 0,
    current_rank: 0,
    rank_points: 0,
    rank_status: 0,
    season_id: 0,
    skill_rating: 1000,
    likes_received: 0,
    profile_views: 0,
    followers_count: 0,
    following_count: 0,
    created_at: now,
    last_seen_at: now,
    last_online_at: now,
    banned: false,
    bio: '',
    gender: 0,
    peak_rank_points: 0,
  });
  ctx.db.player_wallet.insert({ identity, soft_currency: 0n, premium_currency: 0n });
  ctx.db.player_stats.insert({
    identity,
    kills: 0,
    deaths: 0,
    boss_kills: 0,
    beacons_captured: 0,
    nexus_captures: 0,
    damage_dealt: 0,
    damage_taken: 0,
    play_time_seconds: 0n,
    p2p_matches: 0,
    p2p_wins: 0,
  });
  for (const item of STARTER_ITEMS) {
    ctx.db.player_inventory.insert({
      id: 0,
      identity,
      item_id: item.item,
      quantity: item.qty,
      acquired_at: now,
    });
  }
  ctx.db.player_presence.insert({ identity, status: PRESENCE_ONLINE, last_seen: now });
  ctx.db.player_settings.insert({ identity, keybinds: '' });
  return p;
}

/**
 * A connection authenticated. Create the account if needed, mark presence
 * online and refresh the coarse "last seen" stamps (plan §68).
 */
export const on_client_connected = spacetimedb.clientConnected((ctx) => {
  const p = ensureAccount(ctx);
  const now = ctx.timestamp;
  const presence = ctx.db.player_presence.identity.find(ctx.sender);
  if (presence) {
    ctx.db.player_presence.identity.update({ ...presence, status: PRESENCE_ONLINE, last_seen: now });
  } else {
    ctx.db.player_presence.insert({ identity: ctx.sender, status: PRESENCE_ONLINE, last_seen: now });
  }
  ctx.db.player.identity.update({ ...p, last_seen_at: now, last_online_at: now });
});

/**
 * A connection dropped. Keep matchmaking state consistent (a queued ghost
 * would shrink every match by one), hand party leadership over, and mark any
 * live match seat as disconnected. The seat itself survives — reconnection is
 * a client concern with its own grace period (plan §49/§73).
 */
export const on_client_disconnected = spacetimedb.clientDisconnected((ctx) => {
  const identity = ctx.sender;
  const now = ctx.timestamp;

  const presence = ctx.db.player_presence.identity.find(identity);
  if (presence) {
    ctx.db.player_presence.identity.update({ ...presence, status: PRESENCE_OFFLINE, last_seen: now });
  }
  const p = ctx.db.player.identity.find(identity);
  if (p) ctx.db.player.identity.update({ ...p, last_seen_at: now, last_online_at: now });

  // ---- matchmaking hygiene (plan §73: disconnects at any stage drop the seat)
  const hex = identity.toHexString();
  const qe = ctx.db.queue_entry.identity.find(identity);
  if (qe) {
    if (qe.candidate_match_id !== undefined && qe.candidate_match_id !== null) {
      const candidateId = qe.candidate_match_id as number;
      for (const row of ctx.db.match_candidate_player.match_id.filter(candidateId)) {
        if (row.identity.toHexString() === hex) ctx.db.match_candidate_player.id.delete(row.id);
      }
    }
    ctx.db.queue_entry.identity.delete(identity);
  }

  // ---- live match: keep the seat, flag it disconnected
  for (const mp of ctx.db.match_player.identity.filter(identity)) {
    if (mp.connected) ctx.db.match_player.id.update({ ...mp, connected: false, updated_at: now });
  }

  // ---- party leadership handover (plan §73: transfer, never orphan)
  const membership = ctx.db.party_member.identity.find(identity);
  if (membership) {
    const partyId = membership.party_id;
    ctx.db.party_member.identity.delete(identity);
    const remaining = [...ctx.db.party_member.party_id.filter(partyId)];
    if (remaining.length === 0) {
      ctx.db.party.party_id.delete(partyId);
    } else {
      const partyRow = ctx.db.party.party_id.find(partyId);
      if (partyRow && partyRow.leader.toHexString() === hex) {
        // Oldest remaining member takes the party.
        remaining.sort((a, b) => Number(a.joined_at.microsSinceUnixEpoch - b.joined_at.microsSinceUnixEpoch));
        ctx.db.party.party_id.update({ ...partyRow, leader: remaining[0].identity });
      }
    }
  }

  // A deserted candidate below the minimum is cancelled by the scanner on its
  // next pass (it re-checks every candidate's live membership).
  void candidate_match;
});
