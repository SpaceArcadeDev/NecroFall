// NECROFALL — PhysicsColliderFactory (plan §24): builds Rapier collider descriptors for the
// world's object classes, in ONE place, so collider shapes/prices match the visual models and
// the layers stay consistent.
//
// Layers (plan §24): PLAYER, ENEMY, PROJECTILE, TOWER, TREE, PROP, TERRAIN, WATER_TRIGGER.
// The world's terrain itself is ANALYTICAL (plan §25) — it never becomes a collider mesh.
import type * as RAPIER from '@dimforge/rapier3d';
import * as THREE from 'three/webgpu';

/** Collision layer bits (16-bit memberships, filtered by the Rapier group convention). */
export const LAYERS = {
  PLAYER: 1 << 0,
  ENEMY: 1 << 1,
  PROJECTILE: 1 << 2,
  TOWER: 1 << 3,
  TREE: 1 << 4,
  PROP: 1 << 5,
  TERRAIN: 1 << 6,
  WATER_TRIGGER: 1 << 7,
} as const;

export type LayerName = keyof typeof LAYERS;

/** Group word: (membership << 16) | filter. */
export function group(membership: number, filter: number): number {
  return (membership << 16) | filter;
}

/** What each layer collides with. Trees block movement but not other trees; props block players. */
export const GROUPS = {
  TREE: group(LAYERS.TREE, LAYERS.PLAYER | LAYERS.ENEMY | LAYERS.PROJECTILE),
  PROP: group(LAYERS.PROP, LAYERS.PLAYER | LAYERS.ENEMY | LAYERS.PROJECTILE | LAYERS.PROP),
} as const;

export interface ColliderSpec {
  shape: 'cylinder' | 'cuboid';
  /** Cylinder: [halfHeight, radius]. Cuboid: [hx, hy, hz]. */
  parameters: [number, number] | [number, number, number];
  group: number;
  friction: number;
  restitution: number;
}

/** Tree trunk collider sized from the placement scale (plan §14/§80). */
export function treeColliderSpec(scale: number): ColliderSpec {
  return {
    shape: 'cylinder',
    parameters: [2.4 * scale, 0.32 * scale],
    group: GROUPS.TREE,
    friction: 0.7,
    restitution: 0.05,
  };
}

/** Attach a ColliderSpec to a rapier body. */
export function createCollider(
  RAPIER: typeof import('@dimforge/rapier3d'),
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  spec: ColliderSpec,
  offset?: THREE.Vector3,
  rotation?: THREE.Quaternion,
): RAPIER.Collider {
  let desc =
    spec.shape === 'cylinder'
      ? RAPIER.ColliderDesc.cylinder(spec.parameters[0] as number, spec.parameters[1] as number)
      : RAPIER.ColliderDesc.cuboid(spec.parameters[0] as number, spec.parameters[1] as number, spec.parameters[2] as number);

  if (offset) desc = desc.setTranslation(offset.x, offset.y, offset.z);
  if (rotation) desc = desc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
  desc = desc
    .setFriction(spec.friction)
    .setRestitution(spec.restitution)
    .setCollisionGroups(spec.group);

  return world.createCollider(desc, body);
}
