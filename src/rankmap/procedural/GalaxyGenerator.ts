// NECROFALL — galaxy generation (plan §7/§54/§73). Pure + deterministic:
// `galaxyAt(seed, gx, gy)` always returns the same descriptor, and 91% of
// coordinates return null (the void between galaxies — density per ring).
import { GalaxyDescriptor, GalaxyMorphology, GALAXY_PREFIXES, GALAXY_SUFFIXES, NEBULA_COLORS, NebulaType, POI_LABELS, STAR_COLORS, StarType } from './GalaxyTypes';
import { ringConfig } from './RankRingConfig';
import { encodeGalaxyId, hash32, MAX_RING_RADIUS, ringOfGalaxy, rng } from './SeedHash';

/** Weighted star table, biased by ring (rare stars only show up in deep rings). */
function pickStarType(rand: number, ring: number, exoticRoll: number, exotic: number): StarType {
  const exoticStar = exoticRoll < exotic;
  if (exoticStar) return ring >= 4 ? 'EXOTIC' : ring >= 2 ? 'NEUTRON' : 'BINARY';
  if (rand < 0.22) return 'RED_DWARF';
  if (rand < 0.42) return 'ORANGE';
  if (rand < 0.6) return 'YELLOW';
  if (rand < 0.72) return 'WHITE';
  if (rand < 0.84) return 'BLUE';
  if (rand < 0.92) return 'BINARY';
  return 'TRINARY';
}

const NEBULAS: NebulaType[] = ['NONE', 'NONE', 'NONE', 'CRIMSON', 'VIOLET', 'TOXIC', 'ELECTRIC', 'DARK', 'GOLDEN'];

/**
 * MORPHOLOGY ROLL (plan §4). Deep rings skew irregular/elliptical (old, disrupted
 * space) while the inner rings host the classic spirals; every band can still roll
 * any kind, so "a barred spiral in the void" remains possible.
 */
function pickMorphology(rand: number, ring: number): GalaxyMorphology {
  const v = rand * 100;
  const spiralBias = ring <= 2 ? 12 : ring <= 5 ? 0 : -8;
  // SPIRAL | BARRED | ELLIPTICAL | IRREGULAR | RING | FLOCCULENT
  const cuts: [number, GalaxyMorphology][] = [
    [28 + spiralBias, 'SPIRAL'],
    [46 + spiralBias, 'BARRED_SPIRAL'],
    [61 - spiralBias * 0.5, 'ELLIPTICAL'],
    [76 + (ring >= 4 ? 8 : 0), 'IRREGULAR'],
    [86, 'RING'],
    [100, 'FLOCCULENT'],
  ];
  for (const [limit, morph] of cuts) {
    if (v < limit) return morph;
  }
  return 'FLOCCULENT';
}

export function galaxyName(seed: number): string {
  const r = rng(hash32(seed, 'name'));
  const prefix = GALAXY_PREFIXES[Math.floor(r() * GALAXY_PREFIXES.length)];
  const suffix = GALAXY_SUFFIXES[Math.floor(r() * GALAXY_SUFFIXES.length)];
  return `${prefix}${suffix}`;
}

/** Deterministic existence + descriptor. null = empty space at this coordinate. */
export function galaxyAt(universeSeed: number, gx: number, gy: number): GalaxyDescriptor | null {
  // THE RANKED UNIVERSE ENDS AT KING OF GODS' OUTER EDGE (user 2026-09-29): nothing is
  // generated past the last band — no galaxies, no systems, no hits. The void beyond is
  // simply empty (and the field sweep stops paying for it).
  if (gx * gx + gy * gy > MAX_RING_RADIUS * MAX_RING_RADIUS) return null;
  const ring = ringOfGalaxy(gx, gy);
  const cfg = ringConfig(ring);
  const seed = hash32(universeSeed >>> 0, 'galaxy', ring, gx, gy);
  const r = rng(seed);
  if (r() > cfg.density) return null;
  const starRand = r();
  const exoticRoll = r();
  const starType = pickStarType(starRand, ring, exoticRoll, cfg.exotic);
  const nebula = NEBULAS[Math.floor(r() * NEBULAS.length)];
  const systemCount = cfg.systemsMin + Math.floor(r() * (cfg.systemsMax - cfg.systemsMin + 1));
  const poiRoll = r();
  let poi: GalaxyDescriptor['poi'] = 'NORMAL';
  if (poiRoll < 0.04) poi = 'DEAD';
  else if (poiRoll < 0.08) poi = 'CORRUPTED';
  else if (poiRoll < 0.11) poi = 'SWARM';
  else if (poiRoll < 0.14) poi = 'STRONGHOLD';
  else if (poiRoll < 0.18) poi = 'DISCOVERY';
  else if (nebula !== 'NONE') poi = 'NEBULA';

  // ---- morphology (plan §4): every structural property is rolled HERE and read by the
  // sprite generator, the system distribution and the debug overlays alike.
  const morphology = pickMorphology(r(), ring);
  const rotation = r() * Math.PI * 2;
  const armCount = morphology === 'SPIRAL' || morphology === 'BARRED_SPIRAL'
    ? 2 + Math.floor(r() * 3)
    : morphology === 'FLOCCULENT'
      ? 4 + Math.floor(r() * 3)
      : 0;
  const armTightness = 2.1 + r() * 2.6;
  const bulgeStrength = morphology === 'ELLIPTICAL' ? 1.05 + r() * 0.9
    : morphology === 'IRREGULAR' ? 0.35 + r() * 0.5
      : morphology === 'RING' ? 0.3 + r() * 0.35
        : 0.85 + r() * 0.6;
  const discThickness = morphology === 'IRREGULAR' ? 0.12 + r() * 0.2 : 0.03 + r() * 0.09;
  const axisRatio = morphology === 'ELLIPTICAL'
    ? 1.5 + r() * 1.7
    : morphology === 'IRREGULAR'
      ? 1 + r() * 0.6
      : 1 + r() * 0.25;
  const brightness = 0.62 + r() * 0.66;

  return {
    ring,
    gx,
    gy,
    galaxyId: encodeGalaxyId(gx, gy),
    seed,
    name: galaxyName(seed),
    starType,
    starColor: STAR_COLORS[starType],
    systemCount,
    nebula,
    nebulaColor: nebula === 'NONE' ? null : NEBULA_COLORS[nebula],
    poi,
    poiLabel: POI_LABELS[poi],
    radius: 26 + Math.min(16, systemCount) + (r() * 8 - 4),
    morphology,
    rotation,
    armCount,
    armTightness,
    bulgeStrength,
    discThickness,
    axisRatio,
    brightness,
  };
}
