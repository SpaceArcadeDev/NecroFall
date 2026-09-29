// NECROFALL — PhysicsObject (plan §24): a thin wrapper over a Rapier body plus the metadata the
// game needs (what kind of thing it is, what it collides as, which placement it came from).
// Objects are POOLED by WorldPhysics — destroyed props are detached, not deleted and re-created.
import type * as RAPIER from '@dimforge/rapier3d';
import * as THREE from 'three/webgpu';

export type PhysicsObjectKind = 'tree' | 'prop' | 'crate';

export class PhysicsObject {
  readonly colliders: RAPIER.Collider[] = [];

  constructor(
    readonly kind: PhysicsObjectKind,
    readonly body: RAPIER.RigidBody,
    /** Index into the placement list the object was built from (mesh sync + destruction). */
    readonly sourceIndex: number,
  ) {}

  get isDynamic(): boolean {
    return this.body.isDynamic();
  }

  /** Body translation copied into `out` (Rapier returns a cached vector; copy before reusing). */
  position(out: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation();
    return out.set(t.x, t.y, t.z);
  }

  /** Full body transform as a matrix (for instanced-mesh sync). */
  matrix(out: THREE.Matrix4, position: THREE.Vector3, quaternion: THREE.Quaternion): THREE.Matrix4 {
    const t = this.body.translation();
    const r = this.body.rotation();
    position.set(t.x, t.y, t.z);
    quaternion.set(r.x, r.y, r.z, r.w);
    return out.compose(position, quaternion, _one);
  }

  destroy(): void {
    for (const collider of this.colliders) collider.setEnabled(false);
    this.body.setEnabled(false);
  }
}

const _one = new THREE.Vector3(1, 1, 1);
