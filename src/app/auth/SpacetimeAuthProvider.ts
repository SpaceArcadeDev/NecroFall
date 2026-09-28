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

/**
 * BOOT NEVER HANGS (user report 2026-09-28: "refresh stays blank for a long time, then
 * the login wall, and SEND MAGIC LINK does nothing"). Every auth fetch is bounded: a
 * dead network returns in seconds with a TIMEOUT error the caller can show, instead of
 * leaving an unbounded promise (and a spinner) behind.
 */
class FetchTimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`Request timed out after ${Math.round(ms / 1000)}s (${url}).`);
    this.name = 'TimeoutError';
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    // an abort HERE is always OUR timer (nothing else aborts these fetches)
    if (err instanceof Error && err.name === 'AbortError') throw new FetchTimeoutError(url, timeoutMs);
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Was the failure ours (a timeout) rather than the server saying no? */
function isTimeout(err: unknown): boolean {
  return err instanceof FetchTimeoutError || (err instanceof Error && err.name === 'TimeoutError');
}

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

/** The authorize hop's outcome: an interaction to drive, or a code the provider minted straight away. */
type AuthStep = { kind: 'interaction'; id: string } | { kind: 'code'; code: string; state: string };

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
    // A session well inside its lifetime needs no work at all.
    if (s && Date.now() <= s.expiresAt - 60_000) return s.accessToken;
    if (s) {
      // Refresh a minute before expiry so a reducer never rides a dead token.
      try {
        await this.refresh();
        return this.current?.accessToken ?? null;
      } catch (err) {
        // A NETWORK stall (timeout) must not sign the player out: keep the token we
        // have — the socket's own auth handshake is the real gate — and let the
        // connection layer retry. Only a REJECTED refresh ends the session.
        if (isTimeout(err)) {
          console.warn('[NECROFALL] token refresh timed out — continuing with the stored token');
          return this.current?.accessToken ?? null;
        }
        console.warn('[NECROFALL] token refresh failed — trying a cookie-only resume', err);
        this.setSession(null);
      }
    }
    // No local session left (a browser restart wipes it): if the provider's OWN cookie is
    // still alive the proxied authorize endpoint answers with a code in ONE hop, so the
    // returning player is signed back in without any login screen (see `silentResume`).
    return this.silentResume();
  }

  private silentResumePromise: Promise<string | null> | null = null;
  private silentResumeAt = 0;
  private static readonly SILENT_RESUME_COOLDOWN_MS = 20_000;

  /**
   * Cookie-only session resume, throttled and single-flight. Returns null when the provider
   * needs an interaction (a real login) or the attempt failed — never throws.
   */
  private silentResume(): Promise<string | null> {
    if (this.silentResumePromise) return this.silentResumePromise;
    if (Date.now() - this.silentResumeAt < SpacetimeAuthProvider.SILENT_RESUME_COOLDOWN_MS) {
      return Promise.resolve(null);
    }
    this.silentResumeAt = Date.now();
    this.silentResumePromise = this.runSilentResume().finally(() => {
      this.silentResumePromise = null;
    });
    return this.silentResumePromise;
  }

  private async runSilentResume(): Promise<string | null> {
    try {
      const attempt = this.newAttempt(window.location.pathname + window.location.hash);
      const step = await this.beginAuthorization(attempt);
      if (step.kind !== 'code') return null; // the provider wants a real sign-in
      const session = await this.completeWithCode(step.code, step.state, attempt);
      console.info('[NECROFALL] session resumed from the provider cookie');
      return session.accessToken;
    } catch (err) {
      console.warn('[NECROFALL] silent session resume failed', err);
      return null;
    }
  }

  async login(returnTo = window.location.pathname + window.location.hash): Promise<void> {
    const endpoints = await this.discover();
    const attempt = this.newAttempt(returnTo);
    const params = this.authorizeParams(attempt, await sha256Base64Url(attempt.verifier));
    window.location.assign(`${endpoints.authorize}?${params.toString()}`);
  }

  /**
   * MAGIC LINK, direct (no provider page): create the sign-in interaction, ask the provider to
   * email the link, and return. The caller then polls `pollMagicLink()` until it is clicked.
   * The interaction + its cookies live on OUR origin (see the /oidc + /interactions proxy).
   * With a live provider session there is nothing to email — the code comes back in one hop and
   * the caller is signed in on the spot ('signed-in').
   */
  async sendMagicLink(email: string): Promise<'sent' | 'signed-in'> {
    const attempt = this.newAttempt(window.location.pathname + window.location.hash);
    const step = await this.beginAuthorization(attempt);
    if (step.kind === 'code') {
      await this.completeWithCode(step.code, step.state, attempt);
      return 'signed-in';
    }
    this.interactionId = step.id;
    const res = await fetchWithTimeout(`/interactions/${this.interactionId}/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = (await res.json().catch(() => ({}))) as { pollingToken?: string; message?: string };
    if (!res.ok || !data.pollingToken) throw new Error(data.message || 'Could not send the magic link.');
    this.pollingToken = data.pollingToken;
    return 'sent';
  }

  /** One poll tick on the emailed link: still waiting, clicked (used) or timed out. */
  async pollMagicLink(): Promise<'pending' | 'used' | 'expired'> {
    if (!this.interactionId || !this.pollingToken) return 'expired';
    const res = await fetchWithTimeout(
      `/interactions/${this.interactionId}/magic-link?token=${encodeURIComponent(this.pollingToken)}`,
      {},
      8000
    );
    if (res.status >= 400) {
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(data.message || 'The sign-in failed.');
    }
    const data = (await res.json().catch(() => ({}))) as { used?: boolean; expired?: boolean };
    if (data.used) return 'used';
    if (data.expired) return 'expired';
    return 'pending';
  }

  /** The emailed link was clicked — finish THIS tab's sign-in through the provider's redirect hop. */
  finishMagicLink(): void {
    if (!this.interactionId || !this.pollingToken) return;
    window.location.assign(
      `/interactions/${this.interactionId}/magic-link/redirect?token=${encodeURIComponent(this.pollingToken)}`
    );
  }

  /** SKIP — anonymous sign-in, direct: the interaction's own anonymous endpoint. */
  async loginAnonymous(): Promise<'signed-in' | 'navigating'> {
    const attempt = this.newAttempt(window.location.pathname + window.location.hash);
    const step = await this.beginAuthorization(attempt);
    if (step.kind === 'code') {
      await this.completeWithCode(step.code, step.state, attempt);
      return 'signed-in';
    }
    window.location.assign(`/interactions/${step.id}/anonymous`);
    return 'navigating';
  }

  /** One fresh PKCE attempt (verifier + state + return path), persisted for the callback. */
  private newAttempt(returnTo: string): PkceState {
    const verifier = randomString(64);
    const state = randomString(16);
    const attempt: PkceState = { verifier, state, returnTo, createdAt: Date.now() };
    try {
      sessionStorage.setItem(STORAGE.authPkce, JSON.stringify(attempt));
    } catch {
      /* storage-less browsing: the callback will simply say the attempt expired */
    }
    return attempt;
  }

  private authorizeParams(attempt: PkceState, challenge: string): URLSearchParams {
    return new URLSearchParams({
      client_id: APP_CONFIG.authClientId,
      redirect_uri: APP_CONFIG.redirectUri,
      response_type: 'code',
      scope: APP_CONFIG.scope,
      state: attempt.state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
  }

  /**
   * The first hop of a direct sign-in: ask the authorize endpoint for an interaction through the
   * same-origin proxy. Normally the provider 303s to /interactions/<id> and STOPS there — that
   * page's own endpoints drive the rest (anonymous / magic link). When a live provider session
   * already exists the provider skips every consent screen and answers with the callback URL —
   * a minted code the caller can exchange on the spot.
   */
  private async beginAuthorization(attempt: PkceState): Promise<AuthStep> {
    const params = this.authorizeParams(attempt, await sha256Base64Url(attempt.verifier));
    let res: Response;
    try {
      res = await fetchWithTimeout(`/oidc/auth?${params.toString()}`, { redirect: 'follow' }, 12_000);
    } catch {
      throw new Error('Could not reach the sign-in service. Retry below.');
    }
    const id = /\/interactions\/([^/?#]+)/.exec(res.url)?.[1] ?? '';
    if (id) return { kind: 'interaction', id };
    try {
      const url = new URL(res.url);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (code && state) return { kind: 'code', code, state };
    } catch {
      /* not a readable URL — fall through to the error below */
    }
    throw new Error('The sign-in service did not answer — try again.');
  }

  /** Exchange a callback code for tokens with the PKCE attempt that minted it. */
  private async completeWithCode(code: string, state: string, attempt: PkceState): Promise<AuthSession> {
    if (attempt.state !== state) throw new Error('Login state mismatch — start the sign-in again.');
    const endpoints = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: APP_CONFIG.redirectUri,
      client_id: APP_CONFIG.authClientId,
      code_verifier: attempt.verifier,
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

  private interactionId = '';
  private pollingToken = '';

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

    return this.completeWithCode(code, state, stored);
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
      url.searchParams.delete('iss');
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

  private refreshPromise: Promise<void> | null = null;

  /** One refresh at a time: two concurrent rotations would invalidate each other. */
  private async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<void> {
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
    const res = await fetchWithTimeout(url, {
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
      // a SHORT leash: a dead authority must not hold the boot hostage
      const res = await fetchWithTimeout(`${APP_CONFIG.authAuthority}/.well-known/openid-configuration`, {}, 5000);
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
