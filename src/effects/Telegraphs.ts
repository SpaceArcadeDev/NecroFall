// NECROFALL — terrain-conforming danger telegraphs.
//
// A telegraph is a pooled ground decal that says "something is about to hurt you HERE". The one
// thing it must never do is float: NecroFall is played on the inside of a sphere, so a flat
// XY-plane ring laid at the boss's altitude visibly hovers over the ground, cuts through hillsides
// and reads as a bug.
//
// Every vertex is therefore projected onto the planet: an offset from the centre is turned into a
// DIRECTION (walking the great circle, exactly like `AimPreview`), and the vertex is placed at
// `heightAtDir(dir) + LIFT`. The decal is rebuilt only when a telegraph is emitted — a handful of
// times per fight — never per frame, and only its uniforms animate after that.
//
// READABILITY RULES (shared with the player's aiming reticle — `necrotech/AimPreview.ts`):
//  - `depthTest: false` + a high render order, so the decal reads OVER grass blades and terrain it
//    is lying on. Depth-tested, a decal on a grassy slope simply vanished into the blades.
//  - a lift as tall as the reticle's, so the analytic-height decal never sinks under the rendered
//    mesh where the two disagree.
//  - enough radial bands that the fill follows a bumpy contour instead of cutting through it.
import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, varying, vec4 } from 'three/tsl';
import type { Planet } from '../world/Planet';
import { tangentBasis } from '../utils/Utils';

export type TelegraphShape = 'disc' | 'ring' | 'lane';

/** A danger decal never sits exactly on the mesh (z-fighting) but must look attached to it. */
const LIFT = 0.34;
/** Vertex budget per pool slot: a ring decal at 12 bands x 64 segments needs 4608. */
const MAX_VERTS = 4800;
const DISC_RINGS = 12;
const DISC_SEGS = 48;
const RING_SEGS = 64;
const LANE_STEPS = 30;

interface Slot {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicNodeMaterial;
  uniforms: { color: any; progress: any; opacity: any };
  geo: THREE.BufferGeometry;
  pos: Float32Array;
  dist: Float32Array;
  rim: Float32Array;
  /** Seconds of life left. <= 0 means the slot is free. */
  life: number;
  /** Total life (the lead time plus a short after-glow). */
  max: number;
  /** The lead time: how long the fill takes to reach the boundary. */
  lead: number;
  verts: number;
}

/**
 * Pooled, terrain-conforming telegraph decals. The pool is small and fixed: telegraphs are emitted
 * by bosses (a handful per fight), so nothing here ever allocates during gameplay.
 */
export class TelegraphSystem {
  private group = new THREE.Group();
  private slots: Slot[] = [];
  private next = 0;
  private time = 0;
  /** The planet the decals are projected on to. Re-set every match — it is rebuilt per match. */
  private planet: Planet | null = null;

  // Scratches — this module runs on the render path, so it must not allocate.
  private _c = new THREE.Vector3();
  private _f = new THREE.Vector3();
  private _l = new THREE.Vector3();
  private _t1 = new THREE.Vector3();
  private _t2 = new THREE.Vector3();
  private _d = new THREE.Vector3();
  private _p = new THREE.Vector3();
  private _col = new THREE.Color();

  constructor(parent: THREE.Scene, slots = 6) {
    this.group.name = 'telegraphs';
    this.group.renderOrder = 12;
    for (let i = 0; i < slots; i++) this.slots.push(this.makeSlot());
    parent.add(this.group);
  }

