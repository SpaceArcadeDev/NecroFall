// NECROFALL — public views over PRIVATE tables (plan §22/§23).
//
// Matchmaking internals stay private; each player can still see their own
// queue seat and the candidate match they are part of — and nothing else.
// The views return ARRAYS (0 or 1 row) so client iterators are unambiguous.
import { t } from 'spacetimedb/server';
import { spacetimedb } from './schema';
import { candidate_match, match_candidate_player, queue_entry } from './schema/matchmaking';
import { match_player, match_server_usage } from './schema/match';

/** The caller's own queue entry (or none). */
export const my_queue_entry = spacetimedb.view(
  { name: 'my_queue_entry', public: true },
  t.array(queue_entry.rowType),
  (ctx) => {
    const row = ctx.db.queue_entry.identity.find(ctx.sender);
    return row ? [row] : [];
  }
);

/** The candidate the caller is currently seated in (or none). */
export const my_candidate = spacetimedb.view(
  { name: 'my_candidate', public: true },
  t.array(candidate_match.rowType),
  (ctx) => {
    const seat = ctx.db.match_candidate_player.identity.find(ctx.sender);
    if (!seat) return [];
    const row = ctx.db.candidate_match.match_id.find(seat.match_id);
    return row ? [row] : [];
  }
);

/** The seats of the caller's candidate — colonies and confirmation flags only. */
export const my_candidate_players = spacetimedb.view(
  { name: 'my_candidate_players', public: true },
  t.array(match_candidate_player.rowType),
  (ctx) => {
    const seat = ctx.db.match_candidate_player.identity.find(ctx.sender);
    if (!seat) return [];
    return [...ctx.db.match_candidate_player.match_id.filter(seat.match_id)];
  }
);

/**
 * The server usage summary for the caller's MOST RECENT match (plan §28). The table itself stays
 * private; this view exposes only the summary of a match the caller actually played — the debug
 * numbers the end screen prints (ticks, inputs, updates, events, estimated egress, storage).
 */
export const my_match_usage = spacetimedb.view(
  { name: 'my_match_usage', public: true },
  t.array(match_server_usage.rowType),
  (ctx) => {
    let latest = 0;
    for (const seat of ctx.db.match_player.identity.filter(ctx.sender)) {
      if (seat.match_id > latest) latest = seat.match_id;
    }
    if (!latest) return [];
    const row = ctx.db.match_server_usage.match_id.find(latest);
    return row ? [row] : [];
  }
);
