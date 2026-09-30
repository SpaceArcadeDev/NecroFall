// NECROFALL — Folio 2025's `Foliage`, ported from
// folio-2025/sources/Game/World/Foliage.js (MIT, Bruno Simon), adapted for the spherical planet
// and NecroFall's quality ladder (plan §11, §22).
//
// This is the shared foliage renderer behind every leafy thing: tree canopies, bushes and (in a
// simpler form) flowers. Its architecture is preserved exactly:
//
//   references → merged plane geometry → ONE material → official InstancedMesh matrices →
//   shader-driven variation (wind, lighting) → see-through fade → CPU per-instance culling
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
  cameraPosition,
  float,
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
  /** Official InstancedMesh instancing — the same proven path as trunks, rocks and enemies. */
  readonly mesh: THREE.InstancedMesh;
  readonly material: MeshDefaultMaterial;

  readonly counts: { instances: number; planes: number };

  /** LOD seam: the maximum camera distance instances are drawn at (set by VegetationLOD). */
  readonly cullDistance = uniform(140);

  private readonly geometry: THREE.BufferGeometry;
  /** The reference transforms — the CPU cull writes hidden/visible matrices from these. */
  private readonly baseMatrices: THREE.Matrix4[] = [];
  /** Per-instance world position (for the distance/horizon culling pass). */
  private readonly centers: Float32Array;
  /** 1 = shown, 0 = culled; 255 = never written yet (forces the first pass to fill everything). */
  private readonly cullState: Uint8Array;
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly seeThroughPosition = uniform(vec2());
  /** Camera→player distance: leaves closer than this can fade, leaves beyond never do. */
  private readonly seeThroughFocusDistance = uniform(1e3);

  constructor(private readonly options: FoliageOptions) {
    this.geometry = this.buildGeometry();
    this.material = this.buildMaterial();
    const count = this.options.references.length;
    this.counts = { instances: count, planes: PLANE_COUNT };

    // Folio instancing through the OFFICIAL InstancedMesh path (`setMatrixAt` + the built-in
    // instanceMatrix attribute) — the same mechanism the trunk/rock/enemy instancing uses and
    // which provably draws. The previous custom `instance(count, attr)` TSL node silently never
    // drew in this pipeline: every tree rendered as bare branches (live review 2026-09-30).
    this.centers = new Float32Array(count * 3);
    this.cullState = new Uint8Array(count).fill(255);
    for (const reference of this.options.references) {
      if (reference instanceof THREE.Matrix4) {
        this.baseMatrices.push(reference.clone());
      } else {
        reference.updateMatrix();
        this.baseMatrices.push(reference.matrix.clone());
      }
    }
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, Math.max(1, count));
    this.mesh.count = count;
    this.mesh.name = options.name ?? 'foliage';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false; // instances span the whole planet; culling is per-instance below
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < count; i++) {
      const m = this.baseMatrices[i];
      this.centers[i * 3] = m.elements[12];
      this.centers[i * 3 + 1] = m.elements[13];
      this.centers[i * 3 + 2] = m.elements[14];
      this.mesh.setMatrixAt(i, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
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

    // --- colour: lit→shadow mix, washed towards the planet's vein colour by local corruption.
    // The wash stays light (0.22): folio's canopy is `mix(colorA, colorB, lighting)` only, and a
    // strong wash turned every crown on corrupt worlds into the vein's teal — the trees then read
    // as bare trunks with odd blue balls (live review 2026-09-30).
    const data = terrainDataNode();
    const colorNode = Fn(() => {
      const mixStrength = normalWorld.dot(FOLIO.lighting.direction).smoothstep(0, 1);
      const canopyColor = mix(this.options.colorA, this.options.colorB, mixStrength);
      const corruption = data.w.clamp(0, 1).mul(FOLIO.necro.intensity.mul(0.6).add(0.4)).min(1);
      return canopyColor.mix(TERRAIN_PALETTE.vein, corruption.mul(0.22));
    })();

    const material = new MeshDefaultMaterial({
      colorNode,
      alphaNode,
      hasWater: false,
      hasLightBounce: false,
    });

    // Positioning: none — the official `instanceMatrix` of the InstancedMesh applies the
    // instance transform, and per-instance culling happens on the CPU in `update()`.

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

    return material;
  }

  /** See-through edge distances, recomputed per frame from the camera distance (Folio's maths). */
  private readonly seeThroughEdgeMin = uniform(0.11);
  private readonly seeThroughEdgeMax = uniform(0.57);

  // ------------------------------------------------------------------ per-frame

  /**
   * Folio updates the see-through anchor + edge distances every tick. The fade target is the
   * player's screen position; when there is no local player (menus), the fade disables itself by
   * parking the anchor far outside the screen.
   *
   * The per-instance CPU cull also runs here when a camera position is supplied (the caller
   * throttles to ~10 Hz — the instance counts are a few hundred).
   */
  update(cameraDistance: number, focusDistance = 1e3, cameraPosition?: THREE.Vector3): void {
    if (cameraPosition && (this.options.distanceCulling ?? true)) this.cullInstances(cameraPosition);

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

  /**
   * Per-instance CPU culling: past the category distance or behind the planet's horizon the
   * instance is written as a zero-scale matrix (invisible). This replaced the old vertex-stage
   * cull, which depended on the custom instancing path.
   *
   * The horizon circle sits at `acos(R/d)` from the camera's own radial — cosine threshold R/d
   * (with a small margin). Using sqrt(1-(R/d)^2) used to hide a huge visible band of foliage.
   */
  private cullInstances(camera: THREE.Vector3): void {
    const count = this.counts.instances;
    const camLen = Math.max(1, camera.length());
    const horizonCos = Math.min(1, FOLIO.planetRadius.value / camLen) * 0.985;
    const invCam = 1 / camLen;
    const camX = camera.x * invCam;
    const camY = camera.y * invCam;
    const camZ = camera.z * invCam;
    const maxD = this.cullDistance.value;
    const maxD2 = maxD * maxD;
    let changed = false;
    for (let i = 0; i < count; i++) {
      const x = this.centers[i * 3];
      const y = this.centers[i * 3 + 1];
      const z = this.centers[i * 3 + 2];
      const dx = x - camera.x;
      const dy = y - camera.y;
      const dz = z - camera.z;
      const tooFar = dx * dx + dy * dy + dz * dz > maxD2;
      const len = Math.max(1e-4, Math.sqrt(x * x + y * y + z * z));
      const behind = (x * camX + y * camY + z * camZ) / len < horizonCos;
      const shown = tooFar || behind ? 0 : 1;
      if (shown !== this.cullState[i]) {
        this.cullState[i] = shown;
        this.mesh.setMatrixAt(i, shown ? this.baseMatrices[i] : this.hidden);
        changed = true;
      }
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
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