  private makeSlot(): Slot {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX_VERTS * 3);
    const dist = new Float32Array(MAX_VERTS);
    const rim = new Float32Array(MAX_VERTS);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
    geo.setAttribute('aRim', new THREE.BufferAttribute(rim, 1));
    geo.setDrawRange(0, 0);
    // The decal already lives in world space, so the mesh never needs a transform.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    // TSL port of the decal shader: same sweep-to-boundary fill and rim highlight.
    const uColor = uniform(new THREE.Color(0xff2d2d));
    const uProgress = uniform(0);
    const uOpacity = uniform(1);
    const vDist = varying(attribute('aDist', 'float')) as any;
    const vRim = varying(attribute('aRim', 'float')) as any;

    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      // The decal must read over grass and across the terrain it lies on — the same call the player's
      // aiming reticle makes. Depth-tested, a warning on a grassy slope was swallowed by the blades,
      // exactly when the player most needed to see where NOT to stand.
      depthTest: false,
      side: THREE.DoubleSide,
    });
    mat.colorNode = Fn(() => {
      const fill = vDist.smoothstep(uProgress.sub(0.08), uProgress).oneMinus();
      const a = fill.mul(0.30).add(vRim.mul(0.40)).add(0.085).mul(uOpacity);
      const col = uColor.mul(fill.mul(0.55).add(vRim.mul(0.45)).add(0.72));
      return vec4(col, a);
    })();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 12;
    mesh.visible = false;
    this.group.add(mesh);
    return { mesh, mat, uniforms: { color: uColor, progress: uProgress, opacity: uOpacity }, geo, pos, dist, rim, life: 0, max: 0, lead: 0, verts: 0 };
  }

  /** The planet is rebuilt every match, so the system is re-pointed at it each time. */
  setPlanet(planet: Planet): void {
    this.planet = planet;
  }

  clear(): void {
    for (const s of this.slots) {
      s.life = 0;
      s.mesh.visible = false;
      s.geo.setDrawRange(0, 0);
    }
  }

  /**
   * Emits one telegraph.
   *
   * `radius` means different things per shape, matching how the damage is resolved:
   *  - disc / ring: the danger radius around `centre`
   *  - lane: the lane's LENGTH along `dir` (with `width` as the half-width)
   */
  emit(
    shape: TelegraphShape,
    centre: THREE.Vector3,
    up: THREE.Vector3,
    dir: THREE.Vector3,
    radius: number,
    width: number,
    dur: number,
    color = 0xff2d2d
  ): void {
    const planet = this.planet;
    if (!planet) return;
    // Grab a free slot if there is one, otherwise recycle the oldest.
    let slot: Slot | null = null;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[(this.next + i) % this.slots.length];
      if (s.life <= 0) {
        slot = s;
        this.next = (this.next + i + 1) % this.slots.length;
        break;
      }
    }
    if (!slot) {
      slot = this.slots[this.next];
      this.next = (this.next + 1) % this.slots.length;
    }

    this.writeVertices(slot, shape, centre, up, dir, radius, width);
    slot.life = dur + 0.18;
    slot.max = slot.life;
    slot.lead = Math.max(0.05, dur);
    slot.uniforms.color.value.setHex(color);
    slot.uniforms.progress.value = 0;
    slot.uniforms.opacity.value = 1;
    slot.geo.attributes.position.needsUpdate = true;
    slot.geo.attributes.aDist.needsUpdate = true;
    slot.geo.attributes.aRim.needsUpdate = true;
    slot.geo.setDrawRange(0, slot.verts);
    slot.mesh.visible = true;
  }

  /** Projects one surface offset (metres) into a world position on the planet. */
  private project(
    planet: Planet,
    c: THREE.Vector3,
    f: THREE.Vector3,
    l: THREE.Vector3,
    along: number,
    lateral: number,
    out: THREE.Vector3
  ): THREE.Vector3 {
    const r = planet.radius;
    const a = along / r;
    // walk the great circle forward, then step sideways along the lateral tangent
    out.copy(c).multiplyScalar(Math.cos(a)).addScaledVector(f, Math.sin(a));
    out.addScaledVector(l, lateral / r).normalize();
    const h = planet.heightAtDir(out.x, out.y, out.z);
    return out.multiplyScalar(h + LIFT);
  }

  private push(slot: Slot, i: number, p: THREE.Vector3, dist: number, rim: number): void {
    const at = i * 3;
    slot.pos[at] = p.x;
    slot.pos[at + 1] = p.y;
    slot.pos[at + 2] = p.z;
    slot.dist[i] = dist;
    slot.rim[i] = rim;
  }

  private writeVertices(
    slot: Slot,
    shape: TelegraphShape,
    centre: THREE.Vector3,
    up: THREE.Vector3,
    dir: THREE.Vector3,
    radius: number,
    width: number
  ): void {
    const planet = this.planet!;
    const c = this._c.copy(centre).normalize();
    const f = this._f;
    const l = this._l;
    // forward tangent: the telegraph's own direction projected on to the surface
    f.copy(dir).addScaledVector(c, -dir.dot(c));
    if (f.lengthSq() < 1e-6) tangentBasis(c, f, l);
    else f.normalize();
    l.copy(c).cross(f).normalize();

    let v = 0;
    if (shape === 'lane') {
      // a rectangle along the great circle, cut into quads so it follows the contour. Vertices are
      // recomputed per triangle rather than cached in clones: an emit is rare, but this module is
      // still on the render path and must not allocate.
      const halfW = Math.max(0.4, width);
      const p = this._p;
      for (let i = 0; i < LANE_STEPS; i++) {
        const s0 = (i / LANE_STEPS) * radius;
        const s1 = ((i + 1) / LANE_STEPS) * radius;
        const d0 = i / LANE_STEPS;
        const d1 = (i + 1) / LANE_STEPS;
        this.push(slot, v++, this.project(planet, c, f, l, s0, -halfW, p), d0, 0);
        this.push(slot, v++, this.project(planet, c, f, l, s0, halfW, p), d0, 0);
        this.push(slot, v++, this.project(planet, c, f, l, s1, halfW, p), d1, 0);
        this.push(slot, v++, this.project(planet, c, f, l, s0, -halfW, p), d0, 0);
        this.push(slot, v++, this.project(planet, c, f, l, s1, halfW, p), d1, 0);
        this.push(slot, v++, this.project(planet, c, f, l, s1, -halfW, p), d1, 0);
      }
      // the far edge carries the "this is where it lands" rim
      for (let i = 0; i < v; i++) if (slot.dist[i] > 0.9) slot.rim[i] = 1;
    } else {
      // disc (filled) and ring (hollow): concentric bands of quads, projected ring by ring
      const inner = shape === 'ring' ? 0.82 : 0;
      const segs = shape === 'ring' ? RING_SEGS : DISC_SEGS;
      const p = this._p;
      for (let ri = 0; ri < DISC_RINGS; ri++) {
        const t0 = inner + (1 - inner) * (ri / DISC_RINGS);
        const t1 = inner + (1 - inner) * ((ri + 1) / DISC_RINGS);
        const r0 = radius * t0;
        const r1 = radius * t1;
        for (let si = 0; si < segs; si++) {
          const a0 = (si / segs) * Math.PI * 2;
          const a1 = ((si + 1) / segs) * Math.PI * 2;
          this.push(slot, v++, this.surfaceAt(planet, c, l, f, r0, a0, p), t0, 0);
          this.push(slot, v++, this.surfaceAt(planet, c, l, f, r1, a0, p), t1, 0);
          this.push(slot, v++, this.surfaceAt(planet, c, l, f, r1, a1, p), t1, 0);
          this.push(slot, v++, this.surfaceAt(planet, c, l, f, r0, a0, p), t0, 0);
          this.push(slot, v++, this.surfaceAt(planet, c, l, f, r1, a1, p), t1, 0);
          this.push(slot, v++, this.surfaceAt(planet, c, l, f, r0, a1, p), t0, 0);
        }
      }
      // rim highlight on the outer band (and on a ring's inner edge, so it reads as a band)
      for (let i = 0; i < v; i++) {
        if (slot.dist[i] > 1 - 1 / DISC_RINGS || (shape === 'ring' && slot.dist[i] < inner + 1e-3)) slot.rim[i] = 1;
      }
    }
    slot.verts = v;
  }

  /** A point at (distance, angle) from the telegraph centre, on the surface. */
  private surfaceAt(
    planet: Planet,
    c: THREE.Vector3,
    l: THREE.Vector3,
    f: THREE.Vector3,
    dist: number,
    angle: number,
    out: THREE.Vector3
  ): THREE.Vector3 {
    const r = planet.radius;
    const a = dist / r;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    out.copy(c).multiplyScalar(cos);
    out.addScaledVector(l, ca * sin);
    out.addScaledVector(f, sa * sin);
    out.normalize();
    const h = planet.heightAtDir(out.x, out.y, out.z);
    return out.multiplyScalar(h + LIFT);
  }

  update(dt: number): void {
    this.time += dt;
    for (const s of this.slots) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.life = 0;
        s.mesh.visible = false;
        continue;
      }
      const elapsed = s.max - s.life;
      s.uniforms.progress.value = Math.min(1, elapsed / s.lead);
      // after the fill completes the decal blinks out
      s.uniforms.opacity.value = s.life > 0.18 ? 1 : Math.max(0, s.life / 0.18);
    }
  }
}
