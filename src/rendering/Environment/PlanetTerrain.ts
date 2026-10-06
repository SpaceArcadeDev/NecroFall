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
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import type { TerrainNodeBundle } from './PlanetTerrainNodes';
import type { Noises } from './Noises';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { createTerrainMaterial } from '../materials/TerrainMaterial';
import { yieldToMain } from '../../utils/Yield';

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
        await yieldToMain();
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
        await yieldToMain();
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

    // ---- material: folio's terrain read — palette colour via the shared node. The terrain
    // data + palette colour nodes are built ONCE: the colour node shades the ground, and the
    // lawn-glow term reuses the very same samples instead of re-reading terrain + palette per
    // pixel (plan §32 — repeated shader work moved out of the fragment path).
    //
    // The visual rework (plan §4–§7/§19–§21/§62) lives in ONE shared factory — masks, noise
    // breakup, elevation bands, slope/wetness/radiation layers, distance compression and the
    // atmospheric rim — so no other system needs its own terrain material (plan §43).
    const { material } = createTerrainMaterial({ nodes, noises });

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
