// NECROFALL — Materials (plan §8, §9, §53): the ONE material family of the environment.
//
// Folio's Materials.js contract: imported model materials never survive directly — every GLB
// goes through a conversion into the shared `MeshDefaultMaterial` family so the whole world
// shares one lighting / shadow / fog / water-interaction language. This module is the registry
// around that conversion; the conversion itself lives in `NecroVegetationMaterial.ts`
// (`adoptMeshMaterial`, which caches one material per SOURCE material — hundreds of trees, one
// material) and `MeshDefaultMaterial.ts` (the shading model).
//
// Specialized families (terrain, water, sky, crystals) extend the same base and register here so
// a scene-wide material pass (quality, reveal, disposal) has one list to walk.
import * as THREE from 'three/webgpu';
import { adoptMeshMaterial, type AdoptOptions } from './NecroVegetationMaterial';
import type { MeshDefaultMaterial } from './MeshDefaultMaterial';

export class Materials {
  /** Every environment material instance this planet built (debug / disposal). */
  readonly list = new Map<string, THREE.Material>();

  /**
   * Convert an imported GLB material into the shared Folio family, folio-style:
   * geometry and colour are preserved, everything else (lighting, core shadow, drop shadow,
   * fog, water interaction) comes from the family. Repeated calls with the same source material
   * return the SAME instance (the adopt cache).
   */
  createEnvironmentMaterial(source: THREE.Material | THREE.Material[], options: AdoptOptions = {}): MeshDefaultMaterial {
    const material = adoptMeshMaterial(source, options);
    const sourceName = (Array.isArray(source) ? source[0] : source)?.name ?? '';
    const key = material.name || sourceName || 'environment';
    if (!this.list.has(key)) this.list.set(key, material);
    return material;
  }

  /** Register a specialized family member (terrain, water, sky, crystals…). */
  register(name: string, material: THREE.Material): THREE.Material {
    this.list.set(name, material);
    return material;
  }

  /** Debug readout: how many distinct environment materials this world owns. */
  get size(): number {
    return this.list.size;
  }
}
