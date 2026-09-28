// NECROFALL — ATTACK GRAMMAR (plan §22/§29). Attacks are built from ORGANS + LOCOMOTION; each
// one carries windup / telegraph / execution / recovery / cooldown / range / damage / movement.
// The `ability` field is the sim's own vocabulary (what the shipped ability system executes);
// the rest of the record is the generated DRESS — telegraph shape and timing, naming, and the
// data the hunter cycle and the animator read.
import type { Rand } from '../../utils/Utils';
import { ABILITY_META, type AbilityId } from '../EnemyGenomes';
import type { EcoRole, LocomotionId, ProcAttack, TelegraphSpec } from './EnemyGenome';
import { ORGAN_ABILITY, type AttackOrgan } from './OrganGrammar';
import { telegraphFor } from './TelegraphGrammar';

/** Attack abilities an organ can field, richest first. */
const ATTACK_ORGAN_ORDER: AttackOrgan[] = [
  'BEAM_ORGAN', 'PROJECTILE_SAC', 'WEB_GLAND', 'VENOM_GLAND', 'EXPLOSIVE_SAC', 'TAIL', 'JAW', 'CLAW',
];

const MOVEMENT: Partial<Record<AbilityId, ProcAttack['movement']>> = {
  leap: 'leap',
  charge: 'charge',
  burrow: 'burrow',
  blink: 'blink',
};

const DEATH_EFFECTS: Partial<Record<string, AbilityId>> = {
  TOXIC_SWARM: 'spawnlings',
  BURROW_COLONY: 'split',
  VOID_STALKERS: 'split',
  AMBUSH_PACK: 'spawnlings',
};

/** Attacks a role/tier may hold (plan §29 budget: bronze simple, KOG compound chains). */
function attackBudget(ring: number, role: EcoRole): number {
  let n = ring <= 0 ? 1 : ring === 1 ? 2 : ring <= 3 ? 2 + Math.floor(ring / 2) : 3 + Math.floor((ring - 3) / 2);
  if (role === 'BOSS' || role === 'OVERSEER') n += 1;
  if (role === 'APEX') n += ring >= 4 ? 1 : 0;
  if (role === 'SCAVENGER' || role === 'SWARMER') n = Math.min(n, 2);
  return Math.min(5, n);
}

export interface AttackKit {
  attacks: ProcAttack[];
  abilities: AbilityId[];
  /** Passive ability list (thorn/regen/shield/…) appended after the actives. */
  passives: AbilityId[];  /** Extra organs the PADDING grew (plan §29: bosses always field a full kit) — the generator
   *  merges these into the organ list so the body visibly grows the hardware. */
  paddedOrgans: AttackOrgan[];}

