// NECROFALL — PLANET ARCHETYPES (plan §11/§13/§63). The pipeline's first step: one seed
// becomes a named world archetype with its own climate, relief parameters, palette and sky.
//
// This module is the SINGLE SOURCE of the climate draw order — the ranked map's
// `PlanetGenerator` and the match world's `Planet` both call `deriveClimate(seed, ring)`, so
// the biome shown on the map is the biome you actually land on.
import { Rand, clamp } from '../utils/Utils';

/** Biome classes — the same vocabulary the galactic map uses (plan §8/§13). */
export type BiomeClass =
  | 'TOXIC' | 'OCEAN' | 'DESERT' | 'FUNGAL' | 'VOLCANIC' | 'FROZEN'
  | 'CRYSTAL' | 'SWAMP' | 'CORRUPTED' | 'DEAD' | 'JUNGLE' | 'ABYSSAL';

export interface PlanetClimate {
  temperature: number; // 0..1
  moisture: number; // 0..1
  corruption: number; // 0..1
  biome: BiomeClass;
}

export interface PlanetPalette {
  deep: number;
  low: number;
  mid: number;
  ridge: number;
  peak: number;
  vein: number;
}

export interface PlanetSky {
  zenith: number;
  horizon: number;
  nebula: number;
  fog: number;
}

export interface PlanetArchetype {
  id: string;
  biome: BiomeClass;
  climate: PlanetClimate;
  /** -1 pulls the continental mask into deep basins, +1 raises it into continents. */
  continentBias: number;
  /** Belt power of the mountain-chain generator (0..1.4). */
  mountainPower: number;
  /** Ridged-noise sharpness exponent (2.2 soft .. 3.4 spiky). */
  ridgeSharpness: number;
  /** Canyon carving depth in metres. */
  canyonDepth: number;
  /** Plateau lift in metres. */
  plateauLift: number;
  /** Detail roughness multiplier (0.6 smooth .. 1.6 jagged). */
  roughness: number;
  /** Broad valleys along great circles (count, depth m). */
  valleyCount: number;
  valleyDepth: number;
  /** Rivers (count, width radians, depth m). */
  riverCount: number;
  riverWidth: number;
  riverDepth: number;
  /** Crater fields (count, radius rad, depth m). */
  craterCount: number;
  craterDepth: number;
  /** Sinkholes (count, radius rad, depth m). */
  sinkholeCount: number;
  palette: PlanetPalette;
  sky: PlanetSky;
  /** Toxic pool / necrotic vein strength written onto low ground (0..1). */
  veinStrength: number;
  /** Base vegetation density multiplier (plan §11 vegetation step). */
  plantDensity: number;
}

interface ArchetypeTemplate {
  continentBias: number;
  mountainPower: number;
  ridgeSharpness: number;
  canyonDepth: number;
  plateauLift: number;
  roughness: number;
  valleyCount: number;
  valleyDepth: number;
  riverCount: number;
  riverWidth: number;
  riverDepth: number;
  craterCount: number;
  craterDepth: number;
  sinkholeCount: number;
  palette: PlanetPalette;
  sky: PlanetSky;
  veinStrength: number;
  plantDensity: number;
}

const T = (o: Partial<ArchetypeTemplate>): ArchetypeTemplate => ({
  continentBias: 0,
  mountainPower: 1,
  ridgeSharpness: 2.7,
  canyonDepth: 7.5,
  plateauLift: 2.6,
  roughness: 1,
  valleyCount: 2,
  valleyDepth: 4,
  riverCount: 2,
  riverWidth: 0.022,
  riverDepth: 2.6,
  craterCount: 0,
  craterDepth: 5,
  sinkholeCount: 0,
  palette: { deep: 0x1d1a35, low: 0x2d3a56, mid: 0x4c566f, ridge: 0x848da3, peak: 0xe2e7ef, vein: 0x8b4dff },
  sky: { zenith: 0x120b26, horizon: 0x3b2160, nebula: 0x6d3ec8, fog: 0x171029 },
  veinStrength: 0.5,
  plantDensity: 1,
  ...o,
});

