// NECROFALL — same-origin proxy for the SpacetimeAuth sign-in endpoints.
//
// Why this exists: the provider's interaction chain hops through ABSOLUTE
// https://auth.spacetimedb.com/... redirects. Under a plain vercel.json rewrite those Location
// headers pass through unchanged, the browser leaves our origin, and the re-homed first-party
// cookies vanish — the chain then dies with "authorization request has expired". This function
// forwards the calls AND rewrites every Location back to a same-origin path, so the whole flow
// (its cookies AND its JSON magic-link calls) stays first-party. The Vite dev server does the
// same thing in vite.config.ts (`keepAuthChainSameOrigin`).

const PROVIDER_ORIGIN = 'https://auth.spacetimedb.com';
const APP_ORIGIN = 'https://necrofall.vercel.app';

/** Turns a Location header that names an absolute host into a same-origin path. */
function sameOriginLocation(loc: string): string {
  if (loc.startsWith(`${PROVIDER_ORIGIN}/`)) return loc.slice(PROVIDER_ORIGIN.length);
  if (loc.startsWith(`${APP_ORIGIN}/`)) return loc.slice(APP_ORIGIN.length);
  return loc;
}

/** Headers a proxy must never forward as-is (host/connection/length/encoding are per-hop). */
const DROP_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding']);

interface ProxyRequest {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface ProxyResponse {
  statusCode: number;
  setHeader(name: string, value: string | string[]): void;
  end(body?: string): void;
}

export default async function handler(req: ProxyRequest, res: ProxyResponse): Promise<void> {
  // req.url comes in as the rewrite destination (/api/auth-proxy/oidc/…), but be tolerant of the
  // original form (/oidc/…) and of absolute URLs — all three reduce to `oidc/…` or `interactions/…`.
  let rest = String(req.url ?? '/');
  rest = rest.replace(/^https?:\/\/[^/]+/i, '');
  rest = rest.replace(/^\/api\/auth-proxy\//, '');
  rest = rest.replace(/^\//, '');
  const target = `${PROVIDER_ORIGIN}/${rest}`;

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || DROP_REQUEST_HEADERS.has(key)) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  let body: string | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = typeof req.body === 'string' ? req.body : req.body ? JSON.stringify(req.body) : undefined;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: req.method ?? 'GET', headers, body, redirect: 'manual' });
  } catch {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: 'The sign-in service did not answer.' }));
    return;
  }

  res.statusCode = upstream.status;
  for (const [key, value] of upstream.headers) {
    const k = key.toLowerCase();
    if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding' || k === 'set-cookie') continue;
    if (k === 'location') {
      res.setHeader('location', sameOriginLocation(value));
      continue;
    }
    res.setHeader(key, value);
  }
  const setCookies = (upstream.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookies?.length) res.setHeader('set-cookie', setCookies);
  else {
    const single = upstream.headers.get('set-cookie');
    if (single) res.setHeader('set-cookie', single);
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    res.end();
    return;
  }
  res.end(await upstream.text());
}
