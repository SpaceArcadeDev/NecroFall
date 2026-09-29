// NECROFALL — TERRAIN SURFACE QUERY (rework plan §4/§13/§17/§62/§63/§64).
//
// The shared "what is the ground like here" layer used by every environment system:
//
//   * `sample()`        — the plan §4 full surface sample (height, normal, slope, curvature,
//                          biome, moisture, temperature, contamination, water);
//   * `habitatAt()`     — ONE coherent density field per spot (grass/tree/rock/prop weights from
//                          slope + moisture + contamination + biome + landform), so all systems
//                          agree about which parts of a planet are lush and which are barren;
//   * `traversalAt()`   — WALKABLE / DIFFICULT / BLOCKED classification (plan §64) used to keep
//                          environment placement out of gameplay paths;
//   * `arenaSuitability()` — plan §63 arena scoring from the terrain itself (flatness, area,
//                          water, obstruction, accessibility) — boss arenas are *found*, not
//                          stamped into the world.
import * as THREE from 'three';
import { clamp, smoothstep, tangentBasis } from '../../utils/Utils';
import type { BiomeClass } from '../PlanetArchetypes';
import {
  createTerrainSample,
  type PlanetTerrainProvider,
  type TerrainSurfaceSample,
} from './PlanetTerrainProvider';

/** Traversal classification (plan §64). */
export type TraversalClass = 0 | 1 | 2;
export const WALKABLE: TraversalClass = 0;
export const DIFFICULT: TraversalClass = 1;
export const BLOCKED: TraversalClass = 2;

export const TRAVERSAL_NAMES: Record<TraversalClass, string> = {
  0: 'WALKABLE',
  1: 'DIFFICULT',
  2: 'BLOCKED',
};

/** Per-spot habitat weights shared by every placement system (0..~1.6). */
export interface HabitatSample {
  /** How friendly this spot is to herbaceous ground cover. */
  grass: number;
  /** Tree suitability (moisture-dependent, slope-limited). */
  tree: number;
  /** Rock/rubble suitability (slope + crest + contamination). */
  rock: number;
  /** Manufactured debris / structure suitability (flat-ish, near landmarks). */
  prop: number;
  /** Contamination at this spot (0..1) — drives the necrotic palette. */
  contamination: number;
  moisture: number;
  temperature: number;
}

export function createHabitat(): HabitatSample {
  return { grass: 0, tree: 0, rock: 0, prop: 0, contamination: 0, moisture: 0, temperature: 0 };
}

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _q = new THREE.Vector3();

/** Per-biome habitat character (multiplies the continuous fields below). */
const BIOME_HABITAT: Record<BiomeClass, { grass: number; tree: number; rock: number; prop: number }> = {
  TOXIC: { grass: 0.5, tree: 1.1, rock: 0.7, prop: 0.8 },
  OCEAN: { grass: 0.35, tree: 0.5, rock: 1.0, prop: 0.7 },
  DESERT: { grass: 0.18, tree: 0.22, rock: 1.1, prop: 0.9 },
  FUNGAL: { grass: 1.0, tree: 1.35, rock: 0.5, prop: 0.5 },
  VOLCANIC: { grass: 0.25, tree: 0.3, rock: 1.3, prop: 0.7 },
  FROZEN: { grass: 0.3, tree: 0.4, rock: 0.85, prop: 0.6 },
  CRYSTAL: { grass: 0.4, tree: 0.5, rock: 1.2, prop: 0.5 },
  SWAMP: { grass: 0.9, tree: 1.25, rock: 0.45, prop: 0.6 },
  CORRUPTED: { grass: 0.55, tree: 0.9, rock: 0.9, prop: 0.8 },
  DEAD: { grass: 0.35, tree: 0.75, rock: 1.0, prop: 1.0 },
  JUNGLE: { grass: 1.15, tree: 1.5, rock: 0.4, prop: 0.4 },
  ABYSSAL: { grass: 0.25, tree: 0.35, rock: 1.1, prop: 0.6 },
};

/**
 * Higher-level surface queries. One instance per planet; allocation-free per call (pass `out`).
 */
export class TerrainSurfaceQuery {
  private readonly sample: TerrainSurfaceSample = createTerrainSample();
  private readonly habitat: HabitatSample = createHabitat();

  constructor(private readonly provider: PlanetTerrainProvider) {}

  get radius(): number {
    return this.provider.radius;
  }

  /** Water sphere radius for this world (0 = no water). */
  get waterLevel(): number {
    return this.provider.waterLevel;
  }

  /** Full surface sample at a direction (plan §4). */
  sampleAt(dir: THREE.Vector3, out: TerrainSurfaceSample = this.sample): TerrainSurfaceSample {
    return this.provider.getSurfaceInfo(dir.x, dir.y, dir.z, out);
  }

