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
import { PlanetRoot } from '../../world/PlanetRoot';
import { ResourceRegistry } from '../ResourceRegistry';
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
import { SkyDome } from './SkyDome';
import { Landmarks } from './Landmarks';
import { Caves } from './Caves';
import { Formations } from './Formations';
import { SciFiStructures } from './SciFiStructures';
import { readSwitches, DebugSwitches } from '../DebugSwitches';
import type { PlanetCave } from '../../world/caves/CaveGenerator';
import { ASSETS } from '../Assets/AssetManifest';
// Throttle-proof build yields — see utils/Yield.ts (a `setTimeout(0)` yield is clamped to 1 s+
// in an occluded tab and stretched this build from seconds to minutes behind the loading screen).
import { yieldToMain } from '../../utils/Yield';

/** Yield between build stages so a loading screen / picker keeps animating. */
const nextLoop = yieldToMain;

/** Scratch colour for the underground fog blend (never allocated per frame). */
const _undergroundColor = new THREE.Color();

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
  /** Build hidden (background pre-build) — see PlanetWorldParams.hidden. */
  hidden?: boolean;
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
  /** r186 plan §1: the world's OWNED resources (baked textures, remapped materials, …). */
  readonly resources = new ResourceRegistry();
  readonly group = new PlanetRoot(this.resources);

  terrain!: PlanetTerrain;
  grass!: Grass;
  bushes!: Bushes;
  rocks!: Rocks;
  spikes!: Spikes;
  crystals!: RadioactiveCrystals;
  puddles!: Puddles;
  particles!: FloatingParticles;
  /** Sci-fi sky dome (plan §22) — always behind the world; `?sky=0` removes it. */
  sky!: SkyDome;
  /** Landmark prop compositions + the hero formation (plan §16–§18). */
  landmarks!: Landmarks;
  /** Cave compositions + the ONE underground mote cloud (plan §30/§35). */
  caves!: Caves;
  /** Geological formations (plan §9/§10) — composed rock families, rings, spires, cliffs. */
  formations!: Formations;
  /** Sci-fi structures + the crashed colony ship (plan §61/§62). */
  scifi!: SciFiStructures;
  readonly trees: Trees[] = [];

  private readonly focusScratch = new THREE.Vector3();
  /** URL switches (`?sky=0`, `?landmarks=0`, …) — read once per world. */
  private readonly switches = new DebugSwitches();

  /** Environmental colliders (trees / bushes / rocks / spikes / crystals). */
  readonly obstacles: PlanetObstacles;
  private constructor(private readonly deps: PlanetWorldDependencies) {
    this.obstacles = new PlanetObstacles(deps.surface.radius);
    // A background pre-build stays invisible from the very first stage (it would otherwise
    // overlap the menu world on screen while it grows) — the adopting match reveals it.
    if (deps.hidden) this.group.visible = false;
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

    // 0 — the sky dome goes in FIRST: the renderer runs with `sortObjects = false`, so insertion
    // order is draw order and the sky must never be submitted after the world (plan §22).
    if (this.switches.enabled('sky')) {
      this.sky = new SkyDome(deps.noises, deps.time, 1500);
      this.group.add(this.sky.mesh);
    }

    // 1 — terrain first: everything else contours to it (plan §46)
    onProgress?.(0.05, 'building terrain mesh');
    this.terrain = await PlanetTerrain.create(deps.generator, deps.nodes, deps.noises, (ratio) => {
      onProgress?.(0.05 + ratio * 0.25, 'building terrain mesh');
    });
    this.group.add(this.terrain.mesh);
    await nextLoop();

    // 2 — water films FIRST: the basin list feeds the grass suppression slots
    onProgress?.(0.32, 'flooding puddles');
    this.puddles = new Puddles(deps.surface, deps.generator, deps.noises, deps.time, { direction: deps.spawnDirection, radius: 6 });
    this.group.add(this.puddles.mesh);
    await nextLoop();

    // 3 — grass field (planet-wide and static: every blade is baked at build; the only runtime
    // inputs are the player's parting push and the shared wind — nothing streams while walking).
    // The field is ONE shared material over 32 spatial sector meshes (plan §8) so the frustum
    // culls the planet behind the player. The planting itself is chunked (see Grass.plant) —
    // `ready` resolves when the sector meshes are in.
    onProgress?.(0.33, 'planting grass');
    this.grass = new Grass(deps.surface, deps.nodes, deps.quality, deps.wind, deps.noises, this.puddles, deps.time);
    this.group.add(this.grass.root);
    await this.grass.ready;
    await nextLoop();

    // 4 — bushes (leaf-card canopies) — raised count + bigger sizes per user ask. Note there is
    // no see-through fade on bushes anymore (they are knee-high; only tree canopies need it).
    this.bushes = new Bushes(deps.preRenderer, deps.wind, deps.ticker, deps.surface, deps.generator, 780, spawnClear, this.obstacles);
    this.group.add(this.bushes.foliage.mesh);
    await nextLoop();

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
    await nextLoop();

    onProgress?.(0.78, 'planting spikes');
    this.spikes = new Spikes(deps.surface, deps.generator, 74, spawnClear, this.obstacles);
    if (this.spikes.mesh) this.group.add(this.spikes.mesh);
    await nextLoop();

    onProgress?.(0.82, 'growing crystals');
    this.crystals = new RadioactiveCrystals(deps.surface, deps.generator, deps.time, 48, spawnClear, this.obstacles);
    if (this.crystals.mesh) this.group.add(this.crystals.mesh);
    await nextLoop();

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
    await nextLoop();

    // 7 — landmark compositions + the ONE hero formation (plan §16–§18): deterministic from the
    // planet seed, terrain-aligned, instanced. Built after the scatter systems so the clusters
    // own their space; `?landmarks=0` removes the whole layer for A/B.
    if (this.switches.enabled('landmarks')) {
      onProgress?.(0.92, 'composing landmarks');
      this.landmarks = new Landmarks(
        deps.surface,
        deps.generator,
        deps.noises,
        deps.time,
        spawnClear,
        this.obstacles,
      );
      this.group.add(this.landmarks.group);
      await nextLoop();
    }

    // 7b — cave compositions (plan §30/§35): rim arches, entrance arch, ceiling caps +
    // stalactites, crystal beds, glow fans, ruins and the ONE mote cloud. The CARVE itself is
    // already part of the terrain height field, so this layer is pure dressing — `?caves=0`
    // removes it and the caverns stay walkable.
    if (this.switches.enabled('caves')) {
      onProgress?.(0.94, 'opening caverns');
      this.caves = new Caves(deps.surface, deps.generator, deps.time, spawnClear, this.obstacles);
      this.group.add(this.caves.group);
      await nextLoop();
    }

    // 7c — geological formations (plan §9/§10/§59): composed rock families, boulder fields,
    // stone rings, spire fields, cliff lines and crystal beds — the authored mid-ground.
    if (this.switches.enabled('formations')) {
      onProgress?.(0.95, 'raising formations');
      this.formations = new Formations(deps.surface, deps.generator, deps.time, spawnClear, this.obstacles);
      this.group.add(this.formations.group);
      await nextLoop();
    }

    // 7d — sci-fi structures (plan §61/§62): the crashed colony ship + landing pad, ruined
    // antenna and energy relay. `?scifi=0` removes the layer for A/B.
    if (this.switches.enabled('scifi')) {
      onProgress?.(0.955, 'recovering wreckage');
      this.scifi = new SciFiStructures(deps.surface, deps.generator, deps.time, spawnClear, this.obstacles);
      this.group.add(this.scifi.group);
      await nextLoop();
    }

    // ---- FREEZE THE STATIC WORLD (plan §15/§37): every environment transform is final —
    // nothing in this subtree ever moves (all animation lives in shader uniforms), so the
    // renderer must not rebuild world matrices for the static scene on every frame. Pads,
    // bases, towers, enemies and players are separate systems and stay dynamic.
    this.group.updateMatrixWorld(true);
    this.group.matrixAutoUpdate = false;
    this.group.traverse((object) => {
      object.matrixAutoUpdate = false;
    });

    onProgress?.(0.96, 'ready');
  }

  /**
   * Per-frame world pass, called from the environment tick. `walkers` are the OTHER players'
   * proxy positions (user ask 2026-10-03): they feed the grass trample ring and the puddle wake
   * so every survivor visibly disturbs the world — the local screen draws the effect for every
   * body it renders, so no network message is involved.
   */
  update(
    focusPoint: THREE.Vector3,
    camera?: THREE.Camera,
    walkers?: readonly { id: string; pos: THREE.Vector3 }[],
    dt = 1 / 60,
  ): void {
    void this.focusScratch;
    this.grass.update(focusPoint, camera, walkers, dt);
    this.puddles.trackTrail(focusPoint);
    if (walkers) for (const w of walkers) this.puddles.trackWalkerTrail(w.id, w.pos);
    this.particles.update(focusPoint, camera);
  }

  /**
   * Underground blend (plan §33/§34/§35): while the local body walks inside a cave, the surface
   * atmosphere fades out and the cave's own air takes over — fog pulls in and takes the cave's
   * colour, the sun's core-shadow edge rises so the floor reads as shaded rock (not a black
   * hole), and bloom carries the crystal light. The blend eases, so the surface→cave transition
   * is a walk down a ramp, never a cut.
   */
  setUnderground(depth: number, cave: PlanetCave | null, dt: number): void {
    const fog = this.deps.fog;
    const lighting = this.deps.lighting;
    if (this.undergroundBase === null) {
      this.undergroundBase = {
        fogNear: (fog as any).near?.value ?? 34,
        fogFar: (fog as any).far?.value ?? 270,
        fogColor: (fog.color.value as THREE.Color).clone(),
        shadowLow: lighting.coreShadowEdgeLow.value,
        shadowHigh: lighting.coreShadowEdgeHigh.value,
        shadowColor: (lighting.shadowColor.value as THREE.Color).clone(),
        bounce: lighting.lightBounceMultiplier.value,
        sunIntensity: lighting.intensityUniform.value,
        sunColor: (lighting.colorUniform.value as THREE.Color).clone(),
      };
    }
    const base = this.undergroundBase;
    // 0 at the rim, 1 once the body is well inside the carve (plan §33 threshold).
    const target = cave && depth > 1.2 ? Math.min(1, Math.max(0, (depth - 1.2) / 6)) : 0;
    const k = 1 - Math.exp(-dt * 3.2);
    this.undergroundBlend += (target - this.undergroundBlend) * k;
    const u = this.undergroundBlend;
    const caveFog = cave ? (cave.palette.fog as number) : 0x0a1416;
    const caveColor = _undergroundColor.setHex(caveFog).convertSRGBToLinear();

    fog.setDistances(
      base.fogNear + (14 - base.fogNear) * u,
      base.fogFar + (95 - base.fogFar) * u,
    );
    (fog.color.value as THREE.Color).copy(base.fogColor).lerp(caveColor, u * 0.85);
    lighting.coreShadowEdgeLow.value = base.shadowLow + (0.42 - base.shadowLow) * u;
    lighting.coreShadowEdgeHigh.value = base.shadowHigh + (1.06 - base.shadowHigh) * u;
    (lighting.shadowColor.value as THREE.Color).copy(base.shadowColor).lerp(caveColor, u * 0.8);
    // The sun does not reach the floor (plan §34): once inside, the key light fades almost out
    // and shifts into the cave's own air. The bounce term becomes the cave's ambient — lifted so
    // ordinary rock never collapses to black (plan §7's ambient floor) while crystal glow and
    // bloom carry the readable light. Never a flashlight on the player.
    lighting.intensityUniform.value = base.sunIntensity * (1 - u * 0.88);
    (lighting.colorUniform.value as THREE.Color).copy(base.sunColor).lerp(caveColor, u * 0.5);
    lighting.lightBounceMultiplier.value = base.bounce + (1.15 - base.bounce) * u;
  }

  private undergroundBase: {
    fogNear: number;
    fogFar: number;
    fogColor: THREE.Color;
    shadowLow: number;
    shadowHigh: number;
    shadowColor: THREE.Color;
    bounce: number;
    sunIntensity: number;
    sunColor: THREE.Color;
  } | null = null;
  private undergroundBlend = 0;

  /** Live underground blend (0 surface → 1 deep cave) — diagnostics only. */
  get undergroundBlendValue(): number {
    return this.undergroundBlend;
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
    sky?: boolean;
    landmarks?: boolean;
    caves?: boolean;
    formations?: boolean;
    scifi?: boolean;
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
    if (this.sky) this.sky.setVisible(switches.sky ?? true);
    if (this.landmarks) this.landmarks.setVisible(switches.landmarks ?? true);
    if (this.caves) this.caves.setVisible(switches.caves ?? true);
    if (this.formations) this.formations.setVisible(switches.formations ?? true);
    if (this.scifi) this.scifi.setVisible(switches.scifi ?? true);
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
    this.sky?.dispose();
    this.landmarks?.dispose();
    this.caves?.dispose();
    this.formations?.dispose();
    this.scifi?.dispose();
    this.terrain.material.dispose();
    this.terrain.mesh.geometry.dispose();
    // r186 plan §1: the explicit teardown order — systems first (they release their own roots),
    // then the subtree safety net (anything a system forgot), then the registry (baked textures,
    // gradient lookups, remapped GLB materials, particle atlases). Shared app-lifetime resources
    // are skipped by BOTH the subtree walk and the registry.
    this.group.dispose();
    this.resources.disposeAll();
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
      'landmarks': `${this.landmarks ? `${this.landmarks.propCount} props${this.landmarks.heroLabel ? ` · hero ${this.landmarks.heroLabel}` : ''}` : 'off'}`,
      'caves': `${this.caves ? `${this.caves.caveCount} entrances · ${this.caves.propCount} props · ${this.caves.moteCount} motes` : 'off'}`,
      'formations': `${this.formations ? `${this.formations.formationCount} sites · ${this.formations.propCount} props` : 'off'}`,
      'scifi': `${this.scifi ? `${this.scifi.siteCount} sites · ${this.scifi.propCount} props` : 'off'}`,
      'colliders': `${this.obstacles.count}`,
    };
  }

  /**
   * Numeric world counters for the telemetry snapshot (r186 plan §0.3/§49). The grass numbers
   * come from the LOD pass's own bookkeeping; the decoration numbers are instance counts the
   * systems already track — no traversal, no allocation.
   */
  counters(): {
    grassSectors: number;
    grassSectorsVisible: number;
    grassInstances: number;
    grassInstancesDrawn: number;
    grassFadingSectors: number;
    vegetationInstances: number;
  } {
    const grass = this.grass.stats;
    let trees = 0;
    for (const tree of this.trees) trees += tree.treeCount;
    return {
      grassSectors: grass.sectors,
      grassSectorsVisible: grass.visibleSectors,
      grassInstances: grass.instances,
      grassInstancesDrawn: grass.drawnInstances,
      grassFadingSectors: grass.fadingSectors,
      vegetationInstances:
        trees +
        this.bushes.count +
        this.rocks.count +
        this.spikes.spikeCount +
        this.crystals.shardCount +
        (this.caves?.propCount ?? 0) +
        (this.formations?.propCount ?? 0) +
        (this.scifi?.propCount ?? 0),
    };
  }
}
