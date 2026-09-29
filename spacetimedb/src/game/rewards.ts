// NECROFALL — results, rewards, statistics and retention (plan §27/§28/§45/§46).
//
// The SERVER decides the winner and the payouts: the client cannot submit "I
// won" — `finishMatchInternal` is the only path that ends a match, and it runs
// inside the module. Everything money-shaped happens here, in integers.
import { t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { match, match_history, match_input, match_player, match_server_usage } from '../schema/match';
import { match_entity, match_event, match_objective, match_tick } from '../schema/game';
import { player, player_presence, player_stats, player_wallet } from '../schema/player';
import {
  EVENT_MATCH_ENDED,
  MATCH_FINISHED,
  MATCH_RUNNING,
  PRESENCE_ONLINE,
  REWARD_PREMIUM_WIN,
  REWARD_SOFT_KILL,
  REWARD_SOFT_LOSS,
  REWARD_SOFT_OBJECTIVE,
  REWARD_SOFT_WIN,
} from '../constants';
import { rank_history } from '../schema/ranked';
import { applyRankResult, getRankFromStars, RANK_RESULT_DRAW, RANK_RESULT_LOSS, RANK_RESULT_WIN } from '../ranked/rank';
import { claimPlanetControl, ensureActiveSeason, releasePlanetAfterMatch } from '../ranked/planets';
import { RANK_CAUSE_DRAW, RANK_CAUSE_LOSS, RANK_CAUSE_WIN } from '../schema/ranked';

/** Temporary live rows are purged this long after a match ends (plan §46). */
const LIVE_RETENTION_US = 10n * 60n * 1_000_000n;

function nowMicros(ctx: any): bigint {
  return ctx.timestamp.microsSinceUnixEpoch as bigint;
}

/**
 * Interim combat reporting until the server sim owns damage (Phase 8). Bounded
 * and rate-limited so the numbers are plausible: kills <= 400, one report per
 * 30 s. Rewards are computed from these numbers at match end.
 */
export const report_match_stats = spacetimedb.reducer(
  { kills: t.u32(), deaths: t.u32(), objectives: t.u32(), damage: t.f64() },
  (ctx, { kills, deaths, objectives, damage }) => {
    let target: any | undefined;
    for (const s of ctx.db.match_player.identity.filter(ctx.sender)) {
      const m = ctx.db.match.match_id.find(s.match_id);
      if (m && m.status === MATCH_RUNNING) { target = s; break; }
    }
    if (!target) return;
    const now = nowMicros(ctx);
    if (now - target.stats_reported_at < 30_000_000n) return;
    ctx.db.match_player.id.update({
      ...target,
      kills: Math.min(kills, 400),
      deaths: Math.min(deaths, 200),
      objectives: Math.min(objectives, 50),
      damage: Math.max(0, Math.min(Number.isFinite(damage) ? damage : 0, 2_000_000)),
      stats_reported_at: now,
    });
  }
);

/** Best-effort usage counters, sampled ~1/s so the summary can be tuned (plan §28/§29). */
export function noteTickUsage(ctx: any, matchId: number, movedPlayers: number, hadInput: number): void {
  const micros = nowMicros(ctx);
  // Ticks are 100 ms apart, so a 100 ms window catches exactly ONE tick per second
  // (the old 200 ms window wrote the usage row twice a second).
  if (micros % 1_000_000n >= 100_000n) return;
  const usage = ctx.db.match_server_usage.match_id.find(matchId);
  if (!usage) return;
  ctx.db.match_server_usage.match_id.update({
    ...usage,
    server_ticks: usage.server_ticks + 1n,
    state_updates: usage.state_updates + BigInt(movedPlayers),
    input_commands: usage.input_commands + BigInt(hadInput),
    estimated_egress_bytes: usage.estimated_egress_bytes + BigInt(140 * (movedPlayers + 1)),
  });
}

/**
 * THE END OF A MATCH. Server-only (scheduled/system callers); computes the
 * result, grants rewards, updates statistics, writes history, finalizes the
 * usage summary and purges the live simulation rows — in that order (plan §27).
 */
export function finishMatchInternal(ctx: any, matchId: number, winnerColony: number | null, _reason: string): void {
  const m = ctx.db.match.match_id.find(matchId);
  if (!m || m.status !== MATCH_RUNNING) return;
  const now = ctx.timestamp;
  const nowUs = nowMicros(ctx);
  const startedMicros = m.started_at ? (m.started_at.microsSinceUnixEpoch as bigint) : nowUs;
  const durationSeconds = Math.max(0, Number((nowUs - startedMicros) / 1_000_000n));

  for (const p of [...ctx.db.match_player.match_id.filter(matchId)]) {
    if (p.left) {
      // Abandoned seats earn nothing — only clear their in-match presence flag.
      const presence = ctx.db.player_presence.identity.find(p.identity);
      if (presence) ctx.db.player_presence.identity.update({ ...presence, status: PRESENCE_ONLINE, last_seen: now });
      continue;
    }
    const won = winnerColony !== null && p.colony === winnerColony;
    const soft =
      (won ? REWARD_SOFT_WIN : REWARD_SOFT_LOSS) +
      p.kills * REWARD_SOFT_KILL +
      p.objectives * REWARD_SOFT_OBJECTIVE;
    const premium = won ? REWARD_PREMIUM_WIN : 0;
    const xpEarned = 40 + p.kills * 6 + p.objectives * 25 + (won ? 80 : 0);

    // ---- wallet (integers only, plan §7)
    const wallet = ctx.db.player_wallet.identity.find(p.identity);
    if (wallet) {
      ctx.db.player_wallet.identity.update({
        ...wallet,
        soft_currency: wallet.soft_currency + BigInt(soft),
        premium_currency: wallet.premium_currency + BigInt(premium),
      });
    }

    // ---- account totals + level curve (level placeholder until seasons ship)
    const account = ctx.db.player.identity.find(p.identity);
    if (account) {
      const xp = account.xp + BigInt(xpEarned);
      const level = Math.max(1, 1 + Number(xp / 1000n));
      // ---- RANKED result (plan §2/§60): the SERVER hashes out the star change here and
      // NOWHERE else. WIN +1 · DRAW 0 · LOSS −1 (Bronze losses are free, Liberator's
      // 0-star floor is protected — see ranked/rank.ts).
      let rankFields: Record<string, unknown> = {};
      if (m.ranked) {
        const season = ensureActiveSeason(ctx);
        const oldInfo = getRankFromStars(account.rank_points);
        const result = won ? RANK_RESULT_WIN : winnerColony === null ? RANK_RESULT_DRAW : RANK_RESULT_LOSS;
        const applied = applyRankResult(account.rank_points, result);
        const newInfo = getRankFromStars(applied.stars);
        rankFields = {
          rank_points: applied.stars,
          current_rank: newInfo.tier,
          rank_status: 1,
          season_id: season.season_id,
          // The profile's BEST rank (user ask 2026-09-29): the ladder only grows here.
          peak_rank_points: Math.max(account.peak_rank_points, applied.stars),
        };
        ctx.db.rank_history.insert({
          id: 0,
          identity: p.identity,
          season_id: season.season_id,
          old_tier: oldInfo.tier,
          old_division: oldInfo.division,
          old_stars: oldInfo.stars,
          new_tier: newInfo.tier,
          new_division: newInfo.division,
          new_stars: newInfo.stars,
          cause: won ? RANK_CAUSE_WIN : winnerColony === null ? RANK_CAUSE_DRAW : RANK_CAUSE_LOSS,
          match_id: matchId,
          planet_key: m.planet_key ?? '',
          delta: applied.delta,
          created_at: now,
        });
      }
      ctx.db.player.identity.update({
        ...account,
        ...rankFields,
        xp,
        level,
        wins: account.wins + (won ? 1 : 0),
        losses: account.losses + (won ? 0 : 1),
        matches_played: account.matches_played + 1,
        last_seen_at: now,
      });
    }

    // ---- lifetime stats
    const stats = ctx.db.player_stats.identity.find(p.identity);
    if (stats) {
      ctx.db.player_stats.identity.update({
        ...stats,
        kills: stats.kills + p.kills,
        deaths: stats.deaths + p.deaths,
        damage_dealt: stats.damage_dealt + p.damage,
        play_time_seconds: stats.play_time_seconds + BigInt(durationSeconds),
        nexus_captures: stats.nexus_captures + p.objectives,
      });
    }

    // ---- permanent history row (compact — plan §45)
    ctx.db.match_history.insert({
      id: 0,
      identity: p.identity,
      match_id: matchId,
      colony: p.colony,
      won,
      kills: p.kills,
      deaths: p.deaths,
      objectives: p.objectives,
      duration_seconds: durationSeconds,
      ended_at: now,
      soft_currency_earned: BigInt(soft),
      xp_earned: xpEarned,
      // Which planet the match was fought on (user ask 2026-09-29 — the history tab).
      planet_key: m.planet_key ?? '',
    });

    const presence = ctx.db.player_presence.identity.find(p.identity);
    if (presence) ctx.db.player_presence.identity.update({ ...presence, status: PRESENCE_ONLINE, last_seen: now });
  }

  // ---- usage summary finalization (admin/debug only — plan §28)
  const usage = ctx.db.match_server_usage.match_id.find(matchId);
  if (usage) {
    const players = [...ctx.db.match_player.match_id.filter(matchId)].length;
    ctx.db.match_server_usage.match_id.update({
      ...usage,
      ended_at: now,
      duration_seconds: durationSeconds,
      player_count: players,
      events: usage.events + 1n,
      storage_bytes: BigInt(players * 480),
    });
  }

  ctx.db.match_event.insert({
    id: 0,
    match_id: matchId,
    kind: EVENT_MATCH_ENDED,
    a: winnerColony ?? 255,
    b: 0,
    x: 0, y: 0, z: 0,
    at: now,
  });

  // ---- the match row itself (kept — it is the compact result record)
  ctx.db.match.match_id.update({
    ...m,
    status: MATCH_FINISHED,
    ended_at: now,
    winner_colony: winnerColony ?? undefined,
    duration_seconds: durationSeconds,
  });

  // ---- PLANET CONTROL (plan §37/§60): a WON ranked match raises the winner's
  // planetary shield for 72 hours; a draw/abandon frees the planet again.
  if (m.ranked && m.planet_key) {
    if (winnerColony !== null) claimPlanetControl(ctx, m.planet_key, winnerColony, matchId, nowUs);
    else releasePlanetAfterMatch(ctx, m.planet_key);
  }

  // ---- stop the simulation + purge live state (plan §46)
  for (const row of [...ctx.db.match_tick.match_id.filter(matchId)]) {
    ctx.db.match_tick.scheduled_id.delete(row.scheduled_id);
  }
  for (const row of [...ctx.db.match_input.match_id.filter(matchId)]) ctx.db.match_input.id.delete(row.id);
  for (const row of [...ctx.db.match_entity.match_id.filter(matchId)]) ctx.db.match_entity.id.delete(row.id);
  for (const row of [...ctx.db.match_objective.match_id.filter(matchId)]) ctx.db.match_objective.id.delete(row.id);
  for (const row of [...ctx.db.match_msg.match_id.filter(matchId)]) ctx.db.match_msg.id.delete(row.id);
}

/**
 * Retention sweep (called by the 1 Hz scanner): after 10 minutes, delete the
 * per-player live rows and events of a finished match. `match` (the summary)
 * and `match_history` stay forever.
 */
export function cleanupFinishedMatches(ctx: any, now: bigint): void {
  for (const m of ctx.db.match.iter()) {
    if (m.status !== MATCH_FINISHED || !m.ended_at) continue;
    const ended = m.ended_at.microsSinceUnixEpoch as bigint;
    if (now - ended < LIVE_RETENTION_US) continue;
    const players = [...ctx.db.match_player.match_id.filter(m.match_id)];
    const events = [...ctx.db.match_event.match_id.filter(m.match_id)];
    const relayed = [...ctx.db.match_msg.match_id.filter(m.match_id)];
    if (players.length === 0 && events.length === 0 && relayed.length === 0) continue; // already swept
    for (const p of players) ctx.db.match_player.id.delete(p.id);
    for (const e of events) ctx.db.match_event.id.delete(e.id);
    for (const r of relayed) ctx.db.match_msg.id.delete(r.id);
  }
}
