/**
 * NECROFALL — analytic planet collider (plan §41).
 *
 * The collision surface IS the terrain function: closest point on the surface,
 * surface normal, local radius. No discretisation, no Rapier bodies needed for
 * a height field that is already a closed-form function — entities are simply
 * constrained to `planetRadius + terrainHeight + footOffset`.
 */
import * as THREE from 'three/webgpu';
import type { PlanetSurface } from '../../planet/PlanetSurface';

export class PlanetCollider {
  private readonly scratch = new THREE.Vector3();

  constructor(private readonly surface: PlanetSurface) {}

  /** Radius (centre → surface) under a position direction. */
  surfaceRadiusAt(position: THREE.Vector3): number {
    this.scratch.copy(position).normalize();
    return this.surface.radiusAt(this.scratch);
  }

  /** Closest point on the terrain surface under `position` (into `out`). */
  closestPoint(position: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.scratch.copy(position).normalize();
    const radius = this.surface.radiusAt(this.scratch);
    return out.copy(this.scratch).multiplyScalar(radius);
  }

  /** Surface normal (radial direction; the visual normal lives in PlanetSurface). */
  normalAt(position: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(position).normalize();
  }

  /** Penetration depth, positive when `position` is under the surface. */
  penetration(position: THREE.Vector3, footOffset: number): number {
    const radius = this.surfaceRadiusAt(position);
    return radius + footOffset - position.length();
  }
}
