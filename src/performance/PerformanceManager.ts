/**
 * NECROFALL — unified performance telemetry (r186 plan §0.3 / §49).
 *
 * ONE snapshot API that answers "where did the frame go" without guessing:
 *
 *     performanceManager.snapshot()
 *     → { frame, world, combat, network, server }
 *
 * Design rules (the project's own zero-cost rule):
 *
 *   • PULL, not push. Sections are filled by small PROVIDER closures that each subsystem
 *     registers (`PerformanceManager.register('world', () => world.counters())`). A provider is
 *     only called when someone asks for a snapshot — i.e. from the debug overlay or the console,
 *     never from the render loop.
 *   • No console output. `?debug` keeps the existing PerformanceMonitor log; this module is the
 *     structured readout (overlay §49 + `?perfcheck` acceptance runs). Nothing here logs.
 *   • Frame timing comes from Game's own smoothed numbers through `sample()`, so telemetry can
 *     never become a second, disagreeing frame timer.
 */
import type * as THREE from 'three/webgpu';
import { Vector2 } from 'three/webgpu';
import { readSwitches } from '../rendering/DebugSwitches';

export interface FrameSection {
  fps: number;
  frameMs: number;
  cpuMs: number;
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  pixelRatio: number;
  canvasWidth: number;
  canvasHeight: number;
  backend: string;
}

export interface WorldSection {
  grassSectors: number;
  grassSectorsVisible: number;
  grassInstances: number;
  grassInstancesDrawn: number;
  grassFadingSectors: number;
  vegetationInstances: number;
}

export interface CombatSection {
  enemiesActive: number;
  enemiesFull: number;
  enemiesReduced: number;
  enemiesLight: number;
  enemiesSleep: number;
  projectilesActive: number;
  particlesActive: number;
}

export interface NetworkSection {
  rxBytesPerSec: number;
  txBytesPerSec: number;
  spacetimeUpdatesPerSec: number;
}

export interface ServerSection {
  tickMs: number;
}

export interface PerformanceSnapshot {
  frame: FrameSection;
  world: WorldSection;
  combat: CombatSection;
  network: NetworkSection;
  server: ServerSection;
}

export type SectionName = keyof PerformanceSnapshot;
export type SectionProvider<K extends SectionName> = () => Partial<PerformanceSnapshot[K]>;

const FRAME_DEFAULTS: FrameSection = {
  fps: 0,
  frameMs: 0,
  cpuMs: 0,
  drawCalls: 0,
  triangles: 0,
  points: 0,
  lines: 0,
  geometries: 0,
  textures: 0,
  pixelRatio: 1,
  canvasWidth: 0,
  canvasHeight: 0,
  backend: 'none',
};

const WORLD_DEFAULTS: WorldSection = {
  grassSectors: 0,
  grassSectorsVisible: 0,
  grassInstances: 0,
  grassInstancesDrawn: 0,
  grassFadingSectors: 0,
  vegetationInstances: 0,
};

const COMBAT_DEFAULTS: CombatSection = {
  enemiesActive: 0,
  enemiesFull: 0,
  enemiesReduced: 0,
  enemiesLight: 0,
  enemiesSleep: 0,
  projectilesActive: 0,
  particlesActive: 0,
};

const NETWORK_DEFAULTS: NetworkSection = { rxBytesPerSec: 0, txBytesPerSec: 0, spacetimeUpdatesPerSec: 0 };
const SERVER_DEFAULTS: ServerSection = { tickMs: 0 };

/** Renderer shape the frame section reads — both renderer generations expose these. */
interface RendererLike {
  info: {
    render: { drawCalls?: number; triangles?: number; points?: number; lines?: number };
    memory: { geometries?: number; textures?: number };
  };
  getPixelRatio(): number;
  /** `getDrawingBufferSize` chains on the target (`set(...).floor()`) — pass a real Vector2. */
  getDrawingBufferSize(target: Vector2): Vector2;
}

class PerformanceManagerImpl {
  /** True when `?debug`, `?stats`, `?perfcheck` or `?overlay` asked for telemetry. */
  enabled = false;

  private renderer: RendererLike | null = null;
  private backend: string = 'none';
  private readonly providers = new Map<SectionName, Set<SectionProvider<SectionName>>>();
  /** Scratch for `getDrawingBufferSize` — a real Vector2 (the call chains on the target). */
  private readonly size = new Vector2();
  /** Smoothed frame pacing (ms) — pushed by Game's own loop, never measured twice. */
  private frameMs = 0;
  private cpuMs = 0;

  init(): void {
    try {
      const bag = readSwitches();
      const debug = bag['debug'];
      this.enabled =
        debug === 'true' ||
        debug === '1' ||
        bag['stats'] !== undefined ||
        bag['renderstats'] !== undefined ||
        bag['perfcheck'] !== undefined ||
        bag['overlay'] !== undefined;
    } catch {
      this.enabled = false;
    }
  }

