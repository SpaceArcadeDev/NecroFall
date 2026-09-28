// NECROFALL — RANKED LOCATION KEYS (plan §2/§3/§66). PURE FUNCTIONS.
//
// Discovery is recorded for GALAXIES, SYSTEMS and PLANETS, so every location
// needs a STABLE key that never collides across tiers:
//
//     galaxy:  G:12:38
//     system:  G:12:38:S:127
//     planet:  G:12:38:S:127:P:4
//
// KEEP IN SYNC with `src/rankmap/DiscoveryTypes.ts` (the client builds the same
// strings; the server re-validates every one of them before writing a row).
import { decodeGalaxyId, encodeGalaxyId, GALAXY_GRID_ORIGIN, GALAXY_GRID_SPAN, ringOfGalaxy } from './seed';

export const LOCATION_GALAXY = 0;
export const LOCATION_SYSTEM = 1;
export const LOCATION_PLANET = 2;

/** The maximum number of first discoverers kept per location (plan §3). */
export const MAX_LOCATION_DISCOVERERS = 9;

export function galaxyLocationKey(gx: number, gy: number): string {
  return `G:${gx}:${gy}`;
}

export function systemLocationKey(gx: number, gy: number, systemId: number): string {
  return `G:${gx}:${gy}:S:${systemId}`;
}

export function planetLocationKey(gx: number, gy: number, systemId: number, planetId: number): string {
  return `G:${gx}:${gy}:S:${systemId}:P:${planetId}`;
}

export interface ParsedLocation {
  type: number;
  gx: number;
  gy: number;
  galaxyId: number;
  ring: number;
  systemId: number;
  planetId: number;
}

const INT = /^-?\d+$/;

/**
 * Canonical parse + validation (plan §66): the key's SHAPE must match the
 * declared tier, every id must agree with the key, and the galaxy id + ring
 * are DERIVED here — a client can never hand us a location that does not parse
 * back to its own coordinates. Returns null for anything malformed.
 */
export function parseLocationKey(type: number, key: string): ParsedLocation | null {
  const parts = key.split(':');
  if (parts.length < 3 || parts.length > 8 || parts[0] !== 'G') return null;
  const gx = Number(parts[1]);
  const gy = Number(parts[2]);
  if (!INT.test(parts[1]) || !INT.test(parts[2])) return null;
  if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;
  const min = -GALAXY_GRID_ORIGIN;
  const max = GALAXY_GRID_SPAN - GALAXY_GRID_ORIGIN - 1;
  if (gx < min || gx > max || gy < min || gy > max) return null;
  const galaxyId = encodeGalaxyId(gx, gy);
  const base = { gx, gy, galaxyId, ring: ringOfGalaxy(gx, gy) };
  if (type === LOCATION_GALAXY) {
    if (parts.length !== 3) return null;
    return { type, ...base, systemId: 0, planetId: 0 };
  }
  if (parts.length < 5 || parts[3] !== 'S' || !INT.test(parts[4])) return null;
  const systemId = Number(parts[4]);
  if (!Number.isInteger(systemId) || systemId < 0) return null;
  if (type === LOCATION_SYSTEM) {
    if (parts.length !== 5) return null;
    return { type, ...base, systemId, planetId: 0 };
  }
  if (parts.length !== 7 || parts[5] !== 'P' || !INT.test(parts[6])) return null;
  const planetId = Number(parts[6]);
  if (!Number.isInteger(planetId) || planetId < 0) return null;
  return { type, ...base, systemId, planetId };
}

/** The canonical key for a parsed location, to compare against the raw input. */
export function canonicalLocationKey(parsed: ParsedLocation): string {
  if (parsed.type === LOCATION_GALAXY) return galaxyLocationKey(parsed.gx, parsed.gy);
  if (parsed.type === LOCATION_SYSTEM) return systemLocationKey(parsed.gx, parsed.gy, parsed.systemId);
  return planetLocationKey(parsed.gx, parsed.gy, parsed.systemId, parsed.planetId);
}

/** Ring + galaxy id of a grid coordinate (server-derived; never client-sent). */
export function locationRing(gx: number, gy: number): number {
  return ringOfGalaxy(gx, gy);
}

export function decodeLocationGalaxy(galaxyId: number): { gx: number; gy: number } {
  return decodeGalaxyId(galaxyId);
}
