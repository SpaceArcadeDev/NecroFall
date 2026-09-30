// NECROFALL — a tiny self-contained particle emitter for accessory effects (wing embers, wing
// motes, spirit wisps, jet exhaust). It lives INSIDE the accessory's own group, so it follows the
// player for free — no world-space bookkeeping, no shared pool to starve (the game's Effects pool
// is for combat and must not be drained by cosmetics).
//
// Rendering is `BillboardParticles` (instanced camera-facing quads): the old THREE.Points version
// cannot run on the WebGPU backend — a Points material using gl_PointCoord invalidates the whole
// frame's command buffer (observed live 2026-09-30, black menu). The public surface (`points`,
// `emitAt`, `setRate`, `setOpacity`, `update`, `dispose`) is unchanged for the ~30 call sites.
import * as THREE from 'three/webgpu';
import { BillboardParticles } from '../effects/BillboardParticles';

export interface MoteOptions {
  /** Pool size — the hard cap on live particles. Keep these small (couple of dozen). */
  count: number;
  color: THREE.ColorRepresentation;
  /** Point-size scale (already multiplied by the shared distance attenuation). */
  size?: number;
  /** Particle lifetime in seconds. */
  life: number;
  /** Continuous emission rate (particles/s). 0 = only manual `emitAt` calls. */
  rate?: number;
  /** Where a continuous spawn happens (local space of the emitter's parent). */
  spawn?: (out: THREE.Vector3) => THREE.Vector3;
  /** Initial velocity for each spawned particle (local space). */
  velocity?: (out: THREE.Vector3) => THREE.Vector3;
  /** Velocity damping per second (0..~4). */
  drag?: number;
  /** Local +Y acceleration of a particle (negative = falls). */
  gravity?: number;
  opacity?: number;
}

const _spawn = new THREE.Vector3();
const _vel = new THREE.Vector3();

/**
 * gl_PointSize = uSize * (0.5 + seed) * (300 / distance) was pixels at the 1080p/60° reference,
 * and pixels→world at that distance cancels the attenuation, leaving this constant factor.
 */
const POINT_PX_TO_WORLD = (2 * Math.tan((60 * Math.PI) / 180 / 2)) / 1080;

export class MoteEmitter {
  /** The renderable — add it to the accessory group exactly like the old Points object. */
  readonly points: THREE.InstancedMesh;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private count: number;
  private maxLife: number;
  private head = 0;
  private spawnAcc = 0;
  private opts: MoteOptions;
  private bb: BillboardParticles;

  constructor(opts: MoteOptions) {
    this.opts = opts;
    this.count = Math.max(1, opts.count);
    this.maxLife = opts.life;
    this.pos = new Float32Array(this.count * 3);
    this.vel = new Float32Array(this.count * 3);
    this.life = new Float32Array(this.count);

    this.bb = new BillboardParticles({
      capacity: this.count,
      shape: 'soft',
      fadeIn: 0.14, // quick fade-in, no pop (was `vLife.oneMinus().smoothstep(0, 0.14)`)
      blending: THREE.AdditiveBlending,
      renderOrder: 8,
      arrays: { center: this.pos, alpha: new Float32Array(this.count) },
    });
    this.bb.setOpacity(opts.opacity ?? 0.9);
    this.bb.setCount(this.count);

    // Per-particle constant data: size converted from the old point-sprite pixels, tinted colour.
    const sizes = this.bb.aSize.array as Float32Array;
    const colors = this.bb.aColor.array as Float32Array;
    const color = new THREE.Color(opts.color);
    const worldSize = (opts.size ?? 0.07) * POINT_PX_TO_WORLD;
    for (let i = 0; i < this.count; i++) {
      sizes[i] = worldSize * (0.5 + 0.55 + Math.random() * 0.9);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    this.bb.aSize.needsUpdate = true;
    this.bb.aColor.needsUpdate = true;

    this.points = this.bb.mesh;
    this.points.frustumCulled = false; // particles move; the baked bounds would lie
  }

  /** Spawn one particle at a local-space point. */
  emitAt(x: number, y: number, z: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.count;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    const v = this.opts.velocity ? this.opts.velocity(_vel) : _vel.set(0, 0, 0);
    this.vel[i * 3] = v.x;
    this.vel[i * 3 + 1] = v.y;
    this.vel[i * 3 + 2] = v.z;
    this.life[i] = this.maxLife;
  }

  /** Continuous rate can be driven per frame (jetpack flames ramp with speed). */
  setRate(rate: number): void {
    this.opts.rate = rate;
  }

  setOpacity(op: number): void {
    this.bb.setOpacity(op);
  }

  update(dt: number): void {
    const { rate, spawn, drag = 0, gravity = 0 } = this.opts;
    if (rate && spawn) {
      this.spawnAcc += rate * dt;
      while (this.spawnAcc >= 1) {
        this.spawnAcc -= 1;
        this.emitAt(spawn(_spawn).x, _spawn.y, _spawn.z);
      }
    }
    const damp = Math.max(0, 1 - drag * dt);
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      const o = i * 3;
      this.vel[o] *= damp;
      this.vel[o + 1] = this.vel[o + 1] * damp + gravity * dt;
      this.vel[o + 2] *= damp;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
    }
    // Lifetime → alpha (the old `aLife` buffer), written straight into the instance attribute.
    const alpha = this.bb.aAlpha.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      alpha[i] = Math.max(0, this.life[i]) / this.maxLife;
    }
    this.bb.aAlpha.needsUpdate = true;
    if (any || rate) {
      this.bb.aCenter.needsUpdate = true;
    }
  }

  dispose(): void {
    this.bb.dispose();
  }
}

/** Spherical shell spawn position helper (a ring of positions around the origin). */
export function shellSpawn(radius: number, height = 0, jitter = 0): (out: THREE.Vector3) => THREE.Vector3 {
  return (out: THREE.Vector3): THREE.Vector3 => {
    const a = Math.random() * Math.PI * 2;
    const r = radius * (1 - jitter * Math.random());
    return out.set(Math.cos(a) * r, height + (Math.random() - 0.5) * 0.06, Math.sin(a) * r);
  };
}

/** Velocity helper: random direction biased by `bias`, at a random speed in [min,max]. */
export function driftVelocity(bias: THREE.Vector3, min: number, max: number): (out: THREE.Vector3) => THREE.Vector3 {
  return (out: THREE.Vector3): THREE.Vector3 => {
    const s = min + Math.random() * (max - min);
    return out
      .set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2)
      .normalize()
      .multiplyScalar(s)
      .addScaledVector(bias, s * 0.8);
  };
}
