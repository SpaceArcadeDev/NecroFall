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
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    // Build output and editor metadata must never reload the live game.
    watch: { ignored: ['**/dist/**', '**/.vscode/**'] },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
