// NECROFALL — Flowers (plan §16): Folio's `Flowers`, ported from
// folio-2025/sources/Game/World/Flowers.js (MIT, Bruno Simon).
//
// Folio's architecture: one merged geometry (8 tilted planes), one MeshDefaultMaterial, a custom
// instance matrix attribute, wind in the vertex stage. NecroFall proceduralises the cluster
// centre (the Folio `flowersReferences` informs cluster size/count) and adds a per-instance tint
// attribute so a field of flowers varies like the reference's seeded palette.
import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  instance,
  positionLocal,
  uniform,
  vec3,
  float,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rand } from '../../utils/Utils';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { FOLIO } from '../FolioShaderGlobals';
import { terrainDataNode, TERRAIN_PALETTE } from './PlanetTerrainNodes';
import type { FlowerPlacement } from '../../world/vegetation/VegetationTypes';

export interface FlowersOptions {
  /** Folio flowersReferences scene — informs cluster shape/size. */
  references?: THREE.Object3D;
  placements: FlowerPlacement[];
  /** Per-instance tint jitter (deterministic). */
  baseColor?: string;
  tintA?: string;
  tintB?: string;
}

export class Flowers {
  readonly mesh: THREE.Mesh;
  readonly material: MeshDefaultMaterial;

  private readonly geometry: THREE.BufferGeometry;
  private readonly instanceMatrix: THREE.InstancedBufferAttribute;

  constructor(options: FlowersOptions) {
    const placements = options.placements;
    const rng = new Rand(0xf10a2e5);

    // --- cluster transforms: 3-9 flowers per placement, deterministic jitter (Folio's clusterCount)
    const transforms: THREE.Matrix4[] = [];
    const tints = new Float32Array(Math.max(1, placements.length * 9) * 3);
    const terrain: number[] = [];
    const veg: number[] = [];

    const colorA = new THREE.Color(options.tintA ?? '#e6d1ff');
    const colorB = new THREE.Color(options.tintB ?? '#ffd9f2');
    const color = new THREE.Color();
    const offset = new THREE.Vector3();
    const up = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const bitangent = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    let flowerIndex = 0;

    for (const placement of placements) {
      const clusterCount = 3 + Math.floor(rng.next() * 6);

      // local tangent frame for the cluster spread
      up.copy(placement.direction).normalize();
      tangent.set(up.y > 0.9 ? 1 : 0, up.y > 0.9 ? 0 : 1, 0).cross(up).normalize();
      bitangent.crossVectors(up, tangent);

      for (let j = 0; j < clusterCount; j++) {
        const angle = rng.range(0, Math.PI * 2);
        const radius = Math.sqrt(rng.next()) * 1.4 * placement.scale;
        offset
          .copy(placement.position)
          .addScaledVector(tangent, Math.cos(angle) * radius)
          .addScaledVector(bitangent, Math.sin(angle) * radius);

        const scale = placement.scale * rng.range(0.6, 1.0);
        quaternion.copy(placement.quaternion);

        const matrix = new THREE.Matrix4().compose(offset, quaternion, new THREE.Vector3(scale, scale, scale));
        transforms.push(matrix);

        color.copy(colorA).lerp(colorB, rng.next());
        tints[flowerIndex * 3] = color.r;
        tints[flowerIndex * 3 + 1] = color.g;
        tints[flowerIndex * 3 + 2] = color.b;

        terrain.push(...placement.terrain);
        veg.push(placement.vegetation);
        flowerIndex++;
      }
    }

    this.geometry = this.buildGeometry();
    this.instanceMatrix = new THREE.InstancedBufferAttribute(
      new Float32Array(Math.max(1, transforms.length) * 16),
      16,
    );
    this.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    transforms.forEach((matrix, i) => matrix.toArray(this.instanceMatrix.array as Float32Array, i * 16));

    this.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints.subarray(0, flowerIndex * 3), 3));
    this.geometry.setAttribute('aTerrain', new THREE.InstancedBufferAttribute(new Float32Array(terrain), 4));
    this.geometry.setAttribute('aVeg', new THREE.InstancedBufferAttribute(new Float32Array(veg), 1));

    this.material = this.buildMaterial(flowerIndex);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'flowers';
    this.mesh.count = flowerIndex;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  /** Folio's flower cluster: 8 small planes tilted around a point, merged. */
  private buildGeometry(): THREE.BufferGeometry {
    const rng = new Rand(0x5eed0f10);
    const planes: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 8; i++) {
      const plane = new THREE.PlaneGeometry(0.08, 0.08);

      const spherical = new THREE.Spherical(1, Math.PI * 0.2 * rng.next(), Math.PI * 2 * rng.next());
      const direction = new THREE.Vector3().setFromSpherical(spherical);
      const position = direction.clone().setLength(1 + (rng.next() - 0.5) * 0.5);
      position.y -= 0.75;

      const matrix = new THREE.Matrix4();
      matrix.lookAt(direction, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
      matrix.setPosition(position);
      matrix.scale(new THREE.Vector3(1, 1, 1).setScalar(1 + (rng.next() - 0.5)));
      plane.applyMatrix4(matrix);

      planes.push(plane);
    }
    const merged = mergeGeometries(planes);
    merged.deleteAttribute('uv');
    return merged;
  }

  private buildMaterial(count: number): MeshDefaultMaterial {
    const baseColor = uniform(new THREE.Color('#ffffff'));
    const tint = attribute('aTint', 'vec3') as any;

    const material = new MeshDefaultMaterial({
      side: THREE.DoubleSide,
      colorNode: baseColor.mul(tint).mul(1),
      hasWater: false,
    });

    // Received-shadow offset (Folio) + wind sway on the flower heads.
    (material as any).receivedShadowPositionNode = positionLocal.add(
      FOLIO.lighting.direction.mul(0.25),
    );

    const wind = FOLIO.wind.offset(positionLocal.xz) as any;
    const multiplier = positionLocal.y.clamp(0, 1).mul(1);

    material.positionNode = Fn(() => {
      (instance(Math.max(1, count), this.instanceMatrix) as any).toStack();
      return positionLocal.add(vec3(wind.x, float(0), wind.y).mul(multiplier));
    })();

    return material;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

// Referenced by the shared corruption wash path (kept for parity with foliage materials).
export const _flowerCorruptionWash = (colorNode: any): any =>
  colorNode.mix(TERRAIN_PALETTE.vein, terrainDataNode().w.mul(0.3));
