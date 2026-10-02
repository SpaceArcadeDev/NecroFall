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

/** Patch band: below LOW = bare ground (ZERO blades), above HIGH = full packed clump. The band
 *  is consciously WIDE (user ask: edges looked "sharp and programmatic"): the mask itself is
 *  domain-warped in the bake (Noises.createPatchNoise), and this fade band lets the rim thin
 *  out over a couple of metres of irregular contour instead of cutting off in one line. */
export const GRASS_PATCH_EDGE_LOW = 0.5;
export const GRASS_PATCH_EDGE_HIGH = 0.63;

/**
 * How hard the patch rim is thinned: acceptance = coverage^power. The clump interior stays at
 * full density (coverage 1 accepts every blade); the rim fades outward. Lowered from 3.0 to 2.2
 * so the fade occupies most of the band — a harder curve threw away the whole rim in the last
 * half-metre, which is exactly what read as a cut-out edge.
 */
export const GRASS_ACCEPTANCE_POWER = 2.2;

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
