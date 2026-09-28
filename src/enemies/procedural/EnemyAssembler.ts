// NECROFALL — ENEMY ASSEMBLER (plan §16/§30). Genome → rig, plus the human-readable
// description the dev lab and the debug plates show. One import for the whole game.
import type { EnemyGenome } from '../EnemyGenomes';
import type { CreatureRig } from '../EnemyModels';
import { createEnemyModel } from './EnemyModelFactory';

export function assembleEnemy(genome: EnemyGenome, variantGate: number): CreatureRig {
  return createEnemyModel(genome, variantGate);
}

/** "PALE LEAPER — LEAPER · 2 legs · venom sac · AMBUSH PACK" style blurb (plan §71). */
export function describeGenome(genome: EnemyGenome): string {
  const parts: string[] = [];
  if (genome.locomotion) parts.push(genome.locomotion);
  if (genome.role) parts.push(genome.role);
  const legs = Math.round((genome.visual.legPairs ?? 0) * 2);
  if (legs > 0) parts.push(`${legs} legs`);
  else if ((genome.visual.segments ?? 1) > 1) parts.push(`${genome.visual.segments} segments`);
  const attacks = genome.attacks?.map((a) => a.name) ?? [];
  if (attacks.length) parts.push(attacks.join(' + '));
  if (genome.traits.length) parts.push(genome.traits.join(' ').toUpperCase());
  return `${genome.name.toUpperCase()} — ${parts.join(' · ')}`;
}
