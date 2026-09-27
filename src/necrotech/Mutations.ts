// NECROFALL — the Necrotech MUTATION PERMUTATION registry.
//
// A mutation is a PERMUTATION of the Necrotechs a player holds — not a node on a skill tree. There
// is no tree, no points and no unlocks: hold two classes at once and their combination has its own
// identity (name, tags, rarity, description and a real gameplay effect layered on top of the
// ordinary fusion maths) — and a FULL three-Necrotech loadout resolves into a TRIPLE permutation
// with its own name, its own ability picks and its own effects.
//
//   VOLT + RIFT            ->  VOIDSTORM   (pair)
//   VOLT + RIFT + RAVAGER  ->  STORMLANCE  (triple — all three classes fused at once)
//
// The lookup is ORDER-INDEPENDENT: `resolveMutation('RIFT', 'VOLT')` and
// `resolveMutation('VOLT', 'RIFT')` are the same entry (the pair is normalised to a sorted key).
//
// Extending the system is a data edit, never a logic edit: add an entry to `AUTHORED` and the
// discovery panel, the HUD counter and the fused loadout all pick it up. Any pair that has no
// authored entry still resolves — deterministically, from the two classes' own vocabulary — so
// EVERY valid combination has a unique, non-generic name.
import type { Mods } from '../core/Config';

export type MutationRarity = 'common' | 'rare' | 'mythic';

/** What a mutation does to the fused weapon, on top of the standard fusion. */
export interface MutationWeapon {
  chain?: number;
  chainDecay?: number;
  pierce?: number;
  knock?: number;
  explodeOnKill?: number;
  /** Extra projectiles per shot. */
  count?: number;
  damageMul?: number;
  rateMul?: number;
  status?: 'burn' | 'slow' | 'poison';
  statusPowerMul?: number;
  spreadBurn?: number;
  spreadVenom?: number;
  elongMul?: number;
  cryo?: boolean;
}

export interface MutationDef {
  /** Stable unique id (used for the "already discovered" bookkeeping). */
  id: string;
  /** The name shown in the discovery panel. */
  name: string;
  /**
   * The Necrotechs this permutation is made of, as class names. The LOOKUP is order-independent,
   * but for a triple this array's order is what `skillFrom`/`ultFrom` index into. Two names = a
   * pair permutation, three names = a TRIPLE permutation.
   */
  requires: [string, string] | [string, string, string];
  rarity: MutationRarity;
  tags: string[];
  desc: string;
  /** The loadout's tint while this mutation is active. */
  color: number;
  mods?: Partial<Mods>;
  weapon?: MutationWeapon;
  /** Extra lines for the fusion card, alongside the computed fusion traits. */
  traits?: string[];
  /**
   * TRIPLE only: the entry of `requires` whose Skill / Ultimate the fused kit keeps — that is what
   * makes all three parents matter (weapon behaviour from all, abilities picked from the mix).
   * Pairs ignore these: their fusion maths already keeps one parent's Skill and the other's Ult.
   */
  skillFrom?: number;
  ultFrom?: number;
  /** True for hand-authored entries (they get the full discovery reveal). */
  named: boolean;
}

/** Compact authoring shape — the registry is parsed once, at module load. */
type Authored = {
  id: string;
  n: string;
  pair: [string, string];
  r: MutationRarity;
  tags: string[];
  desc: string;
  c: number;
  mods?: Partial<Mods>;
  w?: MutationWeapon;
  traits?: string[];
};

/**
 * Authoring shape for a TRIPLE permutation. `pair` is written in a canonical alphabetical order
 * (same order as the sorted key), and `skillFrom`/`ultFrom` are indices INTO THAT ARRAY — so the
 * loadout's Skill and Ultimate never depend on the order the three were collected in.
 */
type AuthoredTriple = {
  id: string;
  n: string;
  pair: [string, string, string];
  r: MutationRarity;
  tags: string[];
  desc: string;
  c: number;
  mods?: Partial<Mods>;
  w?: MutationWeapon;
  traits?: string[];
  /** Index into `pair` whose Skill the fused kit keeps. */
  skillFrom: number;
  /** Index into `pair` whose Ultimate the fused kit keeps. */
  ultFrom: number;
};

const RARE_COLOR = 0xd07bff;
const MYTHIC_COLOR = 0xff4df0;

/**
 * The authored permutations. Every pair among the eleven Necrotechs has its own authored entry —
 * any two classes a player can hold resolve to a hand-named identity, no generated fallback
 * needed. Each `w` block is layered on to the fusion the ordinary maths already built, so a
 * mutation always has BOTH the generic fusion and its own identity.
 */
