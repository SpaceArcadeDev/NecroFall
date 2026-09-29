// NECROFALL — PLANET TERRAIN PROVIDER (rework plan §0/§4/§5).
//
// THE seam between "what the ground is" and "what grows on the ground". Environment systems
// (foliage, water, props, physics, boss arenas) depend ONLY on this interface — never on
// `TerrainGenerator` internals — so the terrain algorithm can evolve (or be swapped for an
// improved field) without touching a single environment system.
//
// Implementation notes:
//   * `LegacyTerrainProvider` wraps today's `TerrainGenerator` + `BiomeGenerator`: the shipped
//     terrain contour IS the provider's macro field (plan §4: never replace it);
//   * the plan §5 detail layers (medium ridged + micro grain, domain-warped) are added ON TOP of
//     the macro field. They are deterministic, versioned (`environmentVersion`) and modest in
//     amplitude, so collision, walkability and the QA sweeps still hold;
//   * every sampling function is allocation-free and callable thousands of times per frame
//     (collision + raycasts + placement), so it stays within a few percent of the old cost.
import * as THREE from 'three';
import { clamp, fbm, tangentBasis } from '../../utils/Utils';
import type { BiomeClass, PlanetArchetype } from '../PlanetArchetypes';
import type { BiomeGenerator } from '../BiomeGenerator';
import type { TerrainGenerator } from '../TerrainGenerator';
import { TERRAIN_DETAIL, type EnvironmentConfig } from '../EnvironmentConfig';
import { valueNoise3 } from '../EnvironmentSeed';

/** A full surface description at one direction (plan §4 `sampleTerrain`). */
export interface TerrainSurfaceSample {
  /** Distance from the planet centre (radius + elevation). */
  height: number;
  /** Height above the reference radius (negative in basins). */
  elevation: number;
  /** Terrain (non-radial) normal. */
  normal: THREE.Vector3;
  /** Steepness as rise/run (0 = flat, ~2+ = cliff). */
  slope: number;
  /** Signed curvature proxy: >0 convex crest, <0 concave valley. */
  curvature: number;
  biome: BiomeClass;
  moisture: number;
  temperature: number;
  contamination: number;
  /** Water sphere radius for this world (0 = no water). */
  waterLevel: number;
  /** Water depth at this spot (negative when dry). */
  waterDepth: number;
}

export function createTerrainSample(): TerrainSurfaceSample {
  return {
    height: 0,
    elevation: 0,
    normal: new THREE.Vector3(0, 1, 0),
    slope: 0,
    curvature: 0,
    biome: 'DEAD',
    moisture: 0,
    temperature: 0,
    contamination: 0,
    waterLevel: 0,
    waterDepth: -1,
  };
}

/** The environment's single view of the ground (plan §0 step 7). */
export interface PlanetTerrainProvider {
  readonly radius: number;
  readonly seed: number;
  readonly archetype: PlanetArchetype;
  /** Macro field only (without the §5 detail layers) — used for regression comparisons. */
  baseHeight(x: number, y: number, z: number): number;
  /** The §5 detail layers alone (metres; 0 when terrain detail is disabled). */
  detailHeight(x: number, y: number, z: number): number;
  /** Terrain radius along a unit direction — macro + detail (what gameplay stands on). */
  getHeight(x: number, y: number, z: number): number;
  /** Terrain normal at a direction. */
  getNormal(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3;
  /** Rise/run at a direction. */
  getSlope(x: number, y: number, z: number): number;
  /** Biome class at a direction. */
  getBiome(x: number, y: number, z: number): BiomeClass;
  /** Surface moisture 0..1 (rivers + climate — plan §13 input). */
  getMoisture(x: number, y: number, z: number): number;
  /** Surface temperature 0..1 (latitude + climate — plan §13 input). */
  getTemperature(x: number, y: number, z: number): number;
  /** Necrotic contamination 0..1 (veins + climate — plan §13 input). */
  getContamination(x: number, y: number, z: number): number;
  /** Water sphere radius for this world (0 = no water). */
  readonly waterLevel: number;
  /** Fills in the full surface sample (plan §4). */
  getSurfaceInfo(x: number, y: number, z: number, out: TerrainSurfaceSample): TerrainSurfaceSample;
}

/** Per-direction scratch for normal/slope probes (module-level: sampling must not allocate). */
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _nt = new THREE.Vector3(0, 1, 0);
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

/**
 * Today's terrain generator, behind the provider interface. The macro field is untouched; the
 * §5 detail layers are the only addition, gated by `config.terrainDetail`.
 */
export class LegacyTerrainProvider implements PlanetTerrainProvider {
  readonly radius: number;
  readonly seed: number;
  readonly archetype: PlanetArchetype;
  /** Water sphere radius for this world (0 = no water). */
  readonly waterLevel: number;
  /** Detail-layer scale (0 disables — used by the regression harness to compare pure macro). */
  private readonly detail: number;

