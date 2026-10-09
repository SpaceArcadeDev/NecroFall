import { DoubleSide, type Texture } from 'three/webgpu';
import { color, float, mix, normalWorldGeometry, positionLocal, positionWorld, sin, smoothstep, texture } from 'three/tsl';
import { MeshDefaultMaterial, type MeshDefaultMaterialParameters } from './MeshDefaultMaterial';
import type { PlanetArchetype } from '../../world/PlanetArchetypes';
import type { TerrainNodeBundle } from '../Environment/PlanetTerrainNodes';
import type { Noises } from '../Environment/Noises';

export interface SurfaceMaps { albedo?: Texture; normal?: Texture; roughness?: Texture }
export interface SurfaceMaterialOptions extends MeshDefaultMaterialParameters { opacityNode?: any; roughness?: number }

export class SurfaceMaterial extends MeshDefaultMaterial {
  constructor(options: SurfaceMaterialOptions = {}) {
    super({ ...options, alphaNode: options.opacityNode ?? options.alphaNode });
  }
}

export function createBaseTerrainMaterial(nodes: TerrainNodeBundle, noises: Noises, archetype: PlanetArchetype) {
  const art = archetype.art!;
  const data = nodes.terrainNode(positionLocal);
  const direction = positionLocal.normalize();
  const patch = texture(noises.patch, direction.xz.mul(2.4)).r;
  const height = smoothstep(0.22, 0.8, data.x).mul(0.7).add(patch.sub(0.5).mul(0.2)).clamp();
  let albedo: any = mix(color(art.ground), color(art.highland), height);
  const slope = float(1).sub(normalWorldGeometry.dot(direction)).clamp();
  albedo = mix(albedo, color(art.rock), smoothstep(0.18, 0.55, slope).mul(0.82));
  albedo = albedo.mul(float(1).sub(data.y.mul(0.14))).mul(float(1).sub(data.z.mul(0.12)));
  const seams = smoothstep(0.97, 0.999, sin(positionWorld.x.mul(0.31).add(sin(positionWorld.z.mul(0.27)).mul(2)).add(positionWorld.y.mul(0.19))));
  const material = new SurfaceMaterial({ colorNode: albedo, side: DoubleSide, hasLightBounce: false,
    lawnGlowData: data, lawnGlowColor: color(art.infection),
    glowNode: color(art.infection).mul(data.a.pow(2)).mul(seams.mul(0.65).add(0.045)) });
  return { material, albedoNode: albedo };
}