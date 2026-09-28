// NECROFALL — Vercel Middleware: same-origin proxy for the SpacetimeAuth sign-in endpoints.
//
// The provider's interaction chain hops through ABSOLUTE https://auth.spacetimedb.com/... redirects.
// Un-rewritten, the browser leaves our origin, loses the re-homed first-party cookies, and the
// chain dies with "authorization request has expired"; without any proxy at all, its JSON endpoints
// (magic-link POST + polling) reject the cookie-less cross-site calls. This middleware runs BEFORE
// rewrites on every /oidc and /interactions request and does BOTH jobs: forward the call and rewrite
// every Location header back to a same-origin path.
//
// It mirrors the Vite dev server's `keepAuthChainSameOrigin` (vite.config.ts) and the
// api/auth-proxy function (kept as a fallback for deployments without middleware).

export const config = { matcher: ['/oidc/:path*', '/interactions/:path*'] };

const PROVIDER_ORIGIN = 'https://auth.spacetimedb.com';
const APP_ORIGIN = 'https://necrofall.vercel.app';

/** Turns a Location header that names an absolute host into a same-origin path. */
function sameOriginLocation(loc: string): string {
  if (loc.startsWith(`${PROVIDER_ORIGIN}/`)) return loc.slice(PROVIDER_ORIGIN.length);
  if (loc.startsWith(`${APP_ORIGIN}/`)) return loc.slice(APP_ORIGIN.length);
  return loc;
}

/** Headers a proxy must never forward as-is (host/length/encoding are per-hop). */
const DROP_REQUEST_HEADERS = ['host', 'content-length', 'accept-encoding', 'connection', 'transfer-encoding'];
/** Response headers the runtime owns (the body arrives decoded). */
const DROP_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding'];

export default async function middleware(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = `${PROVIDER_ORIGIN}${url.pathname}${url.search}`;

  const headers = new Headers(request.headers);
  for (const drop of DROP_REQUEST_HEADERS) headers.delete(drop);

  let body: ArrayBuffer | undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') body = await request.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: request.method, headers, body, redirect: 'manual' });
  } catch {
    return new Response(JSON.stringify({ message: 'The sign-in service did not answer.' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  const out = new Headers();
  for (const [key, value] of upstream.headers) {
    const k = key.toLowerCase();
    if (DROP_RESPONSE_HEADERS.includes(k) || k === 'set-cookie') continue;
    if (k === 'location') {
      out.set('location', sameOriginLocation(value));
      continue;
    }
    out.set(key, value);
  }
  const setCookies = (upstream.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookies?.length) {
    for (const cookie of setCookies) out.append('set-cookie', cookie);
  } else {
    const single = upstream.headers.get('set-cookie');
    if (single) out.append('set-cookie', single);
  }

  const payload = upstream.status >= 300 && upstream.status < 400 ? null : await upstream.arrayBuffer();
  return new Response(payload, { status: upstream.status, headers: out });
}
