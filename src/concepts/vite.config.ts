import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'public',
  cacheDir: 'node_modules/.vite-concepts',
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  server: { host: true, port: 5188, strictPort: false, watch: { ignored: ['**/dist/**', '**/dist-concepts/**'] } },
  build: { target: 'es2022', outDir: 'dist-concepts', assetsInlineLimit: filePath => filePath.endsWith('ATTRIBUTION.md') ? false : undefined, rollupOptions: { input: { bases: 'base-planets.html', concepts: 'concepts.html' } }, chunkSizeWarningLimit: 2000 },
});