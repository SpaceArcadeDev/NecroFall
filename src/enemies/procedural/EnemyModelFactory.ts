// NECROFALL — ENEMY MODEL FACTORY (plan §30/§31). The single entry point for turning a genome
// into a THREE rig. All parts come from the shared primitive library in `EnemyModels.ts`
// (shells, heads, legs, plates, spikes, cones, cores) — thousands of generated creatures reuse
// the same GPU geometries, and the static parts are merged per creature so draw calls stay flat
// (plan §31: uniqueness comes from transforms/scale/colour, not new GPU resources).
//
// The locomotion organs (fins / wings / sacs / claws, plan §19) are drawn by the builder itself
// so they participate in the same merge + pooling behaviour as every shipped part.
import type { CreatureRig } from '../EnemyModels';
import { buildCreature } from '../EnemyModels';
import type { EnemyGenome } from '../EnemyGenomes';

/** Deterministic per-instance variation gate (same genome + same gate = same body). */
export function modelSeedFor(genome: EnemyGenome, gate: number): number {
  return (1 + genome.idx * 131 + gate) >>> 0;
}

export function createEnemyModel(genome: EnemyGenome, variantGate: number): CreatureRig {
  return buildCreature(genome, modelSeedFor(genome, variantGate));
}
