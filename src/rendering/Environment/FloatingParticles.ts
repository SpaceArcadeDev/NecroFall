/**
 * NECROFALL — floating contamination (plan §31/§32/§80).
 *
 * ONE instanced field of tiny radioactive motes. Origins are baked around the
 * player's spawn point; ALL motion (drift, bob, wind, fade) is shader-side and
 * the whole bubble follows the player's position — no per-particle JavaScript.
 */
import * as THREE from 'three/webgpu';
import {
  attribute,
  color,
  Fn,
  mix,
  positionLocal,
  sin,
  uniform,
  vec3,
} from 'three/tsl';
import { PlanetSurface } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import type { Quality } from '../Quality';
import type { Wind } from './Wind';
import { RADIOACTIVE_PALETTE } from '../materials/PlanetPalette';

export class FloatingParticles {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  readonly count: number;

  private readonly uTime: any;
  private readonly uOpacity = uniform(0.5);

  constructor(
    surface: PlanetSurface,
    generator: PlanetGenerator,
    timeUniform: any,
    quality: Quality,
    wind: Wind,
    spawnDirection: THREE.Vector3,
  ) {
    this.uTime = timeUniform;
    const random = generator.rand(133);
    const count = Math.max(40, Math.round(300 * quality.particleMultiplier()));
    this.count = count;

    const tangent = new THREE.Vector3();
    const bitangent = new THREE.Vector3();
    PlanetSurface.stableTangent(spawnDirection, tangent);
    bitangent.crossVectors(spawnDirection, tangent);

    const dummy = new THREE.Object3D();
    const direction = new THREE.Vector3();
    const samplePoint = new THREE.Vector3();
    const seeds = new Float32Array(count);
    const matrices: THREE.Matrix4[] = [];

    // The bubble's local origin = the spawn surface point.
    PlanetSurface.stableTangent(spawnDirection, tangent);
    samplePoint.set(0, 0, 0);
    {
      const radius = generator.radiusAt(spawnDirection.x, spawnDirection.y, spawnDirection.z);
      samplePoint.copy(spawnDirection).multiplyScalar(radius);
    }

    const local = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const dx = (random() - 0.5) * 0.5;
      const dz = (random() - 0.5) * 0.5;
      direction
        .copy(spawnDirection)
        .addScaledVector(tangent, dx)
        .addScaledVector(bitangent, dz)
        .normalize();
      const height = 0.35 + random() * 9.5;
      const radius = generator.radiusAt(direction.x, direction.y, direction.z);
      local
        .copy(direction)
        .multiplyScalar(radius + height)
        .sub(samplePoint);

      const scale = 0.05 + random() * 0.1;
      dummy.position.copy(local);
      dummy.scale.setScalar(scale);
      dummy.rotation.set(0, random() * Math.PI * 2, 0);
      dummy.updateMatrix();
      matrices.push(dummy.matrix.clone());
      seeds[i] = random();
    }

    this.group.position.copy(samplePoint);

    const geometry = new THREE.OctahedronGeometry(1, 0);
    geometry.setAttribute('particleSeed', new THREE.InstancedBufferAttribute(seeds, 1));

    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;

    const seedAttribute = attribute('particleSeed') as any;

    material.colorNode = mix(
      color(RADIOACTIVE_PALETTE.radioactive3),
      color(RADIOACTIVE_PALETTE.radioactive2),
      seedAttribute,
    ).mul(0.85) as any;

    const drift = Fn(() => {
      const sway = wind.offsetNode(positionLocal.xz) as any;
      const x = sin(this.uTime.mul(0.31).add(seedAttribute.mul(17.3))).mul(1.5).add(sway.x.mul(2.4));
      const y = sin(this.uTime.mul(0.43).add(seedAttribute.mul(29.1))).mul(0.75);
      const z = sin(this.uTime.mul(0.27).add(seedAttribute.mul(11.7))).mul(1.5).add(sway.y.mul(2.4));
      return positionLocal.add(vec3(x, y, z));
    });
    material.positionNode = Fn(() => drift() as any)() as any;

    material.opacityNode = sin(this.uTime.mul(0.8).add(seedAttribute.mul(31.0)))
      .mul(0.16)
      .add(0.42)
      .mul(this.uOpacity) as any;

    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'floatingParticles';
    for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, matrices[i]);
    this.mesh.instanceMatrix.needsUpdate = true;

    this.group.add(this.mesh);
  }

  /** The bubble rides the player's surface position (no per-particle updates). */
  update(focusPoint: THREE.Vector3): void {
    this.group.position.copy(focusPoint);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
