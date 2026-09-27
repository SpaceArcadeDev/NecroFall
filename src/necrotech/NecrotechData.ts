// NECROFALL — the Necrotech classes + deterministic mutation (fusion) rules.
//
// Six classes are selectable at spawn; four more only exist as mid-match drops. Every class owns
// a MOBA-style kit (auto-attack identity, one Skill, one Ultimate, a passive). A mutation fuses
// two loadouts: it keeps one Skill and the other Ultimate, inherits both parents' auto-attack
// behaviour (chain / pierce / knockback / corpse explosions / burn / toxin spread) and adds extra
// projectiles.
//
// Every ability carries an `aim` descriptor. It is the single source of truth for BOTH the
// on-ground aiming marker (necrotech/AimPreview.ts) and the real damage footprint in
// AbilitySystem.ts, so the ground shape a player sees is exactly the area that gets hit.
import type { Mods } from '../core/Config';
import type { MutationDef } from './Mutations';

export type AutoStyle = 'bolt' | 'spread' | 'chain' | 'heavy' | 'pierce' | 'laser' | 'flame' | 'shard' | 'fist' | 'whip';
export type StatusKind = 'burn' | 'slow' | 'poison' | 'root' | null;

/** How an ability's damage lands in the world — drives the aiming marker and the hit test. */
export type AimKind =
  | 'line'   // skillshot: a straight lane out to `range`
  | 'cone'   // fan: everything within ±halfAngle out to `range`
  | 'circle' // aimed area: a disc centred on the aimed point
  | 'self'   // point blank: a disc centred on the caster
  | 'dash';  // a travel lane (blink / charge) — damage along the path

export interface AbilityAim {
  kind: AimKind;
  /** Maximum placement distance from the caster, in multiples of the auto-attack range (R). */
  range?: number;
  /** Fixed distance in metres; wins over `range` when present. */
  fixedRange?: number;
  /**
   * Where an aimed shape lands when the player casts WITHOUT pointing at the ground (keyboard cast).
   * Also in multiples of R. Without it the fallback is `range`, which for an aimed blast would drop
   * the whole thing on the far edge of the ring.
   */
  defaultRange?: number;
  /** Effect radius, in multiples of R. */
  radius?: number;
  /** Fixed effect radius in metres; wins over `radius`. */
  fixedRadius?: number;
  /** Half-width of a lane, in multiples of R (defaults to 0.08R). */
  width?: number;
  /** Half-angle of a cone, in radians. */
  halfAngle?: number;
}

export interface NecrotechStats {
  damage: number;
  rate: number; // shots per second
  range: number; // auto-attack radius (R)
  projSpeed: number;
  style: AutoStyle;
  count: number; // projectiles per shot (spread)
  color: number;
  status: StatusKind;
  statusPower: number;
  /** Enemies an auto-attack arcs on to (chain weapons — VOLT). */
  chain?: number;
  /** Damage kept per chain hop (0.5 = VOLT's Conduction). */
  chainDecay?: number;
  /** Projectile stretch along its flight direction (shards, fists, lasers). */
  elong?: number;
  /** Projectile lifetime in seconds — short for the flamethrower cone. */
  life?: number;
  /** Radius (m) that burning enemies spread fire to (PYRE — Immolate). */
  spreadBurn?: number;
  /** Radius (m) that poisoned enemies smear venom over (VENOM — Contagion). */
  spreadVenom?: number;
  /** Half-angle (radians) of a whip auto-attack's arc at its base width. EXTRA PROJECTILES WIDEN IT. */
  whipArc?: number;
  /** Shield granted per enemy inside the auto-attack ring (WHIPLASH — Madmen). */
  shieldPerFoe?: number;
  /**
   * CRYO weapon (FROST, and any fusion that inherits it). This is the ONLY thing that puts the ice
   * tell on an enemy — deliberately an explicit tag rather than "the status is a slow": a slow is a
   * generic debuff that a dozen non-frost sources apply (Fortress Field, toxin trails, cryo-less
   * cones), and inferring frost from it made every slowed enemy look frozen.
   */
  cryo?: boolean;
}

export interface NecrotechDef {
  idx: number;
  name: string;
  role: string;
  color: number;
  desc: string;
  stats: NecrotechStats;
  passiveName: string;
  passiveDesc: string;
  mods: Partial<Mods>;
  skill: { id: string; name: string; cd: number; desc: string; aim: AbilityAim };
  ult: { id: string; name: string; cd: number; desc: string; aim: AbilityAim };
  /** Not selectable at spawn: only obtainable from a mid-match Necrotech drop. */
  dropOnly?: boolean;
  /** Extra enemies an auto-attack bolt arcs onto (VOLT-style). */
  autoChain?: number;
  /** Extra enemies an auto-attack bolt passes through (RIFT-style). */
  autoPierce?: number;
  /** Impulse applied to whatever an auto-attack hits (BREAKER-style). */
  autoKnock?: number;
  /** Radius of the fire nova a kill with this loadout leaves behind (PYRE-style). */
  explodeOnKill?: number;
  /** Short labels for the combined behaviour of a fusion, shown on cards and in the HUD. */
  traitLabels?: string[];
  mutated?: boolean;
  superMut?: boolean;
  debuffDesc?: string;
  /** Registry id of the mutation this fusion IS (see necrotech/Mutations.ts). */
  mutationId?: string;
  /** The mutation's own name — what the discovery panel and the HUD show. */
  mutationName?: string;
}

