// NECROFALL — SpacetimeAuth provider: OIDC authorization-code + PKCE (plan §2/§57/§60–§62).
//
// Why PKCE and not a client secret: this code runs in the BROWSER, and
// SpacetimeAuth (like every OIDC provider) requires client secrets to stay
// server-side. PKCE proves possession of the code_verifier instead, so no
// secret ever ships to the client (plan §57/§58).
//
// Flow: login() → redirect → provider → /auth/callback?code=...&state=...
//       completeLoginFromUrl() → token exchange → session stored in sessionStorage.
import { APP_CONFIG, STORAGE } from '../config';
import { AuthEvents, AuthProvider, AuthSession, loadStoredSession, storeSession } from './AuthProvider';

interface PkceState {
  verifier: string;
  state: string;
  returnTo: string;
  createdAt: number;
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface OidcEndpoints {
  authorize: string;
  token: string;
  logout: string;
}

const PKCE_TTL_MS = 15 * 60 * 1000;

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64Url(new Uint8Array(digest));
}

/** Payload of an ID token (display-only — never used for authorization decisions). */
function decodeJwtPayload(jwt?: string): Record<string, unknown> {
  if (!jwt) return {};
  try {
    const part = jwt.split('.')[1] ?? '';
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class SpacetimeAuthProvider implements AuthProvider {
  readonly kind = 'spacetimeauth' as const;
  private events = new AuthEvents();
  private current: AuthSession | null = loadStoredSession();
  private endpoints: OidcEndpoints | null = null;

  session(): AuthSession | null {
    return this.current;
  }

  onChanged(cb: (s: AuthSession | null) => void): () => void {
    return this.events.onChanged(cb);
  }

  async validToken(): Promise<string | null> {
    const s = this.current;
    if (!s) return null;
    // Refresh a minute before expiry so a reducer never rides a dead token.
    if (Date.now() > s.expiresAt - 60_000) {
      try {
        await this.refresh();
      } catch (err) {
        console.warn('[NECROFALL] token refresh failed', err);
        this.setSession(null);
        return null;
      }
    }
    return this.current?.accessToken ?? null;
  }

  async login(returnTo = window.location.pathname + window.location.hash): Promise<void> {
    const endpoints = await this.discover();
    const verifier = randomString(64);
    const state = randomString(16);
    const pkce: PkceState = { verifier, state, returnTo, createdAt: Date.now() };
    try {
      sessionStorage.setItem(STORAGE.authPkce, JSON.stringify(pkce));
    } catch {
      /* storage-less browsing: the callback will simply say the attempt expired */
    }
    const params = new URLSearchParams({
      client_id: APP_CONFIG.authClientId,
      redirect_uri: APP_CONFIG.redirectUri,
      response_type: 'code',
      scope: APP_CONFIG.scope,
      state,
      code_challenge: await sha256Base64Url(verifier),
      code_challenge_method: 'S256',
    });
    window.location.assign(`${endpoints.authorize}?${params.toString()}`);
  }

  /**
   * Called on boot when the URL carries ?code/&state. Returns the session on
   * success, null when there was nothing to do. Throws on a provider error.
   */
  async completeLoginFromUrl(): Promise<AuthSession | null> {
    const url = new URL(window.location.href);
    const error = url.searchParams.get('error');
    if (error) {
      this.cleanUrl();
      throw new Error(url.searchParams.get('error_description') || error);
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return null;

    let stored: PkceState | null = null;
    try {
      stored = JSON.parse(sessionStorage.getItem(STORAGE.authPkce) ?? 'null') as PkceState | null;
    } catch {
      stored = null;
    }
    this.cleanUrl();
    if (!stored || stored.state !== state) throw new Error('Login state mismatch — start the sign-in again.');
    if (Date.now() - stored.createdAt > PKCE_TTL_MS) throw new Error('This sign-in attempt expired — try again.');

    const endpoints = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: APP_CONFIG.redirectUri,
      client_id: APP_CONFIG.authClientId,
      code_verifier: stored.verifier,
    });
    const tokens = await this.postToken(endpoints.token, body);
    const session = this.sessionFromTokens(tokens);
    this.setSession(session);
    try {
      sessionStorage.removeItem(STORAGE.authPkce);
    } catch {
      /* ignore */
    }
    return session;
  }

  async logout(): Promise<void> {
    const s = this.current;
    this.setSession(null);
    try {
      sessionStorage.removeItem(STORAGE.sbToken);
      localStorage.removeItem(STORAGE.sbToken);
    } catch {
      /* ignore */
    }
    const endpoints = await this.discover().catch(() => null);
    if (endpoints && s?.idToken) {
      const params = new URLSearchParams({
        id_token_hint: s.idToken,
        post_logout_redirect_uri: APP_CONFIG.postLogoutUri,
      });
      window.location.assign(`${endpoints.logout}?${params.toString()}`);
    }
  }

  // ------------------------------------------------------------ internals

  private setSession(session: AuthSession | null): void {
    this.current = session;
    storeSession(session);
    this.events.emit(session);
  }

  private cleanUrl(): void {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('code');
      url.searchParams.delete('state');
      url.searchParams.delete('error');
      url.searchParams.delete('error_description');
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    } catch {
      /* ignore */
    }
  }

  private sessionFromTokens(tokens: TokenResponse): AuthSession {
    if (!tokens.access_token) throw new Error(tokens.error_description || tokens.error || 'Token exchange failed.');
    const claims = decodeJwtPayload(tokens.id_token);
    return {
      accessToken: tokens.access_token,
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + Math.max(30, tokens.expires_in ?? 300) * 1000,
      subject: String(claims.sub ?? ''),
      email: typeof claims.email === 'string' ? claims.email : undefined,
      displayName:
        typeof claims.name === 'string' ? claims.name : typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined,
    };
  }

  private async refresh(): Promise<void> {
    const s = this.current;
    if (!s?.refreshToken) throw new Error('No refresh token.');
    const endpoints = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: s.refreshToken,
      client_id: APP_CONFIG.authClientId,
    });
    const tokens = await this.postToken(endpoints.token, body);
    this.setSession({ ...this.sessionFromTokens(tokens), refreshToken: tokens.refresh_token ?? s.refreshToken });
  }

  private async postToken(url: string, body: URLSearchParams): Promise<TokenResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok) throw new Error(json.error_description || json.error || `Token endpoint returned ${res.status}.`);
    return json;
  }

  /** OIDC discovery with conventional fallbacks when the document is absent. */
  private async discover(): Promise<OidcEndpoints> {
    if (this.endpoints) return this.endpoints;
    const fallback: OidcEndpoints = {
      authorize: `${APP_CONFIG.authAuthority}/authorize`,
      token: `${APP_CONFIG.authAuthority}/token`,
      logout: `${APP_CONFIG.authAuthority}/logout`,
    };
    try {
      const res = await fetch(`${APP_CONFIG.authAuthority}/.well-known/openid-configuration`);
      if (res.ok) {
        const doc = (await res.json()) as Record<string, string>;
        this.endpoints = {
          authorize: doc.authorization_endpoint || fallback.authorize,
          token: doc.token_endpoint || fallback.token,
          logout: doc.end_session_endpoint || fallback.logout,
        };
      } else {
        this.endpoints = fallback;
      }
    } catch {
      this.endpoints = fallback;
    }
    return this.endpoints;
  }
}

/** The provider when SpacetimeAuth is not configured — always signed out. */
export class NullAuthProvider implements AuthProvider {
  readonly kind = 'none' as const;
  session(): AuthSession | null {
    return null;
  }
  async validToken(): Promise<string | null> {
    return null;
  }
  async login(): Promise<void> {
    /* nothing to log into */
  }
  async completeLoginFromUrl(): Promise<AuthSession | null> {
    return null;
  }
  async logout(): Promise<void> {
    /* nothing to clear */
  }
  onChanged(): () => void {
    return () => undefined;
  }
}
