// NECROFALL — VegetationLOD (plan §39, §88, §90): the single table of draw distances and update
// rates for every environmental system, scaled by the quality tier AND the watchdog's rescue
// level. Systems read their budget from here; nothing hard-codes a distance.
import type { QualitySettings } from '../../../core/Config';

export type LodCategory = 'grass' | 'flowers' | 'bushes' | 'scenery' | 'trees' | 'water' | 'particles';

export interface LodBudget {
  /** Metres: instances beyond this are culled (shader or CPU). Infinity = always drawn. */
  maxDistance: number;
  /** Whole-system visibility toggle (for CPU-side systems like water). */
  enabled: boolean;
  /** 0..1 density multiplier this step can carry. */
  density: number;
}

/** Base draw distances at HIGH quality (plan §88 — tune with profiling, these are the anchors). */
const BASE: Record<LodCategory, number> = {
  grass: 62,
  flowers: 72,
  bushes: 115,
  scenery: 85,
  trees: 240,
  water: 260,
  particles: 60,
};

/** Quality multipliers (LOW..ULTRA from Config's qualities). */
const QUALITY_SCALE: Record<string, number> = {
  low: 0.55,
  medium: 0.78,
  high: 1,
  ultra: 1.25,
};

export function lodFor(category: LodCategory, quality: QualitySettings, rescueLevel = 0): LodBudget {
  const scale = QUALITY_SCALE[quality.name] ?? 1;
  // Rescue trims distances first, then density (plan §94/§95: environment before gameplay).
  const rescueDistance = rescueLevel <= 3 ? 0.82 : rescueLevel <= 5 ? 0.62 : 0.45;
  const rescueDensity = rescueLevel === 0 ? 1 : rescueLevel <= 2 ? 0.8 : rescueLevel <= 4 ? 0.55 : 0.35;

  const enabled =
    rescueLevel < 7 &&
    !(category === 'water' && rescueLevel >= 6) &&
    !(category === 'particles' && rescueLevel >= 1);

  return {
    maxDistance: BASE[category] * scale * rescueDistance,
    enabled,
    density: rescueDensity,
  };
}

/** Update-rate guidance (plan §90) — systems should read these instead of ticking everything at 60. */
export const UPDATE_RATES = {
  grassShader: 60,
  wind: 60,
  waterAnimation: 60,
  vegetationVisibility: 30,
  sceneryVisibility: 20,
  distantLod: 10,
} as const;
