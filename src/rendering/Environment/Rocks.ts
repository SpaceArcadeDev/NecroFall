/**
 * NECROFALL — rocks (plan §22/§76).
 *
 * Three jittered low-poly variants, each ONE InstancedMesh, terrain aligned,
 * palette shaded. Decorative only — physics gets rocks exclusively where
 * gameplay needs them (none today).
 */
import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import type { PlanetSurface } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import { scatterPlacements } from '../../planet/Placement';
import type { PlanetObstacles } from '../../planet/PlanetObstacles';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { mulberry32 } from '../../planet/PlanetSeed';
import { RADIOACTIVE_PALETTE } from '../materials/PlanetPalette';

interface RockVariant {
  color: string;
  count: number;
  salt: number;
  scaleMin: number;
  scaleMax: number;
  stretch: number;
}

const VARIANTS: RockVariant[] = [
  { color: RADIOACTIVE_PALETTE.rock, count: 260, salt: 121, scaleMin: 0.35, scaleMax: 1.15, stretch: 0.72 },
  { color: RADIOACTIVE_PALETTE.rockDark, count: 170, salt: 122, scaleMin: 0.5, scaleMax: 1.7, stretch: 0.85 },
  { color: RADIOACTIVE_PALETTE.rockLight, count: 120, salt: 123, scaleMin: 0.28, scaleMax: 0.85, stretch: 0.6 },
];

export class Rocks {
  readonly group = new THREE.Group();
  readonly count: number;

  constructor(
    surface: PlanetSurface,
    generator: PlanetGenerator,
    spawnClear?: { direction: THREE.Vector3; radius: number },
    obstacles?: PlanetObstacles,
  ) {
    let total = 0;
    for (const variant of VARIANTS) {
      const geometry = Rocks.createGeometry(variant.salt, variant.stretch);
      const material = new MeshDefaultMaterial({
        colorNode: color(variant.color),
        hasLightBounce: true,
        hasFog: true,
      });
      (material as any).flatShading = true;

      const placements = scatterPlacements(surface, generator, {
        count: variant.count,
        salt: variant.salt,
        aboveWater: -1.4,
        scaleMin: variant.scaleMin,
        scaleMax: variant.scaleMax,
        sinkFactor: 0.14,
        attemptsPerInstance: 6,
        excludeDirection: spawnClear?.direction,
        excludeRadius: spawnClear?.radius,
      });

      for (const placement of placements) obstacles?.add(placement, 0.9 * placement.scale, 0.85 * placement.scale, true);

      const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, placements.length));
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.castShadow = variant !== VARIANTS[2];
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      for (let i = 0; i < placements.length; i++) mesh.setMatrixAt(i, placements[i].matrix);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.name = `rocks${variant.salt}`;
      this.group.add(mesh);
      total += placements.length;
    }
    this.count = total;
  }

  /** Low-poly boulder: icosahedron with per-position radial jitter + flatten. */
  private static createGeometry(seed: number, stretch: number): THREE.BufferGeometry {
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const array = position.array as Float32Array;

    for (let i = 0; i < array.length; i += 3) {
      const x = array[i];
      const y = array[i + 1];
      const z = array[i + 2];
      // hash the POSITION so shared vertices jitter identically (no cracks)
      const h = mulberry32(
        seed ^
          Math.imul(Math.round(x * 1000) | 0, 374761393) ^
          Math.imul(Math.round(y * 1000) | 0, 668265263) ^
          Math.imul(Math.round(z * 1000) | 0, 1442695041),
      )();
      const scale = 1 + (h - 0.5) * 0.55;
      array[i] = x * scale;
      array[i + 1] = y * scale * stretch;
      array[i + 2] = z * scale;
    }

    geometry.computeVertexNormals();
    return geometry;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.group.traverse((object: any) => {
      if (object.isInstancedMesh) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
  }
}
