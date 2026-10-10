// NECROFALL — procedural Necrophage bestiary.
// Every match generates its own set of creature *genomes* from the match seed:
// body plan (legged / jelly / segmented), stats, palette and a unique ability loadout.
// Species are original designs inspired only by broad creature archetypes
// (jelly blobs, burrowing worms, web spiders, fast crawlers, heavy brutes).
import { Rand, clamp } from '../utils/Utils';
import type { EnemyAnatomy } from './imported/EnemyAnatomy';
import type { AttackPattern, BossHeavyId, EcoRole, GaitProfile, LocomotionId, ProcAttack, ProcRelationship, SwarmProfile, TargetPreference } from './procedural/EnemyGenome';

export type SpeciesId = 'slime' | 'worm' | 'spider' | 'crawler' | 'brute' | 'hunter';
export type Tier = 'small' | 'large' | 'apex' | 'boss' | 'nexus';

/**
 * BEHAVIOURAL CHARACTERISTIC — rolled per genome, exactly like body parts and abilities.
 *
 * A creature never gets all of them: a genome carries ONE to THREE, and those decide how it
 * hunts (see `BehaviorProfile`). The same list drives the body plan, so a player can read an
 * approaching Necrophage: forward-horned and thick-plated means it will close and hold ground,
 * lean and long-legged means it will run, glowing sacs mean it will burst.
 */
export type BehaviorTrait =
  | 'aggressive'    // closes hard, swings fast, bigger jaws and spikes
  | 'defensive'     // plated, slows down, braces when hurt
  | 'territorial'   // holds ground near where it spawned
  | 'pack'          // hunts with nearby kin, moves in groups
  | 'cowardly'      // breaks off and runs when hurt
  | 'fleeing'       // lighter, faster retreat, longer legs
  | 'ranged'        // keeps its distance, spits / volleys
  | 'charging'      // winds up and sprints into the target
  | 'protective'    // stays near and shields its kin
  | 'explosive'     // volatile body, detonates
  | 'persistent';   // never gives up a chase

/** One line per trait, for the genome inspection / debug surfaces. */
export const TRAIT_BLURB: Record<BehaviorTrait, string> = {
  aggressive: 'closes fast and hits hard',
  defensive: 'armoured, braces when wounded',
  territorial: 'holds the ground it spawned on',
  pack: 'hunts with nearby kin',
  cowardly: 'runs when badly hurt',
  fleeing: 'light frame, fast retreat',
  ranged: 'attacks from range',
  charging: 'winds up and charges',
  protective: 'shields nearby kin',
  explosive: 'volatile — detonates',
  persistent: 'never abandons a chase',
};

/**
 * The numeric face of a trait list. Every field is read by the simulation, so adding a trait never
 * means adding a branch to the AI: a new characteristic is a new row in `TRAIT_PROFILE` plus one
 * line in `pickTraits`.
 */
export interface BehaviorProfile {
  /** How far it will chase before turning back (m). 0 = it never gives up. */
  pursuitRange: number;
  /** Move-speed multiplier while chasing. */
  chaseSpeedMul: number;
  /** Move-speed multiplier while withdrawing. */
  fleeSpeedMul: number;
  /** Health fraction at or below which a skittish creature breaks off. 0 = never flees. */
  fleeHp: number;
  /** Seconds it keeps running once spooked. */
  fleeTime: number;
  /** Extra standoff distance: how much further out it prefers to fight (m, may be negative). */
  standoff: number;
  /** How strongly it prefers a target its kin are already fighting (0..1). */
  groupBias: number;
  /** Radius around its spawn it refuses to leave (m). 0 = free roamer. */
  territory: number;
  /** Keeps nearby kin alive (protective). */
  guardian: boolean;
  /** Explosion radius left behind on death (m). 0 = none. */
  deathBlast: number;
  /** Attack-cadence multiplier: > 1 swings faster. */
  attackRateMul: number;
  /** Damage multiplier on this creature's own hits. */
  damageMul: number;
  /** Leg-cycle speed and swing amplitude, so behaviour reads in the animation too. */
  animSpeedMul: number;
  animAmpMul: number;
  /** How long one AI decision is cached (s). Nothing thinks every frame. */
  thinkInterval: number;
}

/** Per-trait contributions. Multipliers compose, flags OR together. */
interface TraitMod {
  pursuitRange?: number;
  chaseSpeedMul?: number;
  fleeSpeedMul?: number;
  fleeHp?: number;
  fleeTime?: number;
  standoff?: number;
  groupBias?: number;
  territory?: number;
  guardian?: boolean;
  deathBlast?: number;
  attackRateMul?: number;
  damageMul?: number;
  animSpeedMul?: number;
  animAmpMul?: number;
  thinkInterval?: number;
}

