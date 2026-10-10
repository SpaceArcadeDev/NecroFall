import * as THREE from 'three/webgpu';
import { CCDIKSolver } from 'three/addons/animation/CCDIKSolver.js';
import type { AnatomicalAttack, BaseGenome } from './EnemyAnatomy';

export type GroundSampler = (point: THREE.Vector3, up: THREE.Vector3, reach: number, out: THREE.Vector3) => boolean;

export interface RigMotion {
  up?: THREE.Vector3;
  ground?: GroundSampler;
  airborne?: boolean;
  attack?: AnatomicalAttack;
  attackPhase?: number;
}

interface FootContact {
  bone: THREE.Bone;
  target: THREE.Bone;
  home: THREE.Vector3;
  planted: THREE.Vector3;
  start: THREE.Vector3;
  goal: THREE.Vector3;
  wanted: THREE.Vector3;
  progress: number;
  initialized: boolean;
  clearance: number;
}

export class TerrainRig {
  readonly contacts: FootContact[] = [];
  readonly height: number;
  clock = 0;
  steps = 0;
  private readonly solver: CCDIKSolver;
  private readonly iks: Parameters<CCDIKSolver['updateOne']>[0][];
  private readonly rest = new Map<THREE.Bone, THREE.Quaternion>();
  private readonly tails: THREE.Bone[] = [];
  private readonly heads: THREE.Bone[] = [];
  private readonly arms: THREE.Bone[] = [];
  private readonly wings: THREE.Bone[] = [];
  private readonly previous = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly targetPoint = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3(1, 0, 0);
  private started = false;
  private sway = 0;
  private nextFoot = 0;

  constructor(private readonly root: THREE.Object3D, model: THREE.Object3D, base: BaseGenome, height: number) {
    this.height = height;
    root.updateWorldMatrix(true, true);
    let mesh = model.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
    model.traverse(object => { if (object instanceof THREE.SkinnedMesh && object.userData.primaryRig) mesh = object; });
    if (!mesh) throw new Error(`${base}: missing skinned surface`);
    const original = mesh.skeleton;
    const bones = [...original.bones];
    const inverses = original.boneInverses.map(inverse => inverse.clone());
    const find = (name: string) => {
      const bone = bones.find(candidate => candidate.name === THREE.PropertyBinding.sanitizeNodeName(name));
      if (!bone) throw new Error(`${base}: missing locomotion bone ${name}`);
      return bone;
    };
    const animatedBones: THREE.Bone[] = [];
    model.traverse(object => { if (object instanceof THREE.Bone) animatedBones.push(object); });
    for (const bone of animatedBones) {
      this.rest.set(bone, bone.quaternion.clone());
      if (/^Tail\d|^abdomen_|^stinger_/.test(bone.name)) this.tails.push(bone);
      if (/^Head$|^Head_/.test(bone.name)) this.heads.push(bone);
      if (base === 'behemoth' && /^LegF/.test(bone.name) || base === 'parasite' && /^Bicep/.test(bone.name)) this.arms.push(bone);
      if (/^wing[12][lr]/.test(bone.name)) this.wings.push(bone);
    }
    const chains = base === 'parasite'
      ? [['toebase.l_54', 'Foot.l_56', 'Shin.l_57', 'Thigh.l_58'], ['toebase.r_66', 'Foot.r_68', 'Shin.r_69', 'Thigh.r_70']]
      : (base === 'behemoth' ? ['BL', 'BR'] : ['FL', 'BR', 'FR', 'BL']).map(suffix => [`Foot${suffix}`, `Shin${suffix}`, `Leg${suffix}`]);
    const iks = chains.map((chain, index) => {
      const foot = find(chain[0]);
      const target = new THREE.Bone();
      target.name = `ContactTarget${index}`;
      mesh.add(target);
      bones.push(target);
      inverses.push(new THREE.Matrix4());
      const home = root.worldToLocal(foot.getWorldPosition(new THREE.Vector3()));
      this.contacts.push({ bone: foot, target, home, planted: new THREE.Vector3(), start: new THREE.Vector3(),
        goal: new THREE.Vector3(), wanted: new THREE.Vector3(), progress: 1, initialized: false,
        clearance: height * 0.018,
      });
      return { target: bones.length - 1, effector: bones.indexOf(foot), iteration: 12, maxAngle: 0.20,
        links: chain.slice(1).map((name, link) => {
          const joint = find(name);
          const limit = link === chain.length - 2 ? 0.7 : 1.25;
          return { index: bones.indexOf(joint),
            rotationMin: new THREE.Vector3(joint.rotation.x - limit, joint.rotation.y - 0.45, joint.rotation.z - limit),
            rotationMax: new THREE.Vector3(joint.rotation.x + limit, joint.rotation.y + 0.45, joint.rotation.z + limit),
          };
        }),
      };
    });
    const skeleton = new THREE.Skeleton(bones, inverses);
    model.traverse(object => {
      if (object instanceof THREE.SkinnedMesh && object.skeleton === original) object.skeleton = skeleton;
    });
    original.dispose();
    this.iks = iks;
    this.solver = new CCDIKSolver(mesh, iks);
  }

