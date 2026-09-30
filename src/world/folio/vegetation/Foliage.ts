// NECROFALL — Folio 2025's `Foliage`, ported from
// folio-2025/sources/Game/World/Foliage.js (MIT, Bruno Simon), adapted for the spherical planet
// and NecroFall's quality ladder (plan §11, §22).
//
// This is the shared foliage renderer behind every leafy thing: tree canopies, bushes and (in a
// simpler form) flowers. Its architecture is preserved exactly:
//
//   references → merged plane geometry → ONE material → custom instanceMatrix attribute →
//   shader-driven variation (wind, lighting) → see-through fade
//
// What changed for NecroFall:
//   • `references` may be plain matrices (tree leaf transforms) — no extra Object3D per leaf;
//   • the see-through fade is driven by the local player's SCREEN position (the same trick Folio
//     uses for its vehicle) and can be switched off per quality tier;
//   • winds stay local-space like Folio's (each leaf jitters in its own frame), while the
//     world-space flow lives in the Grass/wind system;
//   • every instance carries its ground's terrain data (`aTerrain`), so corrupted land grows
//     corrupted foliage through the same palette the terrain uses.
import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  float,
  instance,
  max,
  mix,
  normalWorld,
  positionLocal,
  positionWorld,
  rotateUV,
  screenSize,
  screenUV,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rand } from '../../../utils/Utils';
import { FOLIO } from '../FolioShaderGlobals';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { terrainDataNode } from '../terrain/NecroFallTerrainNode';
import { TERRAIN_PALETTE } from '../terrain/NecroFallTerrainNode';

/** Deterministic RNG for the one-off geometry build (fixed seed: same plane cluster always). */
const rng = new Rand(0xf0117a6e);

export interface FoliageOptions {
  /** Element transforms. Object3D uses position/quaternion/scale; Matrix4 is applied directly. */
  references: Array<THREE.Object3D | THREE.Matrix4>;
  /** SDF alpha texture (Folio foliageSDF). */
  foliageTexture: THREE.Texture;
  /** Low colour of the lit→shadow mix (uniform node so callers can tune). */
  colorA: any;
  colorB: any;
  /** Enable the player-occlusion fade (skipped on low tiers). */
  seeThrough?: boolean;
  /** Scale of the see-through edges (Folio scales cherry trees by 0.5). */
  seeThroughMultiplier?: number;
  /** Per-instance terrain data (aTerrain vec4 / aVeg float), one entry per reference. */
  terrainData?: Float32Array;
  vegetationData?: Float32Array;
  /** Fade target: screen position of the local player, in CSS pixels. Null = disabled. */
  focusScreenPosition?: () => THREE.Vector2 | null;
  /** Enable shader-side distance culling around the camera (set by the LOD system). */
  distanceCulling?: boolean;
  /** Render order/isolation knobs. */
  name?: string;
}

export class Foliage {
  readonly mesh: THREE.Mesh;
  readonly material: MeshDefaultMaterial;

  readonly counts: { instances: number; planes: number };

  /** LOD seam: the maximum camera distance instances are drawn at (set by VegetationLOD). */
  readonly cullDistance = uniform(140);

  private readonly instanceMatrix: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.BufferGeometry;
  private readonly seeThroughPosition = uniform(vec2());
  /** Camera→player distance: leaves closer than this can fade, leaves beyond never do. */
  private readonly seeThroughFocusDistance = uniform(1e3);

  constructor(private readonly options: FoliageOptions) {
    this.geometry = this.buildGeometry();
    this.material = this.buildMaterial();
    this.instanceMatrix = this.buildInstances();
    this.counts = { instances: this.options.references.length, planes: PLANE_COUNT };

    // Folio renders foliage through a PLAIN Mesh: the instancing lives entirely in the shader
    // (`instance(count, customMatrix)`), exactly like the Grass field. Do NOT use an
    // InstancedMesh here — three injects the mesh's own (zeroed) `instanceMatrix` on top of the
    // custom one and every leaf collapses into a single point (invisible canopies).
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = options.name ?? 'foliage';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false; // instances span the whole planet; culling is cell-based
  }

  // ------------------------------------------------------------------ geometry

