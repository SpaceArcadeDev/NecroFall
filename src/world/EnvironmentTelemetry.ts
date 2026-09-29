// NECROFALL — ENVIRONMENT TELEMETRY (rework plan §65/§66/§67).
//
// Feeds the F1 debug overlay with the rework's own counters, and drives the GPU-hotspot test
// protocol the plan requires for the Android overheating investigation:
//
//     F9  → environment detail overlay (cells, counts, budget)
//     F10 → cycle the hotspot toggles (grass OFF → trees OFF → … → all ON)
//
// The instance counts matter as much as the frame time: "which subsystem owns the frame" is the
// question the numbers answer (plan §65/§66).
export interface TelemetrySource {
  profileLabel(): string;
  qualityLabel(): string;
  streamLabel(): string;
  instanceLabel(): string;
  physicsLabel(): string;
  weatherLabel(): string;
  occlusionLabel(): string;
  ledgerLabel(): string;
}

export interface HotspotState {
  terrain: boolean;
  grass: boolean;
  trees: boolean;
  rocks: boolean;
  props: boolean;
  water: boolean;
  weather: boolean;
  fog: boolean;
  shadows: boolean;
}

export class EnvironmentTelemetry {
  private detailVisible = false;
  private hotspotIndex = 0;
  readonly hotspots: HotspotState = {
    terrain: true,
    grass: true,
    trees: true,
    rocks: true,
    props: true,
    water: true,
    weather: true,
    fog: true,
    shadows: true,
  };

  constructor(private readonly source: TelemetrySource) {}

  /** F9: toggles the environment detail lines inside the debug overlay. */
  toggleDetail(): boolean {
    this.detailVisible = !this.detailVisible;
    return this.detailVisible;
  }

  get detail(): boolean {
    return this.detailVisible;
  }

  /**
   * F10: cycles one hotspot category off per press (and back to all-on after the last one).
   * Returns the category that changed + its new value so the caller can apply it to the renderer.
   */
  cycleHotspot(): { category: keyof HotspotState; enabled: boolean } {
    const order: (keyof HotspotState)[] = ['grass', 'trees', 'rocks', 'props', 'water', 'weather', 'fog', 'shadows', 'terrain'];
    if (this.hotspotIndex >= order.length) {
      // All off once → restore everything.
      for (const key of order) this.hotspots[key] = true;
      this.hotspotIndex = 0;
      return { category: order[0], enabled: true };
    }
    const category = order[this.hotspotIndex++];
    this.hotspots[category] = !this.hotspots[category];
    return { category, enabled: this.hotspots[category] };
  }

  /** Applies every hotspot to the world (used when a caller wants a full sync). */
  applyAll(apply: (category: keyof HotspotState, enabled: boolean) => void): void {
    (Object.keys(this.hotspots) as (keyof HotspotState)[]).forEach(key => apply(key, this.hotspots[key]));
  }

  /** The environment lines appended to the F1 overlay. */
  lines(): string[] {
    if (!this.detailVisible) return [];
    return [
      `env ${this.source.profileLabel()}  ·  ${this.source.qualityLabel()}`,
      `env stream ${this.source.streamLabel()}`,
      `env inst ${this.source.instanceLabel()}`,
      `env phys ${this.source.physicsLabel()}`,
      `env sky ${this.source.weatherLabel()}`,
      `env occlusion ${this.source.occlusionLabel()}  ·  ledger ${this.source.ledgerLabel()}`,
    ];
  }
}
