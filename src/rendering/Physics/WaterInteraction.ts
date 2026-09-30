// NECROFALL — WaterInteraction (plan §21, §71): water as an ANALYTICAL gameplay state, never as
// a physics collider. The surface patches are visuals; everything that needs to know "is this
// point wet" asks here — enemies crossing a boundary, projectiles, dash logic, effects.
//
// Responses are EVENT-DRIVEN by the caller (query on movement/boundary crossing), not polled per
// frame per entity.
import * as THREE from 'three/webgpu';
import type { TerrainSurface } from '../../world/TerrainSurface';

export type WaterState = 'dry' | 'shallow' | 'deep';

export interface WaterMovementModifiers {
  /** Multiplier on ground speed. */
  speedMul: number;
  /** Multiplier on jump impulse. */
  jumpMul: number;
  /** Double-jump / dash dampening. */
  dashMul: number;
}

const SHALLOW_DEPTH = 0.18;
const DEEP_DEPTH = 0.9;

const MODIFIERS: Record<WaterState, WaterMovementModifiers> = {
  dry: { speedMul: 1, jumpMul: 1, dashMul: 1 },
  shallow: { speedMul: 0.88, jumpMul: 1, dashMul: 1 },
  deep: { speedMul: 0.7, jumpMul: 0.82, dashMul: 0.85 },
};

export class WaterInteraction {
  private readonly dir = new THREE.Vector3();

  constructor(private readonly surface: TerrainSurface) {}

  /** Water depth in metres under a world position (plan §21: analytic query). */
  depthAt(position: THREE.Vector3): number {
    const len = position.length();
    if (len < 1e-3) return 0;
    this.dir.copy(position).multiplyScalar(1 / len);
    const h = this.surface.heightAtDir(this.dir.x, this.dir.y, this.dir.z);
    return Math.max(0, this.surface.waterLevel - h);
  }

  stateAt(position: THREE.Vector3): WaterState {
    const depth = this.depthAt(position);
    if (depth <= SHALLOW_DEPTH) return 'dry';
    if (depth <= DEEP_DEPTH) return 'shallow';
    return 'deep';
  }

  isSubmerged(position: THREE.Vector3): boolean {
    // "Submerged" = standing in deep water (the body is at the terrain surface).
    return this.depthAt(position) > DEEP_DEPTH;
  }

  modifiers(state: WaterState): WaterMovementModifiers {
    return MODIFIERS[state];
  }

  /** Surface elevation in world radius (for effects/VFX placement). */
  get surfaceRadius(): number {
    return this.surface.waterLevel;
  }

  /**
   * True when the segment between two positions crosses the waterline — the event seam for
   * splashes (plan §71: emit on boundary crossing, never per-frame polling).
   */
  crossesBoundary(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const a = this.depthAt(from) > SHALLOW_DEPTH;
    const b = this.depthAt(to) > SHALLOW_DEPTH;
    return a !== b;
  }
}