const TRAIT_PROFILE: Record<BehaviorTrait, TraitMod> = {
  aggressive: { chaseSpeedMul: 1.14, attackRateMul: 1.25, damageMul: 1.12, standoff: -0.4, animSpeedMul: 1.2, animAmpMul: 1.15 },
  defensive: { chaseSpeedMul: 0.88, damageMul: 0.95, standoff: 0.4, animSpeedMul: 0.9, animAmpMul: 1.1 },
  territorial: { pursuitRange: 34, territory: 26, chaseSpeedMul: 0.95, standoff: 0.2 },
  pack: { groupBias: 0.8, chaseSpeedMul: 1.08, animSpeedMul: 1.1 },
  cowardly: { fleeHp: 0.32, fleeTime: 3.4, fleeSpeedMul: 1.35, chaseSpeedMul: 0.95, animSpeedMul: 1.15 },
  fleeing: { fleeHp: 0.45, fleeTime: 4.2, fleeSpeedMul: 1.5, pursuitRange: 26, animSpeedMul: 1.2 },
  ranged: { standoff: 3.2, chaseSpeedMul: 0.92 },
  charging: { chaseSpeedMul: 1.2, attackRateMul: 0.9, damageMul: 1.15, animSpeedMul: 1.1, animAmpMul: 1.25 },
  protective: { groupBias: 0.5, guardian: true, chaseSpeedMul: 0.94 },
  explosive: { deathBlast: 5.4, chaseSpeedMul: 1.1, animSpeedMul: 1.05 },
  persistent: { pursuitRange: 200, chaseSpeedMul: 1.06 },
};

const NEUTRAL_PROFILE: BehaviorProfile = {
  pursuitRange: 62, chaseSpeedMul: 1, fleeSpeedMul: 1, fleeHp: 0, fleeTime: 0,
  standoff: 0, groupBias: 0, territory: 0, guardian: false, deathBlast: 0,
  attackRateMul: 1, damageMul: 1, animSpeedMul: 1, animAmpMul: 1, thinkInterval: 0.25,
};

/** Folds a trait list into one cheap numeric profile. */
export function buildBehavior(traits: BehaviorTrait[], tier: Tier): BehaviorProfile {
  const out: BehaviorProfile = { ...NEUTRAL_PROFILE };
  for (const t of traits) {
    const m = TRAIT_PROFILE[t];
    if (!m) continue;
    if (m.pursuitRange !== undefined) out.pursuitRange = out.pursuitRange === NEUTRAL_PROFILE.pursuitRange ? m.pursuitRange : Math.max(out.pursuitRange, m.pursuitRange);
    if (m.chaseSpeedMul !== undefined) out.chaseSpeedMul *= m.chaseSpeedMul;
    if (m.fleeSpeedMul !== undefined) out.fleeSpeedMul *= m.fleeSpeedMul;
    if (m.fleeHp !== undefined) out.fleeHp = Math.max(out.fleeHp, m.fleeHp);
    if (m.fleeTime !== undefined) out.fleeTime = Math.max(out.fleeTime, m.fleeTime);
    if (m.standoff !== undefined) out.standoff += m.standoff;
    if (m.groupBias !== undefined) out.groupBias = Math.max(out.groupBias, m.groupBias);
    if (m.territory !== undefined) out.territory = Math.max(out.territory, m.territory);
    if (m.guardian) out.guardian = true;
    if (m.deathBlast !== undefined) out.deathBlast = Math.max(out.deathBlast, m.deathBlast);
    if (m.attackRateMul !== undefined) out.attackRateMul *= m.attackRateMul;
    if (m.damageMul !== undefined) out.damageMul *= m.damageMul;
    if (m.animSpeedMul !== undefined) out.animSpeedMul *= m.animSpeedMul;
    if (m.animAmpMul !== undefined) out.animAmpMul *= m.animAmpMul;
  }
  // The big tiers cannot be skittish AND organised — a boss that ran away would read as broken.
  if (tier === 'boss' || tier === 'nexus') {
    out.fleeHp = 0;
    out.pursuitRange = Math.max(out.pursuitRange, 150);
    out.thinkInterval = 0.2;
  } else if (tier === 'apex') {
    out.fleeHp = 0;
    out.pursuitRange = Math.max(out.pursuitRange, 110);
  }
  return out;
}

/** Labels for a genome's traits — shown on debug plates and in generated blurbs. */
export function traitLabels(traits: BehaviorTrait[]): string[] {
  return traits.map(t => t.toUpperCase());
}

export type AbilityId =
  // attacks
  | 'spit' | 'web' | 'volley' | 'slam' | 'venomCloud'
  // movement
  | 'charge' | 'leap' | 'blink' | 'burrow' | 'ambush'
  // passives / reactions
  | 'thorn' | 'siphon' | 'frenzy' | 'regen' | 'shield' | 'gravPull' | 'pack'
  // death effects
  | 'split' | 'spawnlings' | 'detonate';

export interface AbilityMeta {
  name: string;
  cd: number;
  blurb: string;
}

