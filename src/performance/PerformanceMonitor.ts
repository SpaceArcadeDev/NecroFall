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
      const flag = new URLSearchParams(window.location.search).get('debug');
      PerformanceMonitor.enabled = flag === 'true' || flag === '1';
    } catch {
      PerformanceMonitor.enabled = false;
    }
    if (PerformanceMonitor.enabled) console.info('[perf] PerformanceMonitor on — logging every 60 frames');
  }

  /** `gapMs` is the wall-clock interval since the previous PROCESSED frame (pacing included). */
  static beginFrame(gapMs: number): void {
    if (!PerformanceMonitor.enabled) return;
    PerformanceMonitor.frameStart = performance.now();
    PerformanceMonitor.gapMs += (gapMs - PerformanceMonitor.gapMs) * 0.2;
  }

  static beginUpdate(): void {
    if (!PerformanceMonitor.enabled) return;
    PerformanceMonitor.updateStart = performance.now();
  }

  /** Closes the update block and opens the render block. */
  static beginRender(): void {
    if (!PerformanceMonitor.enabled) return;
    const now = performance.now();
    PerformanceMonitor.updateMs += (now - PerformanceMonitor.updateStart - PerformanceMonitor.updateMs) * 0.2;
    PerformanceMonitor.renderStart = now;
  }

  static endRender(renderer: RendererLike, phase: string, quality: string): void {
    if (!PerformanceMonitor.enabled) return;
    const now = performance.now();
    PerformanceMonitor.renderMs += (now - PerformanceMonitor.renderStart - PerformanceMonitor.renderMs) * 0.2;
    PerformanceMonitor.workMs += (now - PerformanceMonitor.frameStart - PerformanceMonitor.workMs) * 0.2;
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
      calls: info.render.calls,
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
}
