// NECROFALL — procedural spherical mini-planet: heightfield terrain, analytic
// collision surface, terrain normals, ray casting — with the environment rework
// (`WorldEnvironment`, plan §1/§87) providing every decoration, prop, water and weather system.
import * as THREE from 'three';
import { CONFIG, QualitySettings } from '../core/Config';
import { clamp, orientToSurface, tangentBasis, dirFromAngles } from '../utils/Utils';
import {
  SHADER_GLOBALS,
  nfUniforms,
  NF_UNIFORMS_GLSL,
  NF_LIGHTING_GLSL,
  NF_FOG_GLSL,
  updateShaderGlobals,
} from './ShaderGlobals';
import { createAmbience, type Ambience } from './Ambience';
import { deriveArchetype, type PlanetArchetype } from './PlanetArchetypes';
import { TerrainGenerator } from './TerrainGenerator';
import { BiomeGenerator } from './BiomeGenerator';
import { WorldEnvironment, type EnvironmentFrame } from './WorldEnvironment';
import type { FocusInput } from './interaction/VegetationInteraction';
import type { Landmark } from './LandmarkGenerator';
import { createWindUniforms, type WindUniforms } from './Vegetation';

const _upY = new THREE.Vector3(0, 1, 0);

/** The game's scene lights, handed to the environment so its atmosphere can drive them. */
export interface PlanetLights {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  rim: THREE.DirectionalLight;
}

const _up = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _p = new THREE.Vector3();
const _fw = new THREE.Vector3();

/** Scratch [lat, lon] for the mesh lookup's bin maths: lat is y/|v| in [-1, 1], lon in radians. */
const _ll = new Float64Array(2);

/** Above this lat coordinate (cos 6°) a triangle can enclose a pole (see `eachMeshCell`). */
const POLE_ROW = 0.9945;

/** Grid coordinates of a direction — insertion and query must agree on this exactly. */
function lonLatOf(x: number, y: number, z: number): void {
  const inv = 1 / Math.max(1e-9, Math.sqrt(x * x + y * y + z * z));
  _ll[0] = y * inv;
  _ll[1] = Math.atan2(z * inv, x * inv);
}

/** Blades in a full-density grass field (HIGH). MEDIUM / LOW scale it by `grassDensity`. */
const FULL_GRASS_BLADES = 54600;

/** Indexed icosphere with smooth normals (built by hand so we can merge/shade properly). */
function buildIcosphere(subdiv: number): THREE.BufferGeometry {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (const v of verts) {
    const l = Math.hypot(v[0], v[1], v[2]);
    v[0] /= l; v[1] /= l; v[2] /= l;
  }
  const cache = new Map<string, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const va = verts[a], vb = verts[b];
    const mx = (va[0] + vb[0]) * 0.5, my = (va[1] + vb[1]) * 0.5, mz = (va[2] + vb[2]) * 0.5;
    const l = Math.hypot(mx, my, mz) || 1;
    const idx = verts.length;
    verts.push([mx / l, my / l, mz / l]);
    cache.set(key, idx);
    return idx;
  };
  for (let s = 0; s < subdiv; s++) {
    const next: number[][] = [];
    for (const f of faces) {
      const a = midpoint(f[0], f[1]);
      const b = midpoint(f[1], f[2]);
      const c = midpoint(f[2], f[0]);
      next.push([f[0], a, c], [f[1], b, a], [f[2], c, b], [a, b, c]);
    }
    faces = next;
    cache.clear();
  }
  const positions = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    positions[i * 3] = verts[i][0];
    positions[i * 3 + 1] = verts[i][1];
    positions[i * 3 + 2] = verts[i][2];
  }
  const index: number[] = [];
  for (const f of faces) index.push(f[0], f[1], f[2]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(index);
  return geo;
}

