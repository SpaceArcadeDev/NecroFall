// NECROFALL — Radioactive crystals (plan §24, §25, §79, §96): small bright radioactive accents.
//
//   low-poly Folio silhouette (slender octahedron shards — NOT pyramids)
//   terrain-aligned, rooted, clustered (clusters come from the placement generator)
//   emissive surface + folio bloom — NEVER a dynamic point light
//   GPU-animated: the emission pulses from a shared time uniform (0 crystal material updates
//   on the CPU, plan §79)
//
// The glow colour is PINNED purple (#9a6bff): riding the planet's vein colour tinted them
// green/orange on most worlds, which read as flat coloured pyramids instead of crystals (user
// review 2026-09-30).
import * as THREE from 'three/webgpu';
import { Fn, uniform } from 'three/tsl';
import { FOLIO } from '../FolioShaderGlobals';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { weatheredNode } from '../materials/NecroVegetationMaterial';
import { buildInstancedField } from './InstancedField';
import type { RockPlacement } from '../../world/vegetation/VegetationTypes';

export interface RadioactiveCrystalsOptions {
  placements: RockPlacement[];
  castShadows?: boolean;
}

/** The pinned crystal glow — every planet gets the same purple shards. */
const CRYSTAL_GLOW = 0x9a6bff;
const CRYSTAL_BASE = 0x7a4fd0;
/** Plan §24's emission strength (bright enough to cross the bloom threshold of 1). */
const CRYSTAL_EMISSION = 0.9;

export class RadioactiveCrystals {
  readonly mesh: THREE.Mesh | null = null;
  private readonly material: THREE.Material | null = null;

  constructor(options: RadioactiveCrystalsOptions) {
    const placements = options.placements.filter((placement) => placement.kind === 'CRYSTAL');
    if (placements.length === 0) return;

    const material = this.buildCrystalMaterial();

    const mesh = buildInstancedField({
      name: 'crystals',
      geometry: new THREE.OctahedronGeometry(1, 0),
      material,
      placements,
      castShadows: options.castShadows ?? false,
      yStretch: 2.1,
    });
    if (!mesh) return;

    this.mesh = mesh;
    this.material = material;
  }

  /**
   * The radioactive emission (plan §79): base glow × a slow shared pulse. The pulse is a pure
   * TSL function of `FOLIO.time` — animated entirely on the GPU.
   */
  private buildCrystalMaterial(): MeshDefaultMaterial {
    const baseColor = uniform(new THREE.Color(CRYSTAL_BASE));
    const colorNode = weatheredNode(baseColor, 0.3);
    const glowColor = uniform(new THREE.Color(CRYSTAL_GLOW));

    const emissiveNode = Fn(() => {
      const pulse = FOLIO.time.mul(1.4).sin().mul(0.18).add(1);
      return glowColor.mul(CRYSTAL_EMISSION).mul(pulse);
    })();

    return new MeshDefaultMaterial({
      colorNode,
      hasWater: false,
      emissiveNode,
    });
  }

  setVisible(visible: boolean): void {
    if (this.mesh) this.mesh.visible = visible;
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}
