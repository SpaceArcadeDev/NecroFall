// NECROFALL — Folio 2025's `Trees`, ported from
// folio-2025/sources/Game/World/Trees.js (MIT, Bruno Simon), adapted for the spherical planet
// and procedural placement (plan §11-§14, §38).
//
// Architecture preserved exactly:
//
//   visual model (treeBody + treeLeaves*) + procedural placement references
//        ↓
//   trunk = ONE InstancedMesh (one geometry, one material, N transforms)
//   leaves = shared Foliage renderer (one leaf cluster geometry, one material)
//        ↓
//   MeshDefaultMaterial → TSL → WebGPU
//
// The Folio reference models are reused 1:1 — birch, oak and cherry. What changed: the fixed
// world coordinates become `TreePlacement[]` from the deterministic generator, and physics is
// registered through the distance-tiered `WorldPhysics` (only trees near gameplay get colliders,
// plan §14).
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { Foliage } from './Foliage';
import type { TreePlacement } from '../../vegetation/VegetationTypes';
import { adoptMeshMaterial, cloneGeometryForInstancing } from '../materials/NecroVegetationMaterial';

export interface TreesOptions {
  name: string;
  /** Folio tree visual GLB scene (contains `treeBody` and `treeLeaves*` meshes). */
  visual: THREE.Object3D;
  /** Procedural placements (planet surface frames + scales). */
  placements: TreePlacement[];
  colorA: string;
  colorB: string;
  foliageTexture: THREE.Texture;
  focusScreenPosition?: () => THREE.Vector2 | null;
  seeThrough?: boolean;
  /** Quality gate: leaf shadows (plan §36). */
  castShadows?: boolean;
}

export class Trees {
  readonly name: string;
  readonly bodies: THREE.InstancedMesh | null;
  readonly leaves: Foliage;
  /** World-space info the physics + occlusion systems consume (plan §14/§42). */
  readonly placements: TreePlacement[];

  private readonly bodyGeometry: THREE.BufferGeometry | null;

  constructor(options: TreesOptions) {
    this.name = options.name;
    this.placements = options.placements;

    // --- model parts (Folio's contract: names starting with treeBody / treeLeaves)
    const visual = options.visual;
    visual.updateMatrixWorld(true);
    const leavesMeshes: THREE.Mesh[] = [];
    let body: THREE.Mesh | null = null;
    visual.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.name.startsWith('treeLeaves')) leavesMeshes.push(mesh);
      else if (mesh.name.startsWith('treeBody')) body = mesh;
    });
    if (!body) {
      // Fallback: any non-leaf mesh becomes the body (imported kits are not always named).
      visual.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!body && mesh.isMesh && !mesh.name.startsWith('treeLeaves')) body = mesh;
      });
    }

    // --- trunks: ONE InstancedMesh, shared material (adopted from the GLB, Folio family)
    if (body && options.placements.length > 0) {
      const bodyMesh = body as THREE.Mesh;
      this.bodyGeometry = cloneGeometryForInstancing(bodyMesh.geometry);
      const material = adoptMeshMaterial(bodyMesh.material, {
        weathered: true,
        emissive: 0,
        geometry: bodyMesh.geometry,
      });

      this.bodies = new THREE.InstancedMesh(this.bodyGeometry, material, options.placements.length);
      this.bodies.name = `${options.name} bodies`;
      this.bodies.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      this.bodies.castShadow = options.castShadows ?? false;
      this.bodies.receiveShadow = true;
      // Instances span the whole planet; the cell/visibility systems cull, not three.
      this.bodies.frustumCulled = false;

      // Per-instance terrain data for the weathered trunk shading.
      const terrain = new Float32Array(options.placements.length * 4);
      const veg = new Float32Array(options.placements.length);
      const matrix = new THREE.Matrix4();
      const scratch = new THREE.Matrix4();
      bodyMesh.updateMatrix();
      for (let i = 0; i < options.placements.length; i++) {
        const placement = options.placements[i];
        matrix.compose(placement.position, placement.quaternion, new THREE.Vector3(placement.scale, placement.scale, placement.scale));
        scratch.multiplyMatrices(matrix, bodyMesh.matrix);
        this.bodies.setMatrixAt(i, scratch);
        terrain.set(placement.terrain, i * 4);
        veg[i] = placement.vegetation;
      }
      this.bodyGeometry.setAttribute('aTerrain', new THREE.InstancedBufferAttribute(terrain, 4));
      this.bodyGeometry.setAttribute('aVeg', new THREE.InstancedBufferAttribute(veg, 1));
      this.bodies.instanceMatrix.needsUpdate = true;
      this.bodies.computeBoundingSphere?.();
    } else {
      this.bodies = null;
      this.bodyGeometry = null;
    }

    // --- leaves: every (tree × leaf-mesh) becomes one Foliage reference matrix
    const leafMatrices: THREE.Matrix4[] = [];
    const leafTerrain = new Float32Array(options.placements.length * leavesMeshes.length * 4);
    const leafVeg = new Float32Array(options.placements.length * leavesMeshes.length);
    if (leavesMeshes.length > 0) {
      const placementMatrix = new THREE.Matrix4();
      const leafWorld = new THREE.Matrix4();
      let k = 0;
      for (const placement of options.placements) {
        placementMatrix.compose(
          placement.position,
          placement.quaternion,
          new THREE.Vector3(placement.scale, placement.scale, placement.scale),
        );
        for (const leaves of leavesMeshes) {
          leaves.updateMatrix();
          leafWorld.multiplyMatrices(placementMatrix, leaves.matrix);
          leafMatrices.push(leafWorld.clone());
          leafTerrain.set(placement.terrain, k * 4);
          leafVeg[k] = placement.vegetation;
          k++;
        }
      }
    }

    this.leaves = new Foliage({
      name: `${options.name} leaves`,
      references: leafMatrices,
      foliageTexture: options.foliageTexture,
      colorA: uniform(new THREE.Color(options.colorA)),
      colorB: uniform(new THREE.Color(options.colorB)),
      seeThrough: options.seeThrough ?? true,
      terrainData: leafTerrain,
      vegetationData: leafVeg,
      focusScreenPosition: options.focusScreenPosition,
    });
    this.leaves.mesh.castShadow = options.castShadows ?? false;
  }

  setVisible(visible: boolean): void {
    if (this.bodies) this.bodies.visible = visible;
    this.leaves.mesh.visible = visible;
  }

  dispose(): void {
    if (this.bodies) {
      this.bodies.removeFromParent();
      this.bodyGeometry?.dispose();
    }
    this.leaves.dispose();
    this.leaves.mesh.removeFromParent();
  }
}
