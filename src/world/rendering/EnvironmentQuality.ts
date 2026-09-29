// NECROFALL — ENVIRONMENT QUALITY (rework plan §46/§47/§48/§74/§78).
//
// The plan's ULTRA/HIGH/MEDIUM/LOW ladder already exists in the game as graphics presets; this
// manager adds the ENVIRONMENT-specific half:
//
//   * capability detection (WebGL2 always today; WebGPU reported when the browser offers it —
//     plan §52 — plus texture-size introspection for future asset budgets, plan §41);
//   * a DYNAMIC quality step (0..3) mirrored from the game's watchdog: density and LOD distances
//     scale down when frame time degrades, and back up when it recovers (plan §47);
//   * the device-appropriate pixel-ratio ceiling the renderer should respect (plan §48).
//
// Nothing here lowers gameplay readability: enemies, players, Beacons and collision are NOT on
// this dial (plan §47).
import { ENV_PROFILES, type EnvironmentProfile } from '../EnvironmentConfig';
import { clamp } from '../../utils/Utils';

export interface RendererCapabilities {
  webgl2: boolean;
  webgpu: boolean;
  maxTextureSize: number;
  maxSamples: number;
}

/** Detects what the browser/renderer can do (plan §52/§78). Never throws. */
export function detectRendererCapabilities(renderer?: {
  capabilities?: { maxTextureSize?: number; maxSamples?: number };
  getContext?: () => WebGLRenderingContext | WebGL2RenderingContext | null;
}): RendererCapabilities {
  let webgl2 = false;
  try {
    const canvas = document.createElement('canvas');
    webgl2 = !!canvas.getContext('webgl2');
  } catch {
    webgl2 = false;
  }
  const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const caps = renderer?.capabilities;
  return {
    webgl2,
    webgpu,
    maxTextureSize: caps?.maxTextureSize ?? 4096,
    maxSamples: caps?.maxSamples ?? 0,
  };
}

/** Density/LOD scale per dynamic step (plan §47: step down density first, geometry last). */
const DENSITY_BY_STEP = [1, 0.82, 0.62, 0.45];
const LOD_BY_STEP = [1, 0.85, 0.72, 0.6];
const TIER_BY_STEP = [1, 0.88, 0.76, 0.62];

export class EnvironmentQualityManager {
  private step = 0;
  readonly capabilities: RendererCapabilities;

  constructor(
    public profile: EnvironmentProfile,
    rendererCapabilities?: RendererCapabilities
  ) {
    this.capabilities = rendererCapabilities ?? detectRendererCapabilities();
  }

  /** Swap the profile (graphics preset change — plan §75). Resets the dynamic step. */
  setProfile(profile: EnvironmentProfile): void {
    this.profile = profile;
    this.step = 0;
  }

  /** The watchdog's rescue level maps here (plan §47). */
  setStep(step: number): boolean {
    const next = clamp(Math.round(step), 0, DENSITY_BY_STEP.length - 1);
    if (next === this.step) return false;
    this.step = next;
    return true;
  }

  get currentStep(): number {
    return this.step;
  }

  /** Multiplier sampled at cell build time (new instances only — nothing is yanked). */
  densityScale(): number {
    return DENSITY_BY_STEP[this.step];
  }

  /** Multiplier on LOD switch distances (shrinks draw distance under load). */
  lodScale(): number {
    return LOD_BY_STEP[this.step];
  }

  /** Multiplier on grass tier distances. */
  tierScale(): number {
    return TIER_BY_STEP[this.step];
  }

  /** Pixel-ratio ceiling the renderer should never exceed for this device class (plan §48). */
  get pixelRatioCap(): number {
    return this.profile.pixelRatioCap;
  }

  /** One-line summary for the debug overlay (plan §65). */
  label(): string {
    return `${this.profile.name.toUpperCase()} step ${this.step} · d${this.densityScale()} l${this.lodScale()}`;
  }
}

/** Convenience: the profile for a named quality (re-export for callers that only have a name). */
export function profileFor(name: EnvironmentProfile['name']): EnvironmentProfile {
  return ENV_PROFILES[name];
}
