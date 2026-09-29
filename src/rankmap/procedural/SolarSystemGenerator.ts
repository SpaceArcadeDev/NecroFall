// NECROFALL — solar system generation (plan §5/§6/§12). Each galaxy contains HUNDREDS
// of deterministic systems laid out as POPULATIONS, not a uniform spray:
//
//     45% central bulge   (strong central bias — the bright core the map must show)
//     40% disc / arms     (systems follow the galaxy's own morphology: spiral arms,
//                          elliptical squash, ring band, irregular clumps…)
//     10% outer disc      (sparse, still arm-aligned)
//      5% halo            (rare far scatter — the "strange" systems)
//
// The same coordinate ALWAYS resolves to the same system (plan §0): placement derives
// from `hash32(universeSeed, ring, galaxyId, systemId)` plus the galaxy's own rolled
// morphology, which is itself a pure function of its coordinates.
import { GalaxyDescriptor, GalaxyMorphology, SystemDescriptor, SYSTEM_DESIGNATIONS } from './GalaxyTypes';
import { decodeGalaxyId, hash32, rng } from './SeedHash';
import { galaxyAt, galaxyName } from './GalaxyGenerator';
import { ringConfig } from './RankRingConfig';

const TAU = Math.PI * 2;

/** One position in the galaxy's unit disc (0..1 space). */
interface DiscPlacement {
  ux: number;
  uy: number;
}

/** Angular slot for a disc/arm system, morphology aware (plan §4/§5). */
function armAngle(g: GalaxyDescriptor, radius: number, r: () => number): number {
  const arms = Math.max(1, g.armCount);
  if (g.morphology === 'SPIRAL' || g.morphology === 'BARRED_SPIRAL') {
    const arm = Math.floor(r() * arms);
    // arm base + wrap (tightness scales with the disc fraction) + angular spread
    return g.rotation + (arm / arms) * TAU + radius * g.armTightness * Math.PI + (r() - 0.5) * 0.34;
  }
  if (g.morphology === 'FLOCCULENT') {
    // many short, loose arms: lower wrap, wide spread
    const arm = Math.floor(r() * arms);
    return g.rotation + (arm / arms) * TAU + radius * (g.armTightness * 0.45) * Math.PI + (r() - 0.5) * 0.8;
  }
  // elliptical / ring / irregular dress their disc uniformly; shape comes from the transform
  return r() * TAU + g.rotation;
}

/** Deterministic irregular clump centres (6 lobes — blob galaxies read as clusters). */
function clumpAngle(g: GalaxyDescriptor, idx: number): number {
  return g.rotation + (idx / 6) * TAU + ((g.seed >>> (idx % 16)) & 15) * 0.02;
}

/**
 * Places one system in its galaxy's unit disc. The exact radius formula per population
 * is what creates the bright central bulge (plan §5: `pow(random, 1.8)` bulge bias —
 * NOT plain sqrt area coverage).
 */
function placeSystem(g: GalaxyDescriptor, r: () => number): DiscPlacement {
  const pop = r();
  let radius: number;
  let angle: number;

  if (pop < 0.45) {
    // ---- BULGE: strong central bias (exponent 1.8) — many systems very close in
    radius = Math.pow(r(), 1.8) * 0.34;
    angle = r() * TAU;
  } else if (pop < 0.85) {
    // ---- DISC / ARMS: mid radii, morphology aligned
    radius = 0.34 + Math.pow(r(), 0.85) * 0.48;
    angle = armAngle(g, radius, r);
    radius += (r() - 0.5) * 0.09; // perpendicular jitter = arm width
  } else if (pop < 0.95) {
    // ---- OUTER DISC: sparse, still following the arms
    radius = 0.82 + r() * 0.10;
    angle = armAngle(g, radius, r);
  } else {
    // ---- HALO: rare, off-plane strays
    radius = 0.6 + Math.pow(r(), 0.7) * 0.3;
    angle = r() * TAU;
  }

  if (g.morphology === 'RING') {
    // ring galaxies: the population lives IN the band
    radius = 0.62 + (r() - 0.5) * 0.18;
    angle = r() * TAU;
  } else if (g.morphology === 'IRREGULAR' && pop >= 0.45) {
    // irregular: disc systems scatter around one of six clumps
    const clump = Math.floor(r() * 6);
    angle = clumpAngle(g, clump) + (r() - 0.5) * 0.9;
    radius = 0.34 + r() * 0.48;
  }

  let dx = Math.cos(angle) * radius;
  let dy = Math.sin(angle) * radius;

  if (g.morphology === 'ELLIPTICAL') {
    // squash one axis (before rotation) so the cloud reads as an ellipse
    dy /= g.axisRatio;
    const ca = Math.cos(g.rotation);
    const sa = Math.sin(g.rotation);
    const rx = dx * ca - dy * sa;
    const ry = dx * sa + dy * ca;
    dx = rx;
    dy = ry;
  }

  return { ux: 0.5 + dx, uy: 0.5 + dy };
}

