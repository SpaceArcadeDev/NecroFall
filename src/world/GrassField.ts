// NECROFALL — static stylized grass field.
//
// Grass is generated ONCE, when the planet is built for the match, and never moves again — no
// follow-the-player window, so nothing can pop in or out while you walk around. Density is bought
// where it matters: the field is grown as thick clumps around the tower zones (where fights
// actually happen) on top of the thin planet-wide scatter in `Planet.buildDecorations`.
//
// Techniques inspired by Christian Ortiz's MIT-licensed `cortiz2894/stylized-components` GrassField
// (clumped instancing, per-blade variation, a shared wind); this is an original implementation.
//
// Contour accuracy: each clump takes one surface sample for its validity checks, two probe samples
// that give the *local terrain normal*, and then each blade projects its own tangent offset onto the
// sphere and re-samples the height — so blades sit exactly on the ground and lean with the hillside
// instead of hovering over it.
import * as THREE from 'three';
import { Rand } from '../utils/Utils';
import { dirtAmount } from './Vegetation';

const _upY = new THREE.Vector3(0, 1, 0);
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _b1 = new THREE.Vector3();
const _b2 = new THREE.Vector3();
const _zoneDir = new THREE.Vector3();
const _clump = new THREE.Vector3();
const _blade = new THREE.Vector3();
const _probeA = new THREE.Vector3();
const _probeB = new THREE.Vector3();
const _pointA = new THREE.Vector3();
const _pointB = new THREE.Vector3();
const _base = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _edgeB = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _e = new THREE.Euler();
const _qAlign = new THREE.Quaternion();
const _qLean = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Blade geometry height, so the sway shader can normalise root (0) → tip (1). */
const BLADE_H = 0.85;
/** Blades per clump. */
const CLUMP = 6;
/** Distance used for the two normal probes, in world units. */
const PROBE = 1.1;

interface FieldPlanet {
  heightAtDir(x: number, y: number, z: number): number;
  slopeAt(p: THREE.Vector3): number;
  readonly radius: number;
}

export interface GrassFieldOpts {
  seed: number;
  /** Patch centres as surface points (tower bases, battlefield centre). */
  zones: THREE.Vector3[];
  /** Blades grown per zone. */
  bladesPerZone: number;
  /** Patch radius in world units. */
  radius: number;
}

export interface GrassField {
  mesh: THREE.InstancedMesh;
  blades: number;
  dispose(): void;
}

/**
 * Builds one instanced mesh holding every zone's grass. Blades stand on the local surface normal
 * (so they follow the contour of the land) and lean a little in a hashed direction.
 */
