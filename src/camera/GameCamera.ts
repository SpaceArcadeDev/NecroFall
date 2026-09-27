// NECROFALL — FIXED-ANGLE surface camera.
// The rig keeps a constant heading and a constant pitch: nothing the player does
// (moving, dashing, fighting, moving the mouse) rotates the camera. The heading is
// carried across the planet surface with parallel transport so the view stays stable
// no matter where on the sphere you run.
import * as THREE from 'three';
import type { Planet } from '../world/Planet';
import { CONFIG } from '../core/Config';
import { clamp, tangentBasis } from '../utils/Utils';

/** Anything the camera can follow: the local player or a menu/spectator rig. */
export interface CameraTarget {
  position: THREE.Vector3;
  up: THREE.Vector3;
  velocity: THREE.Vector3;
  alive: boolean;
  frozen: boolean;
}

const _vd = new THREE.Vector3();
const _focus = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _v2 = new THREE.Vector2();

export class GameCamera {
  camera: THREE.PerspectiveCamera;
  /** Fixed heading of the rig, always kept inside the target's tangent plane. */
  forward = new THREE.Vector3(0, 0, 1);
  private smoothUp = new THREE.Vector3(0, 1, 0);
  private pos = new THREE.Vector3();
  private initialized = false;
  /** Fixed, high-angle rig geometry — the camera angle never changes during play. */
  distance = CONFIG.camera.distance;
  height = CONFIG.camera.height;
  /** Wheel zoom multiplier (see zoomBy). */
  zoom = 1;
  private raycaster = new THREE.Raycaster();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(68, aspect, 0.1, 2200);
  }

  /** Mouse-wheel zoom: steps of ±1 (clamped). */
  zoomBy(steps: number): void {
    if (steps === 0) return;
    const factor = 1 + steps * CONFIG.camera.zoomStep;
    this.zoom = clamp(this.zoom * factor, CONFIG.camera.zoomMin, CONFIG.camera.zoomMax);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  snap(): void {
    this.initialized = false;
  }

  /** Aims the rig along a world direction (used on spawn so you face the tower cluster). */
  faceTowards(dir: THREE.Vector3): void {
    this.forward.copy(dir);
    this.initialized = true;
  }

  update(dt: number, player: CameraTarget, planet: Planet, shake: number): void {
    const up = player.up;

    // 1. carry the fixed heading onto the new tangent plane (parallel transport).
    this.forward.addScaledVector(up, -this.forward.dot(up));
    if (this.forward.lengthSq() < 1e-6) tangentBasis(up, this.forward, _vd);
    this.forward.normalize();

    // 2. stable up vector: absorbs terrain facets, never drifts or spins.
    this.smoothUp.lerp(up, 1 - Math.exp(-26 * dt));
    if (this.smoothUp.dot(up) < 0.5) this.smoothUp.copy(up);
    this.smoothUp.normalize();

    // 3. fixed high-angle rig: constant pitch, zoom scales distance and height together.
    _focus.copy(player.position).addScaledVector(up, 1.45);
    _desired
      .copy(_focus)
      .addScaledVector(this.forward, -this.distance * this.zoom)
      .addScaledVector(this.smoothUp, this.height * this.zoom);

    const minLen = planet.heightAt(_desired) + 2.6;
    const len = _desired.length();
    if (len < minLen) _desired.multiplyScalar(minLen / Math.max(len, 0.01));

    if (!this.initialized) {
      this.pos.copy(_desired);
      this.initialized = true;
    } else {
      this.pos.lerp(_desired, 1 - Math.exp(-24 * dt));
    }

    this.camera.position.copy(this.pos);
    if (shake > 0.001) {
      const s = Math.min(shake, 0.9);
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
    }
    this.camera.up.copy(this.smoothUp);
    this.camera.lookAt(_focus);
  }

  /** Camera-relative movement basis in the given tangent plane (outR = right, outF = forward). */
  moveBasis(up: THREE.Vector3, outF: THREE.Vector3, outR: THREE.Vector3): void {
    outF.copy(this.forward).addScaledVector(up, -this.forward.dot(up));
    if (outF.lengthSq() < 1e-6) {
      outF.set(0, 1, 0);
      tangentBasis(up, outF, _vd);
    }
    outF.normalize();
    outR.crossVectors(outF, up).normalize();
  }

  rayFromScreen(nx: number, ny: number): THREE.Ray {
    this.raycaster.setFromCamera(_v2.set(nx, ny), this.camera);
    return this.raycaster.ray;
  }
}
