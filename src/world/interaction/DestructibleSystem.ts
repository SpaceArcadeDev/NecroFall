// NECROFALL — DESTRUCTIBLE SYSTEM (rework plan §26/§57/§73).
//
// The authority that turns damage into STATE. Environment objects register damage through their
// own systems (trees: hp 100 → damaged at ≤75 → destroyed at ≤40; props: hp 100 → damaged ≤55 →
// destroyed at 0 — plan §57), and this system:
//
//   * records every change in the `DestructionLedger` under the object's deterministic id;
//   * hands the host a dirty list to broadcast (`{t:'env', l, s}` — id + state only, plan §26);
//   * applies incoming network batches back into every system (a destroyed tree stays destroyed
//     even for players who never saw it alive — plan §73).
import type { DestructionState } from './DestructionLedger';
import type { EnvironmentContext } from '../EnvironmentContext';
import type { TreeSystem } from '../foliage/TreeSystem';
import type { PropSystem } from '../props/PropSystem';

export interface DestructionBatch {
  ids: number[];
  states: DestructionState[];
}

export class DestructibleSystem {
  constructor(
    private readonly ctx: EnvironmentContext,
    readonly trees: TreeSystem,
    readonly props: PropSystem
  ) {}

  /** Host-side drain: everything that changed since the last network tick. */
  drainChanges(): DestructionBatch {
    return this.ctx.ledger.drain();
  }

  /** Client-side application of a host batch (also used for late-join reconciliation). */
  applyNetwork(batch: DestructionBatch): void {
    this.ctx.ledger.applyNetwork(batch.ids, batch.states);
    for (let i = 0; i < batch.ids.length; i++) {
      const id = batch.ids[i];
      const state = batch.states[i];
      // Kind tag lives in the top bits of the id (see environmentObjectId).
      const kind = (id >>> 28) & 0xf;
      if (kind === 2) this.trees.applyNetworkState(id, state);
      else if (kind === 3) this.props.applyNetworkState(id, state);
    }
  }

  /** Full state for a mid-match joiner (host sends once after admission). */
  serialise(): DestructionBatch {
    return this.ctx.ledger.serialise();
  }

  get changedCount(): number {
    return this.ctx.ledger.size;
  }
}
