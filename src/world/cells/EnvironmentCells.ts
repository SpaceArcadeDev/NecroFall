// NECROFALL — ENVIRONMENT CELLS (rework plan §6/§19/§72/§73).
//
// The planet's streamable surface partition: a CUBE-SPHERE grid (`cellsPerFace²` cells on each of
// the six cube faces, projected to the sphere). Compared to lat/lon bins this gives:
//
//   * near-uniform cell sizes (lat/lon bins collapse at the poles);
//   * DIRECTLY indexable neighbours inside a face — no hashing, no seams;
//   * deterministic indices: `(planetSeed, environmentVersion, cellIndex)` addresses every cell,
//     and cell CENTRES are pure geometry, so all clients agree bit-for-bit (plan §59/§73).
//
// The streamer keeps the cells around the players active: their objects get instanced transforms,
// collision entries and destruction records; everything else is collapsed (plan §19: "inactive
// cells contain no renderable meshes, no physics bodies, no animation, no update loops").
import * as THREE from 'three';
import { clamp } from '../../utils/Utils';

const FACE_BASES: readonly THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];

/** For each face: the two tangent axes whose cube coordinates are the cell's (u, v). */
const FACE_U: readonly THREE.Vector3[] = [
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
];
const FACE_V: readonly THREE.Vector3[] = [
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 1, 0),
];

const _d = new THREE.Vector3();

export class EnvironmentCells {
  readonly perFace: number;
  readonly count: number;
  /** Centre directions, precomputed once (index → unit vector). */
  private readonly centers: Float32Array;
  private readonly adjacency: number[][] = [];
  /** Cached traversal class per cell (plan §64); -1 = not evaluated yet. */
  private readonly traversal: Int8Array;
  /** Cached suitability for structures/arenas per cell (plan §63); -1 = not evaluated yet. */
  private readonly suitability: Float32Array;

  constructor(readonly radius: number, perFace: number) {
    this.perFace = Math.max(2, Math.floor(perFace));
    this.count = 6 * this.perFace * this.perFace;
    this.centers = new Float32Array(this.count * 3);
    this.traversal = new Int8Array(this.count).fill(-1);
    this.suitability = new Float32Array(this.count).fill(-1);
    for (let c = 0; c < this.count; c++) {
      this.centerOf(c, _d);
      this.centers[c * 3] = _d.x;
      this.centers[c * 3 + 1] = _d.y;
      this.centers[c * 3 + 2] = _d.z;
    }
    // Geometric adjacency: cells whose centres are within one cell-step of each other. Computed
    // once; seamless across faces because it only uses the resulting directions.
    const step = (Math.PI / 2 / this.perFace) * 1.75;
    const cosStep = Math.cos(step);
    for (let a = 0; a < this.count; a++) {
      const list: number[] = [];
      const ax = this.centers[a * 3], ay = this.centers[a * 3 + 1], az = this.centers[a * 3 + 2];
      for (let b = 0; b < this.count; b++) {
        if (b === a) continue;
        const d = ax * this.centers[b * 3] + ay * this.centers[b * 3 + 1] + az * this.centers[b * 3 + 2];
        if (d >= cosStep) list.push(b);
      }
      this.adjacency.push(list);
    }
  }

  /** Angular half-size of one cell (radians). */
  get cellAngle(): number {
    return Math.PI / 2 / this.perFace;
  }

  /** World-space size of one cell (metres, approximate). */
  get cellSize(): number {
    return this.radius * this.cellAngle;
  }

