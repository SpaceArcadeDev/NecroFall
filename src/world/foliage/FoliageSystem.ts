// NECROFALL — FOLIAGE SYSTEM (rework plan §7-§11/§87).
//
// The vegetation facade: grass + trees + rocks behind one handle. The individual systems stay
// separate (they have different budgets, LOD strategies and lifecycles), but the world treats
// them as one layer for visibility, quality and telemetry.
import type { GrassSystem } from './GrassSystem';
import type { TreeSystem } from './TreeSystem';
import type { RockSystem } from './RockSystem';
import type { EnvironmentSystem } from '../EnvironmentContext';

export class FoliageSystem {
  constructor(
    readonly grass: GrassSystem,
    readonly trees: TreeSystem,
    readonly rocks: RockSystem
  ) {}

  systems(): EnvironmentSystem[] {
    return [this.grass, this.trees, this.rocks];
  }

  /** Total live instances across the vegetation layer. */
  instanceCount(): number {
    return this.grass.stats().instances + this.trees.stats().instances + this.rocks.stats().instances;
  }

  /** Watchdog hook: hide/show the whole layer (plan §47). */
  setVisible(visible: boolean): void {
    this.grass.setVisible(visible);
    this.trees.setVisible(visible);
    this.rocks.setVisible(visible);
  }
}
