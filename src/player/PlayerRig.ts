import * as THREE from 'three';
import { CCDIKSolver } from 'three/addons/animation/CCDIKSolver.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const restPose: Record<string, [number, number, number]> = {
  Hips: [0, 0.72, 0], Spine: [0, 0.9, 0], Chest: [0, 1.08, 0], Neck: [0, 1.47, 0], Head: [0, 1.68, 0],
  UpperArm_L: [-0.45, 1.35, 0], Forearm_L: [-0.45, 1.07, 0], Hand_L: [-0.45, 0.83, 0],
  UpperArm_R: [0.45, 1.35, 0], Forearm_R: [0.45, 1.07, 0], Hand_R: [0.45, 0.83, 0],
  Thigh_L: [-0.19, 0.72, 0], Shin_L: [-0.19, 0.36, 0], Foot_L: [-0.19, 0.08, 0],
  Thigh_R: [0.19, 0.72, 0], Shin_R: [0.19, 0.36, 0], Foot_R: [0.19, 0.08, 0],
  FootTarget_L: [-0.19, 0.08, 0], FootTarget_R: [0.19, 0.08, 0],
};

export interface PlayerMotion {
  speed: number;
  verticalSpeed: number;
  grounded: boolean;
  strafe?: number;
  forward?: number;
  frozen?: boolean;
}

export class PlayerRig {
  readonly root = new THREE.Group();
  readonly hips = this.joint('Hips', this.root);
  readonly spine = this.joint('Spine', this.hips);
  readonly chest = this.joint('Chest', this.spine);
  readonly neck = this.joint('Neck', this.chest);
  readonly head = this.joint('Head', this.neck);
  readonly armL = this.joint('UpperArm_L', this.chest);
  readonly elbowL = this.joint('Forearm_L', this.armL);
  readonly handL = this.joint('Hand_L', this.elbowL);
  readonly armR = this.joint('UpperArm_R', this.chest);
  readonly elbowR = this.joint('Forearm_R', this.armR);
  readonly handR = this.joint('Hand_R', this.elbowR);
  readonly legL = this.joint('Thigh_L', this.hips);
  readonly kneeL = this.joint('Shin_L', this.legL);
  readonly footL = this.joint('Foot_L', this.kneeL);
  readonly legR = this.joint('Thigh_R', this.hips);
  readonly kneeR = this.joint('Shin_R', this.legR);
  readonly footR = this.joint('Foot_R', this.kneeR);
  readonly headMount = new THREE.Group();
  readonly backMount = new THREE.Group();
  readonly weaponMount = new THREE.Group();
  readonly pack: THREE.Mesh;
  readonly mesh: THREE.SkinnedMesh;
  readonly skeleton: THREE.Skeleton;
  readonly accent: THREE.MeshLambertMaterial;
  state: 'idle' | 'run' | 'jump' | 'fall' = 'idle';
  private readonly targetL = this.joint('FootTarget_L', this.root);
  private readonly targetR = this.joint('FootTarget_R', this.root);
  private readonly hipsHeight = this.hips.position.y;
  private readonly chestHeight = this.chest.position.y;
  private readonly ankleHeight = this.targetR.position.y;
  private readonly ankleWidth = this.targetR.position.x;
  private readonly solver: CCDIKSolver;
  private clock = 0;
  private phase = 0;
  private run = 0;
  private air = 0;
  private panic = 0;
  private landing = 0;
  private wasGrounded = true;
  private verticalSpeed = 0;