const TERRAIN_VERT = /* glsl */ `
  varying vec3 vColor;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  varying vec3 vRadial;
  void main() {
    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
    vWorld = wp;
    vRadial = normalize(wp);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vColor = color;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const TERRAIN_FRAG = /* glsl */ `
  ${NF_UNIFORMS_GLSL}
  uniform vec3 uVeinColor;
  uniform vec3 uGrassColor;
  uniform vec3 uRockColor;
  uniform float uRadius;
  varying vec3 vColor;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  varying vec3 vRadial;
  ${NF_LIGHTING_GLSL}
  ${NF_FOG_GLSL}

  float veins(vec3 p) {
    float a = sin(p.x * 0.42) * sin(p.y * 0.37) * sin(p.z * 0.47);
    float b = sin(p.x * 0.17 + 1.7) * sin(p.z * 0.19 - 0.6);
    // a narrow band so this reads as a glowing vein network, not a wash over the whole ground
    return smoothstep(0.86, 0.995, a * 0.6 + b * 0.5 + 0.5);
  }

  float hash3(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
  }

  /** 3D value noise — cheap ground grain so the surface never looks like flat paint. */
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash3(i);
    float n100 = hash3(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash3(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash3(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash3(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash3(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash3(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash3(i + vec3(1.0, 1.0, 1.0));
    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
  }

  float fbm3(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      sum += amp * vnoise(p);
      p *= 2.03;
      amp *= 0.5;
    }
    return sum;
  }

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 up = normalize(vRadial);
    vec3 lit = nfLight(vColor, n, up, vWorld, 0.35);
    float slope = 1.0 - clamp(dot(n, up), 0.0, 1.0);
    float alt = clamp((length(vWorld) - uRadius + 13.0) / 40.0, 0.0, 1.0);

    // ground grain: two octave bands so close-ups and wide shots both read as terrain
    float grain = fbm3(vWorld * 1.35);
    float fine = vnoise(vWorld * 6.5);
    float patchN = fbm3(vWorld * 0.3);
    vec3 albedo = vColor * (0.68 + 0.62 * grain) * (0.86 + 0.3 * patchN);

    // vegetation creeps over flat low ground, rock takes over on the steep faces
    float flatness = smoothstep(0.38, 0.05, slope);
    float grassy = flatness * (1.0 - smoothstep(0.35, 0.8, alt));
    albedo = mix(albedo, uGrassColor * (0.55 + 1.0 * grain), grassy * 0.72);
    float rocky = smoothstep(0.26, 0.6, slope);
    albedo = mix(albedo, uRockColor * (0.7 + 0.6 * fine), rocky * 0.6);

    // damp basins read darker
    float wet = 1.0 - smoothstep(0.13, 0.32, alt);
    albedo *= mix(1.0, 0.84, wet);
    lit = nfLight(albedo, n, up, vWorld, 0.35);

    // faint necrotic energy veins glowing in the lowlands
    float v = veins(vWorld * 0.08);
    lit += uVeinColor * v * (0.3 + 0.12 * sin(uTime * 0.9 + vWorld.x * 0.05));
    // sheen on wet ground
    lit += uSkyColor * wet * flatness * fine * 0.1;

    lit = mix(lit, uFogColor, nfFog(vWorld));
    gl_FragColor = vec4(lit, 1.0);
  }
`;

// ---------------------------------------------------------------- prop shaders
// The old single-file prop shader family has moved to the environment rework:
// see `rendering/EnvironmentMaterials.ts` (instanced grass/tree/rock/prop/water shaders with
// wind, player interaction, LOD bands and dither fades — plan §7-§11/§54).

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uNebula;
  uniform float uTime;
  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(h, 0.75));

    // slow nebula bands
    float band = sin(d.x * 2.6 + uTime * 0.02) * sin(d.z * 3.1 - uTime * 0.015) * sin(d.y * 1.7);
    col += uNebula * pow(max(band, 0.0), 3.0) * 0.55;

    // procedural stars
    vec3 cell = floor(d * 260.0);
    float rnd = fract(sin(dot(cell, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
    float star = smoothstep(0.9975, 1.0, rnd);
    col += vec3(star) * (0.55 + 0.45 * sin(uTime * 1.4 + rnd * 40.0));

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Planet {
  readonly radius = CONFIG.planetRadius;
  readonly seed: number;
  /** Quality tier for the match, used to size the grass field and scenery. */
  private readonly quality: QualitySettings;
  /** The terrain: one mesh per sector (see `buildTerrainChunks`) so the far side can be skipped. */
  mesh: THREE.Group;
  /** The reworked environment composition root (plan §1/§87): cells, foliage, water, physics. */
  readonly environment: WorldEnvironment;
  private terrainChunks: THREE.Mesh[] = [];
  private chunkCenters: THREE.Vector3[] = [];
  private chunkRadii: number[] = [];
  private decorationsVisible = true;
  private sky: THREE.Mesh;
  private sunBase = new THREE.Vector3(1, 0.85, 0.6).normalize();
  private sunAxis = new THREE.Vector3(0, 0, 1);
  /** Actual terrain relief of THIS planet (filled while baking vertices). */
  private reliefMin = Infinity;
  private reliefMax = -Infinity;
  private terrainMat: THREE.ShaderMaterial;
  private skyMat: THREE.ShaderMaterial;
  /**
   * Spatial index over the RENDERED terrain triangles (see `meshHeightAtDir`). The drawn mesh
   * interpolates linearly between its ~2-4 m vertices, so on steep ground the visible surface sits
   * up to ~1 m above — and 1.8 m below — the analytic field the simulation runs on. Anything that
   * must LOOK like it stands on the ground has to be placed on the mesh, not the field.
   */
  private meshLatBins = 0;
  private meshLonBins = 0;
  private meshCellStart: Int32Array | null = null;
  private meshCellTris: Int32Array | null = null;
  private meshTriIndex: Int32Array | null = null;
  private meshPoints: Float32Array | null = null;
  /** Shared wind state: grass, flowers and plants all read these uniforms. */
  private wind = createWindUniforms();
  private windTime = 0;
  /** Drifting motes + ground glints. */
  private ambience: Ambience | null = null;
  /** Particle budget multiplier from the watchdog. */
  private ambienceMul = 1;
  /** Reusable frame bundle for the environment update (no per-frame allocation). */
  private readonly envFrame: EnvironmentFrame = {
    cameraPos: new THREE.Vector3(),
    cameraQuat: new THREE.Quaternion(),
    elapsed: 0,
    focuses: [],
    localFocus: null,
  };
  /** The planet's archetype (plan §11 step 1) — climate, relief parameters, palette, sky. */
  readonly archetype: PlanetArchetype;
  /** The height-field pipeline (plan §11). */
  readonly terrain: TerrainGenerator;
  /** Biome classifier + palette (plan §13). */
  readonly biome: BiomeGenerator;
  /** Deterministic landmarks carved into this world (plan §12/§14). */
  get landmarks(): readonly Landmark[] {
    return this.terrain.landmarks;
  }
  readonly fogColor = new THREE.Color(0x171029);
  readonly fogDensity = 0.00125;

  constructor(
    scene: THREE.Scene,
    quality: QualitySettings,
    seed: number,
    focusDir?: THREE.Vector3,
    ring = 0,
    lights?: PlanetLights
  ) {
    this.seed = seed;
    this.quality = quality;

    // ---- the world pipeline: seed (+rank ring) → archetype → terrain fields → biome
    this.archetype = deriveArchetype(seed, ring);
    this.terrain = new TerrainGenerator(seed, this.radius, this.archetype, ring, focusDir?.clone().normalize());
    this.biome = new BiomeGenerator(this.archetype, this.terrain);
    this.fogColor.setHex(this.archetype.sky.fog);

    // ---- the environment rework (plan §1/§87): cells, foliage, water, physics and atmosphere.
    // Built BEFORE the terrain mesh so every height sample (here and in gameplay) goes through
    // the provider — macro field + the versioned §5 detail layers.
    this.environment = this.createEnvironment(scene, quality, seed, lights);

    // ---- sky dome (nebula + star shader), tinted by the archetype's sky
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uZenith: { value: new THREE.Color(this.archetype.sky.zenith) },
        uHorizon: { value: new THREE.Color(this.archetype.sky.horizon) },
        uNebula: { value: new THREE.Color(this.archetype.sky.nebula) },
        uTime: { value: 0 },
      },
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1700, 32, 20), this.skyMat);
    sky.frustumCulled = false;
    // Drawn AFTER everything else: the sky is the furthest thing in the scene and writes no depth,
    // so when it is rendered last the depth buffer already rejects the whole area the planet and
    // its props cover — that used to be a full-screen pass of sky shader that was then painted over.
    sky.renderOrder = 1000;
    this.sky = sky;
    scene.add(sky);

    // ---- terrain
    const geo = buildIcosphere(quality.planetDetail);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const scratch = new THREE.Color();
    const v = new THREE.Vector3();
    // PASS 1 — positions from the height pipeline (plan §11: the biome step needs the SHAPE first)
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      const h = this.heightAtDir(v.x, v.y, v.z);
      pos.setXYZ(i, v.x * h, v.y * h, v.z * h);
      if (h < this.reliefMin) this.reliefMin = h;
      if (h > this.reliefMax) this.reliefMax = h;
    }
    geo.computeVertexNormals();
    // PASS 2 — colours from the BIOME classifier: palette ramp + slope rock + veins + landmarks
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const inv = 1 / Math.max(1e-6, v.length());
      const rx = v.x * inv, ry = v.y * inv, rz = v.z * inv;
      const h = this.heightAtDir(rx, ry, rz);
      const slope = clamp(1 - (nrm.getX(i) * rx + nrm.getY(i) * ry + nrm.getZ(i) * rz), 0, 1);
      this.biome.colorAt(rx, ry, rz, h, slope, c, scratch);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.terrainMat = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      vertexColors: true,
      uniforms: nfUniforms({
        uVeinColor: { value: new THREE.Color(this.archetype.palette.vein) },
        uGrassColor: { value: new THREE.Color(this.archetype.palette.mid) },
        uRockColor: { value: new THREE.Color(this.archetype.palette.ridge) },
        uRadius: { value: this.radius },
      }),
    });

    this.mesh = new THREE.Group();
    this.mesh.name = 'terrain';
    this.buildTerrainChunks(geo);
    scene.add(this.mesh);
    this.buildMeshLookup(geo);
  }

  /**
   * Splits the terrain into 32 equal-direction sectors so the frustum — and the horizon test in
   * `updateTerrainChunks` — can skip whatever no camera can see. Every chunk SHARES the parent's
   * vertex buffers; the split only partitions the index, so the drawn surface is bit-identical to
   * the old single mesh. Bounds are computed from the vertices each chunk actually references
   * (three's own `computeBoundingSphere` would report the whole planet's sphere for every chunk).
   */
  private buildTerrainChunks(geo: THREE.BufferGeometry): void {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const idx = geo.index as THREE.BufferAttribute;
    const CHUNKS = 32;
    // Fibonacci sphere: evenly spread seed directions for the sectors.
    const seeds: THREE.Vector3[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < CHUNKS; i++) {
      const y = 1 - (2 * i + 1) / CHUNKS;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const a = golden * i;
      seeds.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
    }
    const lists: number[][] = seeds.map(() => []);
    const a3 = new THREE.Vector3();
    const b3 = new THREE.Vector3();
    const c3 = new THREE.Vector3();
    for (let f = 0; f < idx.count; f += 3) {
      const ia = idx.getX(f);
      const ib = idx.getX(f + 1);
      const ic = idx.getX(f + 2);
      a3.fromBufferAttribute(pos, ia);
      b3.fromBufferAttribute(pos, ib);
      c3.fromBufferAttribute(pos, ic);
      const cx = a3.x + b3.x + c3.x;
      const cy = a3.y + b3.y + c3.y;
      const cz = a3.z + b3.z + c3.z;
      const l = Math.hypot(cx, cy, cz) || 1;
      const nx = cx / l, ny = cy / l, nz = cz / l;
      let best = 0;
      let bestDot = -2;
      for (let s = 0; s < CHUNKS; s++) {
        const d = seeds[s].x * nx + seeds[s].y * ny + seeds[s].z * nz;
        if (d > bestDot) { bestDot = d; best = s; }
      }
      lists[best].push(ia, ib, ic);
    }
    const p = new THREE.Vector3();
    for (let s = 0; s < CHUNKS; s++) {
      const list = lists[s];
      if (list.length === 0) continue;
      const chunk = new THREE.BufferGeometry();
      chunk.setAttribute('position', pos);
      chunk.setAttribute('normal', geo.attributes.normal);
      chunk.setAttribute('color', geo.attributes.color);
      chunk.setIndex(list);
      // Bounds from the vertices this chunk references, not the whole planet's cloud.
      const seen = new Set<number>();
      const box = new THREE.Box3();
      for (const vi of list) {
        if (seen.has(vi)) continue;
        seen.add(vi);
        box.expandByPoint(p.fromBufferAttribute(pos, vi));
      }
      const center = box.getCenter(new THREE.Vector3());
      let radius = 0;
      for (const vi of seen) {
        radius = Math.max(radius, p.fromBufferAttribute(pos, vi).distanceTo(center));
      }
      radius = Math.max(1, radius * 1.05);
      chunk.boundingSphere = new THREE.Sphere(center, radius);
      const mesh = new THREE.Mesh(chunk, this.terrainMat);
      mesh.name = `terrain-chunk-${s}`;
      mesh.frustumCulled = true;
      this.terrainChunks.push(mesh);
      this.chunkCenters.push(center);
      this.chunkRadii.push(radius);
      this.mesh.add(mesh);
    }
  }

  /**
   * Horizon culling (plan §19): from a camera `h` above the surface the planet's own curve hides
   * everything beyond a small cap (at 9 m up: ~14°, plus the angle the peaks add — ~27° for the
   * tallest ridge). A chunk is kept unless its whole bounding sphere sits below the horizon plane
   * through the eye; the conservative test is `dot(C, P) + r·|P| <= R²`, with 3 % slack so tall
   * summits that poke over the curve can never be skipped. Exactness was verified against a
   * per-vertex occlusion check on the seeded planet.
   */
  private updateTerrainChunks(cameraPos: THREE.Vector3): void {
    const n = this.terrainChunks.length;
    if (n === 0) return;
    const d = cameraPos.length();
    if (d <= this.radius) {
      for (let i = 0; i < n; i++) this.terrainChunks[i].visible = true;
      return;
    }
    const horizon = this.radius * this.radius * 0.97;
    for (let i = 0; i < n; i++) {
      const c = this.chunkCenters[i];
      this.terrainChunks[i].visible =
        c.x * cameraPos.x + c.y * cameraPos.y + c.z * cameraPos.z + this.chunkRadii[i] * d > horizon;
    }
  }

  /**
   * Points the sun at a region of the planet so the contested play area is never
   * stuck on the night side. Called once per match with the tower-ring centre.
   */
  aimSunAt(dir: THREE.Vector3): void {
    tangentBasis(dir, _t1, _t2);
    this.sunBase.copy(dir).multiplyScalar(0.62).addScaledVector(_t1, 0.72).addScaledVector(_t2, 0.22).normalize();
    this.sunAxis.copy(_t2).normalize();
  }

  /**
   * Per-frame updates. `focuses`/`localFocus`/`elapsed` come from the game each frame and feed
   * the environment (vegetation reaction, streaming foci, shadows, weather — plan §34/§55).
   */
  update(
    dt: number,
    cameraPos: THREE.Vector3,
    cameraQuat?: THREE.Quaternion,
    focuses: readonly FocusInput[] = [],
    localFocus: THREE.Vector3 | null = null,
    elapsed = 0
  ): void {
    updateShaderGlobals(dt, cameraPos);
    // slow sun drift keeps highlights moving across the surface
    const time = SHADER_GLOBALS.uTime.value;
    SHADER_GLOBALS.uSunDir.value.copy(this.sunBase)
      .applyAxisAngle(this.sunAxis, Math.sin(time * 0.01) * 0.16)
      .normalize();
    (this.skyMat.uniforms.uTime.value as number) += dt;

    // ---- wind: direction wanders slowly, strength gusts in waves. Grass and flowers read the
    // same uniforms, so the whole world breathes as one system.
    this.windTime += dt;
    const t = this.windTime;
    const angle = Math.sin(t * 0.037) * 0.5 + Math.sin(t * 0.013 + 1.7) * 0.9;
    this.wind.uWindDir.value.set(Math.cos(angle), Math.sin(angle)).normalize();
    this.wind.uWindStrength.value = 0.85 + Math.sin(t * 0.21) * 0.17;
    this.wind.uWindGust.value = 0.5 + Math.sin(t * 0.083 + 0.4) * 0.5;

    // Atmosphere: motes wrap around the camera, glints twinkle over the arena.
    this.ambience?.update(dt, cameraPos, time);

    // The planet hides its own far side from a low camera: skip the terrain sectors the horizon
    // cannot possibly show (see `updateTerrainChunks`).
    this.updateTerrainChunks(cameraPos);

    // ---- the environment rework: one bundled update (plan §71 frequencies live inside).
    const frame = this.envFrame;
    frame.cameraPos.copy(cameraPos);
    if (cameraQuat) frame.cameraQuat.copy(cameraQuat);
    frame.elapsed = elapsed;
    frame.focuses = focuses;
    frame.localFocus = localFocus;
    this.environment.update(dt, frame);
  }

  /** Scales the ambient point clouds (watchdog hook, same idea as Effects.setBudget). */
  setAmbienceBudget(mul: number): void {
    this.ambienceMul = mul;
    this.ambience?.setBudget(mul);
  }

  /** Grows the twinkling ground glints over the given zones (called with growGrass). */
  private buildAmbience(zones: THREE.Vector3[]): void {
    this.ambience?.dispose();
    this.ambience = createAmbience(this.environment.root, this, this.seed, {
      motes: Math.round(clamp(this.quality.particles * 0.22, 60, 260)),
      glints: Math.round(clamp(this.quality.decorations * 1.6, 260, 1200)),
      zones,
    });
    this.ambience.setBudget(this.ambienceMul);
  }

  /**
   * Called by the game once the match's towers/pads exist: their feet become gameplay keep-out
   * zones (plan §61), active cells are rebuilt so nothing pokes into a Beacon pad, and the
   * ambience glints are re-grown over the same zones.
   */
  growGrass(zones: THREE.Vector3[]): void {
    if (zones.length === 0) return;
    this.environment.setGameplayZones(zones);
    this.buildAmbience(zones);
  }

  /** Live blade count of the streamed grass (debug readout). */
  get grassBlades(): number {
    return this.environment.grass.stats().instances;
  }

  /** The shared wind state, so gameplay code can read or nudge it. */
  get windUniforms(): WindUniforms {
    return this.wind;
  }

  /**
   * Hides or restores the whole environment (foliage, props, water, weather). Used by the
   * performance watchdog: scenery is the cheapest thing to drop when frames get tight.
   */
  setDecorationsVisible(visible: boolean): void {
    if (this.decorationsVisible === visible) return;
    this.decorationsVisible = visible;
    this.environment.setVisible(visible);
  }

  /** Tears down every GPU resource so a freshly seeded planet can take its place. */
  dispose(): void {
    this.mesh.removeFromParent();
    for (const child of [...this.mesh.children]) (child as THREE.Mesh).geometry.dispose();
    this.mesh.clear();
    this.terrainChunks.length = 0;
    this.chunkCenters.length = 0;
    this.chunkRadii.length = 0;
    this.terrainMat.dispose();
    this.sky.removeFromParent();
    this.sky.geometry.dispose();
    this.skyMat.dispose();
    this.environment.dispose();
    this.ambience?.dispose();
    this.ambience = null;
    // the rendered-surface lookup holds nothing on the GPU, but drop the (multi-MB) buffers
    this.meshCellStart = null;
    this.meshCellTris = null;
    this.meshTriIndex = null;
    this.meshPoints = null;
  }

  // ------------------------------------------------------------ heightfield

  /**
   * Terrain radius (distance from planet centre) along a unit direction — the PLANET TERRAIN
   * PROVIDER's field (macro + §5 detail layers). Every consumer — mesh, collision, raycasts,
   * placement — reads this one function, so the drawn surface and the simulated one can never
   * drift apart (plan §4).
   */
  heightAtDir(x: number, y: number, z: number): number {
    return this.environment.provider.getHeight(x, y, z);
  }

  heightAt(p: THREE.Vector3): number {
    const d = _p.copy(p);
    const len = d.length();
    if (len < 0.001) return this.radius;
    d.multiplyScalar(1 / len);
    return this.heightAtDir(d.x, d.y, d.z);
  }

  // ------------------------------------------------------------ rendered-surface lookup

  /** Triangle hit by the last `meshHeightAtDir` call — callers may pass it back as a hint. */
  meshTriHint = -1;

  /**
   * Files every terrain triangle into a lat/lon grid so `meshHeightAtDir` can find the few
   * candidates along any direction without touching the other ~20 k triangles. A triangle is
   * registered in the exact cell box of its corners (a radial line through the triangle always
   * lands in that box); rows inside the near-pole band are filled across every longitude, because
   * the atan2 longitude of a corner is meaningless right at the pole.
   */
  private buildMeshLookup(geo: THREE.BufferGeometry): void {
    const index = geo.index;
    if (!index) return;
    const pts = geo.attributes.position.array as Float32Array;
    const triCount = Math.floor(index.count / 3);
    const latBins = 64;
    const lonBins = 128;
    this.meshLatBins = latBins;
    this.meshLonBins = lonBins;
    this.meshPoints = pts;
    const triIndex = new Int32Array(triCount * 3);
    for (let k = 0; k < triIndex.length; k++) triIndex[k] = index.getX(k);
    this.meshTriIndex = triIndex;

    const cells = latBins * lonBins;
    const start = new Int32Array(cells + 1);
    // pass 1 — count
    for (let t = 0; t < triCount; t++) this.eachMeshCell(t, triIndex, pts, (i, j) => { start[i * lonBins + j + 1]++; });
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    const tris = new Int32Array(start[cells]);
    const fill = start.slice(0, cells);
    // pass 2 — fill
    for (let t = 0; t < triCount; t++) this.eachMeshCell(t, triIndex, pts, (i, j) => { tris[fill[i * lonBins + j]++] = t; });
    this.meshCellStart = start;
    this.meshCellTris = tris;
  }

  /** Calls `cb(i, j)` for every grid cell a triangle must be filed under. */
  private eachMeshCell(t: number, triIndex: Int32Array, pts: Float32Array, cb: (i: number, j: number) => void): void {
    const latBins = this.meshLatBins;
    const lonBins = this.meshLonBins;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    let lon0 = 0;
    for (let k = 0; k < 3; k++) {
      const vi = triIndex[t * 3 + k] * 3;
      lonLatOf(pts[vi], pts[vi + 1], pts[vi + 2]);
      const lat = _ll[0];
      let lon = _ll[1];
      if (k === 0) lon0 = lon;
      else {
        // unwrap around the first corner: a triangle is far smaller than a half-turn, so this
        // takes the strip ACROSS the ±π seam (shifting only the min side could invert the range
        // and drop the triangle out of the grid entirely — the seam misses).
        while (lon - lon0 > Math.PI) lon -= Math.PI * 2;
        while (lon0 - lon > Math.PI) lon += Math.PI * 2;
      }
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    const i0 = Math.max(0, Math.floor((minLat + 1) * 0.5 * latBins) - 1);
    const i1 = Math.min(latBins - 1, Math.floor((maxLat + 1) * 0.5 * latBins) + 1);
    const j0 = Math.floor((minLon / (Math.PI * 2) + 0.5) * lonBins);
    const j1 = Math.floor((maxLon / (Math.PI * 2) + 0.5) * lonBins);
    // Only triangles right at a pole (≤ 6° away) can enclose it, where a corner's longitude is
    // meaningless — those fill their whole row. Everything else uses the exact longitude box: a
    // wide fill made every polar cell scan hundreds of triangles.
    const polar = maxLon - minLon > Math.PI || maxLat > POLE_ROW || minLat < -POLE_ROW;
    for (let i = i0; i <= i1; i++) {
      const latC = (i + 0.5) / latBins * 2 - 1;
      if (polar && (latC > POLE_ROW || latC < -POLE_ROW)) {
        for (let j = 0; j < lonBins; j++) cb(i, j);
      } else {
        for (let j = j0; j <= j1; j++) cb(i, ((j % lonBins) + lonBins) % lonBins);
      }
    }
  }

  /**
   * Radius of the RENDERED terrain surface along a unit direction — exactly where the drawn ground
   * is (the mesh interpolates linearly inside each triangle).
   *
   * The simulation runs on the analytic field, and on gentle ground the drawn mesh agrees with it
   * to a few centimetres. On steep ground it does NOT: measured planet-wide, the drawn surface sits
   * up to 0.95 m ABOVE the field (slopes > 1, p99 ≈ 0.7 m) and down to 1.8 m below it. A body
   * placed on the field therefore wades through hillsides, and popping in and out of the ground
   * while crossing a slope reads as the creature getting stuck on the terrain. Anything that must
   * LOOK like it stands on the ground belongs on this height.
   *
   * `hint` is the triangle index a previous call hit (`meshTriHint`); passing it back makes the
   * common case a single triangle test. `fallback` (normally the analytic height) is returned when
   * the direction somehow misses every triangle in and around its cell.
   */
  meshHeightAtDir(x: number, y: number, z: number, fallback?: number, hint = -1): number {
    const start = this.meshCellStart;
    const tris = this.meshCellTris;
    const idx = this.meshTriIndex;
    const pts = this.meshPoints;
    if (start && tris && idx && pts) {
      if (hint >= 0) {
        const t = this.rayMeshTri(hint, x, y, z, idx, pts);
        if (t >= 0) { this.meshTriHint = hint; return t; }
      }
      lonLatOf(x, y, z);
      const i = Math.min(this.meshLatBins - 1, Math.max(0, Math.floor((_ll[0] + 1) * 0.5 * this.meshLatBins)));
      const j = Math.min(this.meshLonBins - 1, Math.max(0, Math.floor((_ll[1] / (Math.PI * 2) + 0.5) * this.meshLonBins)));
      this.meshTriHint = -1;
      let t = this.rayMeshCell(i * this.meshLonBins + j, x, y, z, start, tris, idx, pts);
      if (t < 0) {
        // widen the search around the query (seam / a hair outside the triangle's box)
        for (let di = -2; di <= 2 && t < 0; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= this.meshLatBins) continue;
          for (let dj = -2; dj <= 2 && t < 0; dj++) {
            if (di === 0 && dj === 0) continue;
            const jj = ((j + dj) % this.meshLonBins + this.meshLonBins) % this.meshLonBins;
            t = this.rayMeshCell(ii * this.meshLonBins + jj, x, y, z, start, tris, idx, pts);
          }
        }
      }
      if (t >= 0) return t;
    }
    return fallback !== undefined ? fallback : this.heightAtDir(x, y, z);
  }

  /** Nearest triangle hit of a radial ray through one grid cell (Möller–Trumbore), or -1. */
  private rayMeshCell(cell: number, dx: number, dy: number, dz: number, start: Int32Array, tris: Int32Array, idx: Int32Array, pts: Float32Array): number {
    let best = -1;
    const end = start[cell + 1];
    for (let k = start[cell]; k < end; k++) {
      const tri = tris[k];
      const t = this.rayMeshTri(tri, dx, dy, dz, idx, pts);
      if (t > 0 && (best < 0 || t < best)) {
        best = t;
        this.meshTriHint = tri;
      }
    }
    return best;
  }

  /** Ray/triangle intersection for the radial ray (`dir` must be unit). Returns t or -1. */
  private rayMeshTri(tri: number, dx: number, dy: number, dz: number, idx: Int32Array, pts: Float32Array): number {
    const t3 = tri * 3;
    const a = idx[t3] * 3, b = idx[t3 + 1] * 3, c = idx[t3 + 2] * 3;
    const ax = pts[a], ay = pts[a + 1], az = pts[a + 2];
    const e1x = pts[b] - ax, e1y = pts[b + 1] - ay, e1z = pts[b + 2] - az;
    const e2x = pts[c] - ax, e2y = pts[c + 1] - ay, e2z = pts[c + 2] - az;
    // p = dir × e2
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) return -1;
    const inv = 1 / det;
    // u = (tvec · p) with tvec = -a
    const u = (-ax * px - ay * py - az * pz) * inv;
    if (u < -0.001 || u > 1.001) return -1;
    // q = tvec × e1
    const qx = (-ay) * e1z - (-az) * e1y;
    const qy = (-az) * e1x - (-ax) * e1z;
    const qz = (-ax) * e1y - (-ay) * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -0.001 || u + v > 1.001) return -1;
    return (e2x * qx + e2y * qy + e2z * qz) * inv;
  }

  /** Surface point directly "below" p (radial projection). */
  projectToSurface(p: THREE.Vector3): THREE.Vector3 {
    const d = _p.copy(p).normalize();
    return p.copy(d).multiplyScalar(this.heightAtDir(d.x, d.y, d.z));
  }

  surfacePointFromDir(dir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const h = this.heightAtDir(dir.x, dir.y, dir.z);
    return out.copy(dir).multiplyScalar(h);
  }

  /** Terrain (not radial) normal, for placing visuals on slopes. */
  terrainNormalAt(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const up = _up.copy(p).normalize();
    tangentBasis(up, _t1, _t2);
    const eps = 0.45 / this.radius;
    const h0 = this.heightAtDir(up.x, up.y, up.z);
    const d1 = _d1.copy(up).addScaledVector(_t1, eps).normalize();
    const d2 = _d2.copy(up).addScaledVector(_t2, eps).normalize();
    const h1 = this.heightAtDir(d1.x, d1.y, d1.z);
    const h2 = this.heightAtDir(d2.x, d2.y, d2.z);
    const step = eps * this.radius;
    const g1 = (h1 - h0) / step;
    const g2 = (h2 - h0) / step;
    return out.copy(up).addScaledVector(_t1, -g1).addScaledVector(_t2, -g2).normalize();
  }

  /** Rise/run at a point (0 = flat). Used for slope speed penalty + decoration placement. */
  slopeAt(p: THREE.Vector3): number {
    const up = _up.copy(p).normalize();
    tangentBasis(up, _t1, _t2);
    const eps = 0.45 / this.radius;
    const h0 = this.heightAtDir(up.x, up.y, up.z);
    const d1 = _d1.copy(up).addScaledVector(_t1, eps).normalize();
    const d2 = _d2.copy(up).addScaledVector(_t2, eps).normalize();
    const h1 = this.heightAtDir(d1.x, d1.y, d1.z);
    const h2 = this.heightAtDir(d2.x, d2.y, d2.z);
    const step = eps * this.radius;
    const g1 = (h1 - h0) / step;
    const g2 = (h2 - h0) / step;
    return Math.sqrt(g1 * g1 + g2 * g2);
  }

  /** March a ray against the analytic terrain; returns the first surface hit or null. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxT = 420, steps = 64): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    const sample = (t: number): number => {
      p.copy(origin).addScaledVector(dir, t);
      const len = p.length();
      if (len < 0.001) return -1;
      return len - this.heightAtDir(p.x / len, p.y / len, p.z / len);
    };
    let above = sample(0) > 0;
    let tPrev = 0;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * maxT;
      const aboveNow = sample(t) > 0;
      if (aboveNow !== above) {
        let a = tPrev, b = t;
        for (let k = 0; k < 12; k++) {
          const m = (a + b) * 0.5;
          if ((sample(m) > 0) === above) a = m;
          else b = m;
        }
        return new THREE.Vector3().copy(origin).addScaledVector(dir, (a + b) * 0.5);
      }
      above = aboveNow;
      tPrev = t;
    }
    return null;
  }

  dirFromAngles(latDeg: number, lonDeg: number, out: THREE.Vector3): THREE.Vector3 {
    return dirFromAngles(latDeg, lonDeg, out);
  }

  // ------------------------------------------------------------ environment (plan §1/§87)

  /**
   * Builds the reworked environment composition root (`WorldEnvironment`). The old per-planet
   * decoration pass is replaced by the cell-streamed systems under `world/`: deterministic,
   * instanced and budgeted (plan §19/§20/§43).
   */
  private createEnvironment(
    scene: THREE.Scene,
    quality: QualitySettings,
    seed: number,
    lights?: PlanetLights
  ): WorldEnvironment {
    const sun = lights?.sun ?? new THREE.DirectionalLight(0xfff0d8, 1.5);
    const hemi = lights?.hemi ?? new THREE.HemisphereLight(0xb9a6ff, 0x2a1d3d, 1.15);
    const rim = lights?.rim ?? new THREE.DirectionalLight(0x7a5cff, 0.35);
    const env = new WorldEnvironment({
      parent: scene,
      seed,
      qualityName: quality.name,
      radius: this.radius,
      terrain: this.terrain,
      biomeGen: this.biome,
      wind: this.wind,
      sun,
      hemi,
      rim,
      sceneForFog: scene,
    });

    // The environment streams its own content from cells (plan §19/§72); the game only declares
    // its gameplay keep-out zones later, via `growGrass()` → `setGameplayZones()`.
    return env;
  }

  alignOnSurface(obj: THREE.Object3D, dir: THREE.Vector3, forwardHint?: THREE.Vector3): THREE.Vector3 {
    const pos = new THREE.Vector3();
    this.surfacePointFromDir(dir, pos);
    const up = new THREE.Vector3().copy(dir);
    const fw = forwardHint ? _fw.copy(forwardHint) : _fw.set(0, 1, 0);
    orientToSurface(obj, pos, up, fw);
    return pos;
  }
}
