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
import { ART_DIRECTION } from '../ArtDirection';
import { daylightAt, twilightAt, TWILIGHT_COLOR } from './Daylight';

export interface LightingOptions {
  /** Shadow follow window (metres around the focus point). */
  shadowAmplitude?: number;
  distance?: number;
  /**
   * Classic-material fill (hemisphere + rim). The non-TSL gameplay materials (player rig, towers,
   * bases, pads …) still read REAL scene lights, so the ONE lighting owner provides them — instead
   * of the game adding its own lights next to this rig (plan §4: no duplicate environment
   * lighting). Folio/TSL materials shade through the uniforms above and ignore scene lights.
   */
  classicFill?: {
    skyColor: number;
    groundColor: number;
    intensity: number;
    rimColor: number;
    rimIntensity: number;
  };
}

export class Lighting implements LightingGlobals {
  colorUniform = uniform(color('#fff8ec'));
  intensityUniform = uniform(ART_DIRECTION.lighting.sunIntensity);
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
  readonly daylightColor = new THREE.Color('#fff8ec');
  private readonly sunColor = new THREE.Color('#fff8ec');
  private readonly sunsetColor = new THREE.Color(TWILIGHT_COLOR);
  private readonly fillColor = new THREE.Color();

  private readonly light: THREE.DirectionalLight;
  private readonly shadowAmplitude: number;
  private readonly distance: number;
  private mapSize: number;
  private readonly fill: THREE.HemisphereLight | null = null;
  private readonly rim: THREE.DirectionalLight | null = null;
  private readonly fillIntensity: number;
  private readonly rimIntensity: number;
  private readonly focus = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly snapped = new THREE.Vector3();
  private readonly stable = new THREE.Vector3();
  private readonly scratchDirection = new THREE.Vector3();

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

    // Classic-material fill — OWNED by this rig (plan §4). Off by default: the dev world (no
    // legacy materials) runs purely on the folio uniforms.
    const fill = options.classicFill;
    this.fillIntensity = fill?.intensity ?? 0;
    this.rimIntensity = fill?.rimIntensity ?? 0;
    if (fill) {
      this.fillColor.set(fill.skyColor);
      this.fill = new THREE.HemisphereLight(fill.skyColor, fill.groundColor, fill.intensity);
      this.scene.add(this.fill);
      this.rim = new THREE.DirectionalLight(fill.rimColor, fill.rimIntensity);
      this.rim.position.set(-1, 0.2, -0.8).multiplyScalar(this.distance);
      this.scene.add(this.rim);
    }
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

  setSunDirection(direction: THREE.Vector3, tint = '#fff8ec'): void {
    this.sunDirection.copy(direction).normalize().multiplyScalar(this.distance);
    (this.directionUniform.value as THREE.Vector3).copy(direction).normalize();
    (this.colorUniform.value as THREE.Color).set(tint);
    this.light.color.set(tint);
    this.sunColor.set(tint);
    this.daylightColor.copy(this.sunColor);
    this.intensityUniform.value = 1.1;
    (this.shadowColor.value as THREE.Color).set('#172133');
  }

  setSurfacePalette(ground: string, horizon: string): void {
    this.fillColor.set(horizon);
    if (this.fill) { this.fill.color.set(horizon); this.fill.groundColor.set(ground).multiplyScalar(0.5); }
    (this.shadowColor.value as THREE.Color).set(horizon).lerp(new THREE.Color(ground), 0.6).multiplyScalar(0.16).add(new THREE.Color(0.015, 0.018, 0.025));
  }

  /** Debug switch: `?shadows=0` turns the sun's shadow casting off. */
  setShadowsEnabled(enabled: boolean): void {
    this.light.castShadow = enabled;
  }

  /** Debug switch: `?fill=0` turns the classic-material fill off (diagnostics only). */
  setFillEnabled(enabled: boolean): void {
    if (this.fill) this.fill.intensity = enabled ? this.fillIntensity : 0;
    if (this.rim) this.rim.intensity = enabled ? this.rimIntensity : 0;
  }

  /** `?renderBaseline=1` dump. */
  get baseline(): { sunDirection: number[]; sunIntensity: number; shadowMapSize: number; shadowAmplitude: number } {
    const d = this.directionUniform.value as THREE.Vector3;
    return {
      sunDirection: [d.x, d.y, d.z],
      sunIntensity: this.intensityUniform.value as number,
      shadowMapSize: this.mapSize,
      shadowAmplitude: this.shadowAmplitude,
    };
  }

  /** Follow the gameplay focus; snap to the shadow texel grid (no shimmer). */
  update(focus: THREE.Vector3): void {
    const texel = (this.shadowAmplitude * 2) / this.mapSize;

    const direction = this.scratchDirection.copy(this.directionUniform.value as THREE.Vector3);
    const elevation = focus.dot(direction) / Math.max(0.001, focus.length());
    const day = daylightAt(elevation), twilight = twilightAt(elevation);
    this.daylightColor.copy(this.sunColor).lerp(this.sunsetColor, twilight * 0.9);
    (this.colorUniform.value as THREE.Color).copy(this.daylightColor);
    this.light.color.copy(this.daylightColor);
    this.light.intensity = 4.2 * THREE.MathUtils.smoothstep(elevation, -0.1, 0.48);
    if (this.fill) {
      this.fill.intensity = this.fillIntensity * (0.035 + day * 0.22);
      this.fill.color.copy(this.fillColor).lerp(this.sunsetColor, twilight * 0.55);
    }
    if (this.rim) this.rim.intensity = this.rimIntensity * (0.025 + day * 0.055);
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
