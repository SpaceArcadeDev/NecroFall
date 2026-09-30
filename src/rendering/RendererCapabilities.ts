/**
 * NECROFALL — renderer capability probe (plan §4).
 *
 * WebGPU is the target; when it is unavailable the same WebGPURenderer code
 * path runs on its WebGL2 fallback backend, so the world never silently
 * disappears.
 */
export interface RendererCapabilities {
  webgpu: boolean;
  canvas: boolean;
}

export function detectRendererCapabilities(): RendererCapabilities {
  return {
    webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    canvas: typeof document !== 'undefined',
  };
}
