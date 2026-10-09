// NECROFALL — planet generation (plan §9/§12/§13/§28). The BIOME CLASSIFIER is
// shared with the match world (`world/PlanetArchetypes.deriveClimate` +
// `classifyBiomeClass`), so the biome a player reads on the galactic map is the
// biome they actually land on — same seed, same world.
import { BOSS_ARCHETYPES, BIOME_COLORS, BIOME_LABELS, Biome, ECOLOGY_LABELS, Ecology, PlanetDescriptor } from './GalaxyTypes';
import { hash32, planetKey, planetSeed, rng } from './SeedHash';
import { systemAt } from './SolarSystemGenerator';
import { classifyBiomeClass, deriveClimate } from '../../world/PlanetArchetypes';

function classifyEcology(rand: () => number, biome: Biome): Ecology {
  if (biome === 'TOXIC' || biome === 'FUNGAL' || biome === 'CORRUPTED') return rand() < 0.6 ? 'TOXIC_SWARM' : 'BURROW_COLONY';
  if (biome === 'CRYSTAL' || biome === 'FROZEN') return rand() < 0.5 ? 'CRYSTAL_GRAZERS' : 'AMBUSH_PACK';
  if (biome === 'DEAD' || biome === 'ABYSSAL') return rand() < 0.5 ? 'VOID_STALKERS' : 'BURROW_COLONY';
  if (biome === 'JUNGLE' || biome === 'SWAMP') return rand() < 0.55 ? 'AMBUSH_PACK' : 'TOXIC_SWARM';
  return rand() < 0.45 ? 'FERAL_HERD' : 'AMBUSH_PACK';
}

/**
 * One planet. `orbit`/`orbitRadius` are map-space (unit disc around the star)
 * so the system view can animate real orbits. Climate comes from the SHARED
 * pipeline so the world matches the map exactly.
 */
export function planetAt(universeSeed: number, ring: number, galaxyId: number, systemId: number, planetId: number): PlanetDescriptor {
  const seed = planetSeed(universeSeed, ring, galaxyId, systemId, planetId);
  const r = rng(seed);
  const climate = deriveClimate(seed, ring);
  const temperature = climate.temperature;
  const moisture = climate.moisture;
  const corruption = climate.corruption;
  const biome = climate.biome;
  const ecology = classifyEcology(r, biome);
  const system = systemAt(universeSeed, ring, galaxyId, systemId);
  const base = system.name.split(' ')[0];
  const difficulty = Math.min(1, (ring + 1) / 8 + r() * 0.12);
  return {
    ring,
    galaxyId,
    systemId,
    planetId,
    key: planetKey(ring, galaxyId, systemId, planetId),
    seed,
    name: `${base}-${planetId + 1}`,
    biome,
    biomeLabel: BIOME_LABELS[biome],
    biomeColor: BIOME_COLORS[biome],
    radius: 0.7 + r() * 0.9,
    temperature,
    gravity: 0.55 + r() * 0.9,
    corruption,
    ecology,
    ecologyLabel: ECOLOGY_LABELS[ecology],
    boss: BOSS_ARCHETYPES[Math.floor(r() * BOSS_ARCHETYPES.length)],
    difficulty,
    orbit: r() * Math.PI * 2,
    orbitRadius: 0.24 + planetId * 0.062,
  };
}
