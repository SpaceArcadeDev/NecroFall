/**
 * NECROFALL — cel-shading band quantiser (visual rework plan §3).
 *
 * The shared material (`MeshDefaultMaterial`) turns `dot(normal, sun)` into ONE smooth ramp for
 * every surface in the world. This module quantises that ramp into `ART_DIRECTION.cel.bands`
 * discrete levels with a small `softness`, so terrain, grass, rocks and vegetation shade as
 * stylised bands instead of an ordinary smooth PBR falloff — while the shading LANGUAGE around
 * them (core shadow colour, drop shadow, bounce, fog, glow) stays exactly as shipped.
 *
 * `?cel=0` returns the untouched smooth ramp, which makes the whole rework measurable A/B on a
 * live device (the switch is read once; see ArtDirection.celEnabled).
 */
import { float, mix } from 'three/tsl';
import { ART_DIRECTION, celEnabled } from '../ArtDirection';

/**
 * Quantise a 0..1 lighting ramp into discrete bands, softly.
 *
 * Each threshold contributes one `smoothstep`; the sum divided by `bands - 1` yields the levels
 * 0, 1/(n-1), … 1. With the shipped 4-band ladder the ramp snaps to
 * `shadow → dark → mid → bright` at 0.25 / 0.6 / 0.82 (plan §3's thresholds).
 */
export function celQuantize(ramp: any): any {
  if (!celEnabled()) return ramp;
  const thresholds = ART_DIRECTION.cel.thresholds;
  const softness = ART_DIRECTION.cel.softness;
  let level: any = float(0);
  for (const threshold of thresholds) {
    level = level.add((ramp as any).smoothstep(threshold - softness, threshold + softness));
  }
  return level.div(thresholds.length);
}

/**
 * The terrain band ladder (plan §2/§4): a 3-point tint (shadow → mid → light) evaluated on the
 * quantised ramp, multiplying the albedo so each lighting band carries its own value instead of
 * a single flat lit colour. Returns `null` when cel shading is switched off, so the pre-rework
 * image can be restored exactly.
 */
export function celBandTint(ramp: any, shadow: number, mid: number, light: number): any | null {
  if (!celEnabled()) return null;
  const s = float(shadow);
  const m = float(mid);
  const l = float(light);
  const inverse = (ramp as any).oneMinus();
  // Bezier through (0, shadow) (0.5, mid) (1, light) — no `pow` (NaN hazard on some D3D drivers).
  return inverse
    .mul(inverse)
    .mul(s)
    .add((ramp as any).mul(inverse).mul(2).mul(m))
    .add((ramp as any).mul(ramp).mul(l));
}

/** Muted grade for environment albedo (plan §2/§5): desaturate and raise contrast a little. */
export function gradeAlbedo(albedo: any, saturation: number, contrast: number): any {
  const luma: any = (albedo as any).x.mul(0.2126).add((albedo as any).y.mul(0.7152)).add((albedo as any).z.mul(0.0722));
  const grey = mix(albedo, luma, float(1 - saturation));
  return (grey as any).sub(0.5).mul(contrast).add(0.5);
}
