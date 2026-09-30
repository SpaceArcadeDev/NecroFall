/**
 * NECROFALL — minimal typed event emitter (folio `Events.js` port).
 *
 * The world stack (viewport / quality / ticker) publishes through this instead
 * of hand-rolled callback arrays, so listeners can be removed cleanly when a
 * dev world tears down (`off()` handles).
 */

type Handler = (...args: unknown[]) => void;

export class Events {
  private handlers = new Map<string, Set<Handler>>();

  /** Registers a handler and returns a function that removes it again. */
  on(name: string, handler: Handler): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /** Removes a single handler (same function reference). */
  off(name: string, handler: Handler): void {
    this.handlers.get(name)?.delete(handler);
  }

  trigger(name: string, args: unknown[] = []): void {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return;
    // copy so handlers may unsubscribe during dispatch
    for (const handler of [...set]) {
      handler(...args);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
