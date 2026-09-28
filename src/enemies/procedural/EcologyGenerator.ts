// NECROFALL — ECOLOGY GENERATOR (plan §26/§27/§28/§29/§71). The species roster of one planet:
// roles (scavengers, ambushers, spitters, bulwarks, hunters, guardians, apex, boss) assembled
// from the grammars, wired into a food chain, named from the biome's vocabulary, and tuned by
// the RANK RING — complexity first (attack counts, locomotion classes, compound behaviour),
// stats only gently (plan §29: "higher rank should NOT simply mean enemy HP × 10").
import { Rand, clamp } from '../../utils/Utils';
import { applyTraitVisual, type Bestiary, type EnemyGenome, type GenomeVisual, type SpeciesId } from '../EnemyGenomes';
import type { BiomeClass } from '../../world/PlanetArchetypes';
import { deriveArchetype } from '../../world/PlanetArchetypes';
import type { EcoRole, EcologyKind, LocomotionId, PlanetFacts, ProcRelationship } from './EnemyGenome';
import { hash32 } from '../../rankmap/procedural/SeedHash';
import { rollBodyPlan } from './BodyGrammar';
import { rollLimbs } from './LimbGrammar';
import { gaitFor, rollLocomotion } from './LocomotionGrammar';
import { rollOrgans, organVisual } from './OrganGrammar';
import { buildAttacks, huntFromAttack } from './AttackGrammar';
import { behaviorFor } from './BehaviorGrammar';
import { rollTargetPreference } from './TargetGrammar';
import { rollSwarm } from './SwarmGrammar';

// ------------------------------------------------------------ planet facts

export function factsFromDescriptor(seed: number, ring: number, descriptor: {
  biome: BiomeClass | string; ecology: string; corruption: number; temperature: number; difficulty: number; boss: string;
}, landmarkBiases: string[]): PlanetFacts {
  return {
    ring,
    biome: descriptor.biome as BiomeClass,
    ecology: descriptor.ecology as EcologyKind,
    corruption: descriptor.corruption,
    temperature: descriptor.temperature,
    difficulty: descriptor.difficulty,
    bossName: descriptor.boss,
    landmarkBiases,
  };
}

/** Classic / P2P fallback: the world itself carries the facts — derive them from the seed. */
export function factsFromSeed(seed: number, ring = 0): PlanetFacts {
  const arch = deriveArchetype(seed, ring);
  const rng = new Rand((seed ^ 0x51ed270b) >>> 0);
  const kinds: EcologyKind[] = ['AMBUSH_PACK', 'BURROW_COLONY', 'TOXIC_SWARM', 'FERAL_HERD', 'CRYSTAL_GRAZERS', 'VOID_STALKERS'];
  return {
    ring,
    biome: arch.biome,
    ecology: rng.pick(kinds),
    corruption: arch.climate.corruption,
    temperature: arch.climate.temperature,
    difficulty: clamp((ring + 1) / 8 + rng.range(0, 0.12), 0, 1),
    landmarkBiases: [],
  };
}

// ------------------------------------------------------------ naming (plan §71)

const PREFIX: Partial<Record<BiomeClass, string[]>> = {
  FUNGAL: ['Pale', 'Spore', 'Mycel', 'Rot', 'Mire'],
  TOXIC: ['Bile', 'Sludge', 'Fume', 'Caustic', 'Murk'],
  VOLCANIC: ['Cinder', 'Ash', 'Ember', 'Slag', 'Pyre'],
  FROZEN: ['Frost', 'Glacier', 'Rime', 'Pale', 'Hail'],
  CRYSTAL: ['Prism', 'Shard', 'Gleam', 'Facet', 'Lumen'],
  DESERT: ['Dust', 'Dune', 'Scorch', 'Bone', 'Arid'],
  SWAMP: ['Bog', 'Mire', 'Silt', 'Reed', 'Fen'],
  OCEAN: ['Tide', 'Abyss', 'Brine', 'Reef', 'Deep'],
  JUNGLE: ['Vine', 'Canopy', 'Thorn', 'Fern', 'Wild'],
  CORRUPTED: ['Rot', 'Blight', 'Vein', 'Hex', 'Gloom'],
  DEAD: ['Hollow', 'Bone', 'Ash', 'Umbra', 'Void'],
  ABYSSAL: ['Deep', 'Drown', 'Null', 'Trench', 'Gloam'],
};

