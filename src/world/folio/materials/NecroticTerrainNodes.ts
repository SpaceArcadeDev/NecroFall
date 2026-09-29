// NECROFALL — necrotic vein + corruption TSL nodes (plan §33/§34).
//
// The GLSL vein field that used to live in Planet.ts's terrain shader, expressed as TSL nodes
// so it runs through the Folio material architecture on the WebGPU renderer. Same maths, same
// look: a narrow sin-network band that reads as glowing veins rather than a wash.
import { Fn } from 'three/tsl';
import { FOLIO } from '../FolioShaderGlobals';

/**
 * Vein network mask at a world-space point (0..1, narrow band).
 * Ported 1:1 from the previous terrain fragment shader:
 *   a = sin(x·0.42)·sin(y·0.37)·sin(z·0.47)
 *   b = sin(x·0.17+1.7)·sin(z·0.19−0.6)
 *   smoothstep(0.86, 0.995, a·0.6 + b·0.5 + 0.5)
 */
export const necroticVeinNode = Fn(([p]: any[]) => {
  const a = p.x.mul(0.42).sin().mul(p.y.mul(0.37).sin()).mul(p.z.mul(0.47).sin());
  const b = p.x.mul(0.17).add(1.7).sin().mul(p.z.mul(0.19).sub(0.6).sin());
  return a.mul(0.6).add(b.mul(0.5)).add(0.5).smoothstep(0.86, 0.995);
});

/** Vein colour × glow strength, with the shared necro intensity folded in. */
export const necroticGlowNode = Fn(([glow, corruption]: any[]) => {
  return FOLIO.necro.veinColor.mul(glow.mul(corruption.mul(0.75).add(0.35)).mul(FOLIO.necro.intensity.add(0.4)));
});