const AUTHORED: Authored[] = [
  {
    id: 'voidstorm', n: 'VOIDSTORM', pair: ['VOLT', 'RIFT'], r: 'mythic', c: 0x8fb4ff,
    tags: ['CHAIN', 'PIERCE', 'VOID'],
    desc: 'A storm of phase lightning. Every bolt leaps between targets and keeps going straight through them.',
    w: { chain: 3, chainDecay: 0.82, pierce: 2, elongMul: 1.45, damageMul: 1.08 },
    mods: { abilityMul: 1.1 },
    traits: ['BOLTS CHAIN AND PIERCE'],
  },
  {
    id: 'toxicflame', n: 'TOXICFLAME', pair: ['PYRE', 'VENOM'], r: 'mythic', c: 0xa8ff5a,
    tags: ['BURN', 'TOXIN', 'SPREAD'],
    desc: 'Fire that poisons. Burning bodies smear venom, and poisoned bodies catch fire.',
    w: { status: 'poison', statusPowerMul: 1.15, spreadBurn: 4.4, spreadVenom: 4.4 },
    traits: ['FIRE AND VENOM SPREAD TOGETHER'],
  },
  {
    id: 'zeropoint', n: 'ZEROPOINT', pair: ['FROST', 'RIFT'], r: 'mythic', c: 0xbfe9ff,
    tags: ['CRYO', 'PIERCE', 'CONTROL'],
    desc: 'Cryo lances that pass through a whole rank and leave it locked in ice.',
    w: { cryo: true, pierce: 2, status: 'slow', statusPowerMul: 1.35 },
    traits: ['FREEZES WHAT IT PIERCES'],
  },
  {
    id: 'soulfire', n: 'SOULFIRE', pair: ['VOLT', 'PYRE'], r: 'rare', c: 0xffa63d,
    tags: ['CHAIN', 'BURN'],
    desc: 'Arcing flame. The bolt leaps on, and it sets every target it touches alight.',
    w: { chain: 2, chainDecay: 0.78, status: 'burn', statusPowerMul: 1.2, spreadBurn: 3.6 },
    traits: ['IGNITES EVERY ARC'],
  },
  {
    id: 'virulence', n: 'VIRULENCE', pair: ['RAVAGER', 'VENOM'], r: 'rare', c: 0x9dff6b,
    tags: ['TOXIN', 'SUSTAINED'],
    desc: 'A churning stream of toxin — faster and hungrier, and it leaves venom everywhere it looks.',
    w: { rateMul: 1.18, status: 'poison', statusPowerMul: 1.2, spreadVenom: 3.6 },
    traits: ['VENOM TRAILS EVERY ROUND'],
  },
  {
    id: 'aftershock', n: 'AFTERSHOCK', pair: ['BREAKER', 'NOVA'], r: 'mythic', c: 0xffd166,
    tags: ['KNOCKBACK', 'DETONATE'],
    desc: 'Compressed air fists that detonate the corpse. Everything nearby is launched and then blown apart.',
    w: { knock: 10, explodeOnKill: 6 },
    traits: ['KNOCKS BACK AND DETONATES'],
  },
  {
    id: 'bloodnova', n: 'BLOODNOVA', pair: ['REAPER', 'NOVA'], r: 'mythic', c: 0xff6b9d,
    tags: ['EXECUTE', 'DETONATE'],
    desc: 'Finishing rounds that burst on death. The weaker the target, the louder the end.',
    w: { explodeOnKill: 6.2 },
    mods: { execMul: 1.25 },
    traits: ['CORPSES DETONATE'],
  },
  {
    id: 'necroblast', n: 'NECROBLAST', pair: ['VOLT', 'NOVA'], r: 'rare', c: 0x7fd4ff,
    tags: ['CHAIN', 'DETONATE'],
    desc: 'Lightning that stays strong as it jumps — arcs barely weaken across the whole pack.',
    w: { chain: 3, chainDecay: 0.86, explodeOnKill: 4.6 },
    traits: ['HARD-CHAINING ARCS'],
  },
  {
    id: 'voidreaper', n: 'VOIDREAPER', pair: ['REAPER', 'RIFT'], r: 'mythic', c: 0xd07bff,
    tags: ['PIERCE', 'EXECUTE'],
    desc: 'A phased execution round. It ignores ranks, and it finishes what it opens.',
    w: { pierce: 3, elongMul: 1.5 },
    mods: { execMul: 1.32 },
    traits: ['EXECUTES THROUGH RANKS'],
  },
  {
    id: 'mirebastion', n: 'MIREBASTION', pair: ['BULWARK', 'VENOM'], r: 'rare', c: 0x9fe8b0,
    tags: ['PLATED', 'TOXIN'],
    desc: 'A plated plague-bearer: heavy, hard to kill, and dripping toxin behind it.',
    w: { status: 'poison', statusPowerMul: 1.2, spreadVenom: 3.4 },
    mods: { hpMul: 1.1, takenMul: 0.95 },
  },
  {
    id: 'glacierfist', n: 'GLACIERFIST', pair: ['BREAKER', 'FROST'], r: 'rare', c: 0xa8e6ff,
    tags: ['CRYO', 'KNOCKBACK'],
    desc: 'An ice-cased fist. Whatever it hits is launched AND left frozen where it lands.',
    w: { cryo: true, knock: 11, status: 'slow', statusPowerMul: 1.3 },
    traits: ['LAUNCHES AND FREEZES'],
  },
  {
    id: 'hellwhip', n: 'HELLWHIP', pair: ['PYRE', 'WHIPLASH'], r: 'rare', c: 0xff5b3d,
    tags: ['WHIP', 'BURN', 'SPREAD'],
    desc: 'A burning lash swept across the front arc. Everything the sweep touches catches fire.',
    w: { status: 'burn', statusPowerMul: 1.25, spreadBurn: 4.2 },
    traits: ['THE WHOLE ARC BURNS'],
  },
  {
    id: 'arcbarrage', n: 'ARCBARRAGE', pair: ['RAVAGER', 'VOLT'], r: 'rare', c: 0x7fd4ff,
    tags: ['CHAIN', 'RATE'],
    desc: 'Sustained arc fire. A faster stream whose every round jumps to the next target.',
    w: { chain: 2, chainDecay: 0.76, rateMul: 1.2 },
  },
  {
    id: 'phaselance', n: 'PHASELANCE', pair: ['RAVAGER', 'RIFT'], r: 'rare', c: 0xc08bff,
    tags: ['PIERCE'],
    desc: 'A long, thin phase round that punches through a rank without slowing down.',
    w: { pierce: 3, elongMul: 1.55, damageMul: 1.06 },
    traits: ['PIERCES A WHOLE RANK'],
  },
  {
    id: 'starfall', n: 'STARFALL', pair: ['NOVA', 'PYRE'], r: 'mythic', c: 0xff8a3d,
    tags: ['BURN', 'DETONATE', 'SPREAD'],
    desc: 'Each kill falls back to the ground as fire, then bursts.',
    w: { explodeOnKill: 6.4, spreadBurn: 4, status: 'burn' },
    traits: ['CORPSES BURN AND DETONATE'],
  },
  {
    id: 'cataclysm', n: 'CATACLYSM', pair: ['BULWARK', 'NOVA'], r: 'mythic', c: 0x6bffd4,
    tags: ['PLATED', 'KNOCKBACK', 'DETONATE'],
    desc: 'Seismic plating. Slow to wind up, and it takes the ground with everything it kills.',
    w: { knock: 7, explodeOnKill: 6 },
    mods: { takenMul: 0.94 },
  },
  {
    id: 'blightfrost', n: 'BLIGHTFROST', pair: ['FROST', 'VENOM'], r: 'rare', c: 0x8fe6ff,
    tags: ['CRYO', 'TOXIN'],
    desc: 'Frozen venom. The target is locked in place while the toxin does its work.',
    w: { cryo: true, status: 'poison', statusPowerMul: 1.25 },
    traits: ['TOXIN WHILE FROZEN'],
  },
  {
    id: 'rimelash', n: 'RIMELASH', pair: ['FROST', 'WHIPLASH'], r: 'rare', c: 0xa8e6ff,
    tags: ['WHIP', 'CRYO', 'CONTROL'],
    desc: 'A lash of hoarfrost. The front arc is swept, and the sweep leaves it iced over.',
    w: { cryo: true, status: 'slow', statusPowerMul: 1.3 },
  },
  {
    id: 'miasma', n: 'MIASMA', pair: ['REAPER', 'VENOM'], r: 'rare', c: 0x9dff6b,
    tags: ['TOXIN', 'EXECUTE'],
    desc: 'An execution round carrying plague. The wounded die faster and the ground stays poisoned.',
    w: { status: 'poison', statusPowerMul: 1.25, spreadVenom: 4 },
    mods: { execMul: 1.22 },
  },
  {
    id: 'graveward', n: 'GRAVEWARD', pair: ['BULWARK', 'REAPER'], r: 'rare', c: 0x9fe8b0,
    tags: ['PLATED', 'EXECUTE'],
    desc: 'A warden that outlasts everything and finishes what everyone else started.',
    mods: { hpMul: 1.15, takenMul: 0.92, execMul: 1.24 },
  },
  {
    id: 'cinderstorm', n: 'CINDERSTORM', pair: ['PYRE', 'RAVAGER'], r: 'rare', c: 0xff8a3d,
    tags: ['BURN', 'RATE'],
    desc: 'A faster stream of burning rounds. Everything in front of it catches.',
    w: { status: 'burn', statusPowerMul: 1.2, rateMul: 1.15, spreadBurn: 3.4 },
  },
  {
    id: 'livewire', n: 'LIVEWIRE', pair: ['VOLT', 'WHIPLASH'], r: 'rare', c: 0x7fd4ff,
    tags: ['WHIP', 'CHAIN'],
    desc: 'A live cable. The lash itself arcs on to everything beside what it strikes.',
    w: { chain: 3, chainDecay: 0.84 },
    traits: ['THE LASH ARCS'],
  },
  {
    id: 'voidlash', n: 'VOIDLASH', pair: ['RIFT', 'WHIPLASH'], r: 'rare', c: 0xc08bff,
    tags: ['WHIP', 'PIERCE'],
    desc: 'A phase lash that passes through the front rank instead of stopping at it.',
    w: { pierce: 3 },
  },
  {
    id: 'plaguelash', n: 'PLAGUELASH', pair: ['VENOM', 'WHIPLASH'], r: 'rare', c: 0x9dff6b,
    tags: ['WHIP', 'TOXIN'],
    desc: 'A lash that leaves a venom smear along the whole arc it sweeps.',
    w: { status: 'poison', statusPowerMul: 1.2, spreadVenom: 3.8 },
  },
  {
    id: 'rupturelash', n: 'RUPTURELASH', pair: ['NOVA', 'WHIPLASH'], r: 'rare', c: 0x6bffd4,
    tags: ['WHIP', 'DETONATE'],
    desc: 'A resonant lash: everything it kills comes apart in a pulse.',
    w: { explodeOnKill: 5.4 },
  },
  {
    id: 'ironlash', n: 'IRONLASH', pair: ['BREAKER', 'WHIPLASH'], r: 'common', c: 0xffd166,
    tags: ['WHIP', 'KNOCKBACK'],
    desc: 'A weighted chain. The sweep throws the whole front arc backwards.',
    w: { knock: 12 },
  },
  {
    id: 'steellash', n: 'STEELLASH', pair: ['BULWARK', 'WHIPLASH'], r: 'common', c: 0x9fe8b0,
    tags: ['WHIP', 'PLATED'],
    desc: 'A chain carried by a plated body. Trading in the front arc is now a very bad idea.',
    mods: { takenMul: 0.93, hpMul: 1.08 },
  },
  {
    id: 'carrionfist', n: 'CARRIONFIST', pair: ['BREAKER', 'VENOM'], r: 'rare', c: 0x9dff6b,
    tags: ['KNOCKBACK', 'TOXIN'],
    desc: 'A fistful of rot — whatever it launches lands in a patch of its own plague.',
    w: { knock: 9, status: 'poison', statusPowerMul: 1.22, spreadVenom: 3.8 },
    traits: ['THROWS AND INFECTS'],
  },
  {
    id: 'pillbox', n: 'PILLBOX', pair: ['BULWARK', 'RAVAGER'], r: 'common', c: 0x9fe8b0,
    tags: ['PLATED', 'SUSTAINED'],
    desc: 'A gun behind a wall. Slower to kill, much harder to kill back.',
    mods: { takenMul: 0.93, hpMul: 1.08 },
  },
  {
    id: 'bloodhunt', n: 'BLOODHUNT', pair: ['RAVAGER', 'REAPER'], r: 'rare', c: 0xff6b9d,
    tags: ['EXECUTE', 'CRIT'],
    desc: 'A hunter\'s stream: accurate, punishing, and built to close out weakened targets.',
    mods: { execMul: 1.3, crit: 0.08 },
  },
  {
    id: 'stormshear', n: 'STORMSHEAR', pair: ['REAPER', 'VOLT'], r: 'rare', c: 0xd07bff,
    tags: ['CHAIN', 'EXECUTE'],
    desc: 'A hunting storm — the bolt leaps, and every jump lands on whatever is already bleeding.',
    w: { chain: 2, chainDecay: 0.78 },
    mods: { execMul: 1.26 },
    traits: ['ARCS HUNT THE WOUNDED'],
  },
  {
    id: 'stormfist', n: 'STORMFIST', pair: ['BREAKER', 'VOLT'], r: 'rare', c: 0x7fd4ff,
    tags: ['KNOCKBACK', 'CHAIN'],
    desc: 'A fist of lightning. It launches what it hits and arcs on to whoever is standing beside them.',
    w: { chain: 2, chainDecay: 0.78, knock: 9 },
  },
  {
    id: 'magmafist', n: 'MAGMAFIST', pair: ['BREAKER', 'PYRE'], r: 'rare', c: 0xff5b3d,
    tags: ['KNOCKBACK', 'BURN'],
    desc: 'Molten impact. The target is thrown away and lands on fire.',
    w: { status: 'burn', statusPowerMul: 1.25, knock: 8, spreadBurn: 3.4 },
  },
  {
    id: 'phasefist', n: 'PHASEFIST', pair: ['BREAKER', 'RIFT'], r: 'rare', c: 0xc08bff,
    tags: ['KNOCKBACK', 'PIERCE'],
    desc: 'A phase punch: it passes through the first body and throws the second.',
    w: { pierce: 2, knock: 9 },
  },
  {
    id: 'siewall', n: 'SIEGEWALL', pair: ['BREAKER', 'BULWARK'], r: 'mythic', c: 0x9fe8b0,
    tags: ['PLATED', 'KNOCKBACK', 'TANK'],
    desc: 'The slowest, heaviest loadout in the game. You will not die, and neither will your target.',
    w: { knock: 10 },
    mods: { takenMul: 0.87, hpMul: 1.16, spdMul: 0.97 },
    traits: ['A MOVING FORTRESS'],
  },
  {
    id: 'gravefist', n: 'GRAVEFIST', pair: ['BREAKER', 'REAPER'], r: 'rare', c: 0xff6b9d,
    tags: ['EXECUTE', 'KNOCKBACK'],
    desc: 'A fist aimed at whoever is already finished.',
    w: { knock: 8 },
    mods: { execMul: 1.32 },
  },
  {
    id: 'stormwall', n: 'STORMWALL', pair: ['BULWARK', 'VOLT'], r: 'rare', c: 0x9fe8b0,
    tags: ['PLATED', 'CHAIN'],
    desc: 'Plated arc weaponry: the round arcs on, and the body behind it does not flinch.',
    w: { chain: 2, chainDecay: 0.76 },
    mods: { takenMul: 0.94, hpMul: 1.08 },
  },
  {
    id: 'arcplague', n: 'ARCPLAGUE', pair: ['VOLT', 'VENOM'], r: 'rare', c: 0x9dff6b,
    tags: ['CHAIN', 'TOXIN'],
    desc: 'Carried plague. The arc infects everything it touches and then jumps.',
    w: { chain: 2, chainDecay: 0.78, status: 'poison', statusPowerMul: 1.2, spreadVenom: 3.4 },
  },
  {
    id: 'voidflame', n: 'VOIDFLAME', pair: ['PYRE', 'RIFT'], r: 'mythic', c: 0xff5b3d,
    tags: ['BURN', 'PIERCE'],
    desc: 'Fire that does not stop at the front rank. The whole lane burns.',
    w: { status: 'burn', statusPowerMul: 1.2, pierce: 2, spreadBurn: 4 },
  },
  {
    id: 'forgewall', n: 'FORGEWALL', pair: ['BULWARK', 'PYRE'], r: 'rare', c: 0xff8a3d,
    tags: ['PLATED', 'BURN'],
    desc: 'A furnace behind plating. Advance into it and you burn; survive it and you still have to kill it.',
    w: { status: 'burn', statusPowerMul: 1.2, spreadBurn: 3.8 },
    mods: { takenMul: 0.94, hpMul: 1.08 },
  },
  {
    id: 'ashreap', n: 'ASHREAP', pair: ['PYRE', 'REAPER'], r: 'rare', c: 0xff6b9d,
    tags: ['BURN', 'EXECUTE'],
    desc: 'Fire that finishes. Weakened targets burn out and leave fire behind.',
    w: { status: 'burn', statusPowerMul: 1.25, spreadBurn: 4 },
    mods: { execMul: 1.26 },
  },
  {
    id: 'riftguard', n: 'RIFTGUARD', pair: ['BULWARK', 'RIFT'], r: 'rare', c: 0xc08bff,
    tags: ['PLATED', 'PIERCE'],
    desc: 'A guarded phase weapon: it cuts through a rank and the body behind it holds the line.',
    w: { pierce: 2 },
    mods: { takenMul: 0.93, hpMul: 1.08 },
  },
  {
    id: 'voidplague', n: 'VOIDPLAGUE', pair: ['RIFT', 'VENOM'], r: 'rare', c: 0x9dff6b,
    tags: ['PIERCE', 'TOXIN'],
    desc: 'A toxin round that phases through the front rank and infects the one behind it.',
    w: { pierce: 2, status: 'poison', statusPowerMul: 1.22, spreadVenom: 3.6 },
  },
  {
    id: 'blacksun', n: 'BLACKSUN', pair: ['NOVA', 'RIFT'], r: 'mythic', c: 0xd07bff,
    tags: ['PIERCE', 'DETONATE'],
    desc: 'A collapsing phase round: it passes through everything and each kill implodes.',
    w: { pierce: 2, explodeOnKill: 6 },
  },
  {
    id: 'permafrost', n: 'PERMAFROST', pair: ['BULWARK', 'FROST'], r: 'mythic', c: 0xbfe9ff,
    tags: ['PLATED', 'CRYO'],
    desc: 'A frozen wall. Shards that lock a pack where it stands, fired from something that will not move.',
    w: { cryo: true, status: 'slow', statusPowerMul: 1.3 },
    mods: { takenMul: 0.92, hpMul: 1.1 },
  },
  {
    id: 'soulfrost', n: 'SOULFROST', pair: ['FROST', 'REAPER'], r: 'rare', c: 0xbfe9ff,
    tags: ['CRYO', 'EXECUTE'],
    desc: 'Cold and final. Frozen targets cannot run, and the wounded cannot survive.',
    w: { cryo: true, status: 'slow', statusPowerMul: 1.3 },
    mods: { execMul: 1.26 },
  },
  {
    id: 'cryoclast', n: 'CRYOCLAST', pair: ['FROST', 'NOVA'], r: 'rare', c: 0xa8e6ff,
    tags: ['CRYO', 'DETONATE'],
    desc: 'Ice that shatters. Every frozen corpse comes apart in a cold pulse.',
    w: { cryo: true, status: 'slow', statusPowerMul: 1.25, explodeOnKill: 5.2 },
  },
  {
    id: 'plaguenova', n: 'PLAGUENOVA', pair: ['NOVA', 'VENOM'], r: 'rare', c: 0x9dff6b,
    tags: ['TOXIN', 'DETONATE'],
    desc: 'A toxic bloom: each kill bursts into a plume of venom.',
    w: { status: 'poison', statusPowerMul: 1.2, explodeOnKill: 5.6, spreadVenom: 4 },
  },
  {
    id: 'fleshforge', n: 'FLESHFORGE', pair: ['NOVA', 'RAVAGER'], r: 'common', c: 0xff8a3d,
    tags: ['DETONATE', 'SUSTAINED'],
    desc: 'A steady stream that leaves the ground littered with small detonations.',
    w: { explodeOnKill: 5, rateMul: 1.06 },
  },
  {
    id: 'hollowpoint', n: 'HOLLOWPOINT', pair: ['RAVAGER', 'BREAKER'], r: 'common', c: 0xffd166,
    tags: ['KNOCKBACK', 'DAMAGE'],
    desc: 'Heavier rounds, slower stream. Everything in front of them ends up further away.',
    w: { knock: 7, damageMul: 1.08, rateMul: 0.96 },
  },
  {
    id: 'rimestorm', n: 'RIMESTORM', pair: ['FROST', 'VOLT'], r: 'rare', c: 0xa8e6ff,
    tags: ['CHAIN', 'CRYO'],
    desc: 'A rimestorm riding live arcs — every jump lands with the frost already biting in.',
    w: { chain: 3, chainDecay: 0.8, cryo: true, status: 'slow', statusPowerMul: 1.3 },
    traits: ['EVERY ARC LANDS FROZEN'],
  },
  {
    id: 'emberfrost', n: 'EMBERFROST', pair: ['PYRE', 'FROST'], r: 'rare', c: 0xdfeaff,
    tags: ['BURN', 'CRYO'],
    desc: 'A round that burns on the way in and freezes where it lands — scorched, then iced.',
    w: { status: 'burn', statusPowerMul: 1.25, spreadBurn: 4, cryo: true },
    traits: ['SCORCHES THEN ICES'],
  },
  {
    id: 'gravecall', n: 'GRAVECALL', pair: ['REAPER', 'WHIPLASH'], r: 'common', c: 0xff6b9d,
    tags: ['WHIP', 'EXECUTE'],
    desc: 'A heavy chain that only gets hungry once the target is bleeding.',
    mods: { execMul: 1.2 },
  },
  {
    id: 'chainfire', n: 'CHAINFIRE', pair: ['RAVAGER', 'WHIPLASH'], r: 'common', c: 0x7fd4ff,
    tags: ['WHIP', 'CHAIN'],
    desc: 'An arc lash: the sweep carries a charge on to whatever stands beside the target.',
    w: { chain: 2, chainDecay: 0.76 },
  },
  {
    id: 'frostbite', n: 'FROSTBITE', pair: ['FROST', 'RAVAGER'], r: 'common', c: 0xbfe9ff,
    tags: ['CRYO', 'SUSTAINED'],
    desc: 'A steady stream of cryo shards. Nothing it touches is going anywhere quickly.',
    w: { cryo: true, status: 'slow', statusPowerMul: 1.2 },
  },
];

