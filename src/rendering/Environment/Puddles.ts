/**
 * NECROFALL — basin water (folio `World/WaterSurface.js` port, plan §26–§30).
 *
 * WATER FILLS BASINS, not circles: every patch is placed on an analytic
 * depression found by probing spokes around a candidate direction, filled to a
 * flat water level below the rim, and conformed to the terrain (flat inside
 * the basin, hugging the ground at the shore).
 *
 * The surface itself ports folio's technique 1:1 — the water is a BLURRED
 * SCREEN MIRROR (viewportSharedTexture + hashBlur) with white foam details
 * (shore line + wind ripple rings), blended in only where the ground sits
 * under the water level (deep → pure mirror, shore → foam).
 */
import * as THREE from 'three/webgpu';
import {
  attribute,
  color,
  Fn,
  max,
  mix,
  positionWorld,
  screenUV,
  select,
  sin,
  smoothstep,
  texture,
  uniform,
  varying,
  vec3,
  vec4,
  viewportSharedTexture,
} from 'three/tsl';
import { hashBlur } from 'three/addons/tsl/display/hashBlur.js';
import { PlanetSurface, createSurfaceSample } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import type { Noises } from './Noises';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';

const THETA_SEGMENTS = 44;
const RING_SEGMENTS = 7;
const RIM_RADII = [1.8, 2.8, 4.0, 5.6];
const SPOKES = 8;
const MIN_RIM_DROP = 0.22; // metres — the centre must sit this far below its rim
const TARGET_SITES = 120;
const MAX_ATTEMPTS = 9000;

interface BasinSite {
  direction: THREE.Vector3;
  /** Patch radius in metres (the probed rim radius). */
  radius: number;
  /** Water surface as a RADIUS from the planet centre (flat locally). */
  waterLevel: number;
  seed: number;
}

export class Puddles {
  readonly mesh: THREE.Mesh;
  readonly count: number;

