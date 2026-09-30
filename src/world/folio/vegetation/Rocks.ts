// NECROFALL — environment rocks & crystals (NecroFall-specific props, plan §64/§65): rendered
// through the Folio material family like everything else. One InstancedMesh per kind, per-instance
// terrain data for the weathering wash, emissive crystals.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { weatheredNode } from '../materials/NecroVegetationMaterial';
import { FOLIO } from '../FolioShaderGlobals';
import type { RockPlacement } from '../../vegetation/VegetationTypes';

export interface RocksOptions {
  placements: RockPlacement[];
  castShadows?: boolean;
}

export class Rocks {
  readonly meshes: THREE.Mesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(options: RocksOptions) {
    // `lift` (× scale, metres): + stands proud of the ground, − sinks below it. Spikes LIFT —
    // buried half-way a cone reads as a boulder, not a spire.
    const groups: Array<{ kind: RockPlacement['kind']; geometry: THREE.BufferGeometry; material: MeshDefaultMaterial; yStretch?: number; lift?: number }> = [
      {
        kind: 'ROCK',
        geometry: new THREE.DodecahedronGeometry(1, 0),
        material: this.buildMaterial(0x6a6273, 0),
      },
      {
        kind: 'SLAB',
        geometry: new THREE.BoxGeometry(2.2, 0.6, 1.6),
        material: this.buildMaterial(0x5c5566, 0),
      },
      {
        kind: 'CRYSTAL',
        // The purple glowing crystals (user review 2026-09-30: "can have back the purple glowing
        // crystals, i dont want pyramids"): slender tall shards, rooted, with a FIXED purple
        // glow — the planet's vein colour used to tint them green/orange on most worlds, which
        // read as flat coloured pyramids instead of crystals.
        geometry: new THREE.OctahedronGeometry(1, 0),
        material: this.buildMaterial(0x7a4fd0, 0.9, 0.3, 0x9a6bff),
        yStretch: 2.1,
      },
      {
        kind: 'SPIKE',
        // The pre-rework "jagged peaks" (user review 2026-09-30: "the actual spikes should be
        // grey cones in groups, not colored pyramids"): a tall 5-sided grey cone, lifted to
        // stand proud of the ground, with almost no corruption wash so it stays stone-grey.
        // Clusters come from the placement generator (2-5 cones per cluster).
        geometry: new THREE.ConeGeometry(0.62, 3.2, 5),
        material: this.buildMaterial(0x8c8aa0, 0, 0.06),
        lift: 0.5,
      },
    ];

    for (const group of groups) {
      const placements = options.placements.filter((p) => p.kind === group.kind);
      if (placements.length === 0) continue;

      const geometry = group.geometry;
      const mesh = new THREE.InstancedMesh(geometry, group.material, placements.length);
      mesh.name = `rocks:${group.kind}`;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.castShadow = options.castShadows ?? false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;

      const terrain = new Float32Array(placements.length * 4);
      const veg = new Float32Array(placements.length);
      const matrix = new THREE.Matrix4();
      const scaleVec = new THREE.Vector3();
      for (let i = 0; i < placements.length; i++) {
        const placement = placements[i];
        // Sink rocks a quarter of their size along the surface normal (no pasted-on look);
        // spikes lift instead (see the group comment).
        const offset = (group.lift ?? -0.25) * placement.scale;
        const sunk = placement.position.clone().addScaledVector(placement.direction, offset);
        const stretch = placement.stretch ?? group.yStretch ?? 1;
        scaleVec.set(placement.scale, placement.scale * stretch, placement.scale);
        matrix.compose(sunk, placement.quaternion, scaleVec);
        mesh.setMatrixAt(i, matrix);
        terrain.set(placement.terrain, i * 4);
        veg[i] = placement.vegetation;
      }
      geometry.setAttribute('aTerrain', new THREE.InstancedBufferAttribute(terrain, 4));
      geometry.setAttribute('aVeg', new THREE.InstancedBufferAttribute(veg, 1));
      mesh.instanceMatrix.needsUpdate = true;

      this.meshes.push(mesh);
      this.geometries.push(geometry);
      this.materials.push(group.material);
    }
  }

  private buildMaterial(baseHex: number, emissive: number, vein = 0.3, emissiveHex?: number): MeshDefaultMaterial {
    const baseColor = uniform(new THREE.Color(baseHex));
    const colorNode = weatheredNode(baseColor, vein);
    // `emissiveHex` pins the glow colour (crystals stay purple on every planet); without it the
    // glow rides the planet's vein colour like the rest of the necrotic world.
    const glowColor = emissiveHex !== undefined ? uniform(new THREE.Color(emissiveHex)) : FOLIO.necro.veinColor;
    return new MeshDefaultMaterial({
      colorNode,
      hasWater: false,
      emissiveNode: emissive > 0 ? glowColor.mul(emissive) : undefined,
    });
  }

  setVisible(visible: boolean): void {
    for (const mesh of this.meshes) mesh.visible = visible;
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
    }
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.meshes.length = 0;
  }
}
