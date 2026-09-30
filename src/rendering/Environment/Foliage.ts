/**
 * NECROFALL — instanced leaf cards (folio `World/Foliage.js` port, plan §19/§94).
 *
 * One merged plane-cloud geometry (80 leaf cards clustered into a canopy) is
 * instanced at every reference transform. Colour = folio's two-tone canopy
 * (N·L mix), alpha = the generated leaf SDF, wind = the shared field. ONE
 * draw call per tree type / bush family.
 */
import * as THREE from 'three/webgpu';
import { float, Fn, mix, normalWorld, positionLocal, rotateUV, screenSize, screenUV, smoothstep, texture, uniform, uv, vec2, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../planet/PlanetSeed';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { WorldGlobals } from '../WorldGlobals';
import type { PreRenderer } from '../PreRenderer';
import type { Ticker } from '../Ticker';
import type { Wind } from './Wind';

export interface FoliageOptions {
  /** Leaf card size in metres. */
  planeSize?: number;
  /** Cards per canopy. */
  planeCount?: number;
  /** Seed for the canopy scatter. */
  seed?: number;
  /** Fade cards near the player so they never block the view (folio see-through). */
  seeThrough?: boolean;
  castShadow?: boolean;
}

export class Foliage {
  readonly mesh: THREE.InstancedMesh;
  readonly material: MeshDefaultMaterial;
  readonly seeThroughPosition = uniform(vec2(0.5, 0.5));
  readonly seeThroughEdgeMin = uniform(0.08);
  readonly seeThroughEdgeMax = uniform(0.24);
  readonly threshold = uniform(0.3);
  readonly shadowOffset = uniform(1);

  private referenceCount: number;

  constructor(
    private readonly preRenderer: PreRenderer,
    private readonly wind: Wind,
    matrices: THREE.Matrix4[],
    colorA: any,
    colorB: any,
    ticker: Ticker,
    options: FoliageOptions = {},
  ) {
    const globals = WorldGlobals.get();
    const planeSize = options.planeSize ?? 0.8;
    const planeCount = options.planeCount ?? 80;

    const geometry = Foliage.createGeometry(planeCount, planeSize, options.seed ?? 1);

    // ---- alpha: the leaf SDF, shimmering with the wind (folio's rotateUV)
    const foliageAlpha = Fn(() => {
      const rotatedUv = rotateUV(
        uv(),
        (wind.offsetNode(positionLocal.xz) as any).length().mul(2.2),
        vec2(0.5),
      );
      return texture(this.preRenderer.foliageTexture, rotatedUv).r;
    });

    const alphaNode = Fn(() => {
      let alpha: any = foliageAlpha();

      if (options.seeThrough) {
        const toPlayer = screenUV.sub(this.seeThroughPosition);
        toPlayer.mulAssign(vec2(screenSize.x.div(screenSize.y), 1));
        const distanceToPlayer = toPlayer.length();
        const distanceFade = smoothstep(this.seeThroughEdgeMin, this.seeThroughEdgeMax, distanceToPlayer);
        alpha = alpha.mul(distanceFade.mul(this.threshold.oneMinus()).add(this.threshold));
      }

      return alpha.sub(this.threshold);
    })();

    // ---- canopy colour: two-tone folio mix driven by the sun
    const colorNode = Fn(() => {
      const mixStrength = (normalWorld as any).dot(globals.lighting!.directionUniform).smoothstep(0, 1);
      return mix(colorA, colorB, mixStrength);
    })();

    const material = new MeshDefaultMaterial({
      colorNode,
      alphaNode,
      hasWater: false,
      hasLightBounce: false,
      hasFog: true,
    });
    // folio law: leaves are OPAQUE with an alpha-test cutout — stacking blended
    // cards turned every canopy into black murk. The alphaNode still drives the
    // discard threshold.
    material.transparent = false;
    material.depthWrite = true;
    // leaves keep the folio shadow coupling
    (material as any).receivedShadowPositionNode = positionLocal.add(
      globals.lighting!.directionUniform.mul(this.shadowOffset),
    );
    (material as any).maskShadowNode = texture(this.preRenderer.foliageTexture).r.greaterThan(0.5);

    // ---- wind deformation in instance space (positionLocal is already
    // instance-transformed here, so this adds on top of the placement)
    material.positionNode = Fn(() => {
      const sway = wind.offsetNode(positionLocal.xz) as any;
      const heightFactor = positionLocal.y.mul(0.09).add(0.06);
      return positionLocal.add(vec3(sway.x, sway.y.mul(0.35), sway.y).mul(heightFactor));
    })() as any;

    this.material = material;
    this.referenceCount = matrices.length;

    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, matrices.length));
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.mesh.castShadow = options.castShadow ?? false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = matrices.length;

    for (let i = 0; i < matrices.length; i++) this.mesh.setMatrixAt(i, matrices[i]);
    this.mesh.instanceMatrix.needsUpdate = true;

    ticker.on(12, () => this.update());
  }

  /** Folio's canopy: a sphere of leaf cards, radial distribution, bent normals. */
  private static createGeometry(planeCount: number, planeSize: number, seed: number): THREE.BufferGeometry {
    const rng = mulberry32(seed);
    const planes: THREE.BufferGeometry[] = [];

    for (let i = 0; i < planeCount; i++) {
      const plane = new THREE.PlaneGeometry(planeSize, planeSize);

      const radius = 1 - Math.pow(rng(), 3);
      const theta = Math.PI * 2 * rng();
      const phi = Math.PI * rng();
      const position = new THREE.Vector3(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      );

      plane.rotateZ(rng() * 9999);
      plane.translate(position.x, position.y, position.z);

      // normals bent toward the canopy centre so leaves shade softly
      const normal = position.clone().normalize();
      const normalArray = new Float32Array(12);
      const source = plane.attributes.position.array as Float32Array;
      for (let v = 0; v < 4; v++) {
        const i3 = v * 3;
        const vertex = new THREE.Vector3(source[i3], source[i3 + 1], source[i3 + 2]);
        const mixed = vertex.lerp(normal, 0.85);
        normalArray[i3] = mixed.x;
        normalArray[i3 + 1] = mixed.y;
        normalArray[i3 + 2] = mixed.z;
      }
      plane.setAttribute('normal', new THREE.BufferAttribute(normalArray, 3));
      planes.push(plane);
    }

    const geometry = mergeGeometries(planes)!;
    for (const plane of planes) plane.dispose();
    return geometry;
  }

  /** See-through follows the player (screen-space fade, folio §19). */
  private update(): void {
    this.seeThroughEdgeMin.value = 0.1;
    this.seeThroughEdgeMax.value = 0.26;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  /** Replaces all instance matrices (used when quality re-filters placement). */
  setMatrices(matrices: THREE.Matrix4[]): void {
    if (this.referenceCount !== matrices.length) return; // layout is static — rebuild handled by owner
    for (let i = 0; i < matrices.length; i++) this.mesh.setMatrixAt(i, matrices[i]);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