export const ABILITY_META: Record<AbilityId, AbilityMeta> = {
  spit: { name: 'Acid Spit', cd: 2.1, blurb: 'spits corrosive bolts' },
  web: { name: 'Web Shot', cd: 3.0, blurb: 'webs and slows its prey' },
  volley: { name: 'Fan Volley', cd: 4.4, blurb: 'fires a fan of spines' },
  slam: { name: 'Ground Slam', cd: 5.2, blurb: 'shockwave slam' },
  venomCloud: { name: 'Venom Trail', cd: 5.5, blurb: 'leaves a toxic cloud' },
  charge: { name: 'Charge', cd: 7.0, blurb: 'sprints at its target' },
  leap: { name: 'Pounce', cd: 6.0, blurb: 'leaps onto its prey' },
  blink: { name: 'Blink', cd: 8.0, blurb: 'teleports short distances' },
  burrow: { name: 'Burrow', cd: 9.0, blurb: 'burrows away, untouchable' },
  ambush: { name: 'Ambush', cd: 12.0, blurb: 'hides until it strikes' },
  thorn: { name: 'Barbed Hide', cd: 0, blurb: 'barbs retaliate on hit' },
  siphon: { name: 'Siphon', cd: 0, blurb: 'heals with every hit' },
  frenzy: { name: 'Frenzy', cd: 0, blurb: 'attacks faster as it bleeds' },
  regen: { name: 'Regrowth', cd: 0, blurb: 'regenerates while unobserved' },
  shield: { name: 'Plating', cd: 9.0, blurb: 'bracelets of hardened plating' },
  gravPull: { name: 'Gravitic Pull', cd: 8.0, blurb: 'drags prey toward it' },
  pack: { name: 'Rally', cd: 14.0, blurb: 'calls nearby kin' },
  split: { name: 'Fission', cd: 0, blurb: 'splits into two on death' },
  spawnlings: { name: 'Brood', cd: 0, blurb: 'bursts into swarmlings' },
  detonate: { name: 'Volatile', cd: 0, blurb: 'explodes on death' },
};

export interface GenomeVisual {
  /** 1 = legless jelly blob, 0 = legged */
  jelly: number;
  /** >1 = segmented body chain (worm-like) */
  segments: number;
  /** 0..1 translucency for membranes */
  membrane: number;
  legPairs: number;
  legLength: number;
  legThickness: number;
  bodyLength: number;
  bodyWidth: number;
  bodyHeight: number;
  plates: number;
  spikes: number;
  spikeSize: number;
  horns: number;
  eyes: number;
  mandibles: number;
  tail: boolean;
  core: boolean;
  /** Dorsal organs that read as "this thing shoots" (ranged trait). */
  tubes?: number;
  /** Volatile glowing sacs (explosive trait). */
  glowNodes?: number;
  /** Side flippers — FLOATING locomotion (plan §19). */
  fins?: number;
  /** Membrane wings — FLOATING at higher rings; the AVIAN rig's whole silhouette. Animated. */
  wings?: number;
  /** Rear storage organs — LEAPER compression / CHARGER build-up. */
  sacs?: number;
  /** Hooked forelimbs — ambushers and leapers. */
  claws?: number;
  /**
   * STRUCTURAL RIG (the models): which body ARCHITECTURE the assembler builds. The shipped three
   * (legged chassis, jelly sac, segmented worm) grow four more — an avian (wings + long neck +
   * talons), a myriapod (segment chain with a leg pair per segment), a wraith (a hovering core
   * ringed by orbiting shards) and a mollusk (a bulbed shell trailing writhing tentacles). Absent →
   * inferred from `segments`/`jelly`, exactly like the original three-way branch.
   */
  rig?: 'CHASSIS' | 'JELLY' | 'WORM' | 'AVIAN' | 'MYRIAPOD' | 'WRAITH' | 'MOLLUSK';
  /** Radial tentacles writhing around the body (MOLLUSK / WRAITH). Animated. */
  tentacles?: number;
  /** Orbiting shards around the body (WRAITH) — a revolving crown of crystal. Animated. */
  shards?: number;
  /** Feather plumes: tail fans and crests (AVIAN sensors). */
  plumes?: number;
}

