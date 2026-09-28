// NECROFALL — generated-bindings loader (plan §59 step 7).
//
// The `spacetimedb/module_bindings/` directory is produced by
//   cd spacetimedb && spacetime generate --lang typescript --out-dir module_bindings --module-path .
// It is loaded LAZILY via Vite's import.meta.glob so the app still builds and
// runs (in offline mode) when the bindings have not been generated yet.
import { BINDINGS_PATH } from '../config';

/** Minimal structural view of a generated `DbConnection` (we only use these). */
export interface SpacetimeTableHandle {
  iter(): Iterable<unknown>;
  count(): number;
  onInsert?(cb: (ctx: unknown, row: never) => void): void;
  onDelete?(cb: (ctx: unknown, row: never) => void): void;
  onUpdate?(cb: (ctx: unknown, oldRow: never, newRow: never) => void): void;
  removeOnInsert?(cb: (ctx: unknown, row: never) => void): void;
  removeOnDelete?(cb: (ctx: unknown, row: never) => void): void;
  removeOnUpdate?(cb: (ctx: unknown, oldRow: never, newRow: never) => void): void;
}

export interface SpacetimeSubscriptionHandle {
  isActive(): boolean;
  isEnded(): boolean;
  unsubscribe(): void;
  unsubscribeThen?(onEnd: () => void): void;
}

export interface SpacetimeSubscriptionBuilder {
  onApplied(cb: () => void): SpacetimeSubscriptionBuilder;
  onError(cb: (ctx: unknown, err: Error) => void): SpacetimeSubscriptionBuilder;
  subscribe(queries: string | string[]): SpacetimeSubscriptionHandle;
}

export interface SpacetimeConnectionLike {
  identity?: { toHexString(): string };
  token?: string;
  isActive: boolean;
  db: Record<string, SpacetimeTableHandle | undefined>;
  reducers: Record<string, ((args?: unknown) => Promise<void>) | undefined>;
  /** Client-callable server procedures (read-on-demand round trips — e.g. searchPlayers). */
  procedures?: Record<string, ((args?: unknown) => Promise<unknown>) | undefined>;
  subscriptionBuilder(): SpacetimeSubscriptionBuilder;
  disconnect(): void;
}

interface GeneratedModule {
  DbConnection?: { builder(): unknown };
  tables?: unknown;
}

// Literal path so Vite can statically resolve it; zero matches = bindings not
// generated yet, and the game simply runs without the online shell.
const generatedModules = import.meta.glob('../../../spacetimedb/module_bindings/index.ts');

let cached: GeneratedModule | null | undefined;

/** Loads the generated bindings once. Returns null when they are absent. */
export async function loadGeneratedBindings(): Promise<GeneratedModule | null> {
  if (cached !== undefined) return cached;
  const loaders = Object.values(generatedModules);
  if (loaders.length === 0) {
    console.info(
      `[NECROFALL] SpacetimeDB bindings not found (${BINDINGS_PATH}) — running without the online shell.`
    );
    cached = null;
    return null;
  }
  try {
    const mod = (await loaders[0]()) as GeneratedModule;
    if (!mod?.DbConnection) {
      console.warn('[NECROFALL] generated bindings have no DbConnection export');
      cached = null;
      return null;
    }
    cached = mod;
    return cached;
  } catch (err) {
    console.warn('[NECROFALL] failed to load generated bindings', err);
    cached = null;
    return null;
  }
}