/** Per-biome looks. Numbers keep the shipped field's proportions so the game still reads. */
export const ARCHETYPES: Record<BiomeClass, ArchetypeTemplate> = {
  TOXIC: T({
    continentBias: -0.3, mountainPower: 0.7, canyonDepth: 6, roughness: 0.9,
    riverCount: 3, riverWidth: 0.03, riverDepth: 3.4, sinkholeCount: 3,
    palette: { deep: 0x101c14, low: 0x1c3a22, mid: 0x3f6b31, ridge: 0x86a44e, peak: 0xd9e8a8, vein: 0x9dff4d },
    sky: { zenith: 0x0c1a10, horizon: 0x2c4a1e, nebula: 0x6dff5e, fog: 0x15240f },
    veinStrength: 0.9, plantDensity: 1.25,
  }),
  OCEAN: T({
    continentBias: -0.55, mountainPower: 0.8, plateauLift: 2, canyonDepth: 5,
    riverCount: 0, sinkholeCount: 0,
    palette: { deep: 0x071f33, low: 0x0d3a56, mid: 0x1f6b86, ridge: 0x74b7bd, peak: 0xe6f6f4, vein: 0x3fd7d0 },
    sky: { zenith: 0x071524, horizon: 0x14405e, nebula: 0x3fd7d0, fog: 0x0b1c2b },
    veinStrength: 0.25, plantDensity: 0.6,
  }),
  DESERT: T({
    continentBias: 0.35, mountainPower: 0.55, ridgeSharpness: 2.2, canyonDepth: 8.5,
    roughness: 1.15, riverCount: 0, craterCount: 1, craterDepth: 4,
    palette: { deep: 0x2b2013, low: 0x54401f, mid: 0x8a6b33, ridge: 0xc9a25c, peak: 0xf2e0b6, vein: 0xffcf66 },
    sky: { zenith: 0x241407, horizon: 0x6e4419, nebula: 0xffb347, fog: 0x2a1c0d },
    veinStrength: 0.3, plantDensity: 0.35,
  }),
  FUNGAL: T({
    continentBias: 0.05, mountainPower: 0.75, canyonDepth: 6, riverCount: 3, riverWidth: 0.026,
    sinkholeCount: 4,
    palette: { deep: 0x1a0f2b, low: 0x33194f, mid: 0x5b2f86, ridge: 0xa060d0, peak: 0xf0d4ff, vein: 0xc86bff },
    sky: { zenith: 0x160a26, horizon: 0x4a2470, nebula: 0xc86bff, fog: 0x1d1030 },
    veinStrength: 0.8, plantDensity: 1.5,
  }),
  VOLCANIC: T({
    continentBias: 0.25, mountainPower: 1.35, ridgeSharpness: 3.1, canyonDepth: 10,
    roughness: 1.3, craterCount: 5, craterDepth: 7, sinkholeCount: 2,
    palette: { deep: 0x170b0b, low: 0x3c1410, mid: 0x7c2416, ridge: 0xc75028, peak: 0xffd9a8, vein: 0xff5a2d },
    sky: { zenith: 0x1c0a08, horizon: 0x5e1c0e, nebula: 0xff6a3d, fog: 0x22100a },
    veinStrength: 1, plantDensity: 0.5,
  }),
  FROZEN: T({
    continentBias: 0.1, mountainPower: 1.1, ridgeSharpness: 2.4, canyonDepth: 4.5, plateauLift: 3.4,
    roughness: 0.75, valleyCount: 2, valleyDepth: 5, riverCount: 2, riverWidth: 0.028, riverDepth: 1.6,
    palette: { deep: 0x101a2e, low: 0x2a3f5e, mid: 0x6c86a8, ridge: 0xb9d2ea, peak: 0xffffff, vein: 0x8fe6ff },
    sky: { zenith: 0x0a1024, horizon: 0x27406e, nebula: 0x8fe6ff, fog: 0x101a30 },
    veinStrength: 0.35, plantDensity: 0.45,
  }),
  CRYSTAL: T({
    continentBias: 0.3, mountainPower: 1.2, ridgeSharpness: 3.4, canyonDepth: 9, plateauLift: 3.8,
    roughness: 0.95, craterCount: 2, craterDepth: 4, sinkholeCount: 2,
    palette: { deep: 0x140f2e, low: 0x2a2158, mid: 0x4f46a0, ridge: 0x8f8fe8, peak: 0xf2f4ff, vein: 0x66f0ff },
    sky: { zenith: 0x0d0a26, horizon: 0x2e2a66, nebula: 0x8f8fe8, fog: 0x151138 },
    veinStrength: 0.6, plantDensity: 0.7,
  }),
  SWAMP: T({
    continentBias: -0.2, mountainPower: 0.6, canyonDepth: 5, plateauLift: 1.6, roughness: 0.85,
    riverCount: 4, riverWidth: 0.035, riverDepth: 3.2, sinkholeCount: 2,
    palette: { deep: 0x101a10, low: 0x22391f, mid: 0x41663a, ridge: 0x7d9a5e, peak: 0xd8e6bc, vein: 0x9be36b },
    sky: { zenith: 0x0d170c, horizon: 0x2f4a24, nebula: 0x9be36b, fog: 0x14200f },
    veinStrength: 0.55, plantDensity: 1.35,
  }),
  CORRUPTED: T({
    continentBias: 0, mountainPower: 1.15, canyonDepth: 9, craterCount: 3, craterDepth: 6,
    sinkholeCount: 3,
    palette: { deep: 0x1c0a18, low: 0x421233, mid: 0x7c1e4a, ridge: 0xd14b74, peak: 0xffd0e2, vein: 0xff2d6f },
    sky: { zenith: 0x1a0714, horizon: 0x6a1038, nebula: 0xff2d6f, fog: 0x200a18 },
    veinStrength: 1, plantDensity: 0.9,
  }),
  DEAD: T({
    continentBias: -0.15, mountainPower: 0.5, ridgeSharpness: 2.3, canyonDepth: 7, roughness: 1.05,
    riverCount: 0, craterCount: 6, craterDepth: 6, sinkholeCount: 4,
    palette: { deep: 0x14141c, low: 0x2c2c3a, mid: 0x50505f, ridge: 0x84848f, peak: 0xd8d8e0, vein: 0x9a6bff },
    sky: { zenith: 0x0c0c18, horizon: 0x2c2c48, nebula: 0x6a5a9a, fog: 0x141420 },
    veinStrength: 0.4, plantDensity: 0.25,
  }),
  JUNGLE: T({
    continentBias: 0.15, mountainPower: 0.9, canyonDepth: 6.5, riverCount: 3, riverWidth: 0.03, riverDepth: 3,
    palette: { deep: 0x0f1a10, low: 0x1f3a1c, mid: 0x3d6b30, ridge: 0x74a84e, peak: 0xe0f0c0, vein: 0x58c46b },
    sky: { zenith: 0x0e1a0c, horizon: 0x33561e, nebula: 0x58c46b, fog: 0x14260f },
    veinStrength: 0.45, plantDensity: 1.6,
  }),
  ABYSSAL: T({
    continentBias: -0.6, mountainPower: 0.7, plateauLift: 1.8, canyonDepth: 11, roughness: 0.95,
    valleyCount: 3, valleyDepth: 6, riverCount: 0, sinkholeCount: 5,
    palette: { deep: 0x060a18, low: 0x101c3a, mid: 0x22366b, ridge: 0x3f5a99, peak: 0x9fc0e8, vein: 0x3d5aff },
    sky: { zenith: 0x05070f, horizon: 0x101a3a, nebula: 0x3d5aff, fog: 0x080c18 },
    veinStrength: 0.5, plantDensity: 0.35,
  }),
};

