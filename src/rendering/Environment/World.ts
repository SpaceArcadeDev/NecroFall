// NECROFALL — World (plan §46): the world's environment layer, assembled Folio-style.
//
//   Planet (terrain data + mesh)
//        │
//   World
//        ├── Sky                  (TSL, nebula + stars)
//        ├── Grass                (Folio blade architecture, NecroFall zoning)
//        ├── Trees ×3             (birch / oak / cherry — real Folio models)
//        ├── Bushes / Flowers     (Folio Foliage renderer)
//        ├── Scenery              (bricks / fences / benches / crates / lanterns / pole lights)
//        ├── Rocks                (NecroFall-specific props in the Folio material family)
//        ├── WaterSurface         (local curved patches)
//        ├── EnvironmentParticles (one GPU field)
//        ├── WorldPhysics         (Rapier, distance-tiered, radial gravity)
//        ├── WorldOcclusion       (camera→player readability)
//        └── VegetationVisibility (LOD budgets)
//
// Construction order follows the plan's dependency chain: terrain data → biomes → gameplay zones
// → decoration seed → vegetation → scenery → water → physics → visibility.
import * as THREE from 'three/webgpu';
import { FOLIO } from '../FolioShaderGlobals';
import { ResourcesLoader, type EnvironmentAssets } from '../Assets/ResourcesLoader';
import { Trees } from './Trees';
import { PlanetRenderer } from './PlanetRenderer';
import { Bushes } from './Bushes';
import { Flowers } from './Flowers';
import { Grass } from './Grass';
import { Rocks } from './Rocks';
import { Spikes } from './Spikes';
import { RadioactiveCrystals } from './RadioactiveCrystals';
import { WaterSurface } from './Puddles';
import { Sky } from './Sky';
import { EnvironmentParticles } from './FloatingParticles';
import { WorldPhysics } from '../Physics/Physics';
import { PhysicsSurface } from '../Physics/PhysicsSurface';
import { TerrainRaycaster } from '../Physics/TerrainRaycaster';
import { WaterInteraction } from '../Physics/WaterInteraction';
import { WorldOcclusion } from './WorldOcclusion';
import { VegetationVisibility } from '../../world/vegetation/VegetationVisibility';
import { VegetationGenerator } from '../../world/vegetation/VegetationGenerator';
import { VegetationSpatialHash } from '../../world/vegetation/VegetationSpatialHash';
import { createTerrainSurface, type TerrainSurface } from '../../world/TerrainSurface';
import { PlanetGenerator } from '../../planet/PlanetGenerator';
import { PLANET_SALT } from '../../planet/PlanetSeed';
import { clamp } from '../../utils/Utils';
import type { QualitySettings } from '../../core/Config';
import type { EnvironmentPlacements } from '../../world/vegetation/VegetationTypes';
import type { RenderState } from '../../game/RenderState';

