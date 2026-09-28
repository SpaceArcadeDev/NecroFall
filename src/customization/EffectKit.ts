// NECROFALL — shared kit for the ONE-SHOT cosmetic effects (RecallEffects / SpawnEffects /
// EliminateEffects). Same rules as AccessoryKit: primitives + additive light, and every builder
// owns its buffers (an effect is disposed after `duration` seconds, and a shared geometry would be
// freed out from under whoever still plays).
//
// AUTHORING CONTRACT — read before adding an effect:
//  - `build()` authors the effect at the ORIGIN, standing ON the ground plane (+Y up, face +Z).
//    The game runner places and orients the whole group at the trigger point.
//  - `tick(t, dt)` is driven with ELAPSED time from 0 and must animate PURELY from `t` (no hidden
//    state): the item chips in the customize list tick the same build to ~1.17 s and render one
//    frame of it, so every effect must look strong at t ≈ 1.17 s (the "hero moment") and be fully
//    faded out by `duration` (~2.4 s) so disposal never pops.
//  - Keep the pool small: a few meshes + a couple of dozen particles. Several effects can play at
//    once (a team fight can drop three players in a second).
import * as THREE from 'three';
import { AccessoryBuild } from './AccessoryTypes';

export const TAU = Math.PI * 2;

/** Normalised window: 0 before `a`, 1 after `b` (clamped). The only timing helper effects need. */
export function win(t: number, a: number, b: number): number {
  return Math.max(0, Math.min(1, (t - a) / Math.max(1e-4, b - a)));
}

/** Ease-out cubic (fast start, soft landing). */
export function out3(x: number): number {
  const u = 1 - Math.max(0, Math.min(1, x));
  return 1 - u * u * u;
}

/** Ease-in cubic (slow start, hard finish) — implosions, gathers. */
export function in3(x: number): number {
  const u = Math.max(0, Math.min(1, x));
  return u * u * u;
}

/** Ease-out with a small overshoot — pops, bounces, crowns. */
export function outBack(x: number): number {
  const u = Math.max(0, Math.min(1, x)) - 1;
  return 1 + 2.2 * u * u * u + 1.2 * u * u;
}

/** 0 → 1 → 0 across a 0..1 input (a single breath). */
export function pulse(x: number): number {
  return Math.sin(Math.max(0, Math.min(1, x)) * Math.PI);
}

/** Fade in across `inA..inB`, hold, fade out across `outA..outB` — the standard alpha curve. */
export function fade(t: number, inA: number, inB: number, outA: number, outB: number): number {
  return win(t, inA, inB) * (1 - win(t, outA, outB));
}

/** Shared additive material for the effect meshes. */
function fxMat(color: number, opacity: number, side: THREE.Side = THREE.FrontSide): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, side,
  });
}

/** The material of an fx mesh — or of a kit SET (`matOf(dots.mat)` / `matOf(ring)`) — typed for
 * animation: `matOf(ring).opacity = ...`. */
export function matOf(o: THREE.Object3D | THREE.Material): THREE.MeshBasicMaterial {
  return ((o as THREE.Mesh).material ?? o) as THREE.MeshBasicMaterial;
}

/** A flat ring lying on the ground plane (radius measured to the tube's centre). */
export function fxRing(radius: number, tube: number, color: number, opacity = 0.9, seg = 40): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 6, seg), fxMat(color, opacity));
  m.rotation.x = -Math.PI / 2;
  return m;
}

/** A filled disc lying on the ground plane — the light pool under a motif. */
export function fxDisc(radius: number, color: number, opacity = 0.4, seg = 36): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, seg), fxMat(color, opacity, THREE.DoubleSide));
  m.rotation.x = -Math.PI / 2;
  return m;
}

/** An open cylinder standing ON its base (a light column). Scale it to grow/shrink. */
export function fxCol(radius: number, height: number, color: number, opacity = 0.35, seg = 20): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(radius, radius, height, seg, 1, true);
  geo.translate(0, height / 2, 0);
  return new THREE.Mesh(geo, fxMat(color, opacity, THREE.DoubleSide));
}

/** An open cone standing on its base — light cones, rays, flame cores. */
export function fxCone(radius: number, height: number, color: number, opacity = 0.5, seg = 16): THREE.Mesh {
  const geo = new THREE.ConeGeometry(radius, height, seg, 1, true);
  geo.translate(0, height / 2, 0);
  return new THREE.Mesh(geo, fxMat(color, opacity, THREE.DoubleSide));
}

