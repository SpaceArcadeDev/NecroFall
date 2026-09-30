// NECROFALL — the shared placement contract between the procedural generators and the Folio
// renderers (plan §18, §66).
//
// Generators decide WHAT exists and where (deterministic, seed-driven, terrain-aware). The Folio
// renderers decide HOW it is drawn (instancing, Foliage, materials). They only meet here.
import type * as THREE from 'three/webgpu';

export type TreeKind = 'BIRCH' | 'OAK' | 'CHERRY';
export type BushKind = 'BUSH';
export type FlowerKind = 'FLOWER';
export type SceneryKind = 'BRICKS' | 'FENCE' | 'BENCH' | 'CRATE' | 'LANTERN' | 'POLE_LIGHT';
export type RockKind = 'ROCK' | 'CRYSTAL' | 'SLAB' | 'SPIKE';

/** Terrain data packed exactly like the shader attribute contract (see NecroFallTerrainNode). */
export type TerrainDataTuple = [number, number, number, number];

export interface EnvironmentPlacement {
  /** Deterministic id (plan §67) — also the key for destruction state later. */
  id: number;
  position: THREE.Vector3;
  /** Unit surface direction under the object. */
  direction: THREE.Vector3;
  /** Upright frame + yaw around the surface normal. */
  quaternion: THREE.Quaternion;
  scale: number;
  /** (slope, height01, moisture, corruption) of the ground it stands on. */
  terrain: TerrainDataTuple;
  /** Plant-density band at the spot (0..1.6). */
  vegetation: number;
}

export interface TreePlacement extends EnvironmentPlacement {
  kind: TreeKind;
}

export interface BushPlacement extends EnvironmentPlacement {
  kind: BushKind;
}

export interface FlowerPlacement extends EnvironmentPlacement {
  kind: FlowerKind;
}

export interface SceneryPlacement extends EnvironmentPlacement {
  kind: SceneryKind;
}

export interface RockPlacement extends EnvironmentPlacement {
  kind: RockKind;
  /**
   * Extra Y scale for stretched kinds — tall spike cones (the pre-rework "jagged peaks" were
   * tall narrow cones, not round rocks) and stretched crystals. 1 = the kind's default.
   */
  stretch?: number;
}

/** All placements of one generator run — the scene graph is built straight from this. */
export interface EnvironmentPlacements {
  trees: TreePlacement[];
  bushes: BushPlacement[];
  flowers: FlowerPlacement[];
  scenery: SceneryPlacement[];
  rocks: RockPlacement[];
}

export function emptyPlacements(): EnvironmentPlacements {
  return { trees: [], bushes: [], flowers: [], scenery: [], rocks: [] };
}