/** The Planet shape World builds from (structural — Planet stays free to evolve). */
export interface WorldPlanet {
  readonly radius: number;
  readonly waterLevel: number;
  readonly seed: number;
  readonly reliefMin: number;
  readonly reliefMax: number;
  readonly focusDir: THREE.Vector3 | null;
  heightAtDir(x: number, y: number, z: number): number;
  terrainNormalAt(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  slopeAt(p: THREE.Vector3): number;
  terrain: {
    moistureAt(x: number, y: number, z: number): number;
    corruptionAt(x: number, y: number, z: number): number;
  };
  biome: {
    plantDensityAt(x: number, y: number, z: number): number;
    /** The terrain mesh's own vertex-colour baker — shared with the grass blades. */
    colorAt(x: number, y: number, z: number, h: number, slope: number, out: THREE.Color, scratch: THREE.Color): void;
  };
  archetype: {
    palette: { deep: number; low: number; mid: number; ridge: number; peak: number; vein: number };
    sky: { zenith: number; horizon: number; nebula: number; fog: number };
    veinStrength: number;
  };
}

export interface WorldZones {
  towers: THREE.Vector3[];
  focus: THREE.Vector3 | null;
  spawns: THREE.Vector3[];
}

export interface WorldOptions {
  scene: THREE.Scene;
  planet: WorldPlanet;
  quality: QualitySettings;
  /** Resource loader (already constructed with the active renderer for KTX2 detection). */
  resources: ResourcesLoader;
  /** Project a world point to CSS pixels (for the occlusion fade); null when behind the camera. */
  projectToScreen?: (world: THREE.Vector3, out: THREE.Vector2) => THREE.Vector2 | null;
  /** Where the local player is; null in menus. */
  localFocus?: () => THREE.Vector3 | null;
}

export class World {
  readonly surface: TerrainSurface;
  /** The planet adapter (plan §4): the ONE terrain query API + this planet's seeded streams. */
  readonly generator: PlanetGenerator;
  /** The physics-side twin of the terrain query (plan §41) — analytical, never a trimesh. */
  readonly physicsSurface: PhysicsSurface;
  readonly raycaster: TerrainRaycaster;
  readonly water: WaterInteraction;
  readonly occlusion: WorldOcclusion;
  readonly visibility: VegetationVisibility;
  readonly physics: WorldPhysics;

  sky: Sky | null = null;
  grass: Grass | null = null;
  trees: Trees[] = [];
  bushes: Bushes | null = null;
  flowers: Flowers | null = null;
  rocks: Rocks | null = null;
  spikes: Spikes | null = null;
  crystals: RadioactiveCrystals | null = null;
  waterSurface: WaterSurface | null = null;
  particles: EnvironmentParticles | null = null;

  placements: EnvironmentPlacements | null = null;
  private readonly treeHash = new VegetationSpatialHash<{ dir: THREE.Vector3; position: THREE.Vector3; radius: number }>();
  private readonly meadows: THREE.Vector3[] = [];

  private loaded = false;
  private active = true;
  private visible = true;
  private rescueLevel = 0;
  /** The per-frame stage roster (plan §45) — World builds, PlanetRenderer ticks. */
  readonly planetRenderer: PlanetRenderer;

  constructor(private readonly options: WorldOptions) {
    const planet = options.planet;
    this.surface = createTerrainSurface(planet);
    this.generator = new PlanetGenerator(planet, this.surface);
    this.physicsSurface = new PhysicsSurface(this.generator.surface);
    this.planetRenderer = new PlanetRenderer(this);
    this.raycaster = new TerrainRaycaster(this.surface);
    this.water = new WaterInteraction(this.surface);

    const cameraPosition = new THREE.Vector3();
    this.occlusion = new WorldOcclusion({
      focusPosition: () => options.localFocus?.() ?? null,
      cameraPosition,
      project: (world, out) => options.projectToScreen?.(world, out) ?? null,
      quality: options.quality.occlusionQuality,
    });

    this.visibility = new VegetationVisibility(options.quality);
    this.physics = new WorldPhysics({
      objectPhysicsDistance: options.quality.objectPhysicsDistance,
      gravity: 9.81,
    });

    // Feed the shared globals the planet's own numbers (radius, waterline, corruption).
    FOLIO.planetRadius.value = planet.radius;
    FOLIO.water.surfaceElevation.value = planet.waterLevel - planet.radius;
    FOLIO.necro.intensity.value = Math.min(1, 0.35 + planet.archetype.veinStrength * 0.45);
  }

