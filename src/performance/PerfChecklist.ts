/**
 * NECROFALL — performance budget checklist (mobile plan §119–§122).
 *
 * The acceptance test for the mobile overhaul: run the game (optionally under a spawned-swarm
 * load, see PerfHarness), then compare what the machine ACTUALLY did against the plan's budgets
 * and print a PASS/FAIL table — instead of judging a phone by how warm it feels.
 *
 *   ?perfcheck=1     sample 20 s of a LIVE MATCH (after a 3 s in-match warmup) and print the verdict
 *   ?perfcheck=30    sample 30 s
 *   ?swarm=400       keep ~400 Necrophages alive around the player while sampling (§120)
 *
 * Only frames from a running match ('playing') are sampled — "do not optimize based on the main
 * menu" is the plan's own rule, and a menu phase is CPU-capped by design, so its numbers say
 * nothing about the match. Dev-only: nothing here runs unless the URL says so.
 *
 * Budgets (§121, fps per the plan's targets):
 *
 *   HIGH  draws < 150   tris < 1.5 M   JS < 5 ms   fps ≥ 55
 *   MID   draws < 120   tris < 1.0 M   JS < 6 ms   fps ≥ 45
 *   LOW   draws < 80    tris < 600 k   JS < 7 ms   fps ≥ 30
 *
 * The measured JS cost is `workMs` (update + render call on the main thread) from the frame
 * monitor; draws/triangles are `renderer.info` at the sample close.
 */
import { DeviceTier, type DeviceTierName } from './DeviceTier';
import { readSwitches } from '../rendering/DebugSwitches';

export interface PerfBudget {
  draws: number;
  triangles: number;
  jsMs: number;
  fps: number;
}

export interface PerfCheckRow {
  metric: string;
  measured: string;
  budget: string;
  pass: boolean;
}

export interface PerfCheckResult {
  pass: boolean;
  rows: PerfCheckRow[];
  seconds: number;
  frames: number;
  tier: DeviceTierName;
  /** r186 plan §40/§41: scenario label, frame-pacing and memory readouts for the report. */
  context?: {
    scenario: string;
    low1PctFps: number;
    peakMs: number;
    heapDeltaMB: number | null;
    telemetry: string;
  };
}

/** Per-frame draw calls live in `info.render.drawCalls` — `info.render.calls` is cumulative
 *  since boot (three's Info class) and must never be compared against a per-frame budget. */
export interface RenderCounters {
  calls?: number;
  drawCalls?: number;
  triangles?: number;
}

export function frameDrawCalls(info: { render?: RenderCounters } | undefined): number {
  return info?.render?.drawCalls ?? 0;
}

const BUDGETS: Record<DeviceTierName, PerfBudget> = {
  high: { draws: 150, triangles: 1_500_000, jsMs: 5, fps: 55 },
  mid: { draws: 120, triangles: 1_000_000, jsMs: 6, fps: 45 },
  low: { draws: 80, triangles: 600_000, jsMs: 7, fps: 30 },
};

/** Warmup before sampling: shader compiles, world build and the first seconds of a match are
 *  not representative of sustained play. */
const WARMUP_SECONDS = 3;

export class PerfChecklist {
  static enabled = false;
  private static seconds = 20;
  /** When sampling started (first in-match frame + warmup); 0 = no match frame seen yet. */
  private static sampleStart = 0;
  private static frames = 0;
  private static sumGap = 0;
  private static sumWork = 0;
  private static lastCalls = 0;
  private static lastTriangles = 0;
  private static result: PerfCheckResult | null = null;
  /** r186 plan §41: 1 % low / peak need the gap DISTRIBUTION — bounded (20 s @ 240 Hz max). */
  private static readonly gaps: number[] = [];
  private static heapStartMB: number | null = null;
  /** Scenario / telemetry text supplied by the game (Phase 40/49), never required. */
  private static context: { scenario: string; telemetry: () => string } = {
    scenario: 'default',
    telemetry: () => '',
  };

  /** Game hook: label the run (benchmark scenario) and expose the §49 telemetry line. */
  static setContext(context: { scenario?: string; telemetry?: () => string }): void {
    if (context.scenario !== undefined) PerfChecklist.context.scenario = context.scenario;
    if (context.telemetry !== undefined) PerfChecklist.context.telemetry = context.telemetry;
  }

  /** Read the URL flags (`?perfcheck[=seconds]`, search or hash query). Called once at boot. */
  static init(): void {
    try {
      const raw = readSwitches()['perfcheck'];
      if (raw === undefined) return;
      const parsed = Number.parseFloat(raw);
      PerfChecklist.seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
      PerfChecklist.enabled = true;
      PerfChecklist.sampleStart = 0;
      PerfChecklist.result = null;
      console.info(
        `[perfcheck] armed — will sample ${PerfChecklist.seconds}s of a live match (${WARMUP_SECONDS}s in-match warmup), tier ${DeviceTier.name}`
      );
    } catch {
      PerfChecklist.enabled = false;
    }
  }

  /** The last finished verdict (for an on-screen readout; null until the run completes). */
  static get latest(): PerfCheckResult | null {
    return PerfChecklist.result;
  }