export interface EnemyGenome {
  anatomy?: EnemyAnatomy;
  idx: number;
  species: SpeciesId;
  tier: Tier;
  name: string;
  abilities: AbilityId[];
  hp: number;
  speed: number;
  damage: number;
  attackRange: number;
  attackCd: number;
  radius: number;
  xp: number;
  scale: number;
  color: number;
  accent: number;
  ranged: boolean;
  projSpeed: number;
  projColor: number;
  projKind: 'spit' | 'web' | 'volley' | 'none';
  small: boolean;
  visual: GenomeVisual;
  elite: boolean;
  /** Behavioural characteristics rolled for this genome (1..3 of them). */
  traits: BehaviorTrait[];
  /** The numeric face of `traits` — what the simulation actually reads. */
  behavior: BehaviorProfile;
  /** 0 = an ordinary Necrophage; 1 / 2 = one of the two Hunter Necrophages. */
  hunter: 0 | 1 | 2;
  /** Hunter-only tuning: the leap cycle. */
  hunt?: HunterProfile;
  // ----------------------------------------------------------------------------------------
  // THE PROCEDURAL LAYER (plan §16–§29) — written by `enemies/procedural/` and read by the
  // animator + debug surfaces. All optional: the shipped simulation runs with or without it.
  /** Movement class (plan §19) — drives the gait animator. */
  locomotion?: LocomotionId;
  /** The gait the animator plays. */
  gait?: GaitProfile;
  /** Generated attack descriptors: telegraphs, wind-ups, sequencing (plan §22/§23). */
  attacks?: ProcAttack[];
  /** Ecology role within the planet's ecosystem (plan §26). */
  role?: EcoRole;
  /** Where it lives — biome + locomotion, for plates and the lab. */
  habitat?: string;
  /** Food-chain links (plan §27). */
  relationships?: ProcRelationship[];
  /** Incoming-damage multiplier from the body plan (plan §18: shell = tanky). 1 = none. */
  armor?: number;
  /** WHO it prefers to fight (plan §21) — read by `decide()`. */
  targetPreference?: TargetPreference;
  /** Swarm steering + formation (plan §22) — small tiers only. */
  swarm?: SwarmProfile;
  /** The pattern its signature projectile attack fires (plan §19) — mirrors its attack kit. */
  projPattern?: AttackPattern;
  /**
   * The boss's own heavy rotation (plan §24) — written by the generator, so each Beacon Guardian
   * fields its own set of telegraphed heavies instead of every warden running the same script
   * (see `pickBossMechanics`, which falls back to deriving one from the body + kit when absent).
   */
  bossHeavy?: BossHeavyId[];
}

/**
 * The two Hunter Necrophages share ONE simple, readable plan: walk in slowly, leap, land hard,
 * recover, repeat. They differ in their committed values rather than in their rules, which is why
 * both are expressible with this one block.
 */
export interface HunterProfile {
  /** 1 = the heavy Ripper, 2 = the long-stride Pouncer. */
  kind: 1 | 2;
  /** Surface distance at which it commits to the leap (m). */
  leapRange: number;
  /** Seconds between leaps. */
  leapCd: number;
  /** Damage multiplier on the landing impact, relative to its own melee. */
  impactMul: number;
  /** Landing shockwave radius (m). */
  impactRadius: number;
  /** Seconds the leap itself takes — longer means a slower, heavier arc. */
  leapTime: number;
  /**
   * Seconds of WIND-UP before the leap: the hunter plants itself on the mark the ground telegraph
   * drew and coils, and only then launches. This is the player's dodge window — the arc itself is
   * too fast to read.
   */
  telegraph: number;
  /** Seconds of recovery after it lands (its punish window). */
  recover: number;
  /** Hunter 2 lands a follow-up bite a beat after the slam. */
  followUp: boolean;
}

export interface Bestiary {
  seed: number;
  genomes: EnemyGenome[];
  /**
   * The FOUR Beacon Guardians, in Beacon order (0-3). Each Beacon keeps its own warden, generated
   * from its own stream — two Beacons never field the same creature, so a match is four different
   * tower fights instead of the same boss four times (the "guardians are all identical" report).
   */
  bossIdxes: number[];
  nexusIdx: number;
  apexIdx: number;
  smallIdx: number[];
  largeIdx: number[];
  /** The two Hunter Necrophages, in kind order (1, 2). */
  hunterIdx: number[];
}

interface SpeciesTemplate {
  visual: GenomeVisual;
  base: { hp: number; speed: number; damage: number; attackRange: number; attackCd: number; radius: number; xp: number; scale: number };
  abilities: AbilityId[];
  names: string[];
  color: number;
  accent: number;
}

const V = (o: Partial<GenomeVisual>): GenomeVisual => ({
  jelly: 0, segments: 1, membrane: 0, legPairs: 3, legLength: 1, legThickness: 0.1,
  bodyLength: 1, bodyWidth: 1, bodyHeight: 1, plates: 1, spikes: 0, spikeSize: 0.8,
  horns: 0, eyes: 2, mandibles: 2, tail: false, core: false, ...o,
});

