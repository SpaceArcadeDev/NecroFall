/**
 * NECROFALL — planet generator adapter (plan §101 spine).
 *
 * Wraps NecroFall's deterministic gameplay terrain (`TerrainGenerator` +
 * `BiomeGenerator`, shared with matchmaking — the same seed always builds the
 * same world) behind ONE query API. EVERYTHING — grass density, water, rocks,
 * crystals, particles, physics — reads the estimates below; nothing else
 * invents its own terrain (plan §0).
 */
import * as THREE from 'three/webgpu';
import { clamp, fbm, smoothstep } from '../utils/Utils';
import { TerrainGenerator } from '../world/TerrainGenerator';
import { BiomeGenerator } from '../world/BiomeGenerator';
import type { BiomeClass, PlanetArchetype } from '../world/PlanetArchetypes';
import { mulberry32, type PlanetSpec } from './PlanetSeed';
import { biomeProfileOf, type PlanetBiomeProfile } from './PlanetBiomes';

export class PlanetGenerator {
  readonly terrain: TerrainGenerator;
  readonly biomes: BiomeGenerator;
  readonly archetype: PlanetArchetype;
  readonly profile: PlanetBiomeProfile;
  readonly radius: number;
  readonly seed: number;
  readonly ring: number;

  constructor(spec: PlanetSpec) {
    this.seed = spec.seed;
    this.ring = spec.ring;
    this.radius = spec.radius;
    // The focus direction must flow into the SAME TerrainGenerator the game's Planet facade
    // builds, or the baked/visual terrain would drift from the analytic gameplay field.
    this.terrain = spec.focusDir
      ? new TerrainGenerator(spec.seed, spec.radius, undefined, spec.ring, spec.focusDir as any)
      : new TerrainGenerator(spec.seed, spec.radius, undefined, spec.ring);
    this.biomes = new BiomeGenerator(this.terrain.archetype, this.terrain);
    this.archetype = this.terrain.archetype;
    this.profile = biomeProfileOf(this.archetype.biome);
  }

  /** Terrain radius (centre → surface, metres) along a unit direction. */
  radiusAt(x: number, y: number, z: number): number {
    return this.terrain.sample(x, y, z);
  }

  heightAt(x: number, y: number, z: number): number {
    return this.terrain.sample(x, y, z) - this.radius;
  }

  // ------------------------------------------------------------ shared estimates
  //
  // Both the texture bake and the runtime CPU queries call THESE — the two
  // sides can never disagree about the world (plan §12: one source of truth).

  /** 0..1 vegetation density — patches, moisture, slope and archetype rolled into one channel. */
  grassEstimate(x: number, y: number, z: number, slope: number): number {
    const moisture = this.terrain.moistureAt(x, y, z);
    const patch = fbm(x * 7.3 + 31.7, y * 7.3 + 5.3, z * 7.3 + 11.1, 2, (this.seed + 991) >>> 0);
    const grove = smoothstep(0.36, 0.62, patch);
    const slopeFactor = 1 - smoothstep(0.45, 0.95, slope);
    const base = (0.3 + moisture * 0.85) * this.archetype.plantDensity * (0.25 + patch * 1.1);
    return clamp(base * (0.35 + grove * 0.9) * slopeFactor, 0, 1);
  }

  /** 0..1 — wet ground and shallow basins; `waterLevel` is a radius in metres. */
  wetnessEstimate(x: number, y: number, z: number, height: number, waterLevel: number): number {
    const moisture = this.terrain.moistureAt(x, y, z);
    const below = smoothstep(waterLevel + 1.8 - this.radius, waterLevel - 1.2 - this.radius, height);
    return clamp(moisture * 0.45 + below * 0.8, 0, 1);
  }

  /** 0..1 contamination — corruption field + low-ground vein wash + archetype. */
  radiationEstimate(x: number, y: number, z: number, height: number, waterLevel: number): number {
    const corruption = this.terrain.corruptionAt(x, y, z);
    const lowWash = smoothstep(waterLevel + 4 - this.radius, waterLevel - 2 - this.radius, height) * 0.18;
    return clamp(corruption * 0.92 + lowWash + this.archetype.veinStrength * 0.12, 0, 1);
  }

  rockEstimate(slope: number): number {
    return smoothstep(0.32, 0.78, slope);
  }

  biomeWeightEstimate(x: number, y: number, z: number): number {
    const corruption = this.terrain.corruptionAt(x, y, z);
    const moisture = this.terrain.moistureAt(x, y, z);
    return clamp(corruption * 1.2 + (moisture - 0.5) * 0.25, 0, 1);
  }

  /** Named biome (gameplay-side classification; the texture keeps numbers). */
  biomeClassAt(x: number, y: number, z: number): BiomeClass {
    return this.biomes.biomeAt(x, y, z);
  }

  plantDensityAt(x: number, y: number, z: number): number {
    return this.biomes.plantDensityAt(x, y, z);
  }

  /** Deterministic per-planet RNG factory: `rand(3)` is always the same stream. */
  rand(salt: number): () => number {
    return mulberry32((this.seed ^ Math.imul(salt + 1, 2654435761)) >>> 0);
  }

  /** Gradient stops for the folio terrain ramp, from the archetype palette. */
  gradientStops(): [number, string][] {
    const p = this.archetype.palette;
    return [
      [0, hex(p.deep)],
      [0.26, hex(p.low)],
      [0.5, hex(p.mid)],
      [0.74, hex(p.ridge)],
      [1, hex(p.peak)],
    ];
  }
}

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}
