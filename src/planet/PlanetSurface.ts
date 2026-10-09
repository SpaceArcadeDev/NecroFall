/**
 * NECROFALL — CPU planet surface API (plan §11/§13).
 *
 * THE single terrain query for gameplay-side code and placement:
 * `PlanetSurface.sample(direction)` returns point / normal / slope / grass /
 * wetness / radiation — computed from the same generator the GPU textures were
 * baked from. Grass, trees, rocks, crystals, puddles, particles and the dev
 * player all go through here (or through the shader twin `planetTerrainNode`).
 *
 * Allocation-free in steady state: pass a reusable `out` sample.
 */
import * as THREE from 'three/webgpu';
import type { PlanetGenerator } from './PlanetGenerator';
import type { PlanetSurfaceData } from './PlanetSurfaceData';
import { createRenderedRadiusAt, type RenderedRadiusAt } from './RenderedTerrain';

export interface SurfaceSample {
  point: THREE.Vector3;
  /** Unit direction from the planet centre (surface "up"). */
  up: THREE.Vector3;
  /** True surface normal (accounts for the height field). */
  normal: THREE.Vector3;
  /** Terrain radius at this direction. */
  radius: number;
  /** Metres above the base sphere radius. */
  height: number;
  /** 0 flat … 1 vertical. */
  slope: number;
  grass: number;
  wetness: number;
  radiation: number;
  rock: number;
  biomeWeight: number;
}

export function createSurfaceSample(): SurfaceSample {
  return {
    point: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
    normal: new THREE.Vector3(0, 1, 0),
    radius: 0,
    height: 0,
    slope: 0,
    grass: 0,
    wetness: 0,
    radiation: 0,
    rock: 0,
    biomeWeight: 0,
  };
}

// module-level scratch — no per-sample allocation (plan §107)
const _probe1 = new THREE.Vector3();
const _probe2 = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _edge1 = new THREE.Vector3();
const _edge2 = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();
const _alignQuat = new THREE.Quaternion();
const _yawQuat = new THREE.Quaternion();
const _worldUp = new THREE.Vector3(0, 1, 0);

const PROBE_ANGLE = 0.004; // ≈0.5 m arc on a 118 m planet

export class PlanetSurface {
  private readonly renderedRadiusAt: RenderedRadiusAt;
  readonly center = new THREE.Vector3(0, 0, 0);

  /** `?foliageDebug=1` counters (plan §33) — zero cost unless the debug overlay is armed. */
  static debugSamples = 0;
  static debugQueries = 0;
  static debugCounters = false;

  constructor(
    readonly generator: PlanetGenerator,
    readonly data: PlanetSurfaceData,
  ) { this.renderedRadiusAt = createRenderedRadiusAt(generator); }

  get radius(): number {
    return this.generator.radius;
  }

  get waterLevel(): number {
    return this.data.waterLevel;
  }

  get reliefSpan(): number {
    return this.data.reliefMax - this.data.reliefMin;
  }

  radiusAt(direction: THREE.Vector3): number {
    if (PlanetSurface.debugCounters) PlanetSurface.debugQueries++;
    return this.renderedRadiusAt(direction);
  }

  heightAt(direction: THREE.Vector3): number {
    return this.radiusAt(direction) - this.radius;
  }

  /** Stable tangent around a pole-safe reference (plan §70). */
  static stableTangent(normal: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const reference = Math.abs(normal.y) < 0.95 ? _worldUp : _probe2.set(1, 0, 0);
    return out.crossVectors(reference, normal).normalize();
  }

  sample(direction: THREE.Vector3, out: SurfaceSample = createSurfaceSample()): SurfaceSample {
    if (PlanetSurface.debugCounters) PlanetSurface.debugSamples++;
    const up = out.up.copy(direction).normalize();
    const radius = this.radiusAt(up);
    out.radius = radius;
    out.height = radius - this.radius;
    out.point.copy(up).multiplyScalar(radius);

    // ---- normal from two tangent probes
    PlanetSurface.stableTangent(up, _tangent);
    _bitangent.crossVectors(up, _tangent);
    _probe1.copy(up).addScaledVector(_tangent, PROBE_ANGLE).normalize();
    _probe2.copy(up).addScaledVector(_bitangent, PROBE_ANGLE).normalize();
    _p0.copy(up).multiplyScalar(radius);
    _p1.copy(_probe1).multiplyScalar(this.radiusAt(_probe1));
    _p2.copy(_probe2).multiplyScalar(this.radiusAt(_probe2));
    _edge1.subVectors(_p1, _p0);
    _edge2.subVectors(_p2, _p0);
    out.normal.crossVectors(_edge1, _edge2).normalize();
    if (out.normal.dot(up) < 0) out.normal.negate();

    // ---- classification from the shared estimates (same inputs as the bake)
    out.slope = 1 - Math.max(0, Math.min(1, out.normal.dot(up)));
    out.grass = this.generator.grassEstimate(up.x, up.y, up.z, out.slope);
    out.wetness = this.generator.wetnessEstimate(up.x, up.y, up.z, out.height, this.waterLevel);
    out.radiation = this.generator.radiationEstimate(up.x, up.y, up.z, out.height, this.waterLevel);
    out.rock = this.generator.rockEstimate(out.slope);
    out.biomeWeight = this.generator.biomeWeightEstimate(up.x, up.y, up.z);

    return out;
  }

  /** Equirect UV of a direction — MUST match the bake & `planetTerrainNode`. */
  uvOfDirection(direction: THREE.Vector3, out: THREE.Vector2): THREE.Vector2 {
    out.x = 0.5 + Math.atan2(direction.z, direction.x) / (Math.PI * 2);
    out.y = Math.acos(Math.min(1, Math.max(-1, direction.y))) / Math.PI;
    return out;
  }

  /** Inverse of `uvOfDirection`. */
  directionAtUv(u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
    const y = Math.cos(v * Math.PI);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const lon = (u - 0.5) * Math.PI * 2;
    return out.set(r * Math.cos(lon), y, r * Math.sin(lon));
  }

  /**
   * Terrain-contour placement (plan §13): point on the surface, local +Y to the
   * surface normal, then a yaw around that normal, then uniform scale.
   */
  alignToSurface(object: THREE.Object3D, sample: SurfaceSample, yaw: number, scale = 1, sink = 0): void {
    object.position.copy(sample.point).addScaledVector(sample.up, -sink);
    object.scale.setScalar(scale);
    _alignQuat.setFromUnitVectors(_worldUp, sample.up);
    _yawQuat.setFromAxisAngle(sample.up, yaw);
    object.quaternion.copy(_yawQuat).multiply(_alignQuat);
  }

  /** Deterministic random surface point (into `outSample`); filters by grass/slope handled by callers. */
  randomSample(random: () => number, out: SurfaceSample): SurfaceSample {
    const z = random() * 2 - 1;
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    _probe1.set(r * Math.cos(a), z, r * Math.sin(a));
    return this.sample(_probe1, out);
  }
}
