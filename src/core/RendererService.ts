// NECROFALL — renderer service (plan §1, §54, §55, §108): Three.js WebGPU first, WebGL2 fallback.
//
// The game's canonical renderer is `WebGPURenderer` (three/webgpu) — Folio 2025's renderer. On
// browsers/devices without WebGPU it runs the SAME renderer on the WebGL2 backend (`forceWebGL`),
// so gameplay never forks: only the backend behind the node pipeline changes.
//
// Everything in the game now imports from `three/webgpu` (via the Vite alias in vite.config.ts),
// which is also what makes the fallback meaningful: node/TSL materials render on both backends.
import * as THREE from 'three/webgpu';

export interface GameRendererHandle {
  renderer: THREE.WebGPURenderer;
  /** Which backend actually came up. Filled in when `ready` resolves. */
  backend: 'webgpu' | 'webgl';
  /** Resolves once the backend has initialised. */
  ready: Promise<void>;
}

export interface CreateRendererOptions {
  /** Antialiasing (tied to the quality preset in Game). */
  antialias: boolean;
}

/** True when the browser exposes a WebGPU adapter — the only thing worth probing synchronously. */
export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu;
}

export function createGameRenderer(options: CreateRendererOptions): GameRendererHandle {
  const forceWebGL = !webgpuAvailable();

  const renderer = new THREE.WebGPURenderer({
    antialias: options.antialias,
    alpha: false,
    forceWebGL,
    powerPreference: 'high-performance',
  });

  // The game's art direction was authored with no tone mapping; the TSL materials match the
  // previous GLSL look 1:1, so keep the pipeline neutral.
  renderer.toneMapping = THREE.NoToneMapping;

  const handle: GameRendererHandle = {
    renderer,
    backend: forceWebGL ? 'webgl' : 'webgpu',
    ready: Promise.resolve(),
  };

  handle.ready = renderer.init().then(
    () => {
      // Correct the claim if the WebGPU attempt fell back internally.
      const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
      handle.backend = backend?.isWebGPUBackend ? 'webgpu' : 'webgl';
      // eslint-disable-next-line no-console
      console.info(`[NECROFALL] renderer: ${handle.backend === 'webgpu' ? 'WebGPU' : 'WebGL2 (fallback)'}`);
    },
    (error) => {
      // A failed WebGPU init in three surfaces here; the game keeps running on WebGL2 by
      // recreating with forceWebGL upstream of this handle.
      console.warn('[NECROFALL] renderer init failed', error);
    },
  );

  return handle;
}
