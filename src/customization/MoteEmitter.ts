// NECROFALL — a tiny self-contained particle emitter for accessory effects (wing embers, wing
// motes, spirit wisps, jet exhaust). It lives INSIDE the accessory's own group, so it follows the
// player for free — no world-space bookkeeping, no shared pool to starve (the game's Effects pool
// is for combat and must not be drained by cosmetics).
//
// One THREE.Points object per emitter with a fixed pool (32-ish) and per-particle `aLife`; the
// material is additive and discards on alpha, so a dead particle costs one vertex shade and
// nothing else.
import * as THREE from 'three';

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

const VERT = `
  uniform float uSize;
  attribute float aLife;
  attribute float aSeed;
  varying float vLife;
  void main() {
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * (0.5 + aSeed) * (300.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vLife;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float a = smoothstep(0.5, 0.05, d) * clamp(vLife, 0.0, 1.0) * uOpacity;
    a *= smoothstep(0.0, 0.14, 1.0 - vLife);          // quick fade-in, no pop
    if (a < 0.012) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

const _spawn = new THREE.Vector3();
const _vel = new THREE.Vector3();

export class MoteEmitter {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private aLife: THREE.BufferAttribute;
  private count: number;
  private maxLife: number;
  private head = 0;
  private spawnAcc = 0;
  private opts: MoteOptions;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;

  constructor(opts: MoteOptions) {
    this.opts = opts;
    this.count = Math.max(1, opts.count);
    this.maxLife = opts.life;
    this.pos = new Float32Array(this.count * 3);
    this.vel = new Float32Array(this.count * 3);
    this.life = new Float32Array(this.count);
    const seeds = new Float32Array(this.count);
    this.aLife = new THREE.BufferAttribute(new Float32Array(this.count), 1);
    this.aLife.setUsage(THREE.DynamicDrawUsage);
    const aSeed = new THREE.BufferAttribute(seeds, 1);
    for (let i = 0; i < this.count; i++) seeds[i] = 0.55 + Math.random() * 0.9;

    this.geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(this.pos, 3);
    position.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', position);
    this.geometry.setAttribute('aLife', this.aLife);
    this.geometry.setAttribute('aSeed', aSeed);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(opts.color) },
        uSize: { value: opts.size ?? 0.07 },
        uOpacity: { value: opts.opacity ?? 0.9 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;   // particles move; the baked bounds would lie
    this.points.renderOrder = 8;
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
    this.material.uniforms.uOpacity.value = op;
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
    for (let i = 0; i < this.count; i++) {
      this.aLife.array[i] = Math.max(0, this.life[i]) / this.maxLife;
    }
    this.aLife.needsUpdate = true;
    if (any || rate) {
      (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
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