/** Per-galaxyId descriptor cache (bounded — plan §43) so system sweeps never re-hash. */
const descriptorCache = new Map<number, GalaxyDescriptor>();
const DESCRIPTOR_CACHE_CAP = 320;

/** Resolve a galaxy descriptor from its id; synthesises a fallback for empty cells. */
function descriptorFor(universeSeed: number, ring: number, galaxyId: number): GalaxyDescriptor {
  const hit = descriptorCache.get(galaxyId);
  if (hit) return hit;
  const { gx, gy } = decodeGalaxyId(galaxyId);
  let g = galaxyAt(universeSeed, gx, gy);
  if (!g) {
    // a caller asked for a system of a coordinate that holds no galaxy: build a stable
    // synthetic descriptor so placement stays deterministic instead of throwing
    const seed = hash32(universeSeed >>> 0, 'galaxy-fallback', ring, galaxyId);
    const r = rng(seed);
    g = {
      ring, gx, gy, galaxyId, seed,
      name: galaxyName(seed),
      starType: 'YELLOW', starColor: '#ffe08a',
      systemCount: ringConfig(ring).systemsMin,
      nebula: 'NONE', nebulaColor: null,
      radius: 30, morphology: 'SPIRAL', rotation: r() * TAU, armCount: 2 + Math.floor(r() * 3),
      armTightness: 3, bulgeStrength: 1, discThickness: 0.06, axisRatio: 1, brightness: 1,
    };
  }
  if (descriptorCache.size >= DESCRIPTOR_CACHE_CAP) {
    const first = descriptorCache.keys().next().value;
    if (first !== undefined) descriptorCache.delete(first);
  }
  descriptorCache.set(galaxyId, g);
  return g;
}

/** Systems of a descriptor (the ONE placement path — `systemAt` and sweeps share it). */
export function systemAtInGalaxy(g: GalaxyDescriptor, systemId: number): SystemDescriptor {
  const seed = hash32(g.seed, 'system', systemId);
  const r = rng(seed);
  const place = placeSystem(g, r);
  const designation = SYSTEM_DESIGNATIONS[Math.floor(r() * SYSTEM_DESIGNATIONS.length)];
  return {
    ring: g.ring,
    galaxyId: g.galaxyId,
    systemId,
    seed,
    // UNIQUE within the galaxy (plan §71): 180-750 systems share only 8 designations,
    // so the catalog number rides along — two systems can never be "LYROS MINOR".
    name: systemId === 0 ? `${g.name} PRIME` : `${g.name} ${designation} ${systemId}`,
    planetCount: 0, // filled by PlanetGenerator via systemPlanetCount()
    ux: place.ux,
    uy: place.uy,
  };
}

export function systemAt(universeSeed: number, ring: number, galaxyId: number, systemId: number, systemCount = 200): SystemDescriptor {
  void systemCount; // counts are baked into the descriptor; kept for caller compatibility
  const g = descriptorFor(universeSeed, ring, galaxyId);
  return systemAtInGalaxy(g, systemId);
}

/** Planets per system: the RING CONFIG's own range (plan §12) — never a fixed 1..12. */
export function systemPlanetCount(universeSeed: number, ring: number, galaxyId: number, systemId: number): number {
  const cfg = ringConfig(ring);
  const r = rng(hash32(universeSeed >>> 0, 'planets', ring, galaxyId, systemId));
  const min = Math.max(1, cfg.planetsMin);
  const max = Math.max(min, cfg.planetsMax);
  return min + Math.floor(r() * (max - min + 1));
}

/** All systems of a galaxy. */
export function systemsInGalaxy(universeSeed: number, ring: number, galaxyId: number, systemCount: number): SystemDescriptor[] {
  const g = descriptorFor(universeSeed, ring, galaxyId);
  const out: SystemDescriptor[] = [];
  const count = Math.max(1, systemCount);
  for (let s = 0; s < count; s++) out.push(systemAtInGalaxy(g, s));
  return out;
}

/** Morphology of a galaxy id, for debug overlays (plan §39). */
export function morphologyOf(universeSeed: number, ring: number, galaxyId: number): GalaxyMorphology {
  return descriptorFor(universeSeed, ring, galaxyId).morphology;
}