  constructor(
    private readonly surface: PlanetSurface,
    private readonly generator: PlanetGenerator,
    noises: Noises,
    timeUniform: any,
    spawnClear?: { direction: THREE.Vector3; radius: number },
  ) {
    const sites = this.findBasins(spawnClear);
    this.count = sites.length;

    // ---------------------------------------------------------------- geometry
    const positions: number[] = [];
    const depths: number[] = [];
    const rings: number[] = [];
    const seeds: number[] = [];
    const indices: number[] = [];
    let vertexBase = 0;

    const tangent = new THREE.Vector3();
    const bitangent = new THREE.Vector3();
    const direction = new THREE.Vector3();

    for (const site of sites) {
      PlanetSurface.stableTangent(site.direction, tangent);
      bitangent.crossVectors(site.direction, tangent);
      const theta = Math.tan(site.radius / this.surface.radius);

      for (let ring = 0; ring <= RING_SEGMENTS; ring++) {
        const r = ring / RING_SEGMENTS;
        const radius = Math.max(0.02, r) * theta;
        for (let segment = 0; segment <= THETA_SEGMENTS; segment++) {
          const angle = (segment / THETA_SEGMENTS) * Math.PI * 2;
          direction
            .copy(site.direction)
            .addScaledVector(tangent, Math.cos(angle) * radius)
            .addScaledVector(bitangent, Math.sin(angle) * radius)
            .normalize();

          const terrainRadius = this.generator.radiusAt(direction.x, direction.y, direction.z);
          const depth = site.waterLevel - terrainRadius;
          // flat inside the basin, hugging the terrain above the waterline
          const surfaceRadius = depth > 0 ? site.waterLevel : terrainRadius + 0.035;

          positions.push(direction.x * surfaceRadius, direction.y * surfaceRadius, direction.z * surfaceRadius);
          depths.push(depth);
          rings.push(r);
          seeds.push(site.seed);
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
    geometry.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(depths), 1));
    geometry.setAttribute('aRing', new THREE.BufferAttribute(new Float32Array(rings), 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(seeds), 1));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();

    // ---------------------------------------------------------------- folio water
    const depth: any = varying(attribute('aDepth') as any);
    const ring: any = varying(attribute('aRing') as any);
    const seed: any = varying(attribute('aSeed') as any);

    // shore foam + wind ripple rings (folio's details mask)
    const detailsMask = (() => {
      const shore = smoothstep(0.18, 0.02, depth);
      const noise = texture(noises.perlin, positionWorld.xz.mul(0.35)).r;
      const rippleBand = sin(depth.mul(16).sub(timeUniform.mul(0.55)).add(noise.mul(6.283)));
      const ripple = smoothstep(0.87, 1.0, rippleBand).mul(smoothstep(0.05, 0.4, depth));
      return max(shore, ripple) as any;
    })();

    const material = new MeshDefaultMaterial({
      // folio: the detail pass is the foam — tinted here so bloom never blows it out
      colorNode: mix(color(0xffffff), color(0x9fd8cc), 0.4) as any,
      alphaNode: detailsMask,
      alphaTest: 0,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
      hasCoreShadows: false,
      hasDropShadows: true,
      hasLightBounce: false,
      hasFog: true,
    });

    // folio's output override: where the detail mask is quiet the surface shows
    // the BLURRED SCREEN behind it (the mirror); wet pixels replace it, dry
    // pixels vanish entirely.
    const baseOutput = (material as any).outputNode as any;
    (material as any).outputNode = Fn(() => {
      const blurOutput = (hashBlur as any)(viewportSharedTexture(screenUV), floatLike(0.012), {
        repeats: 25,
        premultipliedAlpha: true,
      });
      // contaminated tint over the screen mirror (radioactive puddle water)
      const mirrored = mix(blurOutput.rgb, vec3(0.06, 0.24, 0.25), 0.38);
      const wet = smoothstep(-0.06, 0.02, depth).mul(smoothstep(1.0, 0.84, ring));
      const surface = baseOutput.a.greaterThan(0.5);
      const rgb = select(surface, baseOutput.rgb, mirrored);
      return vec4(rgb, wet.mul(0.97));
    })();

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'puddles';
  }

  /**
   * Analytic basin search: a candidate is a basin when EVERY spoke at a rim
   * radius sits at least MIN_RIM_DROP above the centre — i.e. the terrain
   * actually holds water there. Sites keep a minimum separation.
   */
  private findBasins(spawnClear?: { direction: THREE.Vector3; radius: number }): BasinSite[] {
    const sites: BasinSite[] = [];
    const random = this.generator.rand(88);
    const sample = createSurfaceSample();
    const direction = new THREE.Vector3();
    const probe = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const bitangent = new THREE.Vector3();

    for (let attempt = 0; attempt < MAX_ATTEMPTS && sites.length < TARGET_SITES; attempt++) {
      // deterministic direction
      const z = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      direction.set(r * Math.cos(a), z, r * Math.sin(a));

      if (spawnClear && direction.dot(spawnClear.direction) > Math.cos(spawnClear.radius / this.surface.radius)) {
        continue;
      }

      this.surface.sample(direction, sample);
      if (sample.slope > 0.34) continue;
      if (sample.wetness < 0.22 && sample.radiation < 0.4) continue; // humid or contaminated ground only

      const centreRadius = sample.radius;
      let found: { radius: number; rimMin: number } | null = null;

      PlanetSurface.stableTangent(direction, tangent);
      bitangent.crossVectors(direction, tangent);

      for (const rimRadius of RIM_RADII) {
        const theta = rimRadius / this.surface.radius;
        let rimMin = Infinity;
        for (let s = 0; s < SPOKES; s++) {
          const angle = (s / SPOKES) * Math.PI * 2;
          probe
            .copy(direction)
            .addScaledVector(tangent, Math.cos(angle) * theta)
            .addScaledVector(bitangent, Math.sin(angle) * theta)
            .normalize();
          const height = this.generator.radiusAt(probe.x, probe.y, probe.z);
          if (height < rimMin) rimMin = height;
        }
        if (rimMin - centreRadius > MIN_RIM_DROP) {
          found = { radius: rimRadius, rimMin };
          break;
        }
      }
      if (!found) continue;

      // minimum separation
      let tooClose = false;
      for (const other of sites) {
        const separation = (found.radius + other.radius + 0.6) / this.surface.radius;
        if (other.direction.dot(direction) > Math.cos(separation)) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const fill = Math.min((found.rimMin - centreRadius) * 0.7, 0.85);
      sites.push({
        direction: direction.clone(),
        radius: found.radius,
        waterLevel: centreRadius + Math.max(0.12, fill),
        seed: random(),
      });
    }

    // rebuild probe basis lazily inside the loop above (stable tangent per candidate)
    return sites;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Small helper so hashBlur receives a node-friendly scalar. */
function floatLike(value: number): any {
  return uniform(value);
}
