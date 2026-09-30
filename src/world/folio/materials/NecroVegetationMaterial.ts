// NECROFALL — materials for the non-leaf vegetation half (trunks, rocks, props, scenery) and
// the adopt-a-GLB-material bridge (plan §31, §86).
//
// Folio replaces imported model materials with its own node materials so the whole world shares
// one lighting/fog family. This module does the same for the reused Folio GLBs: it reads the
// colour the model was authored with and returns a SHARED MeshDefaultMaterial instance (one per
// source material — hundreds of trees, one material), with the planet's grain + corruption wash
// on top so NecroFall's identity survives the imported art.
import * as THREE from 'three/webgpu';
import { Fn, attribute, mx_noise_float, positionWorld, uniform } from 'three/tsl';
import { MeshDefaultMaterial } from './MeshDefaultMaterial';
import { terrainDataNode } from '../terrain/NecroFallTerrainNode';
import { TERRAIN_PALETTE } from '../terrain/NecroFallTerrainNode';
import { FOLIO } from '../FolioShaderGlobals';

/** One adopted material per source material — repeated loads share the GPU program. */
const adopted = new WeakMap<THREE.Material, MeshDefaultMaterial>();

export interface AdoptOptions {
  /** Add the terrain grain/humidity/corruption modulation (world surfaces). */
  weathered?: boolean;
  /** Self-glow tint for lanterns etc. (0 = none). */
  emissive?: number;
  /** Force double-sided (foliage-ish props). */
  doubleSided?: boolean;
  /** Skip the fog (used by sky/space sides). */
  noFog?: boolean;
  /** The geometry the material will render — gates the vertex-colour term (see below). */
  geometry?: THREE.BufferGeometry;
}

/** The planet's weathering wash: grain + corruption, shared by every adopted material.
 *  `veinStrength` is the corruption mix cap — spikes pass ~0 so they stay stone-grey under a
 *  warm sun (the full wash tinted them purple on corrupt worlds: "colored pyramids", user
 *  review 2026-09-30). */
export function weatheredNode(baseColor: any, veinStrength = 0.3): any {
  return Fn(() => {
    const data = terrainDataNode();
    const grain = mx_noise_float(positionWorld.mul(2.7)).mul(0.5).add(0.5);
    const col = baseColor.mul(grain.mul(0.28).add(0.86)).toVar();
    if (veinStrength <= 0) return col;
    const corruption = data.w.clamp(0, 1).mul(FOLIO.necro.intensity.mul(0.6).add(0.4)).min(1);
    col.assign(col.mix(TERRAIN_PALETTE.vein, corruption.mul(veinStrength)));
    return col;
  })();
}

/**
 * Adopt a GLB material into the Folio family. The source colour (and vertex colours, when the
 * model uses them) are preserved; everything else becomes the shared shading model.
 */
export function adoptMeshMaterial(source: THREE.Material | THREE.Material[], options: AdoptOptions = {}): MeshDefaultMaterial {
  const src = Array.isArray(source) ? source[0] : source;
  const cached = adopted.get(src);
  if (cached) return cached;

  const srcColor = (src as { color?: THREE.Color }).color?.clone() ?? new THREE.Color(0xffffff);
  // Some GLB materials flag `vertexColors` while the mesh geometry carries none — multiplying by
  // a missing attribute logs a THREE.AttributeNode warning per draw. Trust the geometry.
  const hasVertexColors =
    (src as { vertexColors?: boolean }).vertexColors === true &&
    (options.geometry ? options.geometry.hasAttribute('color') : true);

  let colorNode: any = uniform(srcColor);
  if (hasVertexColors) {
    colorNode = colorNode.mul(attribute('color', 'vec3'));
  }
  if (options.weathered) {
    colorNode = weatheredNode(colorNode);
  }

  const material = new MeshDefaultMaterial({
    colorNode,
    side: options.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    transparent: src.transparent,
    alphaTest: src.alphaTest > 0 ? src.alphaTest : 0.1,
    hasWater: false,
    hasFog: !options.noFog,
    hasLightBounce: true,
    emissiveNode: options.emissive
      ? uniform(new THREE.Color(srcColor).multiplyScalar(options.emissive * 3))
      : undefined,
  });
  material.name = `adopted:${src.name || src.type}`;

  adopted.set(src, material);
  return material;
}

/** Cloned geometries get their own instance attributes; this helper keeps that intent explicit. */
export function cloneGeometryForInstancing(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.clone();
  // Instanced per-instance data lives on the clone, never on the shared source geometry.
  return geometry;
}
