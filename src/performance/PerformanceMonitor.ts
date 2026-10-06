// NECROFALL — development-only frame monitor (plan §0, enabled with `?debug=true`).
//
// Zero cost when off: every entry point early-returns unless the page was opened with
// `?debug=true` (`?debug=1` also works). When on, it times the update and render blocks of the
// main loop and logs a compact line every 60 processed frames with the numbers the thermal work
// is judged by: frame/update/render ms, fps, draw calls, triangles/points/lines, live
// geometries/textures, pixel ratio and the canvas buffer size. "DO NOT leave verbose logging
// enabled in production" — hence the query-flag gate rather than a build-time toggle.
//
// Deliberately separate from the F1 overlay: F1 is a developer readout on screen, this logs to
// the console, so a phone (or a remote-debug session) can be watched without pressing keys.
import { Vector2 } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { PerfChecklist, frameDrawCalls } from './PerfChecklist';

/**
 * Both renderer generations expose the fields this monitor reads (info counters, DPR and the
 * drawing buffer size) — the WebGPU renderer is the game's main one, the WebGL types only kept
 * for callers that still hold the legacy type.
 */
type RendererLike = WebGPURenderer | {
  info: { render: { calls: number; triangles: number; points: number; lines: number }; memory: { geometries: number; textures: number } };
  getPixelRatio(): number;
  getDrawingBufferSize(target: Vector2): Vector2;
};

export class PerformanceMonitor {
  /** Set by `init()` when `?debug=true` is present. Everything below is a no-op otherwise. */
  static enabled = false;

  /**
   * `?stresstest=1` (seconds can be overridden, `?stresstest=45`): the mobile plan §58 harness.
   * The monitor then records every processed frame for the run length and prints ONE summary —
   * average FPS, 1 % low, average/peak frame time, the last renderer counters (calls/triangles/
   * textures) and the render resolution — instead of the rolling 60-frame lines. Run it on a
   * real device, in a live match, with the combat at full tilt: "Do not optimize based on the
   * main menu."
   */
  private static stress = false;
  private static stressSeconds = 30;
  private static stressStart = 0;
  private static stressLast = 0;
  private static stressTimes: number[] = [];

  private static frameStart = 0;
  private static updateStart = 0;
  private static renderStart = 0;
  /** Smoothed time between PROCESSED frames — the pacing-aware interval (1000/gap = fps). */
  private static gapMs = 16.7;
  /** Smoothed CPU cost of one processed frame (update + render). */
  private static workMs = 0;
  private static updateMs = 0;
  private static renderMs = 0;
  private static frames = 0;
  private static readonly size = new Vector2();

  static init(): void {
    try {
      const params = new URLSearchParams(window.location.search);
      const flag = params.get('debug');
      PerformanceMonitor.enabled = flag === 'true' || flag === '1';
      const stress = params.get('stresstest');
      if (stress !== null) {
        const parsed = Number.parseFloat(stress);
        PerformanceMonitor.stressSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
        PerformanceMonitor.stress = true;
        PerformanceMonitor.enabled = true;
        PerformanceMonitor.stressStart = performance.now();
        PerformanceMonitor.stressTimes = [];
      }
    } catch {
      PerformanceMonitor.enabled = false;
      PerformanceMonitor.stress = false;
    }
    if (PerformanceMonitor.enabled) {
      console.info(
        PerformanceMonitor.stress
          ? `[perf] PerformanceMonitor on — STRESS TEST for ${PerformanceMonitor.stressSeconds}s, then one summary`
          : '[perf] PerformanceMonitor on — logging every 60 frames'
      );
    }
  }

  /** Last frame gap — also feeds the §120 budget checklist when `?perfcheck` is on. */
  private static checkGapMs = 16.7;

  /** `gapMs` is the wall-clock interval since the previous PROCESSED frame (pacing included). */
  static beginFrame(gapMs: number): void {
    PerformanceMonitor.checkGapMs = gapMs;
    if (!PerformanceMonitor.enabled && !PerfChecklist.enabled) return;
    PerformanceMonitor.frameStart = performance.now();
    PerformanceMonitor.gapMs += (gapMs - PerformanceMonitor.gapMs) * 0.2;
  }

  static beginUpdate(): void {
    if (!PerformanceMonitor.enabled && !PerfChecklist.enabled) return;
    PerformanceMonitor.updateStart = performance.now();
  }

