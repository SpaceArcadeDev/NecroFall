// NECROFALL — the planet: procedural spherical terrain (plan §57).
//
// After the Folio world rework this file owns TERRAIN DATA, GEOMETRY and SURFACE QUERIES only:
//
//   buildIcosphere()            — hand-built indexed icosphere (unchanged)
//   heightAtDir()               — the authoritative analytic field (TerrainGenerator)
//   meshHeightAtDir()           — the RENDERED surface lookup (triangles), unchanged
//   terrainNormalAt()/slopeAt() — contour sampling every system agrees on
//   raycast/projectToSurface    — analytic queries gameplay already relies on
//
// Rendering left this file: the terrain material is the Folio TSL material (TerrainVisual),
// the sky/vegetation/water/scenery live in `FolioWorld`. The biome classification + vertex colour
// bake stays here because it IS terrain data (the generator's own palette ramp).
import * as THREE from 'three/webgpu';
import { CONFIG, QualitySettings } from '../core/Config';
import { clamp, tangentBasis, dirFromAngles } from '../utils/Utils';
import { SHADER_GLOBALS, updateShaderGlobals } from './ShaderGlobals';
import { deriveArchetype, type PlanetArchetype } from './PlanetArchetypes';
import { TerrainGenerator } from './TerrainGenerator';
import { BiomeGenerator } from './BiomeGenerator';
import type { Landmark } from './LandmarkGenerator';
import { TerrainVisual } from './folio/terrain/TerrainVisual';
import { TERRAIN_PALETTE } from './folio/terrain/NecroFallTerrainNode';
import { FOLIO } from './folio/FolioShaderGlobals';

const _up = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Scratch [lat, lon] for the mesh lookup's bin maths: lat is y/|v| in [-1, 1], lon in radians. */
const _ll = new Float64Array(2);

/** Above this lat coordinate (cos 6°) a triangle can enclose a pole (see `eachMeshCell`). */
const POLE_ROW = 0.9945;

/**
 * Sea level as a fraction of the planet's MEASURED relief band (plan §19). The waterline is a
 * RADIUS: everything below renders submerged and dry land above it. One value for the whole
 * planet — the water system queries it through TerrainSurface.
 */
const WATER_FRACTION = 0.24;

/** Grid coordinates of a direction — insertion and query must agree on this exactly. */
function lonLatOf(x: number, y: number, z: number): void {
  const inv = 1 / Math.max(1e-9, Math.sqrt(x * x + y * y + z * z));
  _ll[0] = y * inv;
  _ll[1] = Math.atan2(z * inv, x * inv);
}

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

export class Planet {
  readonly radius = CONFIG.planetRadius;
  readonly seed: number;
  /**
   * Waterline in radius space (plan §19). Derived from THIS planet's measured relief once the
   * terrain is baked: a fixed depth below the mean left whole planets with no submerged basin at
   * all ("no water anywhere", live review 2026-09-30), so the sea level sits at a fraction of the
   * relief band and low basins always fill.
   */
  readonly waterLevel: number;
  /** Quality tier for the match. */
  private readonly quality: QualitySettings;
  /** The terrain: one mesh per sector (see `buildTerrainChunks`) so the far side can be skipped. */
  mesh: THREE.Group;
  /** Actual relief of THIS planet, measured while baking vertices (also the shader's height band). */
  readonly reliefMin: number;
  readonly reliefMax: number;
  private terrainChunks: THREE.Mesh[] = [];
  private chunkCenters: THREE.Vector3[] = [];
  private chunkRadii: number[] = [];
  private sunBase = new THREE.Vector3(1, 0.85, 0.6).normalize();
  /** Where the sun is being aimed (re-aimed at the local player each frame); `sunBase` eases
   *  towards it so the lit disc follows the action smoothly. */
  private readonly sunTarget = new THREE.Vector3(1, 0.85, 0.6).normalize();
  /** Region that receives most of the scenery (the battlefield). */
  readonly focusDir: THREE.Vector3 | null = null;
  /** The Folio terrain material + baked attributes (plan §6/§7). */
  private terrainVisual: TerrainVisual;
  /**
   * Spatial index over the RENDERED terrain triangles (see `meshHeightAtDir`). The drawn mesh
   * interpolates linearly between its ~2-4 m vertices, so on steep ground the visible surface sits
   * up to ~1 m above — and 1.8 m below — the analytic field the simulation runs on.
   */
  private meshLatBins = 0;
  private meshLonBins = 0;
  private meshCellStart: Int32Array | null = null;
  private meshCellTris: Int32Array | null = null;
  private meshTriIndex: Int32Array | null = null;
  private meshPoints: Float32Array | null = null;
  /** The planet's archetype (climate, relief parameters, palette, sky). */
  readonly archetype: PlanetArchetype;
  /** The height-field pipeline. */
  readonly terrain: TerrainGenerator;
  /** Biome classifier + palette. */
  readonly biome: BiomeGenerator;
  /** Deterministic landmarks carved into this world. */
  get landmarks(): readonly Landmark[] {
    return this.terrain.landmarks;
  }
  readonly fogColor = new THREE.Color(0x171029);
  readonly fogDensity = 0.00125;

