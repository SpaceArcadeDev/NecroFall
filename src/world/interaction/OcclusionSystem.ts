// NECROFALL — OCCLUSION SYSTEM (rework plan §27/§28/§54).
//
// Fades vegetation that blocks the camera→focus line — with a DITHER, not blended transparency
// (the material's `aFade` attribute drives `envDitherDiscard`, plan §54). This file owns the fade
// bookkeeping:
//
//   * `request()`      — this object is blocking a focus, drive its fade toward the target;
//   * `beginTick()`    — called once per look-through pass;
//   * `endTick()`      — everything not requested this pass starts fading back in;
//   * `update(dt)`     — smooth lerp + ONE attribute upload per touched group (batched).
//
// Priorities (plan §28) live with the REQUESTER: LookThroughSystem only ever fades environment
// objects at or below the focus's occlusion priority, and gameplay entities (players, enemies,
// bosses, Beacons) are never registered as fadeable at all.
import type { InstancedEnvironmentGroup } from '../instancing/InstancedEnvironmentGroup';

interface FadeEntry {
  group: InstancedEnvironmentGroup;
  slot: number;
  current: number;
  target: number;
  requested: boolean;
}

export class OcclusionSystem {
  private readonly entries = new Map<number, FadeEntry>();
  private dirtyGroups = new Set<InstancedEnvironmentGroup>();

  beginTick(): void {
    this.entries.forEach(entry => { entry.requested = false; });
  }

  /** Requests a fade target (0..1) for one environment instance. */
  request(key: number, group: InstancedEnvironmentGroup, slot: number, target: number): void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { group, slot, current: 1, target: 1, requested: true };
      this.entries.set(key, entry);
    }
    entry.target = Math.min(entry.target, target);
    entry.requested = true;
  }

  endTick(): void {
    this.entries.forEach(entry => {
      if (!entry.requested && entry.target < 1) entry.target = 1;
      entry.requested = false;
    });
  }

  /** Smoothly moves every fade toward its target; uploads each touched group once. */
  update(dt: number): void {
    const rate = 5.5; // fade in/out speed (per second, exponential)
    const k = 1 - Math.exp(-rate * dt);
    this.entries.forEach(entry => {
      if (Math.abs(entry.current - entry.target) < 0.004) {
        if (entry.current !== entry.target) {
          entry.current = entry.target;
          entry.group.setFade(entry.slot, entry.current);
          this.dirtyGroups.add(entry.group);
        }
        return;
      }
      entry.current += (entry.target - entry.current) * k;
      entry.group.setFade(entry.slot, entry.current);
      this.dirtyGroups.add(entry.group);
    });
    if (this.dirtyGroups.size > 0) {
      this.dirtyGroups.forEach(g => g.commitFades());
      this.dirtyGroups.clear();
    }
  }

  /** Restores everything instantly (dispose / quality reset). */
  reset(): void {
    this.entries.forEach(entry => {
      entry.current = 1;
      entry.target = 1;
      entry.group.setFade(entry.slot, 1);
      this.dirtyGroups.add(entry.group);
    });
    this.dirtyGroups.forEach(g => g.commitFades());
    this.dirtyGroups.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.reset();
    this.entries.clear();
  }
}
