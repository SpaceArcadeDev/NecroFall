// NECROFALL — PROCEDURAL ENEMY CORE TYPES (plan §16/§19/§22/§26). What the grammars produce:
// a locomotion class, a gait, an attack list with telegraphs, an ecology role and the
// species relationships. These ride ON TOP of the shipped `EnemyGenome` (optional fields), so
// the whole existing simulation — abilities, pooling, LOD, netcode — runs unchanged.
import type { AbilityId } from '../EnemyGenomes';
import type { BiomeClass } from '../../world/PlanetArchetypes';

// ------------------------------------------------------------ locomotion (plan §19)

export type LocomotionId =
  | 'WALKER'    // alternating leg groups, the baseline
  | 'CRAWLER'   // low body, fast acceleration
  | 'LEAPER'    // compress → wind-up → launch → air → landing → recovery
  | 'BURROWER'  // dives underground, moves through terrain, emerges
  | 'HOPPER'    // short repeated hops
  | 'SLITHER'   // a travelling body wave through the segments
  | 'CHARGER'   // slow wind-up, straight-line acceleration
  | 'FLOATING'  // low-gravity drift
  | 'STALKING'  // slow, stops often, observes
  | 'SWARM';    // flock-like steering, quick small steps

/** Everything the procedural animator needs for one gait (plan §20/§21). */
export interface GaitProfile {
  style: LocomotionId;
  /** Leg swing amplitude multiplier (radians-ish). */
  stride: number;
  /** Vertical bob height (world units × scale). */
  bob: number;
  /** Bob rate multiplier relative to the base walk cycle. */
  rate: number;
  /** Phase offset between leg pairs: PI = alternating walk, 0 = bound (hops/leaps). */
  pairOffset: number;
  /** Slither wave amplitude for segmented bodies. */
  slither: number;
  /** Forward body lean while moving (radians). */
  lean: number;
  /** Idle breathing amplitude (scale fraction). */
  breathe: number;
  /** Glow-sac pulse rate (0 = none). */
  sacPulse: number;
  /** Tail sway amplitude. */
  tailSway: number;
  /** Head tracking amplitude toward its motion. */
  headTrack: number;
  /** Hover height above the ground for FLOATING bodies. */
  hover: number;
}

// ------------------------------------------------------------ attacks + telegraphs (plan §22/§23)

export type TelegraphShape = 'circle' | 'disc' | 'line' | 'cone' | 'ring';

/** A readable warning derived from the ATTACK TYPE (plan §23) — never hand-authored per enemy. */
export interface TelegraphSpec {
  shape: TelegraphShape;
  /** Seconds of warning before the hit lands. */
  lead: number;
  /** Radius (m) for circle/disc/ring, or half-width for line/cone. */
  radius: number;
  /** Length (m) for line/cone telegraphs. */
  length: number;
  /** Colour on the ground. */
  color: number;
}

export type AttackMovement = 'none' | 'leap' | 'charge' | 'burrow' | 'blink' | 'hover';

/** One generated attack (plan §22): the sim executes `ability`; the rest dresses it. */
export interface ProcAttack {
  id: string;
  name: string;
  ability: AbilityId;
  telegraph: TelegraphSpec;
  windup: number;
  recover: number;
  range: number;
  damageMul: number;
  cd: number;
  movement: AttackMovement;
  /** Sequence weight — higher-rolls come later in a boss rotation. */
  weight: number;
}

// ------------------------------------------------------------ ecology (plan §26/§27)

export type EcologyKind = 'AMBUSH_PACK' | 'BURROW_COLONY' | 'TOXIC_SWARM' | 'FERAL_HERD' | 'CRYSTAL_GRAZERS' | 'VOID_STALKERS';

export type EcoRole =
  | 'SCAVENGER' // small, skittish fodder
  | 'SWARMER'   // small, packs
  | 'SCOUT'     // fast, ranged poke
  | 'HUNTER'    // the two Hunter Necrophages
  | 'AMBUSHER'  // burst from cover
  | 'SPITTER'   // ranged standoff
  | 'BULWARK'   // defensive anchor
  | 'GUARDIAN'  // protects kin / the boss
  | 'APEX'      // miniboss
  | 'BOSS'      // Beacon Guardian
  | 'OVERSEER'; // Nexus Overseer

/** Food-chain link (plan §27). */
export interface ProcRelationship {
  targetIdx: number;
  kind: 'PREY_OF' | 'PROTECTS' | 'PACKS_WITH';
}

// ------------------------------------------------------------ planet facts (plan §6/§29/§32)

export interface PlanetFacts {
  ring: number;
  biome: BiomeClass;
  ecology: EcologyKind;
  corruption: number;
  temperature: number;
  difficulty: number;
  /** Display name for the boss, from the galactic map's archetype list. */
  bossName?: string;
  /** Landmark biases on the planet (plan §14) — nudges kits toward venom/ambush/ranged… */
  landmarkBiases: string[];
}
