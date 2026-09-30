// NECROFALL — Scenery (plan §17/§27): the Folio scenery kit rendered as instanced sets — one
// InstancedMesh per source mesh, one adopted material, N transforms. Bricks, fences, benches,
// explosive crates, lanterns and pole lights are the actual Folio models, dressed into the
// world by SceneryGenerator's procedural placement.
import * as THREE from 'three/webgpu';
import { adoptMeshMaterial, cloneGeometryForInstancing } from '../materials/NecroVegetationMaterial';
import type { SceneryKind, SceneryPlacement } from '../../vegetation/VegetationTypes';

export interface SceneryOptions {
  models: Record<SceneryKind, THREE.Object3D>;
  placements: SceneryPlacement[];
  castShadows?: boolean;
}

interface SceneryPart {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
}

export class Scenery {
  readonly count: number;
  /** Per-kind world transforms — the physics layer registers colliders from these (plan §27). */
  readonly placed: SceneryPlacement[];
  /**
   * Crate meshes + their model-local matrices: dynamic crates write physics transforms back here
   * so the visible crate IS the simulated crate.
   */
  readonly crateParts: Array<{ mesh: THREE.InstancedMesh; localMatrix: THREE.Matrix4 }> = [];

  private readonly parts: SceneryPart[] = [];

  constructor(options: SceneryOptions) {
    this.placed = options.placements;
    this.count = options.placements.length;

    for (const kind of SCENERY_KINDS) {
      const model = options.models[kind];
      const placements = options.placements.filter((p) => p.kind === kind);
      if (!model || placements.length === 0) continue;

      model.updateMatrixWorld(true);
      model.traverse((child) => {
        const source = child as THREE.Mesh;
        if (!source.isMesh) return;

        source.updateMatrix();
        const geometry = cloneGeometryForInstancing(source.geometry);
        const material = adoptMeshMaterial(source.material, {
          weathered: kind !== 'LANTERN' && kind !== 'POLE_LIGHT',
          emissive: kind === 'LANTERN' ? 0.5 : kind === 'POLE_LIGHT' ? 0.35 : 0,
          geometry: source.geometry,
        });

        const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
        mesh.name = `scenery:${kind}:${source.name || 'part'}`;
        mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        mesh.castShadow = options.castShadows ?? false;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;

        const terrain = new Float32Array(placements.length * 4);
        const veg = new Float32Array(placements.length);
        const matrix = new THREE.Matrix4();
        const scratch = new THREE.Matrix4();
        const scale = new THREE.Vector3();
        for (let i = 0; i < placements.length; i++) {
          const placement = placements[i];
          scale.setScalar(placement.scale);
          matrix.compose(placement.position, placement.quaternion, scale);
          scratch.multiplyMatrices(matrix, source.matrix);
          mesh.setMatrixAt(i, scratch);
          terrain.set(placement.terrain, i * 4);
          veg[i] = placement.vegetation;
        }
        geometry.setAttribute('aTerrain', new THREE.InstancedBufferAttribute(terrain, 4));
        geometry.setAttribute('aVeg', new THREE.InstancedBufferAttribute(veg, 1));
        mesh.instanceMatrix.needsUpdate = true;

        this.parts.push({ mesh, geometry });
        if (kind === 'CRATE') {
          this.crateParts.push({ mesh, localMatrix: source.matrix.clone() });
        }
      });
    }
  }

  setVisible(visible: boolean): void {
    for (const part of this.parts) part.mesh.visible = visible;
  }

  /** The instanced meshes, for scene attachment. */
  get meshes(): THREE.InstancedMesh[] {
    return this.parts.map((part) => part.mesh);
  }

  dispose(): void {
    for (const part of this.parts) {
      part.mesh.removeFromParent();
      part.geometry.dispose();
      const material = part.mesh.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
    }
    this.parts.length = 0;
  }
}

const SCENERY_KINDS: SceneryKind[] = ['BRICKS', 'FENCE', 'BENCH', 'CRATE', 'LANTERN', 'POLE_LIGHT'];
