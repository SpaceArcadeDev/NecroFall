// NECROFALL — the ONE terrain surface every system agrees on (plan §5).
//
// Player movement, enemy following, vegetation placement, physics placement, water queries and
// effects all sample through this interface, so the render, the simulation and the collision can
// never disagree about where the ground is. It is a thin adapter over Planet's analytic field;
// it adds nothing of its own.
import * as THREE from 'three';

export interface TerrainSurface {
  /** Planet radius the height field is relative to. */
  readonly radius: number;
  /** Water surface elevation (radius-space). Ground below it is submerged. */
  readonly waterLevel: number;

  /** Terrain radius (distance from planet centre) along a unit direction. */
  heightAtDir(x: number, y: number, z: number): number;
  /** Terrain (not radial) normal at a unit direction. */
  normalAtDir(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3;
  /** Rise/run slope at a unit direction (0 = flat). */
  slopeAtDir(x: number, y: number, z: number): number;
  /** Vegetation density multiplier 0..~1.6 at a unit direction (biome field). */
  vegetationAtDir(x: number, y: number, z: number): number;
  /** Water depth (≥ 0, metres) at a unit direction; 0 = dry land. */
  waterAtDir(x: number, y: number, z: number): number;
}

/** The minimal Planet shape the adapter needs — avoids a circular import. */
export interface TerrainSurfaceSource {
  readonly radius: number;
  readonly waterLevel: number;
  heightAtDir(x: number, y: number, z: number): number;
  terrainNormalAt(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  slopeAt(p: THREE.Vector3): number;
  biome: { plantDensityAt(x: number, y: number, z: number): number };
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Adapts Planet's analytic field to the shared `TerrainSurface` contract. */
export function createTerrainSurface(planet: TerrainSurfaceSource): TerrainSurface {
  return {
    get radius() {
      return planet.radius;
    },
    get waterLevel() {
      return planet.waterLevel;
    },
    heightAtDir: (x, y, z) => planet.heightAtDir(x, y, z),
    normalAtDir: (x, y, z, out) => {
      _p.set(x, y, z);
      return planet.terrainNormalAt(_p, out);
    },
    slopeAtDir: (x, y, z) => {
      _p.set(x, y, z).multiplyScalar(planet.radius);
      return planet.slopeAt(_p);
    },
    vegetationAtDir: (x, y, z) => planet.biome.plantDensityAt(x, y, z),
    waterAtDir: (x, y, z) => {
      const h = planet.heightAtDir(x, y, z);
      return Math.max(0, planet.waterLevel - h);
    },
  };
}

/** Scratch helpers for callers that only want a direction + its surface data. */
export interface SurfaceSample {
  height: number;
  slope: number;
  vegetation: number;
  water: number;
}

export function sampleSurface(surface: TerrainSurface, dir: THREE.Vector3, out: SurfaceSample, normal?: THREE.Vector3): SurfaceSample {
  out.height = surface.heightAtDir(dir.x, dir.y, dir.z);
  out.slope = surface.slopeAtDir(dir.x, dir.y, dir.z);
  out.vegetation = surface.vegetationAtDir(dir.x, dir.y, dir.z);
  out.water = Math.max(0, surface.waterLevel - out.height);
  if (normal) surface.normalAtDir(dir.x, dir.y, dir.z, normal);
  return out;
}

export { _n as _surfaceNormalScratch };
