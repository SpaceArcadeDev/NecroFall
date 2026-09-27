// NECROFALL — accessory types shared by the catalog, the models and the fitting code.
import * as THREE from 'three';

export type AccessoryCategory = 'hat' | 'backpack' | 'pet';

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
}

/** What the player is wearing. Indices into HATS / BACKPACKS / PETS, -1 = nothing. */
export interface AccessorySelection {
  hat: number;
  backpack: number;
  pet: number;
}

export const EMPTY_SELECTION: AccessorySelection = { hat: -1, backpack: -1, pet: -1 };

export function sameSelection(a: AccessorySelection, b: AccessorySelection): boolean {
  return a.hat === b.hat && a.backpack === b.backpack && a.pet === b.pet;
}
