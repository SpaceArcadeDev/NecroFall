// NECROFALL — WATER SYSTEM (rework plan §14/§15/§16/§51).
//
// Owns the trimmed water surface for one planet and exposes the small gameplay/visual seam the
// rest of the environment uses:
//
//   * `hasWater` / `area`        — telemetry and spawn-biasing hooks;
//   * `disturbance(pos, radius)` — a visual splash where gameplay actions hit the surface
//                                   (explosions, landings, wreckage — plan §24);
//   * `update()`                 — uniforms only (time flows through the shared shader globals).
//
// All animation is shader-side (plan §15): no CPU mesh updates, no planar reflections, no
// refraction (plan §51) — mobile-safe by construction.
import * as THREE from 'three';
import { clamp } from '../../utils/Utils';
import { buildWaterSurface, type WaterSurface } from './WaterSurface';
import type { EnvironmentContext, EnvironmentSystem } from '../EnvironmentContext';

export class WaterSystem implements EnvironmentSystem {
  readonly name = 'water';

  private surface: WaterSurface | null = null;
  private visible = true;
  private readonly level: number;
  /** Splash cooldown per area — disturbances are cheap but shouldn't spam the effects pool. */
  private lastDisturb = -10;

  constructor(private readonly ctx: EnvironmentContext) {
    this.level = ctx.provider.waterLevel;
    const detail = clamp(2 + Math.round(ctx.profile.waterDetail) + (ctx.profile.name === 'ultra' ? 1 : 0), 2, 6);
    this.surface = buildWaterSurface(ctx.provider, ctx.biome, {
      detail,
      shaderDetail: ctx.profile.waterDetail,
    });
    if (this.surface) ctx.root.add(this.surface.mesh);
  }

  get hasWater(): boolean {
    return this.surface !== null;
  }

  get waterLevel(): number {
    return this.level;
  }

  get area(): number {
    return this.surface?.area ?? 0;
  }

  /** A visual disturbance at (or under) a point — rings + speckle via the world's FX hooks. */
  disturbance(pos: THREE.Vector3, radius: number, color = 0xcfe8ff): void {
    if (!this.surface || pos.length() < this.level - 2) {
      // Below the waterline: splash from ABOVE the surface (the caller passes the impact point).
    }
    const now = performance.now() / 1000;
    if (now - this.lastDisturb < 0.08) return;
    this.lastDisturb = now;
    const up = pos.clone().normalize();
    const surfacePoint = pos.clone().normalize().multiplyScalar(this.level);
    this.ctx.fx?.ring(surfacePoint, up, radius, color, { dur: 0.6, rings: 2 });
  }

  /** True when a world point lies under the water surface (used by interaction flavour). */
  isSubmerged(point: THREE.Vector3): boolean {
    if (!this.surface) return false;
    return point.length() < this.level;
  }

  activateCell(): boolean {
    return true; // the water mesh is planet-scale; there is no per-cell content
  }

  deactivateCell(): void {
    // nothing per cell
  }

  update(): void {
    // Shader-driven; nothing per frame on the CPU (plan §15/§71).
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (this.surface) this.surface.mesh.visible = visible;
  }

  stats(): { instances: number; activeCells: number; note?: string } {
    return {
      instances: this.surface ? 1 : 0,
      activeCells: 0,
      note: this.surface ? `area ${Math.round(this.area)}m² · lvl ${this.level.toFixed(1)}` : 'dry world',
    };
  }

  dispose(): void {
    this.surface?.dispose();
    this.surface = null;
  }
}
