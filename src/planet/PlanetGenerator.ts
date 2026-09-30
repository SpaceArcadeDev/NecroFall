// NECROFALL — PlanetGenerator (plan §4, §101): the ONE planet adapter of the environment layer.
//
//   PlanetGenerator
//        ├── PlanetSurface     (CPU query API — sample())
//        ├── PlanetBiomes      (per-class environment profiles)
//        ├── PlanetSurfaceData (packed terrain channels for shaders/instances)
//        └── PlanetSeed        (deterministic seeded RNG streams)
//
// It wraps — it does NOT replace — the game's deterministic generation (TerrainGenerator /
// BiomeGenerator). Everything the environment queries (height, slope, moisture, corruption,
// vegetation, biome) comes through here or through the `TerrainSurface` it exposes, so no
// system can quietly invent its own terrain.
import * as THREE from 'three/webgpu';
import { clamp } from '../utils/Utils';
import { createTerrainSurface, type TerrainSurface } from '../world/TerrainSurface';
import { PlanetSurface, type SurfaceSample } from '../rendering/Environment/PlanetSurface';
import { BIOME_IDS, DEFAULT_BIOME, createRadioactiveBiome, type PlanetBiome } from './PlanetBiomes';
import { normalisePlanetSeed, planetRand } from './PlanetSeed';
import { packTerrainData, unpackTerrainData, type TerrainSampleChannels } from './PlanetSurfaceData';
import type { Rand } from '../utils/Utils';
import type { BiomeClass } from '../world/PlanetArchetypes';
import type { TerrainDataTuple } from '../world/vegetation/VegetationTypes';

/** The Planet shape the adapter needs (structural — Planet stays free to evolve). */
export interface PlanetGeneratorSource {
  readonly radius: number;
  readonly waterLevel: number;
  readonly seed: number;
  readonly reliefMin: number;
  readonly reliefMax: number;
  heightAtDir(x: number, y: number, z: number): number;
  meshHeightAtDir?(x: number, y: number, z: number): number;
  terrainNormalAt(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  slopeAt(p: THREE.Vector3): number;
  waterAtDir?(x: number, y: number, z: number): number;
  terrain: {
    moistureAt(x: number, y: number, z: number): number;
    corruptionAt(x: number, y: number, z: number): number;
  };
  biome: {
    plantDensityAt(x: number, y: number, z: number): number;
    biomeAt?(x: number, y: number, z: number): BiomeClass;
    colorAt(x: number, y: number, z: number, h: number, slope: number, out: THREE.Color, scratch: THREE.Color): void;
  };
}

export class PlanetGenerator {
  /** The ONE terrain query API (plan §11) — world systems sample through this. */
  readonly surface: PlanetSurface;
  /** The shared terrain adapter the simulation already uses; the same data, one source. */
  readonly terrainSurface: TerrainSurface;
  readonly seed: number;

  private readonly channels: TerrainSampleChannels = { slope: 0, height01: 0, moisture: 0, corruption: 0 };

  constructor(
    private readonly planet: PlanetGeneratorSource,
    terrainSurface?: TerrainSurface,
  ) {
    this.terrainSurface = terrainSurface ?? createTerrainSurface(planet);
    this.seed = normalisePlanetSeed(planet.seed);
    this.surface = new PlanetSurface({
      surface: this.terrainSurface,
      biomeAt: planet.biome.biomeAt ? (x, y, z) => BIOME_IDS[planet.biome.biomeAt!(x, y, z)] ?? 0 : undefined,
      moistureAt: (x, y, z) => planet.terrain.moistureAt(x, y, z),
      corruptionAt: (x, y, z) => planet.terrain.corruptionAt(x, y, z),
    });
  }

  get radius(): number {
    return this.planet.radius;
  }

  get waterLevel(): number {
    return this.planet.waterLevel;
  }

  get reliefMin(): number {
    return this.planet.reliefMin;
  }

  get reliefMax(): number {
    return this.planet.reliefMax;
  }

