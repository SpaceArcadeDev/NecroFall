// NECROFALL — accessory types shared by the catalog, the models and the fitting code.
import * as THREE from 'three';

export type AccessoryCategory = 'hat' | 'backpack' | 'pet' | 'recall' | 'spawn' | 'eliminated';

/**
 * ONE-SHOT EFFECT categories (user ask): the customize menu offers a 4th/5th/6th shelf of
 * cosmetics that are not WORN but TRIGGERED — while channeling a recall, the moment a body
 * spawns (match start and every respawn), and the moment it is eliminated. Their models are
 * authored exactly like accessories (origin on the ground, +Y up, face +Z) but they live for
 * `duration` seconds and are disposed; the runner ticks them with elapsed time from 0.
 */
export type EffectCategory = 'recall' | 'spawn' | 'eliminated';

export const EFFECT_CATEGORIES: EffectCategory[] = ['recall', 'spawn', 'eliminated'];

export function isEffectCategory(cat: AccessoryCategory): cat is EffectCategory {
  return cat === 'recall' || cat === 'spawn' || cat === 'eliminated';
}

/** A built accessory: its root group plus an optional per-frame animation. */
export interface AccessoryBuild {
  group: THREE.Group;
  /** Called every frame while the accessory is equipped. `t` = seconds, `dt` = frame time. */
  tick?: (t: number, dt: number) => void;
  /** Optional extra teardown (emitters, custom buffers) — geometries are disposed automatically. */
  dispose?: () => void;
}

/** How a pet moves around its owner. Every pet is a follower with no other function. */
export interface PetMotion {
  /** Height above the surface it prefers (ground pets skim, flyers hover). */
  hover: number;
  /** Cruise speed (u/s). */
  speed: number;
  /** How hard it steers toward its wander target (u/s²). */
  accel: number;
  /** How far from the owner it likes to roam (min/max, surface metres). */
  roamMin: number;
  roamMax: number;
  /** How long it lingers on a target before picking a new one (seconds, min/max). */
  lingerMin: number;
  lingerMax: number;
  /** Extra vertical bounce (u) and its rate (rad/s). */
  bob: number;
  bobRate: number;
  /** Body spin while idle (rad/s) — 0 for most. */
  spin?: number;
  /** True for pets that hop instead of gliding (bob is applied as a hard arc). */
  hop?: boolean;
}

export interface AccessoryDef {
  /** Stable id — this is what the browser stores (indices can be reordered, ids cannot). */
  id: string;
  name: string;
  desc: string;
  build: () => AccessoryBuild;
  /** Pets only: how the little thing moves. */
  motion?: PetMotion;
  /** Build-time scale of the whole model (big wings want more than a lantern). Default 1. */
  scale?: number;
  /**
   * EFFECT categories only: how long one playback lives (seconds). The runner ticks the build
   * with elapsed time from 0 and disposes it at `duration`; the customize stage replays it.
   * Accessories omit it — they live as long as they are worn.
   */
  duration?: number;
}

/**
 * What the player is wearing / has equipped. Indices into the HATS / BACKPACKS / PETS catalogs
 * (plus the RECALL / SPAWN / ELIMINATED effect catalogs), -1 = nothing.
 */
export interface AccessorySelection {
  hat: number;
  backpack: number;
  pet: number;
  /** Effect played while channeling a recall (and at both ends when it lands). */
  recall: number;
  /** Effect played at match start and on every respawn. */
  spawn: number;
  /** Effect played where this player is killed. */
  eliminated: number;
}

export const EMPTY_SELECTION: AccessorySelection = {
  hat: -1, backpack: -1, pet: -1, recall: -1, spawn: -1, eliminated: -1,
};

export function sameSelection(a: AccessorySelection, b: AccessorySelection): boolean {
  return a.hat === b.hat && a.backpack === b.backpack && a.pet === b.pet
    && a.recall === b.recall && a.spawn === b.spawn && a.eliminated === b.eliminated;
}
