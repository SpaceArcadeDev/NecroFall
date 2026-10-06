/**
 * NECROFALL — renderer capability probe (r186 plan §0.2 / §4).
 *
 * ONE place that answers "what can this GPU actually do" before any GPU-heavy system is built
 * (grass TSL material, GPU particles, compute, texture budgets). WebGPU is the target and WebGL2
 * stays a first-class fallback — the probe reports BOTH what the browser exposes and which
 * backend the live renderer actually came up on, so a device that silently rides the WebGL
 * compatibility path can never be mistaken for a WebGPU one.
 *
 * The synchronous part is cheap and safe to call at boot (a throwaway canvas probe, no adapter
 * request). The GPU description (`navigator.gpu.requestAdapter` + `adapter.info`) is a SEPARATE
 * async enrichment step: it may be slow or rejected, and a rejection must never delay the first
 * frame — callers log it when it arrives instead of awaiting it on the boot path.
 */
import type * as THREE from 'three/webgpu';
import { DeviceTier, type DeviceTierName } from '../performance/DeviceTier';

export type RendererBackend = 'webgpu' | 'webgl' | 'none';

export interface RendererCapabilities {
  /** `navigator.gpu` exists — WebGPU is AVAILABLE in this browser, not necessarily in use. */
  webgpu: boolean;
  /** A WebGL2 context can be created (the fallback path's precondition). */
  webgl2: boolean;
  /** Which backend the live renderer came up on (`none` before `init()` resolves). */
  backend: RendererBackend;
  /** The live renderer is a WebGPURenderer instance (true even on its WebGL fallback). */
  webgpuRenderer: boolean;
  mobile: boolean;
  touch: boolean;
  /** Approximate GPU tier from the device ladder (cores / memory / DPR / viewport). */
  gpuTier: DeviceTierName;
  maxTextureSize: number;
  /** MSAA sample ceiling (WebGL `MAX_SAMPLES`, WebGPU `maxSampleCount`; 1 = no MSAA). */
  maxSamples: number;
  /** Max compute invocations per workgroup (0 = no compute path). */
  maxComputeInvocations: number;
  /** A compute path exists (WebGPU backend only — the WebGL fallback has none). */
  compute: boolean;
  devicePixelRatio: number;
  /** Adapter/GPU description when the browser exposes one (`""` until enriched). */
  gpu: string;
}

interface RendererProbe {
  backend?: RendererBackend;
  webgpuRenderer?: boolean;
  getContext?: () => WebGL2RenderingContext | WebGLRenderingContext | null;
  backendDevice?: unknown;
}

/** Conservative defaults: a device that hides its limits must not be treated as unlimited. */
const DEFAULTS = {
  maxTextureSize: 4096,
  maxSamples: 4,
  maxComputeInvocations: 0,
};

