/**
 * NECROFALL — physics surface queries (plan §41).
 *
 * The gameplay-facing helpers the dev world (and, at cutover, the real Player)
 * use to stand / walk / jump on the planet.
 */
import * as THREE from 'three/webgpu';
import type { PlanetSurface } from '../../planet/PlanetSurface';
import type { PlanetCollider } from './PlanetCollider';

export class PhysicsSurface {
  constructor(
    readonly collider: PlanetCollider,
    readonly surface: PlanetSurface,
  ) {}

  groundRadiusAt(direction: THREE.Vector3): number {
    return this.surface.radiusAt(direction);
  }

  /**
   * Clamp an entity to the surface. `footOffset` is the distance from the
   * surface to the entity origin (feet).
   */
  projectToSurface(position: THREE.Vector3, footOffset: number): void {
    const direction = position.clone().normalize();
    const radius = this.surface.radiusAt(direction);
    position.copy(direction).multiplyScalar(Math.max(position.length(), radius + footOffset));
  }

  isGrounded(position: THREE.Vector3, footOffset: number, tolerance = 0.12): boolean {
    const direction = position.clone().normalize();
    const radius = this.surface.radiusAt(direction);
    return position.length() - (radius + footOffset) < tolerance;
  }

  /** Downwards along the local normal until the surface (for placement/tests). */
  dropToSurface(position: THREE.Vector3, footOffset: number, out: THREE.Vector3): THREE.Vector3 {
    const direction = position.clone().normalize();
    const radius = this.surface.radiusAt(direction);
    return out.copy(direction).multiplyScalar(radius + footOffset);
  }

  normalAt(position: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return this.collider.normalAt(position, out);
  }
}
