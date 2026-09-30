// NECROFALL — the bridge between Planet's terrain data and Folio's TSL material architecture
// (plan §6, §7, §82, §83, §84).
//
// Planet displaces its icosphere on the CPU through the authoritative analytic height field and
// bakes per-vertex terrain data into attributes. This module turns that data into the TSL nodes
// the terrain material (and every placement system's instance attributes) shade with — ONE
// palette function, so rock-by-slope, grass-by-flatness, damp basins and necrotic veins all
// agree with where trees/grass/props are actually allowed to stand.
//
// Data contract (`aTerrain` vec4, `aVeg` float), baked by Planet per vertex AND per placed
// instance (trees/rocks carry the values of the ground they stand on):
//   x: slope          0 flat .. 1 vertical   (same slopeAt() the placement code uses)
//   y: height01       0 relief low .. 1 relief high (same banding the biome ramp uses)
//   z: moisture       0 dry .. 1 soaked (biome classifier, 0 on props)
//   w: corruption     0 clean .. 1 necrotic (biome classifier + vein strength)
import * as THREE from 'three/webgpu';
import { Fn, attribute, color, float, mx_noise_float, positionWorld, uniform, vec3, vec4 } from 'three/tsl';
import { clamp } from '../../../utils/Utils';
import { FOLIO } from '../FolioShaderGlobals';
import { necroticGlowNode, necroticVeinNode } from '../materials/NecroticTerrainNodes';

/**
 * Per-planet palette uniforms. Written once per planet build (TerrainVisual), read by the
 * terrain material, the light bounce and every vegetation material that wants to match the
 * ground it grows from.
 */
export class TerrainPalette {
  readonly deep = uniform(color('#2a2333'));
  readonly low = uniform(color('#4c3f5c'));
  readonly mid = uniform(color('#5e7a5a'));
  readonly ridge = uniform(color('#6b6478'));
  readonly peak = uniform(color('#b9c0d4'));
  readonly vein = uniform(color('#b06cff'));
  readonly grass = uniform(color('#5f9a58'));
  readonly rock = uniform(color('#6a6273'));
  /** Waterline as height01 (fills everything below it); -1 = dry world. */
  readonly waterline01 = uniform(-1);
  /** Radius band that height01 spans (debug + water maths). */
  readonly reliefMin = uniform(0);
  readonly reliefMax = uniform(0);
}

export const TERRAIN_PALETTE = new TerrainPalette();

/** The per-vertex / per-instance terrain data attributes, read by every Folio material. */
export const terrainDataNode = () => attribute('aTerrain', 'vec4') as any;
export const vegetationDataNode = () => attribute('aVeg', 'float') as any;

/** CPU counterpart of the attribute contract — one place defines the packing. */
export function packTerrainData(
  slope: number,
  height01: number,
  moisture: number,
  corruption: number,
): [number, number, number, number] {
  return [clamp(slope, 0, 1), clamp(height01, 0, 1), clamp(moisture, 0, 1), clamp(corruption, 0, 1)];
}

/**
 * The shared albedo function: baked biome colour × procedural grain × slope rock × vegetation
 * wash × damp basins × necrotic veins. Every consumer (terrain, grass blades, tree canopies,
 * rocks) evaluates the same thing at its own terrain data, so the world reads as one surface.
 */
export function terrainAlbedoNode(data: any, bakedColor: any, vegetation: any): any {
  return Fn(() => {
    const slope = data.x;
    const height01 = data.y;

  // Ground grain: two bands so close-ups and wide shots both read as terrain.
  const grain = mx_noise_float(positionWorld.mul(1.35)).mul(0.5).add(0.5);
  const fine = mx_noise_float(positionWorld.mul(6.5)).mul(0.5).add(0.5);
  const patch = mx_noise_float(positionWorld.mul(0.3)).mul(0.5).add(0.5);

  const albedo = bakedColor
    .mul(grain.mul(0.62).add(0.68))
    .mul(patch.mul(0.3).add(0.86))
    .toVar();

  // Vegetation creeps over flat low ground; rock takes over on steep faces (plan §83 — the same
  // slope value that gates placement, so nothing grows where the material shows cliffs).
  const flatness = slope.smoothstep(0.38, 0.05);
  const highland = height01.smoothstep(0.75, 0.4);
  const grassy = flatness.mul(highland).mul(vegetation).min(1);
  albedo.assign(albedo.mix(TERRAIN_PALETTE.grass.mul(grain.mul(1.0).add(0.55)), grassy.mul(0.72)));

  const rocky = slope.smoothstep(0.26, 0.6);
  albedo.assign(albedo.mix(TERRAIN_PALETTE.rock.mul(fine.mul(0.6).add(0.7)), rocky.mul(0.6)));

  // Damp basins read darker.
  const wet = height01.smoothstep(0.13, 0.32).oneMinus();
  albedo.assign(albedo.mul(wet.mul(0.16).add(0.84)));

  // Shoreline: a dry band just above the waterline, a deep tint below it.
  const aboveWater = height01.sub(TERRAIN_PALETTE.waterline01).max(0);
  const dryBand = aboveWater.mul(30).smoothstep(0, 0.5);
  albedo.assign(albedo.mul(dryBand.mul(0.2).add(0.8)));

  const below = TERRAIN_PALETTE.waterline01.sub(height01).max(0).mul(30).min(1);
  albedo.assign(albedo.mix(TERRAIN_PALETTE.deep, below.mul(0.35)));

  // Necrotic wash: the shared corruption field tinted towards the archetype's vein colour.
  const corruption = data.w.clamp(0, 1).mul(FOLIO.necro.intensity.mul(0.6).add(0.7)).min(1);
  albedo.assign(albedo.mix(TERRAIN_PALETTE.vein, corruption.mul(0.3)));

    return albedo;
  })();
}

/** The emissive half: vein glow, thicker where the corruption field is strong. */
export function terrainEmissiveNode(data: any, time: any): any {
  return Fn(() => {
    const corruption = data.w;
    const veins = necroticVeinNode(positionWorld.mul(0.08));
    const pulse = time.mul(0.9).add(positionWorld.x.mul(0.05)).sin().mul(0.12).add(0.3);
    const glow = veins.mul(pulse).mul(corruption.mul(0.75).add(0.25));
    return necroticGlowNode(glow, corruption);
  })();
}

/** Vector form for callers that pass plain numbers (CPU bake) into a uniform-like node. */
export function terrainDataVec4(values: [number, number, number, number]): any {
  return vec4(values[0], values[1], values[2], values[3]);
}

/** Convenience for unlit/debug passes. */
export function flatColor(hex: number): any {
  return vec3(color(hex));
}

/** Constant node helper (keeps call sites readable). */
export const zero = float(0);