  constructor(
    private readonly gen: TerrainGenerator,
    private readonly biome: BiomeGenerator,
    config: Pick<EnvironmentConfig, 'terrainDetail' | 'planetSeed' | 'waterLevel'>,
    private readonly eps = 0.45
  ) {
    this.radius = gen.radius;
    this.seed = config.planetSeed >>> 0;
    this.archetype = gen.archetype;
    this.detail = clamp(config.terrainDetail, 0, 1);
    this.waterLevel = config.waterLevel;
  }

  baseHeight(x: number, y: number, z: number): number {
    return this.gen.sample(x, y, z);
  }

  /**
   * The plan §5 secondary layers, shaped to read as erosion rather than noise:
   *
   *   medium — domain-warped ridged noise (crests follow the warp, which mimics run-off lines);
   *   micro  — fine grain, damped near flat landmark sites so levelled arenas stay levelled.
   *
   * Both are pure functions of (position, seed): identical on every client, and stable when a
   * cell is unloaded and later rebuilt by the streaming system (plan §20/§59).
   */
  detailHeight(x: number, y: number, z: number): number {
    if (this.detail <= 0) return 0;
    const s = (this.seed ^ 0x51ed270b) >>> 0;
    const D = TERRAIN_DETAIL;
    // 1-octave warp — enough to bend the ridges, one noise call.
    const warp = valueNoise3(x * 0.45 + 3.1, y * 0.45 + 7.7, z * 0.45 + 1.3, s + 11) - 0.5;
    // Medium band: ridged (−1..1) so the layer adds crests AND hollows, not just lumpiness.
    const m = fbm(
      x * D.mediumFreq + warp * 0.9,
      y * D.mediumFreq + 2.2 + warp * 0.5,
      z * D.mediumFreq + 5.5,
      2,
      s + 23
    );
    const ridged = (1 - Math.abs(m * 2 - 1)) * 2 - 1;
    // Micro band: grain. Damped where the terrain generator carved a levelled landmark site,
    // so arenas/landing flats keep their engineered feel (terrain sites stay authoritative).
    const site = this.gen.lastSite();
    const siteDamp = 1 - clamp(site.t * 1.35, 0, 0.85);
    const micro = (fbm(x * D.microFreq + 8.8, y * D.microFreq + 4.4, z * D.microFreq + 6.6, 2, s + 37) - 0.5) * 2;
    return (ridged * D.mediumAmp + micro * D.microAmp) * this.detail * siteDamp;
  }

  getHeight(x: number, y: number, z: number): number {
    return this.gen.sample(x, y, z) + this.detailHeight(x, y, z);
  }

