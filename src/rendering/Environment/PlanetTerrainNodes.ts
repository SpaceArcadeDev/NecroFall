/**
 * NECROFALL — GPU terrain nodes (plan §12/§63).
 *
 * The shader twin of `PlanetSurface.sample`: the ONE way materials read the
 * baked planet data. Every environment shader receives the same packed data:
 *
 *   terrainNode(position) → vec4  R height01 · G grass · B wetness · A radiation
 *   data2Node(position)   → vec4  R rock     · G biome · B puddle  · A spare
 */
import * as THREE from 'three/webgpu';
import { acos, atan, color, mix, texture, uniform, vec2 } from 'three/tsl';
import type { PlanetSurfaceData } from '../../planet/PlanetSurfaceData';
import { RADIOACTIVE_PALETTE } from '../materials/PlanetPalette';
import type { TerrainGlobals } from '../WorldGlobals';

export interface TerrainNodeBundle extends TerrainGlobals {
  directionToUv: (position: any) => any;
  reliefMin: any;
  reliefSpan: any;
}

export function createTerrainNodes(
  data: PlanetSurfaceData,
  gradientTexture: THREE.Texture,
  baseRadius: number,
): TerrainNodeBundle {
  const reliefMin = uniform(data.reliefMin - baseRadius);
  const reliefSpan = uniform(Math.max(0.0001, data.reliefMax - data.reliefMin));

  const grassColor = color(RADIOACTIVE_PALETTE.grass);
  const grassDark = color(RADIOACTIVE_PALETTE.grassDark);
  const radioactive = color(RADIOACTIVE_PALETTE.radioactive3);

  /** position (world/local, planet centred at origin) → equirect uv (bake parity). */
  const directionToUv = (position: any): any => {
    const direction = position.normalize();
    const u = atan(direction.z, direction.x).div(Math.PI * 2).add(0.5);
    const v = acos(direction.y.clamp(-1, 1)).div(Math.PI);
    return vec2(u, v);
  };

  const terrainNode = (position: any): any => texture(data.tex1, directionToUv(position));
  const data2Node = (position: any): any => texture(data.tex2, directionToUv(position));
  /** height01 channel → metres above the base sphere radius (matches PlanetSurface.height). */
  const heightMeters = (height01: any): any => height01.mul(reliefSpan).add(reliefMin);

  const colorNode = (terrainData: any): any => {
    // Height ramp (bottom of the ramp = 1 - height01 so it reads "sea → peak")
    const gradient = texture(gradientTexture, vec2(0, terrainData.x.oneMinus()));
    // Vegetation wash — folio's "grass is the terrain's own colour" idea, with
    // a contamination darkening on radioactive ground.
    const grassBlend = mix(grassColor, grassDark, terrainData.a.mul(0.6));
    const withGrass = mix(gradient.rgb, grassBlend, terrainData.y);
    // Restrained radioactive tint on the most contaminated ground.
    return mix(withGrass, radioactive, terrainData.a.mul(terrainData.a).mul(0.28));
  };

  return { directionToUv, terrainNode, data2Node, colorNode, heightMeters, reliefMin, reliefSpan };
}
