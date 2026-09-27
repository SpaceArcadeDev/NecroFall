// NECROFALL — /auth/callback handling helpers (plan §59/§60).
//
// The redirect URI registered with SpacetimeAuth is
//   <site>/auth/callback
// Depending on the frontend host that path either resolves to a real page
// (Vercel) or falls back to index.html (Vite dev). Both cases land here.
import { APP_CONFIG } from '../config';

/** True when the current URL looks like a provider redirect. */
export function isAuthCallbackUrl(): boolean {
  if (window.location.pathname.replace(/\/+$/, '').toLowerCase().endsWith('/auth/callback')) return true;
  const params = new URLSearchParams(window.location.search);
  return params.has('code') && params.has('state');
}

/** Where a completed/failed login should continue (defaults to the game home). */
export function authReturnPath(): string {
  try {
    const raw = sessionStorage.getItem('nf.auth.pkce');
    if (raw) {
      const parsed = JSON.parse(raw) as { returnTo?: string };
      if (parsed.returnTo && parsed.returnTo.startsWith('/')) return parsed.returnTo;
    }
  } catch {
    /* ignore */
  }
  return `${new URL(APP_CONFIG.postLogoutUri).pathname || '/'}`;
}