export function buildGrassField(
  planet: FieldPlanet,
  material: THREE.ShaderMaterial,
  geometry: THREE.BufferGeometry,
  opts: GrassFieldOpts
): GrassField {
  const capacity = Math.max(1, opts.zones.length * Math.max(1, opts.bladesPerZone));
  const geo = geometry.clone();
  const tint = makeAttr(capacity);
  const height = makeAttr(capacity);
  const trample = makeAttr(capacity);
  const phase = makeAttr(capacity);
  geo.setAttribute('aTint', tint);
  geo.setAttribute('aHeight', height);
  geo.setAttribute('aTrample', trample);
  geo.setAttribute('aPhase', phase);

  const mesh = new THREE.InstancedMesh(geo, material, capacity);
  // Frustum-culled with the bounds three derives from the live instances (the field is static, so
  // they stay valid for the mesh's whole life) — looking away skips the whole ~10k-blade draw
  // instead of vertex-shading every blade off screen.
  mesh.frustumCulled = true;
  mesh.name = 'grass-field';

  const R = planet.radius;
  const clumps = Math.max(1, Math.ceil(opts.bladesPerZone / CLUMP));
  let slot = 0;

  for (let z = 0; z < opts.zones.length && slot < capacity; z++) {
    _zoneDir.copy(opts.zones[z]).normalize();
    tangentBasisLocal(_zoneDir, _t1, _t2);
    // Deterministic per zone, so the same patch of ground always grows the same grass.
    const rng = new Rand(hash2(opts.seed, z + 1, 7919));

    for (let c = 0; c < clumps && slot < capacity; c++) {
      // Clump centre: even-area sample of the disc around the zone.
      const r = Math.sqrt(rng.range(0, 1)) * opts.radius;
      const a = rng.range(0, Math.PI * 2);
      _clump.copy(_zoneDir).multiplyScalar(R)
        .addScaledVector(_t1, Math.cos(a) * r)
        .addScaledVector(_t2, Math.sin(a) * r)
        .normalize();
      const h0 = planet.heightAtDir(_clump.x, _clump.y, _clump.z);
      _base.copy(_clump).multiplyScalar(h0);
      if (planet.slopeAt(_base) > 1.15) continue;                        // cliffs hold no grass
      const dirt = dirtAmount(_base.x, _base.z);
      if (dirt > 0.55 && rng.chance(Math.min(0.9, (dirt - 0.55) * 1.8))) continue;   // bare earth

      // Local surface normal from two probe points on the clump's own tangent plane. Blades then
      // stand perpendicular to the ground they are actually on, not to the zone they belong to.
      tangentBasisLocal(_clump, _b1, _b2);
      _probeA.copy(_clump).multiplyScalar(R).addScaledVector(_b1, PROBE).normalize();
      _probeB.copy(_clump).multiplyScalar(R).addScaledVector(_b2, PROBE).normalize();
      _pointA.copy(_probeA).multiplyScalar(planet.heightAtDir(_probeA.x, _probeA.y, _probeA.z));
      _pointB.copy(_probeB).multiplyScalar(planet.heightAtDir(_probeB.x, _probeB.y, _probeB.z));
      _normal.copy(_pointA).sub(_base).cross(_edgeB.copy(_pointB).sub(_base)).normalize();
      if (_normal.dot(_clump) < 0) _normal.negate();
      _qAlign.setFromUnitVectors(_upY, _normal);

      const clumpTint = rng.range(0.82, 1.22);
      const clumpH = rng.range(0.78, 1.18);

      for (let k = 0; k < CLUMP && slot < capacity; k++) {
        const ba = rng.range(0, Math.PI * 2);
        const br = Math.sqrt(rng.range(0, 1)) * 0.9;
        const s = rng.range(0.72, 1.05) * clumpH;
        // Project this blade's own tangent offset onto the sphere and re-sample the height, so it
        // lands exactly on the terrain rather than on a plane left over from the zone centre.
        _blade.copy(_clump).multiplyScalar(R)
          .addScaledVector(_b1, Math.cos(ba) * br)
          .addScaledVector(_b2, Math.sin(ba) * br)
          .normalize();
        const hb = planet.heightAtDir(_blade.x, _blade.y, _blade.z);
        _pos.copy(_blade).multiplyScalar(hb).addScaledVector(_blade, 0.04);
        // Lean + yaw in the blade's own frame, on top of the ground normal.
        _e.set(rng.range(-0.2, 0.2), rng.range(0, Math.PI * 2), rng.range(-0.2, 0.2), 'YXZ');
        _qLean.setFromEuler(_e);
        _q.copy(_qAlign).multiply(_qLean);
        _scale.set(s * rng.range(0.85, 1.15), s, s * rng.range(0.85, 1.15));
        _m.compose(_pos, _q, _scale);
        mesh.setMatrixAt(slot, _m);
        tint.setX(slot, clumpTint * rng.range(0.92, 1.08));
        height.setX(slot, BLADE_H * s);
        trample.setX(slot, dirt * 0.9);
        phase.setX(slot, rng.range(0, Math.PI * 2));
        slot++;
      }
    }
  }

  mesh.count = slot;
  mesh.instanceMatrix.needsUpdate = true;
  tint.needsUpdate = true;
  height.needsUpdate = true;
  trample.needsUpdate = true;
  phase.needsUpdate = true;

  return {
    mesh,
    blades: slot,
    dispose(): void {
      geo.dispose();
      mesh.removeFromParent();
    },
  };
}

function makeAttr(count: number): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(new Float32Array(count), 1, false);
}

function tangentBasisLocal(up: THREE.Vector3, t1: THREE.Vector3, t2: THREE.Vector3): void {
  const ax = Math.abs(up.x) < 0.9 ? 1 : 0;
  t1.set(ax, ax === 1 ? 0 : 1, 0).cross(up).normalize();
  t2.copy(up).cross(t1).normalize();
}

function hash2(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
