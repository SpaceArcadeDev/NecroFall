// NECROFALL — peer clock alignment.
//
// Positions travel with the *sender's* timestamp instead of being stamped on arrival. That matters:
// a packet delayed by 40 ms would otherwise look 40 ms slower than the one before it, and motion
// interpolated between two such stamps visibly wobbles in speed even on a fast link. With sender
// timestamps the samples sit on one even timeline and only the moment a packet becomes *available*
// is jittery — which is exactly what the interpolation buffer exists to absorb.
//
// Each peer owns a monotonic clock (`performance.now()`, per document) at the same rate as ours, so
// the two are related by a constant offset. That offset is the smallest difference we have seen
// recently: the sample that travelled the least is the closest to the sender's true time. The same
// window also tells us how far the delay of this stream swings, which is how much buffer the
// interpolation needs on top of its base.
export class ClockSync {
  /** Recent `local - sender` differences, dropped once they fall out of the window. */
  private diffs: { at: number; d: number }[] = [];
  private lo = 0;
  private hi = 0;
  private ready = false;
  /** Seconds of history the minimum/maximum are taken over. */
  private static readonly WINDOW = 3;

  /** Feed every packet that carries its sender's time (both in seconds). */
  observe(senderTime: number, localTime: number): void {
    if (!Number.isFinite(senderTime) || !Number.isFinite(localTime)) return;
    this.diffs.push({ at: localTime, d: localTime - senderTime });
    while (this.diffs.length > 1 && localTime - this.diffs[0].at > ClockSync.WINDOW) this.diffs.shift();
    let lo = this.diffs[0].d;
    let hi = lo;
    for (const s of this.diffs) {
      if (s.d < lo) lo = s.d;
      if (s.d > hi) hi = s.d;
    }
    this.lo = lo;
    this.hi = hi;
    this.ready = true;
  }

  /** True once a packet has been seen: before that there is nothing to map from. */
  get synced(): boolean {
    return this.ready;
  }

  /** The sender's time, expressed on our clock. */
  toLocal(senderTime: number): number {
    return senderTime + this.lo;
  }

  /** How unevenly this stream's packets arrive (seconds) — the buffer has to cover it. */
  get spread(): number {
    return Math.max(0, this.hi - this.lo);
  }
}
