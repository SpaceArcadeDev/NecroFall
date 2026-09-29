// NECROFALL — WORLD ENVIRONMENT (rework plan §1/§85/§87).
//
// The composition root of the entire environment rework. One instance per planet/menu world.
//
//     WorldEnvironment
//       ├─ terrain layer     LegacyTerrainProvider (macro) + §5 detail layers + SurfaceQuery
//       ├─ cells             cube-sphere partition, streamed by EnvironmentCulling (plan §19/§72)
//       ├─ vegetation        grass / trees / rocks (instanced, deterministic, cell-streamed)
//       ├─ props             crates / barrels / wreckage (destructible layer, plan §56/§57)
//       ├─ water             sphere-trimmed surface + shoreline dressing (plan §14-§16)
//       ├─ physics           SurfaceCollider + PhysicsWorld + pooled debris (plan §21-§23/§58)
//       ├─ interaction       destruction authority + occlusion/look-through (plan §26-§30/§54)
//       ├─ atmosphere        lighting mood + fog + weather (plan §31-§35)
//       └─ rendering         quality manager + LOD dials + draw composition + telemetry (§43-§67)
//
// Everything a caller can do with it:
//
//     update(dt, frame)            — one tick from Planet/Game (frames carry focuses + camera)
//     setGameplayZones(positions)  — tower/pad feet become keep-out zones (plan §61)
//     explosion(pos, radius, power)— the gameplay→environment destruction seam (plan §24/§57)
//     drainDestruction()/applyDestruction(batch) — host-authoritative state sync (plan §73)
//     setCategoryVisible()/hotspots — the GPU hotspot debugger (plan §66)
//     telemetryLines()             — F1/F9 diagnostics (plan §65)
import * as THREE from 'three';
import type { QualityName } from '../core/Config';
import { createEnvironmentConfig, profileLabel, type EnvironmentConfig } from './EnvironmentConfig';
import { SHADER_GLOBALS } from './ShaderGlobals';
import { LegacyTerrainProvider } from './terrain/PlanetTerrainProvider';
import { TerrainSurfaceQuery } from './terrain/TerrainSurfaceQuery';
import { EnvironmentCells } from './cells/EnvironmentCells';
import { GameplayMasks } from './GameplayMasks';
import { biomeDefinition } from './EnvironmentPalette';
import { AssetRegistry } from './AssetRegistry';
import { DestructionLedger } from './interaction/DestructionLedger';
import type { EnvironmentContext, EnvironmentFxHooks, EnvironmentSystem } from './EnvironmentContext';
import { FoliageSystem } from './foliage/FoliageSystem';
import { GrassSystem } from './foliage/GrassSystem';
import { TreeSystem } from './foliage/TreeSystem';
import { RockSystem } from './foliage/RockSystem';
import { PropSystem } from './props/PropSystem';
import { WaterSystem } from './water/WaterSystem';
import { ShorelineSystem } from './water/ShorelineSystem';
import { SurfaceCollider } from './physics/SurfaceCollider';
import { PhysicsWorld } from './physics/PhysicsWorld';
import { DynamicPropPhysics } from './physics/DynamicPropPhysics';
import { InteractionSystem } from './physics/InteractionSystem';
import { DestructibleSystem, type DestructionBatch } from './interaction/DestructibleSystem';
import { OcclusionSystem } from './interaction/OcclusionSystem';
import { LookThroughSystem, type OccluderSource } from './interaction/LookThroughSystem';
import { VegetationInteraction, type FocusInput } from './interaction/VegetationInteraction';
import { EnvironmentLighting } from './atmosphere/EnvironmentLighting';
import { FogSystem } from './atmosphere/FogSystem';
import { WeatherSystem } from './atmosphere/WeatherSystem';
import { EnvironmentQualityManager, detectRendererCapabilities, type RendererCapabilities } from './rendering/EnvironmentQuality';
import { EnvironmentLOD } from './rendering/EnvironmentLOD';
import { EnvironmentCulling } from './rendering/EnvironmentCulling';
import { EnvironmentRenderer, type EnvironmentCategory } from './rendering/EnvironmentRenderer';
import { EnvironmentTelemetry, type HotspotState } from './EnvironmentTelemetry';
import type { TerrainGenerator } from './TerrainGenerator';
import type { BiomeGenerator } from './BiomeGenerator';
import type { WindUniforms } from './Vegetation';