  /** Load Folio assets and build every system that depends on them. */
  async load(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const assets = await this.options.resources.loadEnvironment(onProgress);
    await this.physics.init();

    const planet = this.options.planet;
    const scene = this.options.scene;

    this.sky = new Sky({
      zenith: planet.archetype.sky.zenith,
      horizon: planet.archetype.sky.horizon,
      nebula: planet.archetype.sky.nebula,
    });
    scene.add(this.sky.mesh);

    this.particles = new EnvironmentParticles({
      seed: planet.seed,
      budget: this.options.quality.environmentParticles,
      tintA: planet.archetype.sky.zenith,
      tintB: planet.archetype.palette.vein,
    });
    scene.add(this.particles.points);
    this.visibility.registerToggle({
      category: 'particles',
      setVisible: (v) => {
        if (this.particles) this.particles.points.visible = v && this.active;
      },
    });

    // Terrain surface water exists on every planet (patches hide themselves without basins).
    this.waterSurface = new WaterSurface({
      surface: this.surface,
      quality: this.options.quality.waterQuality,
      reliefMin: planet.reliefMin,
    });
    scene.add(this.waterSurface.mesh);
    this.visibility.registerToggle({ category: 'water', setVisible: (v) => this.waterSurface?.setQuality(v ? 1 : 0) });

    this.buildVegetation(assets);
    this.loaded = true;
  }

  /** Placement + scene-graph assembly (deterministic; call once per planet). */
  private buildVegetation(assets: EnvironmentAssets): void {
    const planet = this.options.planet;
    const quality = this.options.quality;
    const scene = this.options.scene;
    const seed = planet.seed;
    const focus = planet.focusDir ? planet.focusDir.clone() : null;

    // ---- 1. procedural placement (plan §66 pipeline). Scenery kit REMOVED (user call
    // 2026-09-30): benches / lampposts / crates & friends did not fit the game (and their
    // nested GLB transforms made them hover). Budget 0 keeps the pipeline intact.
    const generator = new VegetationGenerator({
      surface: this.surface,
      seed,
      budget: {
        trees: Math.round(240 * quality.environmentDensity * quality.treeDensity),
        bushes: Math.round(280 * quality.environmentDensity),
        flowers: Math.round(150 * quality.environmentDensity * quality.flowerDensity),
        scenery: 0,
        rocks: Math.round(560 * quality.environmentDensity),
      },
      zones: { towers: [], focus, spawns: [] },
      moistureAt: (x, y, z) => planet.terrain.moistureAt(x, y, z),
      corruptionAt: (x, y, z) => planet.terrain.corruptionAt(x, y, z),
      reliefMin: planet.reliefMin,
      reliefMax: planet.reliefMax,
    });
    const result = generator.generate();
    this.placements = result.placements;

    // ---- 2. renderers (Folio architecture)
    const focusScreen = () => (this.occlusion.hasTarget ? this.occlusion.screenPosition : null);
    const shadows = quality.environmentShadows;

    const treeOptions = {
      foliageTexture: assets.foliageTexture,
      focusScreenPosition: focusScreen,
      seeThrough: quality.occlusionQuality > 0,
      castShadows: shadows,
    };
    this.trees = [
      new Trees({
        name: 'birch',
        visual: assets.birch.visual,
        placements: result.placements.trees.filter((p) => p.kind === 'BIRCH'),
        colorA: '#ff4f2b',
        colorB: '#ff903f',
        ...treeOptions,
      }),
      new Trees({
        name: 'oak',
        visual: assets.oak.visual,
        placements: result.placements.trees.filter((p) => p.kind === 'OAK'),
        colorA: '#b4b536',
        colorB: '#d8cf3b',
        ...treeOptions,
      }),
      new Trees({
        name: 'cherry',
        visual: assets.cherry.visual,
        placements: result.placements.trees.filter((p) => p.kind === 'CHERRY'),
        colorA: '#ff6d6d',
        colorB: '#ff9990',
        ...treeOptions,
      }),
    ];
    for (const trees of this.trees) scene.add(trees.bodies ?? new THREE.Group(), trees.leaves.mesh);

    this.bushes = new Bushes({
      references: assets.bushes,
      placements: result.placements.bushes,
      foliageTexture: assets.foliageTexture,
      colorA: '#b4b536',
      colorB: '#d8cf3b',
      focusScreenPosition: focusScreen,
      seeThrough: quality.occlusionQuality > 0,
    });
    scene.add(this.bushes.foliage.mesh);

    this.flowers = new Flowers({ placements: result.placements.flowers });
    scene.add(this.flowers.mesh);

    this.rocks = new Rocks({ placements: result.placements.rocks, castShadows: shadows });
    for (const mesh of this.rocks.meshes) scene.add(mesh);

    // Spikes and radioactive crystals are their OWN systems (plan §23/§24): separate draw
    // batches with dedicated acceptance tests, sharing the instancing kernel + material family.
    this.spikes = new Spikes({ placements: result.placements.rocks, castShadows: shadows });
    if (this.spikes.mesh) scene.add(this.spikes.mesh);

    this.crystals = new RadioactiveCrystals({ placements: result.placements.rocks, castShadows: shadows });
    if (this.crystals.mesh) scene.add(this.crystals.mesh);

    // ---- 3. physics registration + occlusion candidates
    this.physics.registerTrees(result.placements.trees);
    for (const tree of result.placements.trees) {
      this.treeHash.insert({ dir: tree.direction.clone(), position: tree.position.clone(), radius: 2.4 * tree.scale + 1.4 });
    }
    this.occlusion.setTreeHash(this.treeHash);

    // ---- 4. LOD registration (plan §39/§88)
    for (const trees of this.trees) {
      this.visibility.registerShaderCulled({ category: 'trees', cullDistance: trees.leaves.cullDistance });
    }
    this.visibility.registerShaderCulled({ category: 'bushes', cullDistance: this.bushes.foliage.cullDistance });
  }

