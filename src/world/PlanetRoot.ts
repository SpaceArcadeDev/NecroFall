/**
 * NECROFALL — planet scene-graph root (r186 plan §1).
 *
 * r186 added `Object3D.dispose()`: the base implementation is a no-op and a parent is expected to
 * call it on its subtree when the subtree dies. This root is that implementation for the world,
 * with the project's ONE ownership rule baked in (see `ResourceRegistry`):
 *
 *   • geometry / material found on a descendant is disposed UNLESS the registry marks it shared —
 *     a subtree teardown can never free a resource another planet is still using;
 *   • a descendant that OVERRIDES `dispose()` (its own prototype method, not the inherited no-op)
 *     is asked to dispose itself FIRST, so a system that owns resources beyond its meshes releases
 *     them before the generic walk;
 *   • children are visited depth-first, once.
 *
 * The system-level teardown (`PlanetRenderer.dispose`) still calls each environment system's own
 * `dispose()`; this class is the safety net that makes forgetting one impossible to leak.
 */
import * as THREE from 'three/webgpu';
import { ResourceRegistry, disposeMeshResources } from '../rendering/ResourceRegistry';

const BASE_DISPOSE = THREE.Object3D.prototype.dispose;

export class PlanetRoot extends THREE.Group {
  constructor(private readonly registry?: ResourceRegistry) {
    super();
  }

  /** True when the object implements its own disposal (r186 `Object3D.dispose` contract). */
  private static overridesDispose(object: THREE.Object3D): object is THREE.Object3D & { dispose: () => void } {
    const dispose = (object as { dispose?: unknown }).dispose;
    return typeof dispose === 'function' && dispose !== BASE_DISPOSE;
  }

  override dispose(): void {
    const visited = new Set<THREE.Object3D>();
    const walk = (object: THREE.Object3D): void => {
      if (visited.has(object)) return;
      visited.add(object);
      for (const child of [...object.children]) walk(child);
      disposeMeshResources(object, this.registry);
      if (PlanetRoot.overridesDispose(object)) {
        try {
          (object as THREE.Object3D & { dispose: () => void }).dispose();
        } catch (err) {
          console.warn('[NECROFALL] planet subtree dispose failed', err);
        }
      }
    };
    for (const child of [...this.children]) walk(child);
    this.clear();
    super.dispose();
  }
}
