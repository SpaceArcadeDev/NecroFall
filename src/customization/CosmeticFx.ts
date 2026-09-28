// NECROFALL — the one-shot cosmetic FX runner: plays RECALL / SPAWN / ELIMINATED effects in the
// world. One instance lives on the Game (world FX) and one on the customize stage (the looped
// preview). Each playback builds the catalog model fresh, drops it at the trigger point oriented
// to the local "up", ticks it with ELAPSED time and disposes everything when its `duration` runs
// out — nothing leaks, nothing needs pooling: these fire a handful of times per match.
import * as THREE from 'three';
import { AccessoryBuild, EffectCategory } from './AccessoryTypes';
import { defAt } from './AccessoryCatalog';
import { disposeObject } from './AvatarAccessories';

const _up = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);

interface LiveFx {
  build: AccessoryBuild;
  /** Seconds this playback has run. */
  t: number;
  /** Total seconds until disposal. */
  dur: number;
}

export class CosmeticFxRunner {
  private live: LiveFx[] = [];

  /**
   * `max` concurrent playbacks: past it the OLDEST is evicted (its visuals have faded the most),
   * so a ten-player match start still shows the arrivals instead of silently dropping them.
   */
  constructor(private scene: THREE.Scene, private max = 8) {}

  /** True while any playback is running (used by the customize stage's replays). */
  get active(): number {
    return this.live.length;
  }

  /**
   * Plays effect `idx` of `cat` at `pos`, standing on the surface normal `up`. False when the
   * slot is empty (or out of range) — the caller can treat that as "nothing to show".
   */
  play(cat: EffectCategory, idx: number, pos: THREE.Vector3, up: THREE.Vector3): boolean {
    const def = defAt(cat, idx);
    if (!def || !def.duration) return false;
    if (this.live.length >= this.max) this.drop(0);
    const build = def.build();
    build.group.scale.setScalar(def.scale ?? 1);
    build.group.position.copy(pos);
    _up.copy(up);
    if (_up.lengthSq() < 1e-8) _up.copy(_yAxis);
    else _up.normalize();
    _q.setFromUnitVectors(_yAxis, _up);
    build.group.quaternion.copy(_q);
    // Pose frame zero NOW: between `play` and the first `update` the group would otherwise render
    // with every piece stacked at the origin for one frame.
    build.tick?.(0.001, 0.001);
    this.scene.add(build.group);
    this.live.push({ build, t: 0, dur: def.duration });
    return true;
  }

  /** Per-frame advance: ticks every live playback and disposes the expired ones. */
  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i];
      e.t += dt;
      if (e.t >= e.dur) {
        this.drop(i);
        continue;
      }
      e.build.tick?.(e.t, dt);
    }
  }

  /** Kills every live playback at once (match teardown, mode switches). */
  clear(): void {
    while (this.live.length > 0) this.drop(this.live.length - 1);
  }

  private drop(i: number): void {
    const e = this.live[i];
    this.live.splice(i, 1);
    e.build.group.removeFromParent();
    disposeObject(e.build.group);
    e.build.dispose?.();
  }
}
