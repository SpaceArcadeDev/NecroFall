// NECROFALL — quality (plan §7, §83): ONE renderer for the whole game; quality never forks into a
// second renderer — it only moves a handful of presentation knobs:
//
//   pixel ratio · bloom mip count · DOF · grass density · foliage distance ·
//   shadow map resolution · particle count
//
// Folio's Quality.js carries a single 0|1 level (`0` = highest) plus a change event; the detailed
// budgets (grass/foliage/shadow/particles) live in the game's `QualitySettings` presets, which
// the world systems already consume. This module is the renderer-facing half: it maps the preset
// to a level and tells `Rendering` what the post chain should look like, and it reports the
// plan's knob defaults when asked.
export type QualityLevel = 0 | 1;

export class Quality {
  private _level: QualityLevel = 0;
  private readonly listeners = new Set<(level: QualityLevel) => void>();

  constructor(level: QualityLevel = 0) {
    this._level = level;
  }

  get level(): QualityLevel {
    return this._level;
  }

  setLevel(level: QualityLevel): void {
    if (level === this._level) return;
    this._level = level;
    for (const listener of this.listeners) listener(this._level);
  }

  onChange(callback: (level: QualityLevel) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Depth of field only exists on the high level — the first thing rescue strips is DOF. */
  depthOfField(): boolean {
    return this._level === 0;
  }

  /** Bloom mip chain length (folio: 5 at high, 2 at low — fewer mips = cheaper, tighter glow). */
  bloomMipCount(): number {
    return this._level === 0 ? 5 : 2;
  }

  /** Pixel-ratio ceiling the viewport should clamp to for this level. */
  pixelRatioCeiling(): number {
    return this._level === 0 ? 2 : 1.5;
  }

  /** Plan §7 defaults (used when the game's preset does not own the knob). */
  grassDensity(): number {
    return this._level === 0 ? 280 : 180;
  }

  foliageDistance(): number {
    return this._level === 0 ? 70 : 45;
  }

  shadowMapSize(): number {
    return this._level === 0 ? 2048 : 512;
  }

  particleMultiplier(): number {
    return this._level === 0 ? 1 : 0.55;
  }
}

/** Maps the game's graphics preset onto the renderer's quality level (0 = highest). */
export function qualityLevelForPreset(name: string): QualityLevel {
  return name === 'ultra' || name === 'high' ? 0 : 1;
}
