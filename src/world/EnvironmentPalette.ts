// NECROFALL — ENVIRONMENT PALETTE + BIOME DEFINITIONS (rework plan §12/§13).
//
// ONE art-direction source for the whole rework. Every environmental surface — terrain accents,
// grass, tree sets, rocks, water, fog, props — reads a `BiomeDefinition`, and every definition
// keeps NecroFall's post-apocalyptic identity:
//
//     healthy terrain      muted green / brown / grey
//     contaminated terrain toxic green / dark purple / desaturated cyan
//     Necrophage zones     black / crimson / sickly organic
//     human ruins          rust / concrete / faded paint / oxidized metal
//
// The palette is deliberately desaturated compared to Folio's bright stylisation: the world must
// still read as *beautiful but dying* (plan §88), not as a toy garden.
import type { BiomeClass } from './PlanetArchetypes';

/** The world's visual "sets" a biome can pick from (plan §13 `BiomeDefinition`). */
export interface BiomeDefinition {
  id: BiomeClass;
  /** Terrain accent ramp (used by the material detail pass, not the vertex colours themselves). */
  terrainColor: number;
  /** Grass blade root/tip pair. */
  grassRoot: number;
  grassTip: number;
  /** Tree archetype weights — indices match TREE_ARCHETYPES in TreeSystem (5 entries). */
  treeSet: [number, number, number, number, number];
  /** Rock variant weights — indices match ROCK_VARIANTS in RockSystem. */
  rockSet: [number, number, number, number, number];
  /** Water tint (shallow → deep) + contamination tint. */
  waterShallow: number;
  waterDeep: number;
  waterContamination: number;
  fogColor: number;
  /** 0..1 — how contaminated this biome's world reads. */
  contamination: number;
  /** Multipliers on the continuous habitat fields (plan §13). */
  foliageDensity: number;
  propDensity: number;
  /** Structure theme for ruins/wreckage placement. */
  structures: 'RUINS' | 'WRECKAGE' | 'INDUSTRIAL' | 'BONES' | 'GROWTH' | 'CRYSTAL';
}

const D = (b: BiomeDefinition): BiomeDefinition => b;

