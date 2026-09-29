// NECROFALL — PLANET SURFACE COORDINATE (rework plan §3).
//
// NecroFall's planets are spheres: global +Y is NOT "up". Every environmental object — trees,
// grass, rocks, water, props, decals, VFX — is placed in a LOCAL TANGENT FRAME at its surface
// point:
//
//     direction   = normalize(worldPosition − planetCentre)   (planetCentre = origin)
//     surfacePos  = direction × terrainHeight(direction)
//     localUp     = terrain normal
//     tangent     = arbitrary but DETERMINISTIC perpendicular to up (no random basis!)
//
// Determinism matters: the tangent frame feeds placement rotations, and two multiplayer clients
// must derive byte-identical frames from the same direction (plan §20/§59).
import * as THREE from 'three';

export interface PlanetSurfaceCoordinate {
  /** Unit direction from the planet centre. */
  direction: THREE.Vector3;
  /** Distance from the centre to this surface point (radius + terrain height). */
  radius: number;
  /** Height above the reference radius. */
  height: number;
  /** Terrain normal at this point (local "up"). */
  normal: THREE.Vector3;
  /** Tangent basis, perpendicular to `normal`. */
  tangent: THREE.Vector3;
  bitangent: THREE.Vector3;
}

export function createSurfaceCoordinate(): PlanetSurfaceCoordinate {
  return {
    direction: new THREE.Vector3(0, 1, 0),
    radius: 0,
    height: 0,
    normal: new THREE.Vector3(0, 1, 0),
    tangent: new THREE.Vector3(1, 0, 0),
    bitangent: new THREE.Vector3(0, 0, 1),
  };
}

/**
 * Builds a deterministic tangent basis for a normal. NOT `THREE.Vector3.random()`-based:
 * the axis is picked from the dominant component so the same `up` always yields the same frame.
 */
export function deterministicBasis(up: THREE.Vector3, tangent: THREE.Vector3, bitangent: THREE.Vector3): void {
  // Prefer world X unless `up` is nearly parallel to it; then use world Z. The pick is a pure
  // function of `up`, and the cross products are smooth except exactly at the switching plane
  // (a 1e-9-probability event for our seeds — and still deterministic when it happens).
  if (Math.abs(up.x) < 0.9) tangent.set(1, 0, 0);
  else tangent.set(0, 0, 1);
  tangent.crossVectors(tangent, up).normalize();
  bitangent.crossVectors(up, tangent).normalize();
}

/** Builds the surface coordinate for a unit direction (allocation-free apart from the output). */
export function surfaceCoordinate(
  direction: THREE.Vector3,
  terrainRadius: number,
  referenceRadius: number,
  normal: THREE.Vector3,
  out: PlanetSurfaceCoordinate
): PlanetSurfaceCoordinate {
  out.direction.copy(direction).normalize();
  out.radius = terrainRadius;
  out.height = terrainRadius - referenceRadius;
  out.normal.copy(normal);
  deterministicBasis(out.normal, out.tangent, out.bitangent);
  return out;
}

/** World position of a surface coordinate (`planetCentre + direction × radius`). */
export function surfacePosition(coord: PlanetSurfaceCoordinate, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(coord.direction).multiplyScalar(coord.radius);
}

const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _mat = new THREE.Matrix4();

/**
 * Orients an object so its +Y axis stands along the surface normal and its +Z faces `forward`.
 * `forward` is projected into the tangent plane first, so objects never tilt off the surface.
 * With no `forward`, the object only gets the up-align (its yaw stays whatever it was).
 */
export function alignToSurface(
  obj: THREE.Object3D,
  position: THREE.Vector3,
  normal: THREE.Vector3,
  forward?: THREE.Vector3
): void {
  obj.position.copy(position);
  if (!forward) {
    obj.quaternion.setFromUnitVectors(_up, normal);
    return;
  }
  // Project forward into the tangent plane; a degenerate forward falls back to the deterministic
  // tangent so the frame is still valid (and identical on every client).
  _fwd.copy(forward).addScaledVector(normal, -forward.dot(normal));
  if (_fwd.lengthSq() < 1e-8) deterministicBasis(normal, _fwd, _right);
  else _fwd.normalize();
  _right.crossVectors(normal, _fwd).normalize(); // X = Y × Z keeps the basis right-handed
  _mat.makeBasis(_right, normal, _fwd);
  obj.quaternion.setFromRotationMatrix(_mat);
}
