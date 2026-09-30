/**
 * NECROFALL — spherical terrain mesh (plan §11/§72/§84).
 *
 * ONE lat-long sphere covering the whole planet, built from the SAME analytic
 * heights the physics uses (the baked texture is only for shader reads).
 * Detail windows and sector streaming can raise the resolution locally later;
 * the base mesh stays a single draw call.
 *
 * The build is chunked so the loading screen keeps running.
 */
import * as THREE from 'three/webgpu';
import { mix, normalize, positionLocal, smoothstep, texture } from 'three/tsl';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import type { TerrainNodeBundle } from './PlanetTerrainNodes';
import type { Noises } from './Noises';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';

const RES_X = 320;
const RES_Y = 160;

export class PlanetTerrain {
  readonly mesh: THREE.Mesh;
  readonly material: MeshDefaultMaterial;

  private constructor(mesh: THREE.Mesh, material: MeshDefaultMaterial) {
    this.mesh = mesh;
    this.material = material;
  }

  static async create(
    generator: PlanetGenerator,
    nodes: TerrainNodeBundle,
    noises: Noises,
    onProgress?: (ratio: number) => void,
  ): Promise<PlanetTerrain> {
    const width = RES_X;
    const height = RES_Y;
    const vertexCount = width * (height + 1);

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const radii = new Float32Array(vertexCount);
    const dirs = new Float32Array(vertexCount * 3);

    // ---- positions (chunked)
    for (let iy = 0; iy <= height; iy++) {
      const v = iy / height;
      const y = Math.cos(v * Math.PI);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      for (let ix = 0; ix < width; ix++) {
        const u = ix / width;
        const lon = (u - 0.5) * Math.PI * 2;
        const dx = r * Math.cos(lon);
        const dz = r * Math.sin(lon);
        const index = iy * width + ix;
        dirs[index * 3] = dx;
        dirs[index * 3 + 1] = y;
        dirs[index * 3 + 2] = dz;
        const radius = generator.radiusAt(dx, y, dz);
        radii[index] = radius;
        positions[index * 3] = dx * radius;
        positions[index * 3 + 1] = y * radius;
        positions[index * 3 + 2] = dz * radius;
      }
      if (iy % 16 === 15) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        onProgress?.((iy / height) * 0.7);
      }
    }

    // ---- normals from the height grid (finite differences)
    for (let iy = 0; iy <= height; iy++) {
      const iyN = Math.min(height, iy + 1);
      const iyS = Math.max(0, iy - 1);
      for (let ix = 0; ix < width; ix++) {
        const ixE = (ix + 1) % width;
        const ixW = (ix - 1 + width) % width;
        const index = iy * width + ix;
        const indexE = iy * width + ixE;
        const indexW = iy * width + ixW;
        const indexN = iyN * width + ix;
        const indexS = iyS * width + ix;

        const edgeE = sub(positions, indexE, index);
        const edgeW = sub(positions, indexW, index);
        const edgeN = sub(positions, indexN, index);
        const edgeS = sub(positions, indexS, index);

        // normal = east×north style tangents (orientation fixed below)
        const nx = edgeS[1] * edgeE[2] - edgeS[2] * edgeE[1];
        const ny = edgeS[2] * edgeE[0] - edgeS[0] * edgeE[2];
        const nz = edgeS[0] * edgeE[1] - edgeS[1] * edgeE[0];
        const length = Math.hypot(nx, ny, nz) || 1e-5;
        normals[index * 3] = nx / length;
        normals[index * 3 + 1] = ny / length;
        normals[index * 3 + 2] = nz / length;
        // orient outward
        if (
          normals[index * 3] * dirs[index * 3] +
            normals[index * 3 + 1] * dirs[index * 3 + 1] +
            normals[index * 3 + 2] * dirs[index * 3 + 2] <
          0
        ) {
          normals[index * 3] *= -1;
          normals[index * 3 + 1] *= -1;
          normals[index * 3 + 2] *= -1;
        }
      }
      if (iy % 16 === 15) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        onProgress?.(0.7 + (iy / height) * 0.15);
      }
    }

    // ---- indices
    const indices: number[] = [];
    for (let iy = 0; iy < height; iy++) {
      for (let ix = 0; ix < width; ix++) {
        const ixNext = (ix + 1) % width;
        const a = iy * width + ix;
        const b = (iy + 1) * width + ix;
        const c = iy * width + ixNext;
        const d = (iy + 1) * width + ixNext;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();

    // ---- material: folio's terrain read — palette colour via the shared node
    const material = new MeshDefaultMaterial({
      colorNode: (() => {
        const terrainData = nodes.terrainNode(positionLocal);
        const base = nodes.colorNode(terrainData);
        // DARK SOIL UNDER THE GRASS PATCHES ONLY (the reference look): the
        // terrain darkens exactly where the grass clumps grow — the SAME
        // planet-stable patch field the grass samples (world direction ×9,
        // same thresholds) — so the bare soil between patches stays bright
        // like folio's dunes. The threshold sits INSIDE the grass gate and the
        // intensity is gentle, so dark ground only appears as a soft underlay
        // of the densest clumps (which fully cover it) and never out in the
        // transition tufts.
        const direction = normalize(positionLocal);
        const patchNoise = texture(noises.perlin, direction.xz.mul(9.0)).r;
        // INSIDE the full-blade zone only (blades hit 100% at noise ~0.52) and
        // gentle, so the dark can only ever appear as faint shade BETWEEN
        // packed blades — never as exposed dark ground.
        const patchFactor = smoothstep(0.53, 0.64, patchNoise);
        return base.mul(mix(1.0, 0.62, patchFactor)) as any;
      })(),
      // A convex planet constantly presents far-slope BACKFACES to a low camera;
      // single-sided terrain left see-through voids wherever grass didn't cover.
      side: THREE.DoubleSide,
      hasCoreShadows: true,
      hasDropShadows: true,
      hasLightBounce: false,
      hasFog: true,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.name = 'planetTerrain';

    onProgress?.(1);
    return new PlanetTerrain(mesh, material);
  }
}

function sub(data: Float32Array, i: number, j: number): [number, number, number] {
  return [
    data[i * 3] - data[j * 3],
    data[i * 3 + 1] - data[j * 3 + 1],
    data[i * 3 + 2] - data[j * 3 + 2],
  ];
}
