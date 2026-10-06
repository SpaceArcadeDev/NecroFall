/**
 * NECROFALL — async pipeline precompilation (r186 plan §15).
 *
 * The first frame a material is rendered, the backend compiles its pipeline. Done mid-fight that
 * reads as a stutter — worst of all on WebGPU, where a compute or a heavy TSL graph can cost
 * hundreds of milliseconds. r186 exposes the async facilities to move that cost into the loading
 * screen:
 *
 *     renderer.compileAsync(scene, camera)        — all scene materials
 *     renderer.compileComputeAsync(node)          — compute pipelines
 *
 * Two rules keep this SAFE (r186 shipped with `compileAsync` pipeline/binding reports, so the
 * plan's own instruction is explicit: never let precompilation be a hard dependency):
 *
 *   1. every call is wrapped in a timeout AND a try/catch — a pipeline that fails, or that the
 *      backend never answers for, is simply left to lazy compilation (exactly the pre-r186
 *      behaviour). Loading must never block on one optional pipeline;
 *   2. compute compilation only runs on a real WebGPU backend — the WebGL fallback has no compute
 *      path and asking it to compile compute nodes would only produce a rejected promise.
 *
 * `?precompile=0` disables the pass entirely (the A/B switch for measuring the shader stutter it
 * removes); `?precompileTimeout=<ms>` overrides the per-step budget.
 */
import type * as THREE from 'three/webgpu';
import { readSwitches } from './DebugSwitches';

interface PrecompileRenderer {
  compileAsync?: (
    scene: THREE.Object3D,
    camera: THREE.Camera,
    targetScene?: THREE.Scene | null,
  ) => Promise<unknown>;
  compileComputeAsync?: (nodes: unknown, onProgress?: unknown) => Promise<unknown>;
  backend?: { isWebGPUBackend?: boolean };
}

export interface PrecompileOptions {
  renderer: unknown;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /**
   * Object subtrees that are NOT in the main scene (hidden pre-builds, VFX pools). Each is
   * compiled against the main scene so its lighting/environment bindings match.
   */
  extraObjects?: THREE.Object3D[];
  /** Compute nodes (GPU particle sim, future grass compute) — WebGPU only. */
  computeNodes?: unknown[];
  /** Per-step budget in ms. A step that overruns is abandoned and reported as `timeout`. */
  timeoutMs?: number;
  /** Progress labels for the loading screen. */
  onStep?: (label: string, ratio: number) => void;
}

export interface PrecompileReport {
  compiled: string[];
  failed: string[];
  skipped: string[];
  ms: number;
}

const DEFAULT_TIMEOUT_MS = 4000;

/** Reads the URL switches ONCE per step set (the flags cannot change under a running page). */
export function precompileEnabled(): boolean {
  try {
    return readSwitches()['precompile'] !== '0';
  } catch {
    return true;
  }
}

function timeoutMsFromSwitches(): number {
  try {
    const raw = readSwitches()['precompileTimeout'];
    if (raw === undefined) return DEFAULT_TIMEOUT_MS;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
  } catch {
    return DEFAULT_TIMEOUT_MS;
  }
}

/** Resolves `promise` unless `timeout` fires first; a rejection/timeout never propagates. */
async function guarded(label: string, promise: Promise<unknown>, timeout: number, report: PrecompileReport): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      promise.then(
        () => 'ok' as const,
        () => 'failed' as const,
      ),
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeout);
      }),
    ]);
    if (result === 'ok') report.compiled.push(label);
    else report.failed.push(`${label}:${result}`);
  } catch {
    // Promise.race with a settled handler cannot throw, but a hostile polyfill must not escape.
    report.failed.push(`${label}:failed`);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Compile the current scene's pipelines behind the loading screen. NEVER throws and NEVER
 * rejects: a failure returns a report and the game boots on lazy compilation exactly as before.
 */
export async function precompilePipelines(options: PrecompileOptions): Promise<PrecompileReport> {
  const started = performance.now();
  const report: PrecompileReport = { compiled: [], failed: [], skipped: [], ms: 0 };
  const renderer = options.renderer as PrecompileRenderer | null;
  if (!renderer?.compileAsync) {
    report.skipped.push('compileAsync:unsupported');
    report.ms = performance.now() - started;
    return report;
  }
  const timeout = options.timeoutMs ?? timeoutMsFromSwitches();
  const { scene, camera } = options;

  let step = 0;
  const steps = (options.extraObjects?.length ?? 0) + 1 + (options.computeNodes?.length ? 1 : 0);
  const advance = (label: string): void => {
    step++;
    options.onStep?.(label, steps > 0 ? step / steps : 1);
  };

  for (let i = 0; i < (options.extraObjects?.length ?? 0); i++) {
    const object = options.extraObjects![i];
    advance(`compiling ${object.name || `subtree ${i}`}`);
    await guarded(`object:${object.name || i}`, renderer.compileAsync(object, camera, scene), timeout, report);
  }

  advance('compiling world pipelines');
  try {
    await guarded('scene', renderer.compileAsync(scene, camera, null), timeout, report);
  } catch {
    report.failed.push('scene:threw');
  }

  if (options.computeNodes?.length) {
    const webgpu = renderer.backend?.isWebGPUBackend === true;
    if (webgpu && renderer.compileComputeAsync) {
      advance('compiling compute');
      await guarded('compute', renderer.compileComputeAsync(options.computeNodes), timeout, report);
    } else {
      report.skipped.push('compute:no-webgpu');
    }
  }

  report.ms = performance.now() - started;
  return report;
}
