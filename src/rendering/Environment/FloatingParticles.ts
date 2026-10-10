/**
 * NECROFALL — floating contamination (plan §31/§32/§80).
 *
 * ONE draw of camera-facing BILLBOARDS with a soft circular alpha mask — the
 * motes read as round spores, never squares. Origins are baked ONCE across the
 * WHOLE PLANET and stay fixed in the world (planet-anchored — the field never
 * rides the player and never runs out: contamination is everywhere); ALL
 * motion (drift, bob, wind, fade) is shader-side.
 */
import * as THREE from 'three/webgpu';
import { attribute, color, Fn, mix, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import type { PlanetSurface } from '../../planet/PlanetSurface';
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
    blocked?: (positionX: number, positionY: number, positionZ: number) => boolean,
  ) {
    this.uTime = timeUniform;
    const random = generator.rand(133);
    // sparse drifting spores, present EVERYWHERE — never a fog of orbs
    const count = Math.max(800, Math.round(6000 * quality.particleMultiplier()));
    let placed = 0;

    const centers = new Float32Array(count * 6 * 3);
    const corners = new Float32Array(count * 6 * 2);
    const seeds = new Float32Array(count * 6);
    const positions = new Float32Array(count * 6 * 3);

    const direction = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      // uniform direction over the WHOLE planet — motes exist everywhere
      const z = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      direction.set(r * Math.cos(a), z, r * Math.sin(a));
      const height = 0.35 + random() * 26; // 0.35–26.35 m: motes drift in a TALL column (user ask: "spread more vertically" — raised twice)
      const radius = generator.radiusAt(direction.x, direction.y, direction.z) + height;
      const px = direction.x * radius;
      const py = direction.y * radius;
      const pz = direction.z * radius;
      const seed = random();
      const size = 0.09 + random() * 0.16;
      if (blocked?.(px, py, pz)) continue;

      for (let v = 0; v < 6; v++) {
        const index = (placed * 6 + v) * 3;
        centers[index] = px;
        centers[index + 1] = py;
        centers[index + 2] = pz;
        positions[index] = px;
        positions[index + 1] = py;
        positions[index + 2] = pz;
        corners[(placed * 6 + v) * 2] = CORNERS[v][0];
        corners[(placed * 6 + v) * 2 + 1] = CORNERS[v][1];
        seeds[placed * 6 + v] = seed + size * 7; // pack size variance into the seed channel
      }
      placed++;
    }

    this.count = placed;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, placed * 18), 3));
    geometry.setAttribute('aCenter', new THREE.BufferAttribute(centers.subarray(0, placed * 18), 3));
    geometry.setAttribute('aCorner', new THREE.BufferAttribute(corners.subarray(0, placed * 12), 2));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds.subarray(0, placed * 6), 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2000);

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
    ).mul(0.6) as any;

    material.positionNode = Fn(() => {
      const sway = wind.offsetNode(centerAttribute.xz) as any;
      const drift = vec3(
        sin(this.uTime.mul(0.31).add(seedAttribute.mul(17.3))).mul(1.5).add(sway.x.mul(2.4)),
        // a livelier vertical bob so the column reads as drifting altitudinally, not a flat sheet
        sin(this.uTime.mul(0.43).add(seedAttribute.mul(29.1))).mul(1.7),
        sin(this.uTime.mul(0.27).add(seedAttribute.mul(11.7))).mul(1.5).add(sway.y.mul(2.4)),
      );
      // size rides the low bits of the seed channel (0.07..0.19 m)
      const size = seedAttribute.fract().mul(0.12).add(0.07);
      return centerAttribute
        .add(drift)
        .add(this.uCamRight.mul(cornerAttribute.x.mul(size)))
        .add(this.uCamUp.mul(cornerAttribute.y.mul(size)));
    })() as any;

    // soft circular mask + slow personal pulse — spores, not squares
    material.opacityNode = (() => {
      const radius = cornerAttribute.length();
      const circle = smoothstep(0.2, 1.0, radius).oneMinus();
      const pulse = sin(this.uTime.mul(0.9).add(seedAttribute.mul(31.0))).mul(0.18).add(0.5);
      return circle.mul(pulse) as any;
    })();

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'floatingParticles';
    this.group.add(this.mesh);
  }

  /**
   * Planet-anchored: only the billboard AXES follow the camera — positions are
   * fixed in the world and never reposition with the player.
   */
  update(_focusPoint: THREE.Vector3, camera?: THREE.Camera): void {
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
