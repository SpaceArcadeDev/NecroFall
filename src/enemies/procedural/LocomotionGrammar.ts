// NECROFALL — LOCOMOTION GRAMMAR (plan §19/§20). A movement VOCABULARY: each class gets its own
// procedural gait (what the animator plays) plus motion multipliers the simulation composes with
// the behaviour profile. Higher rings unlock the exotic classes (plan §29: complexity, not HP).
import type { Rand } from '../../utils/Utils';
import type { GaitProfile, LocomotionId } from './EnemyGenome';
import type { LimbPlan } from './LimbGrammar';

const BASE_GAITS: Record<LocomotionId, GaitProfile> = {
  WALKER: { style: 'WALKER', stride: 0.55, bob: 0.03, rate: 1, pairOffset: Math.PI, slither: 0, lean: 0, breathe: 0.05, sacPulse: 0, tailSway: 0.3, headTrack: 0.16, hover: 0 },
  CRAWLER: { style: 'CRAWLER', stride: 0.7, bob: 0.02, rate: 1.35, pairOffset: Math.PI, slither: 0, lean: 0.06, breathe: 0.04, sacPulse: 0, tailSway: 0.4, headTrack: 0.2, hover: 0 },
  LEAPER: { style: 'LEAPER', stride: 0.85, bob: 0.09, rate: 0.72, pairOffset: 0, slither: 0, lean: 0.1, breathe: 0.09, sacPulse: 1.4, tailSway: 0.2, headTrack: 0.24, hover: 0 },
  HOPPER: { style: 'HOPPER', stride: 0.9, bob: 0.13, rate: 1.5, pairOffset: 0, slither: 0, lean: 0.08, breathe: 0.07, sacPulse: 1.1, tailSway: 0.18, headTrack: 0.2, hover: 0 },
  BURROWER: { style: 'BURROWER', stride: 0.5, bob: 0.02, rate: 0.85, pairOffset: Math.PI, slither: 0.22, lean: 0.02, breathe: 0.05, sacPulse: 0, tailSway: 0.5, headTrack: 0.12, hover: 0 },
  SLITHER: { style: 'SLITHER', stride: 0, bob: 0.01, rate: 1.1, pairOffset: 0, slither: 0.5, lean: 0.03, breathe: 0.06, sacPulse: 0, tailSway: 0.6, headTrack: 0.14, hover: 0 },
  CHARGER: { style: 'CHARGER', stride: 0.62, bob: 0.045, rate: 1.15, pairOffset: Math.PI, slither: 0, lean: 0.16, breathe: 0.08, sacPulse: 0.9, tailSway: 0.24, headTrack: 0.3, hover: 0 },
  FLOATING: { style: 'FLOATING', stride: 0.2, bob: 0.1, rate: 0.55, pairOffset: Math.PI, slither: 0, lean: -0.05, breathe: 0.12, sacPulse: 0.7, tailSway: 0.35, headTrack: 0.2, hover: 0.45, wing: 0.3, tentacle: 0.3 },
  // A FLYER holds its altitude in the SIM (airH), so the gait keeps no visual hover — the whole
  // rig is already up there. The wing flap and the slow bank are what sell the flight.
  FLYER: { style: 'FLYER', stride: 0.3, bob: 0.07, rate: 1.3, pairOffset: Math.PI, slither: 0, lean: -0.03, breathe: 0.07, sacPulse: 0.4, tailSway: 0.34, headTrack: 0.3, hover: 0, wing: 0.55, tentacle: 0.2 },
  STALKING: { style: 'STALKING', stride: 0.4, bob: 0.02, rate: 0.7, pairOffset: Math.PI, slither: 0, lean: -0.04, breathe: 0.03, sacPulse: 0, tailSway: 0.22, headTrack: 0.4, hover: 0 },
  SWARM: { style: 'SWARM', stride: 0.75, bob: 0.05, rate: 1.6, pairOffset: Math.PI, slither: 0, lean: 0.05, breathe: 0.05, sacPulse: 0, tailSway: 0.35, headTrack: 0.18, hover: 0 },
};

/** Which classes a role may roll at a given ring (plan §29 locomotion unlock table). */
export function locomotionPool(ring: number, isBoss: boolean): LocomotionId[] {
  // FLYER is part of the BASE set: wings are a silhouette, not a power tier — the deep-ring
  // unlocks stay reserved for the genuinely exotic classes below.
  const pool: LocomotionId[] = ['WALKER', 'CRAWLER', 'FLYER'];
  if (ring >= 0) pool.push('CHARGER');
  if (ring >= 1) pool.push('SWARM', 'STALKING');
  if (ring >= 2) pool.push('LEAPER', 'HOPPER');
  if (ring >= 3) pool.push('SLITHER');
  if (ring >= 4) pool.push('BURROWER', 'FLOATING');
  if (isBoss) {
    // bosses never skim — a boss that floats or flies reads as evasive; keep them grounded but exotic
    return pool.filter((p) => p !== 'FLOATING' && p !== 'SWARM' && p !== 'FLYER');
  }
  return pool;
}

export interface MotionPlan {
  locomotion: LocomotionId;
  /** Composed on top of the behaviour multiplier. */
  speedMul: number;
  gait: GaitProfile;
}

/** Body + limbs feedback into the gait (long legs = longer stride), per plan §18. */
export function gaitFor(locomotion: LocomotionId, limbs: LimbPlan): GaitProfile {
  const base = BASE_GAITS[locomotion];
  const legScale = limbs.legPairs > 0 ? Math.min(1.35, 0.7 + limbs.legLength * 0.35) : 1;
  return {
    ...base,
    stride: base.stride * (0.85 + legScale * 0.2),
    bob: base.bob * (0.8 + base.rate * 0.3),
    slither: base.slither * (limbs.tailSegments > 3 ? 1.25 : 1),
  };
}

/** Movement multipliers per class (plan §19: crawler = fast acceleration, stalking = slow…). */
export function locomotionSpeedMul(locomotion: LocomotionId): number {
  switch (locomotion) {
    case 'CRAWLER': return 1.24;
    case 'SWARM': return 1.18;
    case 'HOPPER': return 1.05;
    case 'CHARGER': return 1.1;
    case 'LEAPER': return 1.12;
    case 'WALKER': return 1;
    case 'SLITHER': return 1.02;
    case 'BURROWER': return 0.92;
    case 'STALKING': return 0.82;
    case 'FLOATING': return 0.9;
    case 'FLYER': return 1.14;
  }
}

export function rollLocomotion(rng: Rand, ring: number, isBoss: boolean, force?: LocomotionId): MotionPlan {
  const locomotion = force ?? rng.pick(locomotionPool(ring, isBoss));
  return { locomotion, speedMul: locomotionSpeedMul(locomotion), gait: BASE_GAITS[locomotion] };
}
