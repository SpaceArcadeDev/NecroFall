// NECROFALL — ASSET REGISTRY (rework plan §40/§41/§68/§69).
//
// ONE place that owns shared environment assets. Today those assets are procedural (this codebase
// ships no binary models), but the registry is the seam the plan describes:
//
//     * CRITICAL assets (player, enemies, boss, Beacon, Nexus — the game's own systems) are built
//       at match start;
//     * ENVIRONMENT assets are registered here and built LAZILY, once, the first time a cell that
//       needs them is streamed in (plan §68);
//     * `get()` is a load-once cache — the "GLTFLoader cache" guarantee of plan §69: the same key
//       always returns the SAME geometry/material instance, and no cell rebuild ever duplicates it.
//
// When GLB assets arrive (see assets/README.md for the Blender → GLB → gltf-transform → KTX2
// pipeline), a `GLTFLoader`-based factory simply registers under the same keys; nothing else
// changes.
export type AssetFactory<T> = () => T;

export interface AssetStats {
  registered: number;
  built: number;
  critical: number;
}

export class AssetRegistry {
  private readonly factories = new Map<string, AssetFactory<unknown>>();
  private readonly cache = new Map<string, unknown>();
  private readonly criticalKeys = new Set<string>();

  /**
   * Registers a factory under a stable key. `critical` marks assets that must exist before the
   * first gameplay frame (they are built by `preloadCritical()`).
   */
  register<T>(key: string, factory: AssetFactory<T>, critical = false): void {
    if (this.cache.has(key)) return; // already built — registration is idempotent
    this.factories.set(key, factory as AssetFactory<unknown>);
    if (critical) this.criticalKeys.add(key);
  }

  /** Load-once access. Unknown keys throw (a typo must be loud, not a null deref later). */
  get<T>(key: string): T {
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit as T;
    const factory = this.factories.get(key);
    if (!factory) throw new Error(`[env] asset not registered: ${key}`);
    const built = factory() as T;
    this.cache.set(key, built);
    return built;
  }

  /** Load-once access with an inline factory (self-registering call sites). */
  ensure<T>(key: string, factory: AssetFactory<T>): T {
    if (!this.factories.has(key)) this.register(key, factory);
    return this.get<T>(key);
  }

  has(key: string): boolean {
    return this.cache.has(key) || this.factories.has(key);
  }

  /** Builds every critical asset up front (plan §68). */
  preloadCritical(): void {
    this.criticalKeys.forEach(key => {
      if (!this.cache.has(key)) this.get(key);
    });
  }

  stats(): AssetStats {
    return { registered: this.factories.size, built: this.cache.size, critical: this.criticalKeys.size };
  }

  /** Disposes geometry/material assets that expose `dispose()` (planet teardown). */
  clear(): void {
    this.cache.forEach(value => {
      const disposable = value as { dispose?: () => void };
      if (typeof disposable?.dispose === 'function') disposable.dispose();
    });
    this.cache.clear();
    this.factories.clear();
    this.criticalKeys.clear();
  }
}
