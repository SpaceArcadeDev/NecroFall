import { MathUtils } from 'three/webgpu';

export const NIGHT_ELEVATION = -0.38;
export const DAY_ELEVATION = 0.48;
export const TWILIGHT_COLOR = '#f3a06a';

export function daylightAt(elevation: number): number {
  return MathUtils.smoothstep(elevation, NIGHT_ELEVATION, DAY_ELEVATION);
}

export function twilightAt(elevation: number): number {
  return MathUtils.smoothstep(elevation, NIGHT_ELEVATION, -0.08)
    * (1 - MathUtils.smoothstep(elevation, 0.04, DAY_ELEVATION));
}