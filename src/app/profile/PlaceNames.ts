// NECROFALL — human-readable NAMES for ranked places (user ask 2026-09-29:
// the profile's history/discoveries say WHICH planet).
//
// The server stores COORDINATES only (planet keys, galaxy ids) — names are
// regenerated client-side from the active season seed with the SAME generators
// the galactic map uses, so a planet is called the same thing everywhere.
import { ClientCache } from '../spacetimedb/cache';
import { LOCATION_GALAXY, LOCATION_PLANET, LOCATION_SYSTEM } from '../spacetimedb/rows';
import { DEFAULT_UNIVERSE_SEED, decodeGalaxyId, parsePlanetKey } from '../../rankmap/procedural/SeedHash';
import { galaxyAt } from '../../rankmap/procedural/GalaxyGenerator';
import { systemAt } from '../../rankmap/procedural/SolarSystemGenerator';
import { planetAt } from '../../rankmap/procedural/PlanetGenerator';

/** The active season's universe seed (falls back to the shipped season-one seed). */
export function activeUniverseSeed(): number {
  const season = ClientCache.shared.rankedSeason();
  return season ? Number(season.universeSeed) : DEFAULT_UNIVERSE_SEED;
}

/** `G:gx:gy` → the galaxy's name. */
export function galaxyName(seed: number, galaxyId: number): string {
  const { gx, gy } = decodeGalaxyId(galaxyId);
  return galaxyAt(seed, gx, gy)?.name ?? `GALAXY ${gx}:${gy}`;
}

/** `ring:g:s:p` → the planet's name, or null when the key is missing/malformed. */
export function planetNameFromKey(seed: number, planetKey: string): string | null {
  const parsed = parsePlanetKey(planetKey);
  if (!parsed) return null;
  return planetAt(seed, parsed.ring, parsed.galaxyId, parsed.systemId, parsed.planetId).name;
}

/** `ring:g:s:p` → the planet's name + its rank band (for the history row's `R3` tag). */
export function planetLabelFromKey(seed: number, planetKey: string): { name: string; ring: number } | null {
  const parsed = parsePlanetKey(planetKey);
  if (!parsed) return null;
  return {
    name: planetAt(seed, parsed.ring, parsed.galaxyId, parsed.systemId, parsed.planetId).name,
    ring: parsed.ring,
  };
}

export interface PlaceLabel {
  /** The place's own name ("VELLUM", …). */
  name: string;
  /** The tier, for the small caption — 'PLANET' / 'SYSTEM' / 'GALAXY'. */
  kind: string;
  /** The rank band the place sits in. */
  ring: number;
}

/**
 * One discovery row → its display label, by tier. Never invents a name: the
 * generators always resolve, and coordinates are the fallback.
 */
export function discoveryPlace(
  seed: number,
  row: { locationType: number; ring: number; galaxyId: number; systemId: number; planetId: number }
): PlaceLabel {
  if (row.locationType === LOCATION_PLANET) {
    return {
      name: planetAt(seed, row.ring, row.galaxyId, row.systemId, row.planetId).name,
      kind: 'PLANET',
      ring: row.ring,
    };
  }
  if (row.locationType === LOCATION_SYSTEM) {
    return { name: systemAt(seed, row.ring, row.galaxyId, row.systemId).name, kind: 'SYSTEM', ring: row.ring };
  }
  if (row.locationType === LOCATION_GALAXY) {
    return { name: galaxyName(seed, row.galaxyId), kind: 'GALAXY', ring: row.ring };
  }
  return { name: `GRID ${row.galaxyId}`, kind: 'UNKNOWN', ring: row.ring };
}