export interface EnvironmentFrame {
  cameraPos: THREE.Vector3;
  cameraQuat: THREE.Quaternion;
  /** Match elapsed seconds — drives the deterministic weather schedule (plan §34). */
  elapsed: number;
  /** Gameplay entities the vegetation should react to (plan §25/§55). */
  focuses: readonly FocusInput[];
  /** The local player (or menu focus) — shadow follow + physics LOD centre (plan §23/§49). */
  localFocus: THREE.Vector3 | null;
}

export interface WorldEnvironmentOptions {
  /** Parent node (usually the scene) — the environment adds its own root group under it. */
  parent: THREE.Object3D;
  seed: number;
  qualityName: QualityName;
  radius: number;
  terrain: TerrainGenerator;
  biomeGen: BiomeGenerator;
  wind: WindUniforms;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  rim: THREE.DirectionalLight;
  sceneForFog?: THREE.Scene | null;
  fx?: EnvironmentFxHooks;
  capabilities?: RendererCapabilities;
  /** Watchdog rescue level (0..3) — drives the dynamic quality step (plan §47). */
  qualityStep?: () => number;
  /** Hotspot hooks owned by the game (terrain mesh / shadow map live outside this class). */
  hooks?: {
    setTerrainVisible?(visible: boolean): void;
    setShadowsEnabled?(enabled: boolean): void;
  };
}

const _dirScratch = new THREE.Vector3();
const _focusDirs: THREE.Vector3[] = [];

/** Sun direction is owned by the planet's shader globals; read it here for the shadow camera. */
function _sunDirFromGlobals(): THREE.Vector3 {
  return SHADER_GLOBALS.uSunDir.value as THREE.Vector3;
}

export class WorldEnvironment {
  readonly config: EnvironmentConfig;
  readonly provider: LegacyTerrainProvider;
  readonly query: TerrainSurfaceQuery;
  readonly cells: EnvironmentCells;
  readonly masks: GameplayMasks;
  readonly assets: AssetRegistry;
  readonly ledger: DestructionLedger;
  readonly root: THREE.Group;

  readonly foliage: FoliageSystem;
  readonly grass: GrassSystem;
  readonly trees: TreeSystem;
  readonly rocks: RockSystem;
  readonly props: PropSystem;
  readonly water: WaterSystem;
  readonly shoreline: ShorelineSystem;

  readonly collider: SurfaceCollider;
  readonly physics: PhysicsWorld;
  readonly debris: DynamicPropPhysics;
  readonly interaction: InteractionSystem;
  readonly destructible: DestructibleSystem;

  readonly occlusion: OcclusionSystem;
  readonly lookThrough: LookThroughSystem;
  readonly vegetation: VegetationInteraction;

  readonly lighting: EnvironmentLighting;
  readonly fog: FogSystem;
  readonly weather: WeatherSystem;

  readonly quality: EnvironmentQualityManager;
  readonly lod: EnvironmentLOD;
  readonly culling: EnvironmentCulling;
  readonly renderer: EnvironmentRenderer;
  readonly telemetry: EnvironmentTelemetry;

  private readonly ctx: EnvironmentContext;
  private hooks: WorldEnvironmentOptions['hooks'];
  private readonly streamedSystems: EnvironmentSystem[] = [];
  private farT = 0;
  private interT = 0;
  private visT = 0;
  private debrisT = 0;
  private frameCount = 0;
  private disposed = false;

