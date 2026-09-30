// NECROFALL — PlanetRenderer (plan §45): the environment's per-frame stage runner.
//
// ONE place owns the ORDER in which the environment systems tick — nothing else may re-order or
// double-tick them. `World` owns construction and asset loading; this class owns the tick, the
// same way Folio's World treats its system list.
//
// No gameplay logic belongs here: the environment reads the `RenderState` snapshot (plan §1) and
// never writes authoritative state back.
import * as THREE from 'three/webgpu';
import type { World } from './World';
import type { RenderState } from '../../game/RenderState';

export class PlanetRenderer {
  /** Foliage see-through edge updates run at ~10 Hz, not per frame. */
  private cpuTimer = 0;

  constructor(private readonly world: World) {}

  update(
    dt: number,
    cameraPosition: THREE.Vector3,
    focuses: THREE.Vector3[],
    primaryFocus: THREE.Vector3,
    active: boolean,
    renderState?: RenderState,
  ): void {
    const world = this.world;

    // Occlusion: screen position + candidate tests (the fade anchor every Foliage reads).
    world.occlusion.update(dt);

    // Visibility budgets at 30 Hz (world) — pass the primary focus.
    world.visibility.update(dt, primaryFocus);

    // Sky + particles follow the camera.
    world.sky?.update(cameraPosition);
    if (active) world.particles?.update(cameraPosition);

    // Water patch recentring (throttled internally).
    world.waterSurface?.update(primaryFocus);

    // Grass: folio's camera-scrolling field follows the view (a uniform write per frame).
    world.grass?.update(primaryFocus);

    // Foliage see-through edge scaling (throttled to ~10 Hz internally by the distance check).
    // Folio scales the see-through edges by the camera→target distance (their view's spherical
    // radius); the core must track the CAMERA distance so only foliage between the camera and
    // the player fades.
    this.cpuTimer -= dt;
    if (this.cpuTimer <= 0) {
      this.cpuTimer = 0.1;
      const focus = primaryFocus;
      const cameraDistance = Math.max(1e-3, cameraPosition.distanceTo(focus));
      const focusDistance = cameraDistance;
      for (const trees of world.trees) {
        trees.leaves.update(cameraDistance * world.occlusion.fadeMultiplier, focusDistance, cameraPosition);
      }
      world.bushes?.foliage.update(cameraDistance * world.occlusion.fadeMultiplier, focusDistance, cameraPosition);
    }

    // Physics (Rapier) — environment bodies only; terrain stays analytical (plan §25).
    if (active) world.physics.update(dt, focuses);

    void renderState;
  }
}