/**
 * The climate classifier (plan §13): elevation/temperature/moisture/corruption collapse into one
 * biome. Pure — the map and the world call it with the same inputs.
 */
export function classifyBiomeClass(temperature: number, moisture: number, corruption: number): BiomeClass {
  if (corruption > 0.72 && temperature > 0.66) return 'VOLCANIC';
  if (corruption > 0.72 && moisture > 0.45) return 'CORRUPTED';
  if (corruption > 0.6) return 'FUNGAL';
  if (temperature < 0.24) return moisture > 0.5 ? 'FROZEN' : 'DEAD';
  if (temperature > 0.8) return moisture < 0.35 ? 'DESERT' : moisture > 0.7 ? 'VOLCANIC' : 'SWAMP';
  if (moisture > 0.78) return temperature > 0.55 ? 'OCEAN' : 'ABYSSAL';
  if (moisture > 0.58) return temperature > 0.6 ? 'JUNGLE' : 'SWAMP';
  if (temperature < 0.4) return 'CRYSTAL';
  if (moisture > 0.42) return 'FUNGAL';
  return temperature > 0.62 ? 'DESERT' : 'DEAD';
}

/**
 * ONE climate draw order for the whole game: temperature, moisture, then corruption with the
 * ring's own pressure folded in (higher rings are more corrupted — plan §6/§29). `ring` is the
 * ranked ring when the caller knows it, 0 otherwise.
 */
