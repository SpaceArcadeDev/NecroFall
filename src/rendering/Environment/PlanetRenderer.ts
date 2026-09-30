/**
 * NECROFALL — planet world orchestrator (plan §45/§46/§101).
 *
 * Build order matters: planet → terrain → grass → bushes → trees → rocks →
 * spikes → crystals → puddles → particles. Everything is added to ONE group;
 * `update()` runs the visibility pass and the per-system updates — no gameplay
 * logic lives here.
 */
import * as THREE from 'three/webgpu';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import type { PlanetSurface } from '../../planet/PlanetSurface';
import { PlanetObstacles } from '../../planet/PlanetObstacles';
import type { Quality } from '../Quality';
import type { Ticker } from '../Ticker';
import type { Materials } from '../materials/Materials';
import type { ResourcesLoader } from '../Assets/ResourcesLoader';
import type { PreRenderer } from '../PreRenderer';
import type { Wind } from './Wind';
import type { Fog } from './Fog';
import type { Lighting } from './Lighting';
import type { Noises } from './Noises';
import type { TerrainNodeBundle } from './PlanetTerrainNodes';
import { PlanetTerrain } from './PlanetTerrain';
import { Grass } from './Grass';
import { Trees, type TreeSpeciesOptions } from './Trees';
import { Bushes } from './Bushes';
import { Rocks } from './Rocks';
import { Spikes } from './Spikes';
import { RadioactiveCrystals } from './RadioactiveCrystals';
import { Puddles } from './Puddles';
import { FloatingParticles } from './FloatingParticles';
import { ASSETS } from '../Assets/AssetManifest';

export interface PlanetWorldDependencies {
  scene: THREE.Scene;
  ticker: Ticker;
  quality: Quality;
  materials: Materials;
  loader: ResourcesLoader;
  preRenderer: PreRenderer;
  wind: Wind;
  noises: Noises;
  fog: Fog;
  lighting: Lighting;
  surface: PlanetSurface;
  generator: PlanetGenerator;
  nodes: TerrainNodeBundle;
  /** Shader time uniform (radioactive pulses). */
  time: any;
  /** Spawn direction — orients the particle bubble. */
  spawnDirection: THREE.Vector3;
}

/** Plan §21: the three folio tree species with NecroFall colour mutations. */
const TREE_SPECIES: TreeSpeciesOptions[] = [
  {
    name: 'Birch',
    url: ASSETS.birchTree,
    count: 74,
    salt: 201,
    leafColorA: '#4f7d33',
    leafColorB: '#b4c94e',
    heightMin: 6,
    heightMax: 10,
  },
  {
    name: 'Oak',
    url: ASSETS.oakTree,
    count: 62,
    salt: 202,
    leafColorA: '#234227',
    leafColorB: '#476b35',
    heightMin: 6,
    heightMax: 11,
  },
  {
    name: 'Cherry',
    url: ASSETS.cherryTree,
    count: 44,
    salt: 203,
    leafColorA: '#3a1420',
    leafColorB: '#61203d',
    heightMin: 4.5,
    heightMax: 8,
  },
];

export class PlanetRenderer {
  readonly group = new THREE.Group();

  terrain!: PlanetTerrain;
  grass!: Grass;
  bushes!: Bushes;
  rocks!: Rocks;
  spikes!: Spikes;
  crystals!: RadioactiveCrystals;
  puddles!: Puddles;
  particles!: FloatingParticles;
  readonly trees: Trees[] = [];

  private readonly focusScratch = new THREE.Vector3();

  /** Environmental colliders (trees / bushes / rocks / spikes / crystals). */
  readonly obstacles: PlanetObstacles;

  private constructor(private readonly deps: PlanetWorldDependencies) {
    this.obstacles = new PlanetObstacles(deps.surface.radius);
  }

  static async create(
    deps: PlanetWorldDependencies,
    onProgress?: (ratio: number, label: string) => void,
  ): Promise<PlanetRenderer> {
    const world = new PlanetRenderer(deps);
    await world.build(onProgress);
    return world;
  }

