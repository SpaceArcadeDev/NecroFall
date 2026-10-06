/**
 * NECROFALL — selective object outlines (visual rework plan §59).
 *
 * The plan's rule: outline IMPORTANT silhouettes (hero landmarks, bosses, the Nexus) and never
 * the world itself — "otherwise the world becomes noisy". The technique is the classic inverted
 * hull: a second draw of the SAME geometry, back-faces only, pushed along the local normal, so
 * the expanded shell shows up as a dark rim around the object.
 *
 * `createOutline(mesh, …)` attaches the hull as a child of a NON-instanced mesh (an instanced
 * body cannot carry a per-instance child hull — clusters deliberately skip outlines). Thickness
 * is in the mesh's local units, so it scales with the object.
 */
import * as THREE from 'three/webgpu';
import { color, normalLocal, positionLocal } from 'three/tsl';
import { ART_DIRECTION, outlinesEnabled } from '../ArtDirection';

/** The rim colour: near-black with a cold blue lift, so it reads as ink, not as glow. */
export const OUTLINE_COLOR = '#0a1418';

/**
 * Builds the inverted-hull material. `thickness` is a fraction of the plan's §2 `outlines.distance`.
 */
export function createOutlineMaterial(thickness: number = ART_DIRECTION.outlines.distance): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.BackSide;
  material.transparent = false;
  material.depthWrite = true;
  material.fog = false;
  material.colorNode = color(OUTLINE_COLOR) as any;
  material.positionNode = (positionLocal as any).add((normalLocal as any).mul(thickness)) as any;
  return material;
}

/**
 * Adds an outline hull around `mesh` (returns the hull, or null when outlines are off). The hull
 * shares the mesh's geometry — never dispose it separately.
 */
export function attachOutline(mesh: THREE.Mesh, thickness: number = ART_DIRECTION.outlines.distance): THREE.Mesh | null {
  if (!outlinesEnabled()) return null;
  const hull = new THREE.Mesh(mesh.geometry, createOutlineMaterial(thickness));
  hull.name = `${mesh.name || 'mesh'}Outline`;
  hull.castShadow = false;
  hull.receiveShadow = false;
  hull.frustumCulled = false;
  hull.renderOrder = (mesh.renderOrder ?? 0) - 1;
  mesh.add(hull);
  return hull;
}
