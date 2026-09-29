// NECROFALL — SceneryGenerator (plan §18): the dressing rules the procedural scenery pass and
// the physics layer share — which Folio model a kind maps to, how big its collider is, and how
// rare it should be. Placement COORDINATES come from VegetationGenerator (one deterministic
// stream for the whole world); this module owns everything else about scenery.
import type { SceneryKind } from '../../vegetation/VegetationTypes';

export interface ScenerySpec {
  /** Key into FolioEnvironmentAssets. */
  asset: 'bricks' | 'fences' | 'benches' | 'crates' | 'lanterns' | 'poleLights';
  /** Collider shape for the physics layer (plan §27). Crate = dynamic, others fixed. */
  physics: 'none' | 'fixed-box' | 'dynamic-box';
  /** Half extents of the box collider in model units (scaled by placement.scale). */
  halfExtents: [number, number, number];
  /** Relative spawn weight in the scenery pass. */
  weight: number;
  /** Never allow vegetation INSIDE this radius of the prop (visual breathing room). */
  carveRadius: number;
}

export const SCENERY_RULES: Record<SceneryKind, ScenerySpec> = {
  BRICKS: { asset: 'bricks', physics: 'fixed-box', halfExtents: [0.7, 0.45, 0.7], weight: 1.0, carveRadius: 1.6 },
  FENCE: { asset: 'fences', physics: 'fixed-box', halfExtents: [1.4, 0.6, 0.15], weight: 0.8, carveRadius: 1.2 },
  BENCH: { asset: 'benches', physics: 'fixed-box', halfExtents: [1.0, 0.35, 0.4], weight: 0.6, carveRadius: 1.4 },
  CRATE: { asset: 'crates', physics: 'dynamic-box', halfExtents: [0.5, 0.5, 0.5], weight: 0.55, carveRadius: 1.2 },
  LANTERN: { asset: 'lanterns', physics: 'fixed-box', halfExtents: [0.25, 1.0, 0.25], weight: 0.5, carveRadius: 1.0 },
  POLE_LIGHT: { asset: 'poleLights', physics: 'fixed-box', halfExtents: [0.3, 2.2, 0.3], weight: 0.4, carveRadius: 1.6 },
};

/** Deterministic weighted kind pick (roll in [0,1)). */
export function pickSceneryKind(roll: number): SceneryKind {
  const kinds = Object.keys(SCENERY_RULES) as SceneryKind[];
  const total = kinds.reduce((sum, k) => sum + SCENERY_RULES[k].weight, 0);
  let acc = roll * total;
  for (const kind of kinds) {
    acc -= SCENERY_RULES[kind].weight;
    if (acc <= 0) return kind;
  }
  return 'BRICKS';
}
