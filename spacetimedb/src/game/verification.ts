// NECROFALL — anti-cheat verification (hybrid official matches, 2026-09-29).
//
// In the hybrid architecture gameplay runs PEER-TO-PEER: poses and world state
// never pass through SpacetimeDB, and nothing here gates a frame of it. This
// reducer is the verification layer that sits BESIDE the match:
//
//   • every seat continuously reports its own pose to the server (SYNC POSE —
//     the existing, unchanged anti-cheat feed),
//   • receivers inspect each other's broadcast POSE STREAM for physically
//     impossible motion, and file a `report_violation` with the offending
//     sample when they see it,
//   • the server CORROBORATES the sample against the target's OWN recent pose
//     claim: if the streamed position and the claimed position disagree beyond
//     a generous slack, the seat lied to somebody. Two corroborated sightings
//     (spaced by the report cooldown) remove the offender mid-match.
//
// Corroboration is what keeps legit teleports safe: a recall/respawn jumps in
// the stream AND is reported to the server via `sync_pose` right away, so the
// sample matches the claim and the report is dismissed. Only a stream that
// disagrees with the seat's own server record counts.
//
// Abuse is bounded: one report per (reporter, target) per cooldown, and a
// reporter whose reports keep failing corroboration is ignored for that match.
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { match, match_player, violation_report } from '../schema/match';
import { match_msg } from '../schema/game';
import { MATCH_RUNNING } from '../constants';

/** Only compare the sample against a pose claim this recent (micros). */
const CLAIM_FRESH_US = 5_000_000n;
/** Claim-vs-stream disagreement (world units) beyond which a report is corroborated.
 *  Generous on purpose: max-speed travel between claims is ~25 u, so 30+ cannot be
 *  explained by honest movement — only by a stream that says something else than the
 *  seat's own record. */
const CLAIM_SLACK = 30;
/** Same reporter may file about the same target at most this often (anti-spam). */
const REPORT_COOLDOWN_US = 6_000_000n;
/** After this many uncorroborated reports a reporter loses their vote for the match. */
const MAX_FALSE_REPORTS = 4;
/** Corroborated sightings needed to remove the offender (repeated, not a single blip). */
const KICKS_AT_CORROBORATED = 2;
/** kind length cap. */
const KIND_MAX_CHARS = 16;

/** The target seat's latest self-reported pose claim, if fresh enough to mean anything. */
function freshClaim(ctx: any, matchId: number, identity: any, nowUs: bigint): { x: number; y: number; z: number } | null {
  for (const row of ctx.db.match_input.match_id.filter(matchId)) {
    if (row.identity.toHexString() !== identity.toHexString()) continue;
    if (nowUs - (row.last_pose_at as bigint) > CLAIM_FRESH_US) return null;
    return { x: row.pose_x, y: row.pose_y, z: row.pose_z };
  }
  return null;
}

/**
 * REPORT VIOLATION — one seat (the caller) observed another seat's relayed stream doing
 * something impossible. Fire-and-forget from the client's point of view; the server decides.
 */
export const report_violation = spacetimedb.reducer(
  { match_id: t.u32(), target_hex: t.string(), kind: t.string(), x: t.f64(), y: t.f64(), z: t.f64(), at: t.u64() },
  (ctx, { match_id, target_hex, kind, x, y, z, at }) => {
    if (![x, y, z].every(Number.isFinite)) return;
    if (!kind || kind.length > KIND_MAX_CHARS) return;
    if (!target_hex) return;
    const m = ctx.db.match.match_id.find(match_id);
    if (!m || m.status !== MATCH_RUNNING) return;

    const nowUs = ctx.timestamp.microsSinceUnixEpoch as bigint;

    // The reporter must hold a live seat in this match.
    let me: any | undefined;
    for (const s of ctx.db.match_player.identity.filter(ctx.sender)) {
      if (s.match_id === match_id && !s.left) { me = s; break; }
    }
    if (!me) throw new SenderError('You are not in this match.');

    // The target must hold a live seat in this match.
    let target: any | undefined;
    for (const s of ctx.db.match_player.match_id.filter(match_id)) {
      if (!s.left && s.identity.toHexString() === target_hex) { target = s; break; }
    }
    if (!target) return; // already gone — nothing to verify

    // Abuse budget + cooldown, from this match's small report set.
    let recentSameTarget = false;
    let falseReports = 0;
    let corroboratedSoFar = 0;
    for (const r of ctx.db.violation_report.match_id.filter(match_id)) {
      if (r.reporter.toHexString() === ctx.sender.toHexString()) {
        if (r.target.toHexString() === target_hex && nowUs - (r.at_server.microsSinceUnixEpoch as bigint) < REPORT_COOLDOWN_US) {
          recentSameTarget = true;
        }
        if (!r.corroborated) falseReports++;
      }
      if (r.target.toHexString() === target_hex && r.corroborated) corroboratedSoFar++;
    }
    if (recentSameTarget) return;
    if (falseReports >= MAX_FALSE_REPORTS) return; // this reporter's reports are ignored

    // Corroboration: the streamed sample must CONTRADICT the target's own recent claim.
    const claim = freshClaim(ctx, match_id, target.identity, nowUs);
    const d = claim ? Math.hypot(x - claim.x, y - claim.y, z - claim.z) : 0;
    const corroborated = Boolean(claim) && d > CLAIM_SLACK;

    ctx.db.violation_report.insert({
      id: 0,
      match_id,
      reporter: ctx.sender,
      target: target.identity,
      kind,
      x, y, z,
      at,
      corroborated,
      at_server: ctx.timestamp,
    });

    if (!corroborated) return;
    if (corroboratedSoFar + 1 < KICKS_AT_CORROBORATED) return; // one blip proves nothing — wait for the repeat

    // KICK: streamed state repeatedly disagrees with the seat's own server record.
    ctx.db.match_player.id.update({
      ...target,
      left: true,
      connected: false,
      alive: false,
      hp: 0,
      kick_reason: 'REMOVED — SUSPECTED CHEATING',
      updated_at: ctx.timestamp,
    });
    // Sweep the offender's in-flight relay traffic so nobody applies another frame of it.
    for (const row of [...ctx.db.match_msg.match_id.filter(match_id)]) {
      if (row.from_hex === target_hex) ctx.db.match_msg.id.delete(row.id);
    }
  }
);
