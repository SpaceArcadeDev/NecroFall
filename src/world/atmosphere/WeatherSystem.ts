// NECROFALL — WEATHER SYSTEM (rework plan §34/§35).
//
// Five NecroFall weathers, deterministic per slot so every client experiences the same sky:
//
//     DUST_STORM · TOXIC_RAIN · ASH_FALL · ACID_RAIN · LIGHTNING_STORM   (+ CLEAR)
//
// Weather is not cosmetic (plan §34): it drives FOG density, WIND strength, LIGHT mood and —
// as a seam — an enemy spawn-weight multiplier the game may read. Rendering is ONE instanced
// mesh of camera-anchored precipitation billboards on the GPU (plan §35: never 5,000 meshes).
import * as THREE from 'three';
import { clamp } from '../../utils/Utils';
import { hash32 } from '../EnvironmentSeed';
import { nfUniforms, NF_UNIFORMS_GLSL } from '../ShaderGlobals';
import type { EnvironmentContext } from '../EnvironmentContext';
import type { EnvironmentLighting } from './EnvironmentLighting';
import type { FogSystem } from './FogSystem';

export type WeatherKind = 'CLEAR' | 'DUST_STORM' | 'TOXIC_RAIN' | 'ASH_FALL' | 'ACID_RAIN' | 'LIGHTNING_STORM';

interface WeatherDef {
  kind: WeatherKind;
  fogScale: number;
  windScale: number;
  sunScale: number;
  ambientScale: number;
  sunTint: number;
  ambientTint: number;
  particleColor: number;
  particleSpeed: number;
  particleSlant: number;
  /** Share of the particle budget in use. */
  intensity: number;
  lightning: boolean;
}

const WEATHERS: Record<WeatherKind, WeatherDef> = {
  CLEAR: { kind: 'CLEAR', fogScale: 1, windScale: 1, sunScale: 1, ambientScale: 1, sunTint: 0xffffff, ambientTint: 0xffffff, particleColor: 0xffffff, particleSpeed: 8, particleSlant: 0.2, intensity: 0, lightning: false },
  DUST_STORM: { kind: 'DUST_STORM', fogScale: 2.6, windScale: 2.3, sunScale: 0.72, ambientScale: 0.9, sunTint: 0xd8a86a, ambientTint: 0xb0885a, particleColor: 0xb08a5a, particleSpeed: 5.5, particleSlant: 1.4, intensity: 0.85, lightning: false },
  TOXIC_RAIN: { kind: 'TOXIC_RAIN', fogScale: 1.9, windScale: 1.35, sunScale: 0.78, ambientScale: 0.95, sunTint: 0xb8d890, ambientTint: 0x7aa860, particleColor: 0x9dff4d, particleSpeed: 13, particleSlant: 0.35, intensity: 0.7, lightning: false },
  ASH_FALL: { kind: 'ASH_FALL', fogScale: 2.1, windScale: 1.15, sunScale: 0.66, ambientScale: 0.85, sunTint: 0xc89a7a, ambientTint: 0x8a7a72, particleColor: 0x9a9a9a, particleSpeed: 1.6, particleSlant: 0.3, intensity: 0.8, lightning: false },
  ACID_RAIN: { kind: 'ACID_RAIN', fogScale: 2.3, windScale: 1.5, sunScale: 0.7, ambientScale: 0.9, sunTint: 0xa8d8c8, ambientTint: 0x6a9a8a, particleColor: 0xa8ffd8, particleSpeed: 15, particleSlant: 0.4, intensity: 0.75, lightning: true },
  LIGHTNING_STORM: { kind: 'LIGHTNING_STORM', fogScale: 2.9, windScale: 1.9, sunScale: 0.6, ambientScale: 0.8, sunTint: 0xb8c8e8, ambientTint: 0x7a8aa8, particleColor: 0xb8d0e8, particleSpeed: 14, particleSlant: 0.5, intensity: 0.75, lightning: true },
};