export const NECROTECHS: NecrotechDef[] = [
  {
    idx: 0,
    name: 'RAVAGER',
    role: 'Marksman',
    color: 0xff8a3d,
    desc: 'Raw weapon damage. Sustained automatic fire that punishes anything caught in the open.',
    stats: {
      damage: 16, rate: 2.4, range: 12.5, projSpeed: 68, style: 'bolt', count: 1,
      color: 0xff8a3d, status: null, statusPower: 0, elong: 1.5,
    },
    passiveName: 'Gunslinger',
    passiveDesc: '+14% attack speed, +8% weapon damage.',
    mods: { rateMul: 1.14, dmgMul: 1.08 },
    skill: {
      id: 'salvo', name: 'Salvo', cd: 6,
      aim: { kind: 'line', range: 1, width: 0.11 },
      desc: 'AIM a lane — a barrage of rounds straight down it, 180% damage per bolt. The lane is exactly where the bullets travel.',
    },
    ult: {
      id: 'berserker', name: 'Berserker', cd: 40,
      aim: { kind: 'self', radius: 1 },
      desc: 'INSTANT — +55% damage, +35% attack speed, +2 projectiles on every attack AND Skill for 5s (longer with Ultimate duration bonuses), and your auto-attack ring burns orange.',
    },
  },
  {
    idx: 2,
    name: 'VOLT',
    role: 'Chain Mage',
    color: 0x7fd4ff,
    desc: 'Arc weaponry. Fires electricity, not bullets — every bolt leaps on to the next target.',
    stats: {
      damage: 10, rate: 2.2, range: 12.5, projSpeed: 92, style: 'chain', count: 1,
      color: 0x7fd4ff, status: null, statusPower: 0, chain: 1, chainDecay: 0.5, elong: 2.2,
    },
    passiveName: 'Conduction',
    passiveDesc: 'Your arcs bounce to 1 nearby enemy for 50% damage.',
    mods: {},
    skill: {
      id: 'lance', name: 'Lightning Lance', cd: 6,
      aim: { kind: 'line', range: 1, width: 0.19 },
      desc: 'AIM a line across your ring — 340% piercing damage, then arcs onward to 2 more enemies.',
    },
    ult: {
      id: 'thunderzone', name: 'Thunder Zone', cd: 44,
      aim: { kind: 'circle', range: 1, defaultRange: 0.52, radius: 0.46 },
      desc: 'AIM a zone — lightning hammers it 10 times over 5s. Every strike spreads to nearby enemies, losing 30% damage per bounce.',
    },
  },
  {
    idx: 3,
    name: 'PYRE',
    role: 'Pyromancer',
    color: 0xff5b3d,
    desc: 'Flame spread. A continuous flamethrower that sets everything it touches alight.',
    stats: {
      damage: 4.2, rate: 6.5, range: 9.5, projSpeed: 34, style: 'flame', count: 1,
      color: 0xff5b3d, status: 'burn', statusPower: 5, elong: 1, life: 0.34, spreadBurn: 6,
    },
    passiveName: 'Immolate',
    passiveDesc: 'Burning enemies spread fire to their neighbours for 5s. +10% Skill damage.',
    mods: { abilityMul: 1.1 },
    skill: {
      id: 'flamewave', name: 'Flamewave', cd: 6.5,
      aim: { kind: 'cone', range: 1, halfAngle: 0.8 },
      desc: 'AIM a 90° wave across your ring — 200% damage, and everything hit burns with a visible flame aura.',
    },
    ult: {
      id: 'meteor', name: 'Meteor', cd: 45,
      aim: { kind: 'circle', range: 1, defaultRange: 0.37, radius: 0.62 },
      desc: 'AIM a point inside your ring — a flaming meteor falls on to the mark. 500% damage, a heavy knockback and a fire that burns for 5s.',
    },
  },
  {
    idx: 4,
    name: 'RIFT',
    role: 'Assassin',
    color: 0xc08bff,
    desc: 'Spatial movement. Fires phase lasers that cut straight through a rank of enemies.',
    stats: {
      damage: 11, rate: 2.2, range: 13.5, projSpeed: 150, style: 'laser', count: 1,
      color: 0xc08bff, status: null, statusPower: 0, elong: 3.2,
    },
    passiveName: 'Phase Shift',
    passiveDesc: '−28% dash recharge time, +10% movement speed.',
    mods: { dashRechargeMul: 1.38, spdMul: 1.1 },
    autoPierce: 2,
    skill: {
      id: 'blink', name: 'Blink Strike', cd: 5.5,
      aim: { kind: 'dash', range: 1, width: 0.1 },
      desc: 'AIM a direction — teleport out to the edge of your ring in a flash, cutting EVERYTHING along the path for 220% damage.',
    },
    ult: {
      id: 'blackhole', name: 'Black Hole', cd: 46,
      aim: { kind: 'circle', range: 1, defaultRange: 0.45, radius: 0.5 },
      desc: 'AIM a point inside your ring — tear open a black hole. It drags enemies to the centre, slows them 50% and deals 420% damage over 5s.',
    },
  },
  {
    idx: 7,
    name: 'VENOM',
    role: 'Plaguebearer',
    color: 0x9dff6b,
    desc: 'Poison. Green toxic rounds that melt groups and smear venom across the ground.',
    stats: {
      damage: 7.5, rate: 2.6, range: 12, projSpeed: 44, style: 'bolt', count: 1,
      color: 0x9dff6b, status: 'poison', statusPower: 7, elong: 1.2, spreadVenom: 3.4,
    },
    passiveName: 'Contagion',
    passiveDesc: '+15% Necromutation gain. Poisoned enemies smear venom as they move — anyone wading through it is slowed and poisoned.',
    mods: { xpMul: 1.15 },
    skill: {
      id: 'toxicbloom', name: 'Toxic Bloom', cd: 7,
      aim: { kind: 'circle', range: 1, defaultRange: 0.35, radius: 0.6 },
      desc: 'AIM a bloom inside your ring — 100% damage/s for 4s in a stacking toxin cloud that bursts when something dies inside.',
    },
    ult: {
      id: 'plaguewake', name: 'Plaguewake', cd: 44,
      aim: { kind: 'circle', range: 1, defaultRange: 0.25, radius: 0.72 },
      desc: 'AIM a plague field inside your ring — 170%/s for 5s. Every kill inside spreads the plague outward and leaves a corpse burst.',
    },
  },
];