  private async build(onProgress?: (ratio: number, label: string) => void): Promise<void> {
    const deps = this.deps;
    deps.scene.add(this.group);
    const spawnClear = { direction: deps.spawnDirection, radius: 9 };

    // 1 — terrain first: everything else contours to it (plan §46)
    onProgress?.(0.05, 'building terrain mesh');
    this.terrain = await PlanetTerrain.create(deps.generator, deps.nodes, (ratio) => {
      onProgress?.(0.05 + ratio * 0.25, 'building terrain mesh');
    });
    this.group.add(this.terrain.mesh);

    // 2 — water films FIRST: the basin list feeds the grass suppression slots
    onProgress?.(0.32, 'flooding puddles');
    this.puddles = new Puddles(deps.surface, deps.generator, deps.noises, deps.time, { direction: deps.spawnDirection, radius: 6 });
    this.group.add(this.puddles.mesh);

    // 3 — grass field (blades vanish inside basins, wake ripples on water)
    this.grass = new Grass(deps.surface, deps.nodes, deps.quality, deps.wind, deps.noises, deps.ticker, deps.spawnDirection, this.puddles);
    this.group.add(this.grass.mesh);

    // 4 — bushes (leaf-card canopies)
    this.bushes = new Bushes(deps.preRenderer, deps.wind, deps.ticker, deps.surface, deps.generator, 240, spawnClear, this.obstacles);
    this.group.add(this.bushes.foliage.mesh);

    // 4 — trees (trunk instancing + leaf-card canopies)
    for (let i = 0; i < TREE_SPECIES.length; i++) {
      const species = TREE_SPECIES[i];
      onProgress?.(0.35 + i * 0.12, `planting ${species.name.toLowerCase()} trees`);
      const tree = await Trees.create(species, {
        loader: deps.loader,
        materials: deps.materials,
        preRenderer: deps.preRenderer,
        wind: deps.wind,
        ticker: deps.ticker,
        surface: deps.surface,
        generator: deps.generator,
        spawnClear,
        obstacles: this.obstacles,
      });
      this.trees.push(tree);
      this.group.add(tree.group);
    }

    // 5 — rocks / spikes / crystals
    onProgress?.(0.72, 'scattering rocks');
    this.rocks = new Rocks(deps.surface, deps.generator, spawnClear, this.obstacles);
    this.group.add(this.rocks.group);

    onProgress?.(0.78, 'planting spikes');
    this.spikes = new Spikes(deps.surface, deps.generator, 74, spawnClear, this.obstacles);
    if (this.spikes.mesh) this.group.add(this.spikes.mesh);

    onProgress?.(0.82, 'growing crystals');
    this.crystals = new RadioactiveCrystals(deps.surface, deps.generator, deps.time, 48, spawnClear, this.obstacles);
    if (this.crystals.mesh) this.group.add(this.crystals.mesh);

    // 6 — atmosphere
    onProgress?.(0.9, 'releasing contamination');
    this.particles = new FloatingParticles(
      deps.surface,
      deps.generator,
      deps.time,
      deps.quality,
      deps.wind,
      deps.spawnDirection,
    );
    this.group.add(this.particles.group);

    onProgress?.(0.96, 'ready');
  }

  /** Per-frame world pass, called from the environment tick. */
  update(focusPoint: THREE.Vector3, camera?: THREE.Camera): void {
    void this.focusScratch;
    this.grass.update(focusPoint);
    this.puddles.trackTrail(focusPoint);
    this.particles.update(focusPoint, camera);
  }

  /** Debug switches (plan §90). */
  applyVisibility(switches: {
    grass: boolean;
    foliage: boolean;
    rocks: boolean;
    spikes: boolean;
    crystals: boolean;
    water: boolean;
    particles: boolean;
  }): void {
    this.grass.setVisible(switches.grass);
    this.bushes.setVisible(switches.foliage);
    for (const tree of this.trees) {
      if (tree.foliage) tree.foliage.setVisible(switches.foliage);
      if (tree.trunkMesh) tree.trunkMesh.visible = true; // trunks stay
    }
    this.rocks.setVisible(switches.rocks);
    this.spikes.setVisible(switches.spikes);
    this.crystals.setVisible(switches.crystals);
    this.puddles.setVisible(switches.water);
    this.particles.setVisible(switches.particles);
  }

  dispose(): void {
    this.grass.dispose();
    this.bushes.dispose();
    for (const tree of this.trees) tree.dispose();
    this.rocks.dispose();
    this.spikes.dispose();
    this.crystals.dispose();
    this.puddles.dispose();
    this.particles.dispose();
    this.terrain.material.dispose();
    this.terrain.mesh.geometry.dispose();
    this.group.removeFromParent();
  }

  get stats(): Record<string, string> {
    return {
      'grass': `${this.grass.bladeCount.toLocaleString()} blades`,
      'trees': `${this.trees.reduce((total, tree) => total + tree.treeCount, 0)}`,
      'rocks': `${this.rocks.count}`,
      'spikes': `${this.spikes.spikeCount}`,
      'crystals': `${this.crystals.shardCount}`,
      'puddles': `${this.puddles.count}`,
      'motes': `${this.particles.count}`,
      'colliders': `${this.obstacles.count}`,
    };
  }
}
