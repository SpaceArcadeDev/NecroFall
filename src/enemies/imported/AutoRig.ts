// NECROFALL — auto-rig for imported enemy base models.
//
// The crawler base model is a Tripo-generated STATIC mesh: one surface, no skeleton, no clips.
// Leaving it a statue would betray "an enemy base model", so the engine derives a rig from the
// geometry itself, once per model (cached by `ImportedVisual`), and drives it procedurally like
// every other Necrophage body in the game:
//
//   • bones are laid out in the model's normalized space (see prepare-crawler-base-model.mjs:
//     faces +Z, 1.0 unit tall, feet on y = 0, centered) — a quadruped spine, neck/head, the
//     four legs and the curling tail;
//   • skin weights come from ANATOMICAL ENVELOPES: each bone owns the vertices within a
//     radius of its segment, with height/side gates so a leg can never drag the belly along;
//   • bones keep the model's axis-aligned rest orientation, so `rotation.x` is always
//     "pitch / swing", `rotation.y` yaw and `rotation.z` roll — the gait solver in
//     `ImportedVisual` authors motion in those plain terms, exactly like `animateEnemyRig`.
import * as THREE from 'three/webgpu';

/** One joint of the derived skeleton, in the model's normalized space. */
export interface AutoRigJoint {
  name: string;
  parent: string | null;
  position: readonly [number, number, number];
}

/**
 * One skin envelope: vertices inside `inner` of the joint→tip segment belong to this joint
 * alone, weight fades to zero at `radius`. `ceiling` refuses vertices above that height
 * (a leg must never claim the torso hanging over it) and `side` restricts the bone to one
 * half of the body (left/right legs must not steal each other's geometry).
 */
export interface AutoRigEnvelope {
  joint: string;
  tip: readonly [number, number, number];
  radius: number;
  inner?: number;
  ceiling?: number;
  side?: -1 | 1;
  /** Overrides the joint's own position as the envelope's origin (used by leaf bones). */
  pivot?: readonly [number, number, number];
}

export interface AutoRigSpec {
  joints: readonly AutoRigJoint[];
  envelopes: readonly AutoRigEnvelope[];
}

/** Four influences per vertex — the standard skin budget, and enough for these rigs. */
const MAX_INFLUENCES = 4;

/** Width of the smooth band around an envelope's ceiling/side gate (metres, model space). */
const GATE_FADE = 0.1;

/** GLSL-style smoothstep on plain numbers (gates and falloffs run on the CPU). */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const _point = new THREE.Vector3();
const _scratch = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _closest = new THREE.Vector3();

/** Distance from a point to a finite segment (three has no public helper). */
function distanceToSegment(point: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3): number {
  _from.copy(to).sub(from);
  const lengthSq = _from.lengthSq();
  if (lengthSq < 1e-10) return point.distanceTo(from);
  // `_scratch` — NOT `point`: the caller's vector stays untouched (it is reused per envelope).
  const t = Math.max(0, Math.min(1, _scratch.copy(point).sub(from).dot(_from) / lengthSq));
  _closest.copy(from).addScaledVector(_from, t);
  return point.distanceTo(_closest);
}

/**
 * Builds the rest skeleton and bakes `skinIndex`/`skinWeight` onto the geometry. The template's
 * geometry is shared by every cloned instance, so this runs once per model per session.
 */
