// NECROFALL — VegetationGenerator (plan §13, §18, §66, §67, §80): WHAT exists in the world and
// WHERE. Deterministic from the match seed — two peers with the same seed build identical
// forests without a single byte of network traffic (plan §68).
//
// Rules, in order of authority:
//   1. terrain (the ONE surface): water, slope, altitude and the biome weights gate every spot;
//   2. combat readability: tower capture zones, spawns and the battlefield centre stay clear of
//      anything tall (plan §47/§48);
//   3. biome palette: the kind of tree/bush is the biome's controlled asset palette (§63);
//   4. minimum separation: a spherical spatial hash keeps clusters from stacking (§42);
//   5. root sink: trunks sink to the MINIMUM of four tangent probes, so nothing floats and
//      nothing perches on a slope's downhill edge (§80).
import * as THREE from 'three/webgpu';
import { clamp, Rand, tangentBasis } from '../../utils/Utils';
import { BiomeField, createBiomeWeights } from '../biomes/BiomeField';
import { pickTreeKind, ruleForWeights } from '../biomes/BiomeRules';
import type { TerrainSurface } from '../TerrainSurface';
import { SHARED_FRAME } from '../surface/SurfaceFrame';
import { angularDistance, VegetationSpatialHash } from './VegetationSpatialHash';
import {
  emptyPlacements,
  type EnvironmentPlacements,
  type FlowerPlacement,
  type RockPlacement,
  type SceneryKind,
  type SceneryPlacement,
  type TreePlacement,
  type BushPlacement,
} from './VegetationTypes';

export interface VegetationBudget {
  trees: number;
  bushes: number;
  /** Flower CLUSTERS (each blooms 3-9 flowers). */
  flowers: number;
  scenery: number;
  rocks: number;
}

export interface VegetationZones {
  /** Tower centres (capture zones stay readable). */
  towers: THREE.Vector3[];
  /** Battlefield centre — dressed deliberately, kept clear of clutter. */
  focus: THREE.Vector3 | null;
  /** Player spawn points (kept clear so nobody wakes up inside a tree). */
  spawns: THREE.Vector3[];
}

export interface VegetationGeneratorOptions {
  surface: TerrainSurface;
  seed: number;
  budget: VegetationBudget;
  zones: VegetationZones;
  moistureAt(x: number, y: number, z: number): number;
  corruptionAt(x: number, y: number, z: number): number;
  reliefMin: number;
  reliefMax: number;
}

/** Angular clearances (radians of arc) around gameplay-critical spots. */
const CLEARANCE = {
  tower: 13, // metres of arc
  spawn: 7,
  focus: 16,
};

/** Everything one generator run produces, plus the sparse hash for later queries. */
export interface VegetationResult {
  placements: EnvironmentPlacements;
  /** Tree positions by direction — the physics + occlusion systems query this. */
  treeHash: VegetationSpatialHash<{ dir: THREE.Vector3; placement: TreePlacement }>;
}

export class VegetationGenerator {
  private readonly biomeField: BiomeField;
  private readonly weights = createBiomeWeights();
  /** Separation-check scratch, typed for the plain hash variant. */
  private readonly genericScratch: Array<{ dir: THREE.Vector3 }> = [];
  /** Separation check inside generateTrees (its hash stores the placement too). */
  private readonly treeQueryScratch: Array<{ dir: THREE.Vector3; placement: TreePlacement }> = [];

  constructor(private readonly options: VegetationGeneratorOptions) {
    this.biomeField = new BiomeField(options.surface);
  }

  generate(): VegetationResult {
    const placements = emptyPlacements();
    const treeHash = new VegetationSpatialHash<{ dir: THREE.Vector3; placement: TreePlacement }>();

    this.generateTrees(placements, treeHash);
    this.generateBushes(placements);
    this.generateFlowers(placements);
    this.generateRocks(placements);
    // NOTE: the scenery kit (benches / lampposts / crates / bricks &c) is no longer placed —
    // user call 2026-09-30 (it did not fit the game and its nested GLB transforms hovered).

    return { placements, treeHash };
  }

