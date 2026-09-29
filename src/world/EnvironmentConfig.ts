// NECROFALL — ENVIRONMENT CONFIG + QUALITY PROFILES (rework plan §46/§47/§74/§75/§78).
//
// The environment rework runs from ONE config object per match:
//
//     EnvironmentConfig {
//       planetSeed, environmentVersion, radius,
//       profile:  MOBILE_LOW … ULTRA   (density / LOD / budget knobs)
//       terrainDetail,                 (plan §5 detail layers)
//       pixelRatioCap,                 (plan §48)
//       waterLevel,
//     }
//
// Profiles are DEVICE-CLASS first (mobile floors are conservative — plan §46) and map 1:1 onto
// the game's existing graphics presets, so the graphic option in the menu and the account shell
// keeps governing everything.
import type { QualityName } from '../core/Config';
import { IS_MOBILE } from '../core/Config';

/** Device class of the quality profile (the plan's ULTRA/HIGH/MEDIUM/LOW ladder). */
export type EnvironmentQualityName = 'ultra' | 'high' | 'medium' | 'low';

export interface EnvironmentProfile {
  name: EnvironmentQualityName;
  /** Stable cell grid: cells per cube-sphere face. 6 → ~810 m² cells at planet radius 118. */
  cellsPerFace: number;
  /** Focus radius (m) inside which cells are built (plan §19/§72). */
  activationRadius: number;
  /** Cells built per frame at most (streaming cost cap). */
  cellBuildBudget: number;
  /** Instance densities (1 = ULTRA reference count). */
  grass: number;
  trees: number;
  rocks: number;
  props: number;
  /** LOD switch distances in metres: [LOD0→1, LOD1→2, LOD2→cull] (plan §6). */
  lod: [number, number, number];
  /** Grass tier distances (plan §8): full / half / sparse / none. */
  grassTiers: [number, number, number, number];
  /** Camera-relative distance beyond which dynamic props stop simulating (plan §23). */
  physicsRadius: number;
  /** How many dynamic prop bodies may exist (plan §58). */
  physicsBodies: number;
  /** Weather particle count (plan §35; GPU-instanced, one draw). */
  weatherParticles: number;
  /** Water shader richness: 0 = flat tint, 1 = waves + foam, 2 = + glint detail. */
  waterDetail: number;
  /** Shadow map size for the single main directional light (plan §49). */
  shadowMapSize: number;
  /** Environment update frequencies in Hz (plan §71 — nothing environmental needs 60 Hz). */
  updateHz: { interaction: number; visibility: number; far: number };
  /** Plan §48: internal render resolution ceiling per device class. */
  pixelRatioCap: number;
  /** Occlusion dither fades for camera-blocking foliage (plan §27/§54). */
  lookThrough: boolean;
}

export const ENV_PROFILES: Record<EnvironmentQualityName, EnvironmentProfile> = {
  ultra: {
    name: 'ultra',
    cellsPerFace: 6,
    activationRadius: 170,
    cellBuildBudget: 6,
    grass: 1,
    trees: 1,
    rocks: 1,
    props: 1,
    lod: [30, 70, 150],
    grassTiers: [24, 55, 100, 999],
    physicsRadius: 60,
    physicsBodies: 28,
    weatherParticles: 3200,
    waterDetail: 2,
    shadowMapSize: 2048,
    updateHz: { interaction: 30, visibility: 20, far: 12 },
    pixelRatioCap: 1.5,
    lookThrough: true,
  },
  high: {
    name: 'high',
    cellsPerFace: 5,
    activationRadius: 150,
    cellBuildBudget: 5,
    grass: 0.75,
    trees: 0.85,
    rocks: 0.8,
    props: 0.8,
    lod: [25, 60, 130],
    grassTiers: [20, 48, 90, 999],
    physicsRadius: 50,
    physicsBodies: 20,
    weatherParticles: 2200,
    waterDetail: 1,
    shadowMapSize: 1536,
    updateHz: { interaction: 24, visibility: 16, far: 10 },
    pixelRatioCap: 1.5,
    lookThrough: true,
  },
  medium: {
    name: 'medium',
    cellsPerFace: 4,
    activationRadius: 120,
    cellBuildBudget: 4,
    grass: 0.45,
    trees: 0.65,
    rocks: 0.6,
    props: 0.55,
    lod: [20, 50, 105],
    grassTiers: [16, 38, 72, 999],
    physicsRadius: 38,
    physicsBodies: 12,
    weatherParticles: 1200,
    waterDetail: 1,
    shadowMapSize: 1024,
    updateHz: { interaction: 20, visibility: 12, far: 8 },
    pixelRatioCap: 1.25,
    lookThrough: true,
  },
  low: {
    name: 'low',
    cellsPerFace: 3,
    activationRadius: 95,
    cellBuildBudget: 3,
    grass: 0.15,
    trees: 0.5,
    rocks: 0.45,
    props: 0.35,
    lod: [16, 40, 85],
    grassTiers: [12, 30, 58, 999],
    physicsRadius: 24,
    physicsBodies: 6,
    weatherParticles: 500,
    waterDetail: 0,
    shadowMapSize: 1024,
    updateHz: { interaction: 15, visibility: 10, far: 6 },
    pixelRatioCap: 1,
    lookThrough: true,
  },
};