  /**
   * Grow the dense grass around the match's tower zones (plan §10: once, when the match is laid
   * out — never per frame).
   */
  growGrass(towers: THREE.Vector3[], focus: THREE.Vector3 | null): void {
    const planet = this.options.planet;
    const quality = this.options.quality;
    // Scratch for the ground-colour baker the grass shares with the terrain mesh.
    const grassScratch = new THREE.Color();

    // Wild meadows: seeded patches away from the battlefield (plan §13's "world beyond the fight").
    this.meadows.length = 0;
    const rand = this.generator.rand(PLANET_SALT.MEADOWS);
    for (let i = 0; i < 7 && this.meadows.length < 7; i++) {
      const z = rand.next() * 2 - 1;
      const a = rand.next() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const dir = new THREE.Vector3(r * Math.cos(a), z, r * Math.sin(a));
      if (focus && dir.dot(focus) > Math.cos(1.05)) continue;
      if (towers.some((t) => dir.dot(_dir.copy(t).normalize()) > Math.cos(0.34))) continue;
      this.meadows.push(dir);
    }

    this.grass?.dispose();
    this.grass = new Grass({
      surface: this.surface,
      seed: planet.seed,
      density: quality.grassDensity,
      // Field reach: covers the visible ground on a 118 m planet while keeping folio-like
      // blades-per-m² — a tighter window with the same count reads as a denser lawn (56 m ≈
      // 26.6 blades/m² at high quality; ≈44/m² inside the patch blobs — folio's packed lawn).
      maxDistance: 56 * (quality.name === 'low' ? 0.7 : quality.name === 'medium' ? 0.85 : 1),
      towers,
      meadows: this.meadows,
      moistureAt: (x, y, z) => planet.terrain.moistureAt(x, y, z),
      corruptionAt: (x, y, z) => planet.terrain.corruptionAt(x, y, z),
      reliefMin: planet.reliefMin,
      reliefMax: planet.reliefMax,
      waterline01: clamp((planet.waterLevel - planet.reliefMin) / Math.max(1e-3, planet.reliefMax - planet.reliefMin), 0, 1),
      // Blades wear the ground's own colour: the exact BiomeGenerator.colorAt the terrain mesh
      // bakes per vertex — folio's shared terrain colorNode. Without it the blades were
      // green-by-default on every palette (the user's “grass doesn't look like the source
      // repo” screenshot: icy ground with green/blue hatch blades, live review 2026-09-30).
      colorAt: (x, y, z, height, slope, out) => planet.biome.colorAt(x, y, z, height, slope, out, grassScratch),
      castShadows: false,
    });
    this.options.scene.add(this.grass.mesh);
    this.visibility.registerShaderCulled({ category: 'grass', cullDistance: this.grass.cullDistance });
  }

