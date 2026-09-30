// NECROFALL — Grass (plan §9, §10, §59, §60): Folio 2025's grass, ported 1:1 from
// folio-2025/sources/Game/World/Grass.js (MIT, Bruno Simon) to the spherical planet.
//
// Folio's architecture, kept exactly:
//   • ONE flat field of `subdivisions²` camera-scrolling blades — a fixed, dense local patch that
//     follows the view instead of a planet-wide scatter;
//   • the field WRAPS modulo its own size around the view centre in the vertex shader
//     (`mod(position − centre + half, size) − half`), so blades recycle seamlessly with zero CPU;
//   • every blade is a 3-vertex triangle (tip + 2 base corners) whose SHAPE lives in the vertex
//     shader (`bladeShape` uniform array + vertexIndex % 3) and which ROTATES TO FACE THE CAMERA;
//   • blade size = folio's `surfaceOverflow` formula (a bigger field grows bigger blades);
//   • terrain data comes from TEXTURES sampled at the blade's own position, so a recycled blade
//     always wears the colours/mask of the ground it currently stands on;
//   • `normalNode` is the surface up, so blades light exactly like the ground beneath them;
//   • wind displacement, per-blade height randomness (0.6) and density-mask thinning: folio's
//     constants verbatim.
//
// Planet adaptations (documented per site, everything else is folio's logic untouched):
//   • the field plane is a TANGENT FRAME on the sphere: blades are stored in metres of arc around
//     an anchor direction, and the vertex shader maps the wrapped offset onto the sphere surface;
//   • `shiftFrame` re-projects the stored offsets into a new tangent frame when the view leaves
//     the frame's centre — a pure coordinate change (every blade keeps its world position). It is
//     NOT a re-scatter: folio never touches its blade positions after `setGeometry`, and neither
//     do we (live bug 2026-09-30: the old re-anchor re-scattered 90 % of the field inside the
//     view = "the grass pops in and changes as I move").
//   • the per-blade terrain data is sampled from two baked equirect textures (slope/height01/
//     moisture/corruption + vegetation) — folio's `terrain.terrainNode(bladePosition)`;
//   • blades hide below the waterline and grow along the surface normal.
//
// Grass is ONE mesh and ONE draw call. The CPU only writes a 2-float uniform per frame.
import * as THREE from 'three/webgpu';
import {
  Fn,
  asin,
  attribute,
  atan,
  cameraPosition,
  cross,
  float,
  mix,
  mx_noise_float,
  normalize,
  texture,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vertexIndex,
} from 'three/tsl';
import { clamp, Rand } from '../../../utils/Utils';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { terrainAlbedoNode, TERRAIN_PALETTE } from '../terrain/NecroFallTerrainNode';
import { FOLIO } from '../FolioShaderGlobals';
import type { TerrainSurface } from '../../TerrainSurface';

export interface GrassOptions {
  surface: TerrainSurface;
  seed: number;
  /** Blade-density multiplier (quality tier): scales the field's subdivisions. */
  density: number;
  /** Field reach in metres (the patch follows the camera). */
  maxDistance: number;
  /** Unused by the folio field (kept for the world builder's signature). */
  towers: THREE.Vector3[];
  /** Unused by the folio field (kept for the world builder's signature). */
  meadows: THREE.Vector3[];
  moistureAt(x: number, y: number, z: number): number;
  corruptionAt(x: number, y: number, z: number): number;
  reliefMin: number;
  reliefMax: number;
  /** Waterline as height01 (0..1 of the relief band); -1 = dry world. */
  waterline01?: number;
  castShadows?: boolean;
}

/** Folio's density: 280² = 78 400 blades per 280 m of field. Our field covers the full visible
 *  ground (~95 m half-extent at high quality), so the subdivisions scale up with the area to keep
 *  a folio-like blades-per-m² (≈5/m²); quality tiers scale it back down through `density`. */
const BASE_SUBDIVISIONS = 420;
/** Folio's ideal field surface (m²) — drives the blade-size overflow formula. */
const SURFACE_IDEAL = 2000;
/** Re-centre (pure coordinate shift, never a re-scatter) once the view leaves this fraction of
 *  the half-extent — keeps the stored offsets small; folio's flat world never needs it, the
 *  sphere does. The blades' world positions are untouched. */
const RECENTER_FRACTION = 0.55;
/** Equirect data texture size (per-texel ≈ 2.9 m at the equator on a 118 m planet). */
const TEX_W = 512;
const TEX_H = 256;

