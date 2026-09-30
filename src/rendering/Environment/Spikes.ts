// NECROFALL — Spikes (plan §23): the contaminated terrain hazards. A NEW NecroFall-specific
// prop, built in the Folio geometry language:
//
//   low-poly · chunky · simple silhouette · palette-based · soft controlled shading
//
// A spike is a tall 5-sided grey cone (the pre-rework "jagged peaks" were tall narrow cones, not
// round rocks). Clusters (2–5 cones per cluster) come from the placement generator — this class
// renders each cone as one instance of ONE InstancedMesh.
//
// Spikes stand PROUD of the ground (`lift` positive): a cone buried half-way reads as a boulder,
// not a spire. They cast shadows (plan §54: spikes are major props).
import * as THREE from 'three/webgpu';
import { buildInstancedField, buildPropMaterial } from './InstancedField';
import type { RockPlacement } from '../../world/vegetation/VegetationTypes';

export interface SpikesOptions {
  placements: RockPlacement[];
  castShadows?: boolean;
}

export class Spikes {
  readonly mesh: THREE.Mesh | null = null;
  private readonly material: THREE.Material | null = null;

  constructor(options: SpikesOptions) {
    const placements = options.placements.filter((placement) => placement.kind === 'SPIKE');
    if (placements.length === 0) return;

    // Grey cones with almost no corruption wash so they stay stone-grey under a warm sun (the
    // full wash tinted them purple on corrupt worlds — "colored pyramids", user review).
    const material = buildPropMaterial(0x8c8aa0, 0, 0.06);

    const mesh = buildInstancedField({
      name: 'spikes',
      geometry: new THREE.ConeGeometry(0.62, 3.2, 5),
      material,
      placements,
      castShadows: options.castShadows,
      lift: 0.5,
    });
    if (!mesh) return;

    this.mesh = mesh;
    this.material = material;
  }

  setVisible(visible: boolean): void {
    if (this.mesh) this.mesh.visible = visible;
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}
