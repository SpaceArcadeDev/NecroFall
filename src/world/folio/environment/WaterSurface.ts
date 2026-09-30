// NECROFALL — WaterSurface (plan §19/§20): Folio's local-patch water, curved onto the planet.
//
// Folio renders a single moving water plane around the view centre with shader-based ripples and
// splashes — never a world-sized surface. NecroFall keeps that architecture:
//
//   • ONE patch mesh (a subdivided grid) that follows the camera's focus along the surface;
//   • a small local depth map (waterDepth − terrain) regenerated only when the patch recenters,
//     standing in for Folio's terrainData texture;
//   • TSL ripple/splash/shore treatment in MeshDefaultMaterial's family;
//   • the whole patch vanishes when the planet has no basins below the waterline.
//
// Water is ANALYTICAL gameplay-wise (plan §21): patches are visuals; depth queries go through
// WaterInteraction.
import * as THREE from 'three/webgpu';
import {
  Fn,
  color,
  float,
  mix,
  mx_noise_float,
  positionLocal,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { tangentBasis } from '../../../utils/Utils';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { FOLIO } from '../FolioShaderGlobals';
import type { TerrainSurface } from '../../TerrainSurface';

export interface WaterSurfaceOptions {
  surface: TerrainSurface;
  /** Patch size in metres (plan §20: local patches, never planet-sized). */
  patchSize?: number;
  /** Depth-map resolution. */
  resolution?: number;
  /** Quality multiplier on ripple detail (0..1). */
  quality?: number;
}

const DEPTH_FADE = 0.45;

export class WaterSurface {
  readonly mesh: THREE.Mesh;
  readonly material: MeshDefaultMaterial;
  /** True when the planet actually has submerged basins (mesh hides otherwise). */
  hasWater = false;

  private readonly patchSize: number;
  private readonly resolution: number;
  private readonly depthData: Float32Array;
  private readonly depthTexture: THREE.DataTexture;

  private readonly center = uniform(new THREE.Vector3(0, 1, 0));
  private readonly tangent = uniform(new THREE.Vector3(1, 0, 0));
  private readonly bitangent = uniform(new THREE.Vector3(0, 0, 1));
  private readonly waterRadius = uniform(0);
  private readonly timeUniform = FOLIO.time;

  private lastFocus = new THREE.Vector3(Infinity, Infinity, Infinity);

  constructor(private readonly options: WaterSurfaceOptions) {
    const surface = options.surface;
    this.patchSize = options.patchSize ?? 96;
    this.resolution = options.resolution ?? 64;
    this.depthData = new Float32Array(this.resolution * this.resolution);

    // HalfFloat, on purpose: float32 colour textures sample with nearest on devices without the
    // WebGPU `float32-filterable` feature, which silently zeroed the depth map — and a zeroed
    // depth map is invisible water (live review 2026-09-30: "no water"). fp16 filters everywhere.
    this.depthTexture = new THREE.DataTexture(this.depthData, this.resolution, this.resolution, THREE.RedFormat, THREE.HalfFloatType);
    this.depthTexture.minFilter = THREE.LinearFilter;
    this.depthTexture.magFilter = THREE.LinearFilter;
    this.depthTexture.needsUpdate = true;

    const geometry = new THREE.PlaneGeometry(1, 1, 48, 48);
    geometry.rotateX(-Math.PI / 2);

    this.material = this.buildMaterial();
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'water-surface';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;

    // Is there water anywhere? Sample a coarse ring of directions once.
    this.hasWater = this.detectWater(surface);
    this.waterRadius.value = surface.waterLevel;
    this.mesh.visible = false;
  }

  private detectWater(surface: TerrainSurface): boolean {
    let submerged = 0;
    const probe = new THREE.Vector3();
    for (let i = 0; i < 256; i++) {
      // Fibonacci sphere probe
      const y = 1 - (2 * i + 1) / 256;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const a = Math.PI * (3 - Math.sqrt(5)) * i;
      probe.set(Math.cos(a) * r, y, Math.sin(a) * r);
      if (surface.waterAtDir(probe.x, probe.y, probe.z) > 0.25) submerged++;
    }
    return submerged >= 4;
  }

  private buildMaterial(): MeshDefaultMaterial {
    const quality = uniform(this.options.quality ?? 1);

    // --- shore/depth mask from the local depth map (Folio's `detailsMask` role)
    const depthAtUv = Fn(() => {
      const u = positionLocal.x.add(0.5);
      const v = positionLocal.z.add(0.5);
      return texture(this.depthTexture, vec2(u, v)).r;
    });

    const waterColorShallow = uniform(new THREE.Color('#6fc7c0'));
    const waterColorDeep = uniform(new THREE.Color('#12355e'));

    const colorNode = Fn(() => {
      const depth = depthAtUv();

      // Ripples: two scrolling noise octaves on the surface position.
      const rippleUv = positionLocal.xz.mul(0.35).add(FOLIO.wind.direction.mul(FOLIO.wind.localTime.mul(0.4)));
      const rippleA = mx_noise_float(vec3(rippleUv, 0)).mul(0.5).add(0.5);
      const rippleB = mx_noise_float(vec3(rippleUv.mul(2.1), FOLIO.wind.localTime.mul(0.3))).mul(0.5).add(0.5);
      const ripple = rippleA.mul(0.6).add(rippleB.mul(0.4));

      // Colour: depth gradient + foam ring at the shoreline + ripple sparkle.
      const deepMix = depth.div(DEPTH_FADE).clamp(0, 1);
      const waterCol = (mix(waterColorShallow, waterColorDeep, deepMix) as any).toVar();
      waterCol.addAssign(ripple.mul(0.08));
      const foam = depth.smoothstep(0.28, 0.02).oneMinus();
      waterCol.assign(mix(waterCol, color('#e8f6f2'), foam.mul(0.55)));
      // Necrotic contamination in corrupted water reads through the shared vein colour.
      waterCol.assign(mix(waterCol, FOLIO.necro.veinColor, FOLIO.necro.intensity.mul(0.12)));
      return waterCol;
    })();

    const alphaNode = Fn(() => {
      const depth = depthAtUv();
      const shelf = depth.smoothstep(0, DEPTH_FADE);
      // Shoreline falloff keeps the edge soft instead of a hard lip.
      const edge = depth.smoothstep(0.0, 0.12);
      return shelf.mul(edge.mul(0.25).add(0.75)).mul(quality.mul(0.35).add(0.65));
    })();

    const material = new MeshDefaultMaterial({
      colorNode,
      alphaNode,
      transparent: true,
      depthWrite: false,
      hasCoreShadows: false,
      hasDropShadows: false,
      hasLightBounce: false,
      hasWater: false,
      alphaTest: 0,
      shadowSide: THREE.FrontSide,
    });

    // --- vertex: curve the grid onto the sphere around the patch centre.
    material.positionNode = Fn(() => {
      const local = positionLocal.xz.mul(this.patchSize);
      const theta = local.div(this.waterRadius);

      // Rodrigues rotation of the centre direction by the local tangent offset.
      const axis = this.tangent.mul(theta.x).add(this.bitangent.mul(theta.y));
      const angle = axis.length();
      const axisN = axis.div(angle.max(1e-5));
      const dir = this.center
        .mul(angle.cos())
        .add(axisN.mul(angle.sin()) as any)
        .normalize();

      // Gentle wave displacement along the radial.
      const wave = mx_noise_float(vec3(local.mul(0.18), FOLIO.time.mul(0.55)))
        .mul(FOLIO.water.amplitude.mul(0.5));
      return dir.mul(this.waterRadius.add(wave));
    })();

    return material;
  }

  /**
   * Follow the world: recenter the patch under the focus point and rebuild the local depth map.
   * Recentring is throttled by distance so this never runs per frame (plan §43).
   */
  update(focusPosition: THREE.Vector3): void {
    if (!this.hasWater) return;

    const surface = this.options.surface;
    const moved = this.lastFocus.distanceTo(focusPosition);
    if (moved < 14 && Number.isFinite(moved)) return;
    this.lastFocus.copy(focusPosition);

    const dir = _dir.copy(focusPosition).normalize();
    this.center.value.copy(dir);
    tangentBasis(dir, this.tangent.value, this.bitangent.value);

    // Rebuild the local depth map: depth = waterLevel − terrain height, sampled around the patch.
    const res = this.resolution;
    const half = this.patchSize * 0.5;
    const radius = surface.radius;
    let submerged = 0;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = (i / (res - 1) - 0.5) * this.patchSize;
        const z = (j / (res - 1) - 0.5) * this.patchSize;
        // map the patch's local offset back to a direction (inverse of the vertex mapping)
        const theta = x / radius;
        const phi = z / radius;
        _sample
          .copy(dir)
          .addScaledVector(this.tangent.value, Math.tan(theta))
          .addScaledVector(this.bitangent.value, Math.tan(phi))
          .normalize();
        // Depth against the DRAWN surface so the shore ring lines up with the seen terrain.
        const h = surface.visualHeightAtDir(_sample.x, _sample.y, _sample.z);
        const depth = Math.max(0, surface.waterLevel - h);
        this.depthData[j * res + i] = depth;
        if (depth > 0.2) submerged++;
      }
    }
    this.depthTexture.needsUpdate = true;

    this.mesh.visible = submerged > 12;
  }

  /** Quality / rescue hook: 0 hides the surface entirely. */
  setQuality(multiplier: number): void {
    this.mesh.visible = this.hasWater && multiplier > 0.01;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.depthTexture.dispose();
    this.mesh.removeFromParent();
  }
}

const _dir = new THREE.Vector3();
const _sample = new THREE.Vector3();
