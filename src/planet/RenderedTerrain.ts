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

export type RenderedRadiusAt = (direction: THREE.Vector3) => number;

/**
 * Builds a cached radius grid identical to `PlanetTerrain`'s vertex heights and
 * returns a bilinear (triangle-exact) sampler. The grid fills lazily on first
 * call — same cost as one terrain build pass, so it must be called at load time.
 */
export function createRenderedRadiusAt(generator: PlanetGenerator): RenderedRadiusAt {
  let radii: Float32Array | null = null;

  const ensureGrid = (): Float32Array => {
    if (radii) return radii;
    const grid = new Float32Array((TERRAIN_RES_Y + 1) * TERRAIN_RES_X);
    for (let iy = 0; iy <= TERRAIN_RES_Y; iy++) {
      const v = iy / TERRAIN_RES_Y;
      const y = Math.cos(v * Math.PI);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      for (let ix = 0; ix < TERRAIN_RES_X; ix++) {
        const lon = (ix / TERRAIN_RES_X - 0.5) * Math.PI * 2;
        grid[iy * TERRAIN_RES_X + ix] = generator.radiusAt(r * Math.cos(lon), y, r * Math.sin(lon));
      }
    }
    radii = grid;
    return grid;
  };

  return (direction: THREE.Vector3): number => {
    const grid = ensureGrid();

    const y = Math.min(1, Math.max(-1, direction.y));
    let u = Math.atan2(direction.z, direction.x) / (Math.PI * 2) + 0.5;
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

    const fu = gx - ix;
    const fv = gy - iy;
    const ixNext = (ix + 1) % TERRAIN_RES_X;

    // quad corners exactly as PlanetTerrain indexes them:
    // a = (iy, ix), b = (iy + 1, ix), c = (iy, ixNext), d = (iy + 1, ixNext)
    // triangles: (a, b, c) and (b, d, c) — split along the b→c diagonal
    const rowA = iy * TERRAIN_RES_X;
    const rowB = (iy + 1) * TERRAIN_RES_X;
    const ra = grid[rowA + ix];
    const rb = grid[rowB + ix];
    const rc = grid[rowA + ixNext];
    const rd = grid[rowB + ixNext];

    if (fu + fv <= 1) {
      return ra + (rb - ra) * fv + (rc - ra) * fu;
    }
    return rb + (rd - rb) * fu + (rc - rd) * (1 - fv);
  };
}
