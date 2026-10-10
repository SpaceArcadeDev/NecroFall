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
import { BaseRocks } from './BaseRocks';
import { BaseEcology } from './BaseEcology';
import { EnvironmentWeather } from '../../concepts/EnvironmentWeather';
import { createSurfaceSample } from '../../planet/PlanetSurface';
import { positionWorld } from 'three/tsl';
import { Spikes } from './Spikes';
import { RadioactiveCrystals } from './RadioactiveCrystals';
import { Puddles } from './Puddles';
import { FloatingParticles } from './FloatingParticles';
import { SkyDome } from './SkyDome';
import { SystemSky } from './SystemSky';
import { daylightAt, twilightAt, TWILIGHT_COLOR } from './Daylight';
import type { PlanetSystem } from '../../planet/PlanetSystem';
import type { WorldGlobals } from '../WorldGlobals';
import { Landmarks } from './Landmarks';
import { Formations } from './Formations';
import { SciFiStructures } from './SciFiStructures';
import { readSwitches, DebugSwitches } from '../DebugSwitches';
import { ASSETS } from '../Assets/AssetManifest';
// Throttle-proof build yields — see utils/Yield.ts (a `setTimeout(0)` yield is clamped to 1 s+
// in an occluded tab and stretched this build from seconds to minutes behind the loading screen).
import { yieldToMain } from '../../utils/Yield';

/** Yield between build stages so a loading screen / picker keeps animating. */
const nextLoop = yieldToMain;

export interface PlanetWorldDependencies {
  system: PlanetSystem;
  globals: WorldGlobals;
  obstacles?: PlanetObstacles;
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
  rocks!: BaseRocks;
  ecology!: BaseEcology;
  weather!: EnvironmentWeather;
  spikes!: Spikes;
  crystals!: RadioactiveCrystals;
  puddles!: Puddles;
  particles!: FloatingParticles;
  /** Sci-fi sky dome (plan §22) — always behind the world; `?sky=0` removes it. */
  sky!: SkyDome | SystemSky;
  /** Landmark prop compositions + the hero formation (plan §16–§18). */
  landmarks!: Landmarks;
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
      this.sky = new SystemSky(deps.system, deps.generator.archetype.art!, deps.generator.radius, deps.time);
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
    this.rocks = await BaseRocks.create({ ...deps, obstacles: this.obstacles });
    this.group.add(this.rocks.group);
    this.ecology = await BaseEcology.create({ ...deps, obstacles: this.obstacles }, this.rocks, this.puddles);
    this.group.add(this.ecology.group);
    await nextLoop();

    // 3 — grass field (planet-wide and static: every blade is baked at build; the only runtime
    // inputs are the player's parting push and the shared wind — nothing streams while walking).
    // The field is ONE shared material over 32 spatial sector meshes (plan §8) so the frustum
    // culls the planet behind the player. The planting itself is chunked (see Grass.plant) —
    // `ready` resolves when the sector meshes are in.
    onProgress?.(0.33, 'planting grass');
    const blocked = (positionX: number, positionY: number, positionZ: number) => this.rocks.blocked(positionX, positionY, positionZ)
      || this.ecology.hazards.blocksVegetation(positionX, positionY, positionZ);
    this.grass = new Grass(deps.surface, deps.nodes, deps.quality, deps.wind, deps.noises, this.puddles, deps.time,
      blocked);
    this.group.add(this.grass.root);
    await this.grass.ready;
    await nextLoop();

    // 4 — bushes (leaf-card canopies) — raised count + bigger sizes per user ask. Note there is
    // no see-through fade on bushes anymore (they are knee-high; only tree canopies need it).
    this.bushes = new Bushes(deps.preRenderer, deps.wind, deps.ticker, deps.surface, deps.generator, 420, spawnClear, this.obstacles, blocked);
    this.group.add(this.bushes.foliage.mesh);
    await nextLoop();