  getNormal(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    // Guard the poles for the tangent basis pick (`tangentBasis` prefers +X unless near it).
    _nt.set(x, y, z);
    if (_nt.lengthSq() < 1e-9) return out.set(0, 1, 0);
    _nt.normalize();
    tangentBasis(_nt, _t1, _t2);
    const eps = this.eps / this.radius;
    _n1.copy(_nt).addScaledVector(_t1, eps).normalize();
    _n2.copy(_nt).addScaledVector(_t2, eps).normalize();
    const h0 = this.getHeight(_nt.x, _nt.y, _nt.z);
    const h1 = this.getHeight(_n1.x, _n1.y, _n1.z);
    const h2 = this.getHeight(_n2.x, _n2.y, _n2.z);
    const step = eps * this.radius;
    const g1 = (h1 - h0) / step;
    const g2 = (h2 - h0) / step;
    return out.copy(_nt).addScaledVector(_t1, -g1).addScaledVector(_t2, -g2).normalize();
  }

  getSlope(x: number, y: number, z: number): number {
    _nt.set(x, y, z).normalize();
    tangentBasis(_nt, _t1, _t2);
    const eps = this.eps / this.radius;
    _n1.copy(_nt).addScaledVector(_t1, eps).normalize();
    _n2.copy(_nt).addScaledVector(_t2, eps).normalize();
    const h0 = this.getHeight(_nt.x, _nt.y, _nt.z);
    const h1 = this.getHeight(_n1.x, _n1.y, _n1.z);
    const h2 = this.getHeight(_n2.x, _n2.y, _n2.z);
    const step = eps * this.radius;
    const g1 = (h1 - h0) / step;
    const g2 = (h2 - h0) / step;
    return Math.sqrt(g1 * g1 + g2 * g2);
  }

  getBiome(x: number, y: number, z: number): BiomeClass {
    return this.biome.biomeAt(x, y, z);
  }

  getMoisture(x: number, y: number, z: number): number {
    return this.gen.moistureAt(x, y, z);
  }

  getTemperature(x: number, y: number, z: number): number {
    return this.gen.temperatureAt(x, y, z);
  }

  getContamination(x: number, y: number, z: number): number {
    const h = this.getHeight(x, y, z) - this.radius;
    return clamp(this.gen.corruptionAt(x, y, z) + (h < -6 ? this.archetype.veinStrength * 0.25 : 0), 0, 1);
  }

  /**
   * The full surface sample (plan §4). `height` includes the detail layers; climate fields come
   * from the macro generator (their own noise does not need the extra grain).
   */
  getSurfaceInfo(x: number, y: number, z: number, out: TerrainSurfaceSample): TerrainSurfaceSample {
    const height = this.getHeight(x, y, z);
    out.height = height;
    out.elevation = height - this.radius;
    this.getNormal(x, y, z, out.normal);
    out.slope = this.getSlope(x, y, z);
    out.moisture = this.gen.moistureAt(x, y, z);
    out.temperature = this.gen.temperatureAt(x, y, z);
    out.contamination = this.getContamination(x, y, z);
    out.biome = this.biome.biomeAt(x, y, z);
    out.waterLevel = this.waterLevel;
    out.waterDepth = this.waterLevel > 0 ? this.waterLevel - height : -1;
    return out;
  }

  /**
   * Curvature proxy used by placement (plan §17/§63/§64): the second difference of height along
   * the tangent basis, averaged over two axes. Positive = crest/ridge line, negative = hollow.
   * Not called in any per-frame hot path — placement passes only.
   */
  curvature(dir: THREE.Vector3, outScratch?: { a: THREE.Vector3; b: THREE.Vector3 }): number {
    const eps = 0.9 / this.radius;
    tangentBasis(dir, _t1, _t2);
    const a = outScratch?.a ?? _n1;
    const b = outScratch?.b ?? _n2;
    const h0 = this.getHeight(dir.x, dir.y, dir.z);
    const curve = (axis: THREE.Vector3): number => {
      a.copy(dir).addScaledVector(axis, eps).normalize();
      b.copy(dir).addScaledVector(axis, -eps).normalize();
      const hp = this.getHeight(a.x, a.y, a.z);
      const hm = this.getHeight(b.x, b.y, b.z);
      return (hp + hm - 2 * h0) / (eps * this.radius * (eps * this.radius));
    };
    return (curve(_t1) + curve(_t2)) * 0.5;
  }
}