function readWebGL2Support(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

function readGlLimits(context: WebGLRenderingContext | null): { maxTextureSize: number; maxSamples: number } {
  if (!context) return { maxTextureSize: DEFAULTS.maxTextureSize, maxSamples: DEFAULTS.maxSamples };
  try {
    const maxTextureSize = context.getParameter(context.MAX_TEXTURE_SIZE) as number;
    // MAX_SAMPLES is WebGL2-only; the guard keeps the probe total for a WebGL1 context.
    const maxSamples =
      typeof (context as WebGL2RenderingContext).MAX_SAMPLES === 'number'
        ? (context.getParameter((context as WebGL2RenderingContext).MAX_SAMPLES) as number)
        : DEFAULTS.maxSamples;
    return {
      maxTextureSize: Number.isFinite(maxTextureSize) ? maxTextureSize : DEFAULTS.maxTextureSize,
      maxSamples: Number.isFinite(maxSamples) ? maxSamples : DEFAULTS.maxSamples,
    };
  } catch {
    return { maxTextureSize: DEFAULTS.maxTextureSize, maxSamples: DEFAULTS.maxSamples };
  }
}

function readWebGpuLimits(device: unknown): { maxTextureSize: number; maxSamples: number; maxComputeInvocations: number } {
  const limits = (device as { limits?: Record<string, number> } | null)?.limits;
  if (!limits) return { ...DEFAULTS, maxComputeInvocations: 256 };
  const pick = (key: string, fallback: number): number => {
    const value = limits[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  return {
    maxTextureSize: pick('maxTextureDimension2D', DEFAULTS.maxTextureSize),
    maxSamples: pick('maxSampleCount', DEFAULTS.maxSamples),
    maxComputeInvocations: pick('maxComputeInvocationsPerWorkgroup', 256),
  };
}

function backendOf(renderer: RendererProbe | null): RendererBackend {
  if (!renderer) return 'none';
  try {
    const backend = (renderer as { backend?: { isWebGPUBackend?: boolean; isWebGLBackend?: boolean } }).backend;
    if (backend?.isWebGPUBackend) return 'webgpu';
    if (backend?.isWebGLBackend) return 'webgl';
  } catch {
    /* fall through to the structural heuristic */
  }
  if (renderer.backend) return renderer.backend;
  return renderer.getContext ? 'webgl' : 'none';
}

function backendDeviceOf(renderer: RendererProbe | null): unknown {
  try {
    const backend = (renderer as { backend?: { device?: unknown } } | null)?.backend;
    return backend?.device ?? null;
  } catch {
    return null;
  }
}

/**
 * Synchronous probe. Pass the live renderer once it exists to learn the ACTUAL backend and
 * (on WebGL) the context limits; the WebGPU device limits are read from the backend when the
 * renderer exposed one.
 */
export function detectRendererCapabilities(renderer?: unknown): RendererCapabilities {
  const probe = (renderer ?? null) as RendererProbe | null;
  const backend = backendOf(probe);
  const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const context = (() => {
    try {
      return probe?.getContext?.() ?? null;
    } catch {
      return null;
    }
  })();
  const gl = readGlLimits(context);
  const gpuLimits = backend === 'webgpu' ? readWebGpuLimits(backendDeviceOf(probe)) : null;
  return {
    webgpu,
    webgl2: readWebGL2Support(),
    backend,
    webgpuRenderer: probe?.webgpuRenderer === true || backend === 'webgpu',
    mobile: DeviceTier.isMobile,
    touch: DeviceTier.isTouch,
    gpuTier: DeviceTier.name,
    maxTextureSize: gpuLimits?.maxTextureSize ?? gl.maxTextureSize,
    maxSamples: gpuLimits?.maxSamples ?? gl.maxSamples,
    maxComputeInvocations: gpuLimits?.maxComputeInvocations ?? 0,
    compute: backend === 'webgpu',
    devicePixelRatio: DeviceTier.info.dpr,
    gpu: '',
  };
}

/**
 * Best-effort adapter description (vendor / architecture). Never throws, never blocks anything:
 * a browser without `requestAdapter` (or a user/media block) resolves to the same object and the
 * caller keeps the sync probe's numbers.
 */
export async function enrichRendererCapabilities(capabilities: RendererCapabilities): Promise<RendererCapabilities> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
  if (!gpu?.requestAdapter) return capabilities;
  try {
    const adapter = await gpu.requestAdapter();
    const info = (adapter as { info?: { vendor?: string; architecture?: string; device?: string; description?: string } } | null)?.info;
    if (!info) return capabilities;
    const description = [info.vendor, info.architecture, info.device || info.description]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ');
    if (description) capabilities.gpu = description;
  } catch {
    /* no adapter info — the sync probe already answered everything the systems need */
  }
  return capabilities;
}

/** One-line boot log (r186 plan §4/§51): every capability decision is readable back. */
export function describeRendererCapabilities(capabilities: RendererCapabilities): string {
  const c = capabilities;
  return [
    `backend=${c.backend}`,
    `webgpuApi=${c.webgpu ? 'yes' : 'no'}`,
    `webgl2=${c.webgl2 ? 'yes' : 'no'}`,
    `compute=${c.compute ? 'yes' : 'no'}`,
    `maxTex=${c.maxTextureSize}`,
    `samples=${c.maxSamples}`,
    `dpr=${c.devicePixelRatio}`,
    `tier=${c.gpuTier}`,
    `mobile=${c.mobile}`,
    c.gpu ? `gpu="${c.gpu}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Convenience for systems that only need the backend fact (grass TSL, particle backend…). */
export function hasWebGPU(renderer?: THREE.Renderer): boolean {
  return detectRendererCapabilities(renderer).backend === 'webgpu';
}
