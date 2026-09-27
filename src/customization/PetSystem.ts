// NECROFALL — the pet follower. A pet does exactly one thing: it moves around its owner, inside a
// fixed leash, independently. No attacks, no pickups, no targeting — cosmetics only.
//
// Motion: the pet picks a random point on a ring around the owner (between roamMin and roamMax
// surface metres), steers toward it with capped acceleration, lingers, then picks another. If the
// owner runs away, the leash overrides everything: the pet sprints straight back to a point beside
// them. Height is not steered but POSITION-CLAMPED: after integration the pet is placed at its
// hover height above the terrain radius under it, so it follows hills, decks and the menu floor
// without raycasts or gravity.
import * as THREE from 'three';
import { AccessoryBuild, PetMotion } from './AccessoryTypes';
import { orientToSurface, rotateTowards, tangentBasis } from '../utils/Utils';

const TAU = Math.PI * 2;
const _steer = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _up = new THREE.Vector3();

export class PetController {
  readonly group: THREE.Group;
  private build: AccessoryBuild;
  private motion: PetMotion;
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private target = new THREE.Vector3();
  private facing = new THREE.Vector3(0, 0, 1);
  private lingerT = 0;
  private age = 0;
  private spawned = false;
  private bobPhase = Math.random() * TAU;

  constructor(build: AccessoryBuild, motion: PetMotion) {
    this.build = build;
    this.motion = motion;
    this.group = build.group;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** Drops the pet beside its owner (fresh spawn / respawn / accessory swap). */
  reset(anchor: THREE.Vector3, up: THREE.Vector3, terrainRadius: ((p: THREE.Vector3) => number) | null = null): void {
    tangentBasis(up, _t1, _t2);
    this.pos.copy(anchor).addScaledVector(_t1, 1.4).addScaledVector(_t2, 0.6);
    this.vel.set(0, 0, 0);
    this.facing.copy(_t1);
    this.lingerT = 0.2;
    this.spawned = true;
    this.place(this.pos, anchor, up, this.motion.hover, terrainRadius, 0, 0);
  }

  /**
   * `terrainRadius` maps a world point to the terrain radius under it (planet.heightAt); pass null
   * on flat ground (the menu preview) where the pet is simply anchored to the owner's plane.
   */
  update(
    dt: number,
    anchor: THREE.Vector3,
    up: THREE.Vector3,
    t: number,
    terrainRadius: ((p: THREE.Vector3) => number) | null
  ): void {
    if (!this.spawned) this.reset(anchor, up, terrainRadius);
    this.age += dt;
    const m = this.motion;

    tangentBasis(up, _t1, _t2);
    const dist = this.pos.distanceTo(anchor);
    this.lingerT -= dt;
    // A new wander point: on arrival, on boredom, or… when left behind (see the leash below).
    if (this.lingerT <= 0 || this.pos.distanceToSquared(this.target) < 0.12) {
      const a = Math.random() * TAU;
      const r = m.roamMin + Math.random() * (m.roamMax - m.roamMin);
      this.target
        .copy(anchor)
        .addScaledVector(_t1, Math.cos(a) * r)
        .addScaledVector(_t2, Math.sin(a) * r);
      this.lingerT = m.lingerMin + Math.random() * (m.lingerMax - m.lingerMin);
    }
    // The leash: never more than LEASH metres away, whatever the wander target said.
    const far = dist > LEASH;
    // …and the sprint must be able to BEAT a running player, or the pet trails the fight forever:
    // a flat 1.65× cruise was slower than a normal run, so standing in the ring and sprinting here
    // are very different caps.
    const speedCap = far ? m.speed * 4.5 : m.speed;
    if (far) {
      this.target.copy(anchor).addScaledVector(_t1, 1.2);
      this.lingerT = Math.min(this.lingerT, 0.4);
    }
    // Left properly behind (a dash, a leap, a Blitz) the pet does not teleport-sprint — it blinks
    // back beside its owner. It is a cosmetic follower; making the player wait for it is worse.
    if (dist > SNAP_DIST) {
      this.pos.copy(anchor).addScaledVector(_t1, 1.3).addScaledVector(_t2, 0.4);
      this.vel.set(0, 0, 0);
    }

    // Steer horizontally (the vertical is handled by the clamp below).
    _steer.subVectors(this.target, this.pos);
    _steer.addScaledVector(up, -_steer.dot(up));
    // while chasing there is no "close enough to ease off": full throttle, plus a kick
    const align = far ? 1 : Math.max(0, 1 - _steer.length() / 4);
    _steer.normalize().multiplyScalar(m.accel * (far ? 2.2 : 0.35 + 0.65 * align) * dt);
    this.vel.addScaledVector(_steer, 1);
    // damping + a speed cap, so the pet never rockets off when the owner is near
    const damp = Math.max(0, 1 - (far ? 0.6 : 3.2) * dt);
    this.vel.multiplyScalar(damp);
    const vLen = this.vel.length();
    if (vLen > speedCap) this.vel.multiplyScalar(speedCap / vLen);

    this.pos.addScaledVector(this.vel, dt);

    // Height clamp: hover above whatever radius is under the pet, plus the bob.
    const bob = m.hop
      ? Math.abs(Math.sin(this.age * m.bobRate + this.bobPhase)) * m.bob
      : Math.sin(this.age * m.bobRate + this.bobPhase) * m.bob;
    this.place(this.pos, anchor, up, m.hover + bob, terrainRadius, dt, t);
  }

  /** Orientation + the height clamp. Also fades the facing toward the direction of travel. */
  private place(
    pos: THREE.Vector3,
    anchor: THREE.Vector3,
    up: THREE.Vector3,
    height: number,
    terrainRadius?: ((p: THREE.Vector3) => number) | null,
    dt = 0,
    t = 0
  ): void {
    if (terrainRadius) {
      // Planet: the pet is rescaled along its own radial direction. The height comes from the
      // HIGHER of the terrain under it and the owner's own radius, so on a fortress deck (which
      // floats far over the terrain) it stays on the deck with its owner.
      const ground = terrainRadius(pos);
      const r = Math.max(ground, anchor.length());
      const len = pos.length();
      if (len > 1e-4) pos.multiplyScalar((r + height) / len);
      else pos.copy(anchor).addScaledVector(up, r + height);
      _up.copy(pos);
      if (_up.lengthSq() < 1e-6) _up.copy(up);
      else _up.normalize();
    } else {
      // Flat ground (menu): keep the tangential offset from the owner and sit `height` above the plane.
      _steer.subVectors(pos, anchor);
      _steer.addScaledVector(up, -_steer.dot(up));
      pos.copy(anchor).addScaledVector(_steer, 1).addScaledVector(up, height);
      _up.copy(up).normalize();
    }

    _dir.copy(this.vel);
    _dir.addScaledVector(_up, -_dir.dot(_up));
    if (_dir.lengthSq() > 0.04) {
      _dir.normalize();
      rotateTowards(this.facing, _dir, _up, dt * 7);
    }
    orientToSurface(this.group, pos, _up, this.facing);
    if (this.motion.spin) this.group.rotateY(this.motion.spin * t);
    this.build.tick?.(t, dt);
  }

  dispose(): void {
    this.build.dispose?.();
  }
}

/** How far a pet may ever be from its owner (surface metres). */
export const LEASH = 4.5;
/** Beyond this the pet gives up running and blinks back beside its owner (dashes, Blitz, long falls). */
export const SNAP_DIST = 20;
