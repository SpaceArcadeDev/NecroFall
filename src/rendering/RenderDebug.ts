/**
 * NECROFALL — render debug harness (plan §1/§10/§33/§45).
 *
 * ONE place that reads the diagnostic URL switches so BOTH the production game
 * and the Dev World expose the identical toolset:
 *
 *   ?render=normal|unlit|normals|lighting|shadow|biome|slope|height|fog
 *   ?materialDebug=<same modes>          (alias of ?render=<mode>)
 *   ?render=fogoff|shadowsOff|grassOff|treesOff|postOff   (component toggles; alias of the
 *                                        existing ?fog=0 / ?shadows=0 / …)
 *   ?renderBaseline=1                    print the frozen Dev World baseline (§1)
 *   ?foliageDebug=1                      live foliage + terrain-query overlay (§33)
 *   ?post=0                              skip bloom + DOF (raw scene pass, §25)
 *
 * The material debug MODE is intentionally read ONCE at startup and baked into
 * each material at construction: it costs nothing per frame, and it keeps the
 * diagnostic honest (the material shows the real pipeline, not a patched one).
 *
 * Diagnostic semantics (§10/§44):
 *   unlit    looks correct  -> lighting/shadow problem
 *   unlit    wrong          -> terrain/material/geometry problem
 *   normals  wrong          -> terrain normal problem
 *   biome/height wrong      -> procedural mask / terrain generation problem
 */
import { readSwitches, type SwitchBag } from './DebugSwitches';

export type MaterialDebugMode =
  | 'normal'
  | 'unlit'
  | 'normals'
  | 'lighting'
  | 'shadow'
  | 'dot'
  | 'core'
  | 'dir'
  | 'terrain'
  | 'biome'
  | 'slope'
  | 'height'
  | 'fog';

const MATERIAL_MODES: readonly MaterialDebugMode[] = [
  'normal',
  'unlit',
  'normals',
  'lighting',
  'shadow',
  'dot',
  'core',
  'dir',
  'terrain',
  'biome',
  'slope',
  'height',
  'fog',
];

/** Component toggles expressed in the plan's `?render=` vocabulary. */
const COMPONENT_SWITCHES: Record<string, string> = {
  fogoff: 'fog',
  shadowsoff: 'shadows',
  grassoff: 'grass',
  treesoff: 'foliage',
  postoff: 'post',
};

function readMaterialMode(bag: SwitchBag): MaterialDebugMode {
  const raw = (bag['materialDebug'] ?? bag['render'] ?? 'normal').toLowerCase();
  return (MATERIAL_MODES as readonly string[]).includes(raw) ? (raw as MaterialDebugMode) : 'normal';
}

class RenderDebugState {
  /** Baked into every MeshDefaultMaterial at construction. */
  readonly materialMode: MaterialDebugMode;
  /** ?renderBaseline=1 — print the frozen baseline to the console + overlay. */
  readonly baseline: boolean;
  /** ?foliageDebug=1 — live foliage/terrain-query counters. */
  readonly foliageDebug: boolean;
  /** ?post=0 / ?render=postOff — skip bloom + DOF (raw scene render, §25). */
  readonly postEnabled: boolean;
  /** `?fog=0` / `?render=fogoff` — the ONE fog off switch (§24). */
  readonly fogEnabled: boolean;
  /** `?shadows=0` / `?render=shadowsOff` — sun shadow casting off. */
  readonly shadowsEnabled: boolean;
  /** `?grass=0` / `?render=grassOff`. */
  readonly grassEnabled: boolean;
  /** `?foliage=0` / `?render=treesOff`. */
  readonly foliageEnabled: boolean;
  readonly bag: SwitchBag;

  constructor() {
    const bag = readSwitches();
    // Normalise the plan's `?render=` component toggles into the classic switch names so the
    // existing systems keep reading ONE vocabulary.
    const render = (bag['render'] ?? '').toLowerCase();
    const mapped = COMPONENT_SWITCHES[render];
    if (mapped && bag[mapped] === undefined) bag[mapped] = '0';
    this.bag = bag;

    this.materialMode = readMaterialMode(bag);
    this.baseline = bag['renderBaseline'] !== undefined && bag['renderBaseline'] !== '0';
    this.foliageDebug = bag['foliageDebug'] !== undefined && bag['foliageDebug'] !== '0';
    this.postEnabled = !(bag['post'] === '0' || bag['post'] === 'off');
    this.fogEnabled = !(bag['fog'] === '0' || bag['fog'] === 'off');
    this.shadowsEnabled = !(bag['shadows'] === '0' || bag['shadows'] === 'off');
    this.grassEnabled = !(bag['grass'] === '0' || bag['grass'] === 'off');
    this.foliageEnabled = !(bag['foliage'] === '0' || bag['foliage'] === 'off');
  }
}

export const RenderDebug = new RenderDebugState();

/**
 * Print the frozen Dev World baseline (§1). Called once both environments are
 * built so the SAME dump can be diffed between the Dev World and a live match —
 * `?renderBaseline=1` is the manual half of the golden test (§31).
 */
export interface RenderBaselineInput {
  world: string;
  renderer: {
    version?: string;
    backend: string;
    pixelRatio: number;
    toneMapping: number;
    size: { x: number; y: number };
  };
  quality: string;
  camera: { fov: number; near: number; far: number };
  planet: { radius: number; seed: number; ring: number };
  lighting: { sunDirection: number[]; sunIntensity: number; shadowMapSize: number; shadowAmplitude: number };
  fog: { near: number; far: number; color: string };
  foliage: Record<string, string | number>;
}

export function printRenderBaseline(input: RenderBaselineInput, overlay?: { set(line: string, value: string): void }): void {
  const lines: Record<string, string> = {
    'world': input.world,
    'three': input.renderer.version ?? '?',
    'backend': input.renderer.backend,
    'pixelRatio': input.renderer.pixelRatio.toFixed(2),
    'toneMapping': String(input.renderer.toneMapping),
    'resolution': `${input.renderer.size.x}×${input.renderer.size.y}`,
    'quality': input.quality,
    'camera': `fov ${input.camera.fov} near ${input.camera.near} far ${input.camera.far}`,
    'planet': `radius ${input.planet.radius} seed ${input.planet.seed} ring ${input.planet.ring}`,
    'sun': `${input.lighting.sunIntensity.toFixed(2)} @ [${input.lighting.sunDirection.map((n) => n.toFixed(3)).join(', ')}]`,
    'shadow': `map ${input.lighting.shadowMapSize} amp ${input.lighting.shadowAmplitude}`,
    'fog': `near ${input.fog.near} far ${input.fog.far} color ${input.fog.color}`,
  };
  for (const [key, value] of Object.entries(input.foliage)) lines[`foliage.${key}`] = String(value);

  if (typeof console !== 'undefined') {
    // eslint-disable-next-line no-console
    console.log('[NECROFALL] RENDER BASELINE\n' + Object.entries(lines).map(([k, v]) => `  ${k.padEnd(16)} ${v}`).join('\n'));
  }
  if (overlay) {
    for (const [key, value] of Object.entries(lines)) overlay.set(`bl.${key}`, value);
  }
}