  constructor(private readonly options: WorldEnvironmentOptions) {
    const biome = biomeDefinition(options.biomeGen.planetBiome);
    this.config = createEnvironmentConfig(options.seed, options.qualityName, options.radius, biome.id);

    const root = new THREE.Group();
    root.name = 'environment';
    options.parent.add(root);
    this.root = root;

    this.assets = new AssetRegistry();
    this.ledger = new DestructionLedger();
    this.masks = new GameplayMasks(options.radius);
    this.provider = new LegacyTerrainProvider(options.terrain, options.biomeGen, this.config);
    this.query = new TerrainSurfaceQuery(this.provider);
    this.cells = new EnvironmentCells(options.radius, this.config.profile.cellsPerFace);

    this.quality = new EnvironmentQualityManager(
      this.config.profile,
      options.capabilities ?? detectRendererCapabilities()
    );
    this.lod = new EnvironmentLOD();
    this.culling = new EnvironmentCulling(this.cells, []);
    this.renderer = new EnvironmentRenderer();

    // Activate critical assets first (plan §68) — the shared base geometries the cell builders
    // will clone from.
    this.assets.register('geo:fallback', () => new THREE.BufferGeometry(), true);

    this.ctx = {
      seed: this.config.planetSeed,
      version: this.config.version,
      radius: options.radius,
      profile: this.config.profile,
      provider: this.provider,
      query: this.query,
      cells: this.cells,
      masks: this.masks,
      biome,
      wind: options.wind,
      root,
      ledger: this.ledger,
      assets: this.assets,
      fx: options.fx,
      qualityScale: () => this.quality.densityScale(),
    };

    // ---- systems ------------------------------------------------------------------------------
    this.grass = new GrassSystem(this.ctx);
    this.trees = new TreeSystem(this.ctx);
    this.rocks = new RockSystem(this.ctx);
    this.props = new PropSystem(this.ctx);
    this.shoreline = new ShorelineSystem(this.ctx);
    this.foliage = new FoliageSystem(this.grass, this.trees, this.rocks);

    this.renderer.add(this.grass, 'grass');
    this.renderer.add(this.trees, 'trees');
    this.renderer.add(this.rocks, 'rocks');
    this.renderer.add(this.props, 'props');
    this.renderer.add(this.shoreline, 'shoreline');
    this.streamedSystems.push(this.grass, this.trees, this.rocks, this.props, this.shoreline);

    // LOD dials (plan §6/§47): every system feeds its materials in.
    for (const system of this.streamedSystems) {
      const provider = system as EnvironmentSystem & {
        lodMaterials?: () => { lod: THREE.ShaderMaterial[]; tiers: THREE.ShaderMaterial[] };
      };
      const materials = provider.lodMaterials?.();
      materials?.lod.forEach(m => this.lod.registerMaterial(m));
      materials?.tiers.forEach(m => this.lod.registerTierMaterial(m));
    }

    // ---- water ---------------------------------------------------------------------------------
    this.water = new WaterSystem(this.ctx);
    this.renderer.add(this.water, 'water');

    // ---- physics + interaction -------------------------------------------------------------------
    this.collider = new SurfaceCollider(this.provider, this.config.profile);
    this.physics = new PhysicsWorld(this.collider, this.config.profile);
    this.debris = new DynamicPropPhysics(this.ctx, this.physics);
    this.interaction = new InteractionSystem(this.ctx, this.trees, this.props, this.physics, this.debris, this.water);
    this.destructible = new DestructibleSystem(this.ctx, this.trees, this.props);

    this.occlusion = new OcclusionSystem();
    this.lookThrough = new LookThroughSystem(this.occlusion, [
      this.trees as OccluderSource,
      this.rocks as OccluderSource,
    ]);
    this.vegetation = new VegetationInteraction(this.grass, this.lookThrough);

    // ---- atmosphere ------------------------------------------------------------------------------
    this.lighting = new EnvironmentLighting(options.sun, options.hemi, options.rim, this.config.profile);
    this.fog = new FogSystem(this.ctx, options.sceneForFog ?? null);
    this.weather = new WeatherSystem(this.ctx, this.lighting, this.fog);
    this.renderer.add(this.weather, 'weather');

    this.culling.setSystems(this.streamedSystems);
    this.hooks = options.hooks;

    this.telemetry = new EnvironmentTelemetry({
      profileLabel: () => `${profileLabel(this.config.profile)} · cells ${this.cells.perFace}² (${this.cells.count})`,
      qualityLabel: () => this.quality.label(),
      streamLabel: () => {
        const s = this.culling.stats();
        return `active ${s.active}  built ${s.built}  dropped ${s.dropped}  last +${s.lastBuilt}/-${s.lastDropped}`;
      },
      instanceLabel: () => {
        const totals = this.renderer.totals();
        const top = totals.bySystem
          .filter(s => s.instances > 0)
          .sort((a, b) => b.instances - a.instances)
          .slice(0, 5)
          .map(s => `${s.name} ${s.instances}`)
          .join(' · ');
        return `${totals.instances} total · ${top || '—'}`;
      },
      physicsLabel: () => {
        const p = this.physics.stats();
        return `${p.bodies} bodies (${p.stepped} stepped, ${p.sleeping} sleeping) · debris ${this.debris.stats().instances}`;
      },
      weatherLabel: () => `${this.weather.kind} ${(this.weather.strength * 100).toFixed(0)}% · fog ${this.fog.fogDensity.toFixed(4)}`,
      occlusionLabel: () => `${this.occlusion.size} fades · ${this.lookThrough.focusCount} focuses`,
      ledgerLabel: () => `${this.ledger.size} changes`,
    });
  }

