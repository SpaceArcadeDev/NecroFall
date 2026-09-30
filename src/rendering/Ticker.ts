/**
 * NECROFALL — ordered ticker (folio `Ticker.js` port, plan §43).
 *
 * One update per frame; subscribers run in an explicit PRIORITY order:
 *
 *   0   time         5   view          10  environment       998 render
 *   1   inputs       6   planet        11  grass/foliage…    999 monitoring
 *   2   prePhysics   7   wind          12+ …
 *   3   physics      8   lighting
 *   4   postPhysics  9   visibility
 *
 * Physics never lives inside a render callback (plan §42).
 */

export interface TickEvent {
  [name: string]: unknown[];
}

export class Ticker {
  elapsed = 0;
  delta = 1 / 60;
  deltaScaled = 1 / 60;
  readonly maxDelta = 1 / 20;
  scale = 1;

  private items: { priority: number; callback: () => void; order: number }[] = [];
  private order = 0;
  private sorted = false;
  private waits: [number, () => void][] = [];

  /** Registers an update callback; lower priorities run first. */
  on(priority: number, callback: () => void): () => void {
    const item = { priority, callback, order: this.order++ };
    this.items.push(item);
    this.sorted = false;
    return () => {
      const index = this.items.indexOf(item);
      if (index >= 0) this.items.splice(index, 1);
    };
  }

  /** Runs `callback` after `frames` frames. */
  wait(frames: number, callback: () => void): void {
    this.waits.push([frames, callback]);
  }

  update(delta: number): void {
    const clamped = Math.min(delta, this.maxDelta);
    this.delta = clamped;
    this.deltaScaled = clamped * this.scale;
    this.elapsed += clamped;

    for (let i = 0; i < this.waits.length; i++) {
      const wait = this.waits[i];
      wait[0]--;
      if (wait[0] <= 0) {
        wait[1]();
        this.waits.splice(i, 1);
        i--;
      }
    }

    if (!this.sorted) {
      this.items.sort((a, b) => a.priority - b.priority || a.order - b.order);
      this.sorted = true;
    }
    // copy so subscriptions may change during a tick
    for (const item of [...this.items]) item.callback();
  }
}
