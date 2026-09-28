// NECROFALL — PROCEDURAL ANIMATOR (plan §20/§21). One solver, every creature: gait styles from
// the locomotion class, secondary motion (breathing, sac pulsing, tail sway, head bearing) on
// top, and NOTHING baked per species. Replaces the shipped walk-cycle block in `Enemy.place` —
// the caller keeps its LOD and visibility gates, so off-screen bodies still cost zero.
import type { CreatureRig } from '../EnemyModels';
import type { EnemyGenome } from '../EnemyGenomes';
import type { GaitProfile, LocomotionId } from './EnemyGenome';

const FALLBACK_GAITS: Record<LocomotionId, GaitProfile> = {
  WALKER: { style: 'WALKER', stride: 0.55, bob: 0.03, rate: 1, pairOffset: Math.PI, slither: 0, lean: 0, breathe: 0.05, sacPulse: 0, tailSway: 0.3, headTrack: 0.16, hover: 0 },
  CRAWLER: { style: 'CRAWLER', stride: 0.7, bob: 0.02, rate: 1.35, pairOffset: Math.PI, slither: 0, lean: 0.06, breathe: 0.04, sacPulse: 0, tailSway: 0.4, headTrack: 0.2, hover: 0 },
  LEAPER: { style: 'LEAPER', stride: 0.85, bob: 0.09, rate: 0.72, pairOffset: 0, slither: 0, lean: 0.1, breathe: 0.09, sacPulse: 1.4, tailSway: 0.2, headTrack: 0.24, hover: 0 },
  HOPPER: { style: 'HOPPER', stride: 0.9, bob: 0.13, rate: 1.5, pairOffset: 0, slither: 0, lean: 0.08, breathe: 0.07, sacPulse: 1.1, tailSway: 0.18, headTrack: 0.2, hover: 0 },
  BURROWER: { style: 'BURROWER', stride: 0.5, bob: 0.02, rate: 0.85, pairOffset: Math.PI, slither: 0.22, lean: 0.02, breathe: 0.05, sacPulse: 0, tailSway: 0.5, headTrack: 0.12, hover: 0 },
  SLITHER: { style: 'SLITHER', stride: 0, bob: 0.01, rate: 1.1, pairOffset: 0, slither: 0.5, lean: 0.03, breathe: 0.06, sacPulse: 0, tailSway: 0.6, headTrack: 0.14, hover: 0 },
  CHARGER: { style: 'CHARGER', stride: 0.62, bob: 0.045, rate: 1.15, pairOffset: Math.PI, slither: 0, lean: 0.16, breathe: 0.08, sacPulse: 0.9, tailSway: 0.24, headTrack: 0.3, hover: 0 },
  FLOATING: { style: 'FLOATING', stride: 0.2, bob: 0.1, rate: 0.55, pairOffset: Math.PI, slither: 0, lean: -0.05, breathe: 0.12, sacPulse: 0.7, tailSway: 0.35, headTrack: 0.2, hover: 0.45, wing: 0.3, tentacle: 0.3 },
  FLYER: { style: 'FLYER', stride: 0.3, bob: 0.07, rate: 1.3, pairOffset: Math.PI, slither: 0, lean: -0.03, breathe: 0.07, sacPulse: 0.4, tailSway: 0.34, headTrack: 0.3, hover: 0, wing: 0.55, tentacle: 0.2 },
  STALKING: { style: 'STALKING', stride: 0.4, bob: 0.02, rate: 0.7, pairOffset: Math.PI, slither: 0, lean: -0.04, breathe: 0.03, sacPulse: 0, tailSway: 0.22, headTrack: 0.4, hover: 0 },
  SWARM: { style: 'SWARM', stride: 0.75, bob: 0.05, rate: 1.6, pairOffset: Math.PI, slither: 0, lean: 0.05, breathe: 0.05, sacPulse: 0, tailSway: 0.35, headTrack: 0.18, hover: 0 },
};

/**
 * Play one frame of gait + secondary motion. `phase` is the enemy's own walk clock (advanced by
 * the sim), `moving` is 0..1 speed blend. Stateless apart from a breathing clock parked in
 * `rig.group.userData` — pooling reuses rigs, and a recycled body simply keeps breathing.
 */
