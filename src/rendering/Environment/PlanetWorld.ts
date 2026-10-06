/**
 * NECROFALL — the ONE planet-world factory (plan §30: "the most important migration rule").
 *
 * The Dev World and a production match MUST build their world through this single
 * function. Everything downstream — terrain, grass, foliage, water, particles,
 * physics queries — is created here from ONE deterministic pipeline:
 *
 *   seed + ring + radius + focusDir
 *        ↓ PlanetGenerator           (deterministic gameplay terrain)
 *        ↓ PlanetSurfaceData.bake    (the packed GPU maps)
 *        ↓ PlanetSurface             (the CPU source of truth)
 *        ↓ WorldGlobals              (ONE lighting/fog/terrain context)
 *        ↓ PlanetRenderer            (the environment system stack)
 *
 * Callers may only vary: seed / ring / planet config / biome config / spawn point /
 * gameplay objects — never the renderer, the shaders or the visibility rules (§60).
 */
import type * as THREE from 'three/webgpu';
import { Vector3 } from 'three/webgpu';
import type { Scene } from 'three/webgpu';
import type { Quality } from '../Quality';
import type { Ticker } from '../Ticker';
import type { Materials } from '../materials/Materials';
import { Materials as MaterialsClass } from '../materials/Materials';
import type { ResourcesLoader } from '../Assets/ResourcesLoader';
import { PreRenderer } from '../PreRenderer';
import { Wind } from './Wind';
import { Noises } from './Noises';
import type { Fog } from './Fog';
import type { Lighting } from './Lighting';
import { WorldGlobals } from '../WorldGlobals';
import { createTerrainNodes, type TerrainNodeBundle } from './PlanetTerrainNodes';
import { PlanetRenderer } from './PlanetRenderer';
import { PlanetGenerator } from '../../planet/PlanetGenerator';
import { PlanetSurfaceData } from '../../planet/PlanetSurfaceData';
import { PlanetSurface } from '../../planet/PlanetSurface';
import { makePlanetSpec, type PlanetSpec } from '../../planet/PlanetSeed';
import { createTerrainGradient } from '../materials/PlanetPalette';

export interface PlanetWorldParams {
  scene: THREE.Scene;
  ticker: Ticker;
  quality: Quality;
  loader: ResourcesLoader;
  fog: Fog;
  lighting: Lighting;
  /**
   * Optional shared wind field. When omitted the factory builds ONE from the same planet noises
   * every world uses — dev and match can never disagree about the wind (§30).
   */
  wind?: Wind;
  /** Extra material options (e.g. the dev world's `?wireframe`). */
  materialsOptions?: { wireframe?: boolean };
  /** Deterministic world seed (the planet's `seed`). */
  seed: number;
  ring: number;
  radius: number;
  label: string;
  /**
   * Rank matches bias the terrain towards the battlefield centre. MUST be the same value the
   * gameplay `Planet` facade uses, or the rendered ground and the analytic field drift (§30).
   */
  focusDir?: THREE.Vector3 | null;
  /** Where the world clears vegetation (spawn / battle centre). */
  spawnDirection?: THREE.Vector3;
  /**
   * Picks the spawn direction from the BAKED surface (the dev world scans for a sunlit, grassy,
   * flat spot). Runs before the environment systems are created, so everything contours to it.
   */
  spawnSelector?: (ctx: { surface: PlanetSurface; generator: PlanetGenerator; spec: PlanetSpec }) => THREE.Vector3;
  /** Shader time uniform (radioactive pulses). */
  time: any;
  onProgress?: (ratio: number, label: string) => void;
  /**
   * Build the world HIDDEN (a background pre-build): the group is invisible from the very first
   * build stage until the adopting match reveals it (`wireWorld`). Without this, the planet would
   * overlap the menu world on screen for the whole preload.
   */
  hidden?: boolean;
}

export interface PlanetWorldResult {
  world: PlanetRenderer;
  spec: PlanetSpec;
  generator: PlanetGenerator;
  surfaceData: PlanetSurfaceData;
  surface: PlanetSurface;
  nodes: TerrainNodeBundle;
  materials: Materials;
  preRenderer: PreRenderer;
  noises: Noises;
  wind: Wind;
  /** The resolved spawn/clearing direction (from `spawnSelector` when provided). */
  spawnDirection: THREE.Vector3;
}

/**
 * Build the planet world. The caller owns disposal (`result.world.dispose()`), but ONLY the
 * current world may stay attached — a stale build (the match changed while baking) must be
 * disposed by the caller immediately.
 */
export async function createPlanetWorld(params: PlanetWorldParams): Promise<PlanetWorldResult> {
  const { onProgress } = params;
  const spec = makePlanetSpec(params.seed, params.ring, params.radius, params.label);
  if (params.focusDir) spec.focusDir = params.focusDir;

  onProgress?.(0.05, 'generating planet');
  const generator = new PlanetGenerator(spec);
  const surfaceData = await PlanetSurfaceData.bake(generator, (ratio, label) => {
    onProgress?.(0.05 + ratio * 0.35, label);
  });
  const surface = new PlanetSurface(generator, surfaceData);

  const gradientTexture = createTerrainGradient(generator.gradientStops());
  const nodes = createTerrainNodes(surfaceData, gradientTexture, spec.radius);
  const noises = new Noises(params.seed ^ 0x51ab);
  const wind = params.wind ?? new Wind(noises, params.ticker);

  // ONE environment context for every material built from here on (plan §4/§23).
  const globals = new WorldGlobals();
  globals.radius = spec.radius;
  globals.lighting = params.lighting;
  globals.fog = params.fog;
  globals.terrain = nodes;
  globals.wind = wind;
  WorldGlobals.current = globals;

  // Materials bind the globals at construction — always created AFTER the context exists.
  const materials = new MaterialsClass(params.materialsOptions ?? {});
  const preRenderer = new PreRenderer((params.seed + 3) >>> 0);

  const spawnDirection = params.spawnSelector
    ? params.spawnSelector({ surface, generator, spec })
    : (params.spawnDirection ?? new Vector3(0.55, 0.52, 0.65)).clone().normalize();

  onProgress?.(0.42, 'building environment');
  const world = await PlanetRenderer.create(
    {
      scene: params.scene,
      ticker: params.ticker,
      quality: params.quality,
      materials,
      loader: params.loader,
      preRenderer,
      wind,
      noises,
      fog: params.fog,
      lighting: params.lighting,
      surface,
      generator,
      nodes,
      time: params.time,
      spawnDirection,
      hidden: params.hidden,
    },
    (ratio, label) => onProgress?.(0.42 + ratio * 0.58, label),
  );

  // r186 plan §1: the world now OWNS the resources it was built from. `PlanetRenderer.dispose`
  // releases them through the registry after its systems are torn down — the baked terrain
  // textures, the gradient lookup, the per-world material registry (palette atlas + every GLB
  // remap) and the generated foliage SDF. Without this, every planet replacement leaked them.
  world.resources.own(surfaceData).own(gradientTexture).own(materials).own(preRenderer);

  return { world, spec, generator, surfaceData, surface, nodes, materials, preRenderer, noises, wind, spawnDirection };
}
