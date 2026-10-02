/**
 * NECROFALL — shared ROUND-DOT see-through dissolve (user ask: the tree canopies must use "the
 * dotted approach same as the rock spikes").
 *
 * ONE definition for both systems: the rock spikes and the tree canopies break into the same
 * round-dot pattern near the player — one jittered dot per screen cell, size growing with
 * `fade` (0 at the player → 1 at the bubble's rim). Near the player only round dots of material
 * survive; by the rim the dots have merged back into the full surface. The dot is a
 * radial-distance shape with an antialiased edge — never a `floor()`ed square cell (that read as
 * pixelation).
 *
 * The value returned is an alpha multiplier in [0, 1]; callers multiply their own alpha by it and
 * let the material's alpha test discard the rest (`transparent` stays false — no sorting).
 */
import { float, mix, screenSize, screenUV } from 'three/tsl';

/** Dot spacing in drawing-buffer pixels — the pattern's scale on every screen size. */
export const DOT_DISSOLVE_SPACING = 11;

/** `fade`: 0 at the player (dissolved into round dots) → 1 at the rim (fully merged / solid). */
export function dotDissolve(fade: any): any {
  // one dot per cell, jittered centre + radius (so it never looks like a mechanical grid)
  const gx = (screenUV.x as any).mul(screenSize.x).div(DOT_DISSOLVE_SPACING);
  const gy = (screenUV.y as any).mul(screenSize.y).div(DOT_DISSOLVE_SPACING);
  const cx = gx.floor();
  const cy = gy.floor();
  const h1: any = cx.mul(127.1).add(cy.mul(311.7)).sin().mul(43758.5453).fract().abs();
  const h2: any = cx.mul(269.5).add(cy.mul(183.3)).sin().mul(28001.73).fract().abs();
  const localX = (gx.fract() as any).sub(0.5).add(h1.sub(0.5).mul(0.3));
  const localY = (gy.fract() as any).sub(0.5).add(h2.sub(0.5).mul(0.3));
  const d = localX.mul(localX).add(localY.mul(localY)).sqrt();

  // radius: distinct dots at the player (r ≈ 0.36 of a half-cell) → past the corners at the rim
  // (r ≥ ~1.0 fills every cell) so the surface is SOLID again outside the bubble
  const radius = mix(float(0.36), float(1.1), fade).mul(h1.mul(0.3).add(0.9));
  // survive inside the round dot; smoothstep gives the circle an antialiased edge
  return (radius as any).sub(d).smoothstep(0, 0.06);
}
