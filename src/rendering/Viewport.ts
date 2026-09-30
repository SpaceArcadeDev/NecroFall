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

  constructor(private readonly domElement: HTMLElement) {
    this.measure();
    window.addEventListener('resize', this.onResize);
  }

  measure(): void {
    const bounding = this.domElement.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(bounding.width));
    this.height = Math.max(1, Math.floor(bounding.height));
    this.ratio = this.width / this.height;
    this.pixelRatioPure = window.devicePixelRatio || 1;
    this.pixelRatio = Math.min(this.pixelRatioPure, this.pixelRatioMax);
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
    this.measure();
    this.events.trigger('change');

    if (this.throttleTimeout !== null) window.clearTimeout(this.throttleTimeout);
    this.throttleTimeout = window.setTimeout(() => {
      this.throttleTimeout = null;
      // Between `change` and `throttleChange` the expensive rebuilds wait for
      // the drag to settle (folio parity).
      this.events.trigger('throttleChange');
    }, 400);
  };

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    if (this.throttleTimeout !== null) window.clearTimeout(this.throttleTimeout);
    this.events.clear();
  }
}
