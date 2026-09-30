// NECROFALL — surface frame for the spherical planet (plan §77/§78).
//
// Folio's world assumes up = (0, 1, 0). On a planet every environmental object needs its own
// frame: a position on the surface, the terrain normal as "up", a tangent basis, and a
// quaternion that aligns local +Y with the normal (so trees/props/flames stand upright while
// still being rotated randomly around the up axis).
//
// One frame object is reused everywhere (placement is synchronous), so the whole world is
// built with zero per-object allocations beyond the final matrix.
import * as THREE from 'three/webgpu';
import { tangentBasis } from '../../utils/Utils';
import type { TerrainSurface } from '../TerrainSurface';

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _upY = new THREE.Vector3(0, 1, 0);
const _basis = new THREE.Matrix4();
const _qYaw = new THREE.Quaternion();

export class SurfaceFrame {
  /** Surface point (radius-space, world space). */
  readonly position = new THREE.Vector3();
  /** Terrain normal — local +Y. */
  readonly normal = new THREE.Vector3();
  /** Unit sphere direction under the frame. */
  readonly direction = new THREE.Vector3();
  /** Tangent of the frame's random yaw. */
  readonly tangent = new THREE.Vector3();
  readonly bitangent = new THREE.Vector3();
  /** orientation: +Y aligns with `normal`, yawed randomly around it. */
  readonly quaternion = new THREE.Quaternion();

  /** Terrain data sampled while filling (for shader attributes and placement rules). */
  height = 0;
  slope = 0;
  vegetation = 0;
  water = 0;

  /**
   * Fill from a unit direction. `yaw` is the random rotation around the surface normal — pass
   * the same value used for placement so instances and colliders share one frame.
   */
  setFromDirection(dir: THREE.Vector3, surface: TerrainSurface, yaw = 0): this {
    this.direction.copy(dir).normalize();

    // --- terrain data through the ONE shared surface
    this.height = surface.heightAtDir(this.direction.x, this.direction.y, this.direction.z);
    surface.normalAtDir(this.direction.x, this.direction.y, this.direction.z, this.normal);
    this.slope = surface.slopeAtDir(this.direction.x, this.direction.y, this.direction.z);
    this.vegetation = surface.vegetationAtDir(this.direction.x, this.direction.y, this.direction.z);
    this.water = Math.max(0, surface.waterLevel - this.height);

    this.position.copy(this.direction).multiplyScalar(this.height);

    // --- tangent basis in the terrain plane (for props that need an explicit frame)
    tangentBasis(this.normal, _t1, _t2);
    this.tangent.copy(_t1).applyAxisAngle(this.normal, yaw);
    // Right-handed basis for `makeBasis(tangent, normal, bitangent)`: z must be cross(x, y).
    // (With the opposite sign the matrix is mirrored, `setFromRotationMatrix` yields a NON-UNIT
    // quaternion — |q| ≈ 0.75 measured — and every instance matrix built from it comes out
    // sheared/distorted.)
    this.bitangent.crossVectors(this.tangent, this.normal).normalize();

    // --- quaternion: local +Y → normal, then random yaw around the normal
    _basis.makeBasis(this.tangent, this.normal, this.bitangent);
    this.quaternion.setFromRotationMatrix(_basis).normalize();
    return this;
  }

  /** The upright orientation without yaw (for aim/turret maths). */
  alignUp(out: THREE.Quaternion): THREE.Quaternion {
    return out.setFromUnitVectors(_upY, this.normal);
  }

  /** Apply the frame to an Object3D. */
  applyTo(object: THREE.Object3D): void {
    object.position.copy(this.position);
    object.quaternion.copy(this.quaternion);
  }
}

/** A reusable frame for synchronous placement loops. */
export const SHARED_FRAME = new SurfaceFrame();
