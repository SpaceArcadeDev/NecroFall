// NECROFALL — ranked matchmaking (plan §5/§32/§36/§53).
//
// FIND RANKED MATCH queues the player for ONE planet (the one they selected on
// the galactic map, or the nearest available one the client recommended). The
// planet is RESERVED for the fill+confirm window, handed to the match when it
// starts, and released or claimed when it ends. Ranked candidates never mix
// with classic candidates (plan §5 — ranked is its own pool).
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { queue_entry } from '../schema/matchmaking';
import { PLANET_RESERVATION_US } from '../constants';
import { requireOnboarded } from '../auth/authorization';
import { armMatchmakingScan, fillOpenCandidates, maybeCreateCandidate } from '../matchmaking/queue';
import { getRankRing } from './rank';
import { planetKey } from './seed';
import { ensureActiveSeason, ensurePlanetRow, planetAvailable, reservePlanet } from './planets';

function nowMicros(ctx: any): bigint {
  return ctx.timestamp.microsSinceUnixEpoch as bigint;
}

/** The caller's live match seat, if any — a player may only be in one match. */
function activeMatchFor(ctx: any, identity: any): any | undefined {
  for (const mp of ctx.db.match_player.identity.filter(identity)) {
    if (mp.left) continue;
    const m = ctx.db.match.match_id.find(mp.match_id);
    if (m && m.status !== 2) return m;
  }
  return undefined;
}

/**
 * FIND RANKED MATCH — the planet-panel button (plan §5/§49).
 * Validates: rank ring ownership, planet availability, no live match, and that
 * the caller is not in a party (ranked is solo — squads play classic).
 */
export const find_ranked_match = spacetimedb.reducer(
  { ring: t.u8(), galaxyId: t.u32(), systemId: t.u32(), planetId: t.u32() },
  (ctx, { ring, galaxyId, systemId, planetId }) => {
    const me = requireOnboarded(ctx);
    armMatchmakingScan(ctx); // self-heal — schedule rows do not survive every deploy
    if (ctx.db.queue_entry.identity.find(ctx.sender)) return; // already searching — idempotent
    if (activeMatchFor(ctx, ctx.sender)) throw new SenderError('You are already in a match.');
    if (ctx.db.party_member.identity.find(ctx.sender)) {
      throw new SenderError('Ranked matches are solo — leave your party first.');
    }

    const myRing = getRankRing(me.rank_points);
    if (ring !== myRing) throw new SenderError('That system belongs to another rank ring — climb to unlock it.');

    const season = ensureActiveSeason(ctx);
    const key = planetKey(ring, galaxyId, systemId, planetId);
    const now = nowMicros(ctx);

    // Queuing IS contact: the planet becomes discovered (plan §34).
    let planet = ensurePlanetRow(ctx, season, key);
    if (!planet.discovered) {
      planet = ctx.db.ranked_planet.planet_key.update({
        ...planet,
        discovered: true,
        first_discovered_at: now,
        generated_rank: me.rank_points,
      });
    }
    if (!planetAvailable(ctx, key, now)) {
      throw new SenderError('That planet is shielded or contested — find another.');
    }
    if (!reservePlanet(ctx, key, 0, now, PLANET_RESERVATION_US)) {
      throw new SenderError('That planet is already contested — find another.');
    }

    ctx.db.queue_entry.insert({
      identity: ctx.sender,
      party_id: undefined,
      colony: me.colony,
      skill_rating: me.skill_rating,
      queued_at: now,
      status: 0,
      candidate_match_id: undefined,
      ranked: true,
      planet_key: key,
    });

    // Snappy path: react to this enqueue now instead of waiting for the scan.
    fillOpenCandidates(ctx, now);
    maybeCreateCandidate(ctx, now);
  }
);
