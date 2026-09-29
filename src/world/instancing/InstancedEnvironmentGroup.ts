// NECROFALL — INSTANCED ENVIRONMENT GROUP (rework plan §18/§42/§43/§70).
//
// One group = one geometry + one material + N instance slots. The whole planet renders its
// environment through a handful of groups (grass, trees ×2 LOD, rocks ×2 LOD, props ×2 LOD,
// crystals…), so the scene keeps a fixed, small material set and a fixed draw-call count —
// never `new THREE.Mesh()` per rock (plan §86).
//
// Slot management:
//   * instances are allocated in CONTIGUOUS ranges (`alloc(count)`), which is exactly what the
//     cell streaming system needs: a cell owns its ranges and can revive/collapse them in one
//     pass (plan §19);
//   * freed ranges return to a free list and are reused by later cells;
//   * hidden instances (unloaded cell, destroyed tree, LOD band) stay allocated but are collapsed
//     by the shader via `aState` — no CPU matrix churn while walking around.
//
// Every instance carries its stable attributes: tint, wind phase, height, state, occlusion fade,
// per-instance random and LOD bias (see EnvironmentMaterials.ts).
import * as THREE from 'three';

export interface InstanceSpec {
  matrix: THREE.Matrix4;
  /** Base colour (instanceColor). */
  color: THREE.Color;
  /** Multiplier on the base colour (per-instance variation). */
  tint: number;
  /** Wind phase offset. */
  phase: number;
  /** Normalising height for wind (geometry height × scale). */
  height: number;
  /** Stable 0..1 random (grass tiers, LOD stagger). */
  rand: number;
  /** LOD switch bias 0.85..1.15 (0 = default 1). */
  lod?: number;
  /** Initial state (1 active — normally true; destruction/pre-spawn uses 0). */
  state?: number;
}

interface FreeRange {
  start: number;
  count: number;
}

const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

export class InstancedEnvironmentGroup {
  readonly mesh: THREE.InstancedMesh;
  /** Cheap far mesh (plan §6/§49) — same instances, collapsed by the complementary LOD band. */
  readonly farMesh: THREE.InstancedMesh | null;
  readonly capacity: number;
  /** Highest slot ever allocated (used by telemetry). */
  highWater = 0;

  private readonly tints: Float32Array;
  private readonly phases: Float32Array;
  private readonly heights: Float32Array;
  private readonly states: Float32Array;
  private readonly fades: Float32Array;
  private readonly rands: Float32Array;
  private readonly lods: Float32Array;
  private readonly colors: Float32Array;
  private readonly freeList: FreeRange[] = [];
  private disposed = false;

