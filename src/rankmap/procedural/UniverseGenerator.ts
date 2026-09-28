// NECROFALL — the universe façade (plan §0/§40/§51/§53). Stateless helpers over
// the generators: viewport sweeps for the map, deterministic "home" anchors per
// ring, and the nearest-available-planet search for FIND ANOTHER PLANET.
import { GalaxyDescriptor, PlanetDescriptor } from './GalaxyTypes';
import { galaxyAt } from './GalaxyGenerator';
import { systemPlanetCount } from './SolarSystemGenerator';
import { planetAt } from './PlanetGenerator';
import { hash32, rng, ringCenterRadius } from './SeedHash';

/** Every galaxy inside a grid window (nulls are empty space — swept away). */
export function galaxiesInView(universeSeed: number, minGx: number, maxGx: number, minGy: number, maxGy: number, cap = 400): GalaxyDescriptor[] {
  const out: GalaxyDescriptor[] = [];
  for (let gy = Math.floor(minGy); gy <= Math.floor(maxGy); gy++) {
    for (let gx = Math.floor(minGx); gx <= Math.floor(maxGx); gx++) {
      const g = galaxyAt(universeSeed, gx, gy);
      if (g) out.push(g);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * A deterministic anchor point for a ring band — used by "YOUR RING" and the
 * ring rail. Walks the mid-radius of the band from a seed-chosen angle until it
 * finds an existing galaxy (there always is one; the walk is bounded).
 */
export function ringHome(universeSeed: number, ring: number): { gx: number; gy: number } {
  const radius = ringCenterRadius(ring);
  const r = rng(hash32(universeSeed >>> 0, 'home', ring));
  const baseAngle = r() * Math.PI * 2;
  for (let step = 0; step < 512; step++) {
    // Golden-angle walk keeps successive probes far apart.
    const angle = baseAngle + step * 2.399963;
    const gx = Math.round(Math.cos(angle) * radius);
    const gy = Math.round(Math.sin(angle) * radius);
    if (galaxyAt(universeSeed, gx, gy)) return { gx, gy };
  }
  return { gx: Math.round(Math.cos(baseAngle) * radius), gy: Math.round(Math.sin(baseAngle) * radius) };
}

/** The full deterministic planet roster of one system. */
export function planetsInSystem(universeSeed: number, ring: number, galaxyId: number, systemId: number): PlanetDescriptor[] {
  const count = systemPlanetCount(universeSeed, ring, galaxyId, systemId);
  const out: PlanetDescriptor[] = [];
  for (let p = 0; p < count; p++) out.push(planetAt(universeSeed, ring, galaxyId, systemId, p));
  return out;
}

/**
 * FIND ANOTHER PLANET (plan §40/§52/§53): the nearest AVAILABLE planet to the
 * one the player wanted, searching the same system first, then neighbouring
 * systems of the same galaxy. `available` decides (controlled/reserved planets
 * fail it). Returns null only when the whole galaxy is saturated — the caller
 * then extends the search to the next galaxy.
 */
export function nearestAvailablePlanet(
  universeSeed: number,
  ring: number,
  galaxyId: number,
  systemId: number,
  fromPlanetId: number,
  systemCount: number,
  available: (p: PlanetDescriptor) => boolean
): PlanetDescriptor | null {
  // System visit order: the selected one, then +1/-1, +2/-2, …
  const order: number[] = [];
  for (let d = 0; d < systemCount; d++) {
    order.push(systemId + d);
    if (d > 0) order.push(systemId - d);
  }
  for (const sid of order) {
    if (sid < 0 || sid >= systemCount) continue;
    const planets = planetsInSystem(universeSeed, ring, galaxyId, sid);
    // Planet visit order: nearest ordinal to the original pick first.
    planets.sort((a, b) => Math.abs(a.planetId - fromPlanetId) - Math.abs(b.planetId - fromPlanetId));
    for (const p of planets) {
      if (available(p)) return p;
    }
  }
  return null;
}
