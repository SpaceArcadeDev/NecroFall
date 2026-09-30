// NECROFALL — Bushes (plan §15): Folio's Foliage renderer + reusable bush cluster shapes from
// `bushesReferences.glb`, procedurally placed over the planet.
//
// Bushes are visual-only by default (non-blocking). A cluster is built from a deterministic
// pick of the Folio cluster shapes, so two peers with the same seed build identical bushes.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { Foliage } from './Foliage';
import type { BushPlacement } from '../../world/vegetation/VegetationTypes';

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

    // The reference GLB's children are folio's OWN island placements — positions scattered
    // across their flat world (e.g. (22.7, 1.3, 24.4)), NOT cluster shapes. The old port
    // composed each child matrix with our procedural placement, which teleported every bush
    // tens of metres off its site — the "bushes floating in the air, not following the terrain"
    // report (live review 2026-09-30). Their SCALE stays as a shape variation; the cluster is
    // instanced directly at OUR placement, lifted half a size along the radial so the blob sits
    // on the contour (folio's own children rest ~1 scale unit above their ground).
    const childScales: number[] = [];
    for (const child of children) {
      child.updateMatrix();
      const e = child.matrix.elements;
      childScales.push(Math.hypot(e[0], e[1], e[2]));
    }

    const placementMatrix = new THREE.Matrix4();
    const scaleVec = new THREE.Vector3();
    const centre = new THREE.Vector3();
    const lift = new THREE.Vector3();

    for (const placement of options.placements) {
      const variant = childScales.length > 0 ? childScales[placement.id % childScales.length] : 1;
      const scale = placement.scale * (0.85 + (variant - 1) * 2);
      // The cluster's plane sphere reaches ±1·scale: centring it half a scale above the ground
      // buries the base and keeps the blob glued to the contour, slopes included.
      lift.copy(placement.position).normalize().multiplyScalar(scale * 0.5);
      centre.copy(placement.position).add(lift);
      placementMatrix.compose(centre, placement.quaternion, scaleVec.setScalar(scale));
      matrices.push(placementMatrix.clone());
      terrain.push(...placement.terrain);
      veg.push(placement.vegetation);
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