  // ------------------------------------------------------------------ late wiring (game seams)

  /** Wires the visual FX hooks once the game's Effects pool exists (plan §24). */
  setFx(hooks: EnvironmentFxHooks): void {
    this.ctx.fx = hooks;
  }

  /** The game's watchdog rescue level (0..3) drives the dynamic quality step (plan §47). */
  setQualityStepProvider(fn: () => number): void {
    this.options.qualityStep = fn;
  }

  /** Hotspot hooks owned by the game (terrain mesh / shadow map — plan §66). */
  setHotspotHooks(hooks: WorldEnvironmentOptions['hooks']): void {
    this.hooks = hooks;
  }

  // ------------------------------------------------------------------ per match / gameplay seams

  /**
   * Tower and pad feet become cleared zones (plan §61). Existing cells are rebuilt so a Beacon
   * that lands on a meadow gets its clearing immediately.
   */
  setGameplayZones(positions: readonly THREE.Vector3[], clearRadius = 13): void {
    for (const pos of positions) {
      _dirScratch.copy(pos).normalize();
      this.masks.addClear(_dirScratch, clearRadius);
    }
    this.culling.clear();
  }

  /** The gameplay→environment destruction seam (plan §24/§57). Call wherever damage happens. */
  explosion(pos: THREE.Vector3, radius: number, power: number): number {
    return this.interaction.explosion(pos, radius, power);
  }

  splash(pos: THREE.Vector3, radius: number): void {
    this.interaction.splash(pos, radius);
  }

  // ------------------------------------------------------------------ network (host authority)

  /** Host: state changes since the last network tick (plan §73). */
  drainDestruction(): DestructionBatch {
    return this.destructible.drainChanges();
  }

  /** Client: apply a host batch. */
  applyDestruction(batch: DestructionBatch): void {
    this.destructible.applyNetwork(batch);
  }

  /** Host: full ledger for a mid-match joiner. */
  serialiseDestruction(): DestructionBatch {
    return this.destructible.serialise();
  }

  // ------------------------------------------------------------------ visibility / hotspots

  setCategoryVisible(category: EnvironmentCategory, visible: boolean): void {
    if (category === 'terrain') {
      this.hooks?.setTerrainVisible?.(visible);
      return;
    }
    if (category === 'shadows') {
      this.hooks?.setShadowsEnabled?.(visible);
      return;
    }
    if (category === 'fog') {
      this.fog.setEnabled(visible);
      return;
    }
    this.renderer.setCategoryVisible(category, visible);
  }