const NOUN_BY_LOCOMOTION: Record<LocomotionId, string[]> = {
  WALKER: ['Stalker', 'Strider', 'Reaver', 'Marauder'],
  CRAWLER: ['Crawler', 'Skitter', 'Scuttler', 'Runner'],
  LEAPER: ['Pouncer', 'Leaper', 'Vaulter', 'Springer'],
  HOPPER: ['Hopper', 'Bounder', 'Jumper', 'Skipfang'],
  BURROWER: ['Burrower', 'Tunneller', 'Fanggrub', 'Undermaw'],
  SLITHER: ['Coil', 'Writhe', 'Serpent', 'Lash'],
  CHARGER: ['Ravager', 'Crusher', 'Breaker', 'Ramhorn'],
  FLOATING: ['Drifter', 'Wisp', 'Hoverer', 'Lantern'],
  FLYER: ['Vulture', 'Kite', 'Shrike', 'Screecher'],
  STALKING: ['Lurker', 'Watcher', 'Stalker', 'Prowler'],
  SWARM: ['Swarmling', 'Nibbler', 'Teemer', 'Cluster'],
};

const ROLE_SUFFIX: Partial<Record<EcoRole, string>> = {
  HUNTER: ' HUNTER',
  APEX: ' Prime',
  BOSS: ' Guardian',
  OVERSEER: ' OVERSEER',
};

