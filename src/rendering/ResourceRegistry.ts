/**
 * NECROFALL — GPU resource ownership registry (r186 plan §1).
 *
 * Planet replacement is a NORMAL event (every match builds its own planet). Without explicit
 * ownership, every replacement leaks: baked terrain textures, the palette texture, remapped GLB
 * materials, generated gradients, per-world render targets — all invisible in `renderer.info`
 * until the browser drops the context.
 *
 * The rule this registry encodes (plan §1):
 *
 *   SHARED       grass/rock geometries created once for the app, texture atlases, environment
 *                maps — the registry REFUSES to dispose them; they outlive every planet.
 *   PLANET-OWNED planet terrain buffers, baked data textures, generated render targets, remapped
 *                materials, the gradient lookup — disposed the moment their planet is torn down,
 *                exactly once.
 *
 * A resource may be registered twice; disposal runs once per object (`Set` semantics), so a
 * system that also disposes its own resources cannot double-free through the registry.
 */
import type * as THREE from 'three/webgpu';

export interface DisposableResource {
  dispose(): void;
}

export class ResourceRegistry {
  private readonly owned = new Set<DisposableResource>();
  private readonly shared = new Set<DisposableResource>();
  private disposed = false;

  /** Transfers ownership: the resource is disposed when the owner is torn down. Chainable. */
  own(resource: DisposableResource | null | undefined): this {
    if (resource) this.owned.add(resource);
    return this;
  }

  /** Convenience for lists (a material plus the textures it samples, …). Chainable. */
  ownAll(...resources: (DisposableResource | null | undefined)[]): this {
    for (const resource of resources) this.own(resource);
    return this;
  }

  /**
   * Marks a resource as APP-LIFETIME SHARED. A shared resource is never disposed by a teardown —
   * the registry remembers it so `PlanetRoot`/`disposeAll` can skip it even when a subtree walk
   * finds it referenced by a dying planet.
   */
  share<T extends DisposableResource>(resource: T): T {
    this.shared.add(resource);
    return resource;
  }

  isShared(resource: unknown): boolean {
    return this.shared.has(resource as DisposableResource);
  }

  get ownedCount(): number {
    return this.owned.size;
  }

  get sharedCount(): number {
    return this.shared.size;
  }

  /**
   * Disposes every owned resource exactly once and drops them from the registry. Shared
   * resources are released from the tracking set but never disposed. Returns the disposed count
   * (telemetry/leak-audit readout).
   */
  disposeAll(): number {
    if (this.disposed) return 0;
    this.disposed = true;
    let count = 0;
    for (const resource of this.owned) {
      try {
        resource.dispose();
        count++;
      } catch (err) {
        console.warn('[NECROFALL] resource dispose failed', err);
      }
    }
    this.owned.clear();
    this.shared.clear();
    return count;
  }
}

/** True when the object exposes a `dispose()` function (geometry/material/texture/render target). */
export function isDisposable(value: unknown): value is DisposableResource {
  return typeof (value as { dispose?: unknown } | null)?.dispose === 'function';
}

/**
 * Disposes the GPU resources a `THREE.Mesh`-like object holds, SKIPPING anything the registry
 * marks shared. Used by `PlanetRoot`'s subtree teardown (plan §1).
 */
export function disposeMeshResources(mesh: THREE.Object3D, registry?: ResourceRegistry): void {
  const holder = mesh as THREE.Object3D & { geometry?: DisposableResource; material?: DisposableResource | DisposableResource[] };
  const geometry = holder.geometry;
  if (geometry && !registry?.isShared(geometry)) geometry.dispose();
  const material = holder.material;
  if (Array.isArray(material)) {
    for (const entry of material) {
      if (entry && !registry?.isShared(entry)) entry.dispose();
    }
  } else if (material && !registry?.isShared(material)) {
    material.dispose();
  }
}