/**
 * The authored TRIPLE permutations — all three Necrotechs folded into one identity.
 *
 * A triple is what a FULL loadout resolves to: three classes held at once, with their own name,
 * their own ability picks (`skillFrom` / `ultFrom` — the kit keeps one parent's Skill and another's
 * Ultimate, chosen per permutation so all three classes matter) and their own effects layered on
 * top of the double fusion maths. Every triple that has no entry here still resolves, through the
 * generated fallback in `resolveTripleMutation` — it is never left unnamed.
 *
 * `pair` is written in canonical ALPHABETICAL order (the same order the sorted key uses); the
 * skill/ult indices point into that array.
 */
const TRIPLES: AuthoredTriple[] = [
  // ---- spawn-class triples (any three of RAVAGER / VOLT / PYRE / RIFT / FROST / VENOM)
  {
    id: 't_ashstorm', n: 'ASHSTORM', pair: ['PYRE', 'RAVAGER', 'VOLT'], r: 'mythic', c: 0xff9a4d,
    tags: ['BURN', 'CHAIN', 'RATE'],
    desc: 'A burning barrage that arcs. Every round ignites what it hits and leaps on to the next.',
    w: { chain: 3, chainDecay: 0.8, status: 'burn', statusPowerMul: 1.25, spreadBurn: 4, rateMul: 1.15 },
    traits: ['BURNING ARCS'],
    skillFrom: 1, ultFrom: 0, // Salvo · Meteor
  },
  {
    id: 't_stormlance', n: 'STORMLANCE', pair: ['RAVAGER', 'RIFT', 'VOLT'], r: 'mythic', c: 0x9fc8ff,
    tags: ['CHAIN', 'PIERCE', 'SUSTAINED'],
    desc: 'A sustained storm round that phases through a rank and keeps arcing.',
    w: { chain: 3, chainDecay: 0.84, pierce: 3, elongMul: 1.4, damageMul: 1.08 },
    mods: { abilityMul: 1.08 },
    traits: ['EVERY ROUND ZAPS AND PIERCES'],
    skillFrom: 2, ultFrom: 1, // Lightning Lance · Black Hole
  },
  {
    id: 't_cryostorm', n: 'CRYOSTORM', pair: ['FROST', 'RAVAGER', 'VOLT'], r: 'rare', c: 0x9fe4ff,
    tags: ['CHAIN', 'CRYO'],
    desc: 'Arctic arc fire: the bolt leaps, and everything it touches slows to a crawl.',
    w: { chain: 3, chainDecay: 0.8, cryo: true, status: 'slow', statusPowerMul: 1.3 },
    skillFrom: 2, ultFrom: 0, // Lightning Lance · Absolute Zero
  },
  {
    id: 't_blightarc', n: 'BLIGHTARC', pair: ['RAVAGER', 'VENOM', 'VOLT'], r: 'rare', c: 0x8fe07a,
    tags: ['CHAIN', 'TOXIN'],
    desc: 'A toxic stream that arcs — the infection travels with every jump.',
    w: { chain: 3, chainDecay: 0.82, status: 'poison', statusPowerMul: 1.25, spreadVenom: 4, rateMul: 1.1 },
    skillFrom: 0, ultFrom: 1, // Salvo · Plaguewake
  },
  {
    id: 't_emberlance', n: 'EMBERLANCE', pair: ['PYRE', 'RAVAGER', 'RIFT'], r: 'mythic', c: 0xff8a55,
    tags: ['BURN', 'PIERCE', 'RATE'],
    desc: 'A phase lance of burning rounds — the whole lane catches fire.',
    w: { pierce: 3, status: 'burn', statusPowerMul: 1.25, spreadBurn: 4.2, rateMul: 1.1, elongMul: 1.4 },
    skillFrom: 2, ultFrom: 0, // Blink Strike · Meteor
  },
  {
    id: 't_steamforge', n: 'STEAMFORGE', pair: ['FROST', 'PYRE', 'RAVAGER'], r: 'rare', c: 0xdfeaff,
    tags: ['BURN', 'CRYO'],
    desc: 'Superheated rounds that chill on impact — burned on the way in, iced where they land.',
    w: { status: 'burn', statusPowerMul: 1.3, spreadBurn: 4.4, cryo: true },
    mods: { takenMul: 0.95 },
    skillFrom: 1, ultFrom: 0, // Flamewave · Absolute Zero
  },
  {
    id: 't_festerflame', n: 'FESTERFLAME', pair: ['PYRE', 'RAVAGER', 'VENOM'], r: 'mythic', c: 0xb5ff5e,
    tags: ['BURN', 'TOXIN', 'SPREAD'],
    desc: 'Fire that rots. Burning bodies smear venom, and poisoned bodies catch fire.',
    w: { status: 'poison', statusPowerMul: 1.3, spreadBurn: 4.4, spreadVenom: 4.4, rateMul: 1.1 },
    traits: ['FIRE AND VENOM SPREAD TOGETHER'],
    skillFrom: 1, ultFrom: 2, // Salvo · Plaguewake
  },
  {
    id: 't_icerail', n: 'ICERAIL', pair: ['FROST', 'RAVAGER', 'RIFT'], r: 'mythic', c: 0xbfe9ff,
    tags: ['CRYO', 'PIERCE', 'SUSTAINED'],
    desc: 'A rail of ice. It cuts through the whole rank and freezes it solid.',
    w: { pierce: 3, cryo: true, status: 'slow', statusPowerMul: 1.35, elongMul: 1.5, damageMul: 1.06 },
    skillFrom: 1, ultFrom: 2, // Salvo · Black Hole
  },
  {
    id: 't_venomrail', n: 'VENOMRAIL', pair: ['RAVAGER', 'RIFT', 'VENOM'], r: 'rare', c: 0x9dff6b,
    tags: ['PIERCE', 'TOXIN'],
    desc: 'A toxic rail round — through the front rank, and the ground behind it stays poisoned.',
    w: { pierce: 3, status: 'poison', statusPowerMul: 1.25, spreadVenom: 4, damageMul: 1.05 },
    skillFrom: 0, ultFrom: 2, // Salvo · Plaguewake
  },
  {
    id: 't_rimestream', n: 'RIMESTREAM', pair: ['FROST', 'RAVAGER', 'VENOM'], r: 'rare', c: 0x9fe0a8,
    tags: ['CRYO', 'TOXIN', 'RATE'],
    desc: 'A frozen stream of plague. The target cannot run from what is killing it.',
    w: { cryo: true, status: 'poison', statusPowerMul: 1.3, spreadVenom: 3.8, rateMul: 1.1 },
    skillFrom: 1, ultFrom: 0, // Salvo · Absolute Zero
  },
  {
    id: 't_pyrostorm', n: 'PYROSTORM', pair: ['PYRE', 'RIFT', 'VOLT'], r: 'mythic', c: 0xff8a3d,
    tags: ['CHAIN', 'BURN', 'PIERCE'],
    desc: 'A storm of chain fire that phases — the bolt ignites, leaps, and does not stop at a rank.',
    w: { chain: 3, chainDecay: 0.82, pierce: 2, status: 'burn', statusPowerMul: 1.25, spreadBurn: 4.2, elongMul: 1.35 },
    skillFrom: 2, ultFrom: 0, // Lightning Lance · Meteor
  },
  {
    id: 't_frostfire', n: 'FROSTFIRE', pair: ['FROST', 'PYRE', 'VOLT'], r: 'rare', c: 0xa8e6ff,
    tags: ['CHAIN', 'BURN', 'CRYO'],
    desc: 'Thunder that burns and chills at once — arcs arrive on fire and leave frost behind.',
    w: { chain: 3, chainDecay: 0.8, status: 'burn', statusPowerMul: 1.25, spreadBurn: 3.8, cryo: true },
    skillFrom: 2, ultFrom: 0, // Lightning Lance · Absolute Zero
  },
  {
    id: 't_soulrot', n: 'SOULROT', pair: ['PYRE', 'VENOM', 'VOLT'], r: 'mythic', c: 0xc8ff6b,
    tags: ['CHAIN', 'BURN', 'TOXIN'],
    desc: 'Every arc carries fire and rot. There is nowhere for the next target to stand.',
    w: { chain: 3, chainDecay: 0.82, status: 'poison', statusPowerMul: 1.3, spreadBurn: 4.2, spreadVenom: 4.2 },
    traits: ['EVERY ARC CARRIES FIRE AND ROT'],
    skillFrom: 0, ultFrom: 1, // Flamewave · Plaguewake
  },
  {
    id: 't_voidfrost', n: 'VOIDFROST', pair: ['FROST', 'RIFT', 'VOLT'], r: 'mythic', c: 0xaee6ff,
    tags: ['CHAIN', 'PIERCE', 'CRYO'],
    desc: 'Phase arcs of absolute cold — they leap, they pass through, and they lock the pack in ice.',
    w: { chain: 3, chainDecay: 0.82, pierce: 2, cryo: true, status: 'slow', statusPowerMul: 1.35, elongMul: 1.4 },
    skillFrom: 2, ultFrom: 1, // Lightning Lance · Black Hole
  },
  {
    id: 't_plaguestorm', n: 'PLAGUESTORM', pair: ['RIFT', 'VENOM', 'VOLT'], r: 'mythic', c: 0x9dffb0,
    tags: ['CHAIN', 'PIERCE', 'TOXIN'],
    desc: 'A toxic tempest that phases — chain, pierce and plague in one round.',
    w: { chain: 3, chainDecay: 0.84, pierce: 2, status: 'poison', statusPowerMul: 1.3, spreadVenom: 4.2, elongMul: 1.4 },
    skillFrom: 2, ultFrom: 0, // Lightning Lance · Black Hole
  },
  {
    id: 't_blightstorm', n: 'BLIGHTSTORM', pair: ['FROST', 'VENOM', 'VOLT'], r: 'rare', c: 0x8fe6b0,
    tags: ['CHAIN', 'CRYO', 'TOXIN'],
    desc: 'Frozen plague riding live arcs — the infection arrives faster than the legs can run.',
    w: { chain: 3, chainDecay: 0.8, status: 'poison', statusPowerMul: 1.3, spreadVenom: 3.8, cryo: true },
    skillFrom: 2, ultFrom: 1, // Lightning Lance · Plaguewake
  },
  {
    id: 't_steamrift', n: 'STEAMRIFT', pair: ['FROST', 'PYRE', 'RIFT'], r: 'rare', c: 0xdfe0ff,
    tags: ['BURN', 'PIERCE', 'CRYO'],
    desc: 'A phase round of scald and frost — the lane burns, then locks.',
    w: { status: 'burn', statusPowerMul: 1.3, pierce: 2, spreadBurn: 4, cryo: true },
    skillFrom: 1, ultFrom: 2, // Flamewave · Black Hole
  },
  {
    id: 't_rotfire', n: 'ROTFIRE', pair: ['PYRE', 'RIFT', 'VENOM'], r: 'mythic', c: 0xaaff5e,
    tags: ['BURN', 'PIERCE', 'TOXIN'],
    desc: 'Fire that does not stop at the front rank, and rot left in the lane behind it.',
    w: { status: 'poison', statusPowerMul: 1.3, pierce: 2, spreadBurn: 4.2, spreadVenom: 4.2 },
    skillFrom: 0, ultFrom: 1, // Flamewave · Black Hole
  },
  {
    id: 't_hellrot', n: 'HELLROT', pair: ['FROST', 'PYRE', 'VENOM'], r: 'mythic', c: 0xc0ff70,
    tags: ['BURN', 'TOXIN', 'CRYO'],
    desc: 'The worst of all three: burns, rots and freezes, and spreads every way it can.',
    w: { status: 'poison', statusPowerMul: 1.35, spreadBurn: 4.4, spreadVenom: 4.4, cryo: true },
    mods: { abilityMul: 1.08 },
    skillFrom: 1, ultFrom: 2, // Flamewave · Plaguewake
  },
  {
    id: 't_cryoplague', n: 'CRYOPLAGUE', pair: ['FROST', 'RIFT', 'VENOM'], r: 'mythic', c: 0x8fe6d0,
    tags: ['CRYO', 'PIERCE', 'TOXIN'],
    desc: 'An ice-cased plague round that phases through the rank and takes root behind it.',
    w: { pierce: 2, cryo: true, status: 'poison', statusPowerMul: 1.35, spreadVenom: 4, elongMul: 1.35 },
    skillFrom: 1, ultFrom: 2, // Blink Strike · Plaguewake
  },

  // ---- drop-class triples (the hybrids built around BREAKER / BULWARK / REAPER / NOVA / WHIPLASH)
  {
    id: 't_tempestfist', n: 'TEMPESTFIST', pair: ['BREAKER', 'RAVAGER', 'VOLT'], r: 'rare', c: 0xffd166,
    tags: ['KNOCKBACK', 'CHAIN', 'RATE'],
    desc: 'Compressed air and live arcs — the fists throw, and the charge follows the throw.',
    w: { chain: 3, chainDecay: 0.8, knock: 10, rateMul: 1.1 },
    skillFrom: 0, ultFrom: 2, // Shockcone · Thunder Zone
  },
  {
    id: 't_voidscythe', n: 'VOIDSCYTHE', pair: ['REAPER', 'RIFT', 'VOLT'], r: 'mythic', c: 0xd07bff,
    tags: ['EXECUTE', 'PIERCE', 'CHAIN'],
    desc: 'A phased execution arc — it reaches through the front rank and hunts the wounded behind it.',
    w: { pierce: 3, chain: 2, chainDecay: 0.8, elongMul: 1.4 },
    mods: { execMul: 1.3, abilityMul: 1.08 },
    traits: ['EXECUTES THROUGH RANKS'],
    skillFrom: 0, ultFrom: 1, // Scythe Arc · Black Hole
  },
  {
    id: 't_solarreap', n: 'SOLARREAP', pair: ['NOVA', 'PYRE', 'REAPER'], r: 'mythic', c: 0xffb03d,
    tags: ['DETONATE', 'EXECUTE', 'BURN'],
    desc: 'Every corpse goes up like a small sun — the weaker the kill, the wider the flare.',
    w: { explodeOnKill: 6.6, status: 'burn', statusPowerMul: 1.2, spreadBurn: 4 },
    mods: { execMul: 1.28 },
    skillFrom: 2, ultFrom: 0, // Scythe Arc · Supernova
  },
  {
    id: 't_chaoslash', n: 'CHAOSLASH', pair: ['PYRE', 'VOLT', 'WHIPLASH'], r: 'mythic', c: 0xff9a6b,
    tags: ['WHIP', 'CHAIN', 'BURN'],
    desc: 'A live, burning lash — the sweep arcs on to everyone beside the target and sets them alight.',
    w: { chain: 3, chainDecay: 0.84, status: 'burn', statusPowerMul: 1.3, spreadBurn: 4 },
    traits: ['THE LASH ARCS AND BURNS'],
    skillFrom: 2, ultFrom: 0, // Spinner · Meteor
  },
  {
    id: 't_thunderhold', n: 'THUNDERHOLD', pair: ['BULWARK', 'FROST', 'VOLT'], r: 'mythic', c: 0x9fe8d8,
    tags: ['PLATED', 'CRYO', 'CHAIN'],
    desc: 'A thunderhead behind a wall of ice. It does not move — and neither will you.',
    w: { chain: 2, chainDecay: 0.78, cryo: true, status: 'slow', statusPowerMul: 1.3 },
    mods: { takenMul: 0.92, hpMul: 1.1 },
    skillFrom: 2, ultFrom: 1, // Lightning Lance · Absolute Zero
  },
  {
    id: 't_avalanche', n: 'AVALANCHE', pair: ['BREAKER', 'FROST', 'RIFT'], r: 'mythic', c: 0xbfe9ff,
    tags: ['KNOCKBACK', 'CRYO', 'PIERCE'],
    desc: 'A phase-cased avalanche — everything in the lane is thrown, frozen and then finished.',
    w: { cryo: true, knock: 11, pierce: 2, status: 'slow', statusPowerMul: 1.35 },
    skillFrom: 0, ultFrom: 2, // Shockcone · Black Hole
  },
  {
    id: 't_novastorm', n: 'NOVASTORM', pair: ['NOVA', 'RAVAGER', 'VOLT'], r: 'rare', c: 0x6bffd4,
    tags: ['DETONATE', 'CHAIN', 'RATE'],
    desc: 'Resonant arc rounds — every kill pops, and every arc carries the pop onward.',
    w: { chain: 3, chainDecay: 0.82, explodeOnKill: 5.6, rateMul: 1.1 },
    skillFrom: 1, ultFrom: 0, // Salvo · Supernova
  },
  {
    id: 't_ironstorm', n: 'IRONSTORM', pair: ['BULWARK', 'RAVAGER', 'VOLT'], r: 'mythic', c: 0x9fc0ff,
    tags: ['PLATED', 'CHAIN', 'RATE'],
    desc: 'A walking gun platform wired into the storm — it shrugs off the hits and the arcs never stop.',
    w: { chain: 3, chainDecay: 0.8, rateMul: 1.12 },
    mods: { takenMul: 0.94, hpMul: 1.08, abilityMul: 1.06 },
    skillFrom: 1, ultFrom: 2, // Salvo · Thunder Zone
  },
  {
    id: 't_sepulcher', n: 'SEPULCHER', pair: ['BULWARK', 'REAPER', 'VENOM'], r: 'mythic', c: 0x9fe8b0,
    tags: ['PLATED', 'EXECUTE', 'TOXIN'],
    desc: 'A walking tomb — plated, patient, poisonous, and it finishes anything already bleeding.',
    w: { status: 'poison', statusPowerMul: 1.25, spreadVenom: 3.8 },
    mods: { hpMul: 1.12, takenMul: 0.9, execMul: 1.26 },
    skillFrom: 1, ultFrom: 2, // Scythe Arc · Plaguewake
  },
];

