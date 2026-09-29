// NECROFALL — Bushes (plan §15): Folio's Foliage renderer + reusable bush cluster shapes from
// `bushesReferences.glb`, procedurally placed over the planet.
//
// Bushes are visual-only by default (non-blocking). A cluster is built from a deterministic
// pick of the Folio cluster shapes, so two peers with the same seed build identical bushes.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { Foliage } from './Foliage';
import type { BushPlacement } from '../../vegetation/VegetationTypes';

export interface BushesOptions {
  /** Folio bushesReferences scene — children are the cluster shapes. */
  references: THREE.Object3D;
  placements: BushPlacement[];
  foliageTexture: THREE.Texture;
  colorA: string;
  colorB: string;
  focusScreenPosition?: () => THREE.Vector2 | null;
  seeThrough?: boolean;
}

export class Bushes {
  readonly foliage: Foliage;

  constructor(options: BushesOptions) {
    const children = options.references.children;
    const matrices: THREE.Matrix4[] = [];
    const terrain: number[] = [];
    const veg: number[] = [];

    const placementMatrix = new THREE.Matrix4();
    const childMatrix = new THREE.Matrix4();
    const scaleVec = new THREE.Vector3();

    for (const placement of options.placements) {
      // 2-4 cluster shapes per bush, picked deterministically from the placement id.
      const clusterSize = 2 + (placement.id % 3);
      for (let k = 0; k < clusterSize && children.length > 0; k++) {
        const child = children[(placement.id * 7 + k * 3) % children.length];
        child.updateMatrix();

        scaleVec.setScalar(placement.scale);
        placementMatrix.compose(placement.position, placement.quaternion, scaleVec);
        childMatrix.multiplyMatrices(placementMatrix, child.matrix);
        matrices.push(childMatrix.clone());

        terrain.push(...placement.terrain);
        veg.push(placement.vegetation);
      }
    }

    this.foliage = new Foliage({
      name: 'bushes',
      references: matrices,
      foliageTexture: options.foliageTexture,
      colorA: uniform(new THREE.Color(options.colorA)),
      colorB: uniform(new THREE.Color(options.colorB)),
      seeThrough: options.seeThrough ?? false,
      terrainData: new Float32Array(terrain),
      vegetationData: new Float32Array(veg),
      focusScreenPosition: options.focusScreenPosition,
    });
  }

  setVisible(visible: boolean): void {
    this.foliage.mesh.visible = visible;
  }

  dispose(): void {
    this.foliage.dispose();
    this.foliage.mesh.removeFromParent();
  }
}