  private buildGeometry(): THREE.BufferGeometry {
    // Folio's leaf cluster: 80 planes scattered inside a unit sphere, normals bent towards the
    // sphere surface so the cluster shades like a rounded canopy, not a pile of cards.
    const planes: THREE.BufferGeometry[] = [];
    for (let i = 0; i < PLANE_COUNT; i++) {
      const plane = new THREE.PlaneGeometry(0.8, 0.8);

      const spherical = new THREE.Spherical(
        1 - Math.pow(rng.next(), 3),
        Math.PI * 2 * rng.next(),
        Math.PI * rng.next(),
      );
      const position = new THREE.Vector3().setFromSpherical(spherical);

      plane.rotateZ(rng.next() * 9999);
      plane.translate(position.x, position.y, position.z);

      const normal = position.clone().normalize();
      const normalArray = new Float32Array(12);
      for (let v = 0; v < 4; v++) {
        const i3 = v * 3;
        const vertex = new THREE.Vector3(
          plane.attributes.position.array[i3],
          plane.attributes.position.array[i3 + 1],
          plane.attributes.position.array[i3 + 2],
        );
        const mixedNormal = vertex.lerp(normal, 0.85);
        normalArray[i3] = mixedNormal.x;
        normalArray[i3 + 1] = mixedNormal.y;
        normalArray[i3 + 2] = mixedNormal.z;
      }
      plane.setAttribute('normal', new THREE.BufferAttribute(normalArray, 3));
      planes.push(plane);
    }

    return mergeGeometries(planes);
  }

  // ------------------------------------------------------------------ material

