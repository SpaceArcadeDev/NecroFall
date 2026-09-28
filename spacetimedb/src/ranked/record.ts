// NECROFALL — the DISCOVERY RECORDER (plan §3/§4). LEAF MODULE: it touches the
// discovery table only, so both `discover_location` (the map flow) and the
// legacy `discover_planet` (match-end first contact) can record through it
// without any import cycles.
import { ranked_location_discovery } from '../schema/ranked';
import { COLONY_NONE } from '../constants';
import { MAX_LOCATION_DISCOVERERS, type ParsedLocation } from './location';

/** A location claimed by a client, already parsed + validated. */
export interface DiscoveredLocation extends ParsedLocation {
  key: string;
}

/**
 * Record the caller among the first discoverers of `loc` (plan §4). No-op when
 * the caller already holds a slot (a player only ever occupies ONE slot per
 * location) or when all 9 slots are taken. The index is `count + 1`, computed
 * inside the same transaction that inserts the row — two simultaneous
 * discoverers can never share an index.
 */
export function recordLocationDiscovery(ctx: any, me: any, loc: DiscoveredLocation, now: bigint): boolean {
  let count = 0;
  let mine = false;
  for (const row of ctx.db.ranked_location_discovery.location_key.filter(loc.key)) {
    count++;
    if (row.player_identity.toHexString() === ctx.sender.toHexString()) mine = true;
  }
  if (mine) return false; // this player already discovered the location — do nothing
  if (count >= MAX_LOCATION_DISCOVERERS) return false; // all 9 slots are taken
  ctx.db.ranked_location_discovery.insert({
    id: 0,
    location_key: loc.key,
    location_type: loc.type,
    ring: loc.ring,
    galaxy_id: loc.galaxyId,
    system_id: loc.systemId,
    planet_id: loc.planetId,
    player_identity: ctx.sender,
    player_name: me.player_name || 'Survivor',
    colony: me.colony ?? COLONY_NONE,
    discovered_at: now,
    discovery_index: count + 1,
  });
  return true;
}