  /** Game's loop pushes the SAME smoothed numbers its watchdog uses. No-op when disabled. */
  sample(frameMs: number, cpuMs: number): void {
    if (!this.enabled) return;
    this.frameMs += (frameMs - this.frameMs) * 0.15;
    this.cpuMs += (cpuMs - this.cpuMs) * 0.15;
  }

  attachRenderer(renderer: THREE.Renderer | null, backend?: string): void {
    this.renderer = (renderer ?? null) as unknown as RendererLike | null;
    if (backend) this.backend = backend;
  }

  /** Registers a pull-based section provider. Returns the unregister function. */
  register<K extends SectionName>(section: K, provider: SectionProvider<K>): () => void {
    let set = this.providers.get(section);
    if (!set) {
      set = new Set();
      this.providers.set(section, set);
    }
    const entry = provider as SectionProvider<SectionName>;
    set.add(entry);
    return () => set.delete(entry);
  }

  private readFrame(): FrameSection {
    const section: FrameSection = { ...FRAME_DEFAULTS };
    section.frameMs = this.frameMs;
    section.cpuMs = this.cpuMs;
    section.fps = this.frameMs > 0 ? Math.min(999, 1000 / this.frameMs) : 0;
    section.backend = this.backend;
    const renderer = this.renderer;
    if (renderer) {
      try {
        const info = renderer.info;
        section.drawCalls = info.render.drawCalls ?? 0;
        section.triangles = info.render.triangles ?? 0;
        section.points = info.render.points ?? 0;
        section.lines = info.render.lines ?? 0;
        section.geometries = info.memory.geometries ?? 0;
        section.textures = info.memory.textures ?? 0;
        section.pixelRatio = renderer.getPixelRatio();
        const size = renderer.getDrawingBufferSize(this.size);
        section.canvasWidth = size.x;
        section.canvasHeight = size.y;
      } catch {
        /* renderer mid-teardown: keep the frame defaults */
      }
    }
    return section;
  }

  private merge<K extends SectionName>(section: K, defaults: PerformanceSnapshot[K]): PerformanceSnapshot[K] {
    const set = this.providers.get(section);
    if (!set || set.size === 0) return defaults;
    const out = { ...defaults };
    for (const provider of set) {
      try {
        Object.assign(out, provider());
      } catch {
        /* a broken provider must never break the snapshot */
      }
    }
    return out;
  }

  /** The full structured readout. Safe to call any time (loading, menu, mid-fight). */
  snapshot(): PerformanceSnapshot {
    return {
      frame: this.readFrame(),
      world: this.merge('world', WORLD_DEFAULTS),
      combat: this.merge('combat', COMBAT_DEFAULTS),
      network: this.merge('network', NETWORK_DEFAULTS),
      server: this.merge('server', SERVER_DEFAULTS),
    };
  }

  /**
   * The Phase §49 overlay layout — one `[label, value]` pair per line, consumed by StatsOverlay
   * (and readable from the console as text). Kept here so every readout shows the same numbers.
   */
  overlayLines(snapshot: PerformanceSnapshot = this.snapshot()): [string, string][] {
    const { frame, world, combat, network } = snapshot;
    const count = (value: number): string => value.toLocaleString();
    return [
      ['fps', `${frame.fps.toFixed(0)}`],
      ['frame', `${frame.frameMs.toFixed(1)}ms`],
      ['cpu', `${frame.cpuMs.toFixed(1)}ms`],
      ['draws', `${frame.drawCalls}`],
      ['triangles', count(frame.triangles)],
      ['geometry', `${frame.geometries} geo · ${frame.textures} tex`],
      ['canvas', `${frame.canvasWidth}x${frame.canvasHeight} @${frame.pixelRatio.toFixed(2)} · ${frame.backend}`],
      ['grass', `${world.grassSectorsVisible}/${world.grassSectors} sectors · ${count(world.grassInstancesDrawn)}/${count(world.grassInstances)} blades${world.grassFadingSectors > 0 ? ` · ${world.grassFadingSectors} fading` : ''}`],
      ['vegetation', `${count(world.vegetationInstances)} instances`],
      ['enemies', `${combat.enemiesActive} active (${combat.enemiesFull} full · ${combat.enemiesReduced} reduced · ${combat.enemiesLight} light · ${combat.enemiesSleep} sleep)`],
      ['projectiles', `${combat.projectilesActive}`],
      ['particles', `${count(combat.particlesActive)}`],
      ['network', `rx ${(network.rxBytesPerSec / 1024).toFixed(1)} KB/s · tx ${(network.txBytesPerSec / 1024).toFixed(1)} KB/s · stdb ${network.spacetimeUpdatesPerSec.toFixed(1)}/s`],
      ['server', `tick ${snapshot.server.tickMs.toFixed(1)}ms`],
    ];
  }
}

export const PerformanceManager = new PerformanceManagerImpl();
