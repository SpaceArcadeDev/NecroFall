// NECROFALL — FOG SYSTEM (rework plan §31/§33/§34).
//
// Folio separates fog from weather; so do we:
//
//   * DISTANCE fog      — exponential-squared, the base atmosphere (already in every custom
//                          shader through SHADER_GLOBALS);
//   * BIOME fog         — colour + density from the planet's biome definition (plan §13);
//   * CONTAMINATION fog — a wash toward the biome's toxic tint on contaminated worlds;
//   * WEATHER fog       — WeatherSystem scales density for dust storms / acid rain (plan §34).
//
// Everything is a uniform write — no volumetric passes on mobile (plan §31/§86).
import * as THREE from 'three';
import { SHADER_GLOBALS } from '../ShaderGlobals';
import type { EnvironmentContext } from '../EnvironmentContext';

export class FogSystem {
  private readonly baseColor: THREE.Color;
  private readonly baseDensity: number;
  private readonly contaminated: THREE.Color;
  /** Weather multiplier (set by WeatherSystem; 1 = clear). */
  private weatherScale = 1;
  private readonly sceneFog: THREE.FogExp2 | null;

  constructor(private readonly ctx: EnvironmentContext, scene: THREE.Scene | null) {
    this.baseColor = new THREE.Color(ctx.biome.fogColor);
    // Denser, hazier worlds for swamps/toxic — from the biome's contamination and density mood.
    this.baseDensity = 0.0011 + ctx.biome.contamination * 0.0009;
    this.contaminated = new THREE.Color(ctx.biome.waterContamination);
    this.sceneFog = scene?.fog instanceof THREE.FogExp2 ? scene.fog : null;
    this.apply();
  }

  setWeatherScale(scale: number): void {
    this.weatherScale = Math.max(0.35, scale);
    this.apply();
  }

  update(dt: number): void {
    // Slow contamination breathing so the world feels alive (very cheap: uniform + colour only).
    void dt;
  }

  private apply(): void {
    const density = this.baseDensity * this.weatherScale;
    SHADER_GLOBALS.uFogDensity.value = density;
    SHADER_GLOBALS.uFogColor.value.copy(this.baseColor);
    // Contaminated worlds tint their fog a touch toward the toxic accent — subtle, or the whole
    // planet reads as a green soup.
    const contam = this.ctx.biome.contamination;
    if (contam > 0.5) SHADER_GLOBALS.uFogColor.value.lerp(this.contaminated, (contam - 0.5) * 0.25);
    if (this.sceneFog) {
      this.sceneFog.color.copy(SHADER_GLOBALS.uFogColor.value as THREE.Color);
      this.sceneFog.density = density;
    }
  }

  /** Debug/hotspot toggle (plan §66): fog OFF for GPU hotspot isolation. */
  setEnabled(enabled: boolean): void {
    this.weatherScale = enabled ? Math.max(0.35, this.weatherScale) : 0.02;
    this.apply();
  }

  get fogColor(): THREE.Color {
    return SHADER_GLOBALS.uFogColor.value as THREE.Color;
  }

  get fogDensity(): number {
    return SHADER_GLOBALS.uFogDensity.value as number;
  }
}
