/**
 * NECROFALL — world shader globals (folio `Game.getInstance()` seam).
 *
 * ONE context object the shared materials read from: lighting, fog, wind and
 * the terrain node family. This is the plan §101 spine — grass, foliage,
 * water, spikes and crystals all shade through the same values instead of
 * inventing their own lighting equations (plan §8/§9).
 */

export interface LightingGlobals {
  /** vec3 uniform – sun colour × intensity folded into one node by Lighting. */
  colorUniform: any;
  intensityUniform: any;
  /** vec3 normalized direction (planet→sun) the core-shadow dot uses. */
  directionUniform: any;
  coreShadowEdgeLow: any;
  coreShadowEdgeHigh: any;
  shadowColor: any;
  lightBounceEdgeLow: any;
  lightBounceEdgeHigh: any;
  /** Metres above the surface where the bounce fades out. */
  lightBounceDistance: any;
  lightBounceMultiplier: any;
  bounceColor: any;
}

export interface FogGlobals {
  /** float node 0..1 — distance fog factor at the shaded fragment. */
  strength: any;
  /** vec3 node. */
  color: any;
  near: any;
  far: any;
}

export interface TerrainGlobals {
  /** vec4 node — R height01 / G grass / B wetness / A radiation. */
  terrainNode: (direction: any) => any;
  /** vec4 node — second packed map: R rock / G biome / B puddle / A exclusion. */
  data2Node: (direction: any) => any;
  /** rgb node — the palette terrain colour for a terrain-data sample. */
  colorNode: (data: any) => any;
  /** float node — decode the height01 channel into metres above planet radius. */
  heightMeters: (height01: any) => any;
}

export interface WindGlobals {
  /** vec2 offset from a position — the ONE wind field (plan §18). */
  offsetNode: (position: any) => any;
  direction: any;
  strength: any;
}

export class WorldGlobals {
  static current: WorldGlobals | null = null;

  lighting: LightingGlobals | null = null;
  fog: FogGlobals | null = null;
  terrain: TerrainGlobals | null = null;
  wind: WindGlobals | null = null;
  /** Planet radius in metres. */
  radius = 0;

  static get(): WorldGlobals {
    const instance = WorldGlobals.current;
    if (!instance) throw new Error('WorldGlobals: world not initialised');
    return instance;
  }

  static reset(): void {
    WorldGlobals.current = null;
  }
}
