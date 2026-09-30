/**
 * NECROFALL — toxic puddles (plan §26–§30/§95).
 *
 * Not an ocean: LOCAL water films in terrain depressions. Every puddle disc is
 * conformed to the sphere on the CPU (`terrain surface + 0.035·normal`) and
 * merged into ONE mesh, so water can never float or cut through the ground.
 * Ripples and the contamination sheen are shader-side.
 */
import * as THREE from 'three/webgpu';
import { attribute, color, mix, positionWorld, vec3 } from 'three/tsl';
import { PlanetSurface } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import { scatterPlacements } from '../../planet/Placement';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { RADIOACTIVE_PALETTE } from '../materials/PlanetPalette';

const THETA_SEGMENTS = 40;
const RING_SEGMENTS = 6;

export class Puddles {
  readonly mesh: THREE.Mesh;
  readonly count: number;

  constructor(surface: PlanetSurface, generator: PlanetGenerator, timeUniform: any, spawnClear?: { direction: THREE.Vector3; radius: number }) {
    const sites = scatterPlacements(surface, generator, {
      count: 30,
      salt: 88,
      accept: (sample) => sample.wetness > 0.62 && sample.slope < 0.28,
      scaleMin: 1.6,
      scaleMax: 4.6,
      attemptsPerInstance: 60,
      excludeDirection: spawnClear?.direction,
      excludeRadius: spawnClear?.radius,
    });

    const positions: number[] = [];
    const fades: number[] = [];
    const seeds: number[] = [];
    const indices: number[] = [];
    let vertexBase = 0;

    const tangent = new THREE.Vector3();
    const bitangent = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const random = generator.rand(89);

    for (const site of sites) {
      PlanetSurface.stableTangent(site.normal, tangent);
      bitangent.crossVectors(site.normal, tangent);
      const theta = Math.tan(site.scale / surface.radius);
      const seed = random();

      for (let ring = 0; ring <= RING_SEGMENTS; ring++) {
        const r = ring / RING_SEGMENTS;
        const radius = Math.max(0.02, r) * theta;
        for (let segment = 0; segment <= THETA_SEGMENTS; segment++) {
          const angle = (segment / THETA_SEGMENTS) * Math.PI * 2;
          const x = Math.cos(angle) * radius;
          const z = Math.sin(angle) * radius;

          direction.copy(site.normal).addScaledVector(tangent, x).addScaledVector(bitangent, z).normalize();
          const groundRadius = generator.radiusAt(direction.x, direction.y, direction.z);
          const waterRadius = groundRadius + 0.035;

          positions.push(direction.x * waterRadius, direction.y * waterRadius, direction.z * waterRadius);
          // shore fade: 1 at the puddle centre → 0 at the rim
          fades.push(1 - Math.pow(r, 1.6));
          seeds.push(seed);
        }
      }

      const stride = THETA_SEGMENTS + 1;
      for (let ring = 0; ring < RING_SEGMENTS; ring++) {
        for (let segment = 0; segment < THETA_SEGMENTS; segment++) {
          const a = vertexBase + ring * stride + segment;
          const b = a + 1;
          const c = a + stride;
          const d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
      vertexBase += (RING_SEGMENTS + 1) * stride;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('puddleFade', new THREE.BufferAttribute(new Float32Array(fades), 1));
    geometry.setAttribute('puddleSeed', new THREE.BufferAttribute(new Float32Array(seeds), 1));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();

    // ---- water shading: quiet dark base, lighter shore ring, ripple sheen
    const fade = attribute('puddleFade') as any;
    const seedAttribute = attribute('puddleSeed') as any;

    const colorNode = (() => {
      const rippleA = positionWorld
        .length()
        .mul(3.4)
        .sub(timeUniform.mul(1.4))
        .add(seedAttribute.mul(6.283))
        .sin();
      const rippleB = positionWorld
        .length()
        .mul(7.3)
        .add(timeUniform.mul(2.1))
        .add(seedAttribute.mul(3.14))
        .sin();

      const base = mix(color(RADIOACTIVE_PALETTE.waterDark), color(RADIOACTIVE_PALETTE.water), rippleA.mul(0.5).add(0.5).mul(0.4));
      const shore = fade.oneMinus().mul(0.4);
      const withShore = mix(base, color(RADIOACTIVE_PALETTE.waterLight), shore);
      // subtle radioactive contamination sheen (mostly kept under the bloom threshold)
      const sheen = rippleB.max(0).pow(3).mul(0.24);
      return withShore.add(vec3(sheen.mul(0.35), sheen, sheen.mul(0.6)));
    })();

    const material = new MeshDefaultMaterial({
      colorNode,
      alphaNode: fade.mul(0.94),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      hasLightBounce: false,
      hasFog: true,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'puddles';
    this.count = sites.length;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
