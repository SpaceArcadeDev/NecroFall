// NECROFALL — the authoritative server simulation (plan §16–§19/§40/§74).
//
// One scheduled reducer per RUNNING match at 10 Hz:
//   • reads the latest input state (never one reducer per frame per player),
//   • integrates/validates player movement,
//   • writes ONLY changed pose rows so subscriptions stay cheap,
//   • bumps the match clock and enforces the safety-net end conditions.
//
// MILESTONE SCOPE: players move under server validation; enemies, bosses,
// towers and objectives are the next Phase 8 stages and their tables
// (match_entity / match_objective / match_event) are already here so the sim
// can grow without a schema migration. Combat stats arrive through
// `report_match_stats` with sanity bounds until the server owns damage.
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { match_input, match_player, match } from '../schema/match';
import { match_event, match_tick } from '../schema/game';
import { player_presence } from '../schema/player';
import {
  EVENT_PLAYER_SPAWNED,
  MATCH_FINISHED,
  MATCH_MAX_DURATION_US,
  MATCH_RUNNING,
  MAX_MOVE_SPEED,
  MOVE_TOLERANCE,
  PLANET_RADIUS,
  PRESENCE_IN_MATCH,
  TICK_INTERVAL_US,
} from '../constants';
import { finishMatchInternal, noteTickUsage } from './rewards';

const DT_SECONDS = Number(TICK_INTERVAL_US) / 1_000_000;
/** Inputs are accepted at most this often per player (plan §39 rate discipline). */
const INPUT_MIN_GAP_US = 40_000n;
/** Pose corrections are accepted at most this often per player. */
const POSE_MIN_GAP_US = 400_000n;
/** An input older than this means the player stopped reporting (or dropped). */
const INPUT_STALE_US = 1_000_000n;
/** A pose claim older than this stops participating in validation. */
const POSE_FRESH_US = 5_000_000n;
/** The plausible world band (surface terrain → colony decks ~72 above it). */
const WORLD_LO_RADIUS = PLANET_RADIUS - 60;
const WORLD_HI_RADIUS = PLANET_RADIUS + 120;

function nowMicros(ctx: any): bigint {
  return ctx.timestamp.microsSinceUnixEpoch as bigint;
}

function clampVec(x: number, y: number, z: number, max: number): [number, number, number] {
  const len = Math.hypot(x, y, z);
  if (!Number.isFinite(len) || len <= 0) return [0, 0, 0];
  if (len <= max) return [x, y, z];
  const k = max / len;
  return [x * k, y * k, z * k];
}

function seekInput(ctx: any, matchId: number, identity: any): any | undefined {
  for (const row of ctx.db.match_input.identity.filter(identity)) {
    if (row.match_id === matchId) return row;
  }
  return undefined;
}

/**
 * SET INPUT — the plan §18/§77 optimisation at the API level: the client sends
 * here only when the movement direction, aim or dash state CHANGES (plus a low
 * frequency heartbeat). The server keeps the latest state and the 10 Hz tick
 * extrapolates from it, so a player holding one direction costs ~1 reducer/s.
 */
export const submit_input = spacetimedb.reducer(
  {
    move_x: t.f64(), move_y: t.f64(), move_z: t.f64(),
    aim_x: t.f64(), aim_y: t.f64(), aim_z: t.f64(),
    seq: t.u64(),
    dash: t.bool(),
  },
  (ctx, { move_x, move_y, move_z, aim_x, aim_y, aim_z, seq, dash }) => {
    let target: any | undefined;
    for (const s of ctx.db.match_player.identity.filter(ctx.sender)) {
      const m = ctx.db.match.match_id.find(s.match_id);
      if (m && m.status === MATCH_RUNNING) { target = s; break; }
    }
    if (!target) throw new SenderError('You are not in a running match.');
    if (target.left) return; // abandoned seat — input never revives it

    const now = nowMicros(ctx);
    let row = seekInput(ctx, target.match_id, ctx.sender);
    if (!row) {
      row = ctx.db.match_input.insert({
        id: 0,
        match_id: target.match_id,
        identity: ctx.sender,
        move_x: 0, move_y: 0, move_z: 0,
        aim_x: 0, aim_y: 0, aim_z: 1,
        seq: 0n,
        dash_seq: 0n,
        pose_x: target.x, pose_y: target.y, pose_z: target.z,
        pose_fx: target.fx, pose_fy: target.fy, pose_fz: target.fz,
        last_input_at: now,
        last_pose_at: now,
      });
    }
    if (seq <= row.seq) return;                 // stale packet (plan §52 sequencing)
    if (now - row.last_input_at < INPUT_MIN_GAP_US) return; // reducer spam guard

    const [mx, my, mz] = clampVec(move_x, move_y, move_z, MAX_MOVE_SPEED);
    const [ax, ay, az] = clampVec(aim_x, aim_y, aim_z, 1);
    ctx.db.match_input.id.update({
      ...row,
      move_x: mx, move_y: my, move_z: mz,
      aim_x: ax, aim_y: ay, aim_z: az,
      seq,
      dash_seq: row.dash_seq + (dash ? 1n : 0n),
      last_input_at: now,
    });

    if (!target.connected) {
      ctx.db.match_player.id.update({ ...target, connected: true, updated_at: ctx.timestamp });
    }
  }
);

