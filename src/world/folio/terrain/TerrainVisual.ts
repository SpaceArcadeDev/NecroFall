// NECROFALL — TerrainVisual (plan §61): bakes Planet's terrain data into vertex attributes and
// attaches the Folio terrain material. Planet keeps the geometry + analytic field; this module
// owns everything the RENDERER needs, so the visual and the simulation read the same numbers.
//
// Baked attributes (the shader contract, see NecroFallTerrainNode):
//   aTerrain vec4 = (slope, height01, moisture, corruption)
//   aVeg     float = plant density (0..1.6)
import * as THREE from 'three/webgpu';
import { clamp } from '../../../utils/Utils';
import { NecroTerrainMaterial } from '../materials/NecroTerrainMaterial';
import { TERRAIN_PALETTE } from './NecroFallTerrainNode';
import { vegetationPatchAt } from './VegetationPatches';

/** The Planet surface TerrainVisual needs — structural, so Planet stays free to evolve. */
export interface TerrainVisualPlanet {
  readonly radius: number;
  readonly waterLevel: number;
  readonly reliefMin: number;
  readonly reliefMax: number;
  heightAtDir(x: number, y: number, z: number): number;
  /** Planet seed — the vegetation patch field must match the grass texture's bake. */
  readonly seed?: number;
  terrain: {
    moistureAt(x: number, y: number, z: number): number;
    corruptionAt(x: number, y: number, z: number): number;
  };
  biome: { plantDensityAt(x: number, y: number, z: number): number };
  archetype: {
    palette: { deep: number; low: number; mid: number; ridge: number; peak: number; vein: number };
  };
}

export class TerrainVisual {
  readonly material: NecroTerrainMaterial;

  constructor(private readonly planet: TerrainVisualPlanet, geometry: THREE.BufferGeometry) {
    this.bake(geometry);

    // Palette: written once, read by the terrain material and every vegetation material that
    // wants to match the ground (grass blades, canopies, rocks carry the same data per-instance).
    const p = planet.archetype.palette;
    TERRAIN_PALETTE.deep.value.setHex(p.deep);
    TERRAIN_PALETTE.low.value.setHex(p.low);
    TERRAIN_PALETTE.mid.value.setHex(p.mid);
    TERRAIN_PALETTE.ridge.value.setHex(p.ridge);
    TERRAIN_PALETTE.peak.value.setHex(p.peak);
    TERRAIN_PALETTE.vein.value.setHex(p.vein);
    TERRAIN_PALETTE.reliefMin.value = planet.reliefMin;
    TERRAIN_PALETTE.reliefMax.value = planet.reliefMax;
    TERRAIN_PALETTE.waterline01.value = this.height01Of(planet.waterLevel);

    this.material = new NecroTerrainMaterial();
  }

  /** Map a radius to the 0..1 relief band (the same banding the biome ramp uses). */
  height01Of(radiusValue: number): number {
    const span = Math.max(1e-3, this.planet.reliefMax - this.planet.reliefMin);
    return clamp((radiusValue - this.planet.reliefMin) / span, 0, 1);
  }

  /** Bake the shader attribute contract onto the displaced terrain geometry. */
  private bake(geometry: THREE.BufferGeometry): void {
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const nrm = geometry.attributes.normal as THREE.BufferAttribute;
    const count = pos.count;

    const terrain = new Float32Array(count * 4);
    const veg = new Float32Array(count);

    const dir = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      dir.fromBufferAttribute(pos, i);
      const len = Math.max(1e-6, dir.length());
      dir.multiplyScalar(1 / len);

      const h = len;
      const slope = clamp(1 - (nrm.getX(i) * dir.x + nrm.getY(i) * dir.y + nrm.getZ(i) * dir.z), 0, 1);

      terrain[i * 4 + 0] = slope;
      terrain[i * 4 + 1] = this.height01Of(h);
      terrain[i * 4 + 2] = clamp(this.planet.terrain.moistureAt(dir.x, dir.y, dir.z), 0, 1);
      terrain[i * 4 + 3] = clamp(this.planet.terrain.corruptionAt(dir.x, dir.y, dir.z), 0, 1);
      // Patched vegetation (VegetationPatches): lawns in blobs over bare ground — the ground's
      // grass wash and the blades must both read the SAME carved channel (folio's authored
      // density data). The seed matches the grass texture bake exactly.
      veg[i] =
        this.planet.biome.plantDensityAt(dir.x, dir.y, dir.z) *
        vegetationPatchAt(dir.x, dir.y, dir.z, this.planet.seed ?? 0x51ab51);
    }

    geometry.setAttribute('aTerrain', new THREE.BufferAttribute(terrain, 4));
    geometry.setAttribute('aVeg', new THREE.BufferAttribute(veg, 1));
  }

  dispose(): void {
    this.material.dispose();
  }
}