const SPECIES: Record<SpeciesId, SpeciesTemplate> = {
  slime: {
    visual: V({ jelly: 1, legPairs: 0, segments: 1, membrane: 0.75, plates: 1, spikes: 2, eyes: 3, bodyHeight: 1.1, bodyWidth: 1.15, core: true }),
    base: { hp: 90, speed: 7.6, damage: 12, attackRange: 2.2, attackCd: 1.6, radius: 0.8, xp: 18, scale: 1.6 },
    abilities: ['leap', 'split', 'detonate', 'venomCloud', 'regen', 'siphon', 'spit'],
    names: ['Ooze', 'Sludge', 'Muck', 'Gel', 'Blob', 'Slime'],
    color: 0x6bffb0, accent: 0xd8fff0,
  },
  worm: {
    visual: V({ jelly: 0.35, legPairs: 0, segments: 6, membrane: 0.3, plates: 2, spikes: 3, eyes: 2, bodyLength: 1.5, bodyWidth: 0.6, mandibles: 4 }),
    base: { hp: 130, speed: 6.6, damage: 16, attackRange: 2.7, attackCd: 1.7, radius: 1.0, xp: 24, scale: 1.9 },
    abilities: ['burrow', 'charge', 'slam', 'spit', 'spawnlings', 'regen', 'thorn'],
    names: ['Grub', 'Writhe', 'Burrower', 'Nematode', 'Coil'],
    color: 0xffb347, accent: 0xfff0d0,
  },
  spider: {
    visual: V({ legPairs: 4, legLength: 1.15, legThickness: 0.075, plates: 2, spikes: 4, eyes: 4, bodyWidth: 0.95, bodyLength: 1.1, tail: false, core: false }),
    base: { hp: 70, speed: 10.6, damage: 11, attackRange: 2.2, attackCd: 1.2, radius: 0.8, xp: 20, scale: 1.7 },
    abilities: ['web', 'ambush', 'blink', 'pack', 'spit', 'leap', 'frenzy'],
    names: ['Weaver', 'Skitter', 'Webspinner', 'Lurker', 'Stalker'],
    color: 0x9a6bff, accent: 0xe0d3ff,
  },
  crawler: {
    visual: V({ legPairs: 3, legLength: 1.1, legThickness: 0.085, plates: 1, spikes: 3, eyes: 2, tail: true, bodyLength: 1.15, bodyWidth: 0.85, core: false }),
    base: { hp: 60, speed: 12.6, damage: 9, attackRange: 1.9, attackCd: 1.0, radius: 0.65, xp: 14, scale: 1.3 },
    abilities: ['charge', 'frenzy', 'thorn', 'leap', 'spawnlings', 'siphon', 'pack'],
    names: ['Crawler', 'Scuttler', 'Runner', 'Prowler', 'Chaser'],
    color: 0xff6b6b, accent: 0xffd7d7,
  },
  brute: {
    visual: V({ legPairs: 3, legLength: 1.05, legThickness: 0.19, plates: 4, spikes: 8, spikeSize: 1.05, horns: 4, eyes: 3, bodyWidth: 1.35, bodyHeight: 1.15, core: true }),
    base: { hp: 215, speed: 5.2, damage: 22, attackRange: 3.2, attackCd: 2.2, radius: 1.5, xp: 34, scale: 2.4 },
    abilities: ['slam', 'shield', 'gravPull', 'volley', 'thorn', 'venomCloud', 'regen'],
    names: ['Brute', 'Colossus', 'Ravager', 'Crusher', 'Hulk'],
    color: 0xffd166, accent: 0xfff3cf,
  },
  // The Hunter Necrophages: a deliberately top-heavy, horned silhouette so "this creature hunts
  // players" is legible before it moves. Both kinds share the template and differ by hunt profile.
  hunter: {
    visual: V({
      legPairs: 3, legLength: 1.3, legThickness: 0.16, plates: 3, spikes: 7, spikeSize: 1.2,
      horns: 6, eyes: 4, mandibles: 4, bodyLength: 1.3, bodyWidth: 1.2, bodyHeight: 1.1,
      tail: true, core: true, glowNodes: 2, membrane: 0.15,
    }),
    base: { hp: 190, speed: 6.4, damage: 24, attackRange: 3.4, attackCd: 1.9, radius: 1.3, xp: 55, scale: 1.9 },
    abilities: ['leap', 'slam', 'frenzy'],
    names: ['Ripper', 'Pouncer', 'Stalker', 'Render', 'Harrow'],
    color: 0xff5a3d, accent: 0xffd0b8,
  },
};

const PREFIX = ['Ashen', 'Rot', 'Pale', 'Vile', 'Hollow', 'Gloom', 'Feral', 'Cinder', 'Frost', 'Toxic', 'Bone', 'Mire', 'Umbra', 'Rust'];
const TIER_SUFFIX: Record<Tier, string> = {
  small: '', large: '', apex: ' Prime', boss: ' Guardian', nexus: ' OVERSEER',
};

const TIER_MUL: Record<Tier, { hp: number; scale: number; speed: number; dmg: number; xp: number; cd: number }> = {
  small: { hp: 0.34, scale: 0.82, speed: 1.18, dmg: 0.55, xp: 0.4, cd: 0.85 },
  large: { hp: 1, scale: 1.6, speed: 1, dmg: 1, xp: 1, cd: 1 },
  apex: { hp: 3.4, scale: 3.0, speed: 0.68, dmg: 1.5, xp: 3.4, cd: 1.5 },
  boss: { hp: 5.2, scale: 4.2, speed: 0.8, dmg: 2.0, xp: 9, cd: 1.8 },
  nexus: { hp: 12.5, scale: 6.0, speed: 0.72, dmg: 2.4, xp: 16, cd: 2.0 },
};

function pickAbilities(rand: Rand, pool: AbilityId[], count: number): AbilityId[] {
  const options = [...pool];
  const out: AbilityId[] = [];
  for (let i = 0; i < count && options.length > 0; i++) {
    const at = rand.int(0, options.length - 1);
    out.push(options[at]);
    options.splice(at, 1);
  }
  return out;
}

