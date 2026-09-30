// NECROFALL — PlanetBiomes (plan §59): the minimal biome structure the environment reads.
//
// The game's own `BiomeGenerator` classifies every direction into a numeric biome class; this
// module gives each class its ENVIRONMENT profile — the density multipliers and the radioactive
// look — so grass, bushes, trees, rocks, spikes and crystals all agree about where they live.
// The colours fall back to the radioactive palette (plan §10); a planet archetype may override
// them through its own art direction.
import * as THREE from 'three/webgpu';
import { RADIOACTIVE_PALETTE } from '../rendering/materials/PlanetPalette';
import type { BiomeClass } from '../world/PlanetArchetypes';

/** Stable numeric ids for the string biome classes (the sample contract carries numbers). */
export const BIOME_IDS: Record<BiomeClass, number> = {
  TOXIC: 1,
  OCEAN: 2,
  DESERT: 3,
  FUNGAL: 4,
  VOLCANIC: 5,
  FROZEN: 6,
  CRYSTAL: 7,
  SWAMP: 8,
  CORRUPTED: 9,
  DEAD: 10,
  JUNGLE: 11,
  ABYSSAL: 12,
};

export interface PlanetBiome {
  id: number;

  groundColor: THREE.Color;
  grassColor: THREE.Color;

  grassDensity: number;

  bushDensity: number;
  treeDensity: number;
  rockDensity: number;
  crystalDensity: number;

  /** 0..1 contamination the biome carries. */
  radiation: number;
  /** 0..1 standing-water tendency. */
  wetness: number;
}

/** Fresh profile instances — callers may tweak their copy without cross-talk. */
export function createRadioactiveBiome(id: number): PlanetBiome {
  return {
    id,
    groundColor: new THREE.Color(RADIOACTIVE_PALETTE.soil),
    grassColor: new THREE.Color(RADIOACTIVE_PALETTE.grassLight),
    grassDensity: 0.85,
    bushDensity: 0.4,
    treeDensity: 0.18,
    rockDensity: 0.45,
    crystalDensity: 0.25,
    radiation: 1,
    wetness: 0.15,
  };
}

/**
 * The default density profile for an unclassified direction. The generators' own fields
 * (plant density, moisture, corruption) remain the primary source; this is the biome FLOOR so a
 * biome can never be silently empty.
 */
export const DEFAULT_BIOME: PlanetBiome = {
  id: 0,
  groundColor: new THREE.Color(RADIOACTIVE_PALETTE.soilDark),
  grassColor: new THREE.Color(RADIOACTIVE_PALETTE.grass),
  grassDensity: 0.6,
  bushDensity: 0.3,
  treeDensity: 0.15,
  rockDensity: 0.35,
  crystalDensity: 0.15,
  radiation: 0.4,
  wetness: 0.2,
};