  /** Water depth (>0 = submerged) without the full sample. */
  waterDepthAt(dir: THREE.Vector3): number {
    const level = this.waterLevel;
    if (level <= 0) return -1;
    return level - this.provider.getHeight(dir.x, dir.y, dir.z);
  }

  /** True when the spot is above the water line (foliage must not grow in water). */
  dryAt(dir: THREE.Vector3): boolean {
    const level = this.waterLevel;
    return level <= 0 || this.provider.getHeight(dir.x, dir.y, dir.z) > level + 0.15;
  }

  /**
   * THE shared habitat field (plan §7/§13/§17): one evaluation gives every system the same
   * answer about a spot. Density = biome character × slope usability × moisture/growth ×
   * contamination × landform band.
   */
  habitatAt(dir: THREE.Vector3, out: HabitatSample = this.habitat, treeLine = 30): HabitatSample {
    const p = this.provider;
    const h = p.getHeight(dir.x, dir.y, dir.z);
    const slope = p.getSlope(dir.x, dir.y, dir.z);
    const moist = p.getMoisture(dir.x, dir.y, dir.z);
    const temp = p.getTemperature(dir.x, dir.y, dir.z);
    const corr = p.getContamination(dir.x, dir.y, dir.z);
    const biome = p.getBiome(dir.x, dir.y, dir.z);
    const char = BIOME_HABITAT[biome];
    const elevation = h - p.radius;

    // slope usability: 0 on cliffs, 1 on flats (grass and trees need flat-ish ground; rocks like
    // steep faces, so their factor is roughly the complement with a crest bonus)
    const flat = 1 - smoothstep(0.35, 1.15, slope);
    const steep = smoothstep(0.45, 1.5, slope);
    // above the tree line only rock survives (metres above the reference radius)
    const alt = 1 - smoothstep(treeLine, treeLine + 18, elevation);
    // below the water line only water plants (handled by the shoreline system)
    const level = this.waterLevel;
    const dry = level > 0 ? smoothstep(level, level + 1.3, h) : 1;

    out.moisture = moist;
    out.temperature = temp;
    out.contamination = corr;
    out.grass = clamp(char.grass * (0.55 + moist * 0.85) * flat * dry * alt * (1 - corr * 0.25), 0, 1.6);
    out.tree = clamp(char.tree * (0.25 + moist * 1.1) * flat * dry * alt, 0, 1.6);
    out.rock = clamp(char.rock * (0.35 + steep * 1.1 + corr * 0.3) * (0.8 + dry * 0.2), 0, 1.6);
    out.prop = clamp(char.prop * (0.35 + flat * 0.9) * dry, 0, 1.6);
    return out;
  }

  /** Traversal classification used to keep placement off gameplay paths (plan §64). */
  traversalAt(dir: THREE.Vector3): TraversalClass {
    const p = this.provider;
    const slope = p.getSlope(dir.x, dir.y, dir.z);
    const depth = this.waterDepthAt(dir);
    if (depth > 0.35) return BLOCKED;              // water is not walkable in NecroFall
    if (slope > 1.35) return BLOCKED;              // unclimbable face
    if (slope > 0.62) return DIFFICULT;            // slow, but passable
    return WALKABLE;
  }

  /**
   * Arena suitability score (plan §63): how well the terrain around `center` behaves as a boss
   * arena. Flatness dominates; water, obstruction (rough ground) and accessibility (a walkable
   * margin) adjust it. Deterministic sampling in a spiral disc — no randomness.
   */
  arenaSuitability(center: THREE.Vector3, radiusRad: number, samples = 12): number {
    const p = this.provider;
    tangentBasis(center, _t1, _t2);
    let flatSum = 0;
    let roughCount = 0;
    let wet = 0;
    const level = this.waterLevel;
    for (let i = 0; i < samples; i++) {
      const t = (i + 0.5) / samples;
      const r = Math.sqrt(t) * radiusRad;
      const a = i * 2.3999632297286533; // golden angle
      _q.copy(center)
        .addScaledVector(_t1, Math.cos(a) * r)
        .addScaledVector(_t2, Math.sin(a) * r)
        .normalize();
      const slope = p.getSlope(_q.x, _q.y, _q.z);
      flatSum += 1 - clamp(slope / 1.2, 0, 1);
      if (slope > 0.85) roughCount++;
      if (level > 0 && p.getHeight(_q.x, _q.y, _q.z) < level + 0.1) wet++;
    }
    const n = samples;
    const flatness = flatSum / n;
    const obstruction = 1 - roughCount / n;
    const dryness = 1 - wet / n;
    return clamp(flatness * 0.55 + obstruction * 0.25 + dryness * 0.2, 0, 1);
  }

  /** One-off world position of a surface point (allocates — placement callers only). */
  surfacePoint(dir: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3().copy(dir).multiplyScalar(this.provider.getHeight(dir.x, dir.y, dir.z));
  }
}
