/**
 * NECROFALL — instanced leaf cards (folio `World/Foliage.js` port, plan §19/§94).
 *
 * One merged plane-cloud geometry (80 leaf cards clustered into a canopy, each
 * with a PERPENDICULAR TWIN so the canopy can never collapse edge-on from any
 * orbit angle) is instanced at every reference transform. Colour = folio's
 * two-tone canopy (N·L mix), alpha = the generated leaf SDF, wind = the shared
 * field. ONE draw call per tree type / bush family.
 */
import * as THREE from 'three/webgpu';
import { cameraPosition, color, float, Fn, mix, normalWorld, positionLocal, positionWorld, rotateUV, screenSize, screenUV, smoothstep, texture, uniform, uv, vec2, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../planet/PlanetSeed';
import { SurfaceMaterial } from '../materials/SurfaceMaterial';
import { WorldGlobals } from '../WorldGlobals';
import type { PreRenderer } from '../PreRenderer';
import type { Ticker } from '../Ticker';
import type { Wind } from './Wind';
import { dotDissolve } from './DotDissolve';
import { leafTexture } from '../../concepts/EnvironmentVegetation';

export interface FoliageOptions {
  /** Leaf card size in metres. */
  planeSize?: number;
  /** Cards per canopy. */
  planeCount?: number;
  /** Seed for the canopy scatter. */
  seed?: number;
  /**
   * Give every card a perpendicular twin. Folio's cards are coplanar per canopy,
   * so from some orbit angles every quad goes edge-on and the SDF cutout
   * collapses to a 2D line; the twin keeps ≥45° of one of the pair face-on
   * from ANY direction.
   */
  crossCards?: boolean;
  /** Fade cards near the player so they never block the view (folio see-through). */
  seeThrough?: boolean;
  castShadow?: boolean;
}

export class Foliage {
  readonly mesh: THREE.InstancedMesh;
  readonly material: SurfaceMaterial;
  readonly seeThroughPosition = uniform(vec2(0.5, 0.5));
  readonly seeThroughEdgeMin = uniform(0.08);
  readonly seeThroughEdgeMax = uniform(0.24);
  readonly threshold = uniform(0.3);
  readonly shadowOffset = uniform(1);

  private referenceCount: number;
  private readonly leafMap?: THREE.Texture;

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
    this.seeThroughPosition.value = globals.playerScreen.value;
    this.leafMap = globals.basePlanet ? leafTexture() : undefined;
    const planeSize = options.planeSize ?? 0.8;
    const planeCount = options.planeCount ?? 80;

    const geometry = Foliage.createGeometry(planeCount, planeSize, options.seed ?? 1, options.crossCards ?? true);

    // ---- alpha: the leaf SDF, shimmering with the wind (folio's rotateUV)
    const foliageAlpha = Fn(() => {
      const rotatedUv = rotateUV(
        uv(),
        (wind.offsetNode(positionLocal.xz) as any).length().mul(2.2),
        vec2(0.5),
      );
      return this.leafMap ? texture(this.leafMap, rotatedUv).a : texture(this.preRenderer.foliageTexture, rotatedUv).r;
    });

    const alphaNode = Fn(() => {
      let alpha: any = foliageAlpha();

      if (options.seeThrough) {
        const toPlayer = screenUV.sub(this.seeThroughPosition);
        toPlayer.mulAssign(vec2(screenSize.x.div(screenSize.y), 1));
        const distanceToPlayer = toPlayer.length();
        const distanceFade = smoothstep(this.seeThroughEdgeMin, this.seeThroughEdgeMax, distanceToPlayer);
        // ROUND-DOT DISSOLVE (user ask: the canopy uses "the dotted approach same as the rock
        // spikes"): ONE shared pattern definition (DotDissolve.ts) — near the player the canopy
        // breaks into round dots of leaves, and the dots grow with distance until the leaves have
        // merged back into their normal cutout by the bubble's rim.
        const closeOccluder = positionWorld.sub(cameraPosition).length().lessThan(globals.playerDistance.sub(0.25)).select(1, 0);
        alpha = alpha.mul(mix(float(1), dotDissolve(distanceFade), closeOccluder));
      }

      return alpha.sub(this.threshold);
    })();

    // ---- canopy colour: two-tone folio mix driven by the sun
    const colorNode = Fn(() => {
      const mixStrength = (normalWorld as any).dot(globals.lighting!.directionUniform).smoothstep(0, 1);
      return mix(colorA, colorB, mixStrength);
    })();

    const material = new SurfaceMaterial({
      colorNode,
      opacityNode: alphaNode,
      // leaf cards are viewed from every angle (under canopies included) —
      // single-sided cards made whole trees look leafless from below
      side: THREE.DoubleSide,
      roughness: 1,
      hasLightBounce: false,
      lawnGlow: false,
      glowNode: globals.basePlanet && globals.terrain ? color(globals.basePlanet.infection).mul(globals.terrain.terrainNode(positionWorld).a).mul(uv().y).mul(0.2) : undefined,
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
    (material as any).maskShadowNode = this.leafMap ? texture(this.leafMap).a.greaterThan(0.5) : texture(this.preRenderer.foliageTexture).r.greaterThan(0.5);

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
  private static createGeometry(
    planeCount: number,
    planeSize: number,
    seed: number,
    crossCards = true,
  ): THREE.BufferGeometry {
    const rng = mulberry32(seed);
    const planes: THREE.BufferGeometry[] = [];

    const makeCard = (position: THREE.Vector3, roll: number, crossed: boolean): THREE.BufferGeometry => {
      const plane = new THREE.PlaneGeometry(planeSize, planeSize);
      plane.rotateZ(roll);
      // the crossed twin sits 90° to its partner — from ANY view at least one
      // of the pair is ≥45° face-on (a canopy can never collapse to a line)
      if (crossed) plane.rotateX(Math.PI * 0.5);
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
      return plane;
    };

    for (let i = 0; i < planeCount; i++) {
      const radius = 1 - Math.pow(rng(), 3);
      const theta = Math.PI * 2 * rng();
      const phi = Math.PI * rng();
      const position = new THREE.Vector3(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      );
      const roll = rng() * 9999;

      planes.push(makeCard(position, roll, false));
      if (crossCards) planes.push(makeCard(position, roll, true));
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
    this.leafMap?.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
