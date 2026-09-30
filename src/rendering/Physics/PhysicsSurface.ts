// NECROFALL — PhysicsSurface (plan §41, §42): the physics-side surface query.
//
// The ONE terrain query API (`PlanetSurface.sample`) has a physics twin: this adapter exposes
// the same surface to the Rapier side of the world (ground clamps, normals, penetration depth)
// without letting any physics consumer re-derive terrain math. Terrain itself never becomes a
// Rapier trimesh — it stays analytical (plan §25).
import * as THREE from 'three/webgpu';
import type { PlanetSurface } from '../Environment/PlanetSurface';
import { PlanetCollider } from './PlanetCollider';

export class PhysicsSurface {
  readonly collider: PlanetCollider;

  constructor(private readonly surface: PlanetSurface) {
    this.collider = new PlanetCollider(surface);
  }

  /** Clamp a world position to stand on the terrain (`footOffset` above it). */
  clampToGround(position: THREE.Vector3, footOffset: number, out: THREE.Vector3): THREE.Vector3 {
    const direction = _dir.copy(position).normalize();
    const radius = this.collider.standingRadius(position, footOffset);
    return out.copy(direction).multiplyScalar(radius);
  }

  /** Terrain normal under a world position. */
  normalAt(position: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return this.collider.normalAt(position, out);
  }

  /** How far below the terrain surface the position is (≤ 0 = free). */
  penetrationAt(position: THREE.Vector3, footOffset = 0): number {
    const sample = this.surface.sample(position);
    const surfaceRadius = this.surface.radius + sample.height + footOffset;
    return position.length() - surfaceRadius;
  }
}

const _dir = new THREE.Vector3();
