/**
 * NECROFALL — biome profiles (plan §59/§58).
 *
 * A minimal numeric profile per biome: what grows there, how radioactive and
 * how wet it reads. The dramatic terrain colour comes from the shared folio
 * gradient; these profiles only steer DENSITIES and accents.
 */
import type { BiomeClass } from '../world/PlanetArchetypes';

export interface PlanetBiomeProfile {
  grassDensity: number;
  bushDensity: number;
  treeDensity: number;
  rockDensity: number;
  crystalDensity: number;
  spikeDensity: number;
  radiation: number;
  wetness: number;
}

const DEFAULT_PROFILE: PlanetBiomeProfile = {
  grassDensity: 0.65,
  bushDensity: 0.5,
  treeDensity: 0.35,
  rockDensity: 0.6,
  crystalDensity: 0.35,
  spikeDensity: 0.3,
  radiation: 0.5,
  wetness: 0.3,
};

/** The contaminated heartland: the plan §59 "radioactiveBiome". */
export const RADIOACTIVE_PROFILE: PlanetBiomeProfile = {
  grassDensity: 0.85,
  bushDensity: 0.4,
  treeDensity: 0.18,
  rockDensity: 0.45,
  crystalDensity: 0.25,
  spikeDensity: 0.45,
  radiation: 1,
  wetness: 0.15,
};

const PROFILES: Record<string, PlanetBiomeProfile> = {
  TOXIC: { grassDensity: 0.7, bushDensity: 0.55, treeDensity: 0.2, rockDensity: 0.5, crystalDensity: 0.5, spikeDensity: 0.5, radiation: 1, wetness: 0.45 },
  CORRUPTED: { grassDensity: 0.75, bushDensity: 0.45, treeDensity: 0.28, rockDensity: 0.55, crystalDensity: 0.45, spikeDensity: 0.4, radiation: 1, wetness: 0.3 },
  FUNGAL: { grassDensity: 0.9, bushDensity: 0.6, treeDensity: 0.3, rockDensity: 0.4, crystalDensity: 0.35, spikeDensity: 0.3, radiation: 0.7, wetness: 0.5 },
  JUNGLE: { grassDensity: 1, bushDensity: 0.7, treeDensity: 0.5, rockDensity: 0.35, crystalDensity: 0.15, spikeDensity: 0.15, radiation: 0.35, wetness: 0.45 },
  SWAMP: { grassDensity: 0.9, bushDensity: 0.6, treeDensity: 0.35, rockDensity: 0.35, crystalDensity: 0.2, spikeDensity: 0.2, radiation: 0.55, wetness: 0.75 },
  DESERT: { grassDensity: 0.35, bushDensity: 0.2, treeDensity: 0.08, rockDensity: 0.8, crystalDensity: 0.25, spikeDensity: 0.35, radiation: 0.3, wetness: 0.06 },
  VOLCANIC: { grassDensity: 0.3, bushDensity: 0.15, treeDensity: 0.05, rockDensity: 0.9, crystalDensity: 0.4, spikeDensity: 0.6, radiation: 0.85, wetness: 0.08 },
  FROZEN: { grassDensity: 0.45, bushDensity: 0.25, treeDensity: 0.15, rockDensity: 0.7, crystalDensity: 0.45, spikeDensity: 0.3, radiation: 0.3, wetness: 0.2 },
  OCEANIC: { grassDensity: 0.8, bushDensity: 0.5, treeDensity: 0.3, rockDensity: 0.4, crystalDensity: 0.2, spikeDensity: 0.2, radiation: 0.45, wetness: 0.85 },
  CRYSTAL: { grassDensity: 0.5, bushDensity: 0.3, treeDensity: 0.12, rockDensity: 0.7, crystalDensity: 0.85, spikeDensity: 0.4, radiation: 0.7, wetness: 0.15 },
  DEAD: { grassDensity: 0.2, bushDensity: 0.1, treeDensity: 0.03, rockDensity: 0.9, crystalDensity: 0.2, spikeDensity: 0.5, radiation: 0.5, wetness: 0.05 },
};

export function biomeProfileOf(biome: BiomeClass | string): PlanetBiomeProfile {
  return PROFILES[biome as string] ?? DEFAULT_PROFILE;
}