// ---------------------------------------------------------------- vocabulary (for the fallback)

/**
 * One word-pair per class, used to name a combination that has no authored entry. The generated
 * name is still specific to the two classes involved — never "Mutation 1" — and the pair is
 * normalised first, so both orderings produce the identical name.
 */
const VOCAB: Record<string, { adj: string; noun: string }> = {
  RAVAGER: { adj: 'IRON', noun: 'BARRAGE' },
  BREAKER: { adj: 'STONE', noun: 'QUAKE' },
  VOLT: { adj: 'ARC', noun: 'STORM' },
  PYRE: { adj: 'CINDER', noun: 'PYRE' },
  RIFT: { adj: 'VOID', noun: 'RIFT' },
  BULWARK: { adj: 'BASTION', noun: 'BULWARK' },
  FROST: { adj: 'GLACIAL', noun: 'FROST' },
  VENOM: { adj: 'TOXIC', noun: 'PLAGUE' },
  REAPER: { adj: 'BLOOD', noun: 'REAP' },
  NOVA: { adj: 'STAR', noun: 'NOVA' },
  WHIPLASH: { adj: 'CHAIN', noun: 'LASH' },
};

/** Sorted key for a pair — this is what makes the lookup order-independent. */
function pairKey(a: string, b: string): string {
  return a <= b ? `${a}+${b}` : `${b}+${a}`;
}

