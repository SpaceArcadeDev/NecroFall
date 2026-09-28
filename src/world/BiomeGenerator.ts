// NECROFALL — BIOME GENERATOR (plan §13/§14). Elevation + temperature + moisture + corruption
// (+ slope, from the rendered normals) classify every vertex into a biome; the biome's palette
// paints the terrain ramp; landmarks blend their own accent on top; low ground takes the
// archetype's necrotic vein tint. Vegetation density reads the same classifier (plan §11's
// "Vegetation" step).
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../utils/Utils';
import { classifyBiomeClass, type BiomeClass, type PlanetArchetype } from './PlanetArchetypes';
import type { TerrainGenerator } from './TerrainGenerator';

export class BiomeGenerator {
  readonly planetBiome: BiomeClass;

  constructor(
    private readonly arch: PlanetArchetype,
    private readonly terrain: TerrainGenerator
  ) {
    this.planetBiome = arch.biome;
  }

  /** Biome classification at a direction (uses the generator's climate fields). */
  biomeAt(x: number, y: number, z: number): BiomeClass {
    const h = this.terrain.sample(x, y, z) - this.terrain.radius;
    const temp = this.terrain.temperatureAt(x, y, z);
    const moist = this.terrain.moistureAt(x, y, z);
    const corr = this.terrain.corruptionAt(x, y, z) + (h < -6 ? this.arch.veinStrength * 0.25 : 0);
    // high ground chills (elevation feeds the classifier's "high + cold → frozen" rule)
    const c = classifyBiomeClass(clamp(temp - Math.max(0, h) * 0.02, 0, 1), clamp(moist, 0, 1), clamp(corr, 0, 1));
    // A site overrides its own biome (toxic lake in a desert still reads TOXIC).
    const site = this.terrain.lastSite();
    if (site.t > 0.45 && site.landmark?.biome) return site.landmark.biome;
    return c;
  }

  /** Vegetation density multiplier at a direction (0..1.6) — the plan's "Enemy Habitat" seam. */
  plantDensityAt(x: number, y: number, z: number): number {
    const h = this.terrain.sample(x, y, z) - this.terrain.radius;
    const moist = this.terrain.moistureAt(x, y, z);
    const corr = this.terrain.corruptionAt(x, y, z);
    let d = 0.45 + moist * 0.75 + (this.arch.plantDensity - 1) * 0.5;
    if (corr > 0.6) d *= 1 + (corr - 0.6) * 1.6; // necrotic growth thrives in corruption
    if (h > 16) d *= 0.35; // bare peaks
    return clamp(d, 0, 1.6);
  }

  /**
   * Terrain vertex colour: the archetype's elevation ramp, mottled, with landmark accents and a
   * corruption vein wash. `slope` (0 flat .. 1 vertical) blends the rocky ridge tone in — the
   * pipeline's "terrain material" step (plan §11).
   */
  colorAt(x: number, y: number, z: number, h: number, slope: number, out: THREE.Color, scratch: THREE.Color): void {
    const p = this.arch.palette;
    const t = clamp((h - this.terrain.radius + 13) / 40, 0, 1);
    if (t < 0.22) out.setHex(p.deep).lerp(scratch.setHex(p.low), t / 0.22);
    else if (t < 0.48) out.setHex(p.low).lerp(scratch.setHex(p.mid), (t - 0.22) / 0.26);
    else if (t < 0.74) out.setHex(p.mid).lerp(scratch.setHex(p.ridge), (t - 0.48) / 0.26);
    else out.setHex(p.ridge).lerp(scratch.setHex(p.peak), (t - 0.74) / 0.26);

    // steep ground exposes rock
    if (slope > 0.42) {
      const k = smoothstep(0.42, 0.85, slope) * 0.55;
      out.lerp(scratch.setHex(p.ridge), k);
    }

    // low land drinks the archetype's vein colour (necrotic wash)
    if (t < 0.5) out.lerp(scratch.setHex(p.vein), (0.5 - t) * 0.5 * this.arch.veinStrength);

    // corruption veins reach up wherever the field says necrotic
    const corr = this.terrain.corruptionAt(x, y, z);
    if (corr > 0.55) out.lerp(scratch.setHex(0x8b4dff), (corr - 0.55) * 0.7);

    // landmark accent (burned-in colour of the site)
    const site = this.terrain.lastSite();
    if (site.t > 0.35 && site.landmark) {
      out.lerp(scratch.setHex(site.landmark.color), Math.min(0.55, (site.t - 0.35) * 0.8));
    }

    // fine mottling so large faces never look flat
    const mottle = (this.terrain.corruptionAt(x * 2.1 + 5, y * 2.1 + 2, z * 2.1 + 9) - 0.5) * 0.6;
    out.offsetHSL(mottle * 0.015, 0, mottle * 0.05);
  }

  /** Linear blend helper kept here so callers do not import lerp just for fog/sky tints. */
  static blendHex(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return (
      (Math.round(lerp(ar, br, t)) << 16) |
      (Math.round(lerp(ag, bg, t)) << 8) |
      Math.round(lerp(ab, bb, t))
    );
  }
}
