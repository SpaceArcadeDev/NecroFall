// NECROFALL — Rocks (plan §22): static, instanced, terrain-aligned low-poly stones in the Folio
// material family. Two kinds share the system:
//
//   ROCK  — dodecahedron boulders
//   SLAB  — thin flat stones
//
// Physics only ever gets the rocks gameplay can actually collide with (plan §22) — decorative
// rocks never become colliders, and this class creates none.
import * as THREE from 'three/webgpu';
import { buildInstancedField, buildPropMaterial } from './InstancedField';
import type { RockPlacement } from '../../world/vegetation/VegetationTypes';

export interface RocksOptions {
  placements: RockPlacement[];
  castShadows?: boolean;
}

export class Rocks {
  readonly meshes: THREE.Mesh[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(options: RocksOptions) {
    const kinds: Array<{ kind: 'ROCK' | 'SLAB'; geometry: THREE.BufferGeometry; baseHex: number }> = [
      { kind: 'ROCK', geometry: new THREE.DodecahedronGeometry(1, 0), baseHex: 0x6a6273 },
      { kind: 'SLAB', geometry: new THREE.BoxGeometry(2.2, 0.6, 1.6), baseHex: 0x5c5566 },
    ];

    for (const definition of kinds) {
      const placements = options.placements.filter((placement) => placement.kind === definition.kind);
      if (placements.length === 0) continue;

      const material = buildPropMaterial(definition.baseHex, 0);
      const mesh = buildInstancedField({
        name: `rocks:${definition.kind}`,
        geometry: definition.geometry,
        material,
        placements,
        castShadows: options.castShadows,
      });
      if (!mesh) continue;

      this.meshes.push(mesh);
      this.materials.push(material);
    }
  }

  setVisible(visible: boolean): void {
    for (const mesh of this.meshes) mesh.visible = visible;
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.geometry.dispose();
    for (const material of this.materials) material.dispose();
  }
}
