// NECROFALL — the rendering boundary (plan §1). Gameplay OWNS the simulation; the environment
// reads a per-frame snapshot of it and never owns authoritative state.
//
//   GAME SIMULATION → RenderState → environment systems
//
// The environment only ever READS from this object (grass focus, occlusion anchor, water
// recentring). It must never write gameplay state back. The collector is allocation-free:
// player fields are copied in place and the enemy/effect lists are pooled, so the boundary adds
// no per-frame garbage (plan §107).
import * as THREE from 'three/webgpu';

export interface RenderStatePlayer {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
}

export interface RenderStateEnemy {
  id: string;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  scale: number;
  type: string;
  visible: boolean;
}

export interface RenderStateEffect {
  type: string;
  position: THREE.Vector3;
  intensity: number;
  lifetime: number;
}

export interface RenderState {
  readonly player: RenderStatePlayer | null;
  readonly enemies: readonly RenderStateEnemy[];
  readonly effects: readonly RenderStateEffect[];
}

/** Structurally matches whatever gameplay hands in (Game's Player / Enemy / effect entries). */
export interface PlayerSource {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
}

export interface EnemySource {
  id: string;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  scale: number;
  type: string;
  visible: boolean;
}

export interface EffectSource {
  type: string;
  position: THREE.Vector3;
  intensity: number;
  lifetime: number;
}

/**
 * The pool that Game fills once per frame. `capture()` copies the player pose and rebuilds the
 * enemy/effect lists into pooled wrappers — zero allocation after the first frames of a crowd.
 */
export class RenderStateCollector implements RenderState {
  player: RenderStatePlayer | null = null;
  readonly enemies: RenderStateEnemy[] = [];
  readonly effects: RenderStateEffect[] = [];

  private readonly playerPool: RenderStatePlayer = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
  };
  private readonly enemyPool: RenderStateEnemy[] = [];
  private readonly effectPool: RenderStateEffect[] = [];

  /** Fill the snapshot. Called once per frame, before the environment stages run. */
  capture(
    player: PlayerSource | null,
    enemies: Iterable<EnemySource> = [],
    effects: Iterable<EffectSource> = [],
  ): void {
    if (player) {
      this.playerPool.position.copy(player.position);
      this.playerPool.velocity.copy(player.velocity);
      this.player = this.playerPool;
    } else {
      this.player = null;
    }

    this.enemies.length = 0;
    let enemyIndex = 0;
    for (const enemy of enemies) {
      let entry = this.enemyPool[enemyIndex];
      if (!entry) {
        entry = {
          id: '',
          position: new THREE.Vector3(),
          rotation: new THREE.Quaternion(),
          scale: 1,
          type: '',
          visible: true,
        };
        this.enemyPool[enemyIndex] = entry;
      }
      entry.id = enemy.id;
      entry.position.copy(enemy.position);
      entry.rotation.copy(enemy.rotation);
      entry.scale = enemy.scale;
      entry.type = enemy.type;
      entry.visible = enemy.visible;
      this.enemies.push(entry);
      enemyIndex++;
    }

    this.effects.length = 0;
    let effectIndex = 0;
    for (const effect of effects) {
      let entry = this.effectPool[effectIndex];
      if (!entry) {
        entry = { type: '', position: new THREE.Vector3(), intensity: 0, lifetime: 0 };
        this.effectPool[effectIndex] = entry;
      }
      entry.type = effect.type;
      entry.position.copy(effect.position);
      entry.intensity = effect.intensity;
      entry.lifetime = effect.lifetime;
      this.effects.push(entry);
      effectIndex++;
    }
  }
}