function makeGenome(
  rand: Rand,
  idx: number,
  species: SpeciesId,
  tier: Tier,
  abilityCount: number,
  usedNames: Set<string>,
  opts: { hunter?: 1 | 2; hunt?: HunterProfile; traits?: BehaviorTrait[] } = {}
): EnemyGenome {
  const t = SPECIES[species];
  const m = TIER_MUL[tier];
  const jitter = (v: number, spread = 0.16): number => v * (1 + rand.range(-spread, spread));

  // original generated name: prefix + species noun + tier suffix
  const suffix = opts.hunter ? ' HUNTER' : TIER_SUFFIX[tier];
  let name = '';
  for (let guard = 0; guard < 24; guard++) {
    name = `${rand.pick(PREFIX)} ${rand.pick(t.names)}${suffix}`;
    if (!usedNames.has(name)) break;
  }
  usedNames.add(name);

  const abilities = pickAbilities(rand, t.abilities, abilityCount);
  const rangedAbility = abilities.find(a => a === 'spit' || a === 'web' || a === 'volley');
  const traits = opts.traits ?? pickTraits(rand, species, tier, abilities, !!rangedAbility);
  const behavior = buildBehavior(traits, tier);

  // palette: species base colour shifted per genome so variants read differently
  const shift = rand.range(-0.14, 0.14);
  const rgbShift = (hex: number): number => {
    const r = clamp(((hex >> 16) & 255) * (1 + shift * 1.6), 0, 255);
    const g = clamp(((hex >> 8) & 255) * (1 - shift * 0.6), 0, 255);
    const b = clamp((hex & 255) * (1 + shift * 0.9), 0, 255);
    return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  };

  const visual: GenomeVisual = { ...t.visual };
  // per-genome body-plan variation
  visual.legPairs = Math.max(0, Math.round(visual.legPairs + rand.range(-1, 1)));
  visual.legLength = Math.max(0.5, jitter(visual.legLength, 0.22));
  visual.bodyWidth = jitter(visual.bodyWidth, 0.16);
  visual.bodyLength = jitter(visual.bodyLength, 0.16);
  visual.bodyHeight = jitter(visual.bodyHeight, 0.16);
  visual.spikes = Math.max(0, Math.round(visual.spikes + rand.range(-3, 3)));
  visual.plates = Math.max(1, Math.round(visual.plates + rand.range(-1, 1)));
  visual.eyes = Math.max(1, Math.round(visual.eyes + rand.range(-1, 1)));
  visual.horns = Math.max(0, Math.round(visual.horns + (tier === 'apex' || tier === 'boss' || tier === 'nexus' ? 2 : 0)));
  visual.spikeSize = jitter(visual.spikeSize, 0.2);
  if (visual.segments > 1) visual.segments = Math.max(4, Math.round(visual.segments + rand.range(-1, 2)));
  visual.membrane = Math.min(0.9, Math.max(0, jitter(visual.membrane + 0.08, 0.25)));
  // The behaviour is written into the BODY: this is the whole point of the trait roll.
  applyTraitVisual(visual, traits);

  const base = t.base;
  const isSmall = tier === 'small';

  return {
    idx,
    species,
    tier,
    name,
    abilities,
    hp: Math.round(jitter(base.hp * m.hp)),
    speed: jitter(base.speed * m.speed),
    damage: Math.max(3, Math.round(jitter(base.damage * m.dmg))),
    attackRange: jitter(base.attackRange, 0.16),
    attackCd: Math.max(0.5, jitter(base.attackCd * m.cd, 0.14)),
    radius: jitter(base.radius * (tier === 'nexus' ? 1.45 : tier === 'boss' ? 1.2 : 1), 0.12),
    xp: Math.round(base.xp * m.xp),
    scale: jitter(base.scale * (m.scale / 1.6), 0.1),
    color: rgbShift(t.color),
    accent: t.accent,
    ranged: !!rangedAbility,
    projSpeed: 26 + rand.range(0, 12),
    projColor: t.accent,
    projKind: rangedAbility === 'web' ? 'web' : rangedAbility === 'volley' ? 'volley' : rangedAbility ? 'spit' : 'none',
    small: isSmall,
    visual,
    elite: false,
    traits,
    behavior,
    hunter: opts.hunter ?? 0,
    hunt: opts.hunt,
  };
}

/**
 * Rolls the behavioural characteristics for one genome.
 *
 * The creature's own kit is the strongest signal — a body with `charge` was built to charge, one
 * with `detonate` was built to burst — and the random roll layers an extra temperament on top so
 * two genomes from the same species never behave identically. The result is capped at three.
 */
