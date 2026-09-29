// NECROFALL — LOOK-THROUGH SYSTEM (rework plan §27/§28/§29/§30/§54/§55).
//
// Keeps PLAYERS AND ENEMIES readable when vegetation gets between them and the camera:
//
//     camera ────────── ray ──────────► focus (player / enemy / boss)
//                        │
//              occluder (tree, big rock) → dither-fade it
//
// Rules that make this safe:
//   * ONLY environment objects registered as occluders can fade (plan §28: never enemies, bosses,
//     players, Beacons, Nexus — they are not in this system);
//   * a tree that blocks an ENEMY fades harder than one blocking a distant teammate (§55);
//   * the pass runs at the visibility frequency (plan §71), not per frame, and only tests
//     occluders near the camera→focus corridor;
//   * grass never raycasts (§29) — it thins via distance uniforms instead.
import * as THREE from 'three';
import type { InstancedEnvironmentGroup } from '../instancing/InstancedEnvironmentGroup';
import type { OcclusionSystem } from './OcclusionSystem';

/** One focus that must stay visible through vegetation. */
export interface LookThroughFocus {
  position: THREE.Vector3;
  /** player | enemy | boss (bosses behave like enemies but fade vegetation even harder). */
  kind: 'player' | 'enemy' | 'boss';
  /** True for the local player (always fully prioritised). */
  local: boolean;
}

/** An environment system that can supply fadeable occluders. */
export interface OccluderSource {
  forEachOccluder(cb: (id: number, x: number, y: number, z: number, radius: number, group: InstancedEnvironmentGroup, slot: number) => void): void;
}

const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
const _closest = new THREE.Vector3();

export class LookThroughSystem {
  private readonly camera = new THREE.Vector3();
  private readonly focuses: LookThroughFocus[] = [];
  /** Working set of occluders gathered per pass (reused; avoids per-tick allocation). */
  private readonly gathered: { id: number; x: number; y: number; z: number; r: number; group: InstancedEnvironmentGroup; slot: number }[] = [];

  constructor(
    private readonly occlusion: OcclusionSystem,
    private readonly sources: OccluderSource[]
  ) {}

  setCamera(pos: THREE.Vector3): void {
    this.camera.copy(pos);
  }

  setFocuses(focuses: readonly LookThroughFocus[]): void {
    this.focuses.length = 0;
    for (const f of focuses) this.focuses.push(f);
  }

  /** One look-through pass (call at the visibility frequency). */
  update(enabled: boolean): void {
    if (!enabled || this.focuses.length === 0) {
      this.occlusion.beginTick();
      this.occlusion.endTick();
      return;
    }
    // Gather occluders once per pass, sorted roughly by distance to the camera later.
    this.gathered.length = 0;
    for (const source of this.sources) {
      source.forEachOccluder((id, x, y, z, radius, group, slot) => {
        this.gathered.push({ id, x, y, z, r: radius, group, slot });
      });
    }

    this.occlusion.beginTick();
    for (const focus of this.focuses) {
      const target = focus.local ? 0.3 : focus.kind === 'player' ? 0.35 : focus.kind === 'boss' ? 0.12 : 0.18;
      _ab.copy(focus.position).sub(this.camera);
      const segLen = _ab.length();
      if (segLen < 0.001) continue;
      _ab.multiplyScalar(1 / segLen);
      for (const o of this.gathered) {
        // quick reject: occluder must be between camera and focus and near the segment
        _ap.set(o.x, o.y, o.z).sub(this.camera);
        const along = _ap.dot(_ab);
        if (along < 0.5 || along > segLen - 0.5) continue;
        const perpendicular2 = _ap.lengthSq() - along * along;
        const reach = o.r + 0.55;
        if (perpendicular2 > reach * reach) continue;
        // The segment passes through the occluder's cylinder — fade it.
        this.occlusion.request(o.id, o.group, o.slot, target);
      }
    }
    this.occlusion.endTick();
  }

  /** Debug helper: closest occluder distance for telemetry. */
  debugClosest(): number {
    if (this.focuses.length === 0 || this.gathered.length === 0) return -1;
    return this.gathered.length;
  }

  get focusCount(): number {
    return this.focuses.length;
  }
}

/** Exported for tests: distance from point `p` to segment `a→b`. */
export function distanceToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  _ab.copy(b).sub(a);
  const len2 = _ab.lengthSq();
  if (len2 < 1e-9) return p.distanceTo(a);
  const t = Math.max(0, Math.min(1, _ap.copy(p).sub(a).dot(_ab) / len2));
  _closest.copy(a).addScaledVector(_ab, t);
  return p.distanceTo(_closest);
}
