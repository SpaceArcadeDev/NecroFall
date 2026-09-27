// NECROFALL — math / noise / orbital helpers.
import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
/**
 * Monotonic wall clock in seconds, shared by everything that talks about time over the network.
 * Unlike the game clock it keeps its rate through frame hitches and never stops with the
 * simulation, so it is the only timeline two peers can be aligned on.
 */
export function nowSec(): number {
  return performance.now() / 1000;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function damp(a: number, b: number, rate: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-rate * dt));
}
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
export function randRange(a: number, b: number): number {
  return a + Math.random() * (b - a);
}
export function randInt(a: number, b: number): number {
  return a + Math.floor(Math.random() * (b - a + 1));
}
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic seeded RNG (mulberry32). */
export class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + this.next() * (b - a);
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ---------------------------------------------------------------- noise

function hashInt(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1442695041) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const c000 = hashInt(xi, yi, zi, seed);
  const c100 = hashInt(xi + 1, yi, zi, seed);
  const c010 = hashInt(xi, yi + 1, zi, seed);
  const c110 = hashInt(xi + 1, yi + 1, zi, seed);
  const c001 = hashInt(xi, yi, zi + 1, seed);
  const c101 = hashInt(xi + 1, yi, zi + 1, seed);
  const c011 = hashInt(xi, yi + 1, zi + 1, seed);
  const c111 = hashInt(xi + 1, yi + 1, zi + 1, seed);
  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

export function fbm(x: number, y: number, z: number, oct: number, seed: number): number {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq, seed + i * 131);
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

// ---------------------------------------------------------------- vectors

export function randomUnitVector(out: THREE.Vector3): THREE.Vector3 {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * TAU;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(r * Math.cos(a), z, r * Math.sin(a));
}

/** Builds an orthonormal tangent basis on the plane perpendicular to `up`. */
export function tangentBasis(up: THREE.Vector3, t1: THREE.Vector3, t2: THREE.Vector3): void {
  if (Math.abs(up.y) < 0.92) t1.set(0, 1, 0);
  else t1.set(1, 0, 0);
  t1.crossVectors(up, t1).normalize();
  t2.crossVectors(up, t1).normalize();
}

export function dirFromAngles(latDeg: number, lonDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const la = latDeg * DEG, lo = lonDeg * DEG;
  const cl = Math.cos(la);
  return out.set(cl * Math.cos(lo), Math.sin(la), cl * Math.sin(lo));
}

export function signedAngleAround(from: THREE.Vector3, to: THREE.Vector3, axis: THREE.Vector3): number {
  const c = clamp(from.dot(to), -1, 1);
  const s = new THREE.Vector3().crossVectors(from, to).dot(axis);
  return Math.atan2(s, c);
}

const _rv = new THREE.Vector3();
const _fv = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

/**
 * Positions an object on the sphere and orients it so local +Y = up (surface normal)
 * and local +Z = forward (tangent).
 */
export function orientToSurface(
  obj: THREE.Object3D,
  pos: THREE.Vector3,
  up: THREE.Vector3,
  forward: THREE.Vector3
): void {
  _rv.crossVectors(up, forward);
  if (_rv.lengthSq() < 1e-8) {
    tangentBasis(up, _rv, _fv);
  }
  _rv.normalize();
  _fv.crossVectors(_rv, up).normalize();
  _m4.makeBasis(_rv, up, _fv);
  obj.quaternion.setFromRotationMatrix(_m4);
  obj.position.copy(pos);
}

/** Rotate `dir` (a tangent vector) toward `target` (tangent) around `up`, capped by maxStep radians. */
export function rotateTowards(
  dir: THREE.Vector3,
  target: THREE.Vector3,
  up: THREE.Vector3,
  maxStep: number
): void {
  const a = signedAngleAround(dir, target, up);
  const step = clamp(a, -maxStep, maxStep);
  dir.applyAxisAngle(up, step);
  dir.addScaledVector(up, -dir.dot(up)).normalize();
}
