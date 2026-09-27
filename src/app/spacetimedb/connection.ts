// NECROFALL — ONE shared SpacetimeDB connection (plan §47).
//
// Profile, friends, matchmaking and the official match all ride this single
// connection and its subscription scopes. It reconnects with backoff, re-checks
// liveness when the tab wakes up, and stays completely inert when the generated
// bindings or the environment configuration are missing.
import { APP_CONFIG, STORAGE } from '../config';
import { loadGeneratedBindings, SpacetimeConnectionLike, SpacetimeSubscriptionHandle } from './bindings';

export type ConnectionState = 'offline' | 'connecting' | 'connected' | 'reconnecting' | 'error';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class SpacetimeConnection {
  static readonly shared = new SpacetimeConnection();

  private conn: SpacetimeConnectionLike | null = null;
  private bindingsLoaded = false;
  private stateValue: ConnectionState = 'offline';
  private token: string | null = null;
  private wantConnected = false;
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer = 0;
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private connectListeners = new Set<(conn: SpacetimeConnectionLike) => void>();
  private activeSubscriptions = new Set<SpacetimeSubscriptionHandle>();

  get state(): ConnectionState {
    return this.stateValue;
  }

  get identityHex(): string {
    return this.conn?.identity?.toHexString() ?? '';
  }

  get current(): SpacetimeConnectionLike | null {
    return this.stateValue === 'connected' ? this.conn : null;
  }

  /** True when the DB is reachable at all (configuration + bindings present). */
  get available(): boolean {
    return APP_CONFIG.configured && this.bindingsLoaded;
  }

  onState(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  onConnect(cb: (conn: SpacetimeConnectionLike) => void): () => void {
    this.connectListeners.add(cb);
    return () => this.connectListeners.delete(cb);
  }

  /** Load lazily so an unconfigured build never even fetches the bindings. */
  async prepare(): Promise<boolean> {
    if (!APP_CONFIG.configured) return false;
    if (!this.bindingsLoaded) {
      const mod = await loadGeneratedBindings();
      this.bindingsLoaded = Boolean(mod);
    }
    return this.bindingsLoaded;
  }

  async connect(token?: string | null): Promise<boolean> {
    this.disposed = false;
    this.wantConnected = true;
    if (token !== undefined) this.token = token;
    // Guests have no OIDC token: reuse the SpacetimeDB private token from the
    // last connection so the SAME identity (and account) comes back.
    if (!this.token) this.token = readStoredDbToken();
    if (!(await this.prepare())) {
      this.setState('offline');
      return false;
    }
    if (this.conn && this.stateValue === 'connected') return true;

    const mod = await loadGeneratedBindings();
    const DbConnection = mod?.DbConnection;
    if (!DbConnection) return false;

    this.setState(this.stateValue === 'offline' ? 'connecting' : 'reconnecting');
    try {
      const builder = DbConnection.builder() as {
        withUri(uri: string): typeof builder;
        withDatabaseName(name: string): typeof builder;
        withToken(token: string): typeof builder;
        onConnect(cb: (conn: SpacetimeConnectionLike, identity: unknown, token: string) => void): typeof builder;
        onConnectError(cb: (ctx: unknown, err: Error) => void): typeof builder;
        onDisconnect(cb: (ctx: unknown, err: Error | null) => void): typeof builder;
        build(): unknown;
      };
      let b = builder.withUri(APP_CONFIG.spacetimeUri).withDatabaseName(APP_CONFIG.spacetimeDb);
      if (this.token) b = b.withToken(this.token);
      b = b
        .onConnect((conn, _identity, dbToken) => {
          if (dbToken) writeStoredDbToken(dbToken);
          this.handleConnected(conn);
        })
        .onConnectError((_ctx, err) => {
          console.warn('[NECROFALL] SpacetimeDB connect error', err?.message ?? err);
          this.setState('error');
          this.scheduleReconnect();
        })
        .onDisconnect(() => {
          this.conn = null;
          for (const sub of this.activeSubscriptions) this.activeSubscriptions.delete(sub);
          if (this.disposed || !this.wantConnected) {
            this.setState('offline');
            return;
          }
          this.setState('reconnecting');
          this.scheduleReconnect();
        });
      b.build();
      return true;
    } catch (err) {
      console.warn('[NECROFALL] SpacetimeDB build failed', err);
      this.setState('error');
      return false;
    }
  }

  disconnect(): void {
    this.disposed = true;
    this.wantConnected = false;
    this.clearReconnectTimer();
    try {
      this.conn?.disconnect();
    } catch {
      /* already closed */
    }
    this.conn = null;
    this.setState('offline');
  }

  /** Subscriptions created before a drop are gone with the connection; scope helpers re-subscribe. */
  track(sub: SpacetimeSubscriptionHandle): SpacetimeSubscriptionHandle {
    this.activeSubscriptions.add(sub);
    return sub;
  }

  private handleConnected(conn: SpacetimeConnectionLike): void {
    this.conn = conn;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.setState('connected');
    for (const cb of [...this.connectListeners]) {
      try {
        cb(conn);
      } catch (err) {
        console.warn('[NECROFALL] connect listener failed', err);
      }
    }
    this.armLivenessHooks();
  }

  private armedLiveness = false;
  private armLivenessHooks(): void {
    if (this.armedLiveness) return;
    this.armedLiveness = true;
    const poke = (): void => {
      if (this.stateValue === 'reconnecting' || this.stateValue === 'error') {
        this.clearReconnectTimer();
        void this.connect();
      }
    };
    window.addEventListener('online', poke);
    window.addEventListener('focus', poke);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) poke();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.wantConnected || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    for (const cb of [...this.stateListeners]) {
      try {
        cb(state);
      } catch (err) {
        console.warn('[NECROFALL] connection listener failed', err);
      }
    }
  }
}

/** The private access token of the last connection (guest identity continuity). */
function readStoredDbToken(): string | null {
  try {
    return localStorage.getItem(STORAGE.sbToken);
  } catch {
    return null;
  }
}

/** True when this browser holds a guest identity from a previous visit. */
export function hasStoredDbToken(): boolean {
  return Boolean(readStoredDbToken());
}

function writeStoredDbToken(token: string): void {
  try {
    localStorage.setItem(STORAGE.sbToken, token);
  } catch {
    /* private mode: the guest identity simply does not persist */
  }
}

/** Explicit sign-out: forget the device-bound identity as well. */
export function clearStoredDbToken(): void {
  try {
    localStorage.removeItem(STORAGE.sbToken);
  } catch {
    /* ignore */
  }
}
