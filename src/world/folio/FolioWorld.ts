// NECROFALL — FolioWorld (plan §3, §61): the world's environment layer, assembled Folio-style.
//
//   Planet (terrain data + mesh)
//        │
//   FolioWorld
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
import { FOLIO } from './FolioShaderGlobals';
import { FolioResources, type FolioEnvironmentAssets } from './FolioResources';
import { Trees } from './vegetation/Trees';
import { Bushes } from './vegetation/Bushes';
import { Flowers } from './vegetation/Flowers';
import { Grass } from './vegetation/Grass';
import { Rocks } from './vegetation/Rocks';
import { WaterSurface } from './environment/WaterSurface';
import { Sky } from './environment/Sky';
import { EnvironmentParticles } from './environment/EnvironmentParticles';
import { WorldPhysics } from './physics/WorldPhysics';
import { TerrainRaycaster } from './physics/TerrainRaycaster';
import { WaterInteraction } from './physics/WaterInteraction';
import { WorldOcclusion } from './occlusion/WorldOcclusion';
import { VegetationVisibility } from '../vegetation/VegetationVisibility';
import { VegetationGenerator } from '../vegetation/VegetationGenerator';
import { VegetationSpatialHash } from '../vegetation/VegetationSpatialHash';
import { createTerrainSurface, type TerrainSurface } from '../TerrainSurface';
import type { QualitySettings } from '../../core/Config';
import type { EnvironmentPlacements } from '../vegetation/VegetationTypes';

/** The Planet shape FolioWorld builds from (structural — Planet stays free to evolve). */
export interface FolioWorldPlanet {
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
  biome: { plantDensityAt(x: number, y: number, z: number): number };
  archetype: {
    palette: { deep: number; low: number; mid: number; ridge: number; peak: number; vein: number };
    sky: { zenith: number; horizon: number; nebula: number; fog: number };
    veinStrength: number;
  };
}

export interface FolioWorldZones {
  towers: THREE.Vector3[];
  focus: THREE.Vector3 | null;
  spawns: THREE.Vector3[];
}

export interface FolioWorldOptions {
  scene: THREE.Scene;
  planet: FolioWorldPlanet;
  quality: QualitySettings;
  /** Resource loader (already constructed with the active renderer for KTX2 detection). */
  resources: FolioResources;
  /** Project a world point to CSS pixels (for the occlusion fade); null when behind the camera. */
  projectToScreen?: (world: THREE.Vector3, out: THREE.Vector2) => THREE.Vector2 | null;
  /** Where the local player is; null in menus. */
  localFocus?: () => THREE.Vector3 | null;
}

export class FolioWorld {
  readonly surface: TerrainSurface;
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
  waterSurface: WaterSurface | null = null;
  particles: EnvironmentParticles | null = null;

  placements: EnvironmentPlacements | null = null;
  private readonly treeHash = new VegetationSpatialHash<{ dir: THREE.Vector3; position: THREE.Vector3; radius: number }>();
  private readonly meadows: THREE.Vector3[] = [];

  private loaded = false;
  private active = true;
  private visible = true;
  private rescueLevel = 0;
  private cpuTimer = 0;

  constructor(private readonly options: FolioWorldOptions) {
    const planet = options.planet;
    this.surface = createTerrainSurface(planet);
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
    });
    scene.add(this.waterSurface.mesh);
    this.visibility.registerToggle({ category: 'water', setVisible: (v) => this.waterSurface?.setQuality(v ? 1 : 0) });

    this.buildVegetation(assets);
    this.loaded = true;
  }

  /** Placement + scene-graph assembly (deterministic; call once per planet). */
  private buildVegetation(assets: FolioEnvironmentAssets): void {
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
        rocks: Math.round(420 * quality.environmentDensity),
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

    // Wild meadows: seeded patches away from the battlefield (plan §13's "world beyond the fight").
    this.meadows.length = 0;
    const rand = new (class {
      s = (planet.seed ^ 0x5747) >>> 0;
      next(): number {
        this.s = (this.s + 0x6d2b79f5) >>> 0;
        let t = this.s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      }
    })();
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
      maxDistance: 62 * (quality.name === 'low' ? 0.7 : quality.name === 'medium' ? 0.85 : 1),
      towers,
      meadows: this.meadows,
      moistureAt: (x, y, z) => planet.terrain.moistureAt(x, y, z),
      corruptionAt: (x, y, z) => planet.terrain.corruptionAt(x, y, z),
      reliefMin: planet.reliefMin,
      reliefMax: planet.reliefMax,
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
  ): void {
    if (!this.loaded) return;

    // The shared state first: everything below reads it.
    if (this.active) FOLIO.update(dt, cameraPosition);
    else FOLIO.update(0, cameraPosition);
    void elapsed;

    // Occlusion: screen position + candidate tests (the fade anchor every Foliage reads).
    this.occlusion.update(dt);

    // Visibility budgets at 30 Hz (world) — pass the primary focus.
    this.visibility.update(dt, focuses[0] ?? cameraPosition);

    // Sky + particles follow the camera.
    this.sky?.update(cameraPosition);
    if (this.active) this.particles?.update(cameraPosition);

    // Water patch recentring (throttled internally).
    this.waterSurface?.update(focuses[0] ?? cameraPosition);

    // Grass: folio's camera-scrolling field follows the view (a uniform write per frame).
    this.grass?.update(focuses[0] ?? cameraPosition);

    // Foliage see-through edge scaling (throttled to ~10 Hz internally by the distance check).
    this.cpuTimer -= dt;
    if (this.cpuTimer <= 0) {
      this.cpuTimer = 0.1;
      const cameraDistance = cameraPosition.length();
      const focusDistance = cameraPosition.distanceTo(focuses[0] ?? cameraPosition);
      for (const trees of this.trees) trees.leaves.update(cameraDistance * this.occlusion.fadeMultiplier, focusDistance);
      this.bushes?.foliage.update(cameraDistance * this.occlusion.fadeMultiplier, focusDistance);
    }

    // Physics (Rapier) — environment bodies only; terrain stays analytical (plan §25).
    if (this.active) this.physics.update(dt, focuses);
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
    this.grass?.setVisible(visible);
    if (this.particles) this.particles.points.visible = visible && this.active;
  }

  dispose(): void {
    for (const trees of this.trees) trees.dispose();
    this.trees = [];
    this.bushes?.dispose();
    this.flowers?.dispose();
    this.rocks?.dispose();
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
