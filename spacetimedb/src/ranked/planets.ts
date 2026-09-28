// NECROFALL — persistent planets (plan §33–§38/§52/§57).
//
// Only player-relevant planets exist in the database. Discovery creates the
// row; matchmaking reserves it; a won ranked match controls it for 72 hours;
// the sweep returns it to the Necrophages when the shield falls.
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { planet_control_history, planet_discovery, ranked_planet, ranked_planet_reservation, ranked_season } from '../schema/ranked';
import { player } from '../schema/player';
import { MAX_PLANET_DISCOVERERS, PLANET_CONTROL_US, PLANET_MATCH_RESERVATION_US, SEASON_ONE_UNIVERSE_SEED } from '../constants';
import { getRankRing } from './rank';
import { parsePlanetKey, planetKey, planetSeed } from './seed';
import { requireOnboarded } from '../auth/authorization';

export const COLONY_NONE = 255;

/** The one active season, created on first use (plan §56). */
export function ensureActiveSeason(ctx: any): any {
  for (const s of ctx.db.ranked_season.iter()) {
    if (s.active) return s;
  }
  return ctx.db.ranked_season.insert({
    season_id: 0,
    universe_seed: SEASON_ONE_UNIVERSE_SEED,
    started_at: ctx.timestamp,
    ends_at: undefined,
    active: true,
  });
}

/** 32-bit view of the season's u64 universe seed — what `planetSeed()` hashes. */
export function universeSeed32(season: any): number {
  return Number(BigInt(season.universe_seed) % 4294967296n);
}

/** Find-or-create the planet row for a key (plan §33: rows exist on contact). */
export function ensurePlanetRow(ctx: any, season: any, key: string): any {
  const existing = ctx.db.ranked_planet.planet_key.find(key);
  if (existing) return existing;
  const parsed = parsePlanetKey(key);
  if (!parsed) throw new SenderError('Malformed planet key.');
  return ctx.db.ranked_planet.insert({
    planet_key: key,
    season_id: season.season_id,
    ring: parsed.ring,
    galaxy_id: parsed.galaxyId,
    system_id: parsed.systemId,
    planet_id: parsed.planetId,
    seed: BigInt(planetSeed(universeSeed32(season), parsed.ring, parsed.galaxyId, parsed.systemId, parsed.planetId)),
    state: 0,
    controlling_colony: COLONY_NONE,
    control_started_at: 0n,
    control_expires_at: 0n,
    discovered: false,
    first_discovered_at: 0n,
    last_match_id: 0,
    generated_rank: 0,
  });
}

/**
 * DISCOVER PLANET (plan §34/§35). Validates the ring against the caller's RANK
 * RING — you cannot queue into a region your rank has not unlocked. Records the
 * caller among the first 5 discoverers and marks the row discovered.
 */
export const discover_planet = spacetimedb.reducer(
  { ring: t.u8(), galaxyId: t.u32(), systemId: t.u32(), planetId: t.u32() },
  (ctx, { ring, galaxyId, systemId, planetId }) => {
    const me = requireOnboarded(ctx);
    const season = ensureActiveSeason(ctx);
    const myRing = getRankRing(me.rank_points);
    if (ring !== myRing) throw new SenderError('That region belongs to another rank ring.');
    const key = planetKey(ring, galaxyId, systemId, planetId);
    const now = ctx.timestamp.microsSinceUnixEpoch as bigint;
    let planet = ensurePlanetRow(ctx, season, key);
    if (!planet.discovered) {
      planet = ctx.db.ranked_planet.planet_key.update({
        ...planet,
        discovered: true,
        first_discovered_at: now,
        generated_rank: me.rank_points,
      });
    }
    // First N discoverers (plan §35) — one row per player per planet.
    let mine: any | undefined;
    let count = 0;
    for (const d of ctx.db.planet_discovery.planet_key.filter(key)) {
      count++;
      if (d.identity.toHexString() === ctx.sender.toHexString()) mine = d;
    }
    if (!mine && count < MAX_PLANET_DISCOVERERS) {
      ctx.db.planet_discovery.insert({
        id: 0,
        planet_key: key,
        identity: ctx.sender,
        player_name: me.player_name || 'Survivor',
        discovered_at: now,
        discovery_order: count + 1,
      });
    }
  }
);

