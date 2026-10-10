import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, color as nodeColor, materialColor, materialEmissive, mix, smoothstep } from 'three/tsl';
import { CCDIKSolver } from 'three/addons/animation/CCDIKSolver.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import avatarUrl from './assets/chameleon.glb?url';
import anatomy from './assets/chameleon.json';

const asset = await new GLTFLoader().loadAsync(avatarUrl);
const sourceMesh = asset.scene.getObjectByName('ChameleonAvatar') as THREE.SkinnedMesh;
if (!sourceMesh?.isSkinnedMesh) throw new Error('Chameleon avatar skin is missing');
const bodyGeometry = sourceMesh.geometry.clone();
const regions: number[][] = [[], []];
const positions = bodyGeometry.attributes.position;
const normals = bodyGeometry.attributes.normal;
const triangles = bodyGeometry.index!;
const chestOrigin = anatomy.joints.find(joint => joint.name === 'Chest')!.position;
const shoulderOrigin = anatomy.joints.find(joint => joint.name === 'UpperArm_R')!.position;
const center = new THREE.Vector3();
const normal = new THREE.Vector3();
for (let offset = 0; offset < triangles.count; offset += 3) {
  const vertices = [triangles.getX(offset), triangles.getX(offset + 1), triangles.getX(offset + 2)];
  center.set(0, 0, 0); normal.set(0, 0, 0);
  for (const vertex of vertices) {
    center.x += positions.getX(vertex) / 3; center.y += positions.getY(vertex) / 3; center.z += positions.getZ(vertex) / 3;
    normal.x += normals.getX(vertex); normal.y += normals.getY(vertex); normal.z += normals.getZ(vertex);
  }
  normal.normalize();
  const chest = (center.x / 0.15) ** 2 + ((center.y - chestOrigin[1] - 0.015) / 0.085) ** 2 < 1 && center.z > 0.07;
  const shoulder = Math.abs(Math.abs(center.x) - shoulderOrigin[0]) < 0.105
    && center.y > shoulderOrigin[1] && normal.y > 0;
  regions[chest || shoulder ? 1 : 0].push(...vertices);
}
bodyGeometry.setIndex(regions.flat());
bodyGeometry.clearGroups();
bodyGeometry.addGroup(0, regions[0].length, 0);
bodyGeometry.addGroup(regions[0].length, regions[1].length, 1);

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
  readonly accent: MeshStandardNodeMaterial;
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
    this.root.userData.avatarRevision = 'chameleon-rig-v1';
    this.root.userData.sourceSHA256 = anatomy.sourceSHA256;
    const sourceMaterial = sourceMesh.material as THREE.MeshStandardMaterial;
    this.accent = new MeshStandardNodeMaterial({ color, emissive: color, emissiveIntensity: 0.8,
      roughness: sourceMaterial.roughness, metalness: sourceMaterial.metalness });
    const rest = attribute('position', 'vec3');
    const chestGlow = smoothstep(0.85, 1, rest.x.div(0.115).pow(2)
      .add(rest.y.sub(chestOrigin[1] + 0.015).div(0.048).pow(2))).oneMinus().mul(smoothstep(0.085, 0.105, rest.z));
    const shoulderGlow = smoothstep(0.06, 0.074, rest.x.abs().sub(shoulderOrigin[0]).abs()).oneMinus()
      .mul(smoothstep(shoulderOrigin[1] + 0.025, shoulderOrigin[1] + 0.045, rest.y))
      .mul(smoothstep(0.25, 0.45, attribute('normal', 'vec3').y));
    const glow = chestGlow.max(shoulderGlow);
    this.accent.colorNode = mix(nodeColor(sourceMaterial.color), materialColor.rgb, glow);
    this.accent.emissiveNode = materialEmissive.mul(glow);
    const materials = [
      sourceMaterial.clone(),
      this.accent,
    ];
    this.root.updateMatrixWorld(true);
    const bones = anatomy.joints.map(joint => this.root.getObjectByName(joint.name) as THREE.Bone);
    this.skeleton = new THREE.Skeleton(bones);
    this.mesh = new THREE.SkinnedMesh(bodyGeometry.clone(), materials);
    this.mesh.name = 'ChameleonAvatar';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.root.add(this.mesh);
    this.mesh.bind(this.skeleton);
    this.headMount.name = 'headMount';
    this.backMount.name = 'backMount';
    this.weaponMount.name = 'weaponMount';
    this.headMount.scale.setScalar(anatomy.headRadius / 0.244);
    this.head.add(this.headMount);
    this.backMount.position.set(0, -0.06, anatomy.backDepth);
    this.backMount.scale.setScalar(0.82);
    this.chest.add(this.backMount);
    this.weaponMount.position.set(0, -0.015, 0.10);
    this.handR.add(this.weaponMount);
    this.pack = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.15, 4, 12), new THREE.MeshLambertMaterial({ color: 0x34434b }));
    this.pack.scale.set(1.25, 1, 0.6);
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
    const joint = anatomy.joints.find(joint => joint.name === name)!;
    const origin = anatomy.joints.find(joint => joint.name === parent.name)?.position ?? [0, 0, 0];
    bone.position.fromArray(joint.position).sub(new THREE.Vector3().fromArray(origin));
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
    this.accent.emissiveIntensity = 0.78 + breathe * 0.08;
  }

  dispose(): void {
    this.skeleton.dispose();
  }
}