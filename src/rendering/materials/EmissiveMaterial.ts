/**
 * NECROFALL — sci-fi emissive material (visual rework plan §25/§26).
 *
 * ONE factory for every emissive accent in the world — crystals, landmark cores, Necrophage
 * organs, beams. It owns the plan's pulse contract:
 *
 *     pulse    = 1 + sin(time × pulseSpeed) × pulseAmount
 *     emission = colour × intensity × bloomTier × pulse
 *
 * and the plan's bloom hierarchy (§26: "if everything blooms, nothing looks important"):
 *
 *     HIGH    Nexus / boss rage / major ability / crystal core   (hot core, blooms hard)
 *     MEDIUM  crystals / Beacon / Necrotech                      (blooms)
 *     LOW     environment accents                                (stays under threshold)
 *
 * The pulse is GPU-side — a material is created once and never touched per frame (plan §43).
 */
import * as THREE from 'three/webgpu';
import { color, mix, normalWorld, uv } from 'three/tsl';
import { ART_DIRECTION } from '../ArtDirection';

export type BloomTier = 'high' | 'medium' | 'low';

/** Tier multipliers — medium lands a shard just over the bloom threshold (0.9), low under it. */
export const BLOOM_TIER_SCALE: Record<BloomTier, number> = {
  high: 1,
  medium: 0.62,
  low: 0.3,
};

export interface EmissiveMaterialOptions {
  /** Core colour (the bright end of the gradient). */
  color: string;
  /** Optional second colour the surface grades toward (defaults to `color`). */
  edgeColor?: string;
  /** Base emission intensity (plan §25). Defaults to the global radiation intensity. */
  intensity?: number;
  /** Bloom importance tier (plan §26). Defaults to `medium`. */
  bloom?: BloomTier;
  /** Pulse speed (rad/s) and relative amount (plan §25; 0 disables the pulse). */
  pulseSpeed?: number;
  pulseAmount?: number;
  /** Facet shading (crystal look): darker on side facets, bright on up-facing ones. */
  facet?: boolean;
  /** `vertexColour`-style gradient axis: 'y' grades by local height, 'uv' by uv.y. */
  gradient?: 'none' | 'y' | 'uv';
  /** Optional time uniform; when omitted the material is static emissive. */
  time?: any;
}

export function createEmissiveMaterial(options: EmissiveMaterialOptions): THREE.MeshBasicNodeMaterial {
  const tier = options.bloom ?? 'medium';
  const intensity = (options.intensity ?? ART_DIRECTION.radiation.intensity) * BLOOM_TIER_SCALE[tier];
  const pulseSpeed = options.pulseSpeed ?? 1.35;
  const pulseAmount = options.pulseAmount ?? 0.22;

  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = false;
  material.fog = true;

  const pulse: any =
    options.time && pulseAmount > 0
      ? (options.time as any).mul(pulseSpeed).sin().mul(pulseAmount).add(1 - pulseAmount * 0.5)
      : null;

  const gradient = options.gradient ?? 'none';
  const gradientNode: any =
    gradient === 'uv' ? (uv() as any).y : gradient === 'y' ? (normalWorld as any).y.mul(0.25).add(0.78) : null;

  let emission: any = gradientNode
    ? mix(color(options.color), color(options.edgeColor ?? options.color), gradientNode)
    : color(options.color);
  if (options.facet) {
    const facet = (normalWorld as any).y.mul(0.35).add(0.7);
    emission = emission.mul(facet);
  }
  emission = emission.mul(intensity);
  if (pulse) emission = emission.mul(pulse);
  material.colorNode = emission as any;

  return material;
}