export const BIOME_DEFINITIONS: Record<BiomeClass, BiomeDefinition> = {
  TOXIC: D({
    id: 'TOXIC', terrainColor: 0x3f6b31, grassRoot: 0x24421f, grassTip: 0x7fae3e,
    treeSet: [0.3, 0.1, 0.2, 0.25, 0.15], rockSet: [0.45, 0.25, 0.15, 0.05, 0.1],
    waterShallow: 0x4a7a24, waterDeep: 0x1c3a10, waterContamination: 0x9dff4d,
    fogColor: 0x15240f, contamination: 0.75, foliageDensity: 1.1, propDensity: 0.8, structures: 'GROWTH',
  }),
  OCEAN: D({
    id: 'OCEAN', terrainColor: 0x1f6b86, grassRoot: 0x1f3a2c, grassTip: 0x5f9a72,
    treeSet: [0.35, 0.05, 0.1, 0.4, 0.1], rockSet: [0.5, 0.25, 0.2, 0.05, 0.0],
    waterShallow: 0x2f8fa8, waterDeep: 0x0b2e44, waterContamination: 0x3fd7d0,
    fogColor: 0x0b1c2b, contamination: 0.25, foliageDensity: 0.8, propDensity: 0.7, structures: 'WRECKAGE',
  }),
  DESERT: D({
    id: 'DESERT', terrainColor: 0x8a6b33, grassRoot: 0x5a4a26, grassTip: 0xc2a552,
    treeSet: [0.55, 0.15, 0.05, 0.15, 0.1], rockSet: [0.3, 0.3, 0.3, 0.05, 0.05],
    waterShallow: 0x6a7a3a, waterDeep: 0x2c3a1c, waterContamination: 0xa9a23a,
    fogColor: 0x2a1c0d, contamination: 0.3, foliageDensity: 0.35, propDensity: 0.95, structures: 'BONES',
  }),
  FUNGAL: D({
    id: 'FUNGAL', terrainColor: 0x5b2f86, grassRoot: 0x2c1a44, grassTip: 0x9a5fd0,
    treeSet: [0.1, 0.05, 0.45, 0.25, 0.15], rockSet: [0.4, 0.2, 0.2, 0.1, 0.1],
    waterShallow: 0x6a3f9a, waterDeep: 0x2a1748, waterContamination: 0xc86bff,
    fogColor: 0x1d1030, contamination: 0.8, foliageDensity: 1.25, propDensity: 0.5, structures: 'GROWTH',
  }),
  VOLCANIC: D({
    id: 'VOLCANIC', terrainColor: 0x7c2416, grassRoot: 0x33201a, grassTip: 0x8a5a30,
    treeSet: [0.3, 0.4, 0.1, 0.1, 0.1], rockSet: [0.25, 0.3, 0.3, 0.1, 0.05],
    waterShallow: 0xa8452a, waterDeep: 0x481410, waterContamination: 0xff5a2d,
    fogColor: 0x22100a, contamination: 0.7, foliageDensity: 0.4, propDensity: 0.6, structures: 'INDUSTRIAL',
  }),
  FROZEN: D({
    id: 'FROZEN', terrainColor: 0x6c86a8, grassRoot: 0x3a4a5c, grassTip: 0x9fb8d0,
    treeSet: [0.45, 0.1, 0.05, 0.3, 0.1], rockSet: [0.45, 0.25, 0.2, 0.1, 0.0],
    waterShallow: 0x7fb0d8, waterDeep: 0x1c3a5c, waterContamination: 0x8fe6ff,
    fogColor: 0x101a30, contamination: 0.3, foliageDensity: 0.55, propDensity: 0.6, structures: 'WRECKAGE',
  }),
  CRYSTAL: D({
    id: 'CRYSTAL', terrainColor: 0x4f46a0, grassRoot: 0x2a2358, grassTip: 0x8f8fe8,
    treeSet: [0.15, 0.05, 0.15, 0.35, 0.3], rockSet: [0.2, 0.2, 0.2, 0.3, 0.1],
    waterShallow: 0x6f8fe8, waterDeep: 0x201c50, waterContamination: 0x66f0ff,
    fogColor: 0x151138, contamination: 0.5, foliageDensity: 0.7, propDensity: 0.5, structures: 'CRYSTAL',
  }),
  SWAMP: D({
    id: 'SWAMP', terrainColor: 0x41663a, grassRoot: 0x26361f, grassTip: 0x86a44e,
    treeSet: [0.25, 0.1, 0.3, 0.15, 0.2], rockSet: [0.5, 0.25, 0.15, 0.05, 0.05],
    waterShallow: 0x3f5a2a, waterDeep: 0x14220f, waterContamination: 0x9be36b,
    fogColor: 0x14200f, contamination: 0.5, foliageDensity: 1.2, propDensity: 0.55, structures: 'BONES',
  }),
  CORRUPTED: D({
    id: 'CORRUPTED', terrainColor: 0x7c1e4a, grassRoot: 0x38122a, grassTip: 0xa83868,
    treeSet: [0.15, 0.1, 0.35, 0.1, 0.3], rockSet: [0.35, 0.2, 0.2, 0.05, 0.2],
    waterShallow: 0x8a2a56, waterDeep: 0x2a0a1e, waterContamination: 0xff2d6f,
    fogColor: 0x200a18, contamination: 0.9, foliageDensity: 0.9, propDensity: 0.8, structures: 'GROWTH',
  }),
  DEAD: D({
    id: 'DEAD', terrainColor: 0x50505f, grassRoot: 0x33333a, grassTip: 0x6e6e5c,
    treeSet: [0.6, 0.2, 0.05, 0.1, 0.05], rockSet: [0.35, 0.25, 0.25, 0.05, 0.1],
    waterShallow: 0x4a4a58, waterDeep: 0x1c1c26, waterContamination: 0x9a6bff,
    fogColor: 0x141420, contamination: 0.4, foliageDensity: 0.3, propDensity: 1.0, structures: 'RUINS',
  }),
  JUNGLE: D({
    id: 'JUNGLE', terrainColor: 0x3d6b30, grassRoot: 0x1f3a1c, grassTip: 0x74a84e,
    treeSet: [0.15, 0.05, 0.2, 0.4, 0.2], rockSet: [0.45, 0.25, 0.15, 0.1, 0.05],
    waterShallow: 0x3f7a54, waterDeep: 0x142c1c, waterContamination: 0x58c46b,
    fogColor: 0x14260f, contamination: 0.35, foliageDensity: 1.35, propDensity: 0.4, structures: 'BONES',
  }),
  ABYSSAL: D({
    id: 'ABYSSAL', terrainColor: 0x22366b, grassRoot: 0x18223c, grassTip: 0x3f5a99,
    treeSet: [0.3, 0.05, 0.2, 0.35, 0.1], rockSet: [0.45, 0.25, 0.2, 0.1, 0.0],
    waterShallow: 0x27408a, waterDeep: 0x070f2a, waterContamination: 0x3d5aff,
    fogColor: 0x080c18, contamination: 0.5, foliageDensity: 0.5, propDensity: 0.6, structures: 'WRECKAGE',
  }),
};

/** Palette used when a biome id is unknown (defensive; never expected in practice). */
export const FALLBACK_BIOME: BiomeDefinition = BIOME_DEFINITIONS.DEAD;

export function biomeDefinition(biome: BiomeClass | string): BiomeDefinition {
  return BIOME_DEFINITIONS[biome as BiomeClass] ?? FALLBACK_BIOME;
}

/**
 * Human-ruin / industry accents (plan §12 "human ruins" row). Shared by props, wreckage and the
 * structure system so every manufactured object on every planet belongs to one worn family.
 */
export const RUIN_PALETTE = {
  rust: 0x8a4a2c,
  oxidized: 0x5c6a5a,
  concrete: 0x8d8d84,
  paintFaded: 0x7a8a7a,
  darkMetal: 0x3a3f45,
  hazard: 0xb08a2c,
} as const;

/** Necrophage organic accents (plan §12 "Necrophage zones"). */
export const NECRO_PALETTE = {
  black: 0x140a12,
  crimson: 0x8a1f3c,
  sickly: 0x9a3f6a,
  membrane: 0x5a2a3f,
  glow: 0xff2d6f,
} as const;

/** Interpolates two hex colours (small helper for materials/particles). */
export function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