/** Sorted key for a triple, built on the same normalisation. */
function tripleKey(a: string, b: string, c: string): string {
  return [a, b, c].sort().join('+');
}

const REGISTRY = new Map<string, MutationDef>();
/** Generated fallbacks are cached so repeated fusions reuse one object. */
const GENERATED = new Map<string, MutationDef>();

for (const a of AUTHORED) {
  const def: MutationDef = {
    id: a.id,
    name: a.n,
    requires: a.pair,
    rarity: a.r,
    tags: a.tags,
    desc: a.desc,
    color: a.c,
    mods: a.mods,
    weapon: a.w,
    traits: a.traits,
    named: true,
  };
  REGISTRY.set(pairKey(a.pair[0], a.pair[1]), def);
}

const REGISTRY3 = new Map<string, MutationDef>();
/** Generated triples are cached the same way the pair fallbacks are. */
const GENERATED3 = new Map<string, MutationDef>();

for (const a of TRIPLES) {
  const def: MutationDef = {
    id: a.id,
    name: a.n,
    requires: a.pair,
    rarity: a.r,
    tags: a.tags,
    desc: a.desc,
    color: a.c,
    mods: a.mods,
    weapon: a.w,
    traits: a.traits,
    skillFrom: a.skillFrom,
    ultFrom: a.ultFrom,
    named: true,
  };
  REGISTRY3.set(tripleKey(a.pair[0], a.pair[1], a.pair[2]), def);
}

