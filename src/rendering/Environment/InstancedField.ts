// NECROFALL — InstancedField (plan §107): the shared instancing kernel for environment props.
//
// ONE InstancedMesh per kind, per-instance terrain data for the weathering wash, no Object3D
// per prop, no per-frame allocation. Rocks, spikes and radioactive crystals are all built from
// this — separating them into distinct systems must not duplicate the instancing machinery.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { weatheredNode } from '../materials/NecroVegetationMaterial';
import { FOLIO } from '../FolioShaderGlobals';
import type { RockPlacement } from '../../world/vegetation/VegetationTypes';

/**
 * A prop material in the Folio family: base colour + weathering wash, optional emissive glow.
 * `emissiveHex` pins the glow colour (crystals stay purple on every planet); without it the glow
 * rides the planet's vein colour like the rest of the necrotic world.
 */
export function buildPropMaterial(baseHex: number, emissive = 0, vein = 0.3, emissiveHex?: number): MeshDefaultMaterial {
  const baseColor = uniform(new THREE.Color(baseHex));
  const colorNode = weatheredNode(baseColor, vein);
  const glowColor = emissiveHex !== undefined ? uniform(new THREE.Color(emissiveHex)) : FOLIO.necro.veinColor;
  return new MeshDefaultMaterial({
    colorNode,
    hasWater: false,
    emissiveNode: emissive > 0 ? glowColor.mul(emissive) : undefined,
  });
}

export interface InstancedFieldOptions {
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  placements: RockPlacement[];
  castShadows?: boolean;
  /** × scale: + stands proud of the ground, − sinks below it. */
  lift?: number;
  /** Default Y stretch for the kind (overridden per placement by `stretch`). */
  yStretch?: number;
}

/** Build the one InstancedMesh for a kind, or null when the kind has no placements. */
export function buildInstancedField(options: InstancedFieldOptions): THREE.Mesh | null {
  const placements = options.placements;
  if (placements.length === 0) return null;

  const geometry = options.geometry;
  const mesh = new THREE.InstancedMesh(geometry, options.material, placements.length);
  mesh.name = options.name;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.castShadow = options.castShadows ?? false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const terrain = new Float32Array(placements.length * 4);
  const veg = new Float32Array(placements.length);
  const matrix = new THREE.Matrix4();
  const scaleVec = new THREE.Vector3();

  for (let i = 0; i < placements.length; i++) {
    const placement = placements[i];
    // Rooting (plan §75/§76): positive lifts stand proud (spires), negative sinks into the
    // terrain (rocks must never look pasted on).
    const offset = (options.lift ?? -0.25) * placement.scale;
    const grounded = placement.position.clone().addScaledVector(placement.direction, offset);
    const stretch = placement.stretch ?? options.yStretch ?? 1;
    scaleVec.set(placement.scale, placement.scale * stretch, placement.scale);
    matrix.compose(grounded, placement.quaternion, scaleVec);
    mesh.setMatrixAt(i, matrix);
    terrain.set(placement.terrain, i * 4);
    veg[i] = placement.vegetation;
  }
  geometry.setAttribute('aTerrain', new THREE.InstancedBufferAttribute(terrain, 4));
  geometry.setAttribute('aVeg', new THREE.InstancedBufferAttribute(veg, 1));
  mesh.instanceMatrix.needsUpdate = true;

  return mesh;
}