/** Graphics preset → environment profile. Mobile devices start one rung conservative (plan §46). */
export function environmentQualityFor(name: QualityName): EnvironmentQualityName {
  if (name === 'ultra') return 'ultra';
  if (name === 'high') return 'high';
  if (name === 'medium') return 'medium';
  return 'low';
}

/** The plan's named mobile profiles, kept explicit for the debug UI (plan §74). */
export function profileLabel(profile: EnvironmentProfile): string {
  return `${profile.name.toUpperCase()}${IS_MOBILE ? ' · mobile' : ''}`;
}

export interface EnvironmentConfig {
  /** The planet seed — the single root of every environmental stream (plan §59). */
  planetSeed: number;
  /** Generation revision; bump to deliberately regenerate (plan §60). */
  version: number;
  /** World radius of the planet. */
  radius: number;
  /** Water sphere radius (visual; from the archetype's climate — plan §14). */
  waterLevel: number;
  /** 0..1 multiplier on the terrain detail layers (plan §5). */
  terrainDetail: number;
  /** Quality profile in force for this match/device. */
  profile: EnvironmentProfile;
}

/** Detail-layer amplitudes (metres). Modest on purpose: contour richness must never break
 *  walkability, and the collision field is the same field (plan §4/§22). */
export const TERRAIN_DETAIL = {
  /** Medium band: domain-warped ridged noise, ~24 m wavelength. */
  mediumAmp: 0.85,
  mediumFreq: 0.26,
  /** Micro band: fine grain, ~6 m wavelength. */
  microAmp: 0.22,
  microFreq: 1.05,
};

/**
 * Builds the config for one planet. `qualityName` is the resolved graphics preset; the water
 * level is derived from the archetype so OCEAN/ABYSSAL worlds flood their deep basins while DEAD
 * worlds stay bone dry (plan §14).
 */
export function createEnvironmentConfig(
  planetSeed: number,
  qualityName: QualityName,
  radius: number,
  biome: string
): EnvironmentConfig {
  return {
    planetSeed: planetSeed >>> 0,
    version: 1,
    radius,
    waterLevel: waterLevelFor(biome, radius),
    terrainDetail: 1,
    profile: ENV_PROFILES[environmentQualityFor(qualityName)],
  };
}

/** Per-biome water level. Returns 0 when the world should have no water at all. */
export function waterLevelFor(biome: string, radius: number): number {
  switch (biome) {
    case 'OCEAN': return radius - 4.0;
    case 'ABYSSAL': return radius - 5.5;
    case 'SWAMP': return radius - 5.0;
    case 'TOXIC': return radius - 5.5;
    case 'JUNGLE': return radius - 6.5;
    case 'CORRUPTED': return radius - 6.5;
    case 'FUNGAL': return radius - 6.5;
    case 'FROZEN': return radius - 6.0;
    default: return radius - 7.5;
  }
}
