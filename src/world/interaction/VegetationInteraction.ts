// NECROFALL — VEGETATION INTERACTION (rework plan §24/§25/§29/§55/§71).
//
// The bridge between gameplay entities and the vegetation that should react to them:
//
//   * GRASS: the nearest players (with their speeds) drive the per-blade bend uniforms — the
//     shader does the rest, nothing per blade on the CPU (plan §25);
//   * LOOK-THROUGH: players, enemies and bosses become visibility focuses, so vegetation blocking
//     them dither-fades (plan §27/§55);
//   * Everything runs at the interaction/visibility frequency (plan §71), never per frame.
import * as THREE from 'three';
import type { GrassSystem, GrassFocus } from '../foliage/GrassSystem';
import type { LookThroughSystem, LookThroughFocus } from './LookThroughSystem';

/** One gameplay entity the environment should react to (fed by the game each tick). */
export interface FocusInput {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  kind: 'player' | 'enemy' | 'boss';
  local: boolean;
}

const MAX_GRASS_FOCUS = 4;
const MAX_LOOK_FOCUS = 8;

export class VegetationInteraction {
  private readonly grassFocuses: GrassFocus[] = [];
  private lookFocuses: LookThroughFocus[] = [];
  private readonly playerPool: { position: THREE.Vector3; speed: number }[] = [];

  constructor(
    private readonly grass: GrassSystem,
    private readonly lookThrough: LookThroughSystem
  ) {}

  /**
   * Feeds this tick's entities into the vegetation systems.
   * `cameraPos` orders the look-through focuses so the closest ones win the budget.
   */
  setInputs(inputs: readonly FocusInput[], cameraPos: THREE.Vector3): void {
    // --- grass: players only, nearest to the camera first ------------------------------------
    this.playerPool.length = 0;
    for (const input of inputs) {
      if (input.kind !== 'player') continue;
      this.playerPool.push({ position: input.position, speed: input.velocity.length() });
    }
    this.playerPool.sort((a, b) => a.position.distanceToSquared(cameraPos) - b.position.distanceToSquared(cameraPos));
    this.grassFocuses.length = 0;
    for (let i = 0; i < this.playerPool.length && i < MAX_GRASS_FOCUS; i++) {
      this.grassFocuses.push(this.playerPool[i]);
    }
    this.grass.setFocuses(this.grassFocuses);

    // --- look-through: everyone, nearest to the camera first ----------------------------------
    const ranked = inputs.slice().sort((a, b) =>
      a.position.distanceToSquared(cameraPos) - b.position.distanceToSquared(cameraPos)
    );
    this.lookFocuses = [];
    for (let i = 0; i < ranked.length && i < MAX_LOOK_FOCUS; i++) {
      const input = ranked[i];
      this.lookFocuses.push({
        position: input.position,
        kind: input.kind,
        local: input.local,
      });
    }
    this.lookThrough.setFocuses(this.lookFocuses);
  }

  /** One visibility-frequency pass (plan §71). */
  update(enabled: boolean): void {
    this.lookThrough.update(enabled);
  }
}
