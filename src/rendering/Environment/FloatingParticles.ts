/**
 * NECROFALL — floating contamination (plan §31/§32/§80).
 *
 * ONE draw of camera-facing BILLBOARDS with a soft circular alpha mask — the
 * motes read as round spores, never squares. Origins are baked around the
 * player's spawn; ALL motion (drift, bob, wind, fade) is shader-side and the
 * whole bubble follows the player. No per-particle JavaScript.
 */
import * as THREE from 'three/webgpu';
import { attribute, color, Fn, mix, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import { PlanetSurface } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import type { Quality } from '../Quality';
import type { Wind } from './Wind';
import { RADIOACTIVE_PALETTE } from '../materials/PlanetPalette';

const CORNERS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

export class FloatingParticles {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly count: number;

  private readonly uTime: any;
  private readonly uCamRight = uniform(new THREE.Vector3(1, 0, 0));
  private readonly uCamUp = uniform(new THREE.Vector3(0, 1, 0));

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
    const count = Math.max(40, Math.round(340 * quality.particleMultiplier()));
    this.count = count;

    const tangent = new THREE.Vector3();
    const bitangent = new THREE.Vector3();
    PlanetSurface.stableTangent(spawnDirection, tangent);
    bitangent.crossVectors(spawnDirection, tangent);

    // The bubble's local origin = the spawn surface point (the group rides it).
    const origin = new THREE.Vector3().copy(spawnDirection).multiplyScalar(
      generator.radiusAt(spawnDirection.x, spawnDirection.y, spawnDirection.z),
    );

    const centers = new Float32Array(count * 6 * 3);
    const corners = new Float32Array(count * 6 * 2);
    const seeds = new Float32Array(count * 6);
    const positions = new Float32Array(count * 6 * 3);

    const direction = new THREE.Vector3();
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
      local.copy(direction).multiplyScalar(radius + height).sub(origin);
      const seed = random();
      const size = 0.09 + random() * 0.16;

      for (let v = 0; v < 6; v++) {
        const index = (i * 6 + v) * 3;
        centers[index] = local.x;
        centers[index + 1] = local.y;
        centers[index + 2] = local.z;
        positions[index] = local.x;
        positions[index + 1] = local.y;
        positions[index + 2] = local.z;
        corners[(i * 6 + v) * 2] = CORNERS[v][0];
        corners[(i * 6 + v) * 2 + 1] = CORNERS[v][1];
        seeds[i * 6 + v] = seed + size * 7; // pack size variance into the seed channel
      }
    }

    this.group.position.copy(origin);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aCenter', new THREE.BufferAttribute(centers, 3));
    geometry.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 80);

    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;

    const centerAttribute = attribute('aCenter') as any;
    const cornerAttribute = attribute('aCorner') as any;
    const seedAttribute = attribute('aSeed') as any;

    material.colorNode = mix(
      color(RADIOACTIVE_PALETTE.radioactive3),
      color(RADIOACTIVE_PALETTE.radioactive2),
      seedAttribute.fract(),
    ).mul(0.75) as any;

    material.positionNode = Fn(() => {
      const sway = wind.offsetNode(centerAttribute.xz) as any;
      const drift = vec3(
        sin(this.uTime.mul(0.31).add(seedAttribute.mul(17.3))).mul(1.5).add(sway.x.mul(2.4)),
        sin(this.uTime.mul(0.43).add(seedAttribute.mul(29.1))).mul(0.75),
        sin(this.uTime.mul(0.27).add(seedAttribute.mul(11.7))).mul(1.5).add(sway.y.mul(2.4)),
      );
      // size rides the low bits of the seed channel (0.09..0.25 m)
      const size = seedAttribute.fract().mul(0.16).add(0.09);
      return centerAttribute
        .add(drift)
        .add(this.uCamRight.mul(cornerAttribute.x.mul(size)))
        .add(this.uCamUp.mul(cornerAttribute.y.mul(size)));
    })() as any;

    // soft circular mask + slow personal pulse — spores, not squares
    material.opacityNode = (() => {
      const radius = cornerAttribute.length();
      const circle = smoothstep(1.0, 0.2, radius);
      const pulse = sin(this.uTime.mul(0.9).add(seedAttribute.mul(31.0))).mul(0.18).add(0.5);
      return circle.mul(pulse) as any;
    })();

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'floatingParticles';
    this.group.add(this.mesh);
  }

  /** The bubble rides the player; billboard axes follow the camera. */
  update(focusPoint: THREE.Vector3, camera?: THREE.Camera): void {
    this.group.position.copy(focusPoint);
    if (camera) {
      const elements = camera.matrixWorld.elements;
      this.uCamRight.value.set(elements[0], elements[1], elements[2]);
      this.uCamUp.value.set(elements[4], elements[5], elements[6]);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
