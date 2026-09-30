/**
 * NECROFALL — planet seed + spatial hash helpers (plan §4).
 *
 * The dev world (and, at cutover, each match planet) is described by one
 * `PlanetSpec`; every consumer derives its randomness from it so two runs of
 * the same seed build the same world.
 */

export interface PlanetSpec {
  seed: number;
  ring: number;
  /** Base sphere radius in metres (terrain oscillates around it). */
  radius: number;
  /** Optional label for the debug overlay. */
  label?: string;
}

export function makePlanetSpec(seed: number, ring = 0, radius = 118, label?: string): PlanetSpec {
  return { seed: seed >>> 0, ring, radius, label };
}

/** Deterministic 32-bit hash of three quantized coordinates + salt → [0, 1). */
export function hash01(x: number, y: number, z: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1442695041 + salt * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Mulberry32 — small seeded RNG used for placement passes. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random unit vector from a seeded RNG (allocation into `out`). */
export function randomDirection(random: () => number, out: { x: number; y: number; z: number }): void {
  const z = random() * 2 - 1;
  const a = random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  out.x = r * Math.cos(a);
  out.y = z;
  out.z = r * Math.sin(a);
}