function pickTraits(
  rand: Rand,
  species: SpeciesId,
  tier: Tier,
  abilities: AbilityId[],
  ranged: boolean
): BehaviorTrait[] {
  const has = (id: AbilityId): boolean => abilities.indexOf(id) >= 0;
  const out: BehaviorTrait[] = [];
  const add = (t: BehaviorTrait): void => {
    if (out.indexOf(t) < 0 && out.length < 3) out.push(t);
  };

  // ---- what the kit already says about it
  if (has('detonate') || has('split') || has('spawnlings')) add('explosive');
  if (has('charge')) add('charging');
  if (has('shield') || has('regen') || species === 'brute') add('defensive');
  if (has('thorn')) add('defensive');
  if (has('pack') || species === 'spider' || species === 'crawler') add('pack');
  if (has('burrow') || has('ambush') || has('blink')) add('cowardly');
  if (has('slam') || has('gravPull') || has('volley')) add('aggressive');
  if (ranged) add('ranged');
  if (has('frenzy')) add('aggressive');

  // ---- the temperament roll: one more, occasionally two, from the species' own leanings
  const POOL: BehaviorTrait[] = species === 'brute'
    ? ['territorial', 'aggressive', 'defensive', 'protective', 'persistent']
    : species === 'spider'
      ? ['pack', 'ranged', 'cowardly', 'charging', 'persistent']
      : species === 'crawler'
        ? ['aggressive', 'charging', 'fleeing', 'persistent', 'pack']
        : species === 'worm'
          ? ['territorial', 'explosive', 'defensive', 'persistent', 'charging']
          : ['explosive', 'cowardly', 'territorial', 'defensive', 'fleeing'];
  const rolls = 1 + (rand.next() < 0.42 ? 1 : 0);
  for (let i = 0; i < rolls; i++) add(rand.pick(POOL));

  // A creature always has at least one, and the swarm tier is never the stubborn kind: a small
  // crawler that refused to disengage was the single most annoying thing on the field.
  if (out.length === 0) add(tier === 'small' ? 'cowardly' : 'aggressive');
  if (tier === 'small') {
    const i = out.indexOf('territorial');
    if (i >= 0) out[i] = 'fleeing';
  }
  // Bosses are always the headline: aggressive and impossible to shake off.
  if (tier === 'boss' || tier === 'nexus') {
    if (out.indexOf('aggressive') < 0) out.unshift('aggressive');
    if (out.indexOf('persistent') < 0) out.push('persistent');
    out.length = Math.min(3, out.length);
  }
  return out;
}

/**
 * Writes the trait list into the body plan — the procedural equivalent of a tell.
 *
 * Uses only the parts the model builder already has (plates, spikes, horns, mandibles, legs,
 * tubes, glowing sacs), so every combination stays inside the existing look and no trait can
 * produce a creature built from nothing.
 */
export function applyTraitVisual(v: GenomeVisual, traits: BehaviorTrait[]): void {
  for (const t of traits) {
    switch (t) {
      case 'aggressive':
        v.mandibles += 2;
        v.spikes += 3;
        v.horns += 1;
        v.eyes += 1;
        v.bodyLength *= 1.08;
        break;
      case 'defensive':
        v.plates += 2;
        v.bodyWidth *= 1.14;
        v.bodyHeight *= 1.08;
        v.legLength *= 0.86;
        v.spikeSize *= 1.05;
        break;
      case 'territorial':
        v.plates += 2;
        v.bodyWidth *= 1.16;
        v.bodyHeight *= 1.12;
        v.legLength *= 0.88;
        break;
      case 'pack':
        v.legPairs += 1;
        v.legLength *= 1.16;
        v.legThickness *= 0.85;
        v.bodyWidth *= 0.9;
        break;
      case 'cowardly':
      case 'fleeing':
        // a light, long-legged, visually fragile frame
        v.bodyWidth *= 0.8;
        v.bodyHeight *= 0.84;
        v.legLength *= 1.3;
        v.legThickness *= 0.85;
        v.plates = Math.max(1, v.plates - 1);
        break;
      case 'charging':
        // forward-heavy: horns and mass up front
        v.horns += 4;
        v.bodyLength *= 1.18;
        v.bodyWidth *= 1.08;
        v.bodyHeight *= 1.04;
        v.spikeSize *= 1.1;
        break;
      case 'ranged':
        v.tubes = (v.tubes ?? 0) + 3;
        v.tail = true;
        v.eyes += 1;
        break;
      case 'protective':
        v.plates += 1;
        v.bodyWidth *= 1.08;
        v.core = true;
        break;
      case 'explosive':
        v.glowNodes = (v.glowNodes ?? 0) + 3;
        v.core = true;
        v.membrane = Math.min(0.9, v.membrane + 0.15);
        break;
      case 'persistent':
        v.legLength *= 1.05;
        v.spikes += 1;
        break;
    }
  }
  // keep the plan inside what the builder can draw
  v.legPairs = Math.max(0, Math.min(6, Math.round(v.legPairs)));
  v.plates = Math.max(1, Math.min(9, Math.round(v.plates)));
  v.spikes = Math.max(0, Math.min(15, Math.round(v.spikes)));
  v.horns = Math.max(0, Math.min(9, Math.round(v.horns)));
  v.mandibles = Math.max(0, Math.min(6, Math.round(v.mandibles)));
  v.eyes = Math.max(1, Math.min(7, Math.round(v.eyes)));
}