const WEATHER_VERT = /* glsl */ `
  ${NF_UNIFORMS_GLSL}
  uniform vec3 uUp;         // planet up at the camera
  uniform vec3 uFallDir;    // fall direction (up reversed + wind slant)
  uniform vec3 uCamRight;
  uniform float uBoxH;      // fall height of the box
  uniform float uSpeed;     // fall speed (per weather)
  attribute vec3 aOffset;
  attribute float aRand;
  attribute float aSize;
  varying float vY;
  varying float vRand;

  void main() {
    // Camera-anchored precipitation box: instances live in a local box around the camera and
    // FALL along uFallDir, wrapping every uBoxH metres — one draw, zero CPU per drop (plan §35).
    vec3 base = uCamPos + aOffset;
    float t = mod(uTime * uSpeed * (0.6 + 0.8 * aRand) + aRand * 71.0, uBoxH);
    vec3 wp = base - uFallDir * t;
    // billboard: camera-right width, fall-direction length
    float stretch = 1.0 + aSize * 2.4;
    wp += uCamRight * position.x * (0.06 + aSize * 0.05);
    wp -= uFallDir * position.y * stretch;
    vY = position.y;
    vRand = aRand;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const WEATHER_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vY;
  varying float vRand;

  void main() {
    if (uOpacity <= 0.003) discard;
    float edge = smoothstep(0.0, 0.35, vY) * (1.0 - smoothstep(0.6, 1.0, vY));
    gl_FragColor = vec4(uColor, uOpacity * edge * (0.5 + 0.5 * vRand));
  }
`;

export class WeatherSystem {
  readonly name = 'weather';

  private readonly mesh: THREE.InstancedMesh;
  private readonly capacity: number;
  private readonly material: THREE.ShaderMaterial;
  private state: WeatherDef = WEATHERS.CLEAR;
  private intensity = 0;
  private visible = true;
  private lightningTimer = 0;
  private lightningCount = 0;
  private readonly moodScratch = { sun: new THREE.Color(), ambient: new THREE.Color() };
  private readonly windScratch = new THREE.Vector3();

