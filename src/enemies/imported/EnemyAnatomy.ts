import { Rand } from '../../utils/Utils';
import type { EnemyGenome } from '../EnemyGenomes';

export type BaseGenome = 'crawler' | 'parasite' | 'behemoth';
export type AnatomicalAttack = 'bite' | 'claw' | 'tail' | 'stomp' | 'spit';

export interface EnemyAnatomy {
  base: BaseGenome;
  headBase?: BaseGenome;
  armBase?: BaseGenome;
  tailBase?: BaseGenome;
  body: number;
  head: number;
  limbs: number;
  tail: number;
  wings: boolean;
  size: number;
  color: number;
  accent: number;
  attack: AnatomicalAttack;
}

export function capabilities(anatomy: EnemyAnatomy, giant = false) {
  const heavy = giant || anatomy.base === 'behemoth' || anatomy.size * anatomy.body > 2.6;
  return {
    heavy,
    supportLegs: anatomy.base === 'crawler' ? 4 : 2,
    canLeap: !heavy && anatomy.limbs >= 0.9,
    canFly: !heavy && anatomy.base === 'parasite' && anatomy.wings,
    canSpit: (anatomy.headBase ?? anatomy.base) !== 'behemoth',
    canTailStrike: anatomy.tail >= 0.75,
    maxStep: anatomy.size * anatomy.limbs * (heavy ? 0.16 : 0.24),
  };
}

export function legalAttacks(anatomy: EnemyAnatomy, giant = false): AnatomicalAttack[] {
  const body = capabilities(anatomy, giant);
  const attacks: AnatomicalAttack[] = anatomy.base === 'crawler' ? ['bite'] : ['claw'];
  if (body.heavy) attacks.push('stomp');
  if (body.canSpit) attacks.push('spit');
  if (body.canTailStrike) attacks.push('tail');
  return attacks;
}

export function normalizeAnatomy(input: EnemyAnatomy, giant = false): EnemyAnatomy {
  const finite = (value: number, fallback: number, low: number, high: number) =>
    Math.min(high, Math.max(low, Number.isFinite(value) ? value : fallback));
  const validBase = (base: BaseGenome | undefined) => ['crawler', 'parasite', 'behemoth'].includes(base ?? '') ? base! : input.base;
  const anatomy = { ...input,
    headBase: validBase(input.headBase),
    armBase: input.base,
    tailBase: validBase(input.tailBase),
    body: finite(input.body, 1, 0.8, 1.25), head: finite(input.head, 1, 0.75, 1.3),
    limbs: finite(input.limbs, 1, 0.8, 1.25), tail: input.tail === 0 ? 0 : finite(input.tail, 1, 0.75, 1.3),
    size: finite(input.size, 1, 0.5, 8),
    wings: input.base === 'parasite' && input.wings,
  };
  const attacks = legalAttacks(anatomy, giant);
  if (!attacks.includes(anatomy.attack)) anatomy.attack = attacks[0];
  return anatomy;
}

export function generateAnatomy(genome: EnemyGenome, seed: number): EnemyAnatomy {
  const rng = new Rand((seed ^ Math.imul(genome.idx + 1, 0x45d9f3b)) >>> 0);
  const bases: BaseGenome[] = ['crawler', 'parasite', 'behemoth'];
  const base = genome.tier === 'boss' ? bases[(genome.idx + seed % 3) % 3]
    : genome.tier === 'nexus' ? rng.pick(bases)
      : genome.species === 'crawler' || genome.hunter ? 'crawler'
        : genome.species === 'brute' ? 'behemoth' : 'parasite';
  const anatomy: EnemyAnatomy = {
    base, body: rng.range(0.88, 1.16), head: rng.range(0.82, 1.22), limbs: rng.range(0.9, 1.2),
    tail: rng.next() < 0.22 ? 0 : rng.range(0.8, 1.2), wings: base === 'parasite' && rng.next() < 0.55,
    size: genome.scale, color: genome.color, accent: genome.accent, attack: 'bite',
  };
  anatomy.headBase = rng.next() < 0.3 ? rng.pick(bases) : base;
  anatomy.armBase = base;
  anatomy.tailBase = rng.next() < 0.25 ? rng.pick(bases) : base;
  anatomy.attack = rng.pick(legalAttacks(anatomy, genome.tier === 'boss' || genome.tier === 'nexus'));
  return normalizeAnatomy(anatomy, genome.tier === 'boss' || genome.tier === 'nexus');
}

export function applyAnatomy(genome: EnemyGenome, seed: number): void {
  const anatomy = genome.anatomy = generateAnatomy(genome, seed);
  const body = capabilities(anatomy, genome.tier === 'boss' || genome.tier === 'nexus');
  genome.visual.legPairs = body.supportLegs / 2;
  genome.visual.wings = anatomy.wings ? 2 : 0;
  genome.visual.tail = anatomy.tail > 0;
  if (!body.canFly && (genome.locomotion === 'FLYER' || genome.locomotion === 'FLOATING')) genome.locomotion = 'WALKER';
  if (!body.canLeap) {
    genome.abilities = genome.abilities.filter(ability => ability !== 'leap');
    genome.attacks = genome.attacks?.filter(attack => attack.ability !== 'leap');
    genome.bossHeavy = genome.bossHeavy?.filter(attack => attack !== 'rageleap');
    if (genome.locomotion === 'LEAPER' || genome.locomotion === 'HOPPER') genome.locomotion = 'WALKER';
    genome.hunter = 0;
    genome.hunt = undefined;
  }
  if (!body.canSpit) {
    genome.abilities = genome.abilities.filter(ability => !['spit', 'web', 'volley'].includes(ability));
    genome.attacks = genome.attacks?.filter(attack => !['spit', 'web', 'volley'].includes(attack.ability));
    genome.ranged = false;
    genome.projKind = 'none';
    genome.attackRange = Math.min(genome.attackRange, 4);
  }
  if (body.heavy) genome.speed = Math.min(genome.speed, 6.2);
}