/**
 * The mutation two Necrotechs produce. Hand-authored entries win; anything else resolves to a
 * deterministic, uniquely named combination generated from the two classes' own vocabulary, so a
 * player can never fuse two classes and be told nothing happened.
 */
export function resolveMutation(aName: string, bName: string): MutationDef {
  const key = pairKey(aName, bName);
  const hit = REGISTRY.get(key);
  if (hit) return hit;
  const cached = GENERATED.get(key);
  if (cached) return cached;
  const first = aName <= bName ? aName : bName;
  const second = aName <= bName ? bName : aName;
  const va = VOCAB[first] ?? { adj: first, noun: first };
  const vb = VOCAB[second] ?? { adj: second, noun: second };
  const gen: MutationDef = {
    id: `gen_${first.toLowerCase()}_${second.toLowerCase()}`,
    name: `${va.adj}${vb.noun}`,
    requires: [first, second],
    rarity: 'common',
    tags: ['FUSION'],
    desc: `${first} and ${second} fold into one loadout: one parent's Skill, the other's Ultimate, and both weapons' behaviour at once.`,
    color: RARE_COLOR,
    named: false,
  };
  GENERATED.set(key, gen);
  return gen;
}

/**
 * The TRIPLE permutation three Necrotechs produce — the identity of a FULL loadout.
 *
 * Lookup is order-independent (the triple is normalised to a sorted key), authored entries win, and
 * anything else resolves to a deterministic, uniquely named triple generated from the three
 * classes' own vocabulary — so a player who fills all three slots is never told nothing happened.
 * The generated fallback also picks its abilities (first class's Skill, last class's Ultimate) and
 * carries a small universal "third parent" bonus, so every triple is a real step up from a pair.
 */