  constructor(
    private readonly ctx: EnvironmentContext,
    private readonly lighting: EnvironmentLighting,
    private readonly fog: FogSystem
  ) {
    this.capacity = Math.max(64, ctx.profile.weatherParticles);
    // Unit quad: x = width, y = length; the shader stretches it into a streak.
    const geo = new THREE.PlaneGeometry(1, 1);
    const offsets = new Float32Array(this.capacity * 3);
    const rands = new Float32Array(this.capacity);
    const sizes = new Float32Array(this.capacity);
    const rng = (i: number, salt: number): number => hash32(ctx.seed, 0xea17, salt, i) / 4294967296;
    for (let i = 0; i < this.capacity; i++) {
      const a = rng(i, 1) * Math.PI * 2;
      const r = Math.sqrt(rng(i, 2)) * 26;
      offsets[i * 3] = Math.cos(a) * r;
      offsets[i * 3 + 1] = Math.sin(a) * r;
      offsets[i * 3 + 2] = (rng(i, 3) - 0.5) * 12;
      rands[i] = rng(i, 4);
      sizes[i] = 0.4 + rng(i, 5) * 1.2;
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(rands, 1));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: WEATHER_VERT,
      fragmentShader: WEATHER_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: nfUniforms({
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uFallDir: { value: new THREE.Vector3(0, -1, 0) },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uBoxH: { value: 34 },
        uSpeed: { value: 10 },
        uColor: { value: new THREE.Color(0xb08a5a) },
        uOpacity: { value: 0 },
      }),
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, this.capacity);
    this.mesh.name = 'env-weather';
    this.mesh.frustumCulled = false;
    // All instances share identity — the vertex shader places each one from its attributes.
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, m);
    this.mesh.instanceMatrix.needsUpdate = true;
    ctx.root.add(this.mesh);
  }

  /** The deterministic weather at a time (all clients agree — plan §34/§73). */
  weatherAt(elapsed: number): { def: WeatherDef; slot: number; envelope: number } {
    const SLOT = 110; // seconds per weather slot
    const slot = Math.floor(elapsed / SLOT);
    const within = elapsed - slot * SLOT;
    const state = this.pickWeather(slot);
    // 10 s fade in / 10 s fade out so weather changes breathe.
    const envelope = Math.min(1, within / 10, (SLOT - within) / 10);
    return { def: state, slot, envelope: clamp(envelope, 0, 1) * state.intensity };
  }

  /** Deterministic per-slot pick, weighted by the planet's biome (plan §13/§34). */
  private pickWeather(slot: number): WeatherDef {
    const roll = hash32(this.ctx.seed, 0xea17, slot) / 4294967296;
    const biome = this.ctx.biome.id;
    const table: WeatherKind[] =
      biome === 'DESERT' ? ['CLEAR', 'DUST_STORM', 'DUST_STORM', 'ASH_FALL', 'LIGHTNING_STORM', 'CLEAR']
      : biome === 'TOXIC' || biome === 'CORRUPTED' || biome === 'SWAMP' || biome === 'FUNGAL' ? ['CLEAR', 'TOXIC_RAIN', 'TOXIC_RAIN', 'ACID_RAIN', 'ASH_FALL', 'CLEAR']
      : biome === 'VOLCANIC' ? ['ASH_FALL', 'ASH_FALL', 'LIGHTNING_STORM', 'CLEAR', 'DUST_STORM', 'ASH_FALL']
      : biome === 'FROZEN' ? ['CLEAR', 'ASH_FALL', 'LIGHTNING_STORM', 'ACID_RAIN', 'CLEAR', 'ASH_FALL']
      : ['CLEAR', 'DUST_STORM', 'TOXIC_RAIN', 'ASH_FALL', 'ACID_RAIN', 'LIGHTNING_STORM'];
    const kind = table[Math.min(table.length - 1, Math.floor(roll * table.length))];
    return WEATHERS[kind];
  }

  /**
   * Applies the current weather to fog / wind / light and animates the particle field.
   * Called every frame is fine (uniform writes only), particles live fully on the GPU.
   */
  advance(dt: number, elapsed: number, cameraPos: THREE.Vector3, cameraQuat: THREE.Quaternion): void {
    const { def, slot, envelope } = this.weatherAt(elapsed);
    this.intensity = envelope;
    this.state = def;

    // Mood + fog + wind (plan §34).
    this.moodScratch.sun.setHex(def.sunTint);
    this.moodScratch.ambient.setHex(def.ambientTint);
    this.lighting.setMood({
      sunIntensity: def.sunScale,
      ambientIntensity: def.ambientScale,
      sunTint: this.moodScratch.sun,
      ambientTint: this.moodScratch.ambient,
    });
    this.fog.setWeatherScale(1 + (def.fogScale - 1) * envelope);
    this.ctx.wind.uWindStrength.value = (0.85 + Math.sin(elapsed * 0.21) * 0.17) * (1 + (def.windScale - 1) * envelope);

    // Lightning: deterministic flashes (same on every client — plan §73).
    if (def.lightning && envelope > 0.4) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 2.4 + (hash32(this.ctx.seed, slot, Math.floor(elapsed)) % 500) / 100;
        this.lighting.triggerFlash(0.9 + this.intensity);
        this.lightningCount++;
      }
    }

    // Particle uniforms: fall direction = planet-down + wind slant; camera basis for billboards.
    const u = this.material.uniforms;
    (u.uOpacity.value as number) = envelope * 0.5;
    (u.uColor.value as THREE.Color).setHex(def.particleColor);
    const up = u.uUp.value as THREE.Vector3;
    up.copy(cameraPos).normalize();
    const fall = u.uFallDir.value as THREE.Vector3;
    const wind = this.ctx.wind.uWindDir.value;
    fall.set(-up.x, -up.y, -up.z).addScaledVector(this.windScratch.set(wind.x, 0, wind.y), def.particleSlant * 0.2).normalize();
    const right = u.uCamRight.value as THREE.Vector3;
    right.set(1, 0, 0).applyQuaternion(cameraQuat);
    (u.uBoxH.value as number) = def.kind === 'ASH_FALL' ? 26 : 40;
    (u.uSpeed.value as number) = def.particleSpeed;
    this.mesh.visible = this.visible && envelope > 0.01;
  }

  /** Enemy-spawn weighting seam (plan §34) — 1 = normal, <1 fewer spawns in bad weather. */
  spawnWeightMul(): number {
    return 1 - this.intensity * 0.25;
  }

  /** Weather is planet-scale: cells do not apply to it (plan §19 — the mesh is always present). */
  activateCell(): boolean {
    return true;
  }

  deactivateCell(): void {
    // nothing per cell
  }

  /** EnvironmentSystem interface: per-frame work is done in `advance()` with the frame data. */
  update(): void {}

  /** Debug/hotspot toggle (plan §66). */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.mesh.visible = visible && this.intensity > 0.01;
  }

  get kind(): WeatherKind {
    return this.state.kind;
  }

  get strength(): number {
    return this.intensity;
  }

  stats(): { instances: number; activeCells: number; note?: string } {
    return { instances: Math.round(this.capacity * this.intensity), activeCells: 0, note: `${this.state.kind} ${(this.intensity * 100).toFixed(0)}%` };
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