  update(dt: number, stunned: boolean, motion: RigMotion = {}): void {
    if (stunned || dt <= 0) return;
    dt = Math.min(dt, 0.05);
    this.clock += dt;
    this.root.updateWorldMatrix(true, true);
    this.root.getWorldPosition(this.point);
    if (!this.started) { this.previous.copy(this.point); this.started = true; }
    this.velocity.copy(this.point).sub(this.previous).divideScalar(dt);
    const teleported = this.point.distanceTo(this.previous) > this.height * 3;
    this.previous.copy(this.point);
    this.up.copy(motion.up ?? this.axis.set(0, 1, 0)).normalize();
    this.velocity.addScaledVector(this.up, -this.velocity.dot(this.up));
    const speed = Math.min(this.velocity.length(), this.height * 12);
    const stride = this.height * 0.24;
    const ground = motion.ground;
    let swinging = this.contacts.filter(foot => foot.progress < 1).length;
    const capacity = Math.max(1, Math.floor(this.contacts.length / 2));
    const firstFoot = this.nextFoot;
    for (let offset = 0; offset < this.contacts.length; offset++) {
      const index = (firstFoot + offset) % this.contacts.length;
      const foot = this.contacts[index];
      this.root.localToWorld(foot.wanted.copy(foot.home));
      foot.wanted.addScaledVector(this.velocity, Math.min(0.12, stride / Math.max(0.01, speed)));
      if (ground) {
        if (!ground(foot.wanted, this.up, this.height * 0.3, this.targetPoint)) {
          foot.initialized = false;
          foot.progress = 1;
          continue;
        }
        foot.wanted.copy(this.targetPoint).addScaledVector(this.up, foot.clearance);
      } else foot.wanted.addScaledVector(this.up, -foot.wanted.dot(this.up) + foot.clearance);
      if (!foot.initialized || teleported || motion.airborne) {
        foot.planted.copy(foot.wanted);
        foot.goal.copy(foot.wanted);
        foot.progress = 1;
        foot.initialized = true;
      }
      if (!motion.airborne && foot.progress >= 1 && swinging < capacity && foot.planted.distanceTo(foot.wanted) > stride * 0.65) {
        foot.start.copy(foot.planted);
        foot.goal.copy(foot.wanted);
        foot.progress = 0;
        swinging++;
        this.steps++;
        this.nextFoot = (index + 1) % this.contacts.length;
      }
      if (foot.progress < 1) {
        foot.progress = Math.min(1, foot.progress + dt / Math.max(0.12, Math.min(0.38, stride / Math.max(speed, 0.1))));
        const blend = foot.progress * foot.progress * (3 - 2 * foot.progress);
        foot.planted.lerpVectors(foot.start, foot.goal, blend);
        foot.planted.addScaledVector(this.up, Math.sin(foot.progress * Math.PI) * this.height * 0.13);
      }
      foot.target.position.copy(foot.planted);
      foot.target.parent!.worldToLocal(foot.target.position);
      foot.target.updateMatrixWorld(true);
    }
    for (const [bone, rest] of this.rest) bone.quaternion.copy(rest);
    const phase = motion.attackPhase ?? 0;
    const strike = phase > 0 ? Math.sin(Math.min(1, phase) * Math.PI) : 0;
    this.sway += (Math.min(1, speed / Math.max(0.1, this.height * 3)) - this.sway) * Math.min(1, dt * 5);
    this.axis.set(1, 0, 0);
    for (const head of this.heads) head.quaternion.multiply(this.turn.setFromAxisAngle(this.axis,
      Math.sin(this.clock * 1.5) * 0.015 + (motion.attack === 'bite' || motion.attack === 'spit' ? -strike * 0.32 : 0)));
    for (const arm of this.arms) arm.quaternion.multiply(this.turn.setFromAxisAngle(this.axis,
      (motion.attack === 'claw' || motion.attack === 'stomp' ? -strike * 0.75 : this.sway * 0.08)));
    this.axis.set(0, 1, 0);
    this.tails.forEach((tail, index) => tail.quaternion.multiply(this.turn.setFromAxisAngle(this.axis,
      Math.sin(this.clock * 1.6 - index * 0.5) * (0.02 + this.sway * 0.04) + (motion.attack === 'tail' ? strike * 0.22 : 0))));
    this.axis.set(0, 0, 1);
    this.wings.forEach((wing, index) => wing.quaternion.multiply(this.turn.setFromAxisAngle(this.axis,
      (index % 2 ? -1 : 1) * Math.sin(this.clock * (motion.airborne ? 13 : 2)) * (motion.airborne ? 0.42 : 0.025))));
    this.root.updateWorldMatrix(true, true);
    if (!motion.airborne) this.contacts.forEach((foot, index) => { if (foot.initialized) this.solver.updateOne(this.iks[index]); });
  }

  diagnostics() {
    this.root.updateWorldMatrix(true, true);
    return { steps: this.steps, clock: this.clock, feet: this.contacts.map(foot => ({
      planted: foot.progress >= 1, contact: foot.planted.toArray(),
      actual: foot.bone.getWorldPosition(new THREE.Vector3()).toArray(),
      error: foot.bone.getWorldPosition(this.point).distanceTo(foot.planted),
    })) };
  }
}