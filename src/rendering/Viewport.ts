// NECROFALL — viewport (plan §88): ONE source of canvas dimensions and pixel ratio.
//
// Individual environment classes must never read `window.innerWidth` or `devicePixelRatio`
// themselves — they read THIS. Folio's Viewport.js ported 1:1 (measure + throttled resize event).
export class Viewport {
  width = 1;
  height = 1;
  ratio = 1;
  /** The panel's own DPR, unclamped (diagnostics). */
  pixelRatioPure = 1;
  /** Cap considered "the device can afford it" — the game's ladder may go lower. */
  pixelRatioMax = 2;
  /** `min(pixelRatioPure, pixelRatioMax)` — the viewport's own recommendation. */
  pixelRatio = 1;

  private readonly listeners = new Set<() => void>();
  private throttleTimeout: number | null = null;

  constructor() {
    this.measure();
    addEventListener('resize', () => {
      this.measure();
      this.emit();

      // Folio's throttle pair (`change` / `throttleChange`); one listener list is enough here.
      if (this.throttleTimeout !== null) clearTimeout(this.throttleTimeout);
      this.throttleTimeout = window.setTimeout(() => {
        this.throttleTimeout = null;
        this.emit();
      }, 400);
    });
  }

  measure(): void {
    // The canvas is always full-screen in NecroFall; window metrics are the honest source.
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.ratio = this.width / Math.max(1, this.height);

    this.pixelRatioPure = window.devicePixelRatio || 1;
    this.pixelRatio = Math.min(this.pixelRatioPure, this.pixelRatioMax);
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
