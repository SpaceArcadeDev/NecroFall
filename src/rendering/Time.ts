// NECROFALL — environment time (plan §43 stage 0): Folio's Time.js responsibility without the
// portfolio-specific bullet-time/gsap half (NecroFall's gameplay has its own pacing).
//
// `Time` owns the WORLD's global time scale and its pause state, and subscribes at stage 0 so
// everything downstream reads this frame's time. The actual clock/uniform drive lives in
// `FOLIO.update()` (shared shader globals) — this module only decides what the scale IS.
import { Ticker, TICK } from './Ticker';

export class Time {
  /** Scale the world animates at (1 = real time). */
  private _scale = 1;
  /** When false the environment clock stands still (menus / hidden matches). */
  active = true;

  constructor(private readonly ticker: Ticker) {
    ticker.on(TICK.TIME, () => this.update());
  }

  get scale(): number {
    return this._scale;
  }

  set scale(value: number) {
    this._scale = value;
    this.ticker.scale = value;
  }

  private update(): void {
    // Nothing to drive here yet beyond the scale handshake: the shared `FOLIO` state advances
    // its own wind clock inside `FOLIO.update(dt, cameraPos)` (the folio-exact drive). When the
    // world layer finishes its migration into `src/rendering/Environment`, this stage will own
    // that clock call directly.
    void this.active;
  }
}
