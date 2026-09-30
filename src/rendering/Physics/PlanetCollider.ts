// NECROFALL — PlanetCollider (plan §41): the spherical terrain collider adapter.
//
// NecroFall's terrain collision is ANALYTICAL (plan §25): this class is the one place the
// spherical surface math for physics lives — clamp a point to the terrain, read its normal,
// read the standing radius — so future Rapier-side consumers (dynamic props, projectiles,
// character grounding) never re-derive it.
//
//   standing radius = planetRadius + terrainHeight + footOffset
//
// Gameplay keeps its existing collision (frozen, plan §1); this adapter is the shared seam for
// everything physics-side that is added later.
import * as THREE from 'three/webgpu';
import type { PlanetSurface, SurfaceSample } from '../Environment/PlanetSurface';

export class PlanetCollider {
  /** Scratch sample — never keep a reference to the returned object. */
  private readonly sample: SurfaceSample = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    height: 0,
    slope: 0,
    grass: 0,
    wetness: 0,
    biome: 0,
  };

  constructor(private readonly surface: PlanetSurface) {}

  /** The surface point under `position` (radial projection onto the terrain). */
  closestPoint(position: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.surface.sample(position, this.sample).point);
  }

  /** The terrain normal under `position`. */
  normalAt(position: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.surface.sample(position, this.sample).normal);
  }

  /** The standing radius (planet radius + terrain height + foot offset) under `position`. */
  standingRadius(position: THREE.Vector3, footOffset = 0): number {
    const sample = this.surface.sample(position, this.sample);
    const radius = this.surface.radius + sample.height + footOffset;
    return radius;
  }

  /** True when `position` is at or below the terrain surface. */
  isInside(position: THREE.Vector3, footOffset = 0): boolean {
    const sample = this.surface.sample(position, this.sample);
    const surfaceRadius = this.surface.radius + sample.height + footOffset;
    return position.length() <= surfaceRadius;
  }
}