export function buildAttacks(
  rng: Rand,
  organs: AttackOrgan[],
  locomotion: LocomotionId,
  role: EcoRole,
  tier: 'small' | 'large' | 'apex' | 'boss' | 'nexus',
  ring: number,
  ecology: string,
  accent: number
): AttackKit {
  const budget = attackBudget(ring, role);
  const attacks: ProcAttack[] = [];
  const attackAbilities = new Set<AbilityId>();
  const used = new Set<AttackOrgan>();

  const mk = (ability: AbilityId, organ: AttackOrgan | null): ProcAttack => {
    const base = ABILITY_META[ability];
    const spec: TelegraphSpec = telegraphFor(ability, rng, ring);
    spec.color = accent;
    const heavy = role === 'BOSS' || role === 'OVERSEER' || role === 'APEX';
    return {
      id: organ ? `${organ}/${ability}` : ability,
      name: base.name,
      ability,
      telegraph: spec,
      // higher rings COMMIT faster but READ shorter — the two windows shrink together
      windup: Math.max(0.3, spec.lead + rng.range(-0.08, 0.12)),
      recover: Math.max(0.25, (heavy ? 1.1 : 0.7) - ring * 0.06 + rng.range(-0.1, 0.15)),
      range: ability === 'volley' || ability === 'spit' || ability === 'web' ? 14 + ring * 1.5 : 2.4 + rng.range(0, 1.4),
      damageMul: (heavy ? 1.35 : 1) * (1 + ring * 0.05) * rng.range(0.9, 1.12),
      cd: Math.max(1.4, base.cd * (heavy ? 0.85 : 1) * rng.range(0.9, 1.15)),
      movement: MOVEMENT[ability] ?? (locomotion === 'LEAPER' && ability === 'slam' ? 'leap' : 'none'),
      weight: rng.range(0.5, 1),
    };
  };

  // ---- locomotion-mandated opener
  const opener: Partial<Record<LocomotionId, AbilityId>> = {
    LEAPER: 'leap', HOPPER: 'leap', BURROWER: 'burrow', CHARGER: 'charge',
    STALKING: 'ambush', FLOATING: 'blink', SWARM: 'pack',
  };
  const openerAbility = opener[locomotion];
  if (openerAbility) {
    attacks.push(mk(openerAbility, null));
    attackAbilities.add(openerAbility);
  }

  // ---- organ attacks, richest organs first
  for (const organ of ATTACK_ORGAN_ORDER) {
    if (!organs.includes(organ) || used.has(organ)) continue;
    const ability = ORGAN_ABILITY[organ];
    if (attackAbilities.has(ability)) continue;
    // passives are not attacks — they ride the passive list
    if (ability === 'thorn' || ability === 'regen' || ability === 'shield') continue;
    if ((organ === 'EXPLOSIVE_SAC' || ability === 'detonate') && tier !== 'small') {
      // a non-small detonator detonates on death: keep it as an ability, but it is not a swing
      attackAbilities.add(ability);
      used.add(organ);
      continue;
    }
    attacks.push(mk(ability, organ));
    attackAbilities.add(ability);
    used.add(organ);
    if (attacks.length >= budget) break;
  }

  // ---- trim/pad to the budget, melee always available
  while (attacks.length > budget) attacks.pop();
  if (attacks.length === 0) attacks.push(mk('slam', null));
  attacks.forEach((a) => attackAbilities.add(a.ability));

  // ---- MINIMUM kits (plan §29): a boss/apex always fields a full rotation. Pad from a pool of
  // real abilities with their own organs, so the padding also grows visible hardware.
  const minAttacks = role === 'BOSS' || role === 'OVERSEER' ? 3 : role === 'APEX' ? 2 : 1;
  const paddedOrgans: AttackOrgan[] = [];
  const PAD_POOL: [AbilityId, AttackOrgan][] = [
    ['slam', 'JAW'], ['volley', 'BEAM_ORGAN'], ['venomCloud', 'VENOM_GLAND'],
    ['gravPull', 'TAIL'], ['spit', 'PROJECTILE_SAC'], ['web', 'WEB_GLAND'], ['detonate', 'EXPLOSIVE_SAC'],
  ];
  for (const [ability, organ] of PAD_POOL) {
    if (attacks.length >= minAttacks) break;
    if (attackAbilities.has(ability)) continue;
    attacks.push(mk(ability, organ));
    attackAbilities.add(ability);
    paddedOrgans.push(organ);
  }

  // ---- death effects by ecology (plan §26: swarm eats itself, colonies fission)
  const death = DEATH_EFFECTS[ecology];
  if (death && tier !== 'nexus' && tier !== 'boss' && rng.next() < 0.55) attackAbilities.add(death);

  const passives: AbilityId[] = [];
  for (const organ of organs) {
    const ab = ORGAN_ABILITY[organ];
    if ((ab === 'thorn' || ab === 'regen' || ab === 'shield') && !passives.includes(ab)) passives.push(ab);
    if (ab === 'detonate' && !attackAbilities.has('detonate')) passives.push('detonate');
  }

  return { attacks, abilities: [...attackAbilities], passives, paddedOrgans };
}

/** Hunter-cycle profile derived from a LEAPER's leap attack (plan §22/§28). */
export function huntFromAttack(attack: ProcAttack, kind: 1 | 2): {
  kind: 1 | 2;
  leapRange: number;
  leapCd: number;
  impactMul: number;
  impactRadius: number;
  leapTime: number;
  telegraph: number;
  recover: number;
  followUp: boolean;
} {
  return {
    kind,
    leapRange: attack.range + (kind === 1 ? -2 : 2),
    leapCd: Math.max(3.6, attack.cd + (kind === 1 ? 1.2 : -0.6)),
    impactMul: attack.damageMul * (kind === 1 ? 1.25 : 0.95),
    impactRadius: kind === 1 ? 5.4 : 3.4,
    leapTime: kind === 1 ? 0.8 : 0.62,
    telegraph: attack.windup,
    recover: attack.recover,
    followUp: kind === 2,
  };
}
