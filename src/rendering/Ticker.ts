// NECROFALL — the ordered ticker (plan §43, §44): Folio's Ticker.js ported to TypeScript.
//
// One frame is one ordered sequence of stages. Folio's canonical ordering:
//
//   0    Time
//   1    Inputs
//   2    Gameplay pre-physics
//   3    Physics
//   4    Gameplay post-physics
//   5    View
//   6    Planet state
//   7    Wind
//   8    Lighting
//   9    Environment visibility
//   10   Terrain
//   11   Grass
//   12   Foliage
//   13   Puddles
//   14   Radioactive crystals
//   15   Particles
//   16   Gameplay VFX
//   998  Rendering
//   999  Monitoring
//
// The game's monolithic `Game.update()` (frozen gameplay — plan §1) runs BEFORE the ticker stages
// of its frame, and the renderer subscribes at 998, so the frame the renderer paints is always
// built from this frame's simulation.
//
// The ticker also owns the shader time uniforms (`elapsed`/`delta`), exactly like Folio's.
import { uniform } from 'three/tsl';

type TickCallback = (ticker: Ticker) => void;

interface Subscription {
  order: number;
  callback: TickCallback;
}

/** Canonical stage orders — anything subscribing to the ticker should name a stage. */
export const TICK = {
  TIME: 0,
  INPUT: 1,
  PRE_PHYSICS: 2,
  PHYSICS: 3,
  POST_PHYSICS: 4,
  VIEW: 5,
  PLANET: 6,
  WIND: 7,
  LIGHTING: 8,
  ENVIRONMENT_VISIBILITY: 9,
  TERRAIN: 10,
  GRASS: 11,
  FOLIAGE: 12,
  PUDDLES: 13,
  CRYSTALS: 14,
  PARTICLES: 15,
  GAMEPLAY_VFX: 16,
  RENDERING: 998,
  MONITORING: 999,
} as const;

export class Ticker {
  /** Seconds since the ticker started (the world's animation clock). */
  elapsed = 0;
  /** This frame's delta in seconds, clamped to `maxDelta`. */
  delta = 1 / 60;
  /** Clamp matching the game loop's own dt clamp (0.05 s) so both halves agree on time. */
  maxDelta = 0.05;
  /** Global time scale (bullet time etc.). 1 = real time. */
  scale = 1;
  deltaScaled = 1 / 60;
  elapsedScaled = 0;

  /** Folio's frame waits: `[framesLeft, callback]`. */
  private readonly waits: Array<[number, () => void]> = [];
  private readonly lastDeltas: number[] = [];
  deltaAverage = 1 / 60;

  /** Shader time uniforms — materials read THESE, never their own clocks. */
  readonly elapsedUniform = uniform(0);
  readonly deltaUniform = uniform(1 / 60);
  readonly elapsedScaledUniform = uniform(0);
  readonly deltaScaledUniform = uniform(1 / 60);

  private readonly subscriptions: Subscription[] = [];
  private sorted = false;

  /** Subscribe to the ordered tick. Returns the unsubscribe function. */
  on(order: number, callback: TickCallback): () => void {
    const subscription: Subscription = { order, callback };
    this.subscriptions.push(subscription);
    this.sorted = false;

    return () => {
      const index = this.subscriptions.indexOf(subscription);
      if (index !== -1) this.subscriptions.splice(index, 1);
    };
  }

  /** Folio's `wait`: run `callback` after `frames` processed frames. */
  wait(frames: number, callback: () => void): void {
    this.waits.push([frames, callback]);
  }

  /**
   * Advance the ticker by `dt` seconds (already clamped by the caller) and run every stage in
   * order. Called once per PROCESSED frame — a paced-out frame must not call this.
   */
  update(dt: number): void {
    this.delta = Math.min(dt, this.maxDelta);
    this.elapsed += this.delta;
    this.deltaScaled = this.delta * this.scale;
    this.elapsedScaled += this.deltaScaled;

    this.lastDeltas.unshift(this.delta);
    if (this.lastDeltas.length > 30) this.lastDeltas.length = 30;
    let total = 0;
    for (const value of this.lastDeltas) total += value;
    this.deltaAverage = total / this.lastDeltas.length;

    this.elapsedUniform.value = this.elapsed;
    this.deltaUniform.value = this.delta;
    this.elapsedScaledUniform.value = this.elapsedScaled;
    this.deltaScaledUniform.value = this.deltaScaled;

    for (let i = 0; i < this.waits.length; i++) {
      const wait = this.waits[i];
      wait[0]--;
      if (wait[0] === 0) {
        wait[1]();
        this.waits.splice(i, 1);
        i--;
      }
    }

    if (!this.sorted) {
      this.subscriptions.sort((a, b) => a.order - b.order);
      this.sorted = true;
    }
    for (const subscription of this.subscriptions) subscription.callback(this);
  }
}