/**
 * SYNC POSE — the client's prediction anchor (plan §19). Sent rarely: after
 * spawn, on teleports/dashes and every couple of seconds as a correction. The
 * tick validates the claim against what the simulation says was reachable and
 * clamps cheaters back (plan §74).
 */
export const sync_pose = spacetimedb.reducer(
  { x: t.f64(), y: t.f64(), z: t.f64(), fx: t.f64(), fy: t.f64(), fz: t.f64() },
  (ctx, { x, y, z, fx, fy, fz }) => {
    if (![x, y, z, fx, fy, fz].every(Number.isFinite)) throw new SenderError('Invalid pose.');
    const radius = Math.hypot(x, y, z);
    if (radius < WORLD_LO_RADIUS || radius > WORLD_HI_RADIUS) return; // obviously off-world

    let target: any | undefined;
    for (const s of ctx.db.match_player.identity.filter(ctx.sender)) {
      const m = ctx.db.match.match_id.find(s.match_id);
      if (m && m.status === MATCH_RUNNING) { target = s; break; }
    }
    if (!target) throw new SenderError('You are not in a running match.');
    if (target.left) return; // abandoned seat — ignore late pose claims

    const now = nowMicros(ctx);
    let row = seekInput(ctx, target.match_id, ctx.sender);
    if (!row) {
      row = ctx.db.match_input.insert({
        id: 0,
        match_id: target.match_id,
        identity: ctx.sender,
        move_x: 0, move_y: 0, move_z: 0,
        aim_x: fx, aim_y: fy, aim_z: fz,
        seq: 0n,
        dash_seq: 0n,
        pose_x: x, pose_y: y, pose_z: z,
        pose_fx: fx, pose_fy: fy, pose_fz: fz,
        last_input_at: now,
        last_pose_at: now,
      });
      return;
    }
    if (now - row.last_pose_at < POSE_MIN_GAP_US) return;

    const [nax, nay, naz] = clampVec(fx, fy, fz, 1);
    ctx.db.match_input.id.update({
      ...row,
      pose_x: x, pose_y: y, pose_z: z,
      pose_fx: nax, pose_fy: nay, pose_fz: naz,
      last_pose_at: now,
    });
  }
);

/**
 * The 10 Hz authoritative tick — bound to the per-match schedule row (plan §40).
 * Deleting the row stops the match's simulation: that is how matches end here.
 */
export const match_sim_tick = spacetimedb.reducer(
  { onSchedule: match_tick },
  { arg: match_tick.rowType },
  (ctx, { arg }) => {
    const m = ctx.db.match.match_id.find(arg.match_id);
    if (!m || m.status !== MATCH_RUNNING) {
      ctx.db.match_tick.scheduled_id.delete(arg.scheduled_id);
      return;
    }
    simulateMatch(ctx, m);
  }
);