export function autoRig(geometry: THREE.BufferGeometry, spec: AutoRigSpec): THREE.Skeleton {
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  const joints = new Map<string, THREE.Bone>();
  const bones: THREE.Bone[] = [];
  const jointIndex = new Map<string, number>();
  for (const joint of spec.joints) {
    const bone = new THREE.Bone();
    bone.name = joint.name;
    // The table is authored in MODEL space (readable against the mesh analysis); bones carry
    // parent-relative offsets, so the parent's own position is subtracted here.
    const parent = joint.parent ? spec.joints.find((candidate) => candidate.name === joint.parent)! : null;
    bone.position.set(
      joint.position[0] - (parent?.position[0] ?? 0),
      joint.position[1] - (parent?.position[1] ?? 0),
      joint.position[2] - (parent?.position[2] ?? 0),
    );
    const parentBone = parent ? joints.get(parent.name) : null;
    if (parentBone) parentBone.add(bone);
    jointIndex.set(joint.name, bones.length);
    joints.set(joint.name, bone);
    bones.push(bone);
  }
  joints.get(spec.joints[0].name)!.updateMatrixWorld(true);

  const segments = spec.envelopes.map((envelope) => {
    const pivot = envelope.pivot ?? spec.joints.find((joint) => joint.name === envelope.joint)!.position;
    return {
      index: jointIndex.get(envelope.joint)!,
      from: new THREE.Vector3(pivot[0], pivot[1], pivot[2]),
      to: new THREE.Vector3(envelope.tip[0], envelope.tip[1], envelope.tip[2]),
      inner: envelope.inner ?? envelope.radius * 0.5,
      radius: envelope.radius,
      ceiling: envelope.ceiling ?? Infinity,
      side: envelope.side ?? 0,
    };
  });

  const index = new Uint16Array(positions.count * MAX_INFLUENCES);
  const weight = new Float32Array(positions.count * MAX_INFLUENCES);
  const scores: { slot: number; score: number }[] = [];
  for (let vertex = 0; vertex < positions.count; vertex++) {
    _point.fromBufferAttribute(positions, vertex);
    let best = 0;
    let bestDistance = Infinity;
    let picked = 0;
    for (let slot = 0; slot < segments.length; slot++) {
      const segment = segments[slot];
      // Smooth gates: a hard ceiling/side cut leaves a seam that tears triangles open the moment
      // the limb swings, so both fade over a short band and blend into the torso's own weights.
      let gate = 1;
      if (_point.y > segment.ceiling - GATE_FADE) {
        gate *= smoothstep(segment.ceiling + GATE_FADE, segment.ceiling - GATE_FADE, _point.y);
      }
      if (segment.side !== 0) gate *= Math.max(0, Math.min(1, 0.5 + _point.x * segment.side / (GATE_FADE * 0.5)));
      if (gate <= 0) continue;
      const distance = distanceToSegment(_point, segment.from, segment.to);
      if (distance < bestDistance) { bestDistance = distance; best = slot; }
      if (distance >= segment.radius) continue;
      // Smoothstep falloff: full ownership inside `inner`, nothing past `radius`.
      const t = Math.max(0, Math.min(1, (segment.radius - distance) / Math.max(1e-5, segment.radius - segment.inner)));
      if (!scores[picked]) scores[picked] = { slot, score: 0 };
      scores[picked].slot = slot;
      scores[picked].score = t * t * (3 - 2 * t) * gate;
      picked++;
    }
    if (picked === 0) {
      // Outside every envelope (horn tips, spikes, the folded wing membranes): blend the two
      // NEAREST joints by inverse square distance instead of a hard 100% assignment, so the
      // uncovered shell still deforms smoothly with whatever it sits on.
      let second = best;
      let secondDistance = Infinity;
      for (let slot = 0; slot < segments.length; slot++) {
        if (slot === best) continue;
        const distance = distanceToSegment(_point, segments[slot].from, segments[slot].to);
        if (distance < secondDistance) { secondDistance = distance; second = slot; }
      }
      const first = 1 / Math.max(1e-4, bestDistance * bestDistance);
      const other = 1 / Math.max(1e-4, secondDistance * secondDistance);
      index[vertex * MAX_INFLUENCES] = segments[best].index;
      index[vertex * MAX_INFLUENCES + 1] = segments[second].index;
      weight[vertex * MAX_INFLUENCES] = first / (first + other);
      weight[vertex * MAX_INFLUENCES + 1] = other / (first + other);
      continue;
    }
    const ranking = scores.slice(0, picked).sort((first, second) => second.score - first.score);
    const used = Math.min(MAX_INFLUENCES, ranking.length);
    let total = 0;
    for (let slot = 0; slot < used; slot++) total += ranking[slot].score;
    for (let slot = 0; slot < used; slot++) {
      index[vertex * MAX_INFLUENCES + slot] = segments[ranking[slot].slot].index;
      weight[vertex * MAX_INFLUENCES + slot] = ranking[slot].score / total;
    }
  }
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(index, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weight, 4));
  return new THREE.Skeleton(bones);
}

/**
 * THE CRAWLER RIG — joint positions read off the prepared model's geometry (the silhouette
 * analysis behind `prepare-crawler-base-model.mjs` follows the same table): hips and chest along
 * the spine, the neck dropping towards the lowered head, the tail curling up, back and under
 * itself in a J-hook, and four legs — one of which the source pose already holds lifted and
 * reaching forward. Envelope radii are tuned so joints blend across the knees and neck while the
 * torso stays torso, and every envelope spans a SEGMENT of its limb (a point envelope chops a
 * curved tail into rigid pieces the moment its bones move).
 */