/**
 * The two Hunter Necrophages. Both are generated from the match seed, so every client builds the
 * same pair from the seed alone — only the spawn itself crosses the wire.
 */
function makeHunter(rand: Rand, idx: number, kind: 1 | 2, usedNames: Set<string>): EnemyGenome {
  // Hunter 1 — the heavy Ripper: slow, short-ranged, brutal landing.
  // Hunter 2 — the long-stride Pouncer: a longer leap, a faster cycle and a follow-up bite.
  //
  // Every leap is TELEGRAPHED: the hunter marks the ground under its target for `telegraph` seconds
  // (see Enemy.beginWindup) and then commits a real ballistic arc at that mark. The arc's horizontal
  // speed is derived at launch from the distance to the mark, so the flight lasts about `leapTime`
  // whatever the target did during the wind-up — which is what the recovery window is measured
  // against. The Ripper gives the player a long, heavy read; the Pouncer commits faster.
  const hunt: HunterProfile = kind === 1
    ? {
        kind: 1,
        leapRange: 13 + rand.range(-1.2, 1.2),
        leapCd: 6.2 + rand.range(-0.6, 0.6),
        impactMul: 1.5,
        impactRadius: 5.4,
        leapTime: 0.8,
        telegraph: 0.85,
        recover: 1.5,
        followUp: false,
      }
    : {
        kind: 2,
        leapRange: 16 + rand.range(-1.4, 1.4),
        leapCd: 4.1 + rand.range(-0.5, 0.5),
        impactMul: 1.1,
        impactRadius: 3.3,
        leapTime: 0.62,
        telegraph: 0.6,
        recover: 0.9,
        followUp: true,
      };
  const g = makeGenome(rand, idx, 'hunter', 'apex', 3, usedNames, {
    hunter: kind,
    hunt,
    // A hunter is never skittish and never loses the scent: those are the two traits that would
    // make "it hunts players" read as a lie.
    traits: ['aggressive', 'persistent', kind === 1 ? 'protective' : 'charging'],
  });
  g.name = `${rand.pick(PREFIX)} ${rand.pick(SPECIES.hunter.names)} HUNTER`;
  return g;
}

/**
 * Builds the match bestiary: 3 small swarm species, 3 large species, 1 apex, the FOUR Beacon
 * Guardians and 1 Nexus Overseer — all generated from the match seed. (The ecology generator in
 * `procedural/EcologyGenerator` is the live path; this remains the classic/P2P fallback and the
 * default instance, kept here so both rosters share one shape.)
 */
export function generateBestiary(seed: number): Bestiary {
  const rand = new Rand(seed ^ 0xb3775f);
  const used = new Set<string>();
  const genomes: EnemyGenome[] = [];

  // --- small swarm tier (food for Necrotech Bursts)
  genomes.push(makeGenome(rand, genomes.length, 'crawler', 'small', 2, used));
  genomes.push(makeGenome(rand, genomes.length, 'slime', 'small', 2, used));
  genomes.push(makeGenome(rand, genomes.length, 'spider', 'small', 2, used));

  // --- large tier: the general population
  const largeSpecies: SpeciesId[] = [rand.pick(['spider', 'crawler']), rand.pick(['slime', 'worm']), 'brute'];
  for (const species of largeSpecies) {
    genomes.push(makeGenome(rand, genomes.length, species, 'large', 3, used));
  }

  // --- apex miniboss
  // --- the match's two Hunter Necrophages: always present, always the same pair from this seed
  const hunterIdx: number[] = [];
  hunterIdx.push(genomes.length);
  genomes.push(makeHunter(rand, genomes.length, 1, used));
  hunterIdx.push(genomes.length);
  genomes.push(makeHunter(rand, genomes.length, 2, used));

  const apexIdx = genomes.length;
  genomes.push(makeGenome(rand, apexIdx, rand.pick(['brute', 'worm', 'spider']), 'apex', 4, used));

  // --- the four Beacon Guardians: one PER BEACON, each its own species frame + generated name
  // (a `used` set keeps the names distinct, so the four wardens never read as clones).
  const bossIdxes: number[] = [];
  for (const species of ['brute', 'worm', 'spider', 'brute'] as SpeciesId[]) {
    bossIdxes.push(genomes.length);
    genomes.push(makeGenome(rand, genomes.length, species, 'boss', 4, used));
  }

  // --- Nexus Overseer (always a brute chassis, biggest and nastiest)
  const nexusIdx = genomes.length;
  genomes.push(makeGenome(rand, nexusIdx, 'brute', 'nexus', 5, used));

  return {
    seed,
    genomes,
    bossIdxes,
    nexusIdx,
    apexIdx,
    hunterIdx,
    smallIdx: genomes.filter(g => g.tier === 'small').map(g => g.idx),
    largeIdx: genomes.filter(g => g.tier === 'large').map(g => g.idx),
  };
}

/** Boss health-bar / debug label. */
export function genomeAbilityNames(g: EnemyGenome): string {
  return g.abilities.map(a => ABILITY_META[a].name).join(', ');
}
