// NECROFALL — the 10 second confirmation window (plan §14/§69/§70/§73).
//
// Every player must explicitly confirm. The SERVER owns the countdown; the
// client only renders the deadline that ships with the candidate view.
import { SenderError } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { candidate_match, match_candidate_player, queue_entry } from '../schema/matchmaking';
import { CANDIDATE_CONFIRMING, QUEUE_CONFIRMED } from '../constants';
import { finalizeCandidate, removeFromQueue } from './queue';

/**
 * CONFIRM — idempotent, one reducer call (plan §39). When the last unconfirmed
 * seat confirms, the match starts immediately; nobody waits out the clock for
 * nothing.
 */
export const confirm_match = spacetimedb.reducer((ctx) => {
  const seat = ctx.db.match_candidate_player.identity.find(ctx.sender);
  if (!seat) throw new SenderError('You are not in a candidate match.');
  const candidate = ctx.db.candidate_match.match_id.find(seat.match_id);
  if (!candidate || candidate.status !== CANDIDATE_CONFIRMING) throw new SenderError('The confirmation window for this match is closed.');
  if (seat.confirmed) return;

  ctx.db.match_candidate_player.id.update({
    ...seat,
    confirmed: true,
    confirmed_at: ctx.timestamp.microsSinceUnixEpoch,
  });
  const q = ctx.db.queue_entry.identity.find(ctx.sender);
  if (q) ctx.db.queue_entry.identity.update({ ...q, status: QUEUE_CONFIRMED });

  const seats = [...ctx.db.match_candidate_player.match_id.filter(seat.match_id)];
  if (seats.length > 0 && seats.every(s => s.confirmed)) {
    finalizeCandidate(ctx, seat.match_id);
  }
});

/**
 * DECLINE / LEAVE (plan §71) — equivalent to a no-show: the player is removed
 * from the candidate AND the queue, and any player left without a viable match
 * gets requeued automatically (plan §14: never cancel everyone because of one).
 */
export const decline_match = spacetimedb.reducer((ctx) => {
  removeFromQueue(ctx, ctx.sender, ctx.timestamp.microsSinceUnixEpoch);
});
