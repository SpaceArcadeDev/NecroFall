// NECROFALL — SURFACE COLLIDER (rework plan §22/§23/§64).
//
// The physics side of the terrain: a *sampled* collision surface, never the rendered mesh.
//
//   rendering geometry:  icosphere at planetDetail (up to 20k triangles)
//   collision geometry:  the analytic height field — evaluated per contact, zero memory
//
// That is the plan's "high detail render / low detail physics" split (§22) taken to its logical
// conclusion on a procedural sphere: no collision triangles exist at all, so there is nothing to
// build, sync or LOD. Distance decides CADENCE instead (§23): bodies far from every focus stop
// simulating entirely; bodies in the mid ring use a cheaper step (coarser normals, no friction
// micro-solve); bodies near gameplay get the full step.
import * as THREE from 'three';
import { clamp } from '../../utils/Utils';
import type { EnvironmentProfile } from '../EnvironmentConfig';
import type { PlanetTerrainProvider } from '../terrain/PlanetTerrainProvider';

export const CONTACT_FULL = 0;
export const CONTACT_COARSE = 1;
export const CONTACT_NONE = 2;

const _d = new THREE.Vector3();

export interface GroundContact {
  height: number;
  normal: THREE.Vector3;
  slope: number;
}

export class SurfaceCollider {
  /** Scratch normal (single-threaded use; fine for this engine). */
  private readonly normal = new THREE.Vector3();
  private readonly contact: GroundContact = { height: 0, normal: this.normal, slope: 0 };

  constructor(
    private readonly provider: PlanetTerrainProvider,
    private profile: EnvironmentProfile
  ) {}

  /** Swap profile when the device quality changes mid-session (plan §46/§47). */
  setProfile(profile: EnvironmentProfile): void {
    this.profile = profile;
  }

  /** Terrain height under a world position (radial projection — the game's ground contract). */
  heightAt(pos: THREE.Vector3): number {
    _d.copy(pos);
    const len = _d.length();
    if (len < 1e-4) return this.provider.radius;
    _d.multiplyScalar(1 / len);
    return this.provider.getHeight(_d.x, _d.y, _d.z);
  }

  /**
   * Contact info at a world position: ground height, terrain normal and slope. `coarse` skips the
   * slope probe (the caller does not need it), halving the cost for mid-distance bodies.
   */
  groundAt(pos: THREE.Vector3, coarse = false): GroundContact {
    const h = this.heightAt(pos);
    _d.copy(pos).normalize();
    this.provider.getNormal(_d.x, _d.y, _d.z, this.normal);
    this.contact.height = h;
    this.contact.slope = coarse ? 0 : this.provider.getSlope(_d.x, _d.y, _d.z);
    return this.contact;
  }

  /** True when a body is above the ground by `clearance`. */
  isAbove(pos: THREE.Vector3, clearance = 0): boolean {
    return pos.length() - this.heightAt(pos) > clearance;
  }

  /** Projects a position onto the ground + lift (used by props settling / debris). */
  clampToGround(pos: THREE.Vector3, lift: number): boolean {
    const h = this.heightAt(pos) + lift;
    const len = pos.length();
    if (len >= h) return false;
    pos.multiplyScalar(h / Math.max(1e-5, len));
    return true;
  }

  /**
   * Collision cadence class for a body at `distance` from the nearest focus (plan §23):
   *   < physicsRadius          → FULL     (every step, friction, rest)
   *   physicsRadius .. ×2      → COARSE   (every other step, no friction micro-detail)
   *   beyond                   → NONE     (sleeping; the renderer still draws it)
   */
  cadence(distance: number): typeof CONTACT_FULL | typeof CONTACT_COARSE | typeof CONTACT_NONE {
    const r = this.profile.physicsRadius;
    if (distance <= r) return CONTACT_FULL;
    if (distance <= r * 2) return CONTACT_COARSE;
    return CONTACT_NONE;
  }

  /** Metric used for cadence: distance from the body to its nearest focus (squared avoided). */
  distanceToFocus(pos: THREE.Vector3, focus: THREE.Vector3 | null): number {
    if (!focus) return 0;
    return clamp(pos.distanceTo(focus), 0, 1e6);
  }
}

/** Convenience: world-space direction of "down" at a point (toward the planet centre). */
export function gravityDown(pos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(pos).normalize().negate();
}
