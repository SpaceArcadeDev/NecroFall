/**
 * NECROFALL — global shader time (folio `Time.js` port, trimmed).
 *
 * Owns the `uTime` uniform every animated material/pass reads, so a single
 * number drives radioactive pulses, wind and post effects coherently.
 */
import { uniform } from 'three/tsl';
import type { Ticker } from './Ticker';

export class Time {
  readonly uTime = uniform(0);

  elapsed = 0;
  delta = 0;
  timeScale = 1;

  constructor(ticker: Ticker) {
    ticker.on(0, () => this.update(ticker.delta));
  }

  private update(delta: number): void {
    this.delta = delta * this.timeScale;
    this.elapsed += this.delta;
    this.uTime.value = this.elapsed;
  }
}
