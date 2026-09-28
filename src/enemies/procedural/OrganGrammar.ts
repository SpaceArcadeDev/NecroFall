// NECROFALL — ORGAN GRAMMAR (plan §17/§18/§22). Attack organs are the bridge between the BODY
// and the KIT: a venom gland IS the venom cloud, a projectile sac IS the spit, an explosive sac
// IS the death blast. The organ also grows visibly, so the player can read the kit off the body.
import type { Rand } from '../../utils/Utils';
import type { AbilityId, GenomeVisual } from '../EnemyGenomes';
import type { EcoRole, LocomotionId } from './EnemyGenome';

export type AttackOrgan =
  | 'JAW' | 'CLAW' | 'TAIL' | 'VENOM_GLAND' | 'PROJECTILE_SAC' | 'WEB_GLAND'
  | 'BEAM_ORGAN' | 'EXPLOSIVE_SAC' | 'THORN_HIDE' | 'REGEN_TISSUE' | 'SHIELD_SACS';

/** Which ability an organ fires (the sim's own vocabulary — plan §22's attack types). */
export const ORGAN_ABILITY: Record<AttackOrgan, AbilityId> = {
  JAW: 'slam',
  CLAW: 'slam',
  TAIL: 'gravPull',
  VENOM_GLAND: 'venomCloud',
  PROJECTILE_SAC: 'spit',
  WEB_GLAND: 'web',
  BEAM_ORGAN: 'volley',
  EXPLOSIVE_SAC: 'detonate',
  THORN_HIDE: 'thorn',
  REGEN_TISSUE: 'regen',
  SHIELD_SACS: 'shield',
};

const PASSIVES: AttackOrgan[] = ['THORN_HIDE', 'REGEN_TISSUE', 'SHIELD_SACS'];

export interface OrganPlan {
  organs: AttackOrgan[];
  visual: Partial<GenomeVisual>;
}

/**
 * Rolls the offensive kit. Locomotion seeds the mandatory organ (a burrower HAS a burrow
 * head, a leaper HAS leap legs), the role leans the rest, and the ring decides how exotic the
 * pool gets. Landmark biases (plan §14) push a matching organ: a toxic lake bends the planet's
 * creatures toward venom, a crystal canyon toward ranged organs.
 */
export function rollOrgans(
  rng: Rand,
  role: EcoRole,
  locomotion: LocomotionId,
  ring: number,
  biases: string[]
): OrganPlan {
  const organs: AttackOrgan[] = [];
  const push = (o: AttackOrgan): void => {
    if (organs.indexOf(o) < 0) organs.push(o);
  };

  // ---- locomotion-mandated organs
  if (locomotion === 'LEAPER' || locomotion === 'HOPPER') push('CLAW');
  if (locomotion === 'BURROWER') push('CLAW');
  if (locomotion === 'SLITHER' || locomotion === 'CHARGER') push('JAW');
  if (locomotion === 'WALKER') push(rng.next() < 0.5 ? 'JAW' : 'CLAW');
  if (locomotion === 'STALKING') push('CLAW');

  // ---- role lean
  switch (role) {
    case 'SPITTER': push('PROJECTILE_SAC'); break;
    case 'SCOUT': push(ring >= 2 ? 'BEAM_ORGAN' : 'PROJECTILE_SAC'); break;
    case 'GUARDIAN': push('SHIELD_SACS'); break;
    case 'BULWARK': push(rng.next() < 0.6 ? 'THORN_HIDE' : 'SHIELD_SACS'); break;
    case 'AMBUSHER': push(ring >= 2 && rng.next() < 0.5 ? 'WEB_GLAND' : 'VENOM_GLAND'); break;
    case 'APEX': push('JAW'); push(ring >= 3 ? 'EXPLOSIVE_SAC' : 'VENOM_GLAND'); break;
    case 'BOSS':
    case 'OVERSEER':
      push('JAW');
      push(ring >= 4 ? 'BEAM_ORGAN' : 'PROJECTILE_SAC');
      if (ring >= 3) push('EXPLOSIVE_SAC');
      break;
    default: break;
  }

  // ---- landmark biases (plan §14: toxic lake → venomous, crystal canyon → ranged…)
  if (biases.indexOf('VENOM') >= 0 && rng.next() < 0.7) push('VENOM_GLAND');
  if (biases.indexOf('RANGED') >= 0 && rng.next() < 0.65) push('PROJECTILE_SAC');
  if (biases.indexOf('AMBUSH') >= 0 && rng.next() < 0.5) push('WEB_GLAND');
  if (biases.indexOf('ELITE') >= 0 && ring >= 3 && rng.next() < 0.5) push('EXPLOSIVE_SAC');

  // ---- passive flavour (0-2, weighted by ring)
  const passiveRolls = 1 + (ring >= 3 && rng.next() < 0.45 ? 1 : 0);
  for (let i = 0; i < passiveRolls; i++) {
    if (rng.next() < 0.55) push(rng.pick(PASSIVES));
  }

  // ---- organ → visible hardware
  return { organs, visual: organVisual(organs) };
}

/** Organ list → the visible hardware (tubes / sacs / spikes / membrane). Exported so the attack
 *  grammar's padded organs (plan §29 boss minimum kits) also GROW their body parts. */
export function organVisual(organs: AttackOrgan[]): Partial<GenomeVisual> {
  const visual: Partial<GenomeVisual> = {};
  const count = (o: AttackOrgan): number => organs.filter((x) => x === o).length;
  if (count('PROJECTILE_SAC') || count('BEAM_ORGAN') || count('WEB_GLAND')) {
    visual.tubes = (visual.tubes ?? 0) + 2 + count('BEAM_ORGAN') * 2;
  }
  if (count('EXPLOSIVE_SAC')) visual.glowNodes = (visual.glowNodes ?? 0) + 3;
  if (count('SHIELD_SACS')) visual.glowNodes = (visual.glowNodes ?? 0) + 1;
  if (count('THORN_HIDE')) { visual.spikes = (visual.spikes ?? 0) + 4; visual.spikeSize = 1.1; }
  if (count('REGEN_TISSUE')) visual.membrane = 0.3;
  if (count('JAW')) visual.mandibles = (visual.mandibles ?? 2) + 2;
  if (count('VENOM_GLAND')) { visual.core = true; visual.membrane = Math.max(visual.membrane ?? 0, 0.2); }
  if (count('TAIL')) visual.tail = true;
  return visual;
}