/**
 * Deterministic tangent basis of a direction. The CPU (frame rebase) and the shader (blade
 * mapping) MUST agree bit-for-bit, so both use this exact rule: the helper axis flips from +Y
 * to +X beyond |y| = 0.9 (a hard switch, no blending).
 */
function helperAxis(y: number): THREE.Vector3 {
  return Math.abs(y) > 0.9 ? _axisX : _axisY;
}
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisY = new THREE.Vector3(0, 1, 0);

export class Grass {
  /**
   * Local copies of the planet's relief band + waterline.
   *
   * These MUST be local uniforms fed from the constructor options: reading a module-level
   * singleton (TERRAIN_PALETTE / FOLIO) left the running match holding 0/0 defaults, which put
   * every blade's base at radius 0 — the whole field buried at the planet's centre (live bug
   * 2026-09-30, cost a full review pass). Local uniforms from `options` cannot go stale.
   */
  private readonly reliefMinU = uniform(0);
  private readonly reliefMaxU = uniform(1);
  private readonly waterlineU = uniform(-1);
  readonly mesh: THREE.Mesh;
  readonly material: MeshDefaultMaterial;
  /** LOD seam: blades farther than this are collapsed (registered with the visibility system). */
  cullDistance!: { value: number };
  bladeCount = 0;

  /** Half-size of the field, in metres of arc. */
  private readonly halfExtent: number;
  private readonly size: number;
  private readonly subdivisions: number;
  private readonly radius: number;

  /** Field frame: anchor direction + tangent basis (the sphere's replacement for world XZ). */
  private readonly anchor = new THREE.Vector3(0, 1, 0);
  private readonly basisT1 = new THREE.Vector3(1, 0, 0);
  private readonly basisT2 = new THREE.Vector3(0, 0, 1);
  private readonly center2D = new THREE.Vector2();

  private readonly anchorUniform = uniform(vec3(0, 1, 0));
  private readonly centerUniform = uniform(vec2(0, 0));
  private readonly sizeUniform = uniform(1);
  private readonly positionAttribute: THREE.BufferAttribute;

  // Frame-rebase scratch.
  private readonly _dir = new THREE.Vector3();
  private readonly _t1n = new THREE.Vector3();
  private readonly _t2n = new THREE.Vector3();

  constructor(private readonly options: GrassOptions) {
    this.radius = options.surface.radius;
    this.reliefMinU.value = options.reliefMin;
    this.reliefMaxU.value = options.reliefMax;
    this.waterlineU.value = options.waterline01 ?? -1;
    // The field reach = the visible ground distance (FolioWorld passes the per-quality value).
    // The wrap recycles blades AT this radius, so it must sit at/beyond the visible edge — the
    // old 36 m cap put the recycling rim INSIDE the view ("grass pops in and changes as I move",
    // live review 2026-09-30).
    this.halfExtent = clamp(options.maxDistance, 48, 200);
    this.size = this.halfExtent * 2;
    this.subdivisions = Math.max(48, Math.round(BASE_SUBDIVISIONS * Math.sqrt(clamp(options.density, 0.25, 1.2))));
    this.bladeCount = this.subdivisions * this.subdivisions;

    this.positionAttribute = this.buildGeometry();
    const data = this.bakeTerrainTextures();

    this.material = this.buildMaterial(data.texA, data.texB);
    this.mesh = new THREE.Mesh(this.geometry!, this.material);
    this.mesh.name = 'folio-grass';
    this.mesh.frustumCulled = false; // the field follows the camera; a baked bound would lie
    this.mesh.castShadow = options.castShadows ?? false;
    this.mesh.receiveShadow = true;

    this.sizeUniform.value = this.size;
    this.buildBasis(this.anchor, this.basisT1, this.basisT2);
    this.anchorUniform.value.copy(this.anchor);
  }

  private geometry: THREE.BufferGeometry | null = null;

  // ------------------------------------------------------------------ field (CPU, once)

