// NECROFALL — debug URL switches (plan §90).
//
// Flip these on the URL. They are read once per world attach; everything is best-effort and
// never writes gameplay state:
//
//   ?renderstats    fps / draw-call / triangle overlay (owned by Rendering — works alone)
//   ?terrain        TERRAIN VIEW: hide every decoration (grass, trees, bushes, flowers, rocks,
//                   spikes, crystals, puddles, particles) — the planet + sky remain
//   ?grass          ISOLATE: terrain + grass only
//   ?foliage        ISOLATE: terrain + trees / bushes / flowers only
//   ?grass&foliage  ISOLATE: terrain + both families (rocks & co. stay hidden)
//   ?shadows        disable shadow-map rendering (perf comparison — the sun light stays)
//   ?wireframe      wireframe on every environment material (terrain stays shaded)
//   ?gpu            badge with the live backend (webgpu / webgl2) + adapter description
//   ?planet         overlay with the planet's generation facts (seed, radius, relief, counts)
//
// The isolate switches follow the "hide all meshes, then show one system" workflow the live
// reviews used, but from the URL. Gameplay objects (player, enemies, towers, towers' VFX) are
// never touched. The suppression is re-asserted every frame (particles / puddles re-show
// themselves inside their own update()), so it sticks for the life of the page — and survives
// world rewires (every world attach re-registers). `window.nfDebug` exposes the parsed flags.
import type * as THREE from 'three/webgpu';
import type { Rendering } from './Rendering';
import type { Ticker } from './Ticker';
import { TICK } from './Ticker';
import type { World } from './Environment/World';

export interface DebugSwitches {
  renderstats: boolean;
  terrain: boolean;
  grass: boolean;
  foliage: boolean;
  shadows: boolean;
  wireframe: boolean;
  gpu: boolean;
  planet: boolean;
}

export function readDebugSwitches(): DebugSwitches {
  const keys = new Set<string>();
  if (typeof location !== 'undefined') {
    for (const [key] of new URLSearchParams(location.search)) keys.add(key.toLowerCase());
  }
  const has = (key: string): boolean => keys.has(key);
  return {
    renderstats: has('renderstats'),
    terrain: has('terrain'),
    grass: has('grass'),
    foliage: has('foliage'),
    shadows: has('shadows'),
    wireframe: has('wireframe'),
    gpu: has('gpu'),
    planet: has('planet'),
  };
}

/** Which environment systems stay hidden for the current world. */
interface Suppression {
  grass: boolean;
  trees: boolean;
  bushes: boolean;
  flowers: boolean;
  rocks: boolean;
  spikes: boolean;
  crystals: boolean;
  water: boolean;
  particles: boolean;
}

function buildSuppression(flags: DebugSwitches): Suppression {
  const isolate = flags.terrain || flags.grass || flags.foliage;
  if (!isolate) {
    return {
      grass: false,
      trees: false,
      bushes: false,
      flowers: false,
      rocks: false,
      spikes: false,
      crystals: false,
      water: false,
      particles: false,
    };
  }
  return {
    grass: !flags.grass,
    trees: !flags.foliage,
    bushes: !flags.foliage,
    flowers: !flags.foliage,
    rocks: true,
    spikes: true,
    crystals: true,
    water: true,
    particles: true,
  };
}

const anySuppressed = (state: Suppression): boolean =>
  state.grass ||
  state.trees ||
  state.bushes ||
  state.flowers ||
  state.rocks ||
  state.spikes ||
  state.crystals ||
  state.water ||
  state.particles;

// The current world + suppression — refreshed on every world attach; the tick re-asserts it.
let activeWorld: World | null = null;
let suppression: Suppression | null = null;
let subscribed = false;
let gpuBadge: HTMLElement | null = null;
let planetOverlay: HTMLElement | null = null;

/** Per-frame re-assert (subscribed at TICK.GAMEPLAY_VFX, after the environment update). */
export function enforceDebugSuppression(): void {
  const world = activeWorld;
  const state = suppression;
  if (!world || !state) return;

  if (state.grass && world.grass) world.grass.mesh.visible = false;
  if (state.trees) {
    for (const trees of world.trees) {
      if (trees.bodies) trees.bodies.visible = false;
      trees.leaves.mesh.visible = false;
    }
  }
  if (state.bushes && world.bushes) world.bushes.foliage.mesh.visible = false;
  if (state.flowers && world.flowers) world.flowers.mesh.visible = false;
  if (state.rocks) for (const mesh of world.rocks?.meshes ?? []) mesh.visible = false;
  if (state.spikes && world.spikes?.mesh) world.spikes.mesh.visible = false;
  if (state.crystals && world.crystals?.mesh) world.crystals.mesh.visible = false;
  if (state.water && world.waterSurface) world.waterSurface.mesh.visible = false;
  if (state.particles && world.particles) world.particles.points.visible = false;
}

