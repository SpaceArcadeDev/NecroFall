/**
 * NECROFALL — quality levels (plan §7 + §83).
 *
 * ONE renderer. Quality only changes numbers: pixel ratio, bloom mips, DOF,
 * grass density, foliage distance, shadow map size, particle count. The
 * adaptive monitor (§83) degrades one step at a time when the frame rate stays
 * below target — quality never oscillates upward on its own.
 */
import { Events } from './Events';

export type QualityLevel = 0 | 1 | 2;

export class Quality {
  readonly events = new Events();

  level: QualityLevel = Quality.detect();

  /** Rolling frame-rate window for the heat control (plan §83). */
  private readonly frameTimes: number[] = [];
  private degradeCooldown = 3;
  /** Warmup: shader compilation hitches must never trigger a downgrade. */
  private warmup = 10;
  /** `?adaptive=0` / forced quality levels pin the level. */
  adaptive = true;

  static detect(): QualityLevel {
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    return isMobile ? 1 : 0;
  }

  changeLevel(level: QualityLevel): void {
    if (level === this.level) return;
    this.level = level;
    this.events.trigger('change', [level]);
  }

  /**
   * Called once per rendered frame. If the average FPS stays under the target
   * for a sustained stretch, drop one quality step (pixel ratio first — the
   * order is implemented cheaply here by stepping the whole level).
   */
  monitor(delta: number, target = 45): void {
    if (!this.adaptive) return;
    if (this.warmup > 0) {
      this.warmup -= delta;
      return;
    }
    if (typeof document !== 'undefined' && (document.hidden || !document.hasFocus())) {
      // throttled/occluded windows report meaningless frame times
      this.frameTimes.length = 0;
      return;
    }
    const list = this.frameTimes;
    list.push(delta);
    if (list.length > 180) list.splice(0, list.length - 180);
    if (list.length < 120 || this.degradeCooldown > 0) {
      this.degradeCooldown -= delta;
      return;
    }
    let total = 0;
    for (const value of list) total += value;
    const fps = list.length / total;
    if (fps < target && this.level < 2) {
      this.changeLevel((this.level + 1) as QualityLevel);
      this.degradeCooldown = 6;
      list.length = 0;
    }
  }

  // ------------------------------------------------------------- capability table

  pixelRatioMax(): number {
    return this.level === 0 ? 2 : this.level === 1 ? 1.5 : 1.25;
  }

  /** Grass blade cells per side (plan §14, raised to folio density). */
  grassSubdivisions(): number {
    return this.level === 0 ? 340 : this.level === 1 ? 260 : 180;
  }

  /** Grass field half extent in metres — the moving detail window (§39/§68). */
  grassHalfExtent(): number {
    return this.level === 0 ? 30 : this.level === 1 ? 24 : 18;
  }

  /** Foliage (leaf cards) fade distance. */
  foliageDistance(): number {
    return this.level === 0 ? 90 : this.level === 1 ? 65 : 42;
  }

  /** Tree trunk / bush body instance distance. */
  treeDistance(): number {
    return this.level === 0 ? 280 : this.level === 1 ? 200 : 140;
  }

  rockDistance(): number {
    return this.level === 0 ? 220 : this.level === 1 ? 160 : 110;
  }

  particleMultiplier(): number {
    return this.level === 0 ? 1 : this.level === 1 ? 0.7 : 0.5;
  }

  shadowMapSize(): number {
    return this.level === 0 ? 2048 : this.level === 1 ? 1024 : 512;
  }

  bloomMips(): number {
    return this.level === 0 ? 5 : this.level === 1 ? 3 : 2;
  }

  /** Dev override: `?dof=0` pins the DOF off regardless of level. */
  forceNoDof = false;

  dofEnabled(): boolean {
    return this.level === 0 && !this.forceNoDof;
  }
}