export function resolveTripleMutation(aName: string, bName: string, cName: string): MutationDef {
  const key = tripleKey(aName, bName, cName);
  const hit = REGISTRY3.get(key);
  if (hit) return hit;
  const cached = GENERATED3.get(key);
  if (cached) return cached;
  const [first, second, third] = [aName, bName, cName].sort();
  const va = VOCAB[first] ?? { adj: first, noun: first };
  const vb = VOCAB[second] ?? { adj: second, noun: second };
  const vc = VOCAB[third] ?? { adj: third, noun: third };
  // a class absorbed twice is possible (drops roll from the whole pool), so the generated name and
  // description collapse repeated words instead of stuttering ("BASTIONBARRAGEBARRAGE")
  const words = [va.adj, vb.noun];
  if (vc.noun !== vb.noun) words.push(vc.noun);
  const distinct = [...new Set([first, second, third])];
  const gen: MutationDef = {
    id: `gen3_${first.toLowerCase()}_${second.toLowerCase()}_${third.toLowerCase()}`,
    name: words.join(''),
    requires: [first, second, third],
    rarity: 'common',
    tags: ['TRIPLE', 'FUSION'],
    desc: `${distinct.join(' + ')} fold into a single loadout — every weapon's behaviour at once, holding ${first}'s Skill and ${third}'s Ultimate.`,
    color: RARE_COLOR,
    named: false,
    weapon: { damageMul: 1.06, rateMul: 1.05 },
    traits: ['TRIPLE FUSION'],
    skillFrom: 0,
    ultFrom: 2,
  };
  GENERATED3.set(key, gen);
  return gen;
}

/** Every authored permutation — the size of the content surface, handy for debug output. */
export const AUTHORED_MUTATION_COUNT = AUTHORED.length + TRIPLES.length;

/** How many of those permutations are triples (all three slots full). */
export const AUTHORED_TRIPLE_COUNT = TRIPLES.length;

/** Rarity tint used by the discovery panel. */
export function rarityColor(r: MutationRarity): string {
  if (r === 'mythic') return '#ff4df0';
  if (r === 'rare') return '#d07bff';
  return '#9a6bff';
}

export const MYTHIC_TINT = MYTHIC_COLOR;
