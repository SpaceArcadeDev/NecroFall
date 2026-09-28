// NECROFALL — TARGETING GRAMMAR (plan §21). Enemies must not all run at the nearest
// player: the genome's target preference is what gives an encounter its personality —
// wound-hunters, straggler-stalkers, pack-breakers, grudge-holders.
//
// The weights are role- and ring-aware: simple preferences live in the low rings,
// the exotic ones (grudges, damage-seeking) only appear deeper in the universe.
import type { Rand } from '../../utils/Utils';
import type { EcoRole, EcologyKind, TargetPreference } from './EnemyGenome';

export const TARGET_BLURB: Record<TargetPreference, string> = {
  NEAREST: 'runs at the closest prey',
  LOWEST_HP: 'hunts the wounded',
  HIGHEST_DAMAGE: 'goes for the heaviest hitter',
  ISOLATED: 'stalks the loneliest straggler',
  COLONY_TARGET: 'breaks up the clustered pack',
  RANDOM: 'targets erratically',
  LAST_ATTACKER: 'remembers who hurt it',
  OBJECTIVE_TARGET: 'defends the objective',
};

interface Weighted {
  pref: TargetPreference;
  w: number;
}

/** Base weights per role (plan §21/§29: roles own their hunting style). */
function weightsFor(role: EcoRole, ring: number): Weighted[] {
  const w: Weighted[] = [
    { pref: 'NEAREST', w: 10 },
    { pref: 'LOWEST_HP', w: 6 + ring },
    { pref: 'HIGHEST_DAMAGE', w: ring >= 3 ? 4 : 0 },
    { pref: 'ISOLATED', w: 5 },
    { pref: 'COLONY_TARGET', w: 4 + (ring >= 2 ? 3 : 0) },
    { pref: 'RANDOM', w: 3 },
    { pref: 'LAST_ATTACKER', w: ring >= 3 ? 4 : 1 },
    { pref: 'OBJECTIVE_TARGET', w: 0 },
  ];
  switch (role) {
    case 'HUNTER':
      w.push({ pref: 'ISOLATED', w: 6 }, { pref: 'LAST_ATTACKER', w: 6 });
      break;
    case 'AMBUSHER':
      w.push({ pref: 'ISOLATED', w: 5 }, { pref: 'LOWEST_HP', w: 4 });
      break;
    case 'SPITTER':
    case 'SCOUT':
      w.push({ pref: 'NEAREST', w: 4 }, { pref: 'HIGHEST_DAMAGE', w: ring >= 3 ? 3 : 0 });
      break;
    case 'GUARDIAN':
      w.push({ pref: 'OBJECTIVE_TARGET', w: 10 }, { pref: 'COLONY_TARGET', w: 4 });
      break;
    case 'BULWARK':
      w.push({ pref: 'COLONY_TARGET', w: 6 });
      break;
    case 'SWARMER':
      w.push({ pref: 'COLONY_TARGET', w: 6 }, { pref: 'RANDOM', w: 3 });
      break;
    case 'APEX':
    case 'BOSS':
    case 'OVERSEER':
      w.push({ pref: 'HIGHEST_DAMAGE', w: 5 }, { pref: 'OBJECTIVE_TARGET', w: 4 });
      break;
    default:
      break;
  }
  return w;
}

/** Rolls the preference — one weighted pick with ecology bias (plan §21/§26). */
export function rollTargetPreference(rng: Rand, role: EcoRole, ecology: EcologyKind, ring: number): TargetPreference {
  const w = weightsFor(role, ring);
  // ecology bias: stealthy ecologies stalk stragglers, swarms like breaking up packs
  if (ecology === 'AMBUSH_PACK' || ecology === 'VOID_STALKERS') {
    const iso = w.find((e) => e.pref === 'ISOLATED');
    if (iso) iso.w += 5;
  }
  if (ecology === 'TOXIC_SWARM' || ecology === 'FERAL_HERD') {
    const c = w.find((e) => e.pref === 'COLONY_TARGET');
    if (c) c.w += 4;
  }
  let total = 0;
  for (const e of w) total += e.w;
  let pick = rng.next() * total;
  for (const e of w) {
    pick -= e.w;
    if (pick <= 0) return e.pref;
  }
  return 'NEAREST';
}
