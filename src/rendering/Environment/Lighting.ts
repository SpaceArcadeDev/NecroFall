/**
 * NECROFALL — lighting (folio `Ligthing.js` port, plan §33/§34).
 *
 * ONE shadow-casting directional sun whose shadow box follows the local player
 * area (texel-snapped so the shadow edges never shimmer), plus the uniform
 * family every MeshDefaultMaterial shades with. Radioactive glow comes from
 * emissive materials + bloom — never from dozens of point lights.
 */
import * as THREE from 'three/webgpu';
import { color, uniform } from 'three/tsl';
import type { Quality } from '../Quality';
import type { LightingGlobals } from '../WorldGlobals';

export interface LightingOptions {
  /** Shadow follow window (metres around the focus point). */
  shadowAmplitude?: number;
  distance?: number;
}

export class Lighting implements LightingGlobals {
  readonly colorUniform = uniform(color('#fff8ec'));
  readonly intensityUniform = uniform(2.35);
  readonly directionUniform: any;
  readonly coreShadowEdgeLow = uniform(-0.2);
  readonly coreShadowEdgeHigh = uniform(1);
  readonly shadowColor = uniform(color('#3d2f63')); // folio's coloured shadow family
  readonly lightBounceEdgeLow = uniform(-0.9);
  readonly lightBounceEdgeHigh = uniform(0.35);
  readonly lightBounceDistance = uniform(2.4);
  readonly lightBounceMultiplier = uniform(0.55);
  readonly bounceColor = uniform(color('#2f6b4f'));

  readonly sunDirection = new THREE.Vector3();

  private readonly light: THREE.DirectionalLight;
  private readonly shadowAmplitude: number;
  private readonly distance: number;
  private mapSize: number;
  private readonly focus = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly snapped = new THREE.Vector3();
  private readonly stable = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    quality: Quality,
    radius: number,
    options: LightingOptions = {},
  ) {
    this.shadowAmplitude = options.shadowAmplitude ?? 46;
    this.distance = options.distance ?? radius + 90;
    this.mapSize = quality.shadowMapSize();

    // Sun high over the spawn horizon — one fixed, controlled key light.
    this.sunDirection.set(0.42, 0.72, 0.32).normalize().multiplyScalar(this.distance);
    this.directionUniform = uniform(new THREE.Vector3(this.sunDirection.x, this.sunDirection.y, this.sunDirection.z).normalize());

    this.light = new THREE.DirectionalLight(0xffffff, 5);
    this.light.castShadow = true;
    this.applyShadowSettings();
    this.scene.add(this.light);
    this.scene.add(this.light.target);
  }

  private applyShadowSettings(): void {
    const shadow = this.light.shadow;
    shadow.mapSize.set(this.mapSize, this.mapSize);
    shadow.camera.left = -this.shadowAmplitude;
    shadow.camera.right = this.shadowAmplitude;
    shadow.camera.top = this.shadowAmplitude;
    shadow.camera.bottom = -this.shadowAmplitude;
    shadow.camera.near = 1;
    shadow.camera.far = this.distance + this.shadowAmplitude * 3;
    shadow.bias = -0.0004;
    shadow.normalBias = 0.06;
    shadow.radius = 2;
    shadow.camera.updateProjectionMatrix();
  }

  setQuality(quality: Quality): void {
    this.mapSize = quality.shadowMapSize();
    this.applyShadowSettings();
  }

  /** Debug switch: `?shadows=0` turns the sun's shadow casting off. */
  setShadowsEnabled(enabled: boolean): void {
    this.light.castShadow = enabled;
  }

  /** Follow the gameplay focus; snap to the shadow texel grid (no shimmer). */
  update(focus: THREE.Vector3): void {
    const texel = (this.shadowAmplitude * 2) / this.mapSize;

    const direction = new THREE.Vector3(
      this.directionUniform.value.x,
      this.directionUniform.value.y,
      this.directionUniform.value.z,
    );
    // stable light basis
    this.stable.set(0, 1, 0);
    if (Math.abs(direction.dot(this.stable)) > 0.95) this.stable.set(1, 0, 0);
    this.right.crossVectors(direction, this.stable).normalize();
    this.up.crossVectors(this.right, direction).normalize();

    this.snapped.copy(focus);
    const alongRight = Math.round(this.snapped.dot(this.right) / texel) * texel;
    const alongUp = Math.round(this.snapped.dot(this.up) / texel) * texel;
    this.snapped.addScaledVector(this.right, alongRight - this.snapped.dot(this.right));
    this.snapped.addScaledVector(this.up, alongUp - this.snapped.dot(this.up));

    this.light.position.copy(this.snapped).addScaledVector(direction, this.distance);
    this.light.target.position.copy(this.snapped);
    this.light.target.updateMatrixWorld();
    this.focus.copy(this.snapped);
  }

  /** Slow radioactive pulse for the emission families (plan §62). */
  static pulse(time: any, speed = 1.4) {
    return time.mul(speed).sin().mul(0.5).add(0.5);
  }
}
