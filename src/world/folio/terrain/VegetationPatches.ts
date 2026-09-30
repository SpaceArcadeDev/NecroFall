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
