// NECROFALL — shared kit for the accessory models (src/customization/HatModels, BackpackModels,
// PetModels). Everything is primitives + flat shading, exactly like the player and the weapons, so
// an accessory always reads as part of the same world. One rule: a builder NEVER shares a geometry
// with another builder — every fit disposes what it built (see AvatarAccessories), and a shared
// geometry would be disposed out from under a second player wearing the same hat.
import * as THREE from 'three';

/** Flat-shaded surface (the game's standard look). Pass an emissive to make it self-lit. */
export function flat(color: number, emissive = 0, emissiveIntensity = 0.55): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    color,
    emissive,
    emissiveIntensity: emissive ? emissiveIntensity : 0,
    flatShading: true,
  });
}

/** Additive light material — eyes, runes, flames. Always transparent. */
export function glow(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

/** Cloth / membrane: visible from both sides (wings, banners, shrouds). */
export function cloth(color: number, emissive = 0): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    color,
    emissive,
    emissiveIntensity: emissive ? 0.35 : 0,
    flatShading: true,
    side: THREE.DoubleSide,
  });
}

export function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

export function cyl(rTop: number, rBot: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 8): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
  m.position.set(x, y, z);
  return m;
}

export function cone(r: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 6): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat);
  m.position.set(x, y, z);
  return m;
}

export function ball(r: number, mat: THREE.Material, x = 0, y = 0, z = 0, ws = 8, hs = 6): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, ws, hs), mat);
  m.position.set(x, y, z);
  return m;
}

export function torus(r: number, tube: number, mat: THREE.Material, seg = 12, tubeSeg = 6): THREE.Mesh {
  return new THREE.Mesh(new THREE.TorusGeometry(r, tube, tubeSeg, seg), mat);
}

/**
 * Flat polygon in the XY plane (extruded a sliver so it is not an infinitely thin sheet).
 *
 * The winding is normalised to CCW first: a mirrored point list (the left wing of a pair is the
 * same list with x negated) reverses the winding, and an ExtrudeGeometry built from a CW contour
 * comes out INSIDE-OUT — the visible faces get back-face culled and half the wing simply vanishes.
 */
export function slab(points: [number, number][], depth: number, mat: THREE.Material): THREE.Mesh {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  const pts = area < 0 ? [...points].reverse() : points;
  const shape = new THREE.Shape();
  pts.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.translate(0, 0, -depth / 2);
  return new THREE.Mesh(geo, mat);
}

export function group(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  for (const c of children) g.add(c);
  return g;
}

/**
 * A drooping articulated chain (tails, tentacles, cloth strips): `count` nested joints hanging
 * DOWN the local −Y axis, tapering from `r0` to `r1`. The returned joints are the rotation handles
 * a `tick` waves — joint i pivots the whole rest of the chain, like a real spine.
 */
export function hangChain(
  count: number,
  segLen: number,
  r0: number,
  r1: number,
  mat: THREE.Material,
  seg = 6
): THREE.Group[] {
  const joints: THREE.Group[] = [];
  let parent: THREE.Object3D = new THREE.Group();
  const root = parent as THREE.Group;
  for (let i = 0; i < count; i++) {
    const joint = new THREE.Group();
    joint.position.y = i === 0 ? 0 : -segLen;
    const a = i / count;
    const b = (i + 1) / count;
    const segMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(r0 + (r1 - r0) * b, r0 + (r1 - r0) * a, segLen, seg),
      mat
    );
    segMesh.position.y = -segLen / 2;
    joint.add(segMesh);
    parent.add(joint);
    joints.push(joint);
    parent = joint;
  }
  return [root, ...joints];
}

/** Deterministic little hash so two instances of the same accessory still pose differently. */
export function varSeed(groupObj: THREE.Object3D): number {
  let n = groupObj.id;
  n = (n * 1103515245 + 12345) & 0x7fffffff;
  return (n % 1000) / 1000;
}
