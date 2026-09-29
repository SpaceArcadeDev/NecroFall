// NECROFALL — DYNAMIC PROP PHYSICS (rework plan §24/§56/§58/§70).
//
// The visual half of the dynamic bodies: one instanced mesh of small chunks that mirrors the
// bodies `PhysicsWorld` simulates (crates knocked loose, wreck debris thrown by explosions).
// Bodies are pooled and short-lived; when a body despawns its slot is recycled — gameplay never
// allocates a new `THREE.Mesh` (plan §70).
import * as THREE from 'three';
import { createEnvironmentMaterial } from '../rendering/EnvironmentMaterials';
import type { EnvironmentContext } from '../EnvironmentContext';
import type { PhysicsBody, PhysicsWorld } from './PhysicsWorld';
import { PHYS_DYNAMIC } from './PhysicsWorld';

const MAX_SLOTS_BY_PROFILE: Record<string, number> = {
  ultra: 96,
  high: 64,
  medium: 40,
  low: 20,
};

interface DebrisSlot {
  body: PhysicsBody | null;
  /** Visual spin (axis × speed) — decoration only, never synced (plan §26). */
  axisX: number;
  axisY: number;
  axisZ: number;
  spin: number;
  angle: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _tang = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _scaleV = new THREE.Vector3();
const _color = new THREE.Color();

export class DynamicPropPhysics {
  private readonly mesh: THREE.InstancedMesh;
  private readonly slots: DebrisSlot[] = [];
  private readonly free: number[] = [];
  private readonly capacity: number;
  private visible = true;
  private activeCount = 0;

  constructor(private readonly ctx: EnvironmentContext, private readonly world: PhysicsWorld) {
    this.capacity = MAX_SLOTS_BY_PROFILE[ctx.profile.name] ?? 40;
    const material = createEnvironmentMaterial(ctx.wind, { facet: 0.5, noise: 0.5, fresnel: 0.1 });
    material.uniforms.uTagColor.value = new THREE.Color(0x8a6a4a);
    // A chunky low-poly chunk reads as "debris" without needing per-kind geometry.
    this.mesh = new THREE.InstancedMesh(
      ctx.assets.ensure('geo:debris-box', () => new THREE.BoxGeometry(0.28, 0.22, 0.34)),
      material,
      this.capacity
    );
    this.mesh.name = 'env-debris';
    this.mesh.frustumCulled = false;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3).fill(1), 3);
    this.mesh.count = this.capacity;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) {
      this.mesh.setMatrixAt(i, zero);
      this.slots.push({ body: null, axisX: 0, axisY: 1, axisZ: 0, spin: 0, angle: 0 });
      this.free.push(i);
    }
    // Instance attributes expected by the environment shader family (single-LOD: no bands).
    const g = this.mesh.geometry;
    const zeros = new Float32Array(this.capacity);
    const ones = new Float32Array(this.capacity).fill(1);
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(ones, 1));
    g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(zeros, 1));
    g.setAttribute('aHeight', new THREE.InstancedBufferAttribute(ones, 1));
    g.setAttribute('aState', new THREE.InstancedBufferAttribute(ones, 1));
    g.setAttribute('aFade', new THREE.InstancedBufferAttribute(ones, 1));
    g.setAttribute('aRand', new THREE.InstancedBufferAttribute(zeros, 1));
    g.setAttribute('aLod', new THREE.InstancedBufferAttribute(ones, 1));
    ctx.root.add(this.mesh);

    this.world.onDespawn = (body) => this.release(body);
  }

  /** Spawns a burst of debris chunks flying away from `up`. */
  spawnBurst(pos: THREE.Vector3, up: THREE.Vector3, count: number, color: number, speed = 4.2): void {
    for (let i = 0; i < count; i++) {
      const slotIndex = this.free.pop();
      if (slotIndex === undefined) return;
      const slot = this.slots[slotIndex];
      // Transient VISUAL randomness (never world generation — plan §86): the same debris burst
      // may look slightly different on each peer, which is invisible in practice.
      _axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      _tang.crossVectors(up, _axis).normalize();
      _dir.copy(up).multiplyScalar(0.5 + Math.random() * 0.6)
        .addScaledVector(_tang, (Math.random() - 0.5) * 1.6)
        .normalize();
      _scaleV.copy(_dir).multiplyScalar(speed * (0.6 + Math.random() * 0.7));
      const body = this.world.addBody({
        layer: PHYS_DYNAMIC,
        kind: 0,
        position: pos.clone().addScaledVector(up, 0.4).addScaledVector(_dir, 0.3),
        velocity: _scaleV.clone(),
        radius: 0.2,
        scale: 0.7 + Math.random() * 0.7,
        mass: 1,
        restitution: 0.28,
        friction: 0.7,
        life: 3.5 + Math.random() * 2.5,
        userData: slotIndex,
      });
      slot.body = body;
      slot.axisX = _axis.x; slot.axisY = _axis.y; slot.axisZ = _axis.z;
      slot.spin = 3 + Math.random() * 9;
      slot.angle = Math.random() * 6.28;
      _color.setHex(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.12);
      if (this.mesh.instanceColor) {
        this.mesh.instanceColor.setXYZ(slotIndex, _color.r, _color.g, _color.b);
        this.mesh.instanceColor.needsUpdate = true;
      }
      this.activeCount++;
    }
  }

  private release(body: PhysicsBody): void {
    const slotIndex = body.userData;
    const slot = this.slots[slotIndex];
    if (!slot || slot.body !== body) return;
    slot.body = null;
    this.free.push(slotIndex);
    this.activeCount = Math.max(0, this.activeCount - 1);
    _m.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(slotIndex, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Mirrors the simulated bodies into the instanced mesh (called at the visual tick). */
  sync(dt: number): void {
    let touched = false;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.body) continue;
      slot.angle += slot.spin * dt;
      _axis.set(slot.axisX, slot.axisY, slot.axisZ);
      _q.setFromAxisAngle(_axis, slot.angle);
      _scaleV.setScalar(slot.body.scale);
      _m.compose(slot.body.position, _q, _scaleV);
      this.mesh.setMatrixAt(i, _m);
      touched = true;
    }
    if (touched) this.mesh.instanceMatrix.needsUpdate = true;
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.mesh.visible = visible;
  }

  stats(): { instances: number; activeCells: number; note?: string } {
    return { instances: this.activeCount, activeCells: 0, note: `pool ${this.capacity}` };
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
    this.world.onDespawn = null;
  }
}
