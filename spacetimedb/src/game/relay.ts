// NECROFALL — the official match RELAY (2026-09-29).
//
// The official match runs the SAME authority protocol as a P2P room; only the wire changes.
// The lowest connected non-left match_player id is the AUTHORITY (deterministic for every
// client): it simulates the world and broadcasts the same `s` snapshots / one-shot events the
// P2P host broadcasts, while every other seat behaves like a P2P client — full pose+stats
// reports into the authority, single-ask messages for hits, pickups and ability casts. Both
// sides funnel through `send_match_msg`, receivers feed rows into the same `onNetMessage`
// handlers, and the match tick sweeps delivered rows after a few seconds.
//
// This reducer is a RELAY, not a game server: it validates identity (a live seat in a
// running match), shape (kind/size caps) and budget (per-sender rate limit), then stores the
// row. Gameplay validation stays with the match authority — exactly like P2P.
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { match_msg, match_msg_rate } from '../schema/game';
import { match, match_player } from '../schema/match';
import { MATCH_RUNNING } from '../constants';

/** Hard cap of one relayed payload (the biggest is the 12 Hz world snapshot). */
const MSG_MAX_CHARS = 64 * 1024;
/** Message kind max length (alphanumeric / dash / underscore). */
const KIND_MAX_CHARS = 24;
/** Target hex length cap (identities are 64 hex chars). */
const TARGET_MAX_CHARS = 80;
/** Fixed-window budget: at most this many relayed messages per second per sender. Normal
 *  play peaks around 20/s (a 15 Hz pose stream) or ~30/s on the authority — the headroom
 *  covers bursts (a snapshot + several relays in one tick) without letting a runaway client
 *  flood the match. Over-budget messages are DROPPED silently: the streams are continuous,
 *  so the next one recovers. */
const MSG_WINDOW_US = 1_000_000n;
const MSG_MAX_PER_WINDOW = 90;

/**
 * SEND MATCH MESSAGE — one P2P wire frame carried by SpacetimeDB.
 *
 * `to_hex` '' = broadcast to every seat (the authority's snapshots/events); anything else is
 * a direct message to one seat (client → authority asks, authority → client offers/kills).
 * The sender's seat is also marked connected: relay traffic IS the liveness heartbeat, and
 * an idle player still sends a 1 Hz pose heartbeat.
 */
export const send_match_msg = spacetimedb.reducer(
  { match_id: t.u32(), to_hex: t.string(), kind: t.string(), seq: t.u64(), payload: t.string() },
  (ctx, { match_id, to_hex, kind, seq, payload }) => {
    // ---- the sender must hold a live seat in a RUNNING match
    let seat: any | undefined;
    for (const s of ctx.db.match_player.identity.filter(ctx.sender)) {
      if (s.match_id === match_id && !s.left) {
        seat = s;
        break;
      }
    }
    if (!seat) throw new SenderError('You are not in this match.');
    const m = ctx.db.match.match_id.find(match_id);
    if (!m || m.status !== MATCH_RUNNING) return; // finish landed mid-flight — late traffic is dropped

    // ---- shape caps
    if (!kind || kind.length > KIND_MAX_CHARS || !/^[a-z0-9_-]+$/i.test(kind)) {
      throw new SenderError('Invalid message kind.');
    }
    if (payload.length > MSG_MAX_CHARS) throw new SenderError('Message too large.');
    if (to_hex.length > TARGET_MAX_CHARS) throw new SenderError('Invalid target.');

    // ---- per-sender fixed-window rate limit
    const nowUs = ctx.timestamp.microsSinceUnixEpoch as bigint;
    let rate = ctx.db.match_msg_rate.identity.find(ctx.sender);
    if (!rate) {
      rate = ctx.db.match_msg_rate.insert({ identity: ctx.sender, window_start: nowUs, count: 0 });
    } else if (nowUs - rate.window_start >= MSG_WINDOW_US) {
      rate = ctx.db.match_msg_rate.identity.update({ ...rate, window_start: nowUs, count: 0 });
    }
    if (rate.count >= MSG_MAX_PER_WINDOW) return; // over budget — recovered by the continuous stream
    ctx.db.match_msg_rate.identity.update({ ...rate, count: rate.count + 1 });

    // ---- relay it. `to_hex` is trusted as an identity string: receivers only ever apply
    //      broadcasts or messages addressed to their own identity, and the dispatch is the
    //      same code the P2P transport feeds — a stray target simply never matches anyone.
    const senderHex = ctx.sender.toHexString();
    ctx.db.match_msg.insert({
      id: 0n,
      match_id,
      from_hex: senderHex,
      to_hex,
      kind,
      seq,
      payload,
      at: ctx.timestamp,
    });

    // ---- liveness: any relay traffic counts as "connected" (idle players send pose
    //      heartbeats, so an AFK seat never looks dropped and the empty-match grace and the
    //      authority election stay accurate).
    if (!seat.connected) {
      ctx.db.match_player.id.update({ ...seat, connected: true, updated_at: ctx.timestamp });
    }
  }
);