  constructor(color: number) {
    this.root.name = 'PlayerRig';
    this.root.userData.avatarRevision = 'classic-rounded-rig-v1';
    this.accent = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.45, flatShading: true });
    const materials = [
      new THREE.MeshLambertMaterial({ color: 0x2a1f42 }),
      new THREE.MeshLambertMaterial({ color: 0x171126 }),
      this.accent,
    ];
    this.root.updateMatrixWorld(true);
    const bones = Object.keys(restPose).map(name => this.root.getObjectByName(name) as THREE.Bone);
    this.skeleton = new THREE.Skeleton(bones);
    const surfaces: THREE.BufferGeometry[] = [], materialIndices: number[] = [];
    const part = (source: THREE.BufferGeometry, position: [number, number, number], material: number, joints: THREE.Bone[]) => {
      const geometry = source.index ? source : mergeVertices(source);
      if (geometry !== source) source.dispose();
      geometry.translate(...position);
      const count = geometry.attributes.position.count;
      const indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
      for (let vertex = 0; vertex < count; vertex++) {
        const height = geometry.attributes.position.getY(vertex);
        const upper = joints.length === 1 ? 1 : THREE.MathUtils.smoothstep(height, restPose[joints[1].name][1] - 0.08, restPose[joints[1].name][1] + 0.08);
        const lower = joints.length < 3 ? 1 : THREE.MathUtils.smoothstep(height, restPose[joints[2].name][1], restPose[joints[2].name][1] + 0.12);
        const shares = [upper, (1 - upper) * lower, (1 - upper) * (1 - lower)];
        joints.forEach((joint, influence) => {
          indices[vertex * 4 + influence] = bones.indexOf(joint);
          weights[vertex * 4 + influence] = shares[influence];
        });
      }
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
      surfaces.push(geometry); materialIndices.push(material);
    };
    part(new THREE.BoxGeometry(0.66, 0.72, 0.42), [0, 1.08, 0], 0, [this.chest]);
    part(new RoundedBoxGeometry(0.44, 0.42, 0.44, 5, 0.17), [0, 1.68, 0], 0, [this.head]);
    for (const [thigh, shin, foot, side] of [[this.legL, this.kneeL, this.footL, -1], [this.legR, this.kneeR, this.footR, 1]] as const) {
      part(new THREE.CapsuleGeometry(0.13, 0.46, 8, 16, 12).scale(1, 1, 0.28 / 0.26), [side * 0.19, 0.36, 0], 1, [thigh, shin, foot]);
    }
    for (const [arm, elbow, hand, side] of [[this.armL, this.elbowL, this.handL, -1], [this.armR, this.elbowR, this.handR, 1]] as const) {
      part(new THREE.CapsuleGeometry(0.09, 0.44, 8, 16, 12).scale(1, 1, 0.2 / 0.18), [side * 0.45, 1.07, 0], 1, [arm, elbow, hand]);
    }
    part(new THREE.BoxGeometry(0.5, 0.3, 0.1), [0, 1.16, 0.22], 2, [this.chest]);
    part(new THREE.BoxGeometry(0.36, 0.14, 0.08), [0, 1.7, 0.22], 2, [this.head]);
    part(new THREE.BoxGeometry(0.22, 0.22, 0.3), [-0.45, 1.35, 0], 2, [this.armL]);
    part(new THREE.BoxGeometry(0.22, 0.22, 0.3), [0.45, 1.35, 0], 2, [this.armR]);
    const geometry = mergeGeometries(surfaces, true)!;
    geometry.groups.forEach((group, index) => { group.materialIndex = materialIndices[index]; });
    for (const surface of surfaces) surface.dispose();
    this.mesh = new THREE.SkinnedMesh(geometry, materials);
    this.mesh.name = 'ClassicPlayerBody';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.root.add(this.mesh);
    this.mesh.bind(this.skeleton);
    this.headMount.name = 'headMount';
    this.backMount.name = 'backMount';
    this.weaponMount.name = 'weaponMount';
    this.head.add(this.headMount);
    this.backMount.position.set(0, 0.07, -0.28);
    this.chest.add(this.backMount);
    this.weaponMount.position.set(0, 0, 0.22);
    this.handR.add(this.weaponMount);
    this.pack = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.44, 0.2), materials[1]);
    this.pack.name = 'DefaultPack';
    this.backMount.add(this.pack);
    this.solver = new CCDIKSolver(this.mesh, [
      [this.targetL, this.footL, this.kneeL, this.legL],
      [this.targetR, this.footR, this.kneeR, this.legR],
    ].map(([target, foot, knee, thigh]) => ({
      target: bones.indexOf(target), effector: bones.indexOf(foot), iteration: 8, maxAngle: 0.35,
      links: [
        { index: bones.indexOf(knee), rotationMin: new THREE.Vector3(0.02, 0, 0), rotationMax: new THREE.Vector3(2.5, 0, 0) },
        { index: bones.indexOf(thigh), rotationMin: new THREE.Vector3(-1.6, -0.3, -0.35), rotationMax: new THREE.Vector3(1.2, 0.3, 0.35) },
      ],
    })));
  }

  private joint(name: string, parent: THREE.Object3D): THREE.Bone {
    const bone = new THREE.Bone();
    bone.name = name;
    const origin = restPose[parent.name] ?? [0, 0, 0];
    bone.position.fromArray(restPose[name]).sub(new THREE.Vector3().fromArray(origin));
    parent.add(bone);
    return bone;
  }

  update(dt: number, motion: PlayerMotion): void {
    if (motion.frozen || dt <= 0) return;
    dt = Math.min(dt, 0.05);
    this.clock += dt;
    const speed = Math.min(18, Math.max(0, motion.speed));
    const blend = 1 - Math.exp(-dt * 12);
    this.run = THREE.MathUtils.lerp(this.run, motion.grounded ? Math.min(1, speed / 6) : 0, blend);
    this.air = THREE.MathUtils.lerp(this.air, motion.grounded ? 0 : 1, blend);
    this.panic = THREE.MathUtils.lerp(this.panic, !motion.grounded && motion.verticalSpeed < -1 ? 1 : 0, blend);
    if (motion.grounded && !this.wasGrounded) this.landing = Math.min(0.11, Math.abs(this.verticalSpeed) * 0.006);
    this.landing *= Math.exp(-dt * 12);
    this.wasGrounded = motion.grounded;
    this.verticalSpeed = motion.verticalSpeed;
    this.state = motion.grounded ? speed > 0.6 ? 'run' : 'idle' : motion.verticalSpeed > 0.5 ? 'jump' : 'fall';
    this.phase += dt * (speed > 0.2 ? 7 + speed * 0.9 : 0);
    const stride = Math.sin(this.phase);
    const breathe = Math.sin(this.clock * 2.3);
    const frantic = Math.sin(this.clock * 20);
    const forward = motion.forward ?? 1;
    const strafe = motion.strafe ?? 0;
    this.hips.position.y = this.hipsHeight - 0.03 + Math.abs(stride) * 0.035 * this.run - this.landing;
    this.hips.rotation.set(0, stride * 0.065 * this.run, -strafe * 0.07 * this.run);
    this.spine.rotation.set(0.12 * this.run * forward - 0.13 * this.air, stride * -0.1 * this.run, Math.sin(this.clock * 1.1) * 0.014);
    this.chest.position.y = this.chestHeight + breathe * 0.004;
    this.chest.rotation.set(breathe * 0.012, stride * -0.08 * this.run, 0);
    this.head.rotation.set(-0.07 * this.run + 0.12 * this.panic, Math.sin(this.clock * 0.7) * 0.065 * (1 - this.run), -frantic * 0.04 * this.panic);
    for (const [arm, elbow, hand, leg, knee, foot, target, side] of [
      [this.armL, this.elbowL, this.handL, this.legL, this.kneeL, this.footL, this.targetL, -1],
      [this.armR, this.elbowR, this.handR, this.legR, this.kneeR, this.footR, this.targetR, 1],
    ] as const) {
      const cycle = this.phase + (side === 1 ? Math.PI : 0);
      const swing = Math.sin(cycle);
      const lift = Math.max(0, Math.cos(cycle));
      const kick = Math.sin(this.clock * 20 + (side === 1 ? Math.PI : 0));
      arm.rotation.set(swing * 0.72 * this.run * forward - 0.25 * this.air + kick * 0.25 * this.panic, 0,
        side * (0.08 + this.air * 0.62 + this.panic * (0.3 + frantic * 0.12)));
      elbow.rotation.set(-0.16 - this.run * (0.7 + swing * 0.22) - this.air * 0.65, 0, 0);
      hand.rotation.set(0, 0, -side * this.panic * 0.18);
      leg.rotation.set(-0.12 - this.air * (0.32 + side * 0.18) + kick * 0.65 * this.panic, 0, -side * 0.1 * this.air);
      knee.rotation.set(0.24 + this.air * (0.85 - side * 0.2) + Math.max(0, -kick) * 0.85 * this.panic, 0, 0);
      target.position.set(side * this.ankleWidth + swing * 0.2 * this.run * strafe,
        this.ankleHeight + lift * 0.2 * this.run, swing * 0.3 * this.run * forward);
      foot.rotation.set(0, 0, 0);
    }
    this.root.updateMatrixWorld(true);
    if (motion.grounded && this.air < 0.15) {
      this.solver.update();
      this.footL.rotation.x = -this.legL.rotation.x - this.kneeL.rotation.x;
      this.footR.rotation.x = -this.legR.rotation.x - this.kneeR.rotation.x;
    } else {
      this.footL.rotation.x = 0.2 + frantic * 0.2 * this.panic;
      this.footR.rotation.x = 0.2 - frantic * 0.2 * this.panic;
    }
  }

  dispose(): void {
    this.skeleton.dispose();
  }
}