export function deriveClimate(seed: number, ring = 0): PlanetClimate {
  const rng = new Rand((seed ^ 0x5f356495) >>> 0);
  const temperature = rng.next();
  const moisture = rng.next();
  const corruption = clamp(rng.next() * (0.45 + ring * 0.08) + ring * 0.02, 0, 1);
  return { temperature, moisture, corruption, biome: classifyBiomeClass(temperature, moisture, corruption) };
}

/** Seed → full archetype (pipeline step 1; plan §11). */
export function deriveArchetype(seed: number, ring = 0): PlanetArchetype {
  const rng = new Rand((seed ^ 0x1d872b41) >>> 0);
  const climate = deriveClimate(seed, ring);
  const base = ARCHETYPES[climate.biome];
  // per-seed personality: ±20 % on the big strokes so two worlds of one biome still differ
  const w = (v: number, spread = 0.2): number => v * (1 + rng.range(-spread, spread));
  return {
    id: `${climate.biome}-${(seed >>> 0).toString(16).slice(0, 4)}`,
    biome: climate.biome,
    climate,
    continentBias: base.continentBias * w(1, 0.5),
    mountainPower: Math.max(0.2, w(base.mountainPower)),
    ridgeSharpness: Math.max(2, w(base.ridgeSharpness, 0.1)),
    canyonDepth: Math.max(0, w(base.canyonDepth, 0.25)),
    plateauLift: Math.max(0, w(base.plateauLift, 0.3)),
    roughness: Math.max(0.5, w(base.roughness, 0.15)),
    valleyCount: Math.max(0, Math.round(w(base.valleyCount, 0.4))),
    valleyDepth: Math.max(0, w(base.valleyDepth, 0.3)),
    riverCount: Math.max(0, Math.round(w(base.riverCount, 0.4))),
    riverWidth: Math.max(0.008, w(base.riverWidth, 0.3)),
    riverDepth: Math.max(0, w(base.riverDepth, 0.3)),
    craterCount: Math.max(0, Math.round(w(base.craterCount, 0.4))),
    craterDepth: Math.max(0, w(base.craterDepth, 0.3)),
    sinkholeCount: Math.max(0, Math.round(w(base.sinkholeCount, 0.4))),
    palette: base.palette,
    sky: base.sky,
    veinStrength: clamp(w(base.veinStrength, 0.25), 0, 1),
    plantDensity: clamp(w(base.plantDensity, 0.2), 0.1, 2),
  };
}
