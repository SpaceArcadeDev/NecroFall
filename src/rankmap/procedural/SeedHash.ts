// NECROFALL — deterministic universe hashing (client mirror of
// `spacetimedb/src/ranked/seed.ts`). KEEP IN SYNC: the server computes the
// match's `map_seed` with the same functions, which is how every player in a
// ranked match generates the identical planet (plan §0/§32).

export function hash32(...parts: Array<number | string>): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = typeof part === 'string' ? part : String(part | 0);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2f;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mix32(a: number, b: number): number {
  let h = a ^ Math.imul(b ^ (b >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Mulberry32 — the one RNG every generator uses. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const GALAXY_GRID_ORIGIN = 512;
export const GALAXY_GRID_SPAN = 1024;

export function encodeGalaxyId(gx: number, gy: number): number {
  const x = Math.max(0, Math.min(GALAXY_GRID_SPAN - 1, Math.floor(gx) + GALAXY_GRID_ORIGIN));
  const y = Math.max(0, Math.min(GALAXY_GRID_SPAN - 1, Math.floor(gy) + GALAXY_GRID_ORIGIN));
  return (x * GALAXY_GRID_SPAN + y) >>> 0;
}

export function decodeGalaxyId(id: number): { gx: number; gy: number } {
  const v = id >>> 0;
  return { gx: Math.floor(v / GALAXY_GRID_SPAN) - GALAXY_GRID_ORIGIN, gy: (v % GALAXY_GRID_SPAN) - GALAXY_GRID_ORIGIN };
}

/** Rank ring of a galaxy grid coordinate — concentric bands (plan §1/§54). */
export const RING_WIDTH_CELLS = 5;
export function ringOfGalaxy(gx: number, gy: number): number {
  const dist = Math.sqrt(gx * gx + gy * gy);
  return Math.min(7, Math.floor(dist / RING_WIDTH_CELLS));
}

export function planetKey(ring: number, galaxyId: number, systemId: number, planetId: number): string {
  return `${ring}:${galaxyId}:${systemId}:${planetId}`;
}

export function parsePlanetKey(key: string): { ring: number; galaxyId: number; systemId: number; planetId: number } | null {
  const parts = key.split(':');
  if (parts.length !== 4) return null;
  const [ring, galaxyId, systemId, planetId] = parts.map((p) => Number(p));
  if (![ring, galaxyId, systemId, planetId].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return { ring, galaxyId, systemId, planetId };
}

/** The canonical planet seed — matches ranked matches' `map_seed`. */
export function planetSeed(universeSeed: number, ring: number, galaxyId: number, systemId: number, planetId: number): number {
  return hash32('nf-planet', universeSeed >>> 0, ring, galaxyId, systemId, planetId);
}

/** The one active season's default seed (matches SEASON_ONE_UNIVERSE_SEED). */
export const DEFAULT_UNIVERSE_SEED = 918273645;
