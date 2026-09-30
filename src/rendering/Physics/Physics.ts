// NECROFALL — WorldPhysics (plan §24, §25, §27, §70): the Rapier world for ENVIRONMENT physics.
//
// Policy (deliberate, matches the plan):
//   • the terrain stays ANALYTICAL — players, enemies and projectiles keep their existing
//     collision; Rapier never sees a planet-sized trimesh (plan §25);
//   • Rapier owns TREES and world props near gameplay (plan §14: only objects close enough to
//     matter get bodies — distance-tiered attach/detach, no per-blade colliders);
//   • gravity is radial (this is a planet): dynamic bodies get a per-step force towards the
//     centre instead of a constant world gravity.
import * as THREE from 'three/webgpu';
import type * as RAPIER from '@dimforge/rapier3d';
import { createCollider, treeColliderSpec } from './PhysicsColliderFactory';
import { PhysicsObject } from './PhysicsObject';
import type { TreePlacement } from '../../world/vegetation/VegetationTypes';

export interface WorldPhysicsOptions {
  /** Metres: objects closer than this to a gameplay focus get real bodies (plan §88). */
  objectPhysicsDistance: number;
  /** Radial gravity strength. */
  gravity: number;
}

interface TreeEntry {
  placement: TreePlacement;
  object: PhysicsObject | null;
}

export class WorldPhysics {
  private RAPIER: typeof import('@dimforge/rapier3d') | null = null;
  private world: RAPIER.World | null = null;
  ready = false;

  private readonly trees: TreeEntry[] = [];
  private readonly colliderObjects = new Set<PhysicsObject>();

  /** Attach/detach budget per tick — physics LOD never spikes a frame (plan §90). */
  private readonly attachQueue: Array<() => void> = [];

  private focusPoints: THREE.Vector3[] = [];
  private lodTimer = 0;
  /** Rescue ladder (plan §94/§95): physics pauses before gameplay systems are sacrificed. */
  private enabled = true;

  constructor(private readonly options: WorldPhysicsOptions) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async init(): Promise<void> {
    const RAPIER = await import('@dimforge/rapier3d');
    this.RAPIER = RAPIER;
    // Zero world gravity: gravity here is radial and applied per body (this is a small planet).
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.ready = true;
  }

  /** Register the world's trees; bodies are created lazily by the distance LOD (plan §14). */
  registerTrees(placements: TreePlacement[]): void {
    this.trees.length = 0;
    for (const placement of placements) this.trees.push({ placement, object: null });
  }

  /**
   * Per-frame bookkeeping:
   *   1. physics LOD (throttled): attach bodies near gameplay focuses, detach far ones;
   *   2. step the world with a fixed-ish timestep;
   *   3. radial gravity.
   */
  update(dt: number, focuses: THREE.Vector3[]): void {
    if (!this.ready || !this.world || !this.RAPIER) return;
    if (!this.enabled) return;
    this.focusPoints = focuses;

    this.lodTimer -= dt;
    if (this.lodTimer <= 0) {
      this.lodTimer = 0.5;
      this.updateLod();
    }

    // Drain a bounded number of attach jobs per frame (plan §70: pooled, never spiky).
    let budget = 6;
    while (this.attachQueue.length > 0 && budget-- > 0) this.attachQueue.shift()!();

    this.applyRadialGravity();
    this.world.timestep = Math.min(0.05, dt);
    this.world.step();
  }

  private nearestFocusDistance(position: THREE.Vector3): number {
    let best = Infinity;
    for (const focus of this.focusPoints) {
      const d = focus.distanceToSquared(position);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  private updateLod(): void {
    const reach = this.options.objectPhysicsDistance;

    for (const entry of this.trees) {
      const distance = this.nearestFocusDistance(entry.placement.position);
      if (!entry.object && distance < reach) {
        this.attachQueue.push(() => this.attachTree(entry));
      } else if (entry.object && distance > reach * 1.35) {
        this.detach(entry);
      }
    }
  }

  private detach(entry: { placement: { position: THREE.Vector3 }; object: PhysicsObject | null }): void {
    if (!entry.object) return;
    entry.object.destroy();
    entry.object = null;
  }

  private attachTree(entry: TreeEntry): void {
    if (!this.world || !this.RAPIER) return;
    const RAPIER = this.RAPIER;
    const placement = entry.placement;
    const spec = treeColliderSpec(placement.scale);

    const bodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(placement.position.x, placement.position.y, placement.position.z)
      .setRotation({ x: placement.quaternion.x, y: placement.quaternion.y, z: placement.quaternion.z, w: placement.quaternion.w });
    const body = this.world.createRigidBody(bodyDesc);

    // Cylinder colliders are centred on the body: lift it to sit on the surface (local +Y = up).
    const halfHeight = spec.parameters[0] as number;
    const object = new PhysicsObject('tree', body, this.trees.indexOf(entry));
    object.colliders.push(createCollider(RAPIER, this.world, body, spec, new THREE.Vector3(0, halfHeight + 0.4, 0)));
    entry.object = object;
    this.colliderObjects.add(object);
  }

  /** Radial gravity: pull every dynamic body towards the planet centre by its own mass. */
  private applyRadialGravity(): void {
    const g = this.options.gravity;
    for (const object of this.colliderObjects) {
      if (!object.isDynamic) continue;
      const t = object.body.translation();
      const length = Math.max(1e-3, Math.hypot(t.x, t.y, t.z));
      const inv = 1 / length;
      const mass = object.body.mass();
      object.body.addForce(
        { x: -t.x * inv * g * mass, y: -t.y * inv * g * mass, z: -t.z * inv * g * mass },
        true,
      );
    }
  }

  dispose(): void {
    for (const object of this.colliderObjects) object.destroy();
    this.colliderObjects.clear();
    this.trees.length = 0;
    this.attachQueue.length = 0;
    this.world?.free();
    this.world = null;
    this.ready = false;
  }

  /** Live collider count (telemetry / debug overlay). */
  get colliderCount(): number {
    return this.colliderObjects.size;
  }
}