  constructor(scene: THREE.Scene, quality: QualitySettings, seed: number, focusDir?: THREE.Vector3, ring = 0) {
    this.seed = seed;
    this.quality = quality;
    if (focusDir) this.focusDir = focusDir.clone().normalize();

    // ---- the world pipeline: seed (+rank ring) → archetype → terrain fields → biome
    this.archetype = deriveArchetype(seed, ring);
    this.terrain = new TerrainGenerator(seed, this.radius, this.archetype, ring, this.focusDir ?? undefined);
    this.biome = new BiomeGenerator(this.archetype, this.terrain);
    this.fogColor.setHex(this.archetype.sky.fog);

    // ---- share the planet's lighting/fog identity with the Folio material family
    FOLIO.fog.color.value.copy(this.fogColor);
    FOLIO.fog.density.value = this.fogDensity;
    FOLIO.lighting.bounceColor.value.setHex(this.archetype.palette.low);
    FOLIO.necro.veinColor.value.setHex(this.archetype.palette.vein);
    FOLIO.necro.intensity.value = Math.min(1, 0.35 + this.archetype.veinStrength * 0.45);
    if (this.focusDir) FOLIO.necro.focusDirection.value.copy(this.focusDir);

    // ---- terrain geometry: displacement + biome vertex colours (material comes from TerrainVisual)
    const geo = buildIcosphere(quality.planetDetail);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const scratch = new THREE.Color();
    const v = new THREE.Vector3();
    let reliefMin = Infinity;
    let reliefMax = -Infinity;
    // PASS 1 — positions from the height pipeline (the biome step needs the SHAPE first)
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      const h = this.heightAtDir(v.x, v.y, v.z);
      pos.setXYZ(i, v.x * h, v.y * h, v.z * h);
      if (h < reliefMin) reliefMin = h;
      if (h > reliefMax) reliefMax = h;
    }
    this.reliefMin = Number.isFinite(reliefMin) ? reliefMin : this.radius - 8;
    this.reliefMax = Number.isFinite(reliefMax) ? reliefMax : this.radius + 20;
    // Sea level from the measured band: everything below floods, so every planet ships water in
    // its low basins. Capped just below the mean surface so plains stay dry.
    const reliefSpan = Math.max(1e-3, this.reliefMax - this.reliefMin);
    this.waterLevel = Math.min(
      this.reliefMin + reliefSpan * WATER_FRACTION,
      this.radius - 1,
    );
    // The shared palette uniforms must reflect THIS planet before any Folio material samples
    // them (grass blade bases, terrain washes, water proximity). Writing them here — right next
    // to the measurements themselves — keeps the values authoritative even if module graphs
    // ever split (live bug 2026-09-30: the grass field sat at radius 0, buried inside the
    // planet, because these uniforms kept their 0/0/-1 defaults for the running match).
    TERRAIN_PALETTE.reliefMin.value = this.reliefMin;
    TERRAIN_PALETTE.reliefMax.value = this.reliefMax;
    TERRAIN_PALETTE.waterline01.value = clamp((this.waterLevel - this.reliefMin) / reliefSpan, 0, 1);
    // The FOLIO copy is the one the grass/terrain/water materials provably share (wind + lighting
    // already flow through it every frame).
    FOLIO.terrain.reliefMin.value = this.reliefMin;
    FOLIO.terrain.reliefMax.value = this.reliefMax;
    FOLIO.terrain.waterline01.value = clamp((this.waterLevel - this.reliefMin) / reliefSpan, 0, 1);
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

