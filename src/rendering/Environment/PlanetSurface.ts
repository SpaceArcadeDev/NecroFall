// NECROFALL — PlanetSurface (plan §11, §12): the ONE terrain query API of the environment.
//
//   PlanetSurface.sample(direction)          ← CPU (this module)
//   planetTerrainNode(worldPosition)         ← GPU (Environment/PlanetTerrainNodes.ts)
//
// Both read the SAME deterministic planet generation (delegated to `TerrainSurface`, which
// adapts the simulation's analytic field) — no environment system may calculate its own terrain.
// Sampling the RENDERED mesh height (visualHeightAtDir) is deliberate: placement must sit on the
// triangles the player actually sees, not on the analytic field a fraction of a metre away.
//
// The pool object means hot loops never allocate (plan §107): call `sample(dir, out)`.
import * as THREE from 'three/webgpu';
import type { TerrainSurface } from '../../world/TerrainSurface';

export interface SurfaceSample {
  /** World-space point on the rendered surface. */
  point: THREE.Vector3;
  /** Terrain normal (not radial) at the point. */
  normal: THREE.Vector3;
  /** Height offset RELATIVE to the planet radius (metres). */
  height: number;
  /** Rise/run slope, 0 = flat. */
  slope: number;
  /** Vegetation density band 0..~1.6. */
  grass: number;
  /** Water depth at the spot (≥ 0, metres; 0 = dry). */
  wetness: number;
  /** Biome class id (0 when the planet does not classify). */
  biome: number;
}

export interface PlanetSurfaceSources {
  surface: TerrainSurface;
  /** Planet centre (defaults to the world origin — NecroFall's planets are centred there). */
  center?: THREE.Vector3;
  /** Biome class lookup (returns a number; omit for 0). */
  biomeAt?: (x: number, y: number, z: number) => number;
  /** Corruption channel for tools that want it (not part of the sample contract). */
  corruptionAt?: (x: number, y: number, z: number) => number;
  moistureAt?: (x: number, y: number, z: number) => number;
}

export class PlanetSurface {
  readonly center: THREE.Vector3;
  private readonly pool: SurfaceSample = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    height: 0,
    slope: 0,
    grass: 0,
    wetness: 0,
    biome: 0,
  };

  constructor(private readonly sources: PlanetSurfaceSources) {
    this.center = sources.center ?? new THREE.Vector3();
  }

  /** The planet radius the height field is relative to (metres). */
  get radius(): number {
    return this.sources.surface.radius;
  }

  /** The surface elevation (radius-space) of standing water. */
  get waterLevel(): number {
    return this.sources.surface.waterLevel;
  }

  /**
   * Sample the terrain along a (not necessarily unit) direction. Pass `out` in hot loops; the
   * returned object is otherwise the internal pool — copy what you keep.
   */
  sample(direction: THREE.Vector3, out: SurfaceSample = this.pool): SurfaceSample {
    const dir = _dir.copy(direction).normalize();
    const surface = this.sources.surface;

    const radius = surface.visualHeightAtDir(dir.x, dir.y, dir.z);
    out.point.copy(dir).multiplyScalar(radius).add(this.center);
    out.height = radius - surface.radius;
    surface.normalAtDir(dir.x, dir.y, dir.z, out.normal);
    out.slope = surface.slopeAtDir(dir.x, dir.y, dir.z);
    out.grass = surface.vegetationAtDir(dir.x, dir.y, dir.z);
    out.wetness = Math.max(0, surface.waterLevel - radius);
    out.biome = this.sources.biomeAt?.(dir.x, dir.y, dir.z) ?? 0;
    return out;
  }
}

const _dir = new THREE.Vector3();

/** Scratch sample for callers that only need one-off reads. Never keep references to it. */
export const SURFACE_SAMPLE_SCRATCH: SurfaceSample = {
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  height: 0,
  slope: 0,
  grass: 0,
  wetness: 0,
  biome: 0,
};
