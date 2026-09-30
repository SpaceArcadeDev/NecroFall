/**
 * NECROFALL — fixed-step physics driver (plan §42).
 *
 * The sim advances in fixed 1/60 s steps from the ticker's `physics` stage;
 * gameplay runs pre/post around it and rendering NEVER owns physics. An
 * accumulator with a bounded substep count keeps the world stable when a frame
 * hitches.
 */
export class Physics {
  readonly fixedDelta = 1 / 60;
  readonly maxSubSteps = 4;

  private accumulator = 0;
  private readonly steps: ((delta: number) => void)[] = [];

  /** Registers a fixed-step system (player, future enemies/projectiles). */
  onStep(callback: (delta: number) => void): () => void {
    this.steps.push(callback);
    return () => {
      const index = this.steps.indexOf(callback);
      if (index >= 0) this.steps.splice(index, 1);
    };
  }

  advance(delta: number): void {
    this.accumulator += Math.min(delta, 0.25);
    let count = 0;
    while (this.accumulator >= this.fixedDelta && count < this.maxSubSteps) {
      for (const step of this.steps) step(this.fixedDelta);
      this.accumulator -= this.fixedDelta;
      count++;
    }
    if (count === this.maxSubSteps) this.accumulator = 0; // drop the backlog
  }
}