  /** A seeded RNG stream for one environment sub-system (pure function of the planet seed). */
  rand(salt: number): Rand {
    return planetRand(this.seed, salt);
  }

  /** The relief band position 0..1 of a direction (shader `height01` channel). */
  height01At(direction: THREE.Vector3): number {
    const height = this.planet.heightAtDir(direction.x, direction.y, direction.z);
    return clamp((height - this.planet.reliefMin) / Math.max(1e-3, this.planet.reliefMax - this.planet.reliefMin), 0, 1);
  }

  /** The packed shader lanes (plan §63/§64) at a direction: slope, height01, moisture, corruption. */
  terrainTupleAt(direction: THREE.Vector3, out?: TerrainDataTuple): TerrainDataTuple {
    const tuple: TerrainDataTuple = out ?? [0, 0, 0, 0];
    this.channels.slope = this.terrainSurface.slopeAtDir(direction.x, direction.y, direction.z);
    this.terrainSurface; // (kept for clarity: all fields read the one surface)
    this.channels.height01 = this.height01At(direction);
    this.channels.moisture = clamp(this.planet.terrain.moistureAt(direction.x, direction.y, direction.z), 0, 1);
    this.channels.corruption = clamp(this.planet.terrain.corruptionAt(direction.x, direction.y, direction.z), 0, 1);
    const packed = packTerrainData(this.channels);
    tuple[0] = packed[0];
    tuple[1] = packed[1];
    tuple[2] = packed[2];
    tuple[3] = packed[3];
    return tuple;
  }

  /** Unpack a tuple back into named channels (debug / tools). */
  channelsOf(tuple: TerrainDataTuple): TerrainSampleChannels {
    return unpackTerrainData(tuple, this.channels);
  }

  /**
   * The biome profile of a direction. The classified biome drives the density multipliers; a
   * planet may later tilt its own profile (radioactive look) per archetype.
   */
  biomeProfileAt(direction: THREE.Vector3): PlanetBiome {
    const biomeAt = this.planet.biome.biomeAt;
    if (!biomeAt) return DEFAULT_BIOME;
    const cls = biomeAt(direction.x, direction.y, direction.z);
    return biomeProfileForClass(cls);
  }

  /** One full surface sample through the ONE query API (plan §11). */
  sample(direction: THREE.Vector3, out?: SurfaceSample): SurfaceSample {
    return this.surface.sample(direction, out);
  }
}

const PROFILE_CACHE = new Map<BiomeClass, PlanetBiome>();

/** Cached per-class profiles — every direction of one biome shares one instance. */
export function biomeProfileForClass(cls: BiomeClass): PlanetBiome {
  let profile = PROFILE_CACHE.get(cls);
  if (profile) return profile;

  profile = createRadioactiveBiome(BIOME_IDS[cls] ?? 0);
  switch (cls) {
    case 'TOXIC':
    case 'CORRUPTED':
      profile.radiation = 1;
      profile.crystalDensity = 0.35;
      profile.wetness = 0.35;
      break;
    case 'OCEAN':
    case 'ABYSSAL':
      profile.wetness = 1;
      profile.grassDensity = 0.2;
      profile.treeDensity = 0.05;
      break;
    case 'DESERT':
      profile.grassDensity = 0.25;
      profile.bushDensity = 0.1;
      profile.treeDensity = 0.05;
      profile.wetness = 0.05;
      profile.radiation = 0.2;
      break;
    case 'FROZEN':
      profile.grassDensity = 0.2;
      profile.wetness = 0.4;
      profile.radiation = 0.25;
      break;
    case 'VOLCANIC':
      profile.grassDensity = 0.15;
      profile.treeDensity = 0;
      profile.radiation = 0.7;
      break;
    case 'JUNGLE':
      profile.grassDensity = 1;
      profile.treeDensity = 0.4;
      profile.bushDensity = 0.6;
      profile.radiation = 0.4;
      break;
    case 'FUNGAL':
      profile.grassDensity = 0.8;
      profile.radiation = 0.6;
      break;
    default:
      break;
  }
  PROFILE_CACHE.set(cls, profile);
  return profile;
}