/**
 * Not selectable at spawn — these classes only turn up in Necrotech drops (boss guardians, elites,
 * apex minibosses and the rare big Necrophage). Their kits are tuned a step hotter than the
 * starters to make a mid-match swap worth taking.
 */
export const DROP_NECROTECHS: NecrotechDef[] = [
  {
    idx: 1,
    name: 'BREAKER',
    role: 'Vanguard',
    color: 0xffd166,
    dropOnly: true,
    desc: 'Tanky knockback. Fires compressed air fists that launch whatever they touch.',
    stats: {
      damage: 15, rate: 1.8, range: 11, projSpeed: 46, style: 'fist', count: 1,
      color: 0xffd166, status: null, statusPower: 0, elong: 2.1,
    },
    passiveName: 'Plated',
    passiveDesc: '+15% max HP, −10% damage taken. Fists punch enemies away.',
    mods: { hpMul: 1.15, takenMul: 0.9 },
    autoKnock: 9,
    skill: {
      id: 'shockcone', name: 'Shockcone', cd: 7,
      aim: { kind: 'cone', range: 1, halfAngle: 0.62 },
      desc: 'AIM a 60° cone across your ring — 230% damage, a huge knockback and a slowing peel.',
    },
    ult: {
      id: 'siegebreaker', name: 'Siegebreaker', cd: 40,
      aim: { kind: 'circle', range: 1, defaultRange: 0.35, radius: 0.6 },
      desc: 'LEAP high, then SLAM the marked ground inside your ring — 420% damage, a knock-up stun, then a green heal field (auto-attack ring) that restores you and your colony for 5s.',
    },
  },
  {
    idx: 5,
    name: 'BULWARK',
    role: 'Juggernaut',
    color: 0x9fe8b0,
    dropOnly: true,
    desc: 'Heavy plating and seismic weapons. Slow but unstoppable.',
    stats: {
      damage: 17, rate: 1.6, range: 11, projSpeed: 44, style: 'heavy', count: 1,
      color: 0x9fe8b0, status: null, statusPower: 0, elong: 1.8,
    },
    passiveName: 'Plated',
    passiveDesc: '+20% max HP, −6% movement speed. Shots knock enemies back. Strongpoints hold 25% longer.',
    mods: { hpMul: 1.2, spdMul: 0.94, ultDurMul: 1.25 },
    autoKnock: 7,
    skill: {
      id: 'quake', name: 'Quake Slam', cd: 8,
      aim: { kind: 'self', radius: 1 },
      desc: 'SLAM the ground — 250% damage across your ring, a knockback and a 50% slow. Body-block and counter-engage.',
    },
    ult: {
      id: 'fortress', name: 'Fortress Protocol', cd: 45,
      aim: { kind: 'circle', range: 1, defaultRange: 0.35, radius: 1 },
      desc: 'AIM a point inside your ring — RAISE A STRONGPOINT there, a whole ring wide. Necrophages are dragged on to it, and the field it claims grants you AND every ally standing in it 60% less damage taken, a steady mend, and a retaliating shockwave.',
    },
  },
  {
    idx: 6,
    name: 'FROST',
    role: 'Controller',
    color: 0xa8e6ff,
    dropOnly: true,
    desc: 'Ice stun. Fires cryo shards that lock whole packs in place.',
    stats: {
      damage: 9, rate: 2.4, range: 12.5, projSpeed: 62, style: 'shard', count: 1,
      color: 0xa8e6ff, status: 'slow', statusPower: 0.4, elong: 3.4, cryo: true,
    },
    passiveName: 'Chill',
    passiveDesc: '−8% damage taken. Every shard chills what it hits, slowing it. Ultimate fields hold 25% longer.',
    mods: { takenMul: 0.92, ultDurMul: 1.25 },
    skill: {
      id: 'frostnova', name: 'Frost Nova', cd: 6,
      aim: { kind: 'self', radius: 1 },
      desc: 'NOVA across your ring — 260% damage, a 60% slow, and a ROOT on everything touching you. Nothing moves.',
    },
    ult: {
      id: 'absolutezero', name: 'Absolute Zero', cd: 44,
      aim: { kind: 'circle', range: 1, defaultRange: 0.35, radius: 0.6 },
      desc: 'AIM an ice field inside your ring — the first tick freezes enemies SOLID inside a block of ice, then 145 damage/s and a heavy slow for 5s.',
    },
  },
  {
    idx: 8,
    name: 'REAPER',
    role: 'Executioner',
    color: 0xff6b9d,
    dropOnly: true,
    desc: 'Execution weapons. Finish what others started.',
    stats: {
      damage: 15, rate: 1.8, range: 11, projSpeed: 50, style: 'heavy', count: 1,
      color: 0xff6b9d, status: null, statusPower: 0, elong: 1.8,
    },
    passiveName: 'Harvest',
    passiveDesc: '+12% damage to enemies below 50% HP. Kills leave a bleeding wound.',
    mods: { execMul: 1.12 },
    explodeOnKill: 3.5,
    skill: {
      id: 'scythe', name: 'Scythe Arc', cd: 6,
      aim: { kind: 'cone', range: 1, halfAngle: 2.094 },
      desc: 'SPIN — a 240° sweep across your ring for 260% damage that leaves everything it touches bleeding.',
    },
    ult: {
      id: 'reap', name: 'Reap', cd: 45,
      aim: { kind: 'self', radius: 1 },
      desc: 'EXECUTE every enemy under 25% HP inside your ring (bosses take 400%). Each execution heals you and refunds 40% of the cooldown.',
    },
  },
  {
    idx: 9,
    name: 'NOVA',
    role: 'Detonator',
    color: 0x6bffd4,
    dropOnly: true,
    desc: 'Pulse emitters. Built to shred swarms.',
    stats: {
      damage: 11, rate: 2.5, range: 12, projSpeed: 66, style: 'bolt', count: 1,
      color: 0x6bffd4, status: null, statusPower: 0, elong: 1.4,
    },
    passiveName: 'Resonance',
    passiveDesc: '+10% Necrotech Burst radius and damage. Skills pulse a second time for 50%. Ultimate effects keep ringing 30% longer.',
    mods: { burstMul: 1.1, ultDurMul: 1.3 },
    skill: {
      id: 'pulsering', name: 'Pulse Ring', cd: 6,
      aim: { kind: 'self', radius: 1 },
      desc: 'PULSE — an expanding ring of 200% damage across your ring with a knockback. It pulses again a beat later for half.',
    },
    ult: {
      id: 'supernova', name: 'Supernova', cd: 48,
      aim: { kind: 'self', radius: 1 },
      desc: 'DETONATE across your ring for 540% damage, knocking everything back and burning it. The ground stays molten for 5s. Heals 20% of your health.',
    },
  },
  {
    idx: 10,
    name: 'WHIPLASH',
    role: 'Warden',
    color: 0xffb0d0,
    dropOnly: true,
    desc: 'Chain whips. No projectiles at all — every strike is a lash swept across the front arc.',
    stats: {
      damage: 13, rate: 1.6, range: 8.5, projSpeed: 0, style: 'whip', count: 1,
      color: 0xffb0d0, status: null, statusPower: 0, whipArc: 0.7, shieldPerFoe: 4,
    },
    passiveName: 'Madmen',
    passiveDesc: 'Enemies inside your whip ring slowly feed a small shield — it builds while you hold the crowd and fades as they die.',
    mods: { shieldHp: 30 },
    traitLabels: ['whip arc', 'shield per foe'],
    skill: {
      id: 'spinner', name: 'Spinner', cd: 7,
      aim: { kind: 'self', radius: 1 },
      desc: 'SPIN — the chain whip whirls across your whole firing ring for 210% damage over 2.6s, driving everything caught in it steadily outward.',
    },
    ult: {
      id: 'judgement', name: 'Judgement', cd: 46,
      aim: { kind: 'circle', range: 1, defaultRange: 0.38, radius: 0.62 },
      desc: 'AIM a wide zone — black chains tear out of the ground for 5s, caging everything for 380% damage and STUNNING it in place.',
    },
  },
];

