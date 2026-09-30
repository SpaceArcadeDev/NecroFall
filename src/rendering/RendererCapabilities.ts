// NECROFALL — renderer capabilities (plan §2, §3): the ONE place that probes what the device can
// run. WebGPU when the browser exposes an adapter; otherwise the SAME node pipeline runs on the
// WebGL2 backend (`forceWebGL`), so gameplay never forks — only the backend behind the TSL
// materials changes.
//
// Nothing else in the game may re-probe the GPU. `Rendering` consumes this at construction.
export interface RendererCapabilities {
  /** True when `navigator.gpu` exposes an adapter — the only worth-probing synchronous check. */
  readonly webgpu: boolean;
  /** When no WebGPU adapter exists the renderer must be created with `forceWebGL: true`. */
  readonly forceWebGL: boolean;
}

export function detectRendererCapabilities(): RendererCapabilities {
  const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu;
  return { webgpu, forceWebGL: !webgpu };
}

/**
 * After `renderer.init()` the runtime knows which backend actually came up (a WebGPU attempt can
 * fall back internally). This reads it without leaking three's private types into the game.
 */
export function resolveActiveBackend(renderer: { backend?: { isWebGPUBackend?: boolean } }): 'webgpu' | 'webgl' {
  return renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl';
}