  /**
   * One processed frame. `gapMs` = wall-clock interval since the previous processed frame,
   * `workMs` = update + render cost on the main thread, counters = renderer.info at frame end,
   * `inMatch` = the frame belongs to a running match (menus are never sampled).
   */
  static sample(gapMs: number, workMs: number, calls: number, triangles: number, inMatch: boolean): void {
    if (!PerfChecklist.enabled || !inMatch) return;
    const now = performance.now();
    if (PerfChecklist.sampleStart === 0) {
      // First in-match frame: reset the window and start the warmup clock from HERE — the
      // samples that matter are the ones after the match's own shader compiles and world swap.
      PerfChecklist.sampleStart = now + WARMUP_SECONDS * 1000;
      PerfChecklist.frames = 0;
    }
    if (now < PerfChecklist.sampleStart) return;
    if (PerfChecklist.frames === 0) {
      // First sampled frame: reset the window so leftover warmup numbers cannot leak in.
      PerfChecklist.sumGap = 0;
      PerfChecklist.sumWork = 0;
      PerfChecklist.gaps.length = 0;
      PerfChecklist.heapStartMB = PerfChecklist.heapMB();
    }
    PerfChecklist.frames++;
    PerfChecklist.sumGap += Math.min(gapMs, 1000); // a hidden-tab gap must not poison the average
    PerfChecklist.sumWork += Math.min(workMs, 1000);
    // 1 % low / peak (plan §41): one small push per sampled frame, hard-bounded.
    if (PerfChecklist.gaps.length < 8192) PerfChecklist.gaps.push(gapMs);
    PerfChecklist.lastCalls = calls;
    PerfChecklist.lastTriangles = triangles;
    const elapsed = (now - PerfChecklist.sampleStart) / 1000;
    if (elapsed >= PerfChecklist.seconds) PerfChecklist.finish();
  }

  private static heapMB(): number | null {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return memory ? memory.usedJSHeapSize / 1048576 : null;
  }

  private static finish(): void {
    PerfChecklist.enabled = false;
    const frames = PerfChecklist.frames;
    if (frames === 0) {
      console.warn('[perfcheck] no frames sampled');
      return;
    }
    const tier = DeviceTier.name;
    const budget = BUDGETS[tier];
    const avgGap = PerfChecklist.sumGap / frames;
    const avgWork = PerfChecklist.sumWork / frames;
    const fps = avgGap > 0 ? 1000 / avgGap : 0;
    const rows: PerfCheckRow[] = [
      {
        metric: 'fps',
        measured: fps.toFixed(1),
        budget: `≥ ${budget.fps}`,
        pass: fps >= budget.fps,
      },
      {
        metric: 'js work ms',
        measured: avgWork.toFixed(2),
        budget: `< ${budget.jsMs}`,
        pass: avgWork < budget.jsMs,
      },
      {
        metric: 'draw calls',
        measured: String(PerfChecklist.lastCalls),
        budget: `< ${budget.draws}`,
        pass: PerfChecklist.lastCalls < budget.draws,
      },
      {
        metric: 'triangles',
        measured: PerfChecklist.lastTriangles.toLocaleString(),
        budget: `< ${budget.triangles.toLocaleString()}`,
        pass: PerfChecklist.lastTriangles < budget.triangles,
      },
    ];
    const pass = rows.every(r => r.pass);
    // r186 plan §41: frame pacing (1 % low / peak) and memory growth ride along as context —
    // they are what separates "average fps is fine" from "the phone is heating".
    const sorted = [...PerfChecklist.gaps].sort((a, b) => a - b);
    const low1PctGap = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : avgGap;
    const peakMs = sorted.length > 0 ? sorted[sorted.length - 1] : avgGap;
    const heapEnd = PerfChecklist.heapMB();
    const heapDeltaMB =
      PerfChecklist.heapStartMB !== null && heapEnd !== null ? heapEnd - PerfChecklist.heapStartMB : null;
    const context = {
      scenario: PerfChecklist.context.scenario,
      low1PctFps: low1PctGap > 0 ? 1000 / low1PctGap : 0,
      peakMs,
      heapDeltaMB,
      telemetry: PerfChecklist.context.telemetry(),
    };
    PerfChecklist.result = { pass, rows, seconds: PerfChecklist.seconds, frames, tier, context };
    console.table(rows.map(r => ({ metric: r.metric, measured: r.measured, budget: r.budget, verdict: r.pass ? 'PASS' : 'FAIL' })));
    // One copyable line (a phone report is read back from a log, not a table).
    const lines = rows.map(r => `${r.metric}=${r.measured}/${r.budget} ${r.pass ? 'PASS' : 'FAIL'}`).join(' · ');
    console.info(
      `[perfcheck] ${pass ? 'PASS' : 'FAIL'} — tier ${tier}, scenario ${context.scenario}, ${frames} frames over ${PerfChecklist.seconds}s — ${lines}`
    );
    console.info(
      `[perfcheck] pacing — 1% low ${context.low1PctFps.toFixed(1)} fps · peak ${peakMs.toFixed(1)} ms · heap ${
        heapDeltaMB === null ? 'n/a' : `${heapDeltaMB >= 0 ? '+' : ''}${heapDeltaMB.toFixed(1)} MB`
      }${context.telemetry ? ` · ${context.telemetry}` : ''}`
    );
  }
}
