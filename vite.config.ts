// NECROFALL — dev server.
//
// The game gets playtested on this dev server, and a Vite full-reload yanks the player out of a
// live match. Two things kept rewriting files WITHOUT a real code change and reloaded every open
// tab:
//   • `npm run build` writing `dist/` — its index.html + assets sit under the watched project root;
//   • editors / formatters / sync clients re-saving files with byte-identical content (mtime-only
//     touches), which Vite cannot tell apart from an edit.
// So: never watch build output or editor metadata, and only accept a hot update when the file's
// CONTENT actually changed. A phantom touch is now a no-op; a real edit still hot-updates.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** What the provider points its own redirects at; those must stay on OUR origin (see api/auth-proxy). */
const PROVIDER_ORIGIN = 'https://auth.spacetimedb.com';
const APP_ORIGIN = 'https://necrofall.vercel.app';

/** Turns a Location header that names an absolute host into a same-origin path. */
export function sameOriginLocation(loc: string): string {
  if (loc.startsWith(`${PROVIDER_ORIGIN}/`)) return loc.slice(PROVIDER_ORIGIN.length);
  if (loc.startsWith(`${APP_ORIGIN}/`)) return loc.slice(APP_ORIGIN.length);
  return loc;
}

/**
 * The sign-in chain hops through ABSOLUTE https://auth.spacetimedb.com/... redirects. Un-rewritten,
 * the browser would leave the proxy, lose the re-homed first-party cookies and die with
 * "authorization request has expired". Rewriting every Location keeps all hops on this origin, so
 * the cookies (and the whole flow) stay first-party.
 */
function keepAuthChainSameOrigin(proxy: { on: (event: 'proxyRes', cb: (res: { headers: Record<string, unknown> }) => void) => void }): void {
  proxy.on('proxyRes', (proxyRes) => {
    const loc = proxyRes.headers['location'];
    if (typeof loc === 'string') proxyRes.headers['location'] = sameOriginLocation(loc);
  });
}

/** Drops hot-update events for files whose bytes are identical to the last accepted version. */
function contentStableHotUpdate(): Plugin {
  const seen = new Map<string, string>();
  return {
    name: 'necrofall:content-stable-hot-update',
    apply: 'serve',
    handleHotUpdate(ctx) {
      let hash: string;
      try {
        hash = createHash('sha1').update(readFileSync(ctx.file)).digest('hex');
      } catch {
        hash = ''; // unreadable (deleted, or mid-write): let Vite handle it normally
      }
      const prev = seen.get(ctx.file);
      seen.set(ctx.file, hash);
      if (prev !== undefined && prev === hash) return []; // a touch, not an edit
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [contentStableHotUpdate()],
  resolve: {
    // ONE three instance: the bare `three` specifier resolves to the WebGPU build, which
    // re-exports the whole core. Mixing `three` and `three/webgpu` in one bundle would duplicate
    // every class (two Vector3s, two scenes) and the renderer would silently ignore half the game.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    // Build output and editor metadata must never reload the live game.
    watch: { ignored: ['**/dist/**', '**/.vscode/**'] },
    // The sign-in interaction lives on auth.spacetimedb.com. Proxying it SAME-ORIGIN keeps its
    // cookies first-party, so the magic-link / anonymous endpoints work directly (no provider page).
    proxy: {
      '/oidc': { target: PROVIDER_ORIGIN, changeOrigin: true, configure: keepAuthChainSameOrigin },
      '/interactions': { target: PROVIDER_ORIGIN, changeOrigin: true, configure: keepAuthChainSameOrigin },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