  // ------------------------------------------------------------------ per-frame

  update(
    dt: number,
    cameraPosition: THREE.Vector3,
    focuses: THREE.Vector3[],
    elapsed: number,
    renderState?: RenderState,
  ): void {
    if (!this.loaded) return;

    // The rendering boundary (plan §1): the environment's primary focus is the gameplay
    // snapshot's player when present — the same player the simulation moved this frame.
    const primaryFocus = renderState?.player?.position ?? focuses[0] ?? cameraPosition;

    // The shared state first: everything below reads it.
    if (this.active) FOLIO.update(dt, cameraPosition);
    else FOLIO.update(0, cameraPosition);
    void elapsed;

    // The ordered per-frame roster (plan §45) — construction stays here, ticking lives there.
    this.planetRenderer.update(dt, cameraPosition, focuses, primaryFocus, this.active, renderState);
  }

  /** Watchdog hook (plan §94): trims the environment before gameplay systems. */
  setRescueLevel(level: number): void {
    this.rescueLevel = level;
    this.visibility.setRescueLevel(level);
    this.physics.setEnabled(level < 5);
  }

  /** Menu policy (plan §106/§107): the world stops animating behind the UI. */
  setActive(active: boolean): void {
    this.active = active;
    if (this.grass) this.grass.mesh.visible = this.visible && active;
    if (this.particles) this.particles.points.visible = this.visible && active;
  }

  /** Watchdog scenery drop (kept from the old environment API). */
  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const trees of this.trees) {
      trees.setVisible(visible);
    }
    this.bushes?.setVisible(visible);
    this.flowers?.setVisible(visible);
    this.rocks?.setVisible(visible);
    this.spikes?.setVisible(visible);
    this.crystals?.setVisible(visible);
    this.grass?.setVisible(visible);
    if (this.particles) this.particles.points.visible = visible && this.active;
  }

  /** Facts for the `?planet` debug overlay (plan §90). */
  debugInfoLines(): string[] {
    const planet = this.options.planet;
    const lines = [
      `planet    ${planet.seed}`,
      `radius    ${planet.radius.toFixed(1)} m`,
      `water     ${planet.waterLevel.toFixed(2)}`,
      `relief    ${planet.reliefMin.toFixed(1)} .. ${planet.reliefMax.toFixed(1)}`,
      `quality   ${this.options.quality.name}`,
      `rescue    ${this.rescueLevel}`,
    ];
    if (this.placements) {
      lines.push(
        `trees     ${this.placements.trees.length}`,
        `bushes    ${this.placements.bushes.length}`,
        `flowers   ${this.placements.flowers.length}`,
        `rocks     ${this.placements.rocks.length}`,
      );
    }
    return lines;
  }

  dispose(): void {
    for (const trees of this.trees) trees.dispose();
    this.trees = [];
    this.bushes?.dispose();
    this.flowers?.dispose();
    this.rocks?.dispose();
    this.spikes?.dispose();
    this.crystals?.dispose();
    this.grass?.dispose();
    this.waterSurface?.dispose();
    this.sky?.dispose();
    this.particles?.dispose();
    this.physics.dispose();
    this.occlusion.dispose();
    this.loaded = false;
  }
}

const _dir = new THREE.Vector3();
