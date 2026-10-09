// NECROFALL — the planet facade (migration phase 3).
//
// This class is the CONTRACT every gameplay system consumes (as a type) — GameCamera, Effects,
// Telegraphs, InputManager, AimPreview, PowerLines, Towers, Bases, Enemies, Player … — so its
// public surface is frozen (plan §57). After the migration it owns TERRAIN DATA and SURFACE
// QUERIES only:
//
//   heightAtDir()               — the authoritative analytic field (TerrainGenerator)
//   meshHeightAtDir()           — the RENDERED surface lookup (the new stack's terrain mesh)
//   terrainNormalAt()/slopeAt() — contour sampling every system agrees on
//   raycast/projectToSurface    — analytic queries gameplay already relies on
//
// Rendering left this file: the terrain/vegetation/water visuals are built by the folio-style
// stack (`PlanetRenderer`, via `attachWorld`) and the match world streams in behind the queries.
// Until the world reports its measured relief, every query answers from the analytic generator —
// identical numbers, because both sides run the SAME `TerrainGenerator`.
import * as THREE from 'three/webgpu';
import { CONFIG, QualitySettings } from '../core/Config';
import { clamp, tangentBasis, dirFromAngles } from '../utils/Utils';
import { SHADER_GLOBALS, updateShaderGlobals } from './ShaderGlobals';
import { deriveArchetype, type PlanetArchetype } from './PlanetArchetypes';
import { TerrainGenerator } from './TerrainGenerator';
import { BiomeGenerator } from './BiomeGenerator';
import type { Landmark } from './LandmarkGenerator';
import { NECRO_UNIFORMS, syncNecroChunks } from '../rendering/materials/NecroChunks';

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
 * RADIUS: everything below renders submerged and dry land above it. Must mirror
 * `PlanetSurfaceData` (same 24 % law) so gameplay and shaders agree.
 */
const WATER_FRACTION = 0.24;

/** Grid coordinates of a direction — insertion and query must agree on this exactly. */
function lonLatOf(x: number, y: number, z: number): void {
  const inv = 1 / Math.max(1e-9, Math.sqrt(x * x + y * y + z * z));
  _ll[0] = y * inv;
  _ll[1] = Math.atan2(z * inv, x * inv);
}

/** What the world layer reports back once the match planet finished measuring/building. */
export interface PlanetWorldAttachment {
  /** The rendered terrain mesh whose surface gameplay must stand on (null = analytic only). */
  terrainMesh: THREE.Mesh | null;
  reliefMin: number;
  reliefMax: number;
  waterLevel: number;
  /** Environment visibility switch (rescue levels) — wired to the world's decoration systems. */
  setDecorationsVisible?: (visible: boolean) => void;
  /** Ambient particle budget (watchdog hook). */
  setAmbienceBudget?: (mul: number) => void;
}

export class Planet {
  readonly radius = CONFIG.planetRadius;
  readonly seed: number;
  /** Rank ring the match plays on (shapes the archetype + ecology) — 0 outside ranked runs. */
  readonly ring: number;
  private readonly quality: QualitySettings;
  /** Kept for API compatibility; the rendered terrain lives in the world layer now. */
  mesh: THREE.Group;

  /** Actual relief of THIS planet, measured by the world bake (analytic fallbacks until then). */
  reliefMin: number;
  reliefMax: number;
  /** Radius of the local waterline (set by the world bake; `radius − 1` until then). */
  waterLevel: number;

  private sunBase = new THREE.Vector3(1, 0.85, 0.6).normalize();
  /** Where the sun is being aimed (re-aimed at the local player each frame); `sunBase` eases
   *  towards it so the lit disc follows the action smoothly. */
  private readonly sunTarget = new THREE.Vector3(1, 0.85, 0.6).normalize();

  /** Region that receives most of the scenery (the battlefield). */
  readonly focusDir: THREE.Vector3 | null = null;

  // ---- rendered-surface lookup over the world's terrain mesh (see `meshHeightAtDir`)
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

  // ---- world attachment (what the visuals/gameplay bridge reported)
  private world: PlanetWorldAttachment | null = null;
  private decorationsVisible = true;
  private ambienceMul = 1;
  private windTime = 0;

  constructor(_scene: THREE.Scene, quality: QualitySettings, seed: number, focusDir?: THREE.Vector3, ring = 0) {
    this.seed = seed;
    this.ring = ring;
    this.quality = quality;
    if (focusDir) this.focusDir = focusDir.clone().normalize();

    // ---- the world pipeline: seed (+rank ring) → archetype → terrain fields → biome
    this.archetype = deriveArchetype(seed, ring);
    this.terrain = new TerrainGenerator(seed, this.radius, this.archetype, ring, this.focusDir ?? undefined);
    this.biome = new BiomeGenerator(this.archetype, this.terrain);
    this.fogColor.setHex(this.archetype.sky.fog);

    // Playable-world defaults until the match bake reports the measured band (mirrors the
    // legacy icosphere fallbacks so early queries on any planet answer sanely).
    this.reliefMin = this.radius - 8;
    this.reliefMax = this.radius + 20;
    this.waterLevel = this.radius - 1;

    this.mesh = new THREE.Group();
    this.mesh.name = 'terrain';

    // Share the planet's identity with the shader family the gameplay materials read. The TSL
    // side mirrors SHADER_GLOBALS through NecroChunks; the value store stays in ShaderGlobals.
    syncNecroChunks();
  }