  /** Cell index containing a unit direction. */
  indexOf(dir: THREE.Vector3): number {
    const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
    let face: number;
    let major: number;
    if (ax >= ay && ax >= az) {
      face = dir.x >= 0 ? 0 : 1;
      major = ax;
    } else if (ay >= az) {
      face = dir.y >= 0 ? 2 : 3;
      major = ay;
    } else {
      face = dir.z >= 0 ? 4 : 5;
      major = az;
    }
    // Project the direction onto the cube face, then read its (u, v) in the face's tangent axes
    // — the exact inverse of `centerOf`, so lookup and placement always agree.
    const inv = 1 / Math.max(1e-9, major);
    const px = dir.x * inv, py = dir.y * inv, pz = dir.z * inv;
    const fu = FACE_U[face], fv = FACE_V[face];
    const u = px * fu.x + py * fu.y + pz * fu.z;
    const v = px * fv.x + py * fv.y + pz * fv.z;
    const i = clamp(Math.floor((u + 1) * 0.5 * this.perFace), 0, this.perFace - 1);
    const j = clamp(Math.floor((v + 1) * 0.5 * this.perFace), 0, this.perFace - 1);
    return (face * this.perFace + j) * this.perFace + i;
  }

  /** Centre direction of a cell index. */
  centerOf(index: number, out: THREE.Vector3): THREE.Vector3 {
    const i = index % this.perFace;
    const j = Math.floor(index / this.perFace) % this.perFace;
    const face = Math.floor(index / (this.perFace * this.perFace));
    const u = ((i + 0.5) / this.perFace) * 2 - 1;
    const v = ((j + 0.5) / this.perFace) * 2 - 1;
    const base = FACE_BASES[face];
    const ux = FACE_U[face];
    const vx = FACE_V[face];
    return out.set(
      base.x + ux.x * u + vx.x * v,
      base.y + ux.y * u + vx.y * v,
      base.z + ux.z * u + vx.z * v
    ).normalize();
  }

  /** Centre direction (read-only access to the precomputed buffer). */
  centerX(index: number): number { return this.centers[index * 3]; }
  centerY(index: number): number { return this.centers[index * 3 + 1]; }
  centerZ(index: number): number { return this.centers[index * 3 + 2]; }

  /** Cells within `radiusWorld` of any focus point, ordered nearest-first (plan §72). */
  activeCells(focusDirs: readonly THREE.Vector3[], radiusWorld: number, out: number[] = []): number[] {
    out.length = 0;
    const cos = Math.cos(radiusWorld / this.radius);
    for (let c = 0; c < this.count; c++) {
      const cx = this.centers[c * 3], cy = this.centers[c * 3 + 1], cz = this.centers[c * 3 + 2];
      for (let f = 0; f < focusDirs.length; f++) {
        const d = focusDirs[f];
        if (cx * d.x + cy * d.y + cz * d.z >= cos) {
          out.push(c);
          break;
        }
      }
    }
    // Nearest-first: the player's own cell and its ring are built before the horizon cells.
    const px = focusDirs[0]?.x ?? 1, py = focusDirs[0]?.y ?? 0, pz = focusDirs[0]?.z ?? 0;
    out.sort((a, b) => {
      const da = this.centers[a * 3] * px + this.centers[a * 3 + 1] * py + this.centers[a * 3 + 2] * pz;
      const db = this.centers[b * 3] * px + this.centers[b * 3 + 1] * py + this.centers[b * 3 + 2] * pz;
      return db - da;
    });
    return out;
  }

  /** Neighbouring cell indices (used by traversal/flood queries). */
  neighborsOf(index: number): readonly number[] {
    return this.adjacency[index];
  }

  /** Cached traversal class (plan §64); callers fill it on first evaluation. */
  traversalOf(index: number): number {
    return this.traversal[index];
  }

  setTraversal(index: number, value: number): void {
    this.traversal[index] = value;
  }

  /** Cached arena/structure suitability (plan §63). */
  suitabilityOf(index: number): number {
    return this.suitability[index];
  }

  setSuitability(index: number, value: number): void {
    this.suitability[index] = value;
  }

  /** Debug: the cell whose centre is nearest to a direction (for visualization). */
  nearestIndex(dir: THREE.Vector3): number {
    return this.indexOf(dir);
  }

  /** Iterates the cube-face grid coordinates of an index. */
  coordsOf(index: number): { face: number; i: number; j: number } {
    const i = index % this.perFace;
    const j = Math.floor(index / this.perFace) % this.perFace;
    const face = Math.floor(index / (this.perFace * this.perFace));
    return { face, i, j };
  }
}