  /** Closes the update block and opens the render block. */
  static beginRender(): void {
    if (!PerformanceMonitor.enabled && !PerfChecklist.enabled) return;
    const now = performance.now();
    PerformanceMonitor.updateMs += (now - PerformanceMonitor.updateStart - PerformanceMonitor.updateMs) * 0.2;
    PerformanceMonitor.renderStart = now;
  }

  static endRender(renderer: RendererLike, phase: string, quality: string): void {
    if (!PerformanceMonitor.enabled && !PerfChecklist.enabled) return;
    const now = performance.now();
    PerformanceMonitor.renderMs += (now - PerformanceMonitor.renderStart - PerformanceMonitor.renderMs) * 0.2;
    PerformanceMonitor.workMs += (now - PerformanceMonitor.frameStart - PerformanceMonitor.workMs) * 0.2;
    if (PerfChecklist.enabled) {
      // §120 acceptance run: feed the budget checklist (works without `?debug=true`).
      // Only LIVE MATCH frames are sampled — a menu's paced frames say nothing about the match.
      const info = renderer.info as { render?: { drawCalls?: number; triangles?: number } };
      PerfChecklist.sample(
        PerformanceMonitor.checkGapMs,
        now - PerformanceMonitor.frameStart,
        frameDrawCalls(info),
        info?.render?.triangles ?? 0,
        phase === 'playing',
      );
    }
    if (!PerformanceMonitor.enabled) return;
    if (PerformanceMonitor.stress) {
      // Raw per-frame interval for the stress statistics (1 % low, peak), capped so a
      // 30-60 s run can never grow without bound.
      const rawGap = PerformanceMonitor.stressLast > 0 ? now - PerformanceMonitor.stressLast : 16.7;
      PerformanceMonitor.stressLast = now;
      if (PerformanceMonitor.stressTimes.length < 7200) PerformanceMonitor.stressTimes.push(rawGap);
      if ((now - PerformanceMonitor.stressStart) / 1000 >= PerformanceMonitor.stressSeconds) {
        PerformanceMonitor.finishStress(renderer, phase);
      }
    }
    PerformanceMonitor.frames++;
    if (PerformanceMonitor.frames < 60) return;
    PerformanceMonitor.frames = 0;
    const info = renderer.info;
    const size = renderer.getDrawingBufferSize(PerformanceMonitor.size);
    console.log('[perf]', {
      fps: PerformanceMonitor.gapMs > 0 ? Math.round(1000 / PerformanceMonitor.gapMs) : 0,
      frameMs: +PerformanceMonitor.gapMs.toFixed(2),
      workMs: +PerformanceMonitor.workMs.toFixed(2),
      updateMs: +PerformanceMonitor.updateMs.toFixed(2),
      renderMs: +PerformanceMonitor.renderMs.toFixed(2),
      // `render.calls` is CUMULATIVE in three's Info — the per-frame number is `drawCalls`.
      calls: frameDrawCalls(info),
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      pixelRatio: renderer.getPixelRatio(),
      canvas: `${size.x}x${size.y}`,
      phase,
      quality,
    });
  }

  /** One summary line for the whole stress run — the §58 record (avg / 1 % low / peak + counters). */
  private static finishStress(renderer: RendererLike, phase: string): void {
    PerformanceMonitor.stress = false;
    const times = PerformanceMonitor.stressTimes;
    if (times.length === 0) {
      console.log('[stresstest] no frames recorded');
      return;
    }
    const sorted = [...times].sort((a, b) => a - b);
    const count = times.length;
    let total = 0;
    for (const ms of times) total += ms;
    const avgMs = total / count;
    const p99ms = sorted[Math.min(count - 1, Math.floor(count * 0.99))];
    const peakMs = sorted[count - 1];
    const fpsOf = (ms: number): number => Math.round(1000 / Math.max(ms, 0.1));
    const info = renderer.info;
    const size = renderer.getDrawingBufferSize(PerformanceMonitor.size);
    console.log('[stresstest]', {
      seconds: PerformanceMonitor.stressSeconds,
      frames: count,
      avgFps: fpsOf(avgMs),
      low1PctFps: fpsOf(p99ms),
      avgMs: +avgMs.toFixed(2),
      peakMs: +peakMs.toFixed(2),
      calls: frameDrawCalls(info),
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      pixelRatio: renderer.getPixelRatio(),
      canvas: `${size.x}x${size.y}`,
      phase,
    });
  }
}
