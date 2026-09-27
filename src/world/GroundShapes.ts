// NECROFALL — flat shapes laid ON the planet's surface.
//
// NecroFall is played on the inside of a sphere, so a plain flat ring or cone built at a structure's
// own altitude visibly floats: laid across a hillside it hovers, laid on to a slope it slices through
// the ground. The capture ring around a Beacon, the landing ring under a colony fortress and the
// shield skirt that rises out of it all have to be projected on to the terrain — the same thing the
// ability markers (`AimPreview`) and the boss telegraphs (`TelegraphSystem`) already do.
//
// Everything here is expressed in a LOCAL frame: an object whose +Y is the surface normal at its
// origin, standing `originRadius` from the planet centre. A local offset (x, z) is turned into a
// direction on the sphere, `heightAtDir` gives the surface there, and the answer comes back as a
// local Y. The geometries are built once per match and never touched again — the terrain is fixed
// for the life of a planet, so there is nothing to recompute per frame.
import * as THREE from 'three';
import type { Planet } from './Planet';

/** The local frame of a structure standing on the surface: local +Y is the normal at its origin. */
export interface GroundFrame {
  planet: Planet;
  /** World surface normal at the frame origin. */
  up: THREE.Vector3;
  /** World direction the frame's local +X points along. */
  axisX: THREE.Vector3;
  /** World direction the frame's local +Z points along. */
  axisZ: THREE.Vector3;
  /** Distance of the frame origin from the planet centre. */
  originRadius: number;
}

/** Scratch — every call re-derives it before use, never across calls. */
const _d = new THREE.Vector3();
const _tan = new THREE.Vector3();

/**
 * The LOCAL Y that puts the tangent-plane point `(x, z)` down on the terrain.
 *
 * The world position is `up * (originRadius + y) + axisX * x + axisZ * z`, and because the two
 * tangents are perpendicular to `up` its distance from the planet centre is just
 * `sqrt((originRadius + y)^2 + r^2)`, with `r = hypot(x, z)`. Setting that equal to the terrain
 * height along the same direction and rearranging gives `y` directly — but the DIRECTION depends on
 * `y` as well, and the terrain's finest octave is high enough in frequency that reading it at the
 * flat-plane direction leaves up to ~2 m of error on a 14 m footprint. Two fixed-point passes close
 * that to centimetres: each one re-reads the height along the direction the previous `y` produced.
 * The map is strongly contractive here (a metre of `y` moves the direction by ~1/planetRadius), so
 * it converges immediately and never needs a third.
 */
export function surfaceOffsetY(f: GroundFrame, x: number, z: number): number {
  const r2 = x * x + z * z;
  _tan.copy(f.axisX).multiplyScalar(x).addScaledVector(f.axisZ, z);
  let y = 0;
  for (let pass = 0; pass < 3; pass++) {
    _d.copy(f.up).multiplyScalar(f.originRadius + y).add(_tan).normalize();
    const h = f.planet.heightAtDir(_d.x, _d.y, _d.z);
    const under = h * h - r2;
    y = (under > 0 ? Math.sqrt(under) : 0) - f.originRadius;
  }
  return y;
}

/**
 * A filled band (annulus) from `inner` to `outer` metres, laid on the terrain.
 *
 * Emitted as an unlit triangle soup rather than an indexed mesh: it is built once and never skinned,
 * and every caller's material is an additive/basic one that ignores normals, so there is nothing to
 * gain from sharing vertices.
 */
export function conformingBand(
  f: GroundFrame,
  inner: number,
  outer: number,
  segs: number,
  lift: number
): THREE.BufferGeometry {
  const n = Math.max(3, Math.round(segs));
  const verts = new Float32Array(n * 18);
  let w = 0;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);
    const ix0 = inner * c0;
    const iz0 = inner * s0;
    const ix1 = inner * c1;
    const iz1 = inner * s1;
    const ox0 = outer * c0;
    const oz0 = outer * s0;
    const ox1 = outer * c1;
    const oz1 = outer * s1;
    const iy0 = surfaceOffsetY(f, ix0, iz0) + lift;
    const iy1 = surfaceOffsetY(f, ix1, iz1) + lift;
    const oy0 = surfaceOffsetY(f, ox0, oz0) + lift;
    const oy1 = surfaceOffsetY(f, ox1, oz1) + lift;
    // quad inner0 -> outer0 -> outer1 -> inner1 as two triangles (winding is irrelevant: the
    // materials are all double sided)
    verts[w++] = ix0; verts[w++] = iy0; verts[w++] = iz0;
    verts[w++] = ox0; verts[w++] = oy0; verts[w++] = oz0;
    verts[w++] = ox1; verts[w++] = oy1; verts[w++] = oz1;
    verts[w++] = ix0; verts[w++] = iy0; verts[w++] = iz0;
    verts[w++] = ox1; verts[w++] = oy1; verts[w++] = oz1;
    verts[w++] = ix1; verts[w++] = iy1; verts[w++] = iz1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  return geo;
}

/**
 * An open cone skirt: the base ring is projected on to the terrain and the apex is a single point
 * `height` metres above the ground under the centre.
 *
 * `uv.y` runs 0 at the terrain and 1 at the tip. That is the whole gradient the shield shader fades
 * along, so the skirt is solid where it meets the ground and has dissolved to nothing before it
 * reaches the top — the wall reads as a wall without ever hiding what stands behind it. Because the
 * base ring carries the relief and the apex is a point, the entire surface conforms: it is the base
 * that was flat before, and it is the base that was wrong.
 */
export function conformingCone(
  f: GroundFrame,
  radius: number,
  height: number,
  segs: number,
  lift: number
): THREE.BufferGeometry {
  const n = Math.max(3, Math.round(segs));
  const apexY = surfaceOffsetY(f, 0, 0) + lift + Math.max(0.1, height);
  const pos = new Float32Array(n * 9);
  const uv = new Float32Array(n * 6);
  let w = 0;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const x0 = radius * Math.cos(a0);
    const z0 = radius * Math.sin(a0);
    const x1 = radius * Math.cos(a1);
    const z1 = radius * Math.sin(a1);
    pos[w++] = x0; pos[w++] = surfaceOffsetY(f, x0, z0) + lift; pos[w++] = z0;
    pos[w++] = x1; pos[w++] = surfaceOffsetY(f, x1, z1) + lift; pos[w++] = z1;
    pos[w++] = 0;  pos[w++] = apexY; pos[w++] = 0;
    uv[u++] = a0 / (Math.PI * 2); uv[u++] = 0;
    uv[u++] = a1 / (Math.PI * 2); uv[u++] = 0;
    uv[u++] = a0 / (Math.PI * 2); uv[u++] = 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  // the shield shader's fresnel term reads the normal, so these must be real
  geo.computeVertexNormals();
  return geo;
}

/**
 * A `GroundFrame` for an object that has already been oriented with local +Y = up. The frame's axes
 * are read straight off the object's quaternion, so the geometry lands in exactly the frame the
 * caller will parent it to — no tangent basis to keep in sync by hand.
 */
export function frameFor(obj: THREE.Object3D, up: THREE.Vector3, planet: Planet): GroundFrame {
  return {
    planet,
    up,
    axisX: new THREE.Vector3(1, 0, 0).applyQuaternion(obj.quaternion),
    axisZ: new THREE.Vector3(0, 0, 1).applyQuaternion(obj.quaternion),
    originRadius: obj.position.length(),
  };
}