  // ------------------------------------------------------------------ shared helpers

  /** Deterministic per-category RNG stream (plan §67: hash(seed, category)). */
  private stream(category: number): Rand {
    const mixed = (this.options.seed ^ (category * 0x9e3779b9)) >>> 0;
    return new Rand(mixed || 1);
  }

  /** Angular clearance test against the gameplay zones (plan §47). */
  private inClearance(dir: THREE.Vector3, metres: number): boolean {
    const radius = this.options.surface.radius;
    const angular = metres / Math.max(1, radius);
    for (const tower of this.options.zones.towers) {
      if (angularDistance(dir, tower) < angular + CLEARANCE.tower / radius) return true;
    }
    for (const spawn of this.options.zones.spawns) {
      if (angularDistance(dir, spawn) < angular + CLEARANCE.spawn / radius) return true;
    }
    if (this.options.zones.focus && angularDistance(dir, this.options.zones.focus) < CLEARANCE.focus / radius) {
      return true;
    }
    return false;
  }

  /** Uniform direction, biased towards the battlefield cap (the region fights happen in). */
  private sampleDirection(rand: Rand, focusChance: number): THREE.Vector3 {
    const focus = this.options.zones.focus;
    if (focus && rand.chance(focusChance)) {
      tangentBasis(focus, _t1, _t2);
      const a = rand.range(0, Math.PI * 2);
      const r = Math.sqrt(rand.next()) * 0.9;
      return new THREE.Vector3()
        .copy(focus)
        .multiplyScalar(Math.cos(r))
        .addScaledVector(_t1, Math.cos(a) * Math.sin(r))
        .addScaledVector(_t2, Math.sin(a) * Math.sin(r))
        .normalize();
    }
    // uniform sphere
    const z = rand.range(-1, 1);
    const a = rand.range(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return new THREE.Vector3(r * Math.cos(a), z, r * Math.sin(a));
  }

  /**
   * Fill the shared frame for a direction, including the root-sink height (plan §80) and the
   * packed terrain data every shader + rule reads afterwards.
   *
   * `probeScale` widens the sink probe ring with the item's size and `sinkExtra` buries the base
   * by a fraction of it — together they keep big rocks and bushes ON the contour instead of
   * hovering at a slope's downhill edge (live review 2026-09-30: "items floating in space").
   */
  private frameFor(dir: THREE.Vector3, rand: Rand, sinkProbes: number, probeScale = 1, sinkExtra = 0): void {
    const surface = this.options.surface;
    const yaw = rand.range(0, Math.PI * 2);
    SHARED_FRAME.setFromDirection(dir, surface, yaw);

    // Everything below works on the DRAWN surface (visualHeight), not the analytic field: the
    // rendered mesh interpolates between its vertices, so an item anchored on the field alone
    // hovers wherever the two disagree (live review 2026-09-30: "items floating in space").
    if (sinkProbes > 0 && SHARED_FRAME.slope > 0.02) {
      // Sink to the minimum of the tangent probes so trunks meet the uphill side of the ground.
      tangentBasis(SHARED_FRAME.normal, _t1, _t2);
      const probeDist = (0.35 * probeScale) / surface.radius;
      let minHeight = SHARED_FRAME.visualHeight;
      for (let k = 0; k < sinkProbes; k++) {
        const angle = (k / sinkProbes) * Math.PI * 2;
        _probe
          .copy(dir)
          .addScaledVector(_t1, Math.cos(angle) * probeDist)
          .addScaledVector(_t2, Math.sin(angle) * probeDist)
          .normalize();
        const h = surface.visualHeightAtDir(_probe.x, _probe.y, _probe.z);
        if (h < minHeight) minHeight = h;
      }
      SHARED_FRAME.visualHeight = minHeight;
      SHARED_FRAME.height = minHeight;
      SHARED_FRAME.position.copy(dir).multiplyScalar(minHeight);
    }

    if (sinkExtra > 0) {
      const sunk = SHARED_FRAME.visualHeight - sinkExtra;
      SHARED_FRAME.visualHeight = sunk;
      SHARED_FRAME.height = sunk;
      SHARED_FRAME.position.copy(dir).multiplyScalar(sunk);
    }
  }

  private packTerrain(): [number, number, number, number] {
    const { reliefMin, reliefMax } = this.options;
    const span = Math.max(1e-3, reliefMax - reliefMin);
    const d = SHARED_FRAME.direction;
    return [
      clamp(SHARED_FRAME.slope, 0, 1),
      clamp((SHARED_FRAME.height - reliefMin) / span, 0, 1),
      clamp(this.options.moistureAt(d.x, d.y, d.z), 0, 1),
      clamp(this.options.corruptionAt(d.x, d.y, d.z), 0, 1),
    ];
  }

  private makeBase(id: number, scale: number): {
    id: number;
    position: THREE.Vector3;
    direction: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: number;
    terrain: [number, number, number, number];
    vegetation: number;
  } {
    return {
      id,
      position: SHARED_FRAME.position.clone(),
      direction: SHARED_FRAME.direction.clone(),
      quaternion: SHARED_FRAME.quaternion.clone(),
      scale,
      terrain: this.packTerrain(),
      vegetation: SHARED_FRAME.vegetation,
    };
  }

  // ------------------------------------------------------------------ trees

  private generateTrees(placements: EnvironmentPlacements, treeHash: VegetationSpatialHash<{ dir: THREE.Vector3; placement: TreePlacement }>): void {
    const rand = this.stream(2);
    const hash = new VegetationSpatialHash<{ dir: THREE.Vector3 }>();
    const budget = Math.max(0, this.options.budget.trees);

    let placed = 0;
    let guard = 0;
    while (placed < budget && guard++ < budget * 40) {
      const dir = this.sampleDirection(rand, 0.42);
      const surface = this.options.surface;

      const h = surface.heightAtDir(dir.x, dir.y, dir.z);
      const slope = surface.slopeAtDir(dir.x, dir.y, dir.z);
      const water = surface.waterAtDir(dir.x, dir.y, dir.z);

      // terrain gates (plan §13): no water trees, steep = fewer (rejection), altitude thins
      if (water > 0.15) continue;
      if (slope > 0.62) continue;
      if (slope > 0.42 && !rand.chance(0.35)) continue;

      // combat readability: nothing tall inside capture zones / spawns
      if (this.inClearance(dir, 4)) continue;

      // minimum separation (canopy + a bit)
      const spacing = 7.5 / surface.radius + rand.range(0, 0.004);
      this.treeQueryScratch.length = 0;
      hash.query(dir, spacing, this.treeQueryScratch);
      let tooClose = false;
      for (const other of this.treeQueryScratch) {
        if (angularDistance(dir, other.dir) < spacing) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const height01 = clamp((h - this.options.reliefMin) / Math.max(1e-3, this.options.reliefMax - this.options.reliefMin), 0, 1);
      const vegetation = surface.vegetationAtDir(dir.x, dir.y, dir.z);
      this.biomeField.weightsAt(dir.x, dir.y, dir.z, this.weights, this.options.moistureAt(dir.x, dir.y, dir.z), this.options.corruptionAt(dir.x, dir.y, dir.z), height01, slope);

      // biome gates: forest loves forest, meadow thins, corrupted thins, rock barely allows
      const rule = ruleForWeights(this.weights);
      const chance = clamp(this.weights.forest * 1.25 + this.weights.grass * 0.25 + 0.05, 0, 1);
      if (!rand.chance(chance * rule.density)) continue;

      const kind = pickTreeKind(rule, rand.next());
      const scale = rand.range(0.85, 1.35) * (kind === 'CHERRY' ? 0.85 : 1);
      // Deep sink: probes widen with the trunk's radius, and the base buries slightly so a slope
      // never shows daylight under the uphill roots.
      this.frameFor(dir, rand, 6, scale, 0.04 * scale);
      const placement: TreePlacement = { ...this.makeBase(0x100000 + placed, scale), kind };
      placements.trees.push(placement);

      const entry = { dir: dir.clone(), placement };
      hash.insert(entry);
      treeHash.insert(entry);
      placed++;
    }
  }

  // ------------------------------------------------------------------ bushes

  private generateBushes(placements: EnvironmentPlacements): void {
    const rand = this.stream(3);
    const hash = new VegetationSpatialHash<{ dir: THREE.Vector3 }>();
    const budget = Math.max(0, this.options.budget.bushes);

    let placed = 0;
    let guard = 0;
    while (placed < budget && guard++ < budget * 30) {
      const dir = this.sampleDirection(rand, 0.5);
      const surface = this.options.surface;

      const h = surface.heightAtDir(dir.x, dir.y, dir.z);
      const slope = surface.slopeAtDir(dir.x, dir.y, dir.z);
      if (surface.waterAtDir(dir.x, dir.y, dir.z) > 0.1) continue;
      if (slope > 0.55) continue;
      if (this.inClearance(dir, 2.5)) continue;

      const spacing = 2.6 / surface.radius;
      this.genericScratch.length = 0;
      hash.query(dir, spacing, this.genericScratch);
      let tooClose = false;
      for (const other of this.genericScratch) {
        if (angularDistance(dir, other.dir) < spacing) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const height01 = clamp((h - this.options.reliefMin) / Math.max(1e-3, this.options.reliefMax - this.options.reliefMin), 0, 1);
      this.biomeField.weightsAt(dir.x, dir.y, dir.z, this.weights, this.options.moistureAt(dir.x, dir.y, dir.z), this.options.corruptionAt(dir.x, dir.y, dir.z), height01, slope);
      const rule = ruleForWeights(this.weights);
      if (!rand.chance(rule.bushChance * (0.4 + this.weights.grass + this.weights.forest))) continue;

      const scale = rand.range(0.5, 1.0);
      this.frameFor(dir, rand, 5, scale, 0.09 * scale);
      const bush: BushPlacement = { ...this.makeBase(0x200000 + placed, scale), kind: 'BUSH' };
      placements.bushes.push(bush);

      const entry = { dir: dir.clone() };
      hash.insert(entry);
      placed++;
    }
  }

  // ------------------------------------------------------------------ flowers

  private generateFlowers(placements: EnvironmentPlacements): void {
    const rand = this.stream(4);
    const budget = Math.max(0, this.options.budget.flowers);
    if (budget === 0) return;

    let placed = 0;
    let guard = 0;
    while (placed < budget && guard++ < budget * 25) {
      const dir = this.sampleDirection(rand, 0.55);
      const surface = this.options.surface;

      const h = surface.heightAtDir(dir.x, dir.y, dir.z);
      const slope = surface.slopeAtDir(dir.x, dir.y, dir.z);
      if (surface.waterAtDir(dir.x, dir.y, dir.z) > 0.05) continue;
      if (slope > 0.4) continue;

      // flowers may sit NEAR capture zones (they read beautifully) but thin out inside them
      const towerClear = this.inClearance(dir, 0);
      if (towerClear && !rand.chance(0.35)) continue;

      const height01 = clamp((h - this.options.reliefMin) / Math.max(1e-3, this.options.reliefMax - this.options.reliefMin), 0, 1);
      this.biomeField.weightsAt(dir.x, dir.y, dir.z, this.weights, this.options.moistureAt(dir.x, dir.y, dir.z), this.options.corruptionAt(dir.x, dir.y, dir.z), height01, slope);
      const rule = ruleForWeights(this.weights);
      if (!rand.chance(rule.flowerChance * (0.3 + this.weights.grass))) continue;

      const scale = rand.range(0.7, 1.15);
      this.frameFor(dir, rand, 4, scale, 0.06 * scale);
      const flower: FlowerPlacement = { ...this.makeBase(0x300000 + placed, scale), kind: 'FLOWER' };
      placements.flowers.push(flower);
      placed++;
    }
  }

  // ------------------------------------------------------------------ scenery

  private generateScenery(placements: EnvironmentPlacements): void {
    const rand = this.stream(5);
    const budget = Math.max(0, this.options.budget.scenery);
    if (budget === 0) return;

    const hash = new VegetationSpatialHash<{ dir: THREE.Vector3 }>();

    let placed = 0;
    let guard = 0;
    while (placed < budget && guard++ < budget * 40) {
      const dir = this.sampleDirection(rand, 0.72);
      const surface = this.options.surface;

      const slope = surface.slopeAtDir(dir.x, dir.y, dir.z);
      if (surface.waterAtDir(dir.x, dir.y, dir.z) > 0.05) continue;
      if (slope > 0.35) continue;
      // scenery dresses the zones — it may sit nearer than trees but never inside a capture pad
      if (this.inClearance(dir, 1.5)) continue;

      const spacing = 4.5 / surface.radius;
      this.genericScratch.length = 0;
      hash.query(dir, spacing, this.genericScratch);
      let tooClose = false;
      for (const other of this.genericScratch) {
        if (angularDistance(dir, other.dir) < spacing) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      this.frameFor(dir, rand, 0);

      const roll = rand.next();
      const kind: SceneryKind =
        roll < 0.26 ? 'BRICKS' : roll < 0.44 ? 'FENCE' : roll < 0.6 ? 'BENCH' : roll < 0.74 ? 'CRATE' : roll < 0.88 ? 'LANTERN' : 'POLE_LIGHT';
      const scenery: SceneryPlacement = { ...this.makeBase(0x400000 + placed, rand.range(0.85, 1.15)), kind };
      placements.scenery.push(scenery);

      const entry = { dir: dir.clone() };
      hash.insert(entry);
      placed++;
    }
  }

  // ------------------------------------------------------------------ rocks

  private generateRocks(placements: EnvironmentPlacements): void {
    const rand = this.stream(6);
    const budget = Math.max(0, this.options.budget.rocks);
    if (budget === 0) return;

    let placed = 0;
    let guard = 0;
    while (placed < budget && guard++ < budget * 25) {
      const dir = this.sampleDirection(rand, 0.4);
      const surface = this.options.surface;

      const slope = surface.slopeAtDir(dir.x, dir.y, dir.z);
      if (surface.waterAtDir(dir.x, dir.y, dir.z) > 0.4) continue;
      if (slope < 0.12 && !rand.chance(0.2)) continue; // rocks live on slopes, some anywhere
      if (this.inClearance(dir, 1)) continue;

      // Kind mix tuned with the terrain review (2026-09-30): rocks stay the majority, slabs and
      // spikes dress the slopes, and crystals are common enough to read as "this planet has
      // crystals" the way the original environment did.
      const roll = rand.next();
      const kind = roll < 0.5 ? 'ROCK' : roll < 0.68 ? 'SLAB' : roll < 0.86 ? 'CRYSTAL' : 'SPIKE';
      const scale =
        kind === 'ROCK' ? rand.range(0.7, 2.1) :
        kind === 'SLAB' ? rand.range(0.6, 1.6) :
        kind === 'CRYSTAL' ? rand.range(1.0, 2.6) :
        rand.range(0.7, 1.6);
      // Per-kind sink: flat slabs need to bury deep or their downhill edge floats on slopes
      // (live review 2026-09-30: "rocks floating in air") — the sink is along the surface normal.
      const sink = kind === 'SLAB' ? 0.42 * scale : kind === 'CRYSTAL' ? 0.28 * scale : 0.22 * scale;
      this.frameFor(dir, rand, 8, scale, sink);
      const rock: RockPlacement = { ...this.makeBase(0x500000 + placed, scale), kind };
      placements.rocks.push(rock);
      placed++;
    }
  }
}

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _probe = new THREE.Vector3();
