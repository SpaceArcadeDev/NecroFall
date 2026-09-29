// NECROFALL — ENVIRONMENT CULLING (rework plan §19/§23/§30/§72).
//
// The cell STREAMER: decides which surface cells exist right now. Everything else follows from
// that decision — no renderable meshes, no physics bodies, no update loops outside the active
// set (plan §19).
//
// Ordering (plan §72): cells are ranked by proximity to the first focus and then the movement
// direction is accounted for implicitly (the player's own cell is always rebuilt first because
// it is nearest). A per-tick build budget keeps a sprint across a cell boundary from spiking the
// frame: the frontier fills in over a few frames instead of all at once.
//
// Deactivation is immediate (cheap: collapse instance states + free ranges), which is what keeps
// the memory and draw cost flat while running.
import * as THREE from 'three';
import type { EnvironmentCells } from '../cells/EnvironmentCells';
import type { EnvironmentSystem } from '../EnvironmentContext';

export interface StreamStats {
  active: number;
  built: number;
  dropped: number;
  lastBuilt: number;
  lastDropped: number;
}

export class EnvironmentCulling {
  private readonly activeSet = new Set<number>();
  private readonly desiredSet = new Set<number>();
  private readonly desired: number[] = [];
  private readonly statsData: StreamStats = { active: 0, built: 0, dropped: 0, lastBuilt: 0, lastDropped: 0 };
  /** Cells that failed to build last tick (out of budget) — retried before fresh ones. */
  private readonly retry: number[] = [];

  constructor(
    private readonly cells: EnvironmentCells,
    private systems: EnvironmentSystem[]
  ) {}

  setSystems(systems: EnvironmentSystem[]): void {
    this.systems = systems;
  }

  /** One streaming tick. Call at the far/streaming frequency (plan §71). */
  update(focusPoints: readonly THREE.Vector3[], radiusWorld: number, buildBudget: number): void {
    this.statsData.lastBuilt = 0;
    this.statsData.lastDropped = 0;
    if (focusPoints.length === 0) return;

    this.cells.activeCells(focusPoints, radiusWorld, this.desired);
    this.desiredSet.clear();
    for (const cell of this.desired) this.desiredSet.add(cell);

    // --- deactivate what left the radius -------------------------------------------------------
    this.activeSet.forEach(cell => {
      if (!this.desiredSet.has(cell)) {
        for (const system of this.systems) system.deactivateCell(cell);
        this.activeSet.delete(cell);
        this.statsData.dropped++;
        this.statsData.lastDropped++;
      }
    });

    // --- activate up to budget, retries first --------------------------------------------------
    let budget = buildBudget;
    for (let i = 0; i < this.retry.length && budget > 0; ) {
      const cell = this.retry[i];
      if (!this.desiredSet.has(cell) || this.activeSet.has(cell)) {
        this.retry.splice(i, 1);
        continue;
      }
      if (this.tryBuild(cell)) {
        this.retry.splice(i, 1);
        budget--;
      } else {
        i++;
      }
    }
    for (const cell of this.desired) {
      if (budget <= 0) break;
      if (this.activeSet.has(cell)) continue;
      if (this.tryBuild(cell)) budget--;
      else {
        this.retry.push(cell);
        if (this.retry.length > 24) this.retry.shift();
      }
    }
    this.statsData.active = this.activeSet.size;
  }

  private tryBuild(cell: number): boolean {
    let builtAny = false;
    for (const system of this.systems) {
      if (!system.activateCell(cell)) {
        // Roll back systems that already committed for this cell and defer the whole cell.
        if (builtAny) {
          for (const rollback of this.systems) rollback.deactivateCell(cell);
        }
        return false;
      }
      builtAny = true;
    }
    this.activeSet.add(cell);
    this.statsData.built++;
    this.statsData.lastBuilt++;
    return true;
  }

  isActive(cell: number): boolean {
    return this.activeSet.has(cell);
  }

  /** The live cell set (read-only). */
  activeCells(): ReadonlySet<number> {
    return this.activeSet;
  }

  get activeCount(): number {
    return this.activeSet.size;
  }

  stats(): StreamStats {
    return this.statsData;
  }

  /** Tears every active cell down (world dispose / match end). */
  clear(): void {
    this.activeSet.forEach(cell => {
      for (const system of this.systems) system.deactivateCell(cell);
    });
    this.activeSet.clear();
    this.retry.length = 0;
  }
}
