// NECROFALL — WorldOcclusion (plan §22/§23/§44/§102): the camera↔player line, kept readable.
//
// Two cooperating mechanisms, both cheap:
//   1. the SCREEN-SPACE fade (Folio's foliage see-through): every Foliage system fades whatever
//      sits between the camera and the local player, pixel by pixel — this is what actually keeps
//      the player visible behind leaves, and it costs nothing per frame;
//   2. a coarse CANDIDATE test: a few ray checks per frame against the nearest large occluders on
//      the camera→player segment, used to (a) boost the fade strength while truly blocked and
//      (b) drive telemetry. Never a raycast against every tree, never geometry rebuilds (plan §44).
import * as THREE from 'three/webgpu';
import { VegetationSpatialHash, angularDistance } from '../../vegetation/VegetationSpatialHash';

export interface OccluderCandidate {
  dir: THREE.Vector3;
  /** World-space position of the occluder. */
  position: THREE.Vector3;
  /** Approximate radius in metres (canopy size). */
  radius: number;
}

export interface WorldOcclusionOptions {
  /** Where the local player is (world space). Null when there is nobody to keep visible. */
  focusPosition: () => THREE.Vector3 | null;
  /** Camera world position. */
  cameraPosition: THREE.Vector3;
  /** Project a world point to CSS pixels; returns null when behind the camera. */
  project: (worldPosition: THREE.Vector3, out: THREE.Vector2) => THREE.Vector2 | null;
  /** Quality gate: 0 disables the see-through fade entirely (plan §23, mobile fallback). */
  quality?: number;
}

/** How often the candidate shortlist is rebuilt (not per frame — plan §22). */
const CANDIDATE_INTERVAL = 0.25;
/** Ray tests per second (a few candidates, never thousands). */
const RAY_TESTS_PER_TICK = 4;

export class WorldOcclusion {
  /** Current screen position of the local player, or null. Shared by every Foliage material. */
  readonly screenPosition = new THREE.Vector2();
  /** 1 = exact player position; values < 1 shrink the fade radius (used by cherry canopies etc.). */
  hasTarget = false;

  private readonly cameraDir = new THREE.Vector3();
  private readonly toFocus = new THREE.Vector3();
  private readonly emitters: Array<(position: THREE.Vector2 | null) => void> = [];

  private treeHash: VegetationSpatialHash<OccluderCandidate> | null = null;
  private readonly candidateScratch: OccluderCandidate[] = [];
  private candidateTimer = 0;
  private blockedTimer = 0;
  /** Smoothed 0..1 "the player is behind something big" — drives the fade boost. */
  blocked = 0;

  constructor(private readonly options: WorldOcclusionOptions) {}

  setTreeHash(hash: VegetationSpatialHash<OccluderCandidate>): void {
    this.treeHash = hash;
  }

  /** Brightness multiplier for the foliage fade: stronger while blocked, calmer in the open. */
  get fadeMultiplier(): number {
    return 1 + this.blocked * 1.6;
  }

  update(dt: number): void {
    const focus = this.options.focusPosition();
    if (!focus) {
      this.hasTarget = false;
      this.emit(null);
      this.blocked = 0;
      return;
    }

    // Screen projection (once per frame — the projection is a few matrix multiplies).
    const projected = this.options.project(focus, this.screenPosition);
    this.hasTarget = projected !== null;
    this.emit(projected);

    // Candidate ray tests (a few per second, plan §22).
    this.candidateTimer -= dt;
    if (this.candidateTimer > 0) return;
    this.candidateTimer = CANDIDATE_INTERVAL;
    this.testCandidates(focus, dt);
  }

  private testCandidates(focus: THREE.Vector3, dt: number): void {
    if (!this.treeHash) return;

    const camera = this.options.cameraPosition;
    this.toFocus.copy(focus);
    this.cameraDir.copy(this.toFocus).sub(camera);
    const segmentLength = this.cameraDir.length();
    if (segmentLength < 0.5) return;
    this.cameraDir.multiplyScalar(1 / segmentLength);

    // Shortlist via the vegetation hash around the segment midpoint.
    _mid.copy(camera).addScaledVector(this.cameraDir, segmentLength * 0.5);
    const angularRadius = (segmentLength * 0.5 + 12) / Math.max(1, _mid.length());
    this.candidateScratch.length = 0;
    this.treeHash.query(_mid, Math.min(1.2, angularRadius), this.candidateScratch);

    let blockedNow = 0;
    let tested = 0;
    for (const candidate of this.candidateScratch) {
      if (tested >= RAY_TESTS_PER_TICK) break;
      tested++;

      // Distance from the occluder centre to the camera→focus segment.
      _seg.copy(candidate.position).sub(camera);
      const t = THREE.MathUtils.clamp(_seg.dot(this.cameraDir), 0, segmentLength);
      _close.copy(camera).addScaledVector(this.cameraDir, t);
      const distance = _close.distanceTo(candidate.position);
      if (distance < candidate.radius && t > 1.5 && t < segmentLength - 0.5) {
        blockedNow = Math.max(blockedNow, 1 - distance / candidate.radius);
      }
    }

    // Smooth in/out: fade in fast (the player must stay visible), recover slowly (plan §23).
    const rate = blockedNow > this.blocked ? 8 : 3;
    this.blocked += (blockedNow - this.blocked) * Math.min(1, dt * rate * 4);
    this.blockedTimer = blockedNow > 0.05 ? 0 : this.blockedTimer + dt;
  }

  /** Systems subscribe to receive the current focus screen position (null = no target). */
  onTarget(callback: (position: THREE.Vector2 | null) => void): void {
    this.emitters.push(callback);
  }

  private emit(position: THREE.Vector2 | null): void {
    for (const emitter of this.emitters) emitter(position);
  }

  dispose(): void {
    this.emitters.length = 0;
    this.treeHash = null;
  }
}

const _mid = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _close = new THREE.Vector3();

export { angularDistance };