export const CRAWLER_RIG: AutoRigSpec = {
  joints: [
    { name: 'Root', parent: null, position: [0, 0.661, -0.264] },
    { name: 'Spine', parent: 'Root', position: [0, 0.628, -0.033] },
    { name: 'Chest', parent: 'Spine', position: [0, 0.595, 0.231] },
    { name: 'Neck', parent: 'Chest', position: [0, 0.529, 0.430] },
    { name: 'Head', parent: 'Neck', position: [0, 0.446, 0.595] },
    { name: 'Jaw', parent: 'Head', position: [0, 0.331, 0.777] },
    // The tail: up and back off the hips, over the top of the curl, then back down and FORWARD
    // under itself (the J-hook the source pose holds).
    { name: 'Tail1', parent: 'Root', position: [0, 0.780, -0.470] },
    { name: 'Tail2', parent: 'Tail1', position: [0, 0.820, -0.560] },
    { name: 'Tail3', parent: 'Tail2', position: [0, 0.790, -0.660] },
    { name: 'Tail4', parent: 'Tail3', position: [0, 0.620, -0.790] },
    { name: 'Tail5', parent: 'Tail4', position: [0, 0.500, -0.740] },
    { name: 'Tail6', parent: 'Tail5', position: [0, 0.380, -0.600] },
    { name: 'LegFL', parent: 'Chest', position: [-0.215, 0.496, 0.215] },
    { name: 'ShinFL', parent: 'LegFL', position: [-0.215, 0.264, 0.380] },
    { name: 'FootFL', parent: 'ShinFL', position: [-0.198, 0.017, 0.496] },
    { name: 'LegFR', parent: 'Chest', position: [0.215, 0.496, 0.215] },
    { name: 'ShinFR', parent: 'LegFR', position: [0.215, 0.264, 0.380] },
    { name: 'FootFR', parent: 'ShinFR', position: [0.198, 0.017, 0.496] },
    { name: 'LegBR', parent: 'Root', position: [0.149, 0.529, -0.264] },
    { name: 'ShinBR', parent: 'LegBR', position: [0.165, 0.264, -0.380] },
    { name: 'FootBR', parent: 'ShinBR', position: [0.182, 0.017, -0.446] },
    // The source pose already holds the left rear leg lifted and reaching forward under the
    // belly; its joints follow the pose, so the gait continues the stride the model shows.
    { name: 'LegBL', parent: 'Root', position: [-0.149, 0.529, -0.264] },
    { name: 'ShinBL', parent: 'LegBL', position: [-0.198, 0.347, -0.083] },
    { name: 'FootBL', parent: 'ShinBL', position: [-0.231, 0.198, 0.099] },
  ],
  envelopes: [
    // Torso: three overlapping segments along the spine barrel.
    { joint: 'Root', tip: [0, 0.628, -0.033], radius: 0.38, ceiling: 0.95 },
    { joint: 'Spine', tip: [0, 0.595, 0.231], radius: 0.38 },
    { joint: 'Chest', tip: [0, 0.529, 0.430], radius: 0.36 },
    { joint: 'Neck', tip: [0, 0.446, 0.595], radius: 0.2 },
    { joint: 'Head', tip: [0, 0.331, 0.777], radius: 0.21 },
    { joint: 'Jaw', tip: [0, 0.27, 0.86], radius: 0.15, pivot: [0, 0.36, 0.72] },
    // Tail: one thin envelope per link, following the hook.
    { joint: 'Tail1', tip: [0, 0.820, -0.560], radius: 0.11 },
    { joint: 'Tail2', tip: [0, 0.790, -0.660], radius: 0.11 },
    { joint: 'Tail3', tip: [0, 0.620, -0.790], radius: 0.11 },
    { joint: 'Tail4', tip: [0, 0.500, -0.740], radius: 0.1 },
    { joint: 'Tail5', tip: [0, 0.380, -0.600], radius: 0.1 },
    { joint: 'Tail6', tip: [0, 0.330, -0.520], radius: 0.09 },
    // Legs: hip → foot, gated below the hip line and to their own side.
    { joint: 'LegFL', tip: [-0.215, 0.264, 0.380], radius: 0.16, ceiling: 0.52, side: -1 },
    { joint: 'ShinFL', tip: [-0.198, 0.017, 0.496], radius: 0.14, ceiling: 0.29, side: -1 },
    { joint: 'FootFL', tip: [-0.198, 0.017, 0.57], radius: 0.12, ceiling: 0.09, side: -1 },
    { joint: 'LegFR', tip: [0.215, 0.264, 0.380], radius: 0.16, ceiling: 0.52, side: 1 },
    { joint: 'ShinFR', tip: [0.198, 0.017, 0.496], radius: 0.14, ceiling: 0.29, side: 1 },
    { joint: 'FootFR', tip: [0.198, 0.017, 0.57], radius: 0.12, ceiling: 0.09, side: 1 },
    { joint: 'LegBR', tip: [0.165, 0.264, -0.380], radius: 0.16, ceiling: 0.52, side: 1 },
    { joint: 'ShinBR', tip: [0.182, 0.017, -0.446], radius: 0.13, ceiling: 0.29, side: 1 },
    { joint: 'FootBR', tip: [0.182, 0.017, -0.37], radius: 0.11, ceiling: 0.09, side: 1 },
    { joint: 'LegBL', tip: [-0.198, 0.347, -0.083], radius: 0.15, ceiling: 0.55, side: -1 },
    { joint: 'ShinBL', tip: [-0.231, 0.198, 0.099], radius: 0.13, ceiling: 0.37, side: -1 },
    { joint: 'FootBL', tip: [-0.231, 0.198, 0.17], radius: 0.11, ceiling: 0.25, side: -1 },
  ],
};