    // 4 — trees (trunk instancing + leaf-card canopies)
    for (let i = 0; i < TREE_SPECIES.length; i++) {
      const art = deps.generator.archetype.art!;
      const chosenSpecies = art.treeSpecies ?? (art.flora === 'canopy' ? 'cherry' : art.flora === 'coral' ? 'oak' : 'birch');
      if (art.flora === 'fungus' || TREE_SPECIES[i].name.toLowerCase() !== chosenSpecies) continue;
      const species = { ...TREE_SPECIES[i], leafColorA: art.foliage, leafColorB: art.foliageLight,
        count: Math.round(140 * Math.min(1.2, deps.generator.archetype.plantDensity)),
        heightMin: art.flora === 'sail' ? 4 : 7, heightMax: art.flora === 'sail' ? 8 : 14 };
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
        blocked,
      });
      this.trees.push(tree);
      this.group.add(tree.group);
    }

    // 5 — rocks / spikes / crystals
    onProgress?.(0.72, 'scattering rocks');
    await nextLoop();

    onProgress?.(0.78, 'planting spikes');
    this.spikes = new Spikes(deps.surface, deps.generator, 74, spawnClear, this.obstacles, blocked);
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
    const weatherSample = createSurfaceSample();
    this.weather = new EnvironmentWeather(deps.generator.archetype.art!, deps.generator.seed,
      window.matchMedia('(max-width: 700px)').matches, deps.time, undefined, undefined, {
        radiation: deps.nodes.terrainNode(positionWorld).a,
        anchor: (random, dry) => {
          deps.surface.randomSample(random, weatherSample);
          if (dry && (weatherSample.radius < deps.surface.waterLevel + 0.8 || blocked(weatherSample.up.x, weatherSample.up.y, weatherSample.up.z))) return null;
          return weatherSample.up.clone().multiplyScalar(Math.max(weatherSample.radius + 0.06, deps.surface.waterLevel + 0.06));
        },
      });
    this.group.add(this.weather.group);
    await nextLoop();

    // 7 — landmark compositions + the ONE hero formation (plan §16–§18): deterministic from the
    // planet seed, terrain-aligned, instanced. Built after the scatter systems so the clusters
    // own their space; `?landmarks=0` removes the whole layer for A/B.
    if (this.switches.enabled('landmarks') && !deps.generator.archetype.art) {
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

    // 7b — geological formations (plan §9/§10/§59): composed rock families, boulder fields,
    // stone rings, spire fields, cliff lines and crystal beds — the authored mid-ground.
    if (this.switches.enabled('formations') && !deps.generator.archetype.art) {
      onProgress?.(0.95, 'raising formations');
      this.formations = new Formations(deps.surface, deps.generator, deps.time, spawnClear, this.obstacles);
      this.group.add(this.formations.group);
      await nextLoop();
    }

    // 7c — sci-fi structures (plan §61/§62): the crashed colony ship + landing pad, ruined
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
    this.obstacles.addMesh(this.terrain.mesh);
    this.rocks.group.traverse(object => { if (object instanceof THREE.Mesh) this.obstacles.addMesh(object); });
    for (const tree of this.trees) if (tree.trunkMesh) this.obstacles.addMesh(tree.trunkMesh);
    if (this.spikes.mesh) this.obstacles.addMesh(this.spikes.mesh);
    if (this.crystals.mesh) this.obstacles.addMesh(this.crystals.mesh);
    this.ecology.group.traverse(object => { if (object instanceof THREE.Mesh && (object.name === 'painted-mushrooms' || object.name === 'lava-vents')) this.obstacles.addMesh(object, object.name === 'painted-mushrooms'); });
    this.obstacles.build();
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
    this.deps.globals.playerPosition.value.copy(focusPoint);
    if (camera) {
      this.deps.fog.setAltitude(camera.position.length(), this.deps.generator.radius);
      this.focusScratch.copy(focusPoint).addScaledVector(focusPoint.clone().normalize(), 0.8).project(camera);
      this.deps.globals.playerScreen.value.set(this.focusScratch.x * 0.5 + 0.5, 0.5 - this.focusScratch.y * 0.5);
      this.deps.globals.playerDistance.value = camera.position.distanceTo(focusPoint);
    }
    this.grass.update(focusPoint, camera, walkers, dt);
    this.puddles.trackTrail(focusPoint);
    if (walkers) for (const w of walkers) this.puddles.trackWalkerTrail(w.id, w.pos);
    this.particles.update(focusPoint, camera);
    this.weather.update(Number(this.deps.time.value), camera);
    if (this.sky instanceof SystemSky) this.sky.update(focusPoint, camera);
    const elevation = focusPoint.dot(this.deps.system.sunDirection) / Math.max(0.001, focusPoint.length());
    this.daylight = daylightAt(elevation);
    this.surfaceFog.copy(this.dayFog).lerp(this.sunsetFog, twilightAt(elevation) * 0.65).multiplyScalar(0.035 + this.daylight * 0.965);
    (this.deps.fog.color.value as THREE.Color).copy(this.surfaceFog);
  }

  private readonly dayFog = new THREE.Color();
  private readonly surfaceFog = new THREE.Color();
  private readonly sunsetFog = new THREE.Color(TWILIGHT_COLOR);
  private daylight = 1;
  activateLighting(): void {
    this.deps.lighting.setSunDirection(this.deps.system.sunDirection, this.deps.system.sunColor);
    this.deps.lighting.setSurfacePalette(this.deps.generator.archetype.art!.ground, this.deps.generator.archetype.art!.horizon);
    this.dayFog.set(this.deps.generator.archetype.art!.horizon);
    this.surfaceFog.copy(this.dayFog);
    (this.deps.fog.color.value as THREE.Color).copy(this.dayFog);
    (this.deps.lighting.bounceColor.value as THREE.Color).set(this.deps.generator.archetype.art!.ground);
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
    formations?: boolean;
    scifi?: boolean;
  }): void {
    this.grass.setVisible(switches.grass);
    this.bushes.setVisible(switches.foliage);
    this.ecology.setVisible(switches.foliage);
    for (const tree of this.trees) {
      if (tree.foliage) tree.foliage.setVisible(switches.foliage);
      if (tree.trunkMesh) tree.trunkMesh.visible = true; // trunks stay
    }
    this.rocks.setVisible(switches.rocks);
    this.spikes.setVisible(switches.spikes);
    this.crystals.setVisible(switches.crystals);
    this.puddles.setVisible(switches.water);
    this.particles.setVisible(switches.particles);
    this.weather.group.visible = switches.particles;
    if (this.sky) this.sky.setVisible(switches.sky ?? true);
    if (this.landmarks) this.landmarks.setVisible(switches.landmarks ?? true);
    if (this.formations) this.formations.setVisible(switches.formations ?? true);
    if (this.scifi) this.scifi.setVisible(switches.scifi ?? true);
  }

  dispose(): void {
    this.obstacles.dispose();
    this.grass.dispose();
    this.bushes.dispose();
    for (const tree of this.trees) tree.dispose();
    this.rocks.dispose();
    this.ecology.dispose();
    this.spikes.dispose();
    this.crystals.dispose();
    this.puddles.dispose();
    this.particles.dispose();
    this.sky?.dispose();
    this.landmarks?.dispose();
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
      'base planet': this.deps.generator.archetype.art?.name ?? this.deps.generator.archetype.biome,
      'grass': `${this.grass.bladeCount.toLocaleString()} blades`,
      'trees': `${this.trees.reduce((total, tree) => total + tree.treeCount, 0)}`,
      'rocks': `${this.rocks.count}`,
      'mushrooms': `${this.ecology.mushroomCount}`,
      'spikes': `${this.spikes.spikeCount}`,
      'crystals': `${this.crystals.shardCount}`,
      'puddles': `${this.puddles.count}`,
      'motes': `${this.particles.count}`,
      'landmarks': `${this.landmarks ? `${this.landmarks.propCount} props${this.landmarks.heroLabel ? ` · hero ${this.landmarks.heroLabel}` : ''}` : 'off'}`,
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
        (this.formations?.propCount ?? 0) +
        (this.scifi?.propCount ?? 0),
    };
  }
}