/** Lock a planet for a filling/playing ranked match (plan §36). */
export function reservePlanet(ctx: any, key: string, matchId: number, now: bigint, ttlUs: bigint): boolean {
  const existing = ctx.db.ranked_planet_reservation.planet_key.find(key);
  if (existing && existing.expires_at > now) return false;
  if (existing) ctx.db.ranked_planet_reservation.planet_key.delete(key);
  ctx.db.ranked_planet_reservation.insert({
    planet_key: key,
    match_id: matchId,
    reserved_at: now,
    expires_at: now + ttlUs,
  });
  return true;
}

export function releaseReservation(ctx: any, key: string): void {
  if (!key) return;
  if (ctx.db.ranked_planet_reservation.planet_key.find(key)) {
    ctx.db.ranked_planet_reservation.planet_key.delete(key);
  }
}

/** Attach/extend a reservation onto a REAL match (called when the candidate becomes one). */
export function refreshPlanetReservation(ctx: any, key: string, matchId: number, now: bigint): void {
  if (!key) return;
  const existing = ctx.db.ranked_planet_reservation.planet_key.find(key);
  if (existing) {
    ctx.db.ranked_planet_reservation.planet_key.update({
      ...existing,
      match_id: matchId,
      expires_at: now + PLANET_MATCH_RESERVATION_US,
    });
    return;
  }
  ctx.db.ranked_planet_reservation.insert({
    planet_key: key,
    match_id: matchId,
    reserved_at: now,
    expires_at: now + PLANET_MATCH_RESERVATION_US,
  });
}

/**
 * Release the lock only if NOBODY still wants the planet: no queue entry, no
 * filling candidate and no LIVE match owns it. Called from the pre-match exits
 * (cancel, decline, too-few-confirmed) so an abandoned search never leaves a
 * planet shielded forever.
 */
export function maybeReleasePlanet(ctx: any, key: string): void {
  if (!key) return;
  const res = ctx.db.ranked_planet_reservation.planet_key.find(key);
  if (!res) return;
  if (res.match_id > 0) {
    const m = ctx.db.match.match_id.find(res.match_id);
    if (m && m.status !== 2) return; // a live match owns this planet now
  }
  for (const q of ctx.db.queue_entry.iter()) {
    if (q.planet_key === key) return; // somebody is still searching for it
  }
  for (const c of ctx.db.candidate_match.iter()) {
    if (c.planet_key !== key) continue;
    for (const _ of ctx.db.match_candidate_player.match_id.filter(c.match_id)) return; // seats still on it
  }
  releaseReservation(ctx, key);
}

/** True when the planet can host a new ranked match (plan §53). */
export function planetAvailable(ctx: any, key: string, now: bigint): boolean {
  const planet = ctx.db.ranked_planet.planet_key.find(key);
  if (planet && planet.state === 1) return false; // controlled — shielded
  const res = ctx.db.ranked_planet_reservation.planet_key.find(key);
  if (res && res.expires_at > now) return false; // locked by a live match
  return true;
}

/**
 * A ranked match was WON on this planet (plan §37): the winning colony raises
 * its shield for 72 hours. The old stint's history row is closed.
 */
export function claimPlanetControl(ctx: any, key: string, colony: number, matchId: number, now: bigint): void {
  const season = ensureActiveSeason(ctx);
  const planet = ctx.db.ranked_planet.planet_key.find(key) ?? ensurePlanetRow(ctx, season, key);
  // Close any running stint (a draw never owns, so this is usually a no-op).
  for (const h of ctx.db.planet_control_history.planet_key.filter(key)) {
    if (h.ended_at === 0n) ctx.db.planet_control_history.id.update({ ...h, ended_at: now });
  }
  ctx.db.ranked_planet.planet_key.update({
    ...planet,
    state: 1,
    controlling_colony: colony,
    control_started_at: now,
    control_expires_at: now + PLANET_CONTROL_US,
    last_match_id: matchId,
  });
  ctx.db.planet_control_history.insert({
    id: 0,
    planet_key: key,
    colony,
    match_id: matchId,
    started_at: now,
    ended_at: 0n,
  });
  releaseReservation(ctx, key);
}

