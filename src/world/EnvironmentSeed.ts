// NECROFALL — ENVIRONMENT SEED (rework plan §59/§60).
//
// Every environmental object in the world is derived from:
//
//     planetSeed × environmentVersion × cellCoordinate × salt
//
// so two clients in the same match — and the same client after a reload — generate the exact same
// trees, rocks, grass and props without networking a single instance transform (plan §20/§73).
//
// Rules (plan §86):
//   * environment code NEVER calls Math.random();
//   * every random stream is addressed by a *stable, integer* (cell, salt, slot);
//   * the stream is a pure function of its address — re-generating a cell later yields the same
//     content, which is what makes streaming (activate → build → discard → rebuild) safe.
import { Rand } from '../utils/Utils';

/** The environment generation revision. Bump when placement ALGORITHMS change. */
export const ENVIRONMENT_VERSION = 1;

/**
 * Order-independent 32-bit mix of any number of integers. This is the base of every
 * environmental stream: `hash32(planetSeed, version, cell, salt)`.
 */
export function hash32(...parts: number[]): number {
  let h = 0x9e3779b9 >>> 0;
  for (let i = 0; i < parts.length; i++) {
    let k = parts[i] >>> 0;
    // fmix32 (murmur3 finalizer) per part, folded in with the golden ratio
    k = Math.imul(k ^ (k >>> 16), 0x85ebca6b) >>> 0;
    k = Math.imul(k ^ (k >>> 13), 0xc2b2ae35) >>> 0;
    h = (h ^ k) >>> 0;
    h = (Math.imul(h, 0x9e3779b1) + 0x6d2b79f5) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  return (h ^ (h >>> 12)) >>> 0;
}

/** Stable per-cell random stream for one placement purpose (a `salt`). */
export function cellRand(planetSeed: number, cell: number, salt: number, version = ENVIRONMENT_VERSION): Rand {
  return new Rand(hash32(planetSeed, version, cell, salt));
}

/** Stable per-object random stream inside a cell (`slot` addresses the object). */
export function objectRand(planetSeed: number, cell: number, slot: number, salt: number, version = ENVIRONMENT_VERSION): Rand {
  return new Rand(hash32(planetSeed, version, cell, salt, slot));
}

/**
 * One deterministic [0,1) value for (cell, salt, index) — the workhorse for hash-based thinning
 * decisions (grass tiers, per-cell variant choice) that must not consume a sequential stream.
 */
export function hash01(planetSeed: number, cell: number, salt: number, index = 0, version = ENVIRONMENT_VERSION): number {
  return hash32(planetSeed, version, cell, salt, index) / 4294967296;
}

/**
 * The kernel of the placement system: a small deterministic value-noise over a 3-vector.
 * Used for habitat fields (grass thickness, tree clumping) that should be continuous across cell
 * borders — two neighbouring cells sampling the same point get the same value, so fields never
 * seam along cell edges.
 */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const corner = (dx: number, dy: number, dz: number): number =>
    hash32(seed, ix + dx, iy + dy, iz + dz) / 4294967296;
  const x00 = corner(0, 0, 0) + (corner(1, 0, 0) - corner(0, 0, 0)) * ux;
  const x10 = corner(0, 1, 0) + (corner(1, 1, 0) - corner(0, 1, 0)) * ux;
  const x01 = corner(0, 0, 1) + (corner(1, 0, 1) - corner(0, 0, 1)) * ux;
  const x11 = corner(0, 1, 1) + (corner(1, 1, 1) - corner(0, 1, 1)) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

/** Fractal Brownian motion over `valueNoise3` — habitat fields (few octaves, placement-time only). */
export function fbm3(x: number, y: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise3(x * f, y * f, z * f, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** A globally stable 32-bit id for one environment object (used by destruction sync, plan §26). */
export function environmentObjectId(cell: number, kind: number, slot: number): number {
  return (hash32(cell, kind, slot) & 0x3fffffff) | (kind << 28);
}
