/**
 * NECROFALL — the grass-field definition (plan §17).
 *
 * ONE source of truth for "where does the planet grow grass": the CPU placement pass in
 * Grass.ts and the terrain's grass shadow (PlanetTerrain.ts) read the SAME patch noise,
 * scale and thresholds from here, so blades and the shade under them can never drift apart.
 *
 * The field is PATCH-ONLY (user ask): below EDGE_LOW there is NO blade at all — bare ground
 * stays genuinely bare (no sparse strays) — and the acceptance curve packs clumps so tightly
 * that blades nearly touch inside a patch.
 */

/**
 * Patch-noise UV scale: `direction.xz × this`, sampled from the SMOOTH `noises.patch` field
 * (one broad octave). LOW scale = LARGE patches — at ×2.5 the mask's base wavelength is
 * ~16 m of surface, so a clump reads as a proper grass FIELD a dozen-plus metres across
 * (user ask: "larger patches of grass, not many small ones"). 1 uv unit ≈ R metres.
 */
export const GRASS_PATCH_UV_SCALE = 2.5;

/** Patch band: below LOW = bare ground (ZERO blades), above HIGH = full packed clump. */
export const GRASS_PATCH_EDGE_LOW = 0.52;
export const GRASS_PATCH_EDGE_HIGH = 0.62;

/**
 * How hard the patch rim is thinned: acceptance = coverage^power. A steep curve keeps the
 * clump interior at full density while the rim fades away in under a metre — the edge reads
 * as grass ending, never as sparse strays scattered around the clump.
 */
export const GRASS_ACCEPTANCE_POWER = 3.0;

/**
 * Terrain shade band — sits INSIDE the clumps (blades are already dense where it starts),
 * so the darkening can never show as bare dark ground.
 */
export const GRASS_SHADOW_EDGE_LOW = 0.56;
export const GRASS_SHADOW_EDGE_HIGH = 0.76;

/** Terrain multiplier under the densest grass — the fixed shadow the clumps sit in. */
export const GRASS_SHADOW_DEPTH = 0.8;

/** CPU smoothstep of the patch value → 0..1 coverage (mirrors the shader's smoothstep). */
export function grassCoverage(patch: number): number {
  const t = Math.min(1, Math.max(0, (patch - GRASS_PATCH_EDGE_LOW) / (GRASS_PATCH_EDGE_HIGH - GRASS_PATCH_EDGE_LOW)));
  return t * t * (3 - 2 * t);
}
