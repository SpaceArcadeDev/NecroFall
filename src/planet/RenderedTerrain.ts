/**
 * NECROFALL — sampler for the RENDERED terrain surface.
 *
 * `PlanetTerrain` builds a lat-long grid (RES_X × RES_Y cells) and the GPU
 * linearly interpolates between those vertices — the analytic `radiusAt` used
 * for placement is NOT what the player sees between grid lines. Small dips
 * (where the water basins live) can be several centimetres to metres shallower
 * in the rendered mesh than analytically.
 *
 * This module reproduces the mesh's EXACT triangle interpolation on the CPU so
 * environment systems (water fill level, shoreline conformance) can agree with
 * the surface that is actually on screen.
 */
import * as THREE from 'three/webgpu';
import type { PlanetGenerator } from './PlanetGenerator';

export const TERRAIN_RES_X = 320;
export const TERRAIN_RES_Y = 160;

export function createTerrainIndices(width: number, height: number): Uint16Array | Uint32Array {
  const IndexArray = width * (height + 1) > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(width * height * 6);
  let cursor = 0;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const next = (column + 1) % width;
      const upperLeft = row * width + column;
      const lowerLeft = (row + 1) * width + column;
      const upperRight = row * width + next;
      const lowerRight = (row + 1) * width + next;
      indices[cursor++] = upperLeft;
      indices[cursor++] = upperRight;
      indices[cursor++] = lowerLeft;
      indices[cursor++] = lowerLeft;
      indices[cursor++] = upperRight;
      indices[cursor++] = lowerRight;
    }
  }
  return indices;
}

export type RenderedRadiusAt = (direction: THREE.Vector3) => number;
const samplerCache = new WeakMap<PlanetGenerator, RenderedRadiusAt>();

/**
 * Builds a cached radius grid identical to `PlanetTerrain`'s vertex heights and
 * returns a ray/triangle-exact sampler. The grid fills lazily on first
 * call — same cost as one terrain build pass, so it must be called at load time.
 */
export function createRenderedRadiusAt(generator: PlanetGenerator): RenderedRadiusAt {
  const cached = samplerCache.get(generator);
  if (cached) return cached;
  let positions: Float32Array | null = null;
  const ray = new THREE.Ray();
  const first = new THREE.Vector3(), second = new THREE.Vector3(), third = new THREE.Vector3(), hit = new THREE.Vector3();

  const ensureGrid = (): Float32Array => {
    if (positions) return positions;
    const grid = new Float32Array((TERRAIN_RES_Y + 1) * TERRAIN_RES_X * 3);
    for (let iy = 0; iy <= TERRAIN_RES_Y; iy++) {
      const v = iy / TERRAIN_RES_Y;
      const y = Math.cos(v * Math.PI);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      for (let ix = 0; ix < TERRAIN_RES_X; ix++) {
        const lon = (ix / TERRAIN_RES_X - 0.5) * Math.PI * 2;
        const directionX = r * Math.cos(lon), directionZ = r * Math.sin(lon);
        const radius = generator.radiusAt(directionX, y, directionZ);
        const offset = (iy * TERRAIN_RES_X + ix) * 3;
        grid[offset] = directionX * radius; grid[offset + 1] = y * radius; grid[offset + 2] = directionZ * radius;
      }
    }
    positions = grid;
    return grid;
  };

  const sample: RenderedRadiusAt = (direction: THREE.Vector3): number => {
    const grid = ensureGrid();
    ray.direction.copy(direction).normalize();
    const y = Math.min(1, Math.max(-1, ray.direction.y));
    let u = Math.atan2(ray.direction.z, ray.direction.x) / (Math.PI * 2) + 0.5;
    if (u >= 1) u -= 1;
    else if (u < 0) u += 1;
    const v = Math.acos(y) / Math.PI;

    const gx = u * TERRAIN_RES_X;
    const gy = v * TERRAIN_RES_Y;
    let ix = Math.floor(gx);
    let iy = Math.floor(gy);
    if (ix > TERRAIN_RES_X - 1) ix = TERRAIN_RES_X - 1;
    if (ix < 0) ix = 0;
    if (iy > TERRAIN_RES_Y - 1) iy = TERRAIN_RES_Y - 1;
    if (iy < 0) iy = 0;

    for (const [offsetX, offsetY] of [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const row = iy + offsetY;
      if (row < 0 || row >= TERRAIN_RES_Y) continue;
      const column = (ix + offsetX + TERRAIN_RES_X) % TERRAIN_RES_X, next = (column + 1) % TERRAIN_RES_X;
      const upperLeft = (row * TERRAIN_RES_X + column) * 3, upperRight = (row * TERRAIN_RES_X + next) * 3;
      const lowerLeft = ((row + 1) * TERRAIN_RES_X + column) * 3, lowerRight = ((row + 1) * TERRAIN_RES_X + next) * 3;
      first.fromArray(grid, upperLeft); second.fromArray(grid, upperRight); third.fromArray(grid, lowerLeft);
      if (ray.intersectTriangle(first, second, third, false, hit)) return hit.length();
      first.fromArray(grid, lowerLeft); third.fromArray(grid, lowerRight);
      if (ray.intersectTriangle(first, second, third, false, hit)) return hit.length();
    }
    return generator.radiusAt(ray.direction.x, ray.direction.y, ray.direction.z);
  };
  samplerCache.set(generator, sample);
  return sample;
}
