// NECROFALL — client configuration (plan §57/§58).
//
// Everything here comes from Vite environment variables (`.env.local`, see
// `.env.example`). When SpacetimeDB is not configured the game boots straight
// into the legacy P2P/offline flow — the account shell stays out of the way.
export type DefaultMultiplayerMode = 'official' | 'p2p';

interface ViteEnv {
  VITE_SPACETIMEDB_URI?: string;
  VITE_SPACETIMEDB_DB_NAME?: string;
  VITE_SPACETIMEAUTH_AUTHORITY?: string;
  VITE_SPACETIMEAUTH_CLIENT_ID?: string;
  VITE_SPACETIMEAUTH_REDIRECT_URI?: string;
  VITE_SPACETIMEAUTH_POST_LOGOUT_URI?: string;
  VITE_SPACETIMEAUTH_SCOPE?: string;
  VITE_P2P_ENABLED?: string;
  VITE_DEFAULT_MULTIPLAYER_MODE?: string;
  VITE_SPACETIMEDB_ENV?: string;
}

function env(): ViteEnv {
  // NOTE: the `import.meta.env` expression must appear VERBATIM here — Vite
  // statically replaces exactly this pattern, and routing it through an
  // intermediate variable silently yields an empty object.
  const raw = import.meta.env as unknown as ViteEnv;
  return raw ?? {};
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface AppConfig {
  spacetimeUri: string;
  spacetimeDb: string;
  authAuthority: string;
  authClientId: string;
  redirectUri: string;
  postLogoutUri: string;
  scope: string;
  p2pEnabled: boolean;
  defaultMode: DefaultMultiplayerMode;
  environment: string;
  /** True when account + official play are actually available. */
  configured: boolean;
  /** True when SpacetimeAuth (OIDC) is usable — false means guest/local mode. */
  authConfigured: boolean;
}

const e = env();

const clientId = (e.VITE_SPACETIMEAUTH_CLIENT_ID ?? '').trim();
const authConfigured = Boolean(clientId) && clientId !== 'YOUR_CLIENT_ID';

export const APP_CONFIG: AppConfig = {
  spacetimeUri: trimSlash(e.VITE_SPACETIMEDB_URI ?? ''),
  spacetimeDb: (e.VITE_SPACETIMEDB_DB_NAME ?? '').trim(),
  authAuthority: trimSlash(e.VITE_SPACETIMEAUTH_AUTHORITY ?? ''),
  authClientId: authConfigured ? clientId : '',
  redirectUri: (e.VITE_SPACETIMEAUTH_REDIRECT_URI ?? `${window.location.origin}/auth/callback`).trim(),
  postLogoutUri: (e.VITE_SPACETIMEAUTH_POST_LOGOUT_URI ?? `${window.location.origin}/`).trim(),
  scope: (e.VITE_SPACETIMEAUTH_SCOPE ?? 'openid profile email').trim(),
  p2pEnabled: (e.VITE_P2P_ENABLED ?? 'true') !== 'false',
  defaultMode: (e.VITE_DEFAULT_MULTIPLAYER_MODE ?? 'official') === 'p2p' ? 'p2p' : 'official',
  environment: e.VITE_SPACETIMEDB_ENV ?? 'production',
  configured: Boolean(e.VITE_SPACETIMEDB_URI && e.VITE_SPACETIMEDB_DB_NAME),
  authConfigured,
};

/** Where the client expects the generated SpacetimeDB bindings to live. */
export const BINDINGS_PATH = 'spacetimedb/module_bindings/index.ts';

/** Local storage keys (all prefixed to keep the namespace tidy). */
export const STORAGE = {
  authSession: 'nf.auth.session',
  authPkce: 'nf.auth.pkce',
  sbToken: 'nf.sb.token',
  multiplayerMode: 'nf.mm.mode',
} as const;
