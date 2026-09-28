// NECROFALL — DISCOVERY OF GALAXIES / SYSTEMS / PLANETS (plan §1–§6/§66).
//
// One authoritative log (`ranked_location_discovery`): the first 9 UNIQUE
// players per location, in chronological order — slot 1 is the first footfall,
// slot 9 is the last that counts. Nothing here trusts the client beyond the
// location it claims to have entered:
//
//   * the caller's identity comes from `ctx.sender`,
//   * name + colony are read from the caller's own player row,
//   * the timestamp is `ctx.timestamp`,
//   * the ring/galaxy id are DERIVED from the location key and re-validated,
//   * discovery must happen inside the caller's own rank ring,
//   * the slot index is assigned inside the reducer transaction, so two
//     simultaneous discoverers can never hold the same index.
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { requireOnboarded } from '../auth/authorization';
import { getRankRing } from './rank';
import { planetKey } from './seed';
import { ensureActiveSeason, ensurePlanetRow } from './planets';
import { canonicalLocationKey, LOCATION_PLANET, LOCATION_SYSTEM, MAX_LOCATION_DISCOVERERS, parseLocationKey } from './location';
import { recordLocationDiscovery } from './record';

/**
 * DISCOVER LOCATION (plan §4/§5/§47) — the map's first-contact trigger.
 * The client asks when a galaxy/system/planet is genuinely ENTERED or SELECTED;
 * the server decides whether that counts. Silently no-ops once the caller is in
 * the list or the slot cap is reached, so the client never has to know.
 */
export const discover_location = spacetimedb.reducer(
  {
    locationType: t.u8(),
    locationKey: t.string(),
    galaxyId: t.u32(),
    systemId: t.u32(),
    planetId: t.u32(),
  },
  (ctx, { locationType, locationKey, galaxyId, systemId, planetId }) => {
    const me = requireOnboarded(ctx);
    const loc = parseLocationKey(locationType, locationKey);
    if (!loc || canonicalLocationKey(loc) !== locationKey) throw new SenderError('Malformed location key.');
    if (loc.galaxyId !== galaxyId) throw new SenderError('Location does not match its galaxy.');
    if (loc.type >= LOCATION_SYSTEM && loc.systemId !== systemId) throw new SenderError('Location does not match its system.');
    if (loc.type === LOCATION_PLANET && loc.planetId !== planetId) throw new SenderError('Location does not match its planet.');
    // Same rule as ranked matchmaking: you only map territory your rank unlocks.
    const myRing = getRankRing(me.rank_points);
    if (loc.ring !== myRing) throw new SenderError('That region belongs to another rank ring.');
    const now = ctx.timestamp.microsSinceUnixEpoch as bigint;
    if (loc.type === LOCATION_PLANET) {
      // A planet claim keeps the legacy row in step (MAPPED status + first contact).
      const season = ensureActiveSeason(ctx);
      let planet = ensurePlanetRow(ctx, season, planetKey(loc.ring, loc.galaxyId, loc.systemId, loc.planetId));
      if (!planet.discovered) {
        planet = ctx.db.ranked_planet.planet_key.update({
          ...planet,
          discovered: true,
          first_discovered_at: now,
          generated_rank: me.rank_points,
        });
      }
    }
    recordLocationDiscovery(ctx, me, { ...loc, key: locationKey }, now);
  }
);

/** The tier cap, re-exported for importers/tests. */
export { MAX_LOCATION_DISCOVERERS };
