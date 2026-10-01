/**
 * NECROFALL — viewport (folio `Viewport.js` port).
 *
 * ONE owner for width / height / pixel ratio. Environment systems read the
 * ratio from here and never compute their own DPR (plan §88).
 */
import { Events } from './Events';

export class Viewport {
  readonly events = new Events();

  /** CSS pixels. */
  width = 1;
  height = 1;
  ratio = 1;
  /** `devicePixelRatio` before clamping. */
  pixelRatioPure = 1;
  /** Clamp owned by the Quality level. */
  pixelRatioMax = 2;
  /** Clamped device pixel ratio actually used by the renderer. */
  pixelRatio = 1;

  private throttleTimeout: number | null = null;
  /** Deferred settle timers for Android rotation (fullscreen/orientation-lock land late). */
  private settleTimers: number[] = [];

  constructor() {
    this.measure();
    window.addEventListener('resize', this.onResize);
    // Android Chrome fires resize OR orientationchange depending on the mood (and the final
    // layout can settle a beat after BOTH when fullscreen/orientation-lock ride along), so
    // both events are watched and a delayed re-measure settles the true final size.
    window.addEventListener('orientationchange', this.onResize);
  }

  /**
   * The page viewport — NOT the canvas box. The renderer writes its pixel size back onto the
   * canvas element itself, so measuring the canvas made the size self-locking: a phone that
   * booted in portrait stayed at portrait width after rotating to landscape — the in-game view
   * filling less than half the screen (Android bug report). The document viewport is always
   * the truth.
   */
  measure(): void {
    const size = Viewport.readViewport();
    this.width = size.width;
    this.height = size.height;
    this.ratio = this.width / this.height;
    this.pixelRatioPure = window.devicePixelRatio || 1;
    this.pixelRatio = Math.min(this.pixelRatioPure, this.pixelRatioMax);
  }

  private static readViewport(): { width: number; height: number } {
    const doc = document.documentElement;
    return {
      width: Math.max(1, Math.floor(doc.clientWidth || window.innerWidth || 1)),
      height: Math.max(1, Math.floor(doc.clientHeight || window.innerHeight || 1)),
    };
  }

  /** Quality changes the DPR clamp → re-measure and notify. */
  setPixelRatioMax(max: number): void {
    if (max === this.pixelRatioMax) return;
    this.pixelRatioMax = max;
    this.measure();
    this.events.trigger('change');
    this.events.trigger('throttleChange');
  }

  private onResize = (): void => {
    this.applyResize();
    // Rotation settles late on Android (fullscreen + orientation lock complete AFTER the event):
    // re-check shortly after, and only react when the size really changed. A new resize event
    // supersedes any pending settle.
    for (const id of this.settleTimers) window.clearTimeout(id);
    this.settleTimers.length = 0;
    for (const delay of [120, 450]) {
      this.settleTimers.push(
        window.setTimeout(() => {
          const size = Viewport.readViewport();
          if (size.width !== this.width || size.height !== this.height) this.applyResize();
        }, delay),
      );
    }
  };

  private applyResize(): void {
    this.measure();
    this.events.trigger('change');

    if (this.throttleTimeout !== null) window.clearTimeout(this.throttleTimeout);
    this.throttleTimeout = window.setTimeout(() => {
      this.throttleTimeout = null;
      // Between `change` and `throttleChange` the expensive rebuilds wait for
      // the drag to settle (folio parity).
      this.events.trigger('throttleChange');
    }, 400);
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    if (this.throttleTimeout !== null) window.clearTimeout(this.throttleTimeout);
    for (const id of this.settleTimers) window.clearTimeout(id);
    this.settleTimers.length = 0;
    this.events.clear();
  }
}
