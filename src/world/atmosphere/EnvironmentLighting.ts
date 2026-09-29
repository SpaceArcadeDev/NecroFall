// NECROFALL — ENVIRONMENT LIGHTING (rework plan §32/§33/§49/§50).
//
// One main directional sun + hemisphere ambient is the whole budget (plan §32: "avoid dozens of
// realtime lights"). This system owns:
//
//   * the SHADOW configuration for the main light (plan §49): one map, modest resolution by
//     profile, camera-relative coverage that FOLLOWS the local player so the limited shadow
//     distance always surrounds the action;
//   * the weather/day MOOD (plan §33): dusty warm sun, cold storm light, toxic glow at night —
//     driven by WeatherSystem, applied through light intensity + tint;
//   * a beacon/emissive hint pool: effects that want "the world glows here" get a cheap emissive
//     boost instead of spawning a real light (plan §32).
import * as THREE from 'three';
import type { EnvironmentProfile } from '../EnvironmentConfig';

export interface LightMood {
  /** Multiplier on sun intensity (1 = archetype base). */
  sunIntensity: number;
  /** Multiplier on hemisphere/ambient. */
  ambientIntensity: number;
  /** Tint applied ON TOP of the base light colours (lerp target). */
  sunTint: THREE.Color;
  ambientTint: THREE.Color;
}

const _sunPos = new THREE.Vector3();
const _focus = new THREE.Vector3();

export class EnvironmentLighting {
  private readonly baseSunColor: THREE.Color;
  private readonly baseHemiSky: THREE.Color;
  private readonly baseHemiGround: THREE.Color;
  private readonly baseSunIntensity: number;
  private readonly baseHemiIntensity: number;
  private mood: LightMood = {
    sunIntensity: 1,
    ambientIntensity: 1,
    sunTint: new THREE.Color(0xffffff),
    ambientTint: new THREE.Color(0xffffff),
  };
  private currentSun = 1;
  private currentAmbient = 1;
  private flash = 0;
  private readonly shadowRadius: number;

  constructor(
    private readonly sun: THREE.DirectionalLight,
    private readonly hemi: THREE.HemisphereLight,
    private readonly rim: THREE.DirectionalLight,
    profile: EnvironmentProfile
  ) {
    this.baseSunColor = sun.color.clone();
    this.baseHemiSky = hemi.color.clone();
    this.baseHemiGround = hemi.groundColor.clone();
    this.baseSunIntensity = sun.intensity;
    this.baseHemiIntensity = hemi.intensity;
    this.shadowRadius = 62;
    this.configureShadows(profile);
  }

  /** (Re)configures the single shadow map for the active quality profile (plan §49/§50). */
  configureShadows(profile: EnvironmentProfile): void {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
    const cam = this.sun.shadow.camera;
    cam.left = -this.shadowRadius;
    cam.right = this.shadowRadius;
    cam.top = this.shadowRadius;
    cam.bottom = -this.shadowRadius;
    cam.near = 1;
    cam.far = 340;
    cam.updateProjectionMatrix();
    // Contact-style bias: keep terrain+props stable without per-object tuning.
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.5;
  }

  /** Weather drives a whole-light mood (plan §33). Values are multipliers/lerps, cheap to apply. */
  setMood(mood: Partial<LightMood>): void {
    if (mood.sunIntensity !== undefined) this.mood.sunIntensity = mood.sunIntensity;
    if (mood.ambientIntensity !== undefined) this.mood.ambientIntensity = mood.ambientIntensity;
    if (mood.sunTint) this.mood.sunTint.copy(mood.sunTint);
    if (mood.ambientTint) this.mood.ambientTint.copy(mood.ambientTint);
  }

  /** Lightning / blast flash (plan §34): a fast-decaying intensity kick. */
  triggerFlash(strength = 1): void {
    this.flash = Math.min(2.4, this.flash + strength);
  }

  /**
   * Follows the local focus with the shadow camera and applies the mood. (plan §49: "stable
   * camera-relative coverage" — the shadow window is centred on the PLAYER, not the camera, so it
   * never swims when the camera rotates.)
   */
  update(dt: number, focus: THREE.Vector3, sunDir: THREE.Vector3): void {
    _focus.copy(focus);
    _sunPos.copy(focus).addScaledVector(sunDir, 170);
    this.sun.position.copy(_sunPos);
    this.sun.target.position.copy(_focus);
    this.sun.target.updateMatrixWorld();

    this.flash = Math.max(0, this.flash - dt * 3.2);
    const sunTarget = this.baseSunIntensity * this.mood.sunIntensity * (1 + this.flash * 0.8);
    const ambTarget = this.baseHemiIntensity * this.mood.ambientIntensity * (1 + this.flash * 0.35);
    // Smooth towards the targets so weather transitions never pop.
    const k = 1 - Math.exp(-2.4 * dt);
    this.currentSun += (sunTarget - this.currentSun) * k;
    this.currentAmbient += (ambTarget - this.currentAmbient) * k;
    this.sun.intensity = this.currentSun;
    this.hemi.intensity = this.currentAmbient;
    this.sun.color.copy(this.baseSunColor).lerp(this.mood.sunTint, 0.85);
    this.hemi.color.copy(this.baseHemiSky).lerp(this.mood.ambientTint, 0.6);
    this.hemi.groundColor.copy(this.baseHemiGround).lerp(this.mood.ambientTint, 0.35);
    // Keep the custom shaders in sync (they read the shared globals, not three's lights).
    void this.rim;
  }

  /** Beacon/emissive hook (plan §32): No effect unless a caller pulses it — kept as the seam. */
  pulse(): void {
    // Intentional no-op: emissive materials + bloom-style glows are the cheap path; a real light
    // is only ever added by gameplay (towers already manage their own).
  }

  get sunIntensity(): number {
    return this.currentSun;
  }
}