/** The match ended without a claim (draw/abandon): free the planet again. */
export function releasePlanetAfterMatch(ctx: any, key: string): void {
  releaseReservation(ctx, key);
}

/**
 * The 1 Hz sweep (called from the matchmaking scanner): expired reservations
 * die, and controlled planets whose 72-hour shield fell return to the
 * Necrophages (plan §38/§52).
 */
export function sweepRanked(ctx: any, now: bigint): void {
  for (const res of [...ctx.db.ranked_planet_reservation.iter()]) {
    if (res.expires_at <= now) ctx.db.ranked_planet_reservation.planet_key.delete(res.planet_key);
  }
  for (const planet of [...ctx.db.ranked_planet.iter()]) {
    if (planet.state !== 1) continue;
    if (planet.control_expires_at === 0n || planet.control_expires_at > now) continue;
    ctx.db.ranked_planet.planet_key.update({
      ...planet,
      state: 0,
      controlling_colony: COLONY_NONE,
      control_started_at: 0n,
      control_expires_at: 0n,
    });
    for (const h of ctx.db.planet_control_history.planet_key.filter(planet.planet_key)) {
      if (h.ended_at === 0n) ctx.db.planet_control_history.id.update({ ...h, ended_at: now });
    }
  }
}

// ------------------------------------------------------------ colony statistics (plan §41/§76)

export const ColonyStats = t.object('ColonyStats', {
  colony: t.u8(),
  planets: t.u32(),
  systems: t.u32(),
  expiring: t.u32(),
});

export const ColonyStatsResult = t.object('ColonyStatsResult', {
  total_planets: t.u32(),
  total_systems: t.u32(),
  colonies: t.array(ColonyStats),
});

/**
 * Aggregate colony power across the WHOLE season (plan §41): planets held,
 * distinct solar systems dominated (a colony holds >= 50% of the system's
 * controlled planets — plan §42), and shields falling within the hour.
 * Computed on demand — never stored (the plan forbids materialising influence).
 */
export const colony_stats = spacetimedb.procedure(ColonyStatsResult, (ctx) => {
  const nowMs = ctx.timestamp.microsSinceUnixEpoch as bigint;
  return ctx.withTx((tx: any) => {
    const planets = [0, 0, 0];
    const expiring = [0, 0, 0];
    const systemOwners = new Map<string, Map<number, number>>();
    let totalPlanets = 0;
    for (const p of tx.db.ranked_planet.iter()) {
      if (p.state !== 1 || p.controlling_colony >= 3) continue;
      totalPlanets++;
      planets[p.controlling_colony]++;
      const sysKey = `${p.ring}:${p.galaxy_id}:${p.system_id}`;
      const owners = systemOwners.get(sysKey) ?? new Map<number, number>();
      owners.set(p.controlling_colony, (owners.get(p.controlling_colony) ?? 0) + 1);
      systemOwners.set(sysKey, owners);
      if (p.control_expires_at > 0n && p.control_expires_at - nowMs < 3_600_000_000n) {
        expiring[p.controlling_colony]++;
      }
    }
    const dominated: Set<string>[] = [new Set<string>(), new Set<string>(), new Set<string>()];
    for (const [sysKey, owners] of systemOwners) {
      let best = -1;
      let bestCount = 0;
      let total = 0;
      for (const [colony, count] of owners) {
        total += count;
        if (count > bestCount) {
          bestCount = count;
          best = colony;
        }
      }
      // >= 50% of the system's controlled planets = domination (plan §42);
      // otherwise the system is CONTESTED and counts for nobody.
      if (best >= 0 && bestCount * 2 >= total) dominated[best].add(sysKey);
    }
    return {
      total_planets: totalPlanets,
      total_systems: dominated[0].size + dominated[1].size + dominated[2].size,
      colonies: [0, 1, 2].map((c) => ({
        colony: c,
        planets: planets[c],
        systems: dominated[c].size,
        expiring: expiring[c],
      })),
    };
  });
});