/** Aim helpers — shared by the aiming marker and AbilitySystem so they can never drift apart. */

/** Resolves an aim descriptor against a caster's auto-attack range. */
export function aimRange(aim: AbilityAim | undefined, autoRange: number): number {
  if (!aim) return autoRange * (FALLBACK_AIM.range ?? 1);
  return aim.fixedRange ?? (aim.range ?? 1) * autoRange;
}

/** Effect radius of an aim descriptor (0 for lanes/cones without a blast). */
export function aimRadius(aim: AbilityAim | undefined, autoRange: number): number {
  if (!aim) return 0;
  return aim.fixedRadius ?? (aim.radius ?? 0) * autoRange;
}

/** Half-width of a lane, in metres. */
export function aimWidth(aim: AbilityAim | undefined, autoRange: number): number {
  if (!aim) return autoRange * 0.09;
  return (aim.width ?? 0.08) * autoRange;
}

/**
 * Where an aimed blast lands when the player never pointed at the ground (a keyboard cast, or a
 * touch drag that never left the button). Both the marker and the real blast read this, so an
 * unaimed cast still lands exactly on the ground the player was shown.
 */
export function aimDefault(aim: AbilityAim | undefined, autoRange: number): number {
  if (!aim) return autoRange;
  if (aim.kind === 'self') return 0;
  if (aim.fixedRange !== undefined) return aim.fixedRange;
  return (aim.defaultRange ?? aim.range ?? 1) * autoRange;
}
/** The final metres an ability actually covers, once clamped to the ring. */
export interface ResolvedAim {
  /** Distance from the caster to the centre of the effect (0 for point-blank shapes). */
  range: number;
  /** Radius of the blast / fan / nova. */
  radius: number;
  /** Half-width of a lane. */
  width: number;
  /** Half-angle of a cone. */
  halfAngle: number;
}

