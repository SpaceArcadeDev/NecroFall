// NECROFALL — INTERACTION SYSTEM (rework plan §24/§25/§26/§56/§57).
//
// Turns gameplay events into environment reactions — VISUAL FIRST (plan §24/§58):
//
//   explosion()  → damage trees + crates (authoritative states, §57), impulse loose dynamic
//                  bodies, splash the water, and schedule chained barrel detonations;
//   splash()     → water disturbance where things land;
//   step()       → (hook) dust/trample the world where players run.
//
// Nothing here simulates a rigid body for a tree or a leaf: trees bend and break via instanced
// states, crates vanish into pooled debris, water gets a ring. That is the whole contract.
import * as THREE from 'three';
import { clamp } from '../../utils/Utils';
import { STATE_DAMAGED, STATE_DESTROYED } from '../interaction/DestructionLedger';
import type { EnvironmentContext } from '../EnvironmentContext';
import type { TreeSystem } from '../foliage/TreeSystem';
import type { PropSystem } from '../props/PropSystem';
import type { PhysicsWorld } from './PhysicsWorld';
import type { DynamicPropPhysics } from './DynamicPropPhysics';
import type { WaterSystem } from '../water/WaterSystem';

interface PendingBlast {
  t: number;
  pos: THREE.Vector3;
  radius: number;
  power: number;
}

const _up = new THREE.Vector3();
const _at = new THREE.Vector3();

export class InteractionSystem {
  private readonly pending: PendingBlast[] = [];
  private blastCount = 0;

  constructor(
    private readonly ctx: EnvironmentContext,
    private readonly trees: TreeSystem,
    private readonly props: PropSystem,
    private readonly physics: PhysicsWorld,
    private readonly debris: DynamicPropPhysics,
    private readonly water: WaterSystem | null
  ) {}

  /**
   * One explosion. Applies damage to destructible environment objects (ledger updated), pushes
   * dynamic bodies, splashes water. Returns the number of state changes — the host broadcasts
   * them via DestructibleSystem.drainChanges() on its next network tick.
   */
  explosion(pos: THREE.Vector3, radius: number, power: number): number {
    this.blastCount++;
    const powerK = clamp(power, 10, 400);
    let changes = 0;

    for (const rec of this.trees.damageAt(pos, radius, powerK * 0.9)) {
      this.ctx.ledger.set(rec.id, rec.state);
      changes++;
      // Damaged trees shed dust while they lean (visual only).
      if (this.ctx.fx && rec.state === STATE_DAMAGED) {
        _at.set(rec.posX, rec.posY, rec.posZ);
        _up.copy(_at).normalize();
        this.ctx.fx.dust(_at, _up, 0x6a7a4a, 5);
      }
    }

    for (const rec of this.props.damageAt(pos, radius, powerK * 1.1)) {
      this.ctx.ledger.set(rec.id, rec.state);
      changes++;
      // Barrels chain: a destroyed barrel detonates a smaller blast of its own.
      if (rec.kind === 1 && rec.state === STATE_DESTROYED) {
        this.pending.push({
          t: 0.22 + Math.random() * 0.12,
          pos: new THREE.Vector3(rec.posX, rec.posY, rec.posZ),
          radius: radius * 0.7,
          power: powerK * 0.55,
        });
      }
    }

    // Loose dynamic bodies get shoved (plan §24/§21 DYNAMIC category only).
    this.physics.impulse(pos, radius, powerK * 0.06);

    // Water disturbance when the blast reaches the surface (plan §15/§16).
    if (this.water?.hasWater) {
      const surfaceDist = Math.abs(pos.length() - this.water.waterLevel);
      if (surfaceDist < radius + 2) this.water.disturbance(pos, radius * 0.9, 0x9fdcff);
    }
    return changes;
  }

  /** A splash where gameplay touches water (deaths, slams, thrown bodies). */
  splash(pos: THREE.Vector3, radius: number): void {
    if (!this.water?.hasWater) return;
    if (pos.length() > this.water.waterLevel + 1.5) return;
    this.water.disturbance(pos, radius, 0xcfe8ff);
  }

  /** Ticks scheduled chained blasts (barrels). Frame-rate independent, event-sized queue. */
  update(dt: number): void {
    if (this.pending.length === 0) return;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const blast = this.pending[i];
      blast.t -= dt;
      if (blast.t <= 0) {
        this.pending.splice(i, 1);
        this.explosion(blast.pos, blast.radius, blast.power);
        this.ctx.fx?.burst(blast.pos, 0xff8a3d, { count: 26, size: 0.5, speed: 7.5 });
      }
    }
  }

  stats(): { explosions: number; pending: number } {
    return { explosions: this.blastCount, pending: this.pending.length };
  }
}
