import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { CCDIKSolver } from 'three/addons/animation/CCDIKSolver.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

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
  readonly hips = this.joint('Hips', this.root, 0, 0.82, 0);
  readonly spine = this.joint('Spine', this.hips, 0, 0.19, 0);
  readonly chest = this.joint('Chest', this.spine, 0, 0.2, 0);
  readonly neck = this.joint('Neck', this.chest, 0, 0.26, 0);
  readonly head = this.joint('Head', this.neck, 0, 0.21, 0);
  readonly armL = this.joint('UpperArm_L', this.chest, -0.43, 0.14, 0);
  readonly elbowL = this.joint('Forearm_L', this.armL, 0, -0.29, 0);
  readonly handL = this.joint('Hand_L', this.elbowL, 0, -0.25, 0);
  readonly armR = this.joint('UpperArm_R', this.chest, 0.43, 0.14, 0);
  readonly elbowR = this.joint('Forearm_R', this.armR, 0, -0.29, 0);
  readonly handR = this.joint('Hand_R', this.elbowR, 0, -0.25, 0);
  readonly legL = this.joint('Thigh_L', this.hips, -0.19, 0, 0);
  readonly kneeL = this.joint('Shin_L', this.legL, 0, -0.36, 0);
  readonly footL = this.joint('Foot_L', this.kneeL, 0, -0.34, 0);
  readonly legR = this.joint('Thigh_R', this.hips, 0.19, 0, 0);
  readonly kneeR = this.joint('Shin_R', this.legR, 0, -0.36, 0);
  readonly footR = this.joint('Foot_R', this.kneeR, 0, -0.34, 0);
  readonly headMount = new THREE.Group();
  readonly backMount = new THREE.Group();
  readonly weaponMount = new THREE.Group();
  readonly pack: THREE.Mesh;
  readonly mesh: THREE.SkinnedMesh;
  readonly skeleton: THREE.Skeleton;
  readonly accent: THREE.MeshLambertMaterial;
  state: 'idle' | 'run' | 'jump' | 'fall' = 'idle';
  private readonly targetL = this.joint('FootTarget_L', this.root, -0.19, 0.12, 0);
  private readonly targetR = this.joint('FootTarget_R', this.root, 0.19, 0.12, 0);
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
    this.root.userData.avatarRevision = 'rounded-rig-v1';
    this.accent = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.8 });
    const materials = [
      new THREE.MeshLambertMaterial({ color: 0x34434b }),
      new THREE.MeshLambertMaterial({ color: 0xb9c9c9 }),
      this.accent,
      new THREE.MeshLambertMaterial({ color: 0x101c25 }),
      new THREE.MeshLambertMaterial({ color: 0xe1efed }),
    ];
    this.root.updateMatrixWorld(true);
    const bones: THREE.Bone[] = [];
    this.root.traverse(object => { if (object instanceof THREE.Bone) bones.push(object); });
    this.skeleton = new THREE.Skeleton(bones);
    const surfaces: THREE.BufferGeometry[][] = materials.map(() => []);
    const shell = (bone: THREE.Bone, material: number, size: [number, number, number], offset: [number, number, number], shape?: THREE.BufferGeometry) => {
      const source = shape ?? new THREE.SphereGeometry(1, 16, 12);
      const geometry = source.index ? source : mergeVertices(source);
      if (geometry !== source) source.dispose();
      geometry.scale(...size).translate(...offset).applyMatrix4(bone.matrixWorld);
      const count = geometry.attributes.position.count;
      const indices = new Uint16Array(count * 4);
      const weights = new Float32Array(count * 4);
      for (let vertex = 0; vertex < count; vertex++) {
        indices[vertex * 4] = bones.indexOf(bone);
        weights[vertex * 4] = 1;
      }
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
      surfaces[material].push(geometry);
    };
    shell(this.hips, 0, [0.29, 0.17, 0.2], [0, 0, 0]);
    shell(this.spine, 0, [0.255, 0.27, 0.18], [0, 0.02, 0]);
    shell(this.chest, 1, [0.35, 0.28, 0.235], [0, 0.02, 0]);
    shell(this.chest, 3, [0.27, 0.145, 0.07], [0, 0.06, 0.204]);
    shell(this.chest, 2, [0.222, 0.084, 0.036], [0, 0.075, 0.264], new RoundedBoxGeometry(2, 2, 2, 3, 0.55));
    for (const side of [-1, 1]) {
      shell(this.hips, 1, [0.13, 0.105, 0.075], [side * 0.17, 0.015, 0.155]);
    }
    shell(this.neck, 0, [0.115, 0.12, 0.115], [0, 0.02, 0]);
    shell(this.head, 1, [0.244, 0.222, 0.237], [0, 0, 0]);
    shell(this.head, 3, [0.216, 0.112, 0.1], [0, 0.012, 0.171]);
    shell(this.head, 2, [0.17, 0.029, 0.018], [0, 0.015, 0.265]);
    shell(this.head, 4, [0.125, 0.047, 0.04], [0, -0.144, 0.166]);
    for (const [arm, elbow, hand, leg, knee, foot, side] of [
      [this.armL, this.elbowL, this.handL, this.legL, this.kneeL, this.footL, -1],
      [this.armR, this.elbowR, this.handR, this.legR, this.kneeR, this.footR, 1],
    ] as const) {
      shell(arm, 0, [0.095, 0.19, 0.1], [0, -0.135, 0]);
      shell(arm, 1, [0.18, 0.15, 0.182], [side * 0.012, 0.005, 0]);
      shell(arm, 2, [0.183, 0.153, 0.185], [side * 0.012, 0.005, 0], new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, 0, 1.05));
      shell(elbow, 0, [0.092, 0.095, 0.095], [0, 0, 0]);
      shell(elbow, 1, [0.115, 0.143, 0.12], [0, -0.13, 0.012]);
      shell(hand, 0, [0.094, 0.092, 0.096], [0, -0.028, 0.015]);
      shell(leg, 0, [0.13, 0.22, 0.13], [0, -0.16, 0]);
      shell(leg, 1, [0.132, 0.175, 0.1], [0, -0.13, 0.068]);
      shell(knee, 0, [0.105, 0.106, 0.11], [0, 0, 0]);
      shell(knee, 1, [0.12, 0.182, 0.13], [0, -0.16, 0.017]);
      shell(knee, 4, [0.102, 0.086, 0.06], [0, -0.016, 0.092]);
      shell(foot, 0, [0.14, 0.1, 0.224], [0, -0.016, 0.065]);
      shell(foot, 1, [0.131, 0.076, 0.16], [0, 0.013, 0.107]);
    }
    const merged = surfaces.map(surface => mergeGeometries(surface)!);
    const geometry = mergeGeometries(merged, true)!;
    for (const surface of [...surfaces.flat(), ...merged]) surface.dispose();
    this.mesh = new THREE.SkinnedMesh(geometry, materials);
    this.mesh.name = 'RoundedPlayerArmor';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.root.add(this.mesh);
    this.mesh.bind(this.skeleton);
    this.headMount.name = 'headMount';
    this.backMount.name = 'backMount';
    this.weaponMount.name = 'weaponMount';
    this.head.add(this.headMount);
    this.backMount.position.set(0, -0.06, -0.28);
    this.chest.add(this.backMount);
    this.weaponMount.position.set(0, 0.02, 0.22);
    this.handR.add(this.weaponMount);
    this.pack = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.15, 4, 12), materials[0]);
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

  private joint(name: string, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Bone {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(x, y, z);
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
    this.hips.position.y = 0.79 + Math.abs(stride) * 0.035 * this.run - this.landing;
    this.hips.rotation.set(0, stride * 0.065 * this.run, -strafe * 0.07 * this.run);
    this.spine.rotation.set(0.12 * this.run * forward - 0.13 * this.air, stride * -0.1 * this.run, Math.sin(this.clock * 1.1) * 0.014);
    this.chest.position.y = 0.2 + breathe * 0.004;
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
      target.position.set(side * 0.19 + swing * 0.2 * this.run * strafe,
        0.12 + lift * 0.2 * this.run, swing * 0.3 * this.run * forward);
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