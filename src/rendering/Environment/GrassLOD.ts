/**
 * NECROFALL — grass sector LOD (mobile plan §6–§11, §72).
 *
 * The grass field keeps its EXACT planet-space placement: every blade's position, normal, size,
 * rotation and phase are baked once and never move (plan §7/§15). What changes with distance is
 * only the REPRESENTATION — how many of a sector's blades are drawn:
 *
 *   LOD0  full blade set              — the lawn around the player, pixel-for-pixel as before
 *   LOD1  every second blade (50 %)   — mid field; at 20 m+ a blade is 1-2 pixels tall
 *   LOD2  every fourth blade (25 %)   — far field; the terrain's baked grass shadow keeps the
 *                                       clump reading dense even where individual cards are gone
 *
 * Decimation is a DRAW RANGE on the sector geometry, not a rebuilt geometry: the blades inside a
 * sector were bucketed in acceptance order (uniform random directions), so a prefix of the buffer
 * is a spatially unbiased subset. A blade that survives keeps its transform — nothing slides,
 * nothing pops into a different place, and there is no per-blade distance test anywhere
 * (plan §8/§9: LOD by sector, ~32 distance checks a frame, not one per blade).
 *
 * Bands carry HYSTERESIS (plan §10): entering 28 m drops to LOD1, but the sector must come back
 * inside 24 m to be full again, so a sector straddling the threshold cannot oscillate.
 */

import { readSwitches } from '../DebugSwitches';

/** Fraction of a sector's blades kept at each LOD (index = LOD). */
export const GRASS_LOD_KEEP = [1, 0.5, 0.25] as const;

export type GrassLod = 0 | 1 | 2;

export interface GrassLodBand {
  /** Distance (m) at which the sector DROPS to the lower LOD. */
  enter: number;
  /** Distance (m) under which the sector climbs back to the higher LOD. */
  exit: number;
}

/**
 * Bands per folio quality level (0 highest … 2 lowest): a weaker device starts decimating
 * sooner, which is where its vertex-bound budget hurts most; the geometry and thresholds on the
 * highest level are untouched.
 */
export function grassLodBands(qualityLevel: number): readonly [GrassLodBand, GrassLodBand] {
  if (qualityLevel <= 0) {
    return [
      { enter: 28, exit: 24 },
      { enter: 62, exit: 52 },
    ];
  }
  if (qualityLevel === 1) {
    return [
      { enter: 22, exit: 18 },
      { enter: 50, exit: 42 },
    ];
  }
  return [
    { enter: 16, exit: 13 },
    { enter: 38, exit: 32 },
  ];
}

/** Hysteretic LOD choice for ONE sector (plan §10). `distance` = metres to the sector's bounds. */
export function chooseGrassLod(distance: number, current: GrassLod, bands: readonly [GrassLodBand, GrassLodBand]): GrassLod {
  if (current === 0) {
    if (distance >= bands[1].enter) return 2;
    if (distance >= bands[0].enter) return 1;
    return 0;
  }
  if (current === 1) {
    if (distance < bands[0].exit) return 0;
    if (distance >= bands[1].enter) return 2;
    return 1;
  }
  if (distance < bands[0].exit) return 0;
  if (distance < bands[1].exit) return 1;
  return 2;
}

/** Blade slots (3 vertices each) a sector may draw at this LOD. */
export function grassLodVertexCount(bladeCount: number, lod: GrassLod): number {
  const blades = Math.max(1, Math.floor(bladeCount * GRASS_LOD_KEEP[lod]));
  return blades * 3;
}

/** `?grasslod=0` pins every sector to LOD0 — the A/B switch for measuring the LOD's effect.
 *  Read once (the flag cannot change under a running page) — this is called per sector, per frame.
 *  Uses the shared switch bag so the flag works in the search AND in the hash query. */
let lodEnabledCache: boolean | null = null;

export function grassLodEnabled(): boolean {
  if (lodEnabledCache === null) {
    try {
      lodEnabledCache = readSwitches()['grasslod'] !== '0';
    } catch {
      lodEnabledCache = true;
    }
  }
  return lodEnabledCache;
}
