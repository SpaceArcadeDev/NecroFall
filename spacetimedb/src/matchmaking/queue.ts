// NECROFALL — official matchmaking (plan §12/§13/§15/§69/§73).
//
// THE QUEUE: players press Find Match, the server validates, and once two
// players are in the queue a 5 second fill window opens. The window then hands
// over to a 10 second confirmation (see confirmation.ts). Colony caps (3 per
// colony, 9 total) are enforced while filling; parties are admitted atomically.
//
// Everything here is SERVER time (`ctx.timestamp`): the client only mirrors it.
import { SenderError, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import { spacetimedb } from '../schema';
import {
  candidate_match,
  match_candidate_player,
  matchmaking_scan,
  party_member,
  queue_entry,
} from '../schema/matchmaking';
import { match, match_player } from '../schema/match';
import { match_event, match_tick } from '../schema/game';
import { server_clock } from '../schema/clock';
import { player, player_presence } from '../schema/player';
import {
  CANDIDATE_CONFIRMING,
  CANDIDATE_FILLING,
  COLONY_CAP,
  CONFIRM_WINDOW_US,
  EVENT_MATCH_STARTED,
  FILL_WINDOW_US,
  MATCH_MAX_PLAYERS,
  MATCH_MIN_PLAYERS,
  MATCH_RUNNING,
  PRESENCE_IN_MATCH,
  QUEUE_CANDIDATE,
  QUEUE_CONFIRMED,
  QUEUE_QUEUED,
  TICK_INTERVAL_US,
} from '../constants';
import { requireOnboarded, requirePlayer } from '../auth/authorization';
import { cleanupFinishedMatches } from '../game/rewards';
import { maybeReleasePlanet, refreshPlanetReservation } from '../ranked/planets';
import { parsePlanetKey, planetSeed } from '../ranked/seed';
import { ensureActiveSeason, universeSeed32 } from '../ranked/planets';
import { sweepRanked } from '../ranked/planets';
import { sweepPartyInvites } from './party';

/** One scan per second ages every window; the real granularity lives in constants. */
const SCAN_INTERVAL_US = 1_000_000n;

function nowMicros(ctx: any): bigint {
  return ctx.timestamp.microsSinceUnixEpoch as bigint;
}

/** The caller's live match seat, if any — a player may only be in one match (plan §73.9). */
function activeMatchFor(ctx: any, identity: any): any | undefined {
  for (const mp of ctx.db.match_player.identity.filter(identity)) {
    if (mp.left) continue; // an abandoned seat never counts as "in a match"
    const m = ctx.db.match.match_id.find(mp.match_id);
    if (m && m.status !== 2) return m;
  }
  return undefined;
}

/**
 * FIND MATCH — validation (plan §41/§63):
 *   account exists and is onboarded, not already queued, not already in a match.
 * A party is queued by its LEADER and enters as one atomic group (plan §72).
 */
export const find_match = spacetimedb.reducer((ctx) => {
  const me = requireOnboarded(ctx);
  // Self-heal: a module update can leave the schedule table empty, and without
  // the scanner candidates never age — the queue would silently stall.
  armMatchmakingScan(ctx);
  if (ctx.db.queue_entry.identity.find(ctx.sender)) return; // already searching — idempotent
  if (activeMatchFor(ctx, ctx.sender)) throw new SenderError('You are already in a match.');

  const membership = ctx.db.party_member.identity.find(ctx.sender);
  let group: any[] = [me];
  if (membership) {
    const partyRow = ctx.db.party.party_id.find(membership.party_id);
    if (!partyRow || partyRow.leader.toHexString() !== ctx.sender.toHexString()) {
      throw new SenderError('Only the party leader can search for a match.');
    }
    group = [...ctx.db.party_member.party_id.filter(membership.party_id)].map(m => ctx.db.player.identity.find(m.identity));
  }

  const now = nowMicros(ctx);
  for (const p of group) {
    if (!p) continue;
    if (p.colony === 255 || !p.player_name) throw new SenderError('Every party member must finish onboarding first.');
    if (ctx.db.queue_entry.identity.find(p.identity)) continue;
    if (activeMatchFor(ctx, p.identity)) throw new SenderError('A party member is already in a match.');
    ctx.db.queue_entry.insert({
      identity: p.identity,
      party_id: membership ? membership.party_id : undefined,
      colony: p.colony,
      skill_rating: p.skill_rating,
      queued_at: now,
      status: QUEUE_QUEUED,
      candidate_match_id: undefined,
      ranked: false,
      planet_key: '',
    });
  }

  // Snappy path: react to this enqueue now instead of waiting for the next scan.
  fillOpenCandidates(ctx, now);
  maybeCreateCandidate(ctx, now);
});

/** CANCEL — the player leaves the queue (allowed before and during confirmation, plan §71). */
export const cancel_find_match = spacetimedb.reducer((ctx) => {
  removeFromQueue(ctx, ctx.sender, nowMicros(ctx));
});

/**
 * The 1 Hz scanner. One global schedule row (plan §40) ages the fill windows,
 * expires confirmations, keeps colony balance while filling, and starts or
 * cancels candidates. All timing decisions are made HERE — never on a client.
 */
export const matchmaking_scan_tick = spacetimedb.reducer(
  { onSchedule: matchmaking_scan },
  { arg: matchmaking_scan.rowType },
  (ctx) => {
    const now = nowMicros(ctx);

    // SERVER CLOCK (plan §14/§46): one tiny public row, stamped every scan, so
    // the map can render planetary-shield countdowns on SERVER time instead of
    // trusting the device clock.
    const clock = [...ctx.db.server_clock.iter()][0];
    if (clock) ctx.db.server_clock.id.update({ ...clock, now_us: now });
    else ctx.db.server_clock.insert({ id: 0, now_us: now });

    // 1) Age open candidates.
    for (const candidate of [...ctx.db.candidate_match.iter()]) {
      if (candidate.status === CANDIDATE_FILLING) {
        fillCandidate(ctx, candidate, now);
        if (now >= candidate.deadline) {
          const seats = [...ctx.db.match_candidate_player.match_id.filter(candidate.match_id)];
          if (seats.length >= MATCH_MIN_PLAYERS) {
            ctx.db.candidate_match.match_id.update({
              ...candidate,
              status: CANDIDATE_CONFIRMING,
              deadline: now + CONFIRM_WINDOW_US,
            });
          } else {
            releaseCandidate(ctx, candidate.match_id, false);
          }
        }
      } else if (candidate.status === CANDIDATE_CONFIRMING) {
        const seats = [...ctx.db.match_candidate_player.match_id.filter(candidate.match_id)];
        const everyoneConfirmed = seats.length > 0 && seats.every(s => s.confirmed);
        if (everyoneConfirmed || now >= candidate.deadline) {
          finalizeCandidate(ctx, candidate.match_id);
        }
      }
    }

    // 2) Form a candidate once the minimum number of players is waiting.
    maybeCreateCandidate(ctx, now);

    // 3) Light housekeeping: purge live state of matches that ended a while ago
    //    (plan §46 retention policy) — permanent results stay, temp rows do not.
    //    The sweep walks EVERY match row ever played; doing it at 1 Hz was this
    //    scanner's single biggest cost. Once a minute is plenty for a 10 min retention
    //    (ticks are 1 s apart, so this window catches exactly one tick per minute).
    if (now % 60_000_000n < 1_000_000n) cleanupFinishedMatches(ctx, now);

    // 4) Ranked-world housekeeping: expired reservations die and shields that
    //    fell return their planets to the Necrophages (plan §38/§52).
    sweepRanked(ctx, now);

    // 5) Lobby invites nobody answered expire (friends-rail INVITE, user ask 2026-09-29).
    sweepPartyInvites(ctx, now);
  }
);

/** Internal: create the queue's first candidate and open its fill window. */
export function maybeCreateCandidate(ctx: any, now: bigint): void {
  for (const _ of ctx.db.candidate_match.iter()) return; // a candidate is already open — one at a time
  const waiting = [...ctx.db.queue_entry.iter()].filter(q => q.status === QUEUE_QUEUED);
  if (waiting.length < MATCH_MIN_PLAYERS) return;

  // The candidate inherits its MODE from the longest-waiting entry (plan §5):
  // ranked candidates only ever fill with ranked entries for the same planet.
  waiting.sort((a, b) => (a.queued_at < b.queued_at ? -1 : a.queued_at > b.queued_at ? 1 : 0));
  const seed = waiting[0];
  const candidate = ctx.db.candidate_match.insert({
    match_id: 0,
    created_at: now,
    deadline: now + FILL_WINDOW_US,
    status: CANDIDATE_FILLING,
    ranked: Boolean(seed.ranked),
    planet_key: seed.ranked ? seed.planet_key ?? '' : '',
  });
  fillCandidate(ctx, candidate, now);
}

/** Internal: pull eligible groups from the queue into a FILLING candidate. */
export function fillOpenCandidates(ctx: any, now: bigint): void {
  for (const candidate of [...ctx.db.candidate_match.iter()]) {
    if (candidate.status === CANDIDATE_FILLING) fillCandidate(ctx, candidate, now);
  }
}

/**
 * Fill one candidate under the caps (plan §13):
 *   1. parties stay whole, 2. max 3 per colony, 3. max 9 total,
 *   4. prefer the rarest colony and the longest wait.
 */
function fillCandidate(ctx: any, candidate: any, _now: bigint): void {
  const seats = [...ctx.db.match_candidate_player.match_id.filter(candidate.match_id)];
  const counts = [0, 0, 0];
  let total = 0;
  for (const s of seats) {
    if (s.colony < 3) counts[s.colony]++;
    total++;
  }

  // Group the queue: party rows collapse into atomic groups. RANKED entries only
  // ever fill a ranked candidate for the SAME planet (plan §5/§53) — mode and
  // planet are hard filters, not preferences.
  const queued = [...ctx.db.queue_entry.iter()].filter(
    q => q.status === QUEUE_QUEUED && Boolean(q.ranked) === Boolean(candidate.ranked) && (!candidate.ranked || (q.planet_key ?? '') === candidate.planet_key)
  );
  const groups: { key: string; entries: any[] }[] = [];
  const partyGroups = new Map<number, any[]>();
  for (const q of queued) {
    if (q.party_id !== undefined && q.party_id !== null) {
      const list = partyGroups.get(q.party_id) ?? [];
      list.push(q);
      partyGroups.set(q.party_id, list);
    } else {
      groups.push({ key: `solo:${q.identity.toHexString()}`, entries: [q] });
    }
  }
  for (const [partyId, list] of partyGroups) groups.push({ key: `party:${partyId}`, entries: list });

  // Colony gap first, then queue age (plan §13 priority order).
  const groupColony = (g: { entries: any[] }): number => Math.min(...g.entries.map(e => (e.colony < 3 ? counts[e.colony] : 99)));
  const groupWait = (g: { entries: any[] }): bigint => g.entries.reduce((acc, e) => (e.queued_at < acc ? e.queued_at : acc), g.entries[0].queued_at);
  groups.sort((a, b) => {
    const gap = groupColony(a) - groupColony(b);
    if (gap !== 0) return gap;
    const at = groupWait(a);
    const bt = groupWait(b);
    return at < bt ? -1 : at > bt ? 1 : 0;
  });

  for (const group of groups) {
    if (total + group.entries.length > MATCH_MAX_PLAYERS) continue;
    const added = [0, 0, 0];
    let fits = true;
    for (const e of group.entries) {
      if (e.colony >= 3) { fits = false; break; }
      added[e.colony]++;
    }
    if (!fits) continue;
    for (let c = 0; c < 3; c++) if (counts[c] + added[c] > COLONY_CAP) fits = false;
    if (!fits) continue;

    for (const entry of group.entries) {
      if (seats.some(s => s.identity.toHexString() === entry.identity.toHexString())) continue;
      // Self-heal: an orphaned seat (from a candidate that vanished before this
      // fix, or any other leak) would trip the UNIQUE(identity) index on insert.
      const stale = ctx.db.match_candidate_player.identity.find(entry.identity);
      if (stale) ctx.db.match_candidate_player.id.delete(stale.id);
      ctx.db.match_candidate_player.insert({
        id: 0,
        match_id: candidate.match_id,
        identity: entry.identity,
        colony: entry.colony,
        confirmed: false,
        confirmed_at: undefined,
      });
      ctx.db.queue_entry.identity.update({ ...entry, status: QUEUE_CANDIDATE, candidate_match_id: candidate.match_id });
      counts[entry.colony]++;
      total++;
    }
  }
}

/**
 * Internal: the confirmation window closed (or everyone confirmed).
 * Unconfirmed seats are DROPPED from matchmaking (plan §14); confirmed seats
 * either start the match or — if too few are left — requeue automatically so
 * nobody has to press Find Match again (plan §14/rule 12).
 */
export function finalizeCandidate(ctx: any, candidateId: number): void {
  const candidate = ctx.db.candidate_match.match_id.find(candidateId);
  if (!candidate || candidate.status === 2) return;
  const seats = [...ctx.db.match_candidate_player.match_id.filter(candidateId)];
  const confirmed = seats.filter(s => s.confirmed);
  const unconfirmed = seats.filter(s => !s.confirmed);

  // Drop the no-shows entirely.
  for (const s of unconfirmed) {
    ctx.db.match_candidate_player.id.delete(s.id);
    ctx.db.queue_entry.identity.delete(s.identity);
  }

  if (confirmed.length >= MATCH_MIN_PLAYERS) {
    createMatch(ctx, candidateId, confirmed);
    // The seats became match_player rows — the candidate seats must go, or the
    // table-wide UNIQUE(identity) blocks these players from ever queueing again.
    for (const s of confirmed) ctx.db.match_candidate_player.id.delete(s.id);
    ctx.db.candidate_match.match_id.delete(candidateId);
    return;
  }

  // Too few confirmed: cancel and requeue the confirmed players automatically.
  for (const s of confirmed) {
    const q = ctx.db.queue_entry.identity.find(s.identity);
    if (q) ctx.db.queue_entry.identity.update({ ...q, status: QUEUE_QUEUED, candidate_match_id: undefined });
    ctx.db.match_candidate_player.id.delete(s.id);
  }
  maybeReleasePlanet(ctx, candidate.planet_key ?? '');
  ctx.db.candidate_match.match_id.delete(candidateId);
}

/** Internal: abandon a candidate entirely (players with CONFIRMED state requeue). */
export function releaseCandidate(ctx: any, candidateId: number, requeueConfirmed: boolean): void {
  const candidate = ctx.db.candidate_match.match_id.find(candidateId);
  for (const s of [...ctx.db.match_candidate_player.match_id.filter(candidateId)]) {
    const q = ctx.db.queue_entry.identity.find(s.identity);
    if (q) {
      if (s.confirmed && requeueConfirmed) {
        ctx.db.queue_entry.identity.update({ ...q, status: QUEUE_QUEUED, candidate_match_id: undefined });
      } else {
        ctx.db.queue_entry.identity.delete(s.identity);
      }
    }
    ctx.db.match_candidate_player.id.delete(s.id);
  }
  if (candidate) maybeReleasePlanet(ctx, candidate.planet_key ?? '');
  ctx.db.candidate_match.match_id.delete(candidateId);
}

/** Internal: remove one player from queue + candidate (cancel/decline path). */
export function removeFromQueue(ctx: any, identity: any, now: bigint): void {
  const q = ctx.db.queue_entry.identity.find(identity);
  const seat = ctx.db.match_candidate_player.identity.find(identity);
  if (seat) {
    const candidateId = seat.match_id;
    ctx.db.match_candidate_player.identity.delete(identity);
    const remaining = [...ctx.db.match_candidate_player.match_id.filter(candidateId)];
    if (remaining.length < MATCH_MIN_PLAYERS) {
      // Not enough left to ever start — do not keep them waiting on a dead candidate.
      releaseCandidate(ctx, candidateId, true);
    } else if (remaining.every(s => s.confirmed)) {
      finalizeCandidate(ctx, candidateId);
    }
  }
  if (q) ctx.db.queue_entry.identity.delete(identity);
  // A ranked search that ends frees its planet lock unless somebody else holds it.
  if (q && q.ranked && q.planet_key) maybeReleasePlanet(ctx, q.planet_key);
  void now;
}

/**
 * Internal: a candidate became real. Creates the Match row, one MatchPlayer per
 * confirmed seat (colonies from the ACCOUNT — plan §3/rule 4), the 10 Hz tick
 * schedule and the opening event. This is the ONLY way a match starts.
 */
export function createMatch(ctx: any, candidateId: number, seats: any[]): void {
  const now = ctx.timestamp;
  const micros = now.microsSinceUnixEpoch as bigint;
  const candidate = ctx.db.candidate_match.match_id.find(candidateId);
  const ranked = Boolean(candidate?.ranked);
  const key = ranked ? candidate.planet_key ?? '' : '';
  const parsed = key ? parsePlanetKey(key) : null;
  // A RANKED match plays the PLANET (plan §32): map_seed is the deterministic
  // planet seed, so every client builds the identical world — classic matches
  // keep their random seed.
  const seed = parsed
    ? planetSeed(universeSeed32(ensureActiveSeason(ctx)), parsed.ring, parsed.galaxyId, parsed.systemId, parsed.planetId)
    : Math.floor(ctx.random() * 0xffffffff) >>> 0;
  const m = ctx.db.match.insert({
    match_id: 0,
    status: MATCH_RUNNING,
    created_at: now,
    started_at: now,
    ended_at: undefined,
    map_seed: seed,
    winner_colony: undefined,
    duration_seconds: 0,
    server_tick: 0n,
    player_count: seats.length,
    empty_since: undefined,
    ranked,
    planet_key: key,
    rank_ring: parsed ? parsed.ring : 255,
  });
  if (key) refreshPlanetReservation(ctx, key, m.match_id, micros);

  for (const seat of seats) {
    const account = ctx.db.player.identity.find(seat.identity);
    ctx.db.match_player.insert({
      id: 0,
      match_id: m.match_id,
      identity: seat.identity,
      name: account?.player_name ?? 'Survivor',
      colony: seat.colony,
      kills: 0,
      deaths: 0,
      damage: 0,
      objectives: 0,
      // Milestone: the account does not carry a Necrotech loadout yet, so every
      // seat starts on class 0. The picker can move server-side later (plan §32).
      necrotech: 0,
      confirmed: true,
      connected: true,
      x: 0, y: 0, z: 0,
      fx: 0, fy: 0, fz: 1,
      vx: 0, vy: 0, vz: 0,
      hp: 100,
      max_hp: 100,
      alive: true,
      has_pose: false,
      stats_reported_at: 0n,
      updated_at: now,
    });
    ctx.db.queue_entry.identity.delete(seat.identity);
    const presence = ctx.db.player_presence.identity.find(seat.identity);
    if (presence) ctx.db.player_presence.identity.update({ ...presence, status: PRESENCE_IN_MATCH, last_seen: now });
  }

  // Usage summary skeleton (plan §28) — filled in by the tick and finalized by rewards.
  ctx.db.match_server_usage.insert({
    match_id: m.match_id,
    started_at: now,
    ended_at: undefined,
    duration_seconds: 0,
    player_count: seats.length,
    server_ticks: 0n,
    input_commands: 0n,
    state_updates: 0n,
    events: 0n,
    estimated_egress_bytes: 0n,
    storage_bytes: 0n,
  });

  ctx.db.match_event.insert({
    id: 0,
    match_id: m.match_id,
    kind: EVENT_MATCH_STARTED,
    a: 0, b: 0,
    x: 0, y: 0, z: 0,
    at: now,
  });

  // One 10 Hz tick per RUNNING match — never one per player/enemy (plan §40).
  ctx.db.match_tick.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.interval(TICK_INTERVAL_US),
    match_id: m.match_id,
  });
  void candidateId;
}
/**
 * Arm the global 1 Hz scan. IDEMPOTENT, and re-checked whenever a player
 * queues: an interrupted module update can leave the schedule table empty —
 * without the scanner, candidates never age and the queue silently stalls.
 */
export function armMatchmakingScan(ctx: any): void {
  for (const _ of ctx.db.matchmaking_scan.iter()) return; // already armed
  ctx.db.matchmaking_scan.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.interval(SCAN_INTERVAL_US),
  });
}
