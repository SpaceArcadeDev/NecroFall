// NECROFALL — MOBA-style aiming markers.
//
// Every Skill / Ultimate carries an `aim` descriptor (see NecrotechData.ts). This module turns it
// into a shape painted ON THE GROUND — a damage lane, a cone fan, an aimed blast circle or a
// point-blank ring — sampled on to the terrain exactly like the auto-attack range ring, so the
// marker always reads as "this is the ground that gets hit".
//
// One dynamic BufferGeometry holds every shape: each frame the active shape emits its triangles
// and the draw range is set to what was written. Fixed scratch vectors only — nothing is
// allocated per frame.
import * as THREE from 'three';
import type { Planet } from '../world/Planet';
import { AbilityAim, resolveAim } from './NecrotechData';
import { clamp, tangentBasis } from '../utils/Utils';

/** Vertices reserved for one frame's shape. */
const MAX_VERTS = 2400;
/** Steps used to subdivide a lane so it follows the terrain. */
const LANE_STEPS = 30;
/** Segments around a circle / fan. */
const SEGS = 64;
/** How far above the terrain the marker floats, so it never z-fights the ground. */
const LIFT = 0.34;

export interface AimRequest {
  aim: AbilityAim;
  /** Ability accent colour. */
  color: number;
  /** 0..1 emphasis — 1 while the player is holding this ability's button. */
  hold: number;
  /** World point the player is looking at (places aimed circles). */
  point: THREE.Vector3;
  /** 1 = just used, 0 = ready. Keeps a cooling ability's marker dim. */
  cdFrac: number;
  /** The caster's current auto-attack range — every `aim` distance is a multiple of it. */
  autoRange: number;
}

export class AimPreview {
  private mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private pos: Float32Array;
  private n = 0;
  /** Eased visibility so the marker never pops. */
  private fade = 0;
  private time = 0;

