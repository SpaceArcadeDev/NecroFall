/**
 * NECROFALL — swarm director (mobile plan §30–§34, §62–§65).
 *
 * Owns HOW OFTEN the horde thinks, and HOW BIG it is allowed to get. It does not move bodies:
 * placement, spawning and the brain stay in `Enemies.ts` — the director only answers the two
 * questions that scale with enemy count:
 *
 *  1. SIMULATION TIER — one distance test per enemy per frame (the Bestiary already computes it
 *     for the draw cull), folded into a hysteretic tier:
 *
 *       tier 0  ≤ 78 m   full rate (every frame — this is the fight the player is in)
 *       tier 1  ≤ 140 m  half rate (every 2nd frame)
 *       tier 2  ≤ 200 m  quarter rate (every 4th frame)
 *       tier 3  > 200 m  sixth rate (every 6th frame — still advancing, at 10 Hz on a 60 Hz device)
 *
 *     The steps are ID-STAGGERED by the caller (`frame % step === id % step`), so a tier's cost
 *     lands on 1/step of the frames, never in one burst (plan §62). Bands carry hysteresis, so a
 *     creature pacing a boundary cannot flicker between rates.
 *
 *     The bands KEEP the shipped 78 m / 140 m steps and add the far band beyond them (the match's
 *     own scale: aggro 110 m, spawn 45-70 m, despawn 260 m) — the plan's 20/45/80 m numbers
 *     target a much shorter aggro radius than this game shipped with, and halving the cadence a
 *     Necrophage is actually fought at would change the fight. Distant bodies still advance every
 *     update; they are never frozen, so nothing reads as a stalled horde.
 *
 *  2. POPULATION TARGET — the spawner's own curve, centralized here so one number answers "how
 *     many Necrophages may exist right now": the device/preset cap plus the match ramp plus the
 *     player count (plan §64). Spawning continues to live in the spawner; this is only the target
 *     it reads.
 */
import type { Enemy } from './Enemies';

/** Update cadence per tier (frame stride). Index = tier. */
export const SWARM_TIER_STEPS = [1, 2, 4, 6] as const;

/** Enter/exit bands (metres) per tier transition, tested on the squared nearest-player distance.
 *  Exit is always under enter — the hysteresis that stops boundary flicker. */
const TIER_BANDS = [
  { enter: 78, exit: 70 },
  { enter: 140, exit: 128 },
  { enter: 200, exit: 186 },
] as const;

export interface SwarmDirectorStats {
  /** The population the spawner is allowed to fill. */
  desired: number;
  /** Live bodies at the last `beginFrame`. */
  alive: number;
  /** Hard ceiling (preset + device). */
  cap: number;
  /** Live bodies per simulation tier. */
  tiers: readonly [number, number, number, number];
}

export class SwarmDirector {
  private readonly tierCounts = new Int32Array(4);
  private desired = 0;
  private alive = 0;
  private cap = 0;

  /** Reset the per-frame counters; call once at the top of the enemy update. */
  beginFrame(alive: number, cap: number): void {
    this.tierCounts.fill(0);
    this.alive = alive;
    this.cap = cap;
  }

  /**
   * The hysteretic tier for one enemy (state carried on the enemy itself, so the director keeps
   * no maps and allocates nothing). Returns the frame stride the caller must use.
   */
  stepFor(enemy: Enemy, distanceSq: number): number {
    const tier = nextSwarmTier(distanceSq, enemy.simTier);
    enemy.simTier = tier;
    this.tierCounts[tier]++;
    return SWARM_TIER_STEPS[tier];
  }

  /**
   * The spawner's target population (plan §64): the shipped curve
   * `14 + elapsed·0.17 + players·8`, clamped to the cap. A pure function of match state, so the
   * spawner can call it every tick without side effects.
   */
  desiredPopulation(playerCount: number, elapsed: number, cap: number): number {
    this.desired = Math.min(cap, Math.floor(14 + elapsed * 0.17 + playerCount * 8));
    return this.desired;
  }

  stats(): SwarmDirectorStats {
    return {
      desired: this.desired,
      alive: this.alive,
      cap: this.cap,
      tiers: [this.tierCounts[0], this.tierCounts[1], this.tierCounts[2], this.tierCounts[3]],
    };
  }
}

/** Hysteretic tier choice from the squared nearest-player distance (metres²). */
export function nextSwarmTier(distanceSq: number, current: number): 0 | 1 | 2 | 3 {
  const clamp = (t: number): 0 | 1 | 2 | 3 => (t < 0 ? 0 : t > 3 ? 3 : (t as 0 | 1 | 2 | 3));
  let tier = clamp(current);
  // Climb while beyond a band's ENTER distance (checked from the far end so a teleport can jump
  // straight to the right tier).
  for (let i = TIER_BANDS.length - 1; i >= 0; i--) {
    if (distanceSq >= TIER_BANDS[i].enter * TIER_BANDS[i].enter) {
      tier = clamp(i + 1);
      break;
    }
  }
  // Drop only once safely under the band's EXIT distance (hysteresis).
  while (tier > 0) {
    const band = TIER_BANDS[tier - 1];
    if (distanceSq < band.exit * band.exit) tier = clamp(tier - 1);
    else break;
  }
  return tier as 0 | 1 | 2 | 3;
}
