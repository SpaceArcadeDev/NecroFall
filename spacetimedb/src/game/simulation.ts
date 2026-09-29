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
import { match_event, match_msg, match_tick } from '../schema/game';
import { player_presence } from '../schema/player';
import {
  COLONY_CAP,
  EVENT_NEXUS_CAPTURED,
  EVENT_PLAYER_SPAWNED,
  MATCH_EMPTY_GRACE_US,
  MATCH_FINISHED,
  MATCH_MAX_DURATION_US,
  MATCH_MAX_PLAYERS,
  MATCH_RUNNING,
  MAX_MOVE_SPEED,
  MOVE_TOLERANCE,
  PLANET_RADIUS,
  PRESENCE_IN_MATCH,
  PRESENCE_ONLINE,
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
/**
 * How long relayed P2P messages stay in `match_msg` before the tick sweeps them. Long
 * enough for a mid-match joiner's initial subscription to deliver the in-flight burst a
 * client needs to catch up (the next 12 Hz snapshot covers it), short enough that the
 * table is a sliding window rather than storage (plan §46).
 */
const RELAY_RETENTION_US = 6_000_000n;
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

  // Match clock. The tick counter is persisted into the row EVERY tick: the empty-match
  // grace below hangs off it, and the old "write only while someone moves" shortcut froze
  // the counter the moment the field went quiet — an abandoned match then never reached its
  // grace check and stayed RUNNING forever. That is exactly how match #12 got stuck: seat
  // disconnected, server_tick frozen at 62, and every later "Find Match" wrongly said
  // "You are already in a match" (bug report 2026-09-28). One row update per 100 ms is
  // nothing next to the players' own writes.
  const startedMicros = m.started_at ? (m.started_at.microsSinceUnixEpoch as bigint) : nowUs;
  const elapsedUs = nowUs - startedMicros;
  const durationSeconds = Number(elapsedUs / 1_000_000n);
  const serverTick = m.server_tick + 1n;
  ctx.db.match.match_id.update({
    ...m,
    server_tick: serverTick,
    duration_seconds: durationSeconds,
  });
  m.server_tick = serverTick;

  noteTickUsage(ctx, m.match_id, moved, Number(highestTickInput > 0n ? 1 : 0));

  // ---- relay sweep (2026-09-29): `match_msg` is in-flight traffic, not storage. Six
  // seconds is several times the longest realistic delivery window; anything older has
  // either been applied everywhere or belongs to a receiver that is gone.
  const relayCutoffUs = nowUs - RELAY_RETENTION_US;
  for (const row of [...ctx.db.match_msg.match_id.filter(m.match_id)]) {
    if ((row.at.microsSinceUnixEpoch as bigint) < relayCutoffUs) ctx.db.match_msg.id.delete(row.id);
  }

  // ---- end conditions (safety nets until objectives own the finish line)
  if (elapsedUs >= MATCH_MAX_DURATION_US) {
    finishMatchInternal(ctx, m.match_id, null, 'TIME LIMIT');
    return;
  }

  // ---- rejoin grace. Evaluated EVERY tick (one filter over ≤ 9 players): under the old
  // %10 cadence a single missed heartbeat postponed it, and on a frozen clock it could be
  // postponed forever — the exact bug above.
  const connected = players.filter(p => p.connected && !p.left).length;
  if (connected === 0) {
    // NOBODY is reporting: hold the match for the rejoin grace so a dropped client can come
    // back (join_match revives its seat) and continue where it left off. Only a full window
    // with zero returners concludes it — the necrophages take the abandoned planet.
    const since = m.empty_since ? (m.empty_since.microsSinceUnixEpoch as bigint) : 0n;
    if (since === 0n) {
      ctx.db.match.match_id.update({ ...m, empty_since: now });
    } else if (nowUs - since >= MATCH_EMPTY_GRACE_US) {
      finishMatchInternal(ctx, m.match_id, null, 'ABANDONED — THE NECROPHAGES WIN');
      return;
    }
  } else if (m.empty_since) {
    // Somebody came back inside the window: the match simply continues.
    ctx.db.match.match_id.update({ ...m, empty_since: undefined });
  }
}

/**
 * JOIN / REJOIN a running official match by id (user ask 2026-09-28): the id travels in the URL, so
 * anyone holding it can drop in midway — and a seat that only DISCONNECTED (never left) revives
 * exactly where it was, colony, stats and loadout intact. A seat abandoned with LEAVE MATCH is a
 * tombstone and stays one.
 */
