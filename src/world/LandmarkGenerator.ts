// NECROFALL — LANDMARK GENERATOR (plan §14). Every planet gets 5–8 deterministic landmarks:
// named terrain features with a shape the TerrainGenerator carves into the height field, a
// colour the BiomeGenerator blends in, and an ENEMY BIAS the ecology reads — "toxic lake →
// venomous enemies", "fungal forest → ambushers" (plan §14/§26).
import * as THREE from 'three';
import { Rand, clamp } from '../utils/Utils';
import type { BiomeClass } from './PlanetArchetypes';

export type LandmarkType =
  | 'FUNGAL_FOREST'
  | 'NECROTIC_CRATER'
  | 'CRYSTAL_CANYON'
  | 'BONE_VALLEY'
  | 'TOXIC_LAKE'
  | 'COLONY_WRECK'
  | 'MASSIVE_SINKHOLE'
  | 'NECROPHAGE_NEST'
  | 'CORRUPTED_PEAK'
  | 'FLOATING_ROCKS';

/** What a landmark does to the height field. */
export type LandmarkShape =
  | 'BOWL' // toxic lake / sinkhole: depressed floor
  | 'CRATER' // raised rim + depressed floor
  | 'PEAK' // raised centre
  | 'FLAT' // levelled field (crystal field / wreck)
  | 'RIDGE'; // raised wall (canyon edge / bone valley side)

/** Gameplay tags consumed by the enemy ecology (plan §14/§26). */
export type EnemyBias = 'VENOM' | 'AMBUSH' | 'RANGED' | 'BURROW' | 'SWARM' | 'ELITE' | 'GUARDIAN';

export interface Landmark {
  id: number;
  type: LandmarkType;
  label: string;
  /** Unit direction of the centre. */
  dir: THREE.Vector3;
  /** Influence radius in radians (surface angle). */
  radius: number;
  /** 0..1 shape strength. */
  strength: number;
  shape: LandmarkShape;
  /** Colour accent blended into terrain + fog near the site. */
  color: number;
  bias: EnemyBias;
  /** Biome override at the site ('' = keep the planet's biome). */
  biome: BiomeClass | '';
}

const PALETTE: Record<LandmarkType, { label: string; shape: LandmarkShape; color: number; bias: EnemyBias; biome: BiomeClass | ''; weight: number }> = {
  FUNGAL_FOREST: { label: 'GIANT FUNGAL FOREST', shape: 'FLAT', color: 0xc86bff, bias: 'AMBUSH', biome: 'FUNGAL', weight: 1 },
  NECROTIC_CRATER: { label: 'NECROTIC CRATER', shape: 'CRATER', color: 0xff2d6f, bias: 'ELITE', biome: '', weight: 1 },
  CRYSTAL_CANYON: { label: 'CRYSTAL CANYON', shape: 'RIDGE', color: 0x8fe6ff, bias: 'RANGED', biome: 'CRYSTAL', weight: 0.9 },
  BONE_VALLEY: { label: 'BONE VALLEY', shape: 'BOWL', color: 0xe2e0d0, bias: 'BURROW', biome: 'DEAD', weight: 0.9 },
  TOXIC_LAKE: { label: 'TOXIC LAKE', shape: 'BOWL', color: 0x9dff4d, bias: 'VENOM', biome: 'TOXIC', weight: 0.9 },
  COLONY_WRECK: { label: 'ANCIENT COLONY WRECK', shape: 'FLAT', color: 0xffa63d, bias: 'GUARDIAN', biome: '', weight: 0.7 },
  MASSIVE_SINKHOLE: { label: 'MASSIVE SINKHOLE', shape: 'BOWL', color: 0x54505f, bias: 'BURROW', biome: '', weight: 0.8 },
  NECROPHAGE_NEST: { label: 'NECROPHAGE NEST', shape: 'CRATER', color: 0xff5a3d, bias: 'SWARM', biome: '', weight: 0.9 },
  CORRUPTED_PEAK: { label: 'CORRUPTED PEAK', shape: 'PEAK', color: 0xb45cff, bias: 'ELITE', biome: '', weight: 0.8 },
  FLOATING_ROCKS: { label: 'FLOATING ROCK FIELD', shape: 'FLAT', color: 0x9fb6ff, bias: 'RANGED', biome: '', weight: 0.6 },
};

const TYPES = Object.keys(PALETTE) as LandmarkType[];

/**
 * Deterministic landmark list for a planet. Placement spreads across the sphere (golden-angle
 * spiral + jitter) so sites never clump on one hemisphere. The FIRST landmark is biased toward
 * the battlefield focus direction so the arena always has one readable feature in view.
 */
export function generateLandmarks(seed: number, focusDir?: THREE.Vector3, count = 6): Landmark[] {
  const rng = new Rand((seed ^ 0x7f4a7c15) >>> 0);
  const total = clamp(5 + Math.round(rng.range(0, 3)), 5, 8);
  void count;
  const out: Landmark[] = [];
  const used = new Set<LandmarkType>();
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < total; i++) {
    // Fibonacci sphere direction + jitter, first one pulled toward the arena.
    const y = 1 - (2 * i + 1) / total;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = golden * i;
    const dir = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
    dir.x += rng.range(-0.12, 0.12);
    dir.y += rng.range(-0.12, 0.12);
    dir.z += rng.range(-0.12, 0.12);
    dir.normalize();
    if (i === 0 && focusDir) dir.lerp(focusDir, 0.72).normalize();
    // Weighted pick without repeats until the pool runs dry.
    let type: LandmarkType = TYPES[0];
    for (let guard = 0; guard < 12; guard++) {
      type = rng.pick(TYPES);
      if (!used.has(type) && rng.next() < PALETTE[type].weight + 0.35) break;
    }
    used.add(type);
    const def = PALETTE[type];
    out.push({
      id: i,
      type,
      label: def.label,
      dir,
      radius: rng.range(0.1, 0.2),
      strength: rng.range(0.55, 1),
      shape: def.shape,
      color: def.color,
      bias: def.bias,
      biome: def.biome,
    });
  }
  return out;
}

/** Nearest landmark to a direction within its radius, or null (used by biome/ecology). */
export function landmarkAt(landmarks: Landmark[], x: number, y: number, z: number, biasT = 0.85): Landmark | null {
  for (const lm of landmarks) {
    const dot = lm.dir.x * x + lm.dir.y * y + lm.dir.z * z;
    // carve a little inside the rim so the FLAT/PEAK reads right at the edge too
    if (dot > Math.cos(lm.radius * biasT)) return lm;
  }
  return null;
}