  // scratch — `_a` (forward) and `_b` (lateral) are READ-ONLY inputs to the emitters; `_o1.._o4`
  // are scratch OUTPUTS and must never be the same vector the emitter is reading from.
  private _a = new THREE.Vector3();
  private _b = new THREE.Vector3();
  private _e = new THREE.Vector3();
  private _f = new THREE.Vector3();
  private _g = new THREE.Vector3();
  private _h = new THREE.Vector3();
  private _i = new THREE.Vector3();
  private _o1 = new THREE.Vector3();
  private _o2 = new THREE.Vector3();
  private _o3 = new THREE.Vector3();
  private _o4 = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_VERTS * 3);
    const attr = new THREE.BufferAttribute(this.pos, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr);
    geo.setDrawRange(0, 0);
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Fades the marker away (nothing is being aimed). */
  hide(dt: number): void {
    this.fade += (0 - this.fade) * clamp(dt * 10, 0, 1);
    if (this.fade < 0.02) {
      this.mesh.visible = false;
      return;
    }
    this.mat.opacity *= this.fade;
  }

  /**
   * Draws the footprint of `req.aim` for a caster standing at `origin` looking along `dir`.
   * `up` is the caster's surface normal; `planet` provides the terrain height.
   */
  show(origin: THREE.Vector3, up: THREE.Vector3, dir: THREE.Vector3, planet: Planet, req: AimRequest, dt: number): void {
    this.fade += (1 - this.fade) * clamp(dt * 12, 0, 1);
    this.time += dt;

    // one resolver for the marker AND the damage, so they can never disagree — and it keeps the
    // whole footprint inside the auto-attack ring.
    const { range, radius, width, halfAngle } = resolveAim(req.aim, req.autoRange);

    // tangent basis: forward + lateral. `lat = up × dir` is the axis that walks a point FORWARD
    // when `up` is rotated around it, which is what every ground point below relies on.
    this._a.copy(dir).addScaledVector(up, -dir.dot(up));
    if (this._a.lengthSq() < 1e-6) this._a.copy(dir);
    this._a.normalize();
    this._b.copy(up).cross(this._a).normalize(); // lateral

    this.n = 0;
    switch (req.aim.kind) {
      case 'line':
      case 'dash':
        this.lane(up, this._b, planet, range, width);
        break;
      case 'cone':
        this.cone(origin, up, this._a, this._b, planet, range, halfAngle);
        break;
      case 'circle': {
        const centre = this.aimCentre(origin, up, this._a, planet, range, req.point);
        this.blastDisc(centre, planet, radius);
        this.blastRim(centre, planet, radius);
        break;
      }
      default: {
        // point blank: the caster's own ring, the same circle the auto-attack uses
        this.blastDisc(origin, planet, radius);
        this.blastRim(origin, planet, radius);
        break;
      }
    }

    const attr = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, this.n);
    this.mesh.visible = this.n > 0;

    // only ever drawn while the ability is being held, so the hold is the baseline look
    const ready = 1 - clamp(req.cdFrac, 0, 1);
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 5.5);
    const hold = clamp(req.hold, 0, 1);
    this.mat.color.setHex(req.color);
    this.mat.opacity = this.fade * hold * (0.17 + ready * 0.2) * (0.88 + pulse * 0.12);
  }

  // ------------------------------------------------------------ shape emitters

  /**
   * The damage lane: a plain filled rectangle, subdivided along its length so it hugs the terrain.
   * Nothing else — no rails, no ticks, no arrow head.
   */
  private lane(up: THREE.Vector3, lat: THREE.Vector3, planet: Planet, range: number, halfWidth: number): void {
    const w = Math.max(0.4, halfWidth);
    const len = Math.max(0.5, range);
    for (let i = 0; i < LANE_STEPS; i++) {
      const f0 = (len * i) / LANE_STEPS;
      const f1 = (len * (i + 1)) / LANE_STEPS;
      this.point(this._o1, planet, up, lat, f0, -w);
      this.point(this._o2, planet, up, lat, f0, w);
      this.point(this._o3, planet, up, lat, f1, w);
      this.point(this._o4, planet, up, lat, f1, -w);
      this.quad(this._o1, this._o2, this._o3, this._o4);
    }
  }

  /** A ground point `forward` metres ahead and `lateral` metres to the side of the caster. */
  private point(
    out: THREE.Vector3,
    planet: Planet,
    up: THREE.Vector3,
    lat: THREE.Vector3,
    forward: number,
    lateral: number
  ): THREE.Vector3 {
    const R = planet.radius;
    out.copy(up).applyAxisAngle(lat, forward / R);
    out.multiplyScalar(R).addScaledVector(lat, lateral).normalize();
    const h = planet.heightAtDir(out.x, out.y, out.z) + LIFT;
    return out.multiplyScalar(h);
  }

  /** Filled fan across ±halfAngle out to `range`, with a bright far rim. */
  private cone(
    origin: THREE.Vector3,
    up: THREE.Vector3,
    dir: THREE.Vector3,
    lat: THREE.Vector3,
    planet: Planet,
    range: number,
    halfAngle: number
  ): void {
    void origin;
    const inner = Math.min(range * 0.14, 1.6);
    for (let i = 0; i < SEGS; i++) {
      const a0 = ((i / SEGS) * 2 - 1) * halfAngle;
      const a1 = (((i + 1) / SEGS) * 2 - 1) * halfAngle;

      // body of the fan: inner arc -> outer arc
      this.fanPoint(this._o1, up, dir, lat, planet, a0, inner);
      this.fanPoint(this._o2, up, dir, lat, planet, a0, range);
      this.fanPoint(this._o3, up, dir, lat, planet, a1, range);
      this.fanPoint(this._o4, up, dir, lat, planet, a1, inner);
      this.quad(this._o1, this._o2, this._o3, this._o4);

      // bright rim band at the far edge
      this.fanPoint(this._o1, up, dir, lat, planet, a0, range * 0.92);
      this.fanPoint(this._o2, up, dir, lat, planet, a0, range);
      this.fanPoint(this._o3, up, dir, lat, planet, a1, range);
      this.fanPoint(this._o4, up, dir, lat, planet, a1, range * 0.92);
      this.quad(this._o1, this._o2, this._o3, this._o4);
    }
  }

  /** A ground point at `angle` / `dist` inside the cone's fan, relative to the caster. */
  private fanPoint(
    out: THREE.Vector3,
    up: THREE.Vector3,
    dir: THREE.Vector3,
    lat: THREE.Vector3,
    planet: Planet,
    angle: number,
    dist: number
  ): THREE.Vector3 {
    out.copy(up).multiplyScalar(planet.radius)
      .addScaledVector(dir, Math.cos(angle) * dist)
      .addScaledVector(lat, Math.sin(angle) * dist)
      .normalize();
    const h = planet.heightAtDir(out.x, out.y, out.z) + LIFT;
    return out.multiplyScalar(h);
  }

  /** Filled blast disc. */
  private blastDisc(centre: THREE.Vector3, planet: Planet, radius: number): void {
    const up = this._g.copy(centre).normalize();
    tangentBasis(up, this._e, this._f);
    const core = this.discPoint(this._h, up, this._e, this._f, planet, 0, 0);
    for (let i = 0; i < SEGS; i++) {
      const a0 = (i / SEGS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGS) * Math.PI * 2;
      this.discPoint(this._o1, up, this._e, this._f, planet, a0, radius);
      this.discPoint(this._o2, up, this._e, this._f, planet, a1, radius);
      this.tri(core, this._o1, this._o2);
    }
  }

  /** Crisp rim on top of a disc. */
  private blastRim(centre: THREE.Vector3, planet: Planet, radius: number): void {
    const up = this._g.copy(centre).normalize();
    tangentBasis(up, this._e, this._f);
    const band = Math.max(0.16, radius * 0.055);
    for (let i = 0; i < SEGS; i++) {
      const a0 = (i / SEGS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGS) * Math.PI * 2;
      this.discPoint(this._o1, up, this._e, this._f, planet, a0, radius - band);
      this.discPoint(this._o2, up, this._e, this._f, planet, a0, radius + band);
      this.discPoint(this._o3, up, this._e, this._f, planet, a1, radius + band);
      this.discPoint(this._o4, up, this._e, this._f, planet, a1, radius - band);
      this.quad(this._o1, this._o2, this._o3, this._o4);
    }
  }

  /** A ground point on a circle of `r` metres around `up`, at `angle`. */
  private discPoint(
    out: THREE.Vector3,
    up: THREE.Vector3,
    t1: THREE.Vector3,
    t2: THREE.Vector3,
    planet: Planet,
    angle: number,
    r: number
  ): THREE.Vector3 {
    out.copy(up).multiplyScalar(planet.radius)
      .addScaledVector(t1, Math.cos(angle) * r)
      .addScaledVector(t2, Math.sin(angle) * r)
      .normalize();
    const h = planet.heightAtDir(out.x, out.y, out.z) + LIFT;
    return out.multiplyScalar(h);
  }

  /**
   * Where an aimed blast lands: the looked-at ground point when it is inside range, otherwise the
   * point exactly `range` metres down the aim direction.
   */
  /**
   * Where an aimed blast lands: the point `min(lookDistance, range)` metres down the aim, exactly
   * as AbilitySystem.landing computes it.
   */
  private aimCentre(
    origin: THREE.Vector3,
    up: THREE.Vector3,
    dir: THREE.Vector3,
    planet: Planet,
    range: number,
    look: THREE.Vector3
  ): THREE.Vector3 {
    const toLook = this._o3.copy(look).sub(origin);
    toLook.addScaledVector(up, -toLook.dot(up));
    const dist = toLook.length();
    const use = dist > 1.5 ? Math.min(dist, range) : range;
    const out = this._i;
    out.copy(up).applyAxisAngle(this._o2.copy(up).cross(dir).normalize(), use / planet.radius).normalize();
    const h = planet.heightAtDir(out.x, out.y, out.z) + LIFT;
    return out.multiplyScalar(h);
  }

  // ------------------------------------------------------------ primitives

  private push(p: THREE.Vector3): void {
    if (this.n >= MAX_VERTS) return;
    const i = this.n * 3;
    this.pos[i] = p.x;
    this.pos[i + 1] = p.y;
    this.pos[i + 2] = p.z;
    this.n++;
  }

  /** Quad a->b->c->d as two triangles (winding is irrelevant: the material is double sided). */
  private quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void {
    if (this.n + 6 > MAX_VERTS) return;
    this.push(a); this.push(b); this.push(c);
    this.push(a); this.push(c); this.push(d);
  }

  private tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
    if (this.n + 3 > MAX_VERTS) return;
    this.push(a); this.push(b); this.push(c);
  }
}