export const join_match = spacetimedb.reducer(
  { match_id: t.u32(), colony: t.u8(), necrotech: t.u32() },
  (ctx, { match_id, colony, necrotech }) => {
    const m = ctx.db.match.match_id.find(match_id);
    if (!m) throw new SenderError('No match with that id.');
    if (m.status !== MATCH_RUNNING) throw new SenderError('That match is no longer running.');
    const now = ctx.timestamp;

    // Rejoin: a seat of mine that never left takes the call and keeps everything it had.
    for (const s of ctx.db.match_player.identity.filter(ctx.sender)) {
      if (s.match_id !== match_id) continue;
      if (s.left) throw new SenderError('You left this match — queue again to play.');
      if (!s.connected) ctx.db.match_player.id.update({ ...s, connected: true, updated_at: now });
      const presence = ctx.db.player_presence.identity.find(ctx.sender);
      if (presence) ctx.db.player_presence.identity.update({ ...presence, status: PRESENCE_IN_MATCH, last_seen: now });
      return;
    }

    // Fresh mid-join seat.
    if (colony > 2) throw new SenderError('Pick a colony to join.');
    const seats = [...ctx.db.match_player.match_id.filter(match_id)].filter((p: any) => !p.left);
    if (seats.length >= MATCH_MAX_PLAYERS) throw new SenderError('The match is full.');
    if (seats.filter((p: any) => p.colony === colony).length >= COLONY_CAP) throw new SenderError('That colony is full.');
    const account = ctx.db.player.identity.find(ctx.sender);
    ctx.db.match_player.insert({
      id: 0,
      match_id,
      identity: ctx.sender,
      name: account?.player_name ?? 'Survivor',
      colony,
      kills: 0,
      deaths: 0,
      damage: 0,
      objectives: 0,
      necrotech,
      confirmed: true,
      connected: true,
      x: 0,
      y: PLANET_RADIUS,
      z: 0,
      fx: 0,
      fy: 1,
      fz: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      hp: 100,
      max_hp: 100,
      alive: true,
      has_pose: false,
      stats_reported_at: 0n,
      updated_at: now,
      left: false,
    });
    ctx.db.match.match_id.update({ ...m, player_count: m.player_count + 1 });
    const presence = ctx.db.player_presence.identity.find(ctx.sender);
    if (presence) ctx.db.player_presence.identity.update({ ...presence, status: PRESENCE_IN_MATCH, last_seen: now });
  }
);

/**
 * LEAVE MATCH (plan §27/§71) — abandon my live seat. The row stays as a tombstone: the sim
 * skips it (exactly like a disconnect), it stops counting for "you are already in a match",
 * and `finishMatchInternal` earns it no rewards or history. The match itself is NOT concluded
 * here: the tick's rejoin grace decides (30 s with zero connected players = necrophages win),
 * so a friend who only dropped can still come back.
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
  // OUT OF THE GAME = ONLINE right away (user report 2026-09-29: the friends rail kept showing
  // "In match" for up to the 30 s abandonment grace, because presence only flipped when the
  // match row finally finished. Leaving IS the exit — flip it here.)
  const presence = ctx.db.player_presence.identity.find(ctx.sender);
  if (presence) ctx.db.player_presence.identity.update({ ...presence, status: PRESENCE_ONLINE, last_seen: ctx.timestamp });
});

/**
 * REPORT NEXUS CAPTURE (user ask 2026-09-28): the Nexus is the win condition — the match ends the
 * moment a colony takes it, full stop. Towers/objectives are not server-simulated yet (milestone),
 * so the client whose simulation completed the capture reports it here. The reducer is idempotent
 * by construction: `finishMatchInternal` only acts on a RUNNING match, so the first report wins.
 *
 * Why this exists at all: without it the server match stayed RUNNING after a local victory and the
 * client's matchmaking watcher kept pulling the player back into a game that was already over (the
 * "brought back into the match / back to the end screen" reports) — and the results screen never
 * received the finalized usage summary, because `detectMatchEnd` only fires on a FINISHED row.
 */
export const report_nexus_capture = spacetimedb.reducer(
  { colony: t.u8() },
  (ctx, { colony }) => {
    if (colony > 2) throw new SenderError('Invalid colony.');
    let target: any | undefined;
    for (const s of ctx.db.match_player.identity.filter(ctx.sender)) {
      if (s.left) continue; // tombstone seats never declare a winner
      const m = ctx.db.match.match_id.find(s.match_id);
      if (m && m.status === MATCH_RUNNING) { target = s; break; }
    }
    if (!target) throw new SenderError('You are not in a running match.');
    ctx.db.match_event.insert({
      id: 0,
      match_id: target.match_id,
      kind: EVENT_NEXUS_CAPTURED,
      a: colony,
      b: 0,
      x: 0, y: 0, z: 0,
      at: ctx.timestamp,
    });
    finishMatchInternal(ctx, target.match_id, colony, 'NEXUS CAPTURED');
  }
);

/**
 * REPORT NECROPHAGE VICTORY (bug report 2026-09-29). The client's own clock ran out — or its
 * simulation otherwise concluded — with NO colony claiming the Nexus: the Necrophages keep the
 * planet. Without this report the server row stayed RUNNING long after every screen said
 * NECROPHAGES WIN: "Find Match" answered "You are already in a match", a reload dragged the
 * player back into a finished game, and the row only concluded once every socket had been gone
 * for the whole 30 s rejoin grace.
 *
 * Idempotent by construction: `finishMatchInternal` only acts on a RUNNING match, so the first
 * report from any seat ends it for everyone. Winner null = every seat is paid the loss reward
 * and ranked records a draw — exactly what the server's own TIME LIMIT / ABANDONED paths do.
 */
export const report_necrophage_victory = spacetimedb.reducer((ctx) => {
  let target: any | undefined;
  for (const s of ctx.db.match_player.identity.filter(ctx.sender)) {
    if (s.left) continue; // tombstone seats never declare a result
    const m = ctx.db.match.match_id.find(s.match_id);
    if (m && m.status === MATCH_RUNNING) { target = s; break; }
  }
  if (!target) throw new SenderError('You are not in a running match.');
  // `finishMatchInternal` writes the MATCH ENDED event itself (winner 255 = nobody).
  finishMatchInternal(ctx, target.match_id, null, 'NECROPHAGES WIN');
});
