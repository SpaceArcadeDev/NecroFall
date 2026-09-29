// NECROFALL — ENVIRONMENT RENDERER (rework plan §30/§43/§45/§65/§66/§85).
//
// The draw-side composition: holds every environment system under one roof, exposes the
// category toggles the GPU-hotspot debugger needs (plan §66), and aggregates the counters the
// telemetry overlay prints (plan §65).
//
// The visibility pipeline itself (plan §30) is layered:
//
//     cells (streamer)  →  per-instance distance/LOD (shader)  →  frustum (three's own culling
//     for the terrain chunks)  →  occlusion dither (LookThroughSystem)  →  draw
//
// Draw-call shape (plan §43): one InstancedMesh per system per LOD band + terrain chunks + one
// water mesh + one weather mesh. Nothing environment-side ever creates a mesh per object.
import type { EnvironmentSystem } from '../EnvironmentContext';

export type EnvironmentCategory =
  | 'terrain'
  | 'grass'
  | 'trees'
  | 'rocks'
  | 'props'
  | 'shoreline'
  | 'water'
  | 'weather'
  | 'particles'
  | 'fog'
  | 'shadows';

interface SystemEntry {
  system: EnvironmentSystem;
  category: EnvironmentCategory;
}

export interface EnvironmentTotals {
  systems: number;
  instances: number;
  activeCells: number;
  bySystem: { name: string; instances: number; activeCells: number; note?: string }[];
}

export class EnvironmentRenderer {
  private readonly entries: SystemEntry[] = [];
  private readonly categoryVisible = new Map<EnvironmentCategory, boolean>();
  private masterVisible = true;

  add(system: EnvironmentSystem, category: EnvironmentCategory): void {
    this.entries.push({ system, category });
    if (!this.categoryVisible.has(category)) this.categoryVisible.set(category, true);
  }

  /** True when the category should be drawn (F10 hotspot toggles flip these — plan §66). */
  setCategoryVisible(category: EnvironmentCategory, visible: boolean): void {
    this.categoryVisible.set(category, visible);
    for (const entry of this.entries) {
      if (entry.category === category) entry.system.setVisible(visible && this.masterVisible);
    }
  }

  isCategoryVisible(category: EnvironmentCategory): boolean {
    return this.categoryVisible.get(category) ?? true;
  }

  /** Watchdog / rescue path: hide ALL environment systems at once (plan §47). */
  setVisible(visible: boolean): void {
    this.masterVisible = visible;
    for (const entry of this.entries) {
      entry.system.setVisible(visible && (this.categoryVisible.get(entry.category) ?? true));
    }
  }

  /** Cycling helper for the hotspot debugger. */
  categories(): EnvironmentCategory[] {
    return [...this.categoryVisible.keys()];
  }

  /** Per-frame update for every system (uniform-only work — plan §71). */
  update(dt: number): void {
    for (const entry of this.entries) entry.system.update(dt);
  }

  totals(): EnvironmentTotals {
    const bySystem: EnvironmentTotals['bySystem'] = [];
    let instances = 0;
    let activeCells = 0;
    for (const entry of this.entries) {
      const stats = entry.system.stats();
      instances += stats.instances;
      activeCells += stats.activeCells;
      bySystem.push({ name: entry.system.name, instances: stats.instances, activeCells: stats.activeCells, note: stats.note });
    }
    return { systems: this.entries.length, instances, activeCells, bySystem };
  }

  disposeAll(): void {
    for (const entry of this.entries) entry.system.dispose();
    this.entries.length = 0;
  }
}