  private buildMaterial(): MeshDefaultMaterial {
    // --- alpha: Folio's rotating SDF sample minus a threshold
    const threshold = uniform(0.3);

    const foliageAlpha = Fn(() => {
      const rotatedUv = rotateUV(
        uv(),
        FOLIO.wind.offsetLength(positionLocal.xz).mul(2.2),
        vec2(0.5),
      );
      return texture(this.options.foliageTexture, rotatedUv).r;
    });

    const alphaNode = Fn(() => {
      let alpha: any = float(1);

      if (this.options.seeThrough) {
        // Fade foliage between the camera and the player, exactly like Folio's vehicle fade — but
        // ONLY foliage that actually sits in front of the player. Without the depth gate any tree
        // you merely LOOK AT has its canopy at the screen's centre; the screen-space core then
        // erased those leaves, which read as "bare trees everywhere".
        const toFocus = screenUV.sub(this.seeThroughPosition);
        toFocus.mulAssign(vec2(screenSize.x.div(screenSize.y), 1));
        const distanceToFocus = toFocus.length();
        const distanceFade = smoothstep(
          this.seeThroughEdgeMin,
          this.seeThroughEdgeMax,
          distanceToFocus,
        );
        const fragmentDistance = positionWorld.sub(cameraPosition).length();
        const beyondPlayer = smoothstep(
          this.seeThroughFocusDistance.sub(2.0),
          this.seeThroughFocusDistance.add(1.0),
          fragmentDistance,
        );
        const fade = max(distanceFade, beyondPlayer);
        alpha.assign(foliageAlpha().mul(fade.mul(threshold.oneMinus()).add(threshold)));
      } else {
        alpha.assign(foliageAlpha());
      }

      alpha.subAssign(threshold);
      return alpha;
    })();

    // --- colour: lit→shadow mix, washed towards the planet's vein colour by local corruption
    const data = terrainDataNode();
    const colorNode = Fn(() => {
      const mixStrength = normalWorld.dot(FOLIO.lighting.direction).smoothstep(0, 1);
      const canopyColor = mix(this.options.colorA, this.options.colorB, mixStrength);
      const corruption = data.w.clamp(0, 1).mul(FOLIO.necro.intensity.mul(0.6).add(0.4)).min(1);
      return canopyColor.mix(TERRAIN_PALETTE.vein, corruption.mul(0.45));
    })();

    const material = new MeshDefaultMaterial({
      colorNode,
      alphaNode,
      hasWater: false,
      hasLightBounce: false,
    });

    // --- positioning: consume the custom instance matrix in the vertex stage
    const instanceCount = Math.max(1, this.options.references.length);
    const aCenter = attribute('aCenter', 'vec3') as any;
    const useCulling = this.options.distanceCulling ?? true;

    material.positionNode = Fn(() => {
      (instance(instanceCount, this.instanceMatrix) as any).toStack();
      if (!useCulling) return positionLocal;

      // Instance culling in the vertex stage: past the category distance, or on the planet's
      // far side, the whole leaf cluster is moved off the planet.
      //
      // The horizon test: from a camera at distance d from the centre, the horizon circle sits
      // at `acos(R/d)` from the camera's own radial — so the cosine threshold is simply R/d
      // (times a small safety margin). Using sqrt(1 - (R/d)^2) here hid a huge visible band of
      // foliage (~36°..54° at typical camera heights), which read as "most tree canopies empty".
      const center = aCenter as any;
      const radial = center.normalize();

      const tooFar = center.sub(cameraPosition as any).length().step(this.cullDistance);

      const cameraDistance = (cameraPosition as any).length();
      const horizonCos = FOLIO.planetRadius
        .div(cameraDistance.max(1))
        .min(1)
        .mul(0.985);
      const behindHorizon = horizonCos.sub(radial.dot((cameraPosition as any).normalize())).step(0.0);

      const hidden = max(tooFar, behindHorizon);
      return positionLocal.add(radial.mul(hidden.mul(9999)));
    })();

    // Shadows: offset the shadow sample along the sun so thin leaf planes cast a softer shape.
    (material as any).receivedShadowPositionNode = positionLocal.add(
      FOLIO.lighting.direction.mul(SHADOW_OFFSET),
    );

    // Mask shadows out of the alpha gaps so canopies dapple instead of turning into blobs.
    (material as any).maskShadowNode = texture(this.options.foliageTexture).r.greaterThan(0.5);

    // --- per-instance terrain data (corruption wash + future LOD dithering)
    if (this.options.terrainData) {
      this.geometry.setAttribute(
        'aTerrain',
        new THREE.InstancedBufferAttribute(this.options.terrainData, 4),
      );
    }
    if (this.options.vegetationData) {
      this.geometry.setAttribute(
        'aVeg',
        new THREE.InstancedBufferAttribute(this.options.vegetationData, 1),
      );
    }

    // --- per-instance center (vertex-stage culling reads it)
    const centers = new Float32Array(instanceCount * 3);
    let ci = 0;
    for (const reference of this.options.references) {
      if (reference instanceof THREE.Matrix4) {
        centers[ci * 3] = reference.elements[12];
        centers[ci * 3 + 1] = reference.elements[13];
        centers[ci * 3 + 2] = reference.elements[14];
      } else {
        reference.updateMatrix();
        centers[ci * 3] = reference.matrix.elements[12];
        centers[ci * 3 + 1] = reference.matrix.elements[13];
        centers[ci * 3 + 2] = reference.matrix.elements[14];
      }
      ci++;
    }
    this.geometry.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 3));

    return material;
  }

  /** See-through edge distances, recomputed per frame from the camera distance (Folio's maths). */
  private readonly seeThroughEdgeMin = uniform(0.11);
  private readonly seeThroughEdgeMax = uniform(0.57);

  // ------------------------------------------------------------------ instances

  private buildInstances(): THREE.InstancedBufferAttribute {
    const count = this.options.references.length;
    const instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(count * 16), 16);
    instanceMatrix.setUsage(THREE.StaticDrawUsage);

    let i = 0;
    for (const reference of this.options.references) {
      if (reference instanceof THREE.Matrix4) {
        reference.toArray(instanceMatrix.array as Float32Array, i * 16);
      } else {
        reference.updateMatrix();
        reference.matrix.toArray(instanceMatrix.array as Float32Array, i * 16);
      }
      i++;
    }
    return instanceMatrix;
  }

  // ------------------------------------------------------------------ per-frame

  /**
   * Folio updates the see-through anchor + edge distances every tick. The fade target is the
   * player's screen position; when there is no local player (menus), the fade disables itself by
   * parking the anchor far outside the screen.
   */
  update(cameraDistance: number, focusDistance = 1e3): void {
    if (!this.options.seeThrough) return;
    this.seeThroughFocusDistance.value = focusDistance;

    const focus = this.options.focusScreenPosition?.() ?? null;
    if (focus) {
      this.seeThroughPosition.value.set(focus.x, focus.y);
    } else {
      this.seeThroughPosition.value.set(-10_000, -10_000);
    }

    const multiplier = this.options.seeThroughMultiplier ?? 1;
    const d = Math.max(1, cameraDistance);
    this.seeThroughEdgeMin.value = (3 / d) * multiplier;
    this.seeThroughEdgeMax.value = (15 / d) * multiplier;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Folio's leaf cluster size. */
const PLANE_COUNT = 80;
/** Shadow sample offset along the sun (world units). */
const SHADOW_OFFSET = 1;
