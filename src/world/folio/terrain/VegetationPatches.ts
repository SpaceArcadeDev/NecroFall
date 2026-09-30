// NECROFALL — the grass-PATCH field (the user's folio note: "in patches not full all over").
//
// Folio's lawn is not uniform: the ISLAND's terrain data carries an authored density channel
// (the green channel their grass reads for blade size, root shadow AND the visibility gate),
// and the lawn visibly forms blobs over bare ground. We have no hand-authored channel — this
// module IS the procedural stand-in: a seeded fbm carved with a smooth threshold into broad
// lawn blobs (≈14 m across on a 118 m planet) separated by bare ground.
//
// ONE definition, used by EVERY baker of the vegetation channel (the terrain mesh's `aVeg`
// attribute in TerrainVisual and the grass data texture in Grass) so the blades, the ground's
// grass wash and the trees' shared albedo all agree on where the lawn is.
//
// The channel is NORMALIZED to the planet's own plant-density peak (vegetationPeak): folio's
// density data runs 0..1 over the lawn, but our raw `plantDensityAt` runs ~0.16..0.3 on a DESERT
// planet — the raw product left every low-vegetation planet with blades below the visibility
// floor and a near-invisible wash ("no grass in a classic game", user review 2026-09-30).
//
// Lawn density = patch carve × planet richness:
//
//   veg  =  patch × (0.5 + 0.5 × clamp(raw / planetPeak, 0, 1))
//
// The PATCH is the primary lawn mask (folio's authored on/off density: blobs of lawn over bare
// ground); the planet's own richness only modulates WITHIN the lawn (0.5..1), so every archetype
// reads a real lawn where its patches are — a desert's scrub and a jungle's meadow differ by
// tone, not by "grass exists at all".
import { fbm } from '../../../utils/Utils';

/** Blob scale: fbm features every ≈1/8 radian ≈ 14 m of arc — folio-lawn sized. */
const PATCH_FREQUENCY = 8;
/** fbm carve band: below 0.34 bare, above 0.54 full lawn, smoothstep between. Kept fairly wide
 *  (≈60% coverage) — the user reads the lawn as the main ground cover, with bare ground as the
 *  gaps, same as the island. */
const PATCH_LOW = 0.34;
const PATCH_SPAN = 0.2;

/**
 * The patch mask (0..1) at a unit direction: 1 = dense lawn, 0 = bare ground. Deterministic
 * for a planet seed — the same seed paints the same patches forever.
 */
export function vegetationPatchAt(x: number, y: number, z: number, seed: number): number {
  const n = fbm(x * PATCH_FREQUENCY, y * PATCH_FREQUENCY, z * PATCH_FREQUENCY, 3, seed);
  const t = (n - PATCH_LOW) / PATCH_SPAN;
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * The planet's own peak of the RAW plant density (`plantDensityAt`), found on a coarse lat/lon
 * grid — deterministic, so every baker (and every peer) computes the exact same normalizer.
 * Bakers divide the raw density by it (→ 0..1 "planet richness") before folding it into the
 * patch-carved lawn channel. The 0.25 floor keeps near-sterile worlds from amplifying float
 * noise into a lawn.
 */
export function vegetationPeak(plantDensityAt: (x: number, y: number, z: number) => number, seed: number): number {
  let peak = 0;
  for (let iy = 0; iy < 32; iy++) {
    const lat = ((iy + 0.5) / 32 - 0.5) * Math.PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    for (let ix = 0; ix < 64; ix++) {
      const lon = ((ix + 0.5) / 64 - 0.5) * Math.PI * 2;
      const dx = cosLat * Math.cos(lon);
      const dz = cosLat * Math.sin(lon);
      const v = plantDensityAt(dx, sinLat, dz);
      if (v > peak) peak = v;
    }
  }
  void seed;
  return Math.max(0.25, peak);
}

/**
 * The lawn channel at a direction, in the shader contract's 0..1.6 range: the patch carve times
 * the planet's normalized richness (0.5..1). Both bakers call THIS, so blades and the ground
 * wash cannot disagree.
 */
export function vegetationLawnAt(
  plantDensityAt: (x: number, y: number, z: number) => number,
  peak: number,
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  const richness = Math.min(1, plantDensityAt(x, y, z) / peak);
  return vegetationPatchAt(x, y, z, seed) * (0.5 + 0.5 * richness) * 1.6;
}