function simulateMatch(ctx: any, m: any): void {
  const now = ctx.timestamp;
  const nowUs = nowMicros(ctx);
  const players = [...ctx.db.match_player.match_id.filter(m.match_id)];
  // ONE indexed pass over the match's inputs (instead of a per-player btree lookup
  // plus linear scan): the tick is the hottest reducer in the database (plan §40).
  const inputs = new Map<string, any>();
  for (const row of ctx.db.match_input.match_id.filter(m.match_id)) {
    inputs.set(row.identity.toHexString(), row);
  }
  let moved = 0;
  let highestTickInput = 0n;

  for (const p of players) {
    if (p.left) continue; // tombstone seat — leave_match never revives it, so never simulate it
    const input = inputs.get(p.identity.toHexString());
    if (!input) continue;

    const stale = nowUs - input.last_input_at > INPUT_STALE_US;
    const freshPose = nowUs - input.last_pose_at <= POSE_FRESH_US;

    let x = p.x, y = p.y, z = p.z;
    let vx = p.vx, vy = p.vy, vz = p.vz;

    if (freshPose) {
      // ---- prediction correction, with anti-cheat clamp (plan §19/§74)
      const claimedDx = input.pose_x - x;
      const claimedDy = input.pose_y - y;
      const claimedDz = input.pose_z - z;
      const claimed = Math.hypot(claimedDx, claimedDy, claimedDz);
      const elapsed = Math.max(0.05, Number(nowUs - input.last_pose_at) / 1e6);
      const reachable = MAX_MOVE_SPEED * elapsed * MOVE_TOLERANCE;
      if (claimed > reachable && claimed > 0.001) {
        const k = reachable / claimed;
        x += claimedDx * k;
        y += claimedDy * k;
        z += claimedDz * k;
      } else {
        x = input.pose_x;
        y = input.pose_y;
        z = input.pose_z;
      }
      // Estimate velocity from the accepted jump for interpolation smoothing.
      const ix = claimed > 0.001 ? claimedDx / claimed : 0;
      const iy = claimed > 0.001 ? claimedDy / claimed : 0;
      const iz = claimed > 0.001 ? claimedDz / claimed : 0;
      const impliedSpeed = Math.min(claimed / elapsed, MAX_MOVE_SPEED);
      vx = ix * impliedSpeed;
      vy = iy * impliedSpeed;
      vz = iz * impliedSpeed;
    } else if (!stale) {
      // ---- extrapolate from the stored input between pose corrections
      x += input.move_x * DT_SECONDS;
      y += input.move_y * DT_SECONDS;
      z += input.move_z * DT_SECONDS;
      vx = input.move_x;
      vy = input.move_y;
      vz = input.move_z;
    } else if (Math.hypot(vx, vy, vz) > 0.01) {
      // Input went quiet: keep a short coast, then stop (no wall-hugging).
      vx *= 0.6; vy *= 0.6; vz *= 0.6;
      x += vx * DT_SECONDS;
      y += vy * DT_SECONDS;
      z += vz * DT_SECONDS;
    } else {
      continue; // idle and silent: no row write at all (plan §40/§65)
    }

    // Keep the runner on the planet — but ONLY when they leave the plausible surface
    // band. The world is surface+altitude: terrain sits near PLANET_RADIUS and colony
    // decks tower ~72 units above it, so re-scaling everything onto the base sphere
    // would drag deck-standing players down through their own platform.
    const radius = Math.hypot(x, y, z) || PLANET_RADIUS;
    if (radius < WORLD_LO_RADIUS || radius > WORLD_HI_RADIUS) {
      const k = (radius < WORLD_LO_RADIUS ? WORLD_LO_RADIUS : WORLD_HI_RADIUS) / radius;
      x *= k; y *= k; z *= k;
    }

    const dx = x - p.x, dy = y - p.y, dz = z - p.z;
    const movedDistSq = dx * dx + dy * dy + dz * dz;
    const changed = movedDistSq > 0.0001
      || Math.abs(vx - p.vx) > 0.05 || Math.abs(vy - p.vy) > 0.05 || Math.abs(vz - p.vz) > 0.05
      || !p.has_pose;
    if (!changed) continue;

    ctx.db.match_player.id.update({
      ...p,
      x, y, z,
      vx, vy, vz,
      has_pose: true,
      updated_at: now,
    });
    if (!p.has_pose) {
      ctx.db.match_event.insert({
        id: 0, match_id: m.match_id, kind: EVENT_PLAYER_SPAWNED,
        a: p.id, b: 0, x, y, z, at: now,
      });
    }
    moved++;
    if (input.seq > highestTickInput) highestTickInput = input.seq;
  }

  // Match clock + periodic (not per-tick) row write when nothing moved.
  const startedMicros = m.started_at ? (m.started_at.microsSinceUnixEpoch as bigint) : nowUs;
  const elapsedUs = nowUs - startedMicros;
  const durationSeconds = Number(elapsedUs / 1_000_000n);
  const serverTick = m.server_tick + 1n;
  const heartbeat = moved > 0 || serverTick % 10n === 0n;
  if (heartbeat) {
    ctx.db.match.match_id.update({
      ...m,
      server_tick: serverTick,
      duration_seconds: durationSeconds,
    });
  } else {
    // Still advance the in-memory copy for the checks below.
    m.server_tick = serverTick;
  }

  noteTickUsage(ctx, m.match_id, moved, Number(highestTickInput > 0n ? 1 : 0));

  // ---- end conditions (safety nets until objectives own the finish line)
  if (elapsedUs >= MATCH_MAX_DURATION_US) {
    finishMatchInternal(ctx, m.match_id, null, 'TIME LIMIT');
    return;
  }
  if (serverTick % 10n === 0n) {
    const connected = players.filter(p => p.connected && !p.left).length;
    if (connected === 0) finishMatchInternal(ctx, m.match_id, null, 'ALL LEFT');
  }
}

void player_presence;

/**
 * LEAVE MATCH (plan §27/§71) — abandon my live seat. The row stays as a tombstone: the sim
 * skips it (exactly like a disconnect), it stops counting for "you are already in a match",
 * and `finishMatchInternal` earns it no rewards or history. If it was the last live seat the
 * match is over for everyone.
 */
export const leave_match = spacetimedb.reducer((ctx) => {
  let seat: any | undefined;
  for (const s of ctx.db.match_player.identity.filter(ctx.sender)) {
    if (s.left) continue;
    const m = ctx.db.match.match_id.find(s.match_id);
    if (m && m.status !== MATCH_FINISHED) {
      seat = s;
      break;
    }
  }
  if (!seat) return; // nothing to leave — idempotent
  ctx.db.match_player.id.update({ ...seat, left: true, connected: false, updated_at: ctx.timestamp });
  const remaining = [...ctx.db.match_player.match_id.filter(seat.match_id)].filter((p: any) => p.connected && !p.left).length;
  if (remaining === 0) finishMatchInternal(ctx, seat.match_id, null, 'ALL LEFT');
});
