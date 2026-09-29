// NECROFALL — WorldPhysics (plan §24, §25, §27, §70): the Rapier world for ENVIRONMENT physics.
//
// Policy (deliberate, matches the plan):
//   • the terrain stays ANALYTICAL — players, enemies and projectiles keep their existing
//     collision; Rapier never sees a planet-sized trimesh (plan §25);
//   • Rapier owns trees, scenery props and dynamic crates near gameplay (plan §14: only objects
//     close enough to matter get bodies — distance-tiered attach/detach, no per-blade colliders);
//   • gravity is radial (this is a planet): dynamic bodies get a per-step force towards the
//     centre instead of a constant world gravity;
//   • dynamic crates write their transforms back into the Scenery InstancedMesh — the render and
//     the physics never disagree.
import * as THREE from 'three/webgpu';
import type * as RAPIER from '@dimforge/rapier3d';
import { createCollider, sceneryColliderSpec, treeColliderSpec } from './PhysicsColliderFactory';
import { PhysicsObject } from './PhysicsObject';
import type { SceneryPlacement, TreePlacement } from '../../vegetation/VegetationTypes';
import type { Scenery } from '../scenery/Scenery';

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

interface SceneryEntry {
  placement: SceneryPlacement;
  /** Index inside its kind's placement list (crate sync uses it). */
  kindIndex: number;
  object: PhysicsObject | null;
  isDynamic: boolean;
}

export class WorldPhysics {
  private RAPIER: typeof import('@dimforge/rapier3d') | null = null;
  private world: RAPIER.World | null = null;
  ready = false;

  private readonly trees: TreeEntry[] = [];
  private readonly scenery: SceneryEntry[] = [];
  private readonly colliderObjects = new Set<PhysicsObject>();
  private sceneryRef: Scenery | null = null;

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

  /** Register scenery; crates are dynamic, everything else fixed (plan §27). */
  registerScenery(placements: SceneryPlacement[], scenery: Scenery): void {
    this.scenery.length = 0;
    this.sceneryRef = scenery;
    const kindCounters = new Map<string, number>();
    for (const placement of placements) {
      const kindIndex = kindCounters.get(placement.kind) ?? 0;
      kindCounters.set(placement.kind, kindIndex + 1);
      const isDynamic = placement.kind === 'CRATE';
      this.scenery.push({ placement, kindIndex, object: null, isDynamic });
    }
  }

  /**
   * Per-frame bookkeeping:
   *   1. physics LOD (throttled): attach bodies near gameplay focuses, detach far ones;
   *   2. step the world with a fixed-ish timestep;
   *   3. radial gravity + crate mesh sync.
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

    this.syncCrates();
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

    for (const entry of this.scenery) {
      const distance = this.nearestFocusDistance(entry.placement.position);
      const reachHere = entry.isDynamic ? reach * 1.2 : reach * 0.8;
      if (!entry.object && distance < reachHere) {
        this.attachQueue.push(() => this.attachScenery(entry));
      } else if (entry.object && distance > reachHere * 1.35) {
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

  private attachScenery(entry: SceneryEntry): void {
    if (!this.world || !this.RAPIER) return;
    const RAPIER = this.RAPIER;
    const placement = entry.placement;
    const spec = sceneryColliderSpec(placement.kind, placement.scale);
    if (!spec) return;

    const isDynamic = entry.isDynamic;
    let bodyDesc = isDynamic ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.fixed();
    bodyDesc = bodyDesc
      .setTranslation(placement.position.x, placement.position.y, placement.position.z)
      .setRotation({ x: placement.quaternion.x, y: placement.quaternion.y, z: placement.quaternion.z, w: placement.quaternion.w });
    if (isDynamic) {
      bodyDesc = bodyDesc.setLinearDamping(0.25).setAngularDamping(0.6);
    }
    const body = this.world.createRigidBody(bodyDesc);

    const halfHeight = spec.parameters[1] as number;
    const object = new PhysicsObject(isDynamic ? 'crate' : 'prop', body, entry.kindIndex);
    object.colliders.push(createCollider(RAPIER, this.world, body, spec, new THREE.Vector3(0, halfHeight, 0)));
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

  /** Write dynamic crate transforms back into the Scenery instanced meshes (plan §27). */
  private syncCrates(): void {
    const scenery = this.sceneryRef;
    if (!scenery) return;

    const crateParts = scenery.crateParts;
    if (crateParts.length === 0) return;

    for (const entry of this.scenery) {
      if (!entry.isDynamic || !entry.object) continue;
      const matrix = entry.object.matrix(_matrix, _position, _quaternion);
      for (const part of crateParts) {
        _scratch.multiplyMatrices(matrix, part.localMatrix);
        part.mesh.setMatrixAt(entry.kindIndex, _scratch);
        part.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    for (const object of this.colliderObjects) object.destroy();
    this.colliderObjects.clear();
    this.trees.length = 0;
    this.scenery.length = 0;
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

const _matrix = new THREE.Matrix4();
const _scratch = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
