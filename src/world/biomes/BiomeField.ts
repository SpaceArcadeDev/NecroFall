// NECROFALL — BiomeField (plan §32): the weighting layer between the raw climate fields and
// every placement decision. It folds elevation, slope, moisture and corruption into the named
// weights the world is built from (grass / forest / rock / sand / water / dirt / necrotic), so
// generators and materials all consume the SAME curve shapes.
import { clamp, smoothstep } from '../../utils/Utils';
import type { TerrainSurface } from '../TerrainSurface';

export interface BiomeWeights {
  /** 0..1 — how much ground cover the spot supports. */
  grass: number;
  /** 0..1 — canopy density (trees). */
  forest: number;
  /** 0..1 — bare rock exposure. */
  rock: number;
  /** 0..1 — beach/dry band. */
  sand: number;
  /** 0..1 — submersion. */
  water: number;
  /** 0..1 — exposed soil (battle scars, steep soft ground). */
  dirt: number;
  /** 0..1 — corruption (necrotic growth). */
  necrotic: number;
}

export class BiomeField {
  constructor(private readonly surface: TerrainSurface) {}

  /**
   * Sample the weights. `slope` is rise/run (0 flat); heights are normalised by the caller's
   * relief band so the same field works on every archetype.
   */
  weightsAt(
    x: number,
    y: number,
    z: number,
    out: BiomeWeights,
    moisture = 0.5,
    corruption = 0,
    height01 = 0.5,
    slope?: number,
  ): BiomeWeights {
    const s = slope ?? this.surface.slopeAtDir(x, y, z);
    const depth = this.surface.waterAtDir(x, y, z);
    const water = depth > 0.35 ? 1 : depth > 0 ? 0.5 : 0;
    const vegetation = this.surface.vegetationAtDir(x, y, z) / 1.6;

    const flatness = 1 - smoothstep(0.14, 0.52, s);
    const highDry = 1 - smoothstep(0.62, 0.85, height01);

    out.grass = clamp(flatness * highDry * (0.35 + vegetation * 0.9), 0, 1);
    out.forest = clamp(flatness * (1 - smoothstep(0.55, 0.8, height01)) * (0.15 + vegetation * 1.1) * (0.4 + moisture), 0, 1);
    out.rock = clamp(smoothstep(0.3, 0.62, s) + smoothstep(0.8, 0.95, height01) * 0.6, 0, 1);
    out.sand = clamp((1 - smoothstep(0.06, 0.2, height01)) * (1 - smoothstep(0.1, 0.3, s)), 0, 1);
    out.water = clamp(water, 0, 1);
    out.dirt = clamp(smoothstep(0.4, 0.7, s) * (1 - out.rock) + (1 - moisture) * 0.25, 0, 1);
    out.necrotic = clamp(corruption, 0, 1);
    return out;
  }
}

export function createBiomeWeights(): BiomeWeights {
  return { grass: 0, forest: 0, rock: 0, sand: 0, water: 0, dirt: 0, necrotic: 0 };
}