/** Names derive from the genome itself (plan §71): biome word + locomotion noun + role suffix. */
export function enemyName(rng: Rand, facts: PlanetFacts, locomotion: LocomotionId, role: EcoRole, used: Set<string>): string {
  const prefixes = PREFIX[facts.biome] ?? ['Feral', 'Grim', 'Vile', 'Ash'];
  const nouns = NOUN_BY_LOCOMOTION[locomotion];
  for (let guard = 0; guard < 24; guard++) {
    const name = `${rng.pick(prefixes)} ${rng.pick(nouns)}${role === 'HUNTER' ? ' HUNTER' : ROLE_SUFFIX[role] ?? ''}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  const fallback = `${rng.pick(prefixes)} ${rng.pick(nouns)} ${used.size}`;
  used.add(fallback);
  return fallback;
}

export function bossNameFor(facts: PlanetFacts, rng: Rand): string {
  if (facts.bossName && facts.bossName.startsWith('The')) return facts.bossName;
  if (facts.bossName) return `The ${facts.bossName.split(' ').pop()}`.replace(/organism/i, 'Devourer');
  const prefixes = PREFIX[facts.biome] ?? ['Hollow'];
  return `The ${rng.pick(prefixes)} ${rng.pick(['Maw', 'King', 'Warden', 'Tyrant', 'Coil'])}`;
}

// ------------------------------------------------------------ role line-ups per ecology (plan §26)

const ECOLOGY_ROSTERS: Record<EcologyKind, { small: EcoRole[]; large: EcoRole[] }> = {
  AMBUSH_PACK: { small: ['SWARMER', 'SCAVENGER', 'SCOUT'], large: ['AMBUSHER', 'AMBUSHER', 'GUARDIAN'] },
  BURROW_COLONY: { small: ['SCAVENGER', 'SWARMER', 'SWARMER'], large: ['AMBUSHER', 'BULWARK', 'GUARDIAN'] },
  TOXIC_SWARM: { small: ['SWARMER', 'SWARMER', 'SCAVENGER'], large: ['SPITTER', 'AMBUSHER', 'BULWARK'] },
  FERAL_HERD: { small: ['SCAVENGER', 'SCAVENGER', 'SWARMER'], large: ['AMBUSHER', 'SPITTER', 'GUARDIAN'] },
  CRYSTAL_GRAZERS: { small: ['SWARMER', 'SCAVENGER', 'SCOUT'], large: ['BULWARK', 'SPITTER', 'GUARDIAN'] },
  VOID_STALKERS: { small: ['SCAVENGER', 'SWARMER', 'SCOUT'], large: ['AMBUSHER', 'SPITTER', 'BULWARK'] },
};

interface RoleBase {
  hp: number; speed: number; damage: number; attackRange: number; attackCd: number;
  radius: number; xp: number; scale: number; species: SpeciesId;
}

/** Base bodies per role, calibrated against the shipped bestiary's tiers. */
const ROLE_STATS: Record<EcoRole, RoleBase> = {
  SCAVENGER: { hp: 48, speed: 12.6, damage: 9, attackRange: 1.9, attackCd: 1.0, radius: 0.62, xp: 14, scale: 1.3, species: 'crawler' },
  SWARMER: { hp: 64, speed: 11.6, damage: 10, attackRange: 2.0, attackCd: 1.05, radius: 0.68, xp: 16, scale: 1.35, species: 'crawler' },
  SCOUT: { hp: 70, speed: 10.6, damage: 11, attackRange: 12.5, attackCd: 1.7, radius: 0.72, xp: 18, scale: 1.45, species: 'spider' },
  AMBUSHER: { hp: 82, speed: 10.8, damage: 11, attackRange: 2.2, attackCd: 1.2, radius: 0.78, xp: 20, scale: 1.6, species: 'spider' },
  SPITTER: { hp: 120, speed: 7.4, damage: 13, attackRange: 13.5, attackCd: 2.2, radius: 0.95, xp: 24, scale: 1.8, species: 'worm' },
  BULWARK: { hp: 235, speed: 5.0, damage: 20, attackRange: 3.1, attackCd: 2.3, radius: 1.45, xp: 34, scale: 2.3, species: 'brute' },
  GUARDIAN: { hp: 200, speed: 5.6, damage: 18, attackRange: 2.9, attackCd: 2.0, radius: 1.3, xp: 32, scale: 2.1, species: 'brute' },
  HUNTER: { hp: 190, speed: 6.4, damage: 24, attackRange: 3.4, attackCd: 1.9, radius: 1.3, xp: 55, scale: 1.9, species: 'hunter' },
  APEX: { hp: 620, speed: 6.2, damage: 26, attackRange: 3.2, attackCd: 2.0, radius: 1.6, xp: 90, scale: 2.9, species: 'brute' },
  BOSS: { hp: 980, speed: 5.6, damage: 30, attackRange: 3.6, attackCd: 2.1, radius: 1.9, xp: 160, scale: 4.0, species: 'brute' },
  OVERSEER: { hp: 1450, speed: 5.2, damage: 34, attackRange: 3.8, attackCd: 2.2, radius: 2.2, xp: 260, scale: 5.4, species: 'brute' },
};

const TIER_OF: Record<EcoRole, 'small' | 'large' | 'apex' | 'boss' | 'nexus'> = {
  SCAVENGER: 'small', SWARMER: 'small', SCOUT: 'small',
  AMBUSHER: 'large', SPITTER: 'large', BULWARK: 'large', GUARDIAN: 'large',
  HUNTER: 'apex', APEX: 'apex', BOSS: 'boss', OVERSEER: 'nexus',
};

export interface EcologyBestiary extends Bestiary {
  ecologyKind: EcologyKind;
  planetLabel: string;
  roleOf: Record<number, EcoRole>;
  relationships: ProcRelationship[];
}

/**
 * The planet's whole bestiary. Same slots as the shipped generator (3 small, 3 large, the two
 * Hunters, an apex, a Beacon Guardian and the Nexus Overseer) so the spawner, rewards and
 * network code run untouched — but every genome now comes from the grammars.
 */
export function generateEcology(seed: number, facts: PlanetFacts): EcologyBestiary {
  const rng = new Rand((seed ^ 0xb3775f) >>> 0);
  const used = new Set<string>();
  const genomes: EnemyGenome[] = [];
  const roleOf: Record<number, EcoRole> = {};

  const make = (role: EcoRole, forced?: Partial<{ locomotion: LocomotionId; hunter: 1 | 2; boss: boolean; color: number }>): EnemyGenome => {
    const tier = TIER_OF[role];
    const base = ROLE_STATS[role];
    const isBoss = role === 'BOSS' || role === 'OVERSEER' || role === 'APEX';

    // ---- SEED STABILITY (plan §23): every dimension rolls from its OWN hash-derived
    // stream, so changing the body grammar can never silently re-roll the attacks,
    // the movement, the targeting or the colour of every enemy in the universe.
    const enemySeed = hash32(seed, 'enemy', genomes.length, facts.ring, facts.ecology);
    const sub = (salt: string): Rand => new Rand(hash32(enemySeed, salt));

    // ---- locomotion → body → limbs → organs → attacks → behaviour (plan §16 flow)
    const motion = rollLocomotion(sub('motion'), facts.ring, isBoss, forced?.locomotion);
    const locomotion = motion.locomotion;
    const body = rollBodyPlan(sub('body'), role, locomotion, facts.ring);
    const limbs = rollLimbs(sub('limbs'), locomotion, body, facts.ring);
    const organs = rollOrgans(sub('organs'), role, locomotion, facts.ring, facts.landmarkBiases);
    const accent = forced?.color ?? 0xffffff;
    const kit = buildAttacks(sub('attack'), organs.organs, locomotion, role, tier, facts.ring, facts.ecology, accent);
    // Bosses always field a full kit (plan §29) — the padded organs also GROW their hardware.
    const allOrgans = [...organs.organs];
    for (const o of kit.paddedOrgans) if (!allOrgans.includes(o)) allOrgans.push(o);
    const ranged = kit.attacks.some((a) => a.ability === 'spit' || a.ability === 'web' || a.ability === 'volley');
    const behavior = behaviorFor(sub('behaviour'), role, tier, facts.ecology, facts.ring, ranged);
    // targeting + swarming (plan §21/§22) — their own streams, like every other dimension
    const targetPreference = rollTargetPreference(sub('target'), role, facts.ecology, facts.ring);
    const swarm = tier === 'small' ? rollSwarm(sub('swarm'), locomotion, facts.ring) : undefined;

    // ---- visual assembly (plan §18: the traits write into the BODY)
    const visual: GenomeVisual = {
      jelly: 0, segments: 1, membrane: 0, legPairs: 3, legLength: 1, legThickness: 0.1,
      bodyLength: 1, bodyWidth: 1, bodyHeight: 1, plates: 1, spikes: 0, spikeSize: 0.85,
      horns: 0, eyes: 2, mandibles: 2, tail: false, core: false,
      ...body.visual, ...limbs.visual, ...organVisual(allOrgans),
    };
    if (role === 'APEX' || role === 'BOSS' || role === 'OVERSEER') visual.tail = true;
    applyTraitVisual(visual, behavior.traits);
    visual.legPairs = clamp(Math.round(visual.legPairs ?? 0), 0, 6);
    if (limbs.legPairs === 0 && locomotion !== 'FLOATING') visual.legPairs = 0;
    if (visual.segments !== undefined && visual.segments > 1) {
      // a centipede's whole silhouette IS its segment count, so it may run longer than a worm
      visual.segments = clamp(Math.round(visual.segments), 4, visual.rig === 'MYRIAPOD' ? 12 : 10);
    }

    // ---- stats (mild ring pressure; complexity carries the difficulty — plan §29)
    const statsRng = sub('stats');
    const colourRng = sub('colour');
    const nameRng = sub('name');
    const ringHp = 1 + facts.ring * 0.06;
    const ringDmg = 1 + facts.ring * 0.05;
    const corruptionBoost = 1 + clamp(facts.corruption - 0.5, 0, 0.5) * 0.3;
    const jitter = (v: number, spread = 0.12): number => v * (1 + statsRng.range(-spread, spread));
    const color = forced?.color ?? shiftColor(colourRng, facts.biome);

    const name = role === 'BOSS'
      ? bossNameFor(facts, nameRng)
      : role === 'OVERSEER'
        ? `${bossNameFor(facts, nameRng)} OVERSEER`
        : enemyName(nameRng, facts, locomotion, role, used);

    const genome: EnemyGenome = {
      idx: genomes.length,
      species: base.species,
      tier,
      name,
      abilities: [...kit.attacks.map((a) => a.ability), ...kit.passives],
      hp: Math.round(jitter(base.hp * ringHp * corruptionBoost)),
      speed: jitter(base.speed * motion.speedMul * body.speedMul, 0.08),
      damage: Math.max(3, Math.round(jitter(base.damage * ringDmg))),
      attackRange: jitter(base.attackRange, 0.12),
      attackCd: Math.max(0.5, jitter(base.attackCd, 0.1)),
      radius: jitter(base.radius, 0.1),
      xp: Math.round(base.xp * (1 + facts.ring * 0.08)),
      scale: jitter(base.scale, 0.08),
      color,
      accent: accentColor(colourRng, color),
      ranged,
      projSpeed: 26 + statsRng.range(0, 12),
      projColor: accentColor(colourRng, color),
      projKind: kit.attacks.some((a) => a.ability === 'web') ? 'web' : kit.attacks.some((a) => a.ability === 'volley') ? 'volley' : ranged ? 'spit' : 'none',
      projPattern: kit.attacks.find((a) => a.ability === 'spit' || a.ability === 'volley' || a.ability === 'web')?.pattern ?? 'STRAIGHT',
      small: tier === 'small',
      visual,
      elite: false,
      traits: behavior.traits,
      behavior: behavior.profile,
      hunter: forced?.hunter ?? 0,
      // ---- the procedural layer (plan §16/§19/§22/§26) — carried ON the shipped genome
      locomotion,
      gait: gaitFor(locomotion, limbs),
      attacks: kit.attacks,
      role,
      habitat: forced?.hunter ? 'HUNTER STALK' : role === 'BOSS' || role === 'OVERSEER' ? 'NEST HEART' : `${facts.biome} ${locomotion}`,
      armor: body.armor,
      targetPreference,
      swarm,
    } as EnemyGenome;

    // hunters: bake the leap cycle from their own generated leap attack (plan §28)
    if (forced?.hunter) {
      const leap = kit.attacks.find((a) => a.ability === 'leap') ?? kit.attacks[0];
      genome.hunt = huntFromAttack(leap, forced.hunter);
    }
    genomes.push(genome);
    roleOf[genome.idx] = role;
    return genome;
  };

  // ---- roster assembly (plan §26: an ECOSYSTEM, not independent randoms)
  const roster = ECOLOGY_ROSTERS[facts.ecology];
  const smallIdx: number[] = [];
  for (const role of roster.small) smallIdx.push(make(role).idx);
  const largeIdx: number[] = [];
  for (const role of roster.large) largeIdx.push(make(role).idx);

  const hunterIdx: number[] = [];
  hunterIdx.push(make('HUNTER', { hunter: 1, locomotion: 'LEAPER' }).idx);
  hunterIdx.push(make('HUNTER', { hunter: 2, locomotion: 'LEAPER' }).idx);

  const apexIdx = make('APEX').idx;
  const bossIdx = make('BOSS', { locomotion: 'CHARGER' }).idx;
  const nexusIdx = make('OVERSEER', { locomotion: 'CHARGER' }).idx;

  // ---- food chain (plan §27): prey → hunters, guardians → boss, kin pack together
  const relationships: ProcRelationship[] = [];
  for (const s of smallIdx) relationships.push({ targetIdx: hunterIdx[0], kind: 'PREY_OF' });
  relationships.push({ targetIdx: nexusIdx, kind: 'PROTECTS' });
  for (let i = 0; i < smallIdx.length; i++) {
    for (let j = i + 1; j < smallIdx.length; j++) relationships.push({ targetIdx: smallIdx[j], kind: 'PACKS_WITH' });
  }

  return {
    seed,
    genomes,
    bossIdx,
    nexusIdx,
    apexIdx,
    hunterIdx,
    smallIdx,
    largeIdx,
    ecologyKind: facts.ecology,
    planetLabel: `${facts.biome} · ${facts.ecology.replace('_', ' ')} · RING ${facts.ring}`,
    roleOf,
    relationships,
  };
}

// ------------------------------------------------------------ palette

const BIOME_HUE: Partial<Record<BiomeClass, [number, number]>> = {
  FUNGAL: [0.72, 0.88], TOXIC: [0.22, 0.34], VOLCANIC: [0.0, 0.08], FROZEN: [0.5, 0.6],
  CRYSTAL: [0.5, 0.62], DESERT: [0.09, 0.14], SWAMP: [0.24, 0.34], OCEAN: [0.5, 0.62],
  JUNGLE: [0.28, 0.4], CORRUPTED: [0.86, 0.98], DEAD: [0.66, 0.78], ABYSSAL: [0.6, 0.72],
};

/** Species colour: the biome owns the hue family, the seed picks inside it. */
function shiftColor(rng: Rand, biome: BiomeClass): number {
  const [h0, h1] = BIOME_HUE[biome] ?? [0, 1];
  const h = h0 + rng.next() * (h1 - h0);
  const s = 0.55 + rng.next() * 0.3;
  const l = 0.42 + rng.next() * 0.22;
  return hslToHex(h, s, l);
}

function accentColor(rng: Rand, base: number): number {
  const r = (base >> 16) & 255, g = (base >> 8) & 255, b = base & 255;
  const lift = 1.35 + rng.next() * 0.3;
  return (
    (Math.min(255, Math.round(r * lift)) << 16) |
    (Math.min(255, Math.round(g * lift)) << 8) |
    Math.min(255, Math.round(b * lift))
  );
}

function hslToHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(clamp(c, 0, 1) * 255);
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}