  /** F10 (plan §66): cycles one hotspot and applies it. Returns a label for the toast. */
  cycleHotspot(): string {
    const { category, enabled } = this.telemetry.cycleHotspot();
    this.applyHotspot(category, enabled);
    return `${category.toUpperCase()} ${enabled ? 'ON' : 'OFF'}`;
  }

  private applyHotspot(category: keyof HotspotState, enabled: boolean): void {
    const map: Record<keyof HotspotState, EnvironmentCategory> = {
      terrain: 'terrain', grass: 'grass', trees: 'trees', rocks: 'rocks', props: 'props',
      water: 'water', weather: 'weather', fog: 'fog', shadows: 'shadows',
    };
    this.setCategoryVisible(map[category], enabled);
  }

  /** F9 — environment detail lines for the debug overlay (plan §65). */
  telemetryLines(): string[] {
    return this.telemetry.lines();
  }

  toggleTelemetry(): boolean {
    return this.telemetry.toggleDetail();
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, frame: EnvironmentFrame): void {
    if (this.disposed) return;
    const profile = this.config.profile;
    this.frameCount++;

    // Dynamic quality step (plan §47) — mirrored from the game's watchdog.
    const step = this.options.qualityStep?.() ?? 0;
    if (this.quality.setStep(step)) {
      this.lod.setScales(this.quality.lodScale(), this.quality.tierScale());
    }

    // --- streaming (far frequency — plan §71/§72) -----------------------------------------------
    this.farT -= dt;
    if (this.farT <= 0) {
      this.farT = 1 / profile.updateHz.far;
      _focusDirs.length = 0;
      for (const focus of frame.focuses) {
        if (focus.kind !== 'player') continue;
        if (_focusDirs.length >= 4) break;
        _focusDirs.push(_dirScratch.copy(focus.position).normalize().clone());
      }
      if (_focusDirs.length === 0 && frame.localFocus) {
        _focusDirs.push(_dirScratch.copy(frame.localFocus).normalize().clone());
      }
      this.culling.update(_focusDirs, profile.activationRadius, profile.cellBuildBudget);
    }

    // --- per-frame system uniform updates --------------------------------------------------------
    this.renderer.update(dt);

    // --- interaction/visibility frequencies (plan §71) --------------------------------------------
    this.interT -= dt;
    if (this.interT <= 0) {
      this.interT = 1 / profile.updateHz.interaction;
      this.vegetation.setInputs(frame.focuses, frame.cameraPos);
    }
    this.visT -= dt;
    if (this.visT <= 0) {
      this.visT = 1 / profile.updateHz.visibility;
      this.lookThrough.setCamera(frame.cameraPos);
      this.vegetation.update(profile.lookThrough);
    }
    this.occlusion.update(dt);

    // --- physics (plan §21-§23) -------------------------------------------------------------------
    const focus = frame.localFocus ?? frame.cameraPos;
    this.physics.setFocus(focus);
    this.physics.step(dt, this.frameCount);
    this.debrisT -= dt;
    if (this.debrisT <= 0) {
      this.debrisT = 1 / Math.min(profile.updateHz.interaction, 30);
      this.debris.sync(this.debrisT);
    }
    this.interaction.update(dt);

    // --- atmosphere (plan §31-§35) ----------------------------------------------------------------
    this.weather.advance(dt, frame.elapsed, frame.cameraPos, frame.cameraQuat);
    this.lighting.update(dt, focus, _sunDirFromGlobals());
    this.fog.update(dt);
  }

  setVisible(visible: boolean): void {
    this.renderer.setVisible(visible);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.culling.clear();
    this.occlusion.clear();
    this.renderer.disposeAll();
    this.debris.dispose();
    this.physics.clear();
    this.assets.clear();
    this.root.removeFromParent();
    this.root.clear();
  }
}