  /**
   * Called by the game once the folio world finished building for THIS match: adopts the measured
   * relief/waterline and builds the rendered-surface lookup over the world's terrain mesh.
   */
  attachWorld(attachment: PlanetWorldAttachment): void {
    this.world = attachment;
    if (Number.isFinite(attachment.reliefMin)) this.reliefMin = attachment.reliefMin;
    if (Number.isFinite(attachment.reliefMax)) this.reliefMax = attachment.reliefMax;
    if (Number.isFinite(attachment.waterLevel) && attachment.waterLevel > 0) {
      this.waterLevel = attachment.waterLevel;
    } else {
      const span = Math.max(1e-3, this.reliefMax - this.reliefMin);
      this.waterLevel = Math.min(this.reliefMin + span * WATER_FRACTION, this.radius - 1);
    }
    const geometry = attachment.terrainMesh?.geometry;
    if (geometry?.index) this.buildMeshLookup(geometry);
    // Re-apply the switches that were set before the world finished loading.
    attachment.setDecorationsVisible?.(this.decorationsVisible);
    attachment.setAmbienceBudget?.(this.ambienceMul);
  }

  /**
   * Aim the lit hemisphere at a region of the planet so the contested play area is never
   * stuck on the night side. Writes the TARGET only — `update()` eases the sun towards it, so
   * the lit disc keeps following the local player (a static sun always leaves a terminator to
   * walk into — "the light keeps changing as I move", live review 2026-09-30).
   */
  aimSunAt(dir: THREE.Vector3): void {
    tangentBasis(dir, _t1, _t2);
    this.sunTarget.copy(dir).multiplyScalar(0.62).addScaledVector(_t1, 0.72).addScaledVector(_t2, 0.22).normalize();
  }

  setSunDirection(direction: THREE.Vector3): void {
    this.sunBase.copy(direction).normalize();
    this.sunTarget.copy(this.sunBase);
  }

  /** Per-frame uniform updates (shared by the gameplay materials and the world layer). */
  update(dt: number, cameraPos: THREE.Vector3): void {
    updateShaderGlobals(dt, cameraPos);
    // Ease the sun towards its aim (Game re-aims it at the local player every frame): the lit
    // disc then FOLLOWS the action, and the local lighting stays constant instead of the player
    // walking into the day/night terminator. Slow enough that normal walking never visibly turns
    // the sun; fast enough that spawn/recall jumps settle within a second.
    this.sunBase.lerp(this.sunTarget, clamp(dt * 1.6, 0, 1)).normalize();
    SHADER_GLOBALS.uSunDir.value.copy(this.sunBase);

    // ---- wind: direction wanders slowly, strength gusts in waves (kept from the legacy planet;
    // the TSL side carries it through NECRO_UNIFORMS for every wind-aware gameplay material).
    this.windTime += dt;
    const t = this.windTime;
    const angle = Math.sin(t * 0.037) * 0.5 + Math.sin(t * 0.013 + 1.7) * 0.9;
    syncNecroChunks({
      dir: { x: Math.cos(angle), y: Math.sin(angle) },
      strength: 0.85 + Math.sin(t * 0.21) * 0.17,
      gust: 0.5 + Math.sin(t * 0.083 + 0.4) * 0.5,
    });
  }

  /** Scales the ambient point clouds (watchdog hook — forwarded to the world's particles). */
  setAmbienceBudget(mul: number): void {
    this.ambienceMul = mul;
    this.world?.setAmbienceBudget?.(mul);
  }

  /** Grows the dense grass (legacy API): the folio world grows its own lawn at match build, so
   *  this only keeps the call sites that pre-date the migration working. */
  growGrass(_zones: THREE.Vector3[]): void {
    // The whole planet's lawn is part of `PlanetRenderer.create` now (patch-driven, no zones).
  }

  /** Hide/show the decorative environment (rescue levels) — forwarded to the world layer. */
  setDecorationsVisible(visible: boolean): void {
    this.decorationsVisible = visible;
    this.world?.setDecorationsVisible?.(visible);
  }

  /** Tears down the facade's own bookkeeping. The world layer disposes its resources itself. */
  dispose(): void {
    this.meshCellStart = null;
    this.meshCellTris = null;
    this.meshTriIndex = null;
    this.meshPoints = null;
    this.world = null;
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
   * ground is (the mesh interpolates linearly inside each triangle). Falls back to the analytic
   * field until the world's terrain mesh has been attached.
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

  /** Rise/run at a point (0 = flat). Used for slope speed penalty + placement. */
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
    return Math.hypot(g1, g2);
  }

  // ------------------------------------------------------------ picking

  /** Ray vs. analytic terrain (bisection march). Returns the first surface hit point or null. */
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
