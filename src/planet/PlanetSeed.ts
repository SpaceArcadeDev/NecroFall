// NECROFALL — PlanetSeed (plan §4): the deterministic seed helpers every planet-derived system
// shares. One normalisation (uint32) and one salted RNG factory, so a planet's world seed
// reproduces EXACTLY the same placement, patches and weather regardless of load order.
import { Rand } from '../utils/Utils';

/** The canonical planet seed: uint32. */
export function normalisePlanetSeed(seed: number): number {
  return seed >>> 0;
}

/**
 * A seeded RNG for one sub-system. The salt separates streams (meadows vs patches vs scatter)
 * while both stay a pure function of the planet seed.
 */
export function planetRand(seed: number, salt: number): Rand {
  return new Rand((normalisePlanetSeed(seed) ^ (salt >>> 0)) >>> 0);
}

/** Common salts — never reuse one for two systems. */
export const PLANET_SALT = {
  MEADOWS: 0x5747,
  PATCHES: 0x1d2f,
  SCATTER: 0x77aa,
} as const;
