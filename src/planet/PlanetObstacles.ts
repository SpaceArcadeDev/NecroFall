/**
 * NECROFALL — environmental object colliders (trees, bushes, rocks, spikes,
 * crystals). A flat list of surface-anchored circles; the player resolver
 * pushes the body out of any overlapping circle in the local tangent plane.
 *
 * ~1 100 obstacles, one dot-product prefilter each per physics step — the
 * brute-force query is cheaper than maintaining a spatial index at this scale.
 */
import * as THREE from 'three/webgpu';
import type { Placement } from './Placement';

interface Obstacle {
  /** Surface point (planet space). */
  position: THREE.Vector3;
  /** |position| — the surface radius under the object. */
  positionRadius: number;
  /** Unit surface direction (for the angular prefilter). */
  direction: THREE.Vector3;
  /** Horizontal collision radius in metres. */
  radius: number;
  /** Object height in metres (drives the step-over cap). */
  height: number;
  /** Low objects (rocks, bushes) are climbed over; tall/pointed ones block. */
  steppable: boolean;
  /** dot(direction, obstacleDirection) prefilter threshold. */
  reachCos: number;
}

/** Objects at most this tall are stepped onto automatically. */
const STEP_HEIGHT = 0.68;

export class PlanetObstacles {
  private readonly list: Obstacle[] = [];
  private readonly scratchUp = new THREE.Vector3();
  private readonly scratchTo = new THREE.Vector3();
  private readonly scratchPush = new THREE.Vector3();

  constructor(private readonly planetRadius: number) {}

  get count(): number {
    return this.list.length;
  }

  /** Registers a placed object as a solid circle of `radius` metres. */
  add(placement: Placement, radius: number, height = radius, steppable = false): void {
    if (radius <= 0.02) return;
    const position = placement.position.clone();
    this.list.push({
      position,
      positionRadius: position.length(),
      direction: position.clone().normalize(),
      radius,
      height,
      steppable,
      // prefilter for a generous body radius (0.8 m) — the exact overlap is
      // resolved in the tangent plane after this reject
      reachCos: Math.cos((radius + 0.8) / this.planetRadius),
    });
  }

  /**
   * Pushes `position` out of every overlapping obstacle. Cancels the inward
   * component of `velocity` when supplied so the body slides around instead of
   * grinding. Returns true when anything was adjusted.
   */
  resolve(position: THREE.Vector3, bodyRadius: number, velocity?: THREE.Vector3): boolean {
    const up = this.scratchUp.copy(position).normalize();
    let adjusted = false;

    for (const obstacle of this.list) {
      if (up.dot(obstacle.direction) < obstacle.reachCos) continue;

      const to = this.scratchTo.subVectors(obstacle.position, position);
      const vertical = to.dot(up);
      if (Math.abs(vertical) > 4) continue; // far above/below — let it be

      // tangent-plane offset from the body to the obstacle centre
      const tx = to.x - up.x * vertical;
      const ty = to.y - up.y * vertical;
      const tz = to.z - up.z * vertical;
      const distanceSq = tx * tx + ty * ty + tz * tz;
      const minDistance = obstacle.radius + bodyRadius;
      if (distanceSq >= minDistance * minDistance) continue;

      const distance = Math.sqrt(distanceSq);

      // steppable objects (small rocks, bushes) are climbed OVER, never blocked:
      // stand on the ellipsoid cap — smoothly ramps up as the body crosses the
      // footprint, so walking over a knee-high rock just works
      if (obstacle.steppable && obstacle.height <= STEP_HEIGHT) {
        const t = Math.min(1, distance / obstacle.radius);
        const standRadius = obstacle.positionRadius + obstacle.height * Math.sqrt(Math.max(0, 1 - t * t));
        if (position.length() < standRadius) {
          position.multiplyScalar(standRadius / Math.max(1e-6, position.length()));
          adjusted = true;
        }
        continue;
      }
      let nx: number;
      let ny: number;
      let nz: number;
      if (distance > 1e-4) {
        // push AWAY from the obstacle centre (note the flip: `to` points from
        // the body TO the obstacle — a missing sign here sucks the player in
        // and cancels any escape velocity, i.e. “stuck inside objects”)
        nx = -tx / distance;
        ny = -ty / distance;
        nz = -tz / distance;
      } else {
        // dead centre — pick a stable push direction perpendicular to up
        const push = this.scratchPush.set(1, 0, 0);
        if (Math.abs(up.x) > 0.9) push.set(0, 0, 1);
        push.addScaledVector(up, -push.dot(up)).normalize();
        nx = push.x;
        ny = push.y;
        nz = push.z;
      }

      const pushDistance = minDistance - distance;
      position.x += nx * pushDistance;
      position.y += ny * pushDistance;
      position.z += nz * pushDistance;

      if (velocity) {
        const inward = velocity.x * nx + velocity.y * ny + velocity.z * nz;
        if (inward < 0) {
          velocity.x -= nx * inward;
          velocity.y -= ny * inward;
          velocity.z -= nz * inward;
        }
      }
      adjusted = true;
    }

    return adjusted;
  }
}
