// NECROFALL — DESTRUCTION LEDGER (rework plan §26/§57/§73).
//
// The small authoritative record of environment-object STATES that must survive cell unload and
// be shared between peers:
//
//     objectId → state (1 intact, 2 damaged, 3 destroyed)
//
// Object ids are deterministic (`environmentObjectId(cell, kind, slot)` — plan §59), so the host
// only ever broadcasts id + state; every client derives WHICH tree/crate that is from its own
// world generation (plan §26/§73: "network only treeId and state").
export type DestructionState = 1 | 2 | 3;

export const STATE_INTACT: DestructionState = 1;
export const STATE_DAMAGED: DestructionState = 2;
export const STATE_DESTROYED: DestructionState = 3;

export class DestructionLedger {
  private readonly states = new Map<number, DestructionState>();
  /** Changes not yet broadcast (host) / not yet applied visually (client queue drain). */
  private dirty: number[] = [];

  get(id: number): DestructionState | undefined {
    return this.states.get(id);
  }

  /** Records a new state; returns true when it actually changed. */
  set(id: number, state: DestructionState): boolean {
    const prev = this.states.get(id);
    if (prev === state) return false;
    this.states.set(id, state);
    this.dirty.push(id, state);
    return true;
  }

  /** Drains the change list (host broadcast / telemetry). */
  drain(): { ids: number[]; states: DestructionState[] } {
    const ids: number[] = [];
    const states: DestructionState[] = [];
    for (let i = 0; i < this.dirty.length; i += 2) {
      ids.push(this.dirty[i]);
      states.push(this.dirty[i + 1] as DestructionState);
    }
    this.dirty = [];
    return { ids, states };
  }

  /** Applies a network batch without re-queueing it. */
  applyNetwork(ids: readonly number[], states: readonly DestructionState[]): void {
    for (let i = 0; i < ids.length; i++) this.states.set(ids[i], states[i]);
  }

  /** Serialises the whole ledger (for a mid-match joiner's late sync). */
  serialise(): { ids: number[]; states: DestructionState[] } {
    const ids: number[] = [];
    const states: DestructionState[] = [];
    this.states.forEach((state, id) => {
      ids.push(id);
      states.push(state);
    });
    return { ids, states };
  }

  get size(): number {
    return this.states.size;
  }
}