export interface DebugContext {
  rendering: Rendering;
  world: World;
  ticker: Ticker;
}

export function applyDebugSwitches(context: DebugContext): DebugSwitches {
  const flags = readDebugSwitches();

  activeWorld = context.world;
  suppression = buildSuppression(flags);

  if (anySuppressed(suppression)) {
    enforceDebugSuppression();
    if (!subscribed) {
      subscribed = true;
      context.ticker.on(TICK.GAMEPLAY_VFX, enforceDebugSuppression);
    }
  }

  if (flags.shadows) {
    context.rendering.renderer.shadowMap.enabled = false;
    console.info('[NECROFALL][debug] ?shadows — shadow-map rendering disabled');
  }
  if (flags.wireframe) setEnvironmentWireframe(context.world, true);
  if (flags.gpu) mountGpuBadge(context.rendering);
  if (flags.planet) mountPlanetOverlay(context.world);

  if (typeof window !== 'undefined') {
    (window as unknown as { nfDebug?: DebugSwitches }).nfDebug = flags;
  }
  return flags;
}

function setEnvironmentWireframe(world: World, on: boolean): void {
  const roots: THREE.Object3D[] = [];
  if (world.grass) roots.push(world.grass.mesh);
  for (const trees of world.trees) {
    if (trees.bodies) roots.push(trees.bodies);
    roots.push(trees.leaves.mesh);
  }
  if (world.bushes) roots.push(world.bushes.foliage.mesh);
  if (world.flowers) roots.push(world.flowers.mesh);
  for (const mesh of world.rocks?.meshes ?? []) roots.push(mesh);
  if (world.spikes?.mesh) roots.push(world.spikes.mesh);
  if (world.crystals?.mesh) roots.push(world.crystals.mesh);
  if (world.waterSurface) roots.push(world.waterSurface.mesh);
  if (world.sky) roots.push(world.sky.mesh);

  const materials = new Set<THREE.Material>();
  for (const root of roots) {
    root.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      if (Array.isArray(material)) {
        for (const entry of material) materials.add(entry);
      } else if (material) {
        materials.add(material);
      }
    });
  }
  for (const material of materials) {
    const target = material as THREE.Material & { wireframe?: boolean };
    if ('wireframe' in target) target.wireframe = on;
  }
}

function mountGpuBadge(rendering: Rendering): void {
  if (typeof document === 'undefined') return;
  if (!gpuBadge) {
    gpuBadge = document.createElement('div');
    gpuBadge.style.cssText =
      'position:fixed;bottom:8px;left:8px;z-index:99999;font:11px/1.45 ui-monospace,monospace;' +
      'color:#8ff;background:rgba(0,0,0,.6);padding:6px 8px;border-radius:4px;' +
      'pointer-events:none;white-space:pre';
    document.body.appendChild(gpuBadge);
  }
  gpuBadge.textContent = `gpu ${rendering.backend}`;

  const gpu = (
    navigator as Navigator & {
      gpu?: {
        requestAdapter?: () => Promise<{
          info?: { vendor?: string; architecture?: string; device?: string; description?: string };
        } | null>;
      };
    }
  ).gpu;
  gpu?.requestAdapter?.()
    .then((adapter) => {
      const el = gpuBadge;
      if (!el) return;
      const info = adapter?.info;
      const label = info ? info.description || info.device || info.vendor || '' : '';
      el.textContent = label ? `gpu ${rendering.backend} · ${label}` : `gpu ${rendering.backend}`;
    })
    .catch(() => undefined);
}

function mountPlanetOverlay(world: World): void {
  if (typeof document === 'undefined') return;
  if (!planetOverlay) {
    planetOverlay = document.createElement('div');
    planetOverlay.style.cssText =
      'position:fixed;bottom:8px;right:8px;z-index:99999;font:11px/1.45 ui-monospace,monospace;' +
      'color:#cfc;background:rgba(0,0,0,.6);padding:6px 8px;border-radius:4px;' +
      'pointer-events:none;white-space:pre';
    document.body.appendChild(planetOverlay);
  }
  planetOverlay.textContent = world.debugInfoLines().join('\n');
}