    // ---- Folio terrain material + baked shader attributes (slope/height/moisture/corruption)
    this.terrainVisual = new TerrainVisual(this, geo);

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
   * the old single mesh.
   */
  private buildTerrainChunks(geo: THREE.BufferGeometry): void {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const idx = geo.index as THREE.BufferAttribute;
    const CHUNKS = 32;
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
      chunk.setAttribute('aTerrain', geo.attributes.aTerrain);
      chunk.setAttribute('aVeg', geo.attributes.aVeg);
      chunk.setIndex(list);
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
      const mesh = new THREE.Mesh(chunk, this.terrainVisual.material);
      mesh.name = `terrain-chunk-${s}`;
      mesh.frustumCulled = true;
      mesh.receiveShadow = true;
      this.terrainChunks.push(mesh);
      this.chunkCenters.push(center);
      this.chunkRadii.push(radius);
      this.mesh.add(mesh);
    }
  }

  /**
   * Horizon culling: from a camera `h` above the surface the planet's own curve hides everything
   * beyond a small cap. A chunk is kept unless its whole bounding sphere sits below the horizon
   * plane through the eye; the conservative test is `dot(C, P) + r·|P| <= R²`, with 3 % slack.
   */
  private updateTerrainChunks(cameraPos: THREE.Vector3): void {
    const n = this.terrainChunks.length;
    if (n === 0) return;
    const d = cameraPos.length();
    // The horizon test below is only valid for an eye clearly above the planet's terrain
    // envelope. The surface itself climbs past the base radius (reliefMax > radius), and the
    // third-person camera flies ~20 m above the player, so anything short of "obviously in
    // orbit" must keep every chunk; otherwise the far-side cull wipes out nearby terrain and
    // the background shows through.
    if (d <= this.reliefMax + 60) {
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
   * Aim the lit hemisphere at a region of the planet so the contested play area is never
   * stuck on the night side. Writes the TARGET only — `update()` eases the sun towards it, so
   * the lit disc keeps following the local player (the local lighting then stays constant
   * while roaming a whole planet: a static sun always leaves a terminator to walk into —
   * "the light keeps changing as I move", live review 2026-09-30).
   */
  aimSunAt(dir: THREE.Vector3): void {
    tangentBasis(dir, _t1, _t2);
    this.sunTarget.copy(dir).multiplyScalar(0.62).addScaledVector(_t1, 0.72).addScaledVector(_t2, 0.22).normalize();
  }

  /** Per-frame uniform updates (shared by the GLSL gameplay shaders and the Folio materials). */
  update(dt: number, cameraPos: THREE.Vector3): void {
    updateShaderGlobals(dt, cameraPos);
    // Ease the sun towards its aim (Game re-aims it at the local player every frame): the lit
    // disc then FOLLOWS the action, and the local lighting stays constant instead of the player
    // walking into the day/night terminator — the "light keeps flickering/changing as I move"
    // report (live review 2026-09-30). Slow enough that normal walking never visibly turns the
    // sun; fast enough that spawn/recall jumps settle within a second.
    this.sunBase.lerp(this.sunTarget, clamp(dt * 1.6, 0, 1)).normalize();
    SHADER_GLOBALS.uSunDir.value.copy(this.sunBase);
    // The Folio family reads the same sun through its own uniform.
    FOLIO.lighting.direction.value.copy(SHADER_GLOBALS.uSunDir.value);
    FOLIO.lighting.color.value.copy(SHADER_GLOBALS.uSunColor.value);
    FOLIO.lighting.intensity.value = 1;
    FOLIO.fog.color.value.copy(SHADER_GLOBALS.uFogColor.value);
    FOLIO.fog.density.value = SHADER_GLOBALS.uFogDensity.value;
    FOLIO.lighting.skyColor.value.copy(SHADER_GLOBALS.uSkyColor.value);
    FOLIO.lighting.groundColor.value.copy(SHADER_GLOBALS.uGroundColor.value);
    FOLIO.lighting.rimColor.value.copy(SHADER_GLOBALS.uRimColor.value);

    // The planet hides its own far side from a low camera.
    this.updateTerrainChunks(cameraPos);
  }

  /** Tears down every GPU resource so a freshly seeded planet can take its place. */
  dispose(): void {
    this.mesh.removeFromParent();
    for (const child of [...this.mesh.children]) (child as THREE.Mesh).geometry.dispose();
    this.mesh.clear();
    this.terrainChunks.length = 0;
    this.chunkCenters.length = 0;
    this.chunkRadii.length = 0;
    this.terrainVisual.dispose();
    this.meshCellStart = null;
    this.meshCellTris = null;
    this.meshTriIndex = null;
    this.meshPoints = null;
  }

  // ------------------------------------------------------------ heightfield

  /** Terrain radius (distance from planet centre) along a unit direction. */
  heightAtDir(x: number, y: number, z: number): number {
    return this.terrain.sample(x, y, z);
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
    for (let t = 0; t < triCount; t++) this.eachMeshCell(t, triIndex, pts, (i, j) => { start[i * lonBins + j + 1]++; });
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    const tris = new Int32Array(start[cells]);
    const fill = start.slice(0, cells);
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
   * Radius of the RENDERED terrain surface along a unit direction — exactly where the drawn
   * ground is (the mesh interpolates linearly inside each triangle).
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
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) return -1;
    const inv = 1 / det;
    const u = (-ax * px - ay * py - az * pz) * inv;
    if (u < -0.001 || u > 1.001) return -1;
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
}