  constructor(
    readonly name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.ShaderMaterial,
    capacity: number,
    far?: { geometry: THREE.BufferGeometry; material: THREE.ShaderMaterial }
  ) {
    this.capacity = Math.max(1, capacity);
    const n = this.capacity;
    this.tints = new Float32Array(n).fill(1);
    this.phases = new Float32Array(n);
    this.heights = new Float32Array(n).fill(1);
    this.states = new Float32Array(n);            // start collapsed: slots are filled by cells
    this.fades = new Float32Array(n).fill(1);
    this.rands = new Float32Array(n);
    this.lods = new Float32Array(n).fill(1);
    this.colors = new Float32Array(n * 3).fill(1);

    const attach = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
      g.setAttribute('aTint', new THREE.InstancedBufferAttribute(this.tints, 1));
      g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(this.phases, 1));
      g.setAttribute('aHeight', new THREE.InstancedBufferAttribute(this.heights, 1));
      g.setAttribute('aState', new THREE.InstancedBufferAttribute(this.states, 1));
      g.setAttribute('aFade', new THREE.InstancedBufferAttribute(this.fades, 1));
      g.setAttribute('aRand', new THREE.InstancedBufferAttribute(this.rands, 1));
      g.setAttribute('aLod', new THREE.InstancedBufferAttribute(this.lods, 1));
      return g;
    };
    // Clone: the same BASE geometry (AssetRegistry, plan §69) can back several groups, and each
    // group needs its own instance attributes on its own geometry object.
    const detailGeo = attach(geometry.clone());

    this.mesh = new THREE.InstancedMesh(detailGeo, material, n);
    this.mesh.count = n;
    // The groups span the whole planet; per-instance distance/LOD culling happens in the shader.
    this.mesh.frustumCulled = false;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.mesh.name = name;
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, ZERO_MATRIX);

    if (far) {
      attach(far.geometry);
      this.farMesh = new THREE.InstancedMesh(far.geometry, far.material, n);
      this.farMesh.count = n;
      this.farMesh.frustumCulled = false;
      this.farMesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
      this.farMesh.name = `${name}-far`;
      for (let i = 0; i < n; i++) this.farMesh.setMatrixAt(i, ZERO_MATRIX);
    } else {
      this.farMesh = null;
    }
  }

  /** Allocates a contiguous range of `count` slots, or null when the group is out of budget. */
  alloc(count: number): { start: number; count: number } | null {
    if (count <= 0) return null;
    // First fit in the free list.
    for (let i = 0; i < this.freeList.length; i++) {
      const r = this.freeList[i];
      if (r.count >= count) {
        const start = r.start;
        if (r.count === count) this.freeList.splice(i, 1);
        else {
          r.start += count;
          r.count -= count;
        }
        return { start, count };
      }
    }
    if (this.highWater + count > this.capacity) return null;
    const start = this.highWater;
    this.highWater += count;
    return { start, count };
  }

  /** Returns a range to the free list (the slot data stays; the shader keeps them collapsed). */
  free(start: number, count: number): void {
    if (count <= 0 || start < 0) return;
    // Keep the list sorted + merged so later allocations stay contiguous-friendly.
    let i = 0;
    while (i < this.freeList.length && this.freeList[i].start < start) i++;
    const before = this.freeList[i - 1];
    const after = this.freeList[i];
    if (before && before.start + before.count === start) {
      before.count += count;
      if (after && start + count === after.start) {
        before.count += after.count;
        this.freeList.splice(i, 1);
      }
      return;
    }
    if (after && start + count === after.start) {
      after.start = start;
      after.count += count;
      return;
    }
    this.freeList.splice(i, 0, { start, count });
  }

  /** Writes one instance into slot `i`. */
  set(i: number, spec: InstanceSpec): void {
    this.mesh.setMatrixAt(i, spec.matrix);
    if (this.farMesh) this.farMesh.setMatrixAt(i, spec.matrix);
    this.colors[i * 3] = spec.color.r;
    this.colors[i * 3 + 1] = spec.color.g;
    this.colors[i * 3 + 2] = spec.color.b;
    this.tints[i] = spec.tint;
    this.phases[i] = spec.phase;
    this.heights[i] = spec.height;
    this.states[i] = spec.state ?? 1;
    this.fades[i] = 1;
    this.rands[i] = spec.rand;
    this.lods[i] = spec.lod ?? 1;
  }

  /** Replaces one instance's transform only (tree damage lean, prop knocked over). */
  setMatrix(i: number, m: THREE.Matrix4): void {
    this.mesh.setMatrixAt(i, m);
    if (this.farMesh) this.farMesh.setMatrixAt(i, m);
  }

  /** Replaces one instance's colour only (damage darkening, contamination tint). */
  setColor(i: number, color: THREE.Color): void {
    this.colors[i * 3] = color.r;
    this.colors[i * 3 + 1] = color.g;
    this.colors[i * 3 + 2] = color.b;
  }

  setTint(i: number, value: number): void {
    this.tints[i] = value;
  }

  setState(i: number, value: number): void {
    this.states[i] = value;
  }

  /** Occlusion fade target (0..1) for one instance (plan §54). */
  setFade(i: number, value: number): void {
    this.fades[i] = value;
  }

  /** Pushes the CPU-side attribute arrays to the GPU. Call once after a batch of `set`s. */
  commit(): void {
    if (this.disposed) return;
    const g = this.mesh.geometry;
    this.touch(g);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.farMesh) {
      this.touch(this.farMesh.geometry);
      this.farMesh.instanceMatrix.needsUpdate = true;
      if (this.farMesh.instanceColor) this.farMesh.instanceColor.needsUpdate = true;
    }
  }

  /** Pushes only the per-instance STATE attribute (cell streaming toggles many slots cheaply). */
  commitStates(): void {
    if (this.disposed) return;
    const a = this.mesh.geometry.getAttribute('aState');
    if (a) a.needsUpdate = true;
    const f = this.farMesh?.geometry.getAttribute('aState');
    if (f) f.needsUpdate = true;
  }

  /** Pushes only the FADE attribute (occlusion changes a handful of instances per frame). */
  commitFades(): void {
    if (this.disposed) return;
    const a = this.mesh.geometry.getAttribute('aFade');
    if (a) a.needsUpdate = true;
    const f = this.farMesh?.geometry.getAttribute('aFade');
    if (f) f.needsUpdate = true;
  }

  /** Pushes instance transforms + colours after damage edits (small batches only). */
  commitTransforms(): void {
    if (this.disposed) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.farMesh) {
      this.farMesh.instanceMatrix.needsUpdate = true;
      if (this.farMesh.instanceColor) this.farMesh.instanceColor.needsUpdate = true;
    }
  }

  /** Pushes the per-instance tint attribute (after damage edits). */
  commitTints(): void {
    if (this.disposed) return;
    const a = this.mesh.geometry.getAttribute('aTint');
    if (a) a.needsUpdate = true;
    const f = this.farMesh?.geometry.getAttribute('aTint');
    if (f) f.needsUpdate = true;
  }

  private touch(g: THREE.BufferGeometry): void {
    for (const key of ['aTint', 'aPhase', 'aHeight', 'aState', 'aFade', 'aRand', 'aLod']) {
      const a = g.getAttribute(key);
      if (a) a.needsUpdate = true;
    }
  }

  /** Watchdog hook (plan §47/§69): collapses or restores the entire group in one attribute write. */
  setAllStates(value: number): void {
    this.states.fill(value);
    this.commitStates();
  }

  dispose(): void {
    this.disposed = true;
    this.mesh.geometry.dispose();
    this.mesh.removeFromParent();
    // Materials are shared — the materials owner disposes them.
    this.farMesh?.geometry.dispose();
    this.farMesh?.removeFromParent();
    this.freeList.length = 0;
  }
}
