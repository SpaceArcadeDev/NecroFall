// NECROFALL — deterministic universe hashing (plan §0/§7/§32). PURE FUNCTIONS.
//
// The universe is VIRTUAL: nothing about a galaxy/system/planet is stored —
// everything derives from `hash(seasonSeed, ring, galaxyId, systemId, planetId)`.
// The client keeps an EXACT copy in `src/rankmap/procedural/SeedHash.ts`;
// the match's `map_seed` is this hash, which is why every player in the same
// ranked match generates the same planet (plan §32/§63).

/** FNV-1a 32-bit over a mixed list of integers/strings. */
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

/** Mix two integers into one 32-bit value (avalanche). */
export function mix32(a: number, b: number): number {
  let h = a ^ Math.imul(b ^ (b >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Mulberry32 — the one RNG every generator uses. Deterministic across platforms. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Galaxy grid coordinate encoding: (gx, gy) ∈ [-512, 511]² → u32. */
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

/**
 * RANK-BAND GEOMETRY (universe v2, plan §1): cumulative band widths so higher ranks
 * own larger territory. KEEP IN SYNC with `src/rankmap/procedural/SeedHash.ts` —
 * `scripts/ring-parity.mjs` asserts both files resolve identical rings.
 */
export const RING_WIDTHS = [5, 7, 9, 11, 14, 17, 21, 25] as const;

/** Cumulative outer boundary of each tier — [5, 12, 21, 32, 46, 63, 84, 109]. */
export const RING_BOUNDS: number[] = (() => {
  const out: number[] = [];
  let acc = 0;
  for (const w of RING_WIDTHS) {
    acc += w;
    out.push(acc);
  }
  return out;
})();

/** The whole ranked universe lives inside this radius (King of Gods' outer edge). */
export const MAX_RING_RADIUS = RING_BOUNDS[RING_BOUNDS.length - 1];

export function ringInnerRadius(tier: number): number {
  const t = Math.max(0, Math.min(RING_WIDTHS.length - 1, Math.floor(tier)));
  return t === 0 ? 0 : RING_BOUNDS[t - 1];
}

export function ringOuterRadius(tier: number): number {
  const t = Math.max(0, Math.min(RING_WIDTHS.length - 1, Math.floor(tier)));
  return RING_BOUNDS[t];
}

export function ringCenterRadius(tier: number): number {
  return (ringInnerRadius(tier) + ringOuterRadius(tier)) / 2;
}

/** Rank ring of a galaxy grid coordinate — cumulative band boundaries (plan §1). */
export function ringOfGalaxy(gx: number, gy: number): number {
  const dist = Math.sqrt(gx * gx + gy * gy);
  for (let r = 0; r < RING_BOUNDS.length; r++) {
    if (dist < RING_BOUNDS[r]) return r;
  }
  return RING_BOUNDS.length - 1;
}

/**
 * UNIVERSE GENERATION VERSION (plan §46/§47). Bump whenever a change alters which
 * galaxy/system/planet a coordinate resolves to; the season stores it so a stale
 * season's rows can be migrated instead of silently re-pointing at other worlds.
 */
export const UNIVERSE_GENERATION_VERSION = 2;

/** The virtual planet KEY. Human-readable, sortable, and the DB primary key. */
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

/** The canonical planet seed — what ranked matches hand to the terrain generator. */
export function planetSeed(universeSeed: number, ring: number, galaxyId: number, systemId: number, planetId: number): number {
  return hash32('nf-planet', universeSeed >>> 0, ring, galaxyId, systemId, planetId);
}