export const BEHEMOTH_RIG: AutoRigSpec = {
  joints: [
    { name: 'Root', parent: null, position: [0, 0.50, -0.12] },
    { name: 'Spine', parent: 'Root', position: [0, 0.62, -0.04] },
    { name: 'Chest', parent: 'Spine', position: [0, 0.73, 0.10] },
    { name: 'Neck', parent: 'Chest', position: [0, 0.70, 0.28] },
    { name: 'Head', parent: 'Neck', position: [0, 0.62, 0.42] },
    { name: 'Jaw', parent: 'Head', position: [0, 0.52, 0.49] },
    { name: 'Tail1', parent: 'Chest', position: [0, 0.80, -0.16] },
    { name: 'Tail2', parent: 'Tail1', position: [0, 0.84, -0.32] },
    { name: 'Tail3', parent: 'Tail2', position: [0, 0.90, -0.50] },
    { name: 'Tail4', parent: 'Tail3', position: [0, 0.89, -0.66] },
    { name: 'Tail5', parent: 'Tail4', position: [0, 0.82, -0.80] },
    { name: 'Tail6', parent: 'Tail5', position: [0, 0.72, -0.94] },
    { name: 'LegFL', parent: 'Chest', position: [-0.37, 0.64, 0.10] },
    { name: 'ShinFL', parent: 'LegFL', position: [-0.49, 0.37, 0.32] },
    { name: 'FootFL', parent: 'ShinFL', position: [-0.47, 0.20, 0.73] },
    { name: 'LegFR', parent: 'Chest', position: [0.37, 0.64, 0.10] },
    { name: 'ShinFR', parent: 'LegFR', position: [0.49, 0.37, 0.32] },
    { name: 'FootFR', parent: 'ShinFR', position: [0.47, 0.20, 0.73] },
    { name: 'LegBL', parent: 'Root', position: [-0.27, 0.49, -0.14] },
    { name: 'ShinBL', parent: 'LegBL', position: [-0.35, 0.24, -0.22] },
    { name: 'FootBL', parent: 'ShinBL', position: [-0.36, 0.03, -0.10] },
    { name: 'LegBR', parent: 'Root', position: [0.27, 0.49, -0.14] },
    { name: 'ShinBR', parent: 'LegBR', position: [0.35, 0.24, -0.22] },
    { name: 'FootBR', parent: 'ShinBR', position: [0.36, 0.03, -0.10] },
  ],
  envelopes: [],
};

BEHEMOTH_RIG.envelopes = BEHEMOTH_RIG.joints.map(joint => {
  const child = BEHEMOTH_RIG.joints.find(candidate => candidate.parent === joint.name);
  const limb = /Leg|Shin|Foot/.test(joint.name);
  const tail = joint.name.startsWith('Tail');
  return {
    joint: joint.name,
    tip: child?.position ?? joint.position,
    radius: tail ? 0.12 : limb ? 0.20 : joint.name === 'Head' || joint.name === 'Jaw' ? 0.22 : 0.32,
    ceiling: limb ? joint.position[1] + 0.04 : undefined,
    side: limb ? joint.position[0] < 0 ? -1 : 1 : undefined,
  };
});