/**
 * Resolves an ability's footprint and CLAMPS IT INSIDE THE AUTO-ATTACK RING: an ability may never
 * reach past the circle the player already shoots to. An AIMED BLAST may place its centre anywhere
 * inside that ring — a mark on the very edge throws half the disc over the boundary, which is the
 * point of aiming it — while lanes, cones and dashes stop at the ring.
 *
 * Both the aiming marker and the real damage footprint call this, which is why what you see is
 * always exactly what gets hit.
 */
export function resolveAim(aim: AbilityAim, autoRange: number): ResolvedAim {
  const halfAngle = aim.halfAngle ?? 0.7;
  const width = aimWidth(aim, autoRange);
  const radius = Math.min(aimRadius(aim, autoRange), autoRange);
  const raw = aimRange(aim, autoRange);
  let range = raw;
  if (aim.kind === 'self') {
    range = 0;
  } else {
    // the centre may reach the ring itself (aimed blasts included) — never past it
    range = clampNumber(raw, 0, autoRange);
  }
  return { range, radius, width, halfAngle };
}

function clampNumber(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
/** Every class that can appear in a drop, in drop-pool order. */
export const ALL_NECROTECHS: NecrotechDef[] = [...NECROTECHS, ...DROP_NECROTECHS];

/**
 * Ability id → aim descriptor, including the ids the old roster used. A loadout saved before the
 * aiming rework carries no `aim` field, and this is what puts the footprint back on it.
 */
export const ABILITY_AIMS: Record<string, AbilityAim> = (() => {
  const out: Record<string, AbilityAim> = {};
  for (const def of ALL_NECROTECHS) {
    out[def.skill.id] = def.skill.aim;
    out[def.ult.id] = def.ult.aim;
  }
  // retired ids — left on their original FIXED metres: they only ever resolve from a pre-rework save,
  // and re-basing them on the ring would silently change what an old loadout does
  out.overcharge = { kind: 'self', radius: 1.35 };
  out.storm = { kind: 'circle', fixedRange: 10, fixedRadius: 4.2 };
  out.singularity = { kind: 'circle', fixedRange: 12, fixedRadius: 7 };
  return out;
})();

/** Whatever a legacy ability cannot tell us: a modest lane straight ahead. */
export const FALLBACK_AIM: AbilityAim = { kind: 'line', range: 1.3, width: 0.09 };

/** Fills in a missing aim descriptor (legacy saves, hand-edited defs). */
export function ensureAim<T extends { id: string; aim?: AbilityAim }>(ability: T): T {
  if (!ability.aim) ability.aim = ABILITY_AIMS[ability.id] ?? FALLBACK_AIM;
  return ability;
}

/** Drop-pool index → definition. */
export function defForDrop(nt: number): NecrotechDef {
  return ALL_NECROTECHS[((nt % ALL_NECROTECHS.length) + ALL_NECROTECHS.length) % ALL_NECROTECHS.length];
}

interface Debuff {
  desc: string;
  mods: Partial<Mods>;
}

const MUTATION_DEBUFFS: Debuff[] = [
  { desc: '−12% max HP', mods: { hpMul: 0.88 } },
  { desc: '+12% damage taken', mods: { takenMul: 1.12 } },
  { desc: '−8% movement speed', mods: { spdMul: 0.92 } },
  { desc: '+25% dash recharge time', mods: { dashRechargeMul: 0.8 } },
  { desc: '+15% ability cooldowns', mods: { cdMul: 1.15 } },
  { desc: '−20% health regeneration', mods: { regenMul: 0.8 } },
  { desc: '−10% attack range', mods: { rangeMul: 0.9 } },
];

/**
 * Deterministic NECROTECH FUSION — fuse two loadouts into a combined kit (the engine).
 *
 * The fusion takes the Skill from one parent and the Ultimate from the other and then COMBINES
 * their auto-attack behaviour: chain arcs, piercing, knockback, a burning trail, toxin spread and
 * corpse explosions all stack, and the fused weapon always throws extra projectiles. The result
 * reads as one hybrid gun — e.g. RAVAGER·VOLT shoots a spread that zaps everything around what it
 * hits, and PYRE·FROST sets the ground on fire and then freezes whatever dies.
 *
 * This function is the ENGINE ONLY. It never applies a mutation registry entry: the loadout's
 * PERMUTATION identity (name, extra mods/weapon behaviour, ability picks for triples, drawback) is
 * layered on by `applyMutation` exactly once, AFTER the whole stack has been folded — that is what
 * lets three Necrotechs resolve into their own TRIPLE identity instead of re-resolving
 * intermediate pseudo-pairs.
 *
 * A mutation has to be SEEN, not just measured: the merged traits are all rendered in the world
 * (chain beams, elongated hybrid rounds, burning/poisoned auras on enemies, corpses that burst),
 * so other players can read a fusion at a glance.
 */
export function mutateDefs(a: NecrotechDef, b: NecrotechDef, superMut: boolean): NecrotechDef {
  const pattern = (a.idx + b.idx) % 2;
  const skill = pattern === 0 ? a.skill : b.skill;
  const ult = pattern === 0 ? b.ult : a.ult;
  const bonus = superMut ? 1.34 : 1.15;

  // multi-projectiles: a fusion always adds iron to the volley (the extra rounds come from
  // mods.projCount, so the per-shot count is not double-counted)
  const extraProj = superMut ? 2 : 1;
  const count = Math.max(a.stats.count, b.stats.count);
  const chain = Math.max(a.autoChain ?? 0, b.autoChain ?? 0, a.stats.chain ?? 0, b.stats.chain ?? 0);
  const decayA = a.stats.chainDecay ?? 0.7;
  const decayB = b.stats.chainDecay ?? 0.7;
  const chainDecay = Math.max(0.35, Math.min(decayA, decayB) - (superMut ? 0.1 : 0));
  const pierceBase = Math.max(a.autoPierce ?? (a.stats.style === 'pierce' ? 2 : 0), b.autoPierce ?? (b.stats.style === 'pierce' ? 2 : 0));
  const knock = Math.max(a.autoKnock ?? 0, b.autoKnock ?? 0);
  const status = a.stats.status ?? b.stats.status;
  const burnish = status === 'burn' || status === 'poison' || a.stats.style === 'heavy' || b.stats.style === 'heavy';
  const explode = Math.max(a.explodeOnKill ?? 0, b.explodeOnKill ?? 0, burnish ? (superMut ? 5.5 : 4.2) : 0);
  // status passives fuse too: PYRE·VENOM spreads fire AND smears venom on the ground
  const spreadBurn = Math.max(a.stats.spreadBurn ?? 0, b.stats.spreadBurn ?? 0);
  const spreadVenom = Math.max(a.stats.spreadVenom ?? 0, b.stats.spreadVenom ?? 0);

  const stats: NecrotechStats = {
    damage: Math.max(a.stats.damage, b.stats.damage) * bonus,
    rate: Math.max(a.stats.rate, b.stats.rate) * (superMut ? 1.16 : 1.05),
    range: Math.max(a.stats.range, b.stats.range) * (superMut ? 1.1 : 1.03),
    projSpeed: Math.max(a.stats.projSpeed, b.stats.projSpeed) * 1.06,
    // a multi-shot fusion reads as a scatter weapon, otherwise keep the tighter parent style
    style: count > 1 ? 'spread' : pattern === 0 ? a.stats.style : b.stats.style,
    count,
    color: superMut ? 0xff4df0 : 0xc94dff,
    status,
    statusPower: Math.max(a.stats.statusPower, b.stats.statusPower) * (superMut ? 1.3 : 1.1),
    // the cryo tag fuses too: a FROST fusion keeps its ice tell on the merged weapon
    cryo: a.stats.cryo || b.stats.cryo || undefined,
    chain: chain || undefined,
    chainDecay: chain > 0 ? chainDecay : undefined,
    // the hybrid round is visibly fatter and longer than either parent's
    elong: Math.max(a.stats.elong ?? 1, b.stats.elong ?? 1) * (superMut ? 1.6 : 1.3),
    life: Math.max(a.stats.life ?? 0, b.stats.life ?? 0) || undefined,
    spreadBurn: spreadBurn || undefined,
    spreadVenom: spreadVenom || undefined,
  };

  const traitLabels: string[] = [`+${extraProj} PROJECTILE${extraProj > 1 ? 'S' : ''}`];
  if (chain > 0) traitLabels.push(`ZAPS ${chain} NEARBY`);
  if (chain > 0 && chainDecay < 0.7) traitLabels.push(`SOFT CHAIN ${Math.round(chainDecay * 100)}%`);
  if (pierceBase > 0) traitLabels.push(`PIERCES ${pierceBase}`);
  if (knock > 0) traitLabels.push('KNOCKBACK');
  if (status === 'burn') traitLabels.push('IGNITES');
  if (status === 'poison') traitLabels.push('TOXIN');
  if (status === 'slow') traitLabels.push('CHILLS');
  if (spreadBurn > 0) traitLabels.push('FIRE SPREADS');
  if (spreadVenom > 0) traitLabels.push('VENOM TRAILS');
  if (superMut || (a.mods.ultDurMul ?? 1) > 1 || (b.mods.ultDurMul ?? 1) > 1) traitLabels.push('LONG ULTIMATE');
  if (explode > 0) traitLabels.push(superMut ? 'CORPSES DETONATE' : 'CORPSES BURST');

  const mods: Partial<Mods> = { ...a.mods };
  // clean merge: additive keys add, every other key multiplies
  for (const key of Object.keys(b.mods) as (keyof Mods)[]) {
    const v = b.mods[key] as number;
    if (v === undefined) continue;
    const additive = key === 'lifesteal' || key === 'crit' || key === 'dashMax';
    const cur = (mods[key] as number) ?? (additive ? 0 : 1);
    mods[key] = additive ? cur + v : cur * v;
  }
  if (superMut) {
    mods.dmgMul = (mods.dmgMul ?? 1) * 1.12;
    mods.abilityMul = (mods.abilityMul ?? 1) * 1.2;
    mods.spdMul = (mods.spdMul ?? 1) * 1.06;
  }
  // a fusion holds its ultimate together longer than either parent did — a SUPER mutation longer still
  mods.ultDurMul = (mods.ultDurMul ?? 1) * (superMut ? 1.2 : 1.1);
  // the fused weapon genuinely throws more projectiles, on top of the per-shot count
  mods.projCount = (mods.projCount ?? 0) + extraProj;

  // NOTE: the permutation identity — the registry entry's name, mods, weapon behaviour, ability
  // picks and drawback — is deliberately NOT applied here; `applyMutation` layers it on exactly
  // ONCE, after the whole stack has been folded (see Player.refoldMutations).
  return {
    idx: 100 + a.idx * 10 + b.idx,
    name: `${a.name}${superMut ? '✷' : '·'}${b.name}`,
    role: superMut ? 'SUPER MUTATION' : 'MUTATION',
    desc: `Fused kit — ${skill.name} + ${ult.name}.`,
    color: superMut ? 0xff4df0 : 0xc94dff,
    stats,
    autoChain: chain || undefined,
    autoPierce: pierceBase || undefined,
    autoKnock: knock || undefined,
    explodeOnKill: explode || undefined,
    traitLabels,
    passiveName: `${a.passiveName} + ${b.passiveName}`,
    passiveDesc: `${a.passiveDesc} ${b.passiveDesc}`,
    mods,
    skill,
    ult,
    mutated: true,
    superMut,
  };
}

/**
 * Applies a resolved MUTATION PERMUTATION to a fused loadout — the identity layer.
 *
 * Called exactly once per loadout, AFTER the generic folds, with the mutation resolved from the RAW
 * class list (a pair when two Necrotechs are held, a TRIPLE when all three slots are full). It
 * merges the entry's mods and weapon behaviour into the fused def, raises the auto-attack flags,
 * picks the loadout's Skill / Ultimate where the entry says so (triples — so all three parents
 * matter, and the picks never depend on collection order), restates the identity and applies the
 * loadout's SINGLE generic drawback. One entry, one drawback: a three-Necrotech loadout used to
 * stack two drawbacks behind one description.
 */
export function applyMutation(
  def: NecrotechDef,
  mutation: MutationDef,
  parents: NecrotechDef[],
  anySuper: boolean
): NecrotechDef {
  // ---- registry mods merge into the fused mods with the same additive/multiply rules
  if (mutation.mods) {
    for (const key of Object.keys(mutation.mods) as (keyof Mods)[]) {
      const v = mutation.mods[key] as number;
      if (v === undefined) continue;
      const additive = key === 'lifesteal' || key === 'crit' || key === 'dashMax';
      const cur = (def.mods[key] as number) ?? (additive ? 0 : 1);
      def.mods[key] = additive ? cur + v : cur * v;
    }
  }
  // ---- registry weapon behaviour, layered on top of the fused stats
  const w = mutation.weapon;
  const stats = def.stats;
  if (w) {
    if (w.chain !== undefined) {
      stats.chain = Math.max(stats.chain ?? 0, w.chain);
      stats.chainDecay = w.chainDecay ?? stats.chainDecay ?? 0.7;
    }
    if (w.count !== undefined) stats.count += w.count;
    if (w.damageMul !== undefined) stats.damage *= w.damageMul;
    if (w.rateMul !== undefined) stats.rate *= w.rateMul;
    if (w.status !== undefined) {
      stats.status = w.status;
      stats.statusPower *= w.statusPowerMul ?? 1;
    } else if (w.statusPowerMul !== undefined) {
      stats.statusPower *= w.statusPowerMul;
    }
    if (w.spreadBurn !== undefined) stats.spreadBurn = Math.max(stats.spreadBurn ?? 0, w.spreadBurn);
    if (w.spreadVenom !== undefined) stats.spreadVenom = Math.max(stats.spreadVenom ?? 0, w.spreadVenom);
    if (w.elongMul !== undefined) stats.elong = (stats.elong ?? 1) * w.elongMul;
    if (w.cryo) stats.cryo = true;
  }
  // auto-attack flags: the folds wrote their generic values, the registry raises them — max, never
  // sum, so a fusion that both chains and pierces does each at its strongest
  def.autoChain = Math.max(def.autoChain ?? 0, stats.chain ?? 0) || undefined;
  def.autoPierce = Math.max(def.autoPierce ?? 0, w?.pierce ?? 0) || undefined;
  def.autoKnock = Math.max(def.autoKnock ?? 0, w?.knock ?? 0) || undefined;
  def.explodeOnKill = Math.max(def.explodeOnKill ?? 0, w?.explodeOnKill ?? 0) || undefined;
  // ---- extra card lines
  def.traitLabels = def.traitLabels ?? [];
  if (mutation.traits) {
    for (const t of mutation.traits) if (def.traitLabels.indexOf(t) < 0) def.traitLabels.push(t);
  }
  // ---- ability picks (triples): the entry says which parent's Skill / Ultimate the kit keeps
  if (mutation.skillFrom !== undefined) {
    const want = mutation.requires[mutation.skillFrom];
    const p = want ? parents.find(q => q.name === want) : undefined;
    if (p) def.skill = p.skill;
  }
  if (mutation.ultFrom !== undefined) {
    const want = mutation.requires[mutation.ultFrom];
    const p = want ? parents.find(q => q.name === want) : undefined;
    if (p) def.ult = p.ult;
  }
  // ---- colour: a super anywhere paints the whole loadout magenta
  def.stats.color = anySuper ? 0xff4df0 : 0xc94dff;
  def.color = anySuper ? 0xff4df0 : mutation.color;
  // ---- one generic drawback per loadout (never on a super mutation)
  if (!anySuper) {
    const debuff = MUTATION_DEBUFFS[debuffIndex(mutation, parents)];
    for (const key of Object.keys(debuff.mods) as (keyof Mods)[]) {
      const v = debuff.mods[key] as number;
      def.mods[key] = ((def.mods[key] as number) ?? 1) * v;
    }
    def.debuffDesc = debuff.desc;
  }
  // ---- identity
  def.mutationId = mutation.id;
  def.mutationName = mutation.name;
  def.desc = `${mutation.name} — ${mutation.desc}`;
  return def;
}

/**
 * The loadout's generic drawback, picked deterministically from the classes involved. A pair keeps
 * exactly the drawback it always had (`base ×7 + absorbed ×3`, in collection order); a triple folds
 * all three in (`first ×7 + second ×5 + third ×3` over the mutation's canonical source order), so
 * the same three classes always carry the same drawback however they were collected.
 */
function debuffIndex(mutation: MutationDef, parents: NecrotechDef[]): number {
  const slot = (name: string | undefined): number =>
    name ? parents.find(p => p.name === name)?.idx ?? 0 : 0;
  // a triple reads the classes in the mutation's canonical order, so the drawback is independent of
  // collection order; a pair keeps the legacy base/absorbed weights (see the doc above)
  const r: readonly (string | undefined)[] = mutation.requires;
  if (mutation.requires.length > 2) {
    return (slot(r[0]) * 7 + slot(r[1]) * 5 + slot(r[2]) * 3) % MUTATION_DEBUFFS.length;
  }
  return ((parents[0]?.idx ?? 0) * 7 + (parents[1]?.idx ?? 0) * 3) % MUTATION_DEBUFFS.length;
}