/** A hemisphere sitting ON the ground plane — barriers, splash domes, shells. */
export function fxDome(radius: number, color: number, opacity = 0.4, seg = 18): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, seg, 8, 0, TAU, 0, Math.PI / 2);
  return new THREE.Mesh(geo, fxMat(color, opacity, THREE.DoubleSide));
}

/** A vertical pane (billboard-ish glow flash). Faces +Z by default; rotate as needed. */
export function fxPane(w: number, h: number, color: number, opacity = 0.5): THREE.Mesh {
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), fxMat(color, opacity, THREE.DoubleSide));
}

/** A thin emissive rod — spokes, bolts, tendrils, blades. Pivot at the centre. */
export function fxRod(w: number, h: number, d: number, color: number, opacity = 0.8): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), fxMat(color, opacity));
}

/** A faceted crystal (octahedron) — stars, gems, shards that want volume. */
export function fxGem(radius: number, color: number, opacity = 0.9): THREE.Mesh {
  return new THREE.Mesh(new THREE.OctahedronGeometry(radius, 0), fxMat(color, opacity, THREE.DoubleSide));
}

export interface Dot {
  mesh: THREE.Mesh;
  /** Base angle around Y. */
  a0: number;
  /** Radius fraction (multiply by the effect's max radius). */
  rf: number;
  /** Height fraction. */
  hf: number;
  /** Angular speed factor. */
  sp: number;
}

export interface DotSet {
  group: THREE.Group;
  dots: Dot[];
  mat: THREE.MeshBasicMaterial;
}

/**
 * `count` little glowing dots with per-dot random seeds (angle / radius / height / speed). One
 * shared geometry and material within THIS builder; the effect's tick places them (`positions are
 * never animated for you — every motif moves differently`).
 */
export function fxDots(count: number, color: number, size = 0.05, opacity = 0.95): DotSet {
  const group = new THREE.Group();
  const mat = fxMat(color, opacity, THREE.DoubleSide);
  const geo = new THREE.SphereGeometry(size, 6, 4);
  const dots: Dot[] = [];
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
    dots.push({
      mesh,
      a0: Math.random() * TAU,
      rf: 0.55 + Math.random() * 0.45,
      hf: Math.random(),
      sp: 0.6 + Math.random() * 0.9,
    });
  }
  return { group, dots, mat };
}

export interface Shard {
  mesh: THREE.Mesh;
  /** Random unit direction to fly along. */
  dir: THREE.Vector3;
  /** Tumble rates. */
  spin: THREE.Vector3;
  a0: number;
  rf: number;
  /** Random height fraction (which "lane" of the effect the shard favours). */
  hf: number;
}

export interface ShardSet {
  group: THREE.Group;
  shards: Shard[];
  mat: THREE.MeshBasicMaterial;
}

/** `count` elongated faceted shards — bursts, shatters, debris. One shared geometry/material. */
export function fxShards(count: number, color: number, size = 0.16, opacity = 0.9): ShardSet {
  const group = new THREE.Group();
  const mat = fxMat(color, opacity, THREE.DoubleSide);
  const geo = new THREE.OctahedronGeometry(size, 0);
  geo.scale(0.55, 1.6, 0.55);
  const shards: Shard[] = [];
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(geo, mat);
    const dir = new THREE.Vector3(
      Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5
    ).normalize();
    shards.push({
      mesh,
      dir,
      spin: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4),
      hf: Math.random(),
      a0: Math.random() * TAU,
      rf: 0.5 + Math.random() * 0.5,
    });
    group.add(mesh);
  }
  return { group, shards, mat };
}

/**
 * A tiny builder wrapper: collect the pieces, register per-frame animation, and return the
 * `AccessoryBuild` the catalog wants. Keeps each effect down to its actual visual idea.
 */
export class Composer {
  readonly group = new THREE.Group();
  private ticks: ((t: number, dt: number) => void)[] = [];
  private kills: (() => void)[] = [];

  add(...objs: THREE.Object3D[]): this {
    for (const o of objs) this.group.add(o);
    return this;
  }

  tick(fn: (t: number, dt: number) => void): this {
    this.ticks.push(fn);
    return this;
  }

  onDispose(fn: () => void): this {
    this.kills.push(fn);
    return this;
  }

  build(): AccessoryBuild {
    return {
      group: this.group,
      tick: (t, dt) => {
        for (const fn of this.ticks) fn(t, dt);
      },
      dispose: () => {
        for (const fn of this.kills) fn();
      },
    };
  }
}
