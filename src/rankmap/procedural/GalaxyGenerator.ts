// NECROFALL — galaxy generation (plan §7/§54/§73). Pure + deterministic:
// `galaxyAt(seed, gx, gy)` always returns the same descriptor, and 91% of
// coordinates return null (the void between galaxies — density per ring).
import { GalaxyDescriptor, GALAXY_PREFIXES, GALAXY_SUFFIXES, NEBULA_COLORS, NebulaType, POI_LABELS, STAR_COLORS, StarType } from './GalaxyTypes';
import { ringConfig } from './RankRingConfig';
import { encodeGalaxyId, hash32, ringOfGalaxy, rng } from './SeedHash';

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

export function galaxyName(seed: number): string {
  const r = rng(hash32(seed, 'name'));
  const prefix = GALAXY_PREFIXES[Math.floor(r() * GALAXY_PREFIXES.length)];
  const suffix = GALAXY_SUFFIXES[Math.floor(r() * GALAXY_SUFFIXES.length)];
  return `${prefix}${suffix}`;
}

/** Deterministic existence + descriptor. null = empty space at this coordinate. */
export function galaxyAt(universeSeed: number, gx: number, gy: number): GalaxyDescriptor | null {
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
  };
}
