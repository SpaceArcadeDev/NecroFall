// NECROFALL — auth abstraction (plan §2/§57).
//
// The game only knows THIS interface. The concrete provider today is
// SpacetimeAuth (OIDC + PKCE); a future Steam/Discord provider implements the
// same surface without the rest of the app noticing.
import { STORAGE } from '../config';

export interface AuthSession {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  subject: string;
  email?: string;
  displayName?: string;
}

export interface AuthProvider {
  readonly kind: 'spacetimeauth' | 'none';
  /** Current session (may be expired — callers should hop through `validToken`). */
  session(): AuthSession | null;
  /** A usable access token, refreshing if needed. Null when signed out. */
  validToken(): Promise<string | null>;
  /** Redirect the browser to the identity provider. */
  login(returnTo?: string): Promise<void>;
  /** Handle the provider redirect (?code/&state) and return the session, if it was one. */
  completeLoginFromUrl(): Promise<AuthSession | null>;
  logout(): Promise<void>;
  /** Notified on sign-in/sign-out. Returns an unsubscribe fn. */
  onChanged(cb: (session: AuthSession | null) => void): () => void;
}

// The session (and with it the REFRESH token) MUST survive a browser restart: the access
// token expires after 15 minutes, so reopening the browser after a while can only sign the
// player back in silently if the refresh token is still around (user report 2026-09-29:
// "reopen after a while → login wall saying it could not reach the game server").
// A legacy per-tab sessionStorage copy is still read once and migrated.
function parseSession(raw: string | null): AuthSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed.accessToken || typeof parsed.expiresAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadStoredSession(): AuthSession | null {
  let fromLocal: string | null = null;
  try {
    fromLocal = localStorage.getItem(STORAGE.authSession);
  } catch {
    /* storage-less browsing */
  }
  const local = parseSession(fromLocal);
  if (local) return local;
  let fromTab: string | null = null;
  try {
    fromTab = sessionStorage.getItem(STORAGE.authSession);
  } catch {
    /* ignore */
  }
  const legacy = parseSession(fromTab);
  if (legacy) storeSession(legacy); // migrate the last per-tab session into the durable copy
  return legacy;
}

export function storeSession(session: AuthSession | null): void {
  let durable = false;
  try {
    if (session) {
      localStorage.setItem(STORAGE.authSession, JSON.stringify(session));
      durable = true;
    } else {
      localStorage.removeItem(STORAGE.authSession);
    }
  } catch {
    /* restricted storage: fall back to the per-tab copy below */
  }
  try {
    if (session && !durable) sessionStorage.setItem(STORAGE.authSession, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE.authSession);
  } catch {
    /* private mode without storage: the session simply does not persist */
  }
}

/** Tiny change notifier shared by provider implementations. */
export class AuthEvents {
  private listeners = new Set<(s: AuthSession | null) => void>();

  onChanged(cb: (s: AuthSession | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(session: AuthSession | null): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(session);
      } catch (err) {
        console.warn('[NECROFALL] auth listener failed', err);
      }
    }
  }
}