export function animateEnemyRig(rig: CreatureRig, genome: EnemyGenome, phase: number, moving: number, dt: number): void {
  const gait = genome.gait ?? (genome.locomotion ? FALLBACK_GAITS[genome.locomotion] : FALLBACK_GAITS.WALKER);
  const prof = genome.behavior;
  const s = rig.scale;
  const breathT = ((rig.group.userData.breathT as number) ?? 0) + dt;
  rig.group.userData.breathT = breathT;

  // ---- legs: gait-styled swing + knee bend
  const swingAmt = (0.22 + moving * 0.5) * prof.animAmpMul * (0.75 + gait.stride * 0.4);
  const p0 = phase * prof.animSpeedMul * gait.rate;
  for (const leg of rig.legs) {
    // pairOffset PI = alternating walk; 0 = a bound (both sides together, rows staggered a little)
    const off = gait.pairOffset === Math.PI ? leg.phase : leg.phase * 0.28;
    const p = p0 + off;
    leg.root.rotation.x = Math.sin(p) * swingAmt;
    leg.knee.rotation.x = Math.max(0, -Math.sin(p + 0.7)) * (0.25 + moving * 0.55) * prof.animAmpMul;
  }

  // ---- segmented bodies: travelling wave, amplitude from the gait (slither)
  const waveAmp = (gait.slither > 0 ? gait.slither : 0.28) * (0.4 + moving);
  const waveRate = gait.style === 'SLITHER' ? 2.1 : 1.6;
  // Chain links (worm / myriapod) are MARCHED: each link is placed one step behind the previous
  // along a cumulative heading, so the body bends like a real chain — and because the links are
  // FLAT children of the body (see the rig comments in EnemyModels), nothing can compound. The
  // other rigs' secondary parts (chest/abdomen/bell/…) keep their own local sway.
  let chainAng = 0;
  let chainX = 0;
  let chainZ = 0;
  for (let i = 1; i < rig.segments.length; i++) {
    const seg = rig.segments[i];
    const wave = Math.sin(phase * waveRate - i * 0.7);
    if (seg.userData.chain === 1) {
      chainAng += wave * waveAmp;
      const step = seg.userData.step as number;
      chainX += Math.sin(chainAng) * step;
      chainZ -= Math.cos(chainAng) * step;
      seg.position.x = chainX;
      seg.position.z = chainZ;
      seg.rotation.y = chainAng;
    } else {
      seg.rotation.y = wave * waveAmp;
      seg.position.x = wave * s * 0.06;
    }
  }

  // ---- body: squash/breathe + gait bob/lean + hover
  const baseY = s * 0.62 + (gait.hover > 0 ? gait.hover * s * (0.8 + 0.2 * Math.sin(breathT * 1.3)) : 0);
  if (rig.jelly > 0.5) {
    const squash = 1 + Math.sin(phase * (1.4 + moving)) * (0.06 + moving * 0.12);
    rig.body.scale.set(rig.jellyBase.x / squash, rig.jellyBase.y * squash, rig.jellyBase.z / squash);
    rig.body.position.y = baseY + Math.sin(phase * 2) * s * 0.05;
  } else {
    const bobAmp = gait.bob * (0.35 + moving * 0.65) + gait.breathe * 0.04;
    rig.body.position.y = baseY + Math.sin(phase * (1.6 + gait.rate) + (gait.style === 'HOPPER' ? 0 : 1)) * s * bobAmp + Math.sin(breathT * 1.1) * s * gait.breathe * 0.012;
    // idle breathing: a slow scale pulse keeps a standing body alive (plan §21)
    const breathe = 1 + Math.sin(breathT * 1.1) * gait.breathe * 0.5;
    rig.body.scale.set(rig.jellyBase.x * breathe, rig.jellyBase.y * (2 - breathe), rig.jellyBase.z * breathe);
  }
  // forward lean reads the movement intent
  rig.body.rotation.x = gait.lean * moving;
  if (gait.style === 'FLOATING') rig.body.rotation.z = Math.sin(phase * 0.5) * 0.06;

  // ---- head + tail
  rig.head.rotation.y = Math.sin(phase * 0.6) * gait.headTrack;
  rig.head.rotation.x = Math.sin(phase * 1.1) * 0.08 - moving * 0.12;
  if (rig.tail) rig.tail.rotation.y = Math.sin(phase * 0.9) * gait.tailSway;

  // ---- WINGS (AVIAN / winged drifters): a beat that deepens with effort; a glide at rest
  if (rig.wings.length > 0) {
    const wingAmp = (gait.wing ?? 0.3) * (0.5 + moving * 0.75) * prof.animAmpMul;
    for (const wing of rig.wings) {
      const flap = Math.sin(phase * (1.5 + gait.rate) + wing.phase);
      wing.root.rotation.z = -wing.side * (0.34 + flap * wingAmp);
      wing.root.rotation.x = Math.sin(phase * 0.9 + wing.phase) * 0.09;
    }
  }

  // ---- NECK (avians): a stacked sway so the head leads the body instead of riding it
  for (let i = 0; i < rig.neck.length; i++) {
    const joint = rig.neck[i];
    joint.rotation.y = Math.sin(phase * 0.65 - i * 0.45) * (0.07 + i * 0.035) * prof.animAmpMul;
    joint.rotation.x = Math.sin(phase * 0.95 - i * 0.5) * 0.028;
  }

  // ---- TENTACLES (mollusk / wraith): a travelling writhe down each strand root
  if (rig.tentacles.length > 0) {
    const tAmp = (gait.tentacle ?? 0.22) * (0.55 + moving * 0.4) * prof.animAmpMul;
    for (let i = 0; i < rig.tentacles.length; i++) {
      const t = rig.tentacles[i];
      const o = i * 1.31;
      t.rotation.x = Math.sin(phase * 1.6 + o) * tAmp * 0.55;
      t.rotation.z = Math.cos(phase * 1.25 + o) * tAmp * 0.55;
    }
  }

  // ---- SHARD CROWN: the whole ring revolves; the body's own breath is what makes it rise
  if (rig.shardRing) {
    rig.shardRing.rotation.y = phase * 0.6 + breathT * 0.12;
    rig.shardRing.position.y = Math.sin(breathT * 1.3) * s * 0.05;
  }

  // ---- glow sacs (kept out of the static merge by `userData.dynamic`): pulse with exertion
  const sacRate = 2 + gait.sacPulse * 2.4;
  const sacAmp = 0.08 + gait.sacPulse * 0.1 + moving * 0.06;
  for (const child of rig.body.children) {
    if (child.userData.sacPulse !== 1) continue;
    const base = child.userData.baseScale as { x: number; y: number; z: number } | undefined;
    if (!base) continue;
    const k = 1 + Math.sin(breathT * sacRate) * sacAmp;
    child.scale.set(base.x * k, base.y * k, base.z * k);
  }
}