  /** Folio's grid: one random blade centre per fragment, replicated across its 3 vertices. */
  private buildGeometry(): THREE.BufferAttribute {
    const count = this.bladeCount;
    const rect = this.subdivisions;
    const fragment = this.size / rect;
    const radius = this.radius;

    // `aField` = the wrapped field offset (the shader's real input); `position` stays a VALID
    // vec3 so the material pipeline's internal reads (fog/normal transforms) never see the
    // two-component layout — folio's itemSize-2 `position` collides with three r183's vec3
    // positionLocal and produced garbage vertex data (live bug 2026-09-30: giant blade spray).
    const fields = new Float32Array(count * 3 * 2);
    const positions = new Float32Array(count * 3 * 3);
    const heightRandomness = new Float32Array(count * 3);
    const rand = new Rand((this.options.seed ^ 0x6a55) >>> 0);

    for (let iX = 0; iX < rect; iX++) {
      const fragmentX = (iX / rect - 0.5) * this.size + fragment * 0.5;
      for (let iZ = 0; iZ < rect; iZ++) {
        const fragmentZ = (iZ / rect - 0.5) * this.size + fragment * 0.5;
        const i = iX * rect + iZ;
        const x = fragmentX + (rand.next() - 0.5) * fragment;
        const z = fragmentZ + (rand.next() - 0.5) * fragment;
        const r = 0.55 + rand.next() * 0.9;

        // Initial-frame world position (anchor +Y): the pipeline's internal reads get sane data;
        // the vertex shader positions everything itself regardless.
        const len = Math.max(1e-4, Math.hypot(x, z));
        const angle = len / radius;
        const s = Math.sin(angle) / len;
        const px = z * s * radius;
        const py = Math.cos(angle) * radius;
        const pz = x * s * radius;

        for (let v = 0; v < 3; v++) {
          const i2 = (i * 3 + v) * 2;
          const i3 = (i * 3 + v) * 3;
          fields[i2] = x;
          fields[i2 + 1] = z;
          positions[i3] = px;
          positions[i3 + 1] = py;
          positions[i3 + 2] = pz;
          heightRandomness[i * 3 + v] = r;
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    const field = new THREE.BufferAttribute(fields, 2);
    field.setUsage(THREE.DynamicDrawUsage); // frame rebases rewrite it
    geometry.setAttribute('aField', field);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('heightRandomness', new THREE.BufferAttribute(heightRandomness, 1));
    this.geometry = geometry;
    return field;
  }

  /**
   * Bake the per-direction terrain data into two equirect textures — the spherical stand-in for
   * folio's `terrain.terrainNode(bladePosition)`. A = (slope, height01, moisture, corruption),
   * B = vegetation (0..1.6 → 0..255). Sampled per blade in the vertex/fragment shaders, so a
   * wrapped blade always wears the data of the ground it currently stands on.
   */
  private bakeTerrainTextures(): { texA: THREE.DataTexture; texB: THREE.DataTexture } {
    const surface = this.options.surface;
    const reliefSpan = Math.max(1e-3, this.options.reliefMax - this.options.reliefMin);
    const texA = new Uint8Array(TEX_W * TEX_H * 4);
    const texB = new Uint8Array(TEX_W * TEX_H);

    for (let y = 0; y < TEX_H; y++) {
      const lat = (y / (TEX_H - 1) - 0.5) * Math.PI;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      for (let x = 0; x < TEX_W; x++) {
        const lon = (x / TEX_W - 0.5) * Math.PI * 2;
        const dx = cosLat * Math.cos(lon);
        const dz = cosLat * Math.sin(lon);

        const h = surface.heightAtDir(dx, sinLat, dz);
        const slope = surface.slopeAtDir(dx, sinLat, dz);
        const moisture = this.options.moistureAt(dx, sinLat, dz);
        const corruption = this.options.corruptionAt(dx, sinLat, dz);
        const veg = surface.vegetationAtDir(dx, sinLat, dz);

        const i = (y * TEX_W + x) * 4;
        texA[i] = clamp(slope, 0, 1) * 255;
        texA[i + 1] = clamp((h - this.options.reliefMin) / reliefSpan, 0, 1) * 255;
        texA[i + 2] = clamp(moisture, 0, 1) * 255;
        texA[i + 3] = clamp(corruption, 0, 1) * 255;
        texB[y * TEX_W + x] = clamp(veg / 1.6, 0, 1) * 255;
      }
    }

    const wrap = (data: Uint8Array, format: THREE.PixelFormat, channels: number): THREE.DataTexture => {
      const tex = new THREE.DataTexture(data, TEX_W, TEX_H, format, THREE.UnsignedByteType);
      tex.wrapS = THREE.RepeatWrapping; // the longitude seam must filter across ±π
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      void channels;
      return tex;
    };

    return { texA: wrap(texA, THREE.RGBAFormat, 4), texB: wrap(texB, THREE.RedFormat, 1) };
  }

  private buildBasis(dir: THREE.Vector3, t1: THREE.Vector3, t2: THREE.Vector3): void {
    const helper = helperAxis(dir.y);
    t1.crossVectors(helper, dir).normalize();
    t2.crossVectors(dir, t1).normalize();
  }

  // ------------------------------------------------------------------ material (folio port)

  /** Blade shape uniforms — public so the field can be tuned (and diagnosed) live. */
  readonly bladeWidthU: any = uniform(0.1);
  readonly bladeHeightU: any = uniform(0.6);
  readonly bladeRandomnessU: any = uniform(0.6);

  private buildMaterial(texA: THREE.DataTexture, texB: THREE.DataTexture): MeshDefaultMaterial {
    // --- folio's overflow formula, CLAMPED: folio grows the blades when the field grows (their
    // field resizes with the view LOD). Our field now covers the whole visible ground (190 m
    // wide), which would push the raw overflow to 17 → 3.8 m blades. The clamp keeps the tuned
    // third-person scale (≈0.1 m wide / 0.7 m tall) at every quality tier.
    const surface = this.size * this.size;
    const surfaceOverflow = clamp((surface - SURFACE_IDEAL) / SURFACE_IDEAL, 0, 1.6);
    this.bladeWidthU.value = 0.055 * (1 + surfaceOverflow * 0.5);
    this.bladeHeightU.value = 0.4 * (1 + surfaceOverflow * 0.5);
    const bladeWidth = this.bladeWidthU;
    const bladeHeight = this.bladeHeightU;
    const bladeHeightRandomness = this.bladeRandomnessU;
    this.cullDistance = uniform(this.options.maxDistance);

    const bladeShape = uniformArray([
      0, 1, // tip
      1, 0, // left side
      -1, 0, // right side
    ]);

    // --- varyings shared by both stages
    const vertexLoopIndex = varying(vertexIndex.toFloat().mod(3));
    const vTipness = varying(vertexLoopIndex.step(0.5).oneMinus()); // 1 on the tip corner
    const vUv = varying(vec2());
    const vUp = varying(vec3());
    const vMask = varying(float());

    // --- folio's terrain lookups, from the baked textures. The samplers take the UV as a
    // parameter so the VERTEX stage reads its local uv node (reading the varying back inside the
    // same stage diverges per vertex and sprayed giant shards — live bug 2026-09-30), while the
    // fragment stage samples at the interpolated `vUv`.
    const sampleA = Fn(([uvNode]: any[]) => texture(texA, uvNode));
    const sampleVeg = Fn(([uvNode]: any[]) => (texture(texB, uvNode) as any).r.mul(1.6));

    const material = new MeshDefaultMaterial({
      colorNode: Fn(() => {
        // Folio: the terrain's own colour function, evaluated at this blade's data.
        return terrainAlbedoNode(sampleA(vUv), TERRAIN_PALETTE.grass, sampleVeg(vUv).div(1.6));
      })(),
      // Folio passes a constant (0, 1, 0); on the sphere that is the blade's surface up.
      normalNode: vUp,
      hasWater: false,
      hasLightBounce: false,
      // Folio's shadow tip mix: tips read lit, roots sit in the ground's shadow.
      shadowNode: vTipness.oneMinus().mul(vMask),
      side: THREE.DoubleSide, // thin camera-facing blades — never let winding hide the field
      shadowSide: THREE.DoubleSide,
    });

    // --- the vertex stage: folio's blade construction on the tangent frame ---------------------
    const anchor = this.anchorUniform;
    const centerU = this.centerUniform;
    const sizeU = this.sizeUniform;
    const radiusU = uniform(this.radius);

    material.positionNode = Fn(() => {
      // The field's tangent frame (must mirror `buildBasis` bit-for-bit: hard switch at |y|=0.9).
      const helper = (vec3(0, 1, 0) as any).mix(
        vec3(1, 0, 0),
        (anchor.y.abs() as any).step(0.9),
      );
      const t1 = normalize(cross(helper, anchor));
      const t2 = normalize(cross(anchor, t1));

      // Folio's infinite scroll (Grass.js exactly): wrap the blade's stored offset around the
      // VIEW CENTRE, then add the centre back. While the blade is inside the window its world
      // spot is unchanged (world-pinned); when the view scrolls past it, the wrap recycles it to
      // the far rim — out of sight — so nothing ever pops or drifts inside the view.
      const raw = attribute('aField', 'vec2') as any;
      const half = sizeU.mul(0.5);
      const loopPosition = raw
        .sub(centerU)
        .add(half)
        .mod(sizeU)
        .sub(half)
        .add(centerU);

      // Map the wrapped tangent offset onto the sphere (metres of arc around the anchor).
      const offsetLength = loopPosition.length().max(1e-4);
      const angle = offsetLength.div(radiusU);
      const dir = anchor
        .mul(angle.cos())
        .add(t1.mul(loopPosition.x).add(t2.mul(loopPosition.y)).mul(angle.sin().div(offsetLength)))
        .normalize();

      // Per-blade terrain data at the blade's CURRENT position (folio's terrainNode call).
      // The v coordinate is LATITUDE-LINEAR (asin), because the baked equirect texture's rows
      // are latitude rows — the sine-based `dir.y*0.5+0.5` sampled the wrong latitude and left
      // blades up to 4.4 m off the ground ("grass floats", live review 2026-09-30: measured
      // -2.8..-4.4 m error vs 0.00 m with the angle-based v).
      const uv = vec2(
        atan(dir.z, dir.x).mul(1 / (Math.PI * 2)).add(0.5),
        asin(dir.y.clamp(-1, 1)).mul(1 / Math.PI).add(0.5),
      );
      vUv.assign(uv);
      vUp.assign(dir);

      // Folio's grass mask, derived from the sampled terrain data. NecroFall reads as a GRASS
      // planet (folio's island is lush everywhere): the terrain data MODULATES the grass — it
      // never erases it except on genuinely steep rock. No water gate (folio has none — the sea
      // covers its own ground), so the carpet runs right down to the waterline.
      const a = sampleA(uv) as any;
      const height01 = a.y;
      const flatness = a.x.smoothstep(1.35, 0.05);
      const lush = sampleVeg(uv)
        .mul(0.55)
        .add(0.45)
        .clamp(0, 1)
        .mul(a.w.oneMinus().mul(0.45).add(0.55));
      const mask = flatness.mul(lush).clamp(0, 1);
      vMask.assign(mask);

      // Height variation from the blade's WORLD direction (folio samples its perlin at the
      // blade's world position) — wrapping never changes a blade's height.
      const heightVariation = mx_noise_float(dir.mul(this.radius * 0.0321))
        .mul(0.5)
        .add(1);
      const randomness = mix(float(1), attribute('heightRandomness', 'float') as any, bladeHeightRandomness);
      // Folio scales geometry by the RAW density; a modest floor keeps ground cover even on the
      // barren biomes, so no planet reads as "no grass".
      const densityScale = mask.mul(0.65).add(0.35);
      const height = bladeHeight.mul(randomness).mul(heightVariation).mul(densityScale);
      const width = bladeWidth.mul(densityScale);

      // The blade's base radius, from the sampled relief of the ground it stands on.
      const baseRadius = this.reliefMinU.add(
        height01.mul(this.reliefMaxU.sub(this.reliefMinU)),
      );

      // Shape (vertices: tip / left / right) along the surface up.
      const corner = vertexIndex.toFloat().mod(3);
      const shapeX = (bladeShape.element(corner.mul(2)) as any).negate().mul(width);
      const shapeY = (bladeShape.element(corner.mul(2).add(1)) as any).mul(height);

      const base = dir.mul(baseRadius);
      let vertex: any = base.add(dir.mul(shapeY));

      // Camera-facing rotation — folio's `angleToCamera` (atan2 of the blade→camera vector),
      // evaluated in the blade's TANGENT plane. Two sphere hazards: a cross-product version
      // degenerates for blades radially under the camera, and atan2(0,0) itself is NaN — so the
      // arguments carry a tiny bias. NaN inputs sprayed giant triangles over the field.
      const toCamera = (cameraPosition as any).sub(base);
      const facing = atan(
        toCamera.dot(t2).add(1e-4),
        toCamera.dot(t1).add(1e-4),
      ).sub(Math.PI * 0.5);
      const right = t1.mul(facing.cos()).add(t2.mul(facing.sin()));
      vertex = vertex.add(right.mul(shapeX));

      // Wind: folio's `wind.offsetNode(...) × tipness × height × 2` along the surface tangent.
      // The gust samples the blade's STORED offset (constant per blade) so wrapping never
      // re-rolls a blade's wind state.
      const windWorld = vec3(FOLIO.wind.direction.x, float(0), FOLIO.wind.direction.y);
      const windTangent = normalize(windWorld.sub(dir.mul(windWorld.dot(dir))).add(right.mul(1e-4)));
      const gust = FOLIO.wind.offset(raw).length().mul(0.5).add(FOLIO.wind.strength.mul(0.5));
      const sway = gust.mul(vTipness).mul(height).mul(2);
      vertex = vertex.add(windTangent.mul(sway));

      // Folio has no per-blade distance cull: the wrap keeps the field around the view, so
      // every blade is near by construction.
      return vertex;
    })();

    return material;
  }

  // ------------------------------------------------------------------ per-frame

  /**
   * Follow the view (folio's `center.value.set(...)` — their flat-world version). `focus` is the
   * camera/player position in WORLD space; the field centres on the surface point beneath it.
   */
  update(focus: THREE.Vector3): void {
    const dir = this._dir.copy(focus).normalize();

    // The view's angular offset inside the current field frame (folio's `center`).
    const cx = Math.atan2(dir.dot(this.basisT1), dir.dot(this.anchor)) * this.radius;
    const cy = Math.atan2(dir.dot(this.basisT2), dir.dot(this.anchor)) * this.radius;
    this.center2D.set(cx, cy);
    this.centerUniform.value.set(cx, cy);

    // The tangent cap distorts when the view walks far from the anchor: re-base the frame.
    // This is a PURE COORDINATE SHIFT — folio's field never re-scatters, and the shader's
    // wrap-around-view keeps every blade's world spot through the rebase.
    if (Math.hypot(cx, cy) > this.halfExtent * RECENTER_FRACTION) {
      this.shiftFrame(dir);
    }
  }

  /**
   * Re-base the tangent frame under the view.
   *
   * Folio's flat world never needs this; on a sphere the cap projection distorts when the view
   * walks far from the anchor. Every blade's WORLD direction is transformed into the new frame
   * and stored back (wrapped into one field-size window — the shader wraps anyway, so this is
   * display-lossless). NOTHING is re-scattered: no blade ever moves relative to the terrain and
   * nothing pops inside the view (live review 2026-09-30 — the old scatter-based re-anchor was
   * the "grass pops in and changes as I move" bug).
   */
  private shiftFrame(newAnchor: THREE.Vector3): void {
    const pos = this.positionAttribute.array as Float32Array;
    const count = this.bladeCount;
    const size = this.size;
    const half = size * 0.5;
    const radius = this.radius;

    const t1n = this._t1n;
    const t2n = this._t2n;
    this.buildBasis(newAnchor, t1n, t2n);

    const oldT1 = this.basisT1;
    const oldT2 = this.basisT2;
    const oldAnchor = this.anchor;

    for (let i = 0; i < count; i++) {
      const o = i * 6;
      // The blade's stored offset (all three vertices are identical; vertex 0 is the blade's).
      const lu = pos[o];
      const lv = pos[o + 1];
      const len = Math.max(1e-4, Math.hypot(lu, lv));
      const r = len / radius;
      const sinR = Math.sin(r);

      // Its world direction (inverse of the shader's cap mapping).
      const dx = oldAnchor.x * Math.cos(r) + (oldT1.x * lu + oldT2.x * lv) * (sinR / len);
      const dy = oldAnchor.y * Math.cos(r) + (oldT1.y * lu + oldT2.y * lv) * (sinR / len);
      const dz = oldAnchor.z * Math.cos(r) + (oldT1.z * lu + oldT2.z * lv) * (sinR / len);

      // Into the new frame (angular offsets, metres of arc), wrapped into the field window.
      const ca = dx * newAnchor.x + dy * newAnchor.y + dz * newAnchor.z;
      const nu = Math.atan2(dx * t1n.x + dy * t1n.y + dz * t1n.z, ca) * radius;
      const nv = Math.atan2(dx * t2n.x + dy * t2n.y + dz * t2n.z, ca) * radius;
      const wu = (((nu + half) % size) + size) % size - half;
      const wv = (((nv + half) % size) + size) % size - half;
      pos[o] = wu; pos[o + 2] = wu; pos[o + 4] = wu;
      pos[o + 1] = wv; pos[o + 3] = wv; pos[o + 5] = wv;
    }
    this.positionAttribute.needsUpdate = true;

    this.anchor.copy(newAnchor);
    this.anchorUniform.value.copy(newAnchor);
    this.basisT1.copy(t1n);
    this.basisT2.copy(t2n);
    this.center2D.set(0, 0);
    this.centerUniform.value.set(0, 0);
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
