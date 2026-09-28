// NECROFALL — BEHAVIOR GRAMMAR (plan §25/§26/§66). Cheap utility scoring over the SHIPPED
// `BehaviorProfile` — no neural nets, no new AI state machine. The role fixes the temperament,
// the ecology colours it, and the ring adds COMPOUND behaviours (plan §29: "GOLD: behavior
// combinations", "LIBERATOR: compound behavior") instead of raw stats.
import type { Rand } from '../../utils/Utils';
import { buildBehavior, type BehaviorProfile, type BehaviorTrait, type Tier } from '../EnemyGenomes';
import type { EcoRole, EcologyKind } from './EnemyGenome';

const ROLE_TRAITS: Record<EcoRole, BehaviorTrait[]> = {
  SCAVENGER: ['cowardly', 'fleeing'],
  SWARMER: ['pack', 'aggressive'],
  SCOUT: ['ranged', 'cowardly'],
  HUNTER: ['aggressive', 'persistent'],
  AMBUSHER: ['pack', 'cowardly'],
  SPITTER: ['ranged', 'defensive'],
  BULWARK: ['defensive', 'territorial'],
  GUARDIAN: ['protective', 'territorial'],
  APEX: ['aggressive', 'persistent'],
  BOSS: ['aggressive', 'persistent', 'protective'],
  OVERSEER: ['aggressive', 'persistent', 'protective'],
};

const ECOLOGY_EXTRA: Record<EcologyKind, BehaviorTrait[]> = {
  AMBUSH_PACK: ['pack'],
  BURROW_COLONY: ['territorial'],
  TOXIC_SWARM: ['pack', 'explosive'],
  FERAL_HERD: ['pack', 'fleeing'],
  CRYSTAL_GRAZERS: ['defensive', 'territorial'],
  VOID_STALKERS: ['persistent', 'aggressive'],
};

/**
 * Think cadence per the plan §66 table: small 250–500 ms, elites 150–250 ms, bosses 100–200 ms.
 * The shipped profile already reads `thinkInterval` every frame — this is the tuning surface.
 */
export function thinkIntervalFor(tier: Tier, role: EcoRole, rand: () => number): number {
  if (tier === 'boss' || tier === 'nexus') return 0.12 + rand() * 0.08;
  if (tier === 'apex' || role === 'GUARDIAN' || role === 'HUNTER') return 0.15 + rand() * 0.1;
  if (tier === 'large') return 0.22 + rand() * 0.12;
  return 0.3 + rand() * 0.2;
}

export interface BehaviorKit {
  traits: BehaviorTrait[];
  profile: BehaviorProfile;
}

export function behaviorFor(
  rng: Rand,
  role: EcoRole,
  tier: Tier,
  ecology: EcologyKind,
  ring: number,
  hasRanged: boolean
): BehaviorKit {
  const traits: BehaviorTrait[] = [];
  const add = (t: BehaviorTrait): void => {
    if (traits.indexOf(t) < 0 && traits.length < 3) traits.push(t);
  };

  for (const t of ROLE_TRAITS[role]) add(t);
  if (hasRanged) add('ranged');
  if (role === 'HUNTER') return { traits, profile: buildBehavior(traits, tier) };

  // ---- ecology flavour (one slot)
  if (rng.next() < 0.75) add(rng.pick(ECOLOGY_EXTRA[ecology]));

  // ---- compound behaviours unlock with the ring (plan §29)
  if (ring >= 2 && rng.next() < 0.5) add(rng.pick(['charging', 'protective', 'territorial'] as BehaviorTrait[]));
  if (ring >= 4 && rng.next() < 0.5) add(rng.pick(['persistent', 'explosive'] as BehaviorTrait[]));
  if (ring >= 6 && rng.next() < 0.6) add(traits.length >= 3 ? traits[0] : rng.pick(['fleeing', 'aggressive'] as BehaviorTrait[]));

  if (traits.length === 0) add(tier === 'small' ? 'cowardly' : 'aggressive');
  const profile = buildBehavior(traits, tier);
  profile.thinkInterval = thinkIntervalFor(tier, role, () => rng.next());
  return { traits, profile };
